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

  # Match the NixOS release used by the production host. The frontend's Deno
  # dependency cache is produced through nixpkgs, so the standalone and host
  # builds must use the same release generation for depsHash to stay valid.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  inputs.rust-overlay = {
    url = "github:oxalica/rust-overlay";
    inputs.nixpkgs.follows = "nixpkgs";
  };
  inputs.crane.url = "github:ipetkov/crane";

  # The shared @shared-utils/ui SDK (business- and portal-free React + MUI
  # primitives), referenced as a Nix package and staged into the web build below
  # — NOT vendored into this repo's git tree (web/src/_shell/ is gitignored and
  # materialized from here). Lives in the public shared-utils monorepo, exposed
  # as that flake's `ui` package.
  inputs.shared-utils.url = "github:dravengarden/shared-utils";
  inputs.shared-utils.inputs.nixpkgs.follows = "nixpkgs";

  outputs =
    {
      self,
      nixpkgs,
      rust-overlay,
      crane,
      shared-utils,
    }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        overlays = [ rust-overlay.overlays.default ];
      };
      lib = pkgs.lib;
      shared = shared-utils.lib.${system};
      version = (builtins.fromTOML (builtins.readFile ./Cargo.toml)).package.version;
      rustToolchain = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;
      craneLib = (crane.mkLib pkgs).overrideToolchain rustToolchain;
      rootRustFilter =
        path: type:
        let
          root = toString ./.;
          pathString = toString path;
          relative = lib.removePrefix "${root}/" pathString;
          excludedTrees = [
            "app"
            "lv-sync"
            "plugins"
          ];
          excluded = lib.any (tree: relative == tree || lib.hasPrefix "${tree}/" relative) excludedTrees;
        in
        pathString == root || (!excluded && craneLib.filterCargoSources path type);
      cargoSrc = lib.cleanSourceWith {
        src = lib.cleanSource ./.;
        filter = rootRustFilter;
        name = "liveview-cargo-source";
      };
      rustSrc = lib.cleanSourceWith {
        src = lib.cleanSource ./.;
        filter =
          path: type:
          rootRustFilter path type
          || (
            type == "regular"
            && builtins.elem (baseNameOf (toString path)) [
              "schema.sql"
              "taxonomy.json"
            ]
          );
        name = "liveview-rust-source";
      };
      webBuildSrc = lib.cleanSourceWith {
        src = lib.cleanSource ./.;
        filter =
          path: type:
          let
            root = toString ./.;
            pathString = toString path;
            relative = lib.removePrefix "${root}/" pathString;
            inWeb = relative == "web" || lib.hasPrefix "web/" relative;
            inTools = relative == "tools" || lib.hasPrefix "tools/" relative;
          in
          pathString == root || inWeb || inTools || (type == "regular" && relative == "taxonomy.json");
        name = "liveview-web-source";
      };

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
        src = webBuildSrc;
        installArgs = "--frozen --allow-scripts";
        depsHash = "sha256-wcjOFWiGOKuPklz+ZHJbl/hWjd4lAm2ahzjcyTM2jLw=";
      };

      # Compile the locked dependency graph independently from application
      # source. Ordinary Rust edits reuse this derivation; Cargo graph changes
      # invalidate it. The final package below supplies compile-time data and
      # the prebuilt SPA separately.
      cargoArtifacts = craneLib.buildDepsOnly {
        pname = "liveview-deps";
        inherit version;
        src = cargoSrc;
        strictDeps = true;
        cargoExtraArgs = "--locked --features embedded --bin liveview";
        nativeBuildInputs = [ pkgs.pkg-config ];
      };

      # ── liveview: axum daemon, embeds the SPA via include_dir! ────────
      liveview = craneLib.buildPackage {
        pname = "liveview";
        inherit version;
        src = rustSrc;
        inherit cargoArtifacts;
        strictDeps = true;
        cargoExtraArgs = "--locked --features embedded --bin liveview";

        # makeWrapper puts edge-tts on PATH. sqlx is postgres-only (pure-Rust
        # driver, no libpq) and the S3 client uses rustls, so no system libs are
        # linked; pkg-config stays for any transitive build-script probe.
        nativeBuildInputs = [
          pkgs.pkg-config
          pkgs.makeWrapper
        ];

        # The audiobook player shells out to `edge-tts`; bake it onto PATH so
        # the deployed binary is self-contained (no unit-level PATH wiring).
        postInstall = ''
          wrapProgram $out/bin/liveview --prefix PATH : ${lib.makeBinPath [ edgeTts ]}
        '';

        # include_dir!("$CARGO_MANIFEST_DIR/web/dist") is a compile-time
        # lookup — drop the prebuilt SPA there before cargo runs.
        preBuild = ''
          mkdir -p web/dist
          cp -r ${liveview-web}/. web/dist/
        '';

        # Hermetic tests run during packaging; integration tests that require
        # live postgres/S3/VictoriaLogs are explicitly ignored by the suite.
        doCheck = true;
        cargoTestExtraArgs = "--all-targets";

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
        # web/src/_shell/ via `just shell` (it isn't committed). Pinned by the
        # same locked shared-utils input the web build uses.
        shared-ui-src = sharedUiSrc;
      };

      checks.${system} = {
        inherit liveview liveview-web;
      };

      devShells.${system}.default = pkgs.mkShell {
        packages = [
          rustToolchain
          pkgs.sccache
          pkgs.cargo-nextest
          pkgs.cargo-deny
          pkgs.cargo-machete
          pkgs.rust-analyzer
          pkgs.just
          pkgs.nixfmt
          shared.deno
          pkgs.nodejs
          pkgs.imagemagick
          pkgs.libicns
          pkgs.pkg-config
          pkgs.sqlite
          edgeTts
        ];
        # Tauri's Linux host build compiles the desktop webview backend even
        # though the primary native target is iOS/macOS. Keeping these here lets
        # `just verify` type-check and test the plugin on a clean Linux checkout.
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
