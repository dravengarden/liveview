# liveview flake — pure-Nix build of the `liveview` binary: the React/MUI SPA
# (deno + vite) and the axum daemon that embeds it via include_dir!.
#
# `nix build` produces a binary equivalent to `deno task build` followed by
# `cargo build --release --features embedded`, with no external build
# orchestration (no docker compile sandbox). The SPA is built through the
# shared, footgun-free buildDenoViteApp (deps-only FOD + offline build); see
# its comment below.
{
  description = "liveview — book reader (axum + embedded React SPA, pg + rustfs backed)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  # The shared @shared-utils/ui SDK (business- and portal-free React + MUI
  # primitives), referenced as a Nix package and staged into the web build below
  # — NOT vendored into this repo's git tree (web/src/_shell/ is gitignored and
  # materialized from here). Lives in the public shared-utils monorepo, exposed
  # as that flake's `ui` package.
  inputs.shared-utils.url = "github:dravengarden/shared-utils";
  inputs.shared-utils.inputs.nixpkgs.follows = "nixpkgs";

  outputs =
    { self, nixpkgs, shared-utils }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      lib = pkgs.lib;
      shared = shared-utils.lib.${system};
      version = (builtins.fromTOML (builtins.readFile ./Cargo.toml)).package.version;

      # Shared UI SDK source tree from the shared-utils `ui` package, re-exposed
      # for local dev to materialize web/src/_shell/ (the build itself stages it
      # via buildDenoViteApp's default shellSrc).
      sharedUiSrc = shared-utils.packages.${system}.ui;

      # edge-tts CLI for the audiobook track: `liveview` shells out to it to
      # synthesize chapter narration. Baked onto the binary's PATH (below) so
      # the deployed unit needs no extra wiring, and present in the dev shell.
      edgeTts = pkgs.python3Packages.edge-tts;

      # ── liveview-web: the SPA, built via the shared, footgun-free builder ──
      # A deps-only FOD (vendored npm cache keyed by web/deno.lock + package.json
      # → depsHash below) + a normal content-addressed offline build. Any source
      # edit rebuilds automatically; only refresh depsHash when the lockfiles
      # change (lib.fakeHash → build → copy "got"). Replaces the old single FOD
      # whose outputHash addressed the WHOLE build — so a source-only change
      # silently reused a stale bundle until the hash was hand-rebumped.
      #
      # The checked-in lockfile makes local and Nix dependency resolution agree;
      # --allow-scripts lets esbuild's lifecycle script link its native binary.
      # The build runs `deno task
      # build`, which web/deno.json maps to a vite-only build (no tsc pass), as
      # the old FOD did. shellSrc defaults to the shared-utils ui SDK — exactly
      # what liveview already staged — so it's omitted.
      liveview-web = shared.buildDenoViteApp {
        pname = "liveview";
        inherit version;
        src = lib.cleanSource ./.;
        installArgs = "--frozen --allow-scripts";
        depsHash = "sha256-E0EpfeHduBNXW9ne0rayUJJufQRxW9UbKOyCxPS8FIc=";
      };

      # ── liveview: axum daemon, embeds the SPA via include_dir! ────────
      liveview = pkgs.rustPlatform.buildRustPackage {
        pname = "liveview";
        inherit version;

        src = lib.cleanSourceWith {
          src = ./.;
          filter =
            path: _type:
            let
              base = baseNameOf (toString path);
            in
            !(builtins.elem base [
              "target"
              "result"
              "node_modules"
              "dist"
            ]);
        };

        # makeWrapper puts edge-tts on PATH. sqlx is postgres-only (pure-Rust
        # driver, no libpq) and the S3 client uses rustls, so no system libs are
        # linked; pkg-config stays for any transitive build-script probe.
        nativeBuildInputs = [
          pkgs.pkg-config
          pkgs.makeWrapper
        ];
        nativeCheckInputs = [ shared.deno ];

        # The audiobook player shells out to `edge-tts`; bake it onto PATH so
        # the deployed binary is self-contained (no unit-level PATH wiring).
        postInstall = ''
          wrapProgram $out/bin/liveview --prefix PATH : ${lib.makeBinPath [ edgeTts ]}
        '';

        # Vendor via fetchCargoVendor (cargo's own downloader → sparse index
        # + static.crates.io), NOT importCargoLock: this box's omega proxy
        # 403s the crates.io API download endpoint that importCargoLock uses,
        # while static.crates.io returns 200.
        cargoHash = "sha256-FmeDET3+qalwv0vEp1t5b6HOSxIUukx6JfWtKs8tCfo=";

        # include_dir!("$CARGO_MANIFEST_DIR/web/dist") is a compile-time
        # lookup — drop the prebuilt SPA there before cargo runs.
        preBuild = ''
          mkdir -p web/dist
          cp -r ${liveview-web}/. web/dist/
        '';

        buildFeatures = [ "embedded" ];
        cargoBuildFlags = [
          "--bin"
          "liveview"
        ];

        # Hermetic tests run during packaging; integration tests that require
        # live postgres/S3/VictoriaLogs are explicitly ignored by the suite.
        doCheck = true;
        cargoTestFlags = [ "--all-targets" ];

        meta = with lib; {
          description = "Live-reloading docs previewer (axum + embedded React SPA)";
          mainProgram = "liveview";
          platforms = platforms.linux;
          license = licenses.mit;
        };
      };
    in
    {
      packages.${system} = {
        inherit liveview liveview-web;
        default = liveview;
        # The shared-utils ui SDK source, re-exposed so local dev can materialize
        # web/src/_shell/ via `make shell` (it isn't committed). Pinned by the
        # same locked shared-utils input the web build uses.
        shared-ui-src = sharedUiSrc;
      };

      checks.${system} = {
        inherit liveview liveview-web;
      };

      devShells.${system}.default = pkgs.mkShell {
        packages = [
          pkgs.cargo
          pkgs.rustc
          # clippy + rustfmt match this rustc, so `make check` (cargo clippy /
          # cargo fmt) doesn't fall back to a mismatched rustup toolchain.
          pkgs.clippy
          pkgs.rustfmt
          shared.deno
          pkgs.nodejs
          pkgs.pkg-config
          pkgs.sqlite
          edgeTts
        ];
        # Tauri's Linux host build compiles the desktop webview backend even
        # though the primary native target is iOS/macOS. Keeping these here lets
        # `make verify` type-check and test the plugin on a clean Linux checkout.
        buildInputs = [
          pkgs.cairo
          pkgs.dbus
          pkgs.gtk3
          pkgs.libsoup_3
          pkgs.webkitgtk_4_1
        ];
      };
    };
}
