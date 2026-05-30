# liveview flake — pure-Nix build of the `lv` binary: the React/MUI SPA
# (deno + vite) and the axum daemon that embeds it via include_dir!.
#
# `nix build` produces a binary equivalent to `deno task build` followed by
# `cargo build --release --features embedded`, with no external build
# orchestration (no docker compile sandbox). Mirrors heimdall's flake; the
# web build runs in a fixed-output derivation so `deno install` gets network
# (the box's omega TUN proxies the sandbox egress, same as heimdall-ui).
{
  description = "liveview — live-reloading docs previewer (axum + embedded React SPA)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  # The shared atlantis app-shell SDK (contract + UI primitives), referenced as
  # a Nix package and staged into the web build below — NOT vendored into this
  # repo's git tree (web/src/_shell/ is gitignored and materialized from here).
  # Lives in the atlantis project (projects/atlantis/main/components), exposed
  # as that flake's `components` package.
  inputs.app-shell.url = "git+file:///home/draven/columbus/projects/atlantis/main";
  inputs.app-shell.inputs.nixpkgs.follows = "nixpkgs";

  outputs =
    { self, nixpkgs, app-shell }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      lib = pkgs.lib;

      # SDK source tree (contract + UI primitives) from the app-shell package,
      # staged into web/src/_shell/ at build time.
      appShellSrc = app-shell.packages.${system}.components;

      # edge-tts CLI for the audiobook track: `lv` shells out to it to
      # synthesize chapter narration. Baked onto the binary's PATH (below) so
      # the deployed unit needs no extra wiring, and present in the dev shell.
      edgeTts = pkgs.python3Packages.edge-tts;

      # ── deno: pinned to the latest upstream release ───────────────────
      # nixpkgs trails upstream (nixos-unstable is on 2.7.x); we want the
      # newest deno, so wrap the official prebuilt x86_64-linux binary
      # (autoPatchelf'd against glibc/libstdc++) instead of nixpkgs' source
      # build. Bump `version` + re-prefetch `hash` to upgrade.
      deno = pkgs.stdenv.mkDerivation rec {
        pname = "deno";
        version = "2.8.1";
        src = pkgs.fetchurl {
          url = "https://github.com/denoland/deno/releases/download/v${version}/deno-x86_64-unknown-linux-gnu.zip";
          hash = "sha256-LXu2GVImrIMuC/cQmhFfCvZe5prHl6S73lsnoGzCQtk=";
        };
        nativeBuildInputs = [
          pkgs.unzip
          pkgs.autoPatchelfHook
        ];
        buildInputs = [
          pkgs.stdenv.cc.cc.lib # libstdc++ / libgcc_s
          pkgs.glibc
        ];
        sourceRoot = ".";
        installPhase = ''
          runHook preInstall
          install -Dm755 deno $out/bin/deno
          runHook postInstall
        '';
        meta.mainProgram = "deno";
      };

      # ── liveview-web: deno install + vite build → dist/ ───────────────
      # Single fixed-output derivation: `deno install` needs the npm
      # registry (FODs are allowed network), then an offline vite build.
      liveview-web = pkgs.stdenv.mkDerivation {
        pname = "liveview-web";
        version = "0.1.0";

        # _shell excluded here: it's not committed in this repo and is staged
        # fresh from the app-shell package in buildPhase, so the FOD's copy is
        # pinned by the input, not by whatever a dev materialized locally.
        src = lib.cleanSourceWith {
          src = ./web;
          filter =
            path: _type:
            let
              base = baseNameOf (toString path);
            in
            !(builtins.elem base [
              "node_modules"
              "dist"
              "_shell"
            ]);
        };

        # nodejs because some npm postinstall scripts (esbuild, which vite
        # pulls in) run `node install.js` — deno's `--allow-scripts` execs
        # them via node. cacert for npm registry TLS.
        nativeBuildInputs = [
          deno
          pkgs.nodejs
          pkgs.cacert
        ];

        buildPhase = ''
          runHook preBuild
          export HOME=$TMPDIR
          # Stage the shared app-shell SDK into src/_shell/ from the Nix
          # package (not committed in this repo). chmod: the store source is
          # read-only and the tree must be writable for the build.
          mkdir -p src/_shell
          cp ${appShellSrc}/* src/_shell/
          chmod -R u+w src/_shell
          # --allow-scripts so esbuild's lifecycle script links its native
          # binary; deno blocks npm lifecycle scripts by default. No
          # --frozen: deno.lock is gitignored (not in the flake source),
          # the outputHash is what pins reproducibility here.
          deno install --allow-scripts
          # Invoke vite directly: the package.json `build` script is
          # `tsc && vite build`; the embedded bundle only needs vite's
          # esbuild output, so skip the tsc type-check pass.
          deno run -A ./node_modules/vite/bin/vite.js build
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall
          cp -r dist $out
          runHook postInstall
        '';

        dontPatchShebangs = true;
        dontFixup = true;

        outputHashMode = "recursive";
        outputHashAlgo = "sha256";
        outputHash = "sha256-TuWNF+BXcrzAOnwJbpKtEPiIF+GIYl2isktCoS4CL8w=";
      };

      # ── lv: axum daemon, embeds the SPA via include_dir! ──────────────
      liveview = pkgs.rustPlatform.buildRustPackage {
        pname = "liveview";
        version = "0.1.0";

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

        # sqlx's sqlite driver links libsqlite3 (via libsqlite3-sys), found at
        # build time through pkg-config. makeWrapper puts edge-tts on PATH.
        nativeBuildInputs = [
          pkgs.pkg-config
          pkgs.makeWrapper
        ];
        buildInputs = [ pkgs.sqlite ];

        # The audiobook player shells out to `edge-tts`; bake it onto PATH so
        # the deployed binary is self-contained (no unit-level PATH wiring).
        postInstall = ''
          wrapProgram $out/bin/lv --prefix PATH : ${lib.makeBinPath [ edgeTts ]}
        '';

        # Vendor via fetchCargoVendor (cargo's own downloader → sparse index
        # + static.crates.io), NOT importCargoLock: this box's omega proxy
        # 403s the crates.io API download endpoint that importCargoLock uses,
        # while static.crates.io returns 200.
        cargoHash = "sha256-6sK3Yzkg9am+BdNDOoDX9RZwi6DFhFCCTg86Iu7MIJ8=";

        # Build id the binary serves at /version.json for the atlantis portal's
        # update-banner poll. The app's commit SHA changes every deploy; a dirty
        # tree (local `nix build`) has no rev, so fall back to the static
        # version. Read via option_env! in src/main.rs.
        ATLANTIS_BUILD_VERSION = self.shortRev or "0.1.0";

        # include_dir!("$CARGO_MANIFEST_DIR/web/dist") is a compile-time
        # lookup — drop the prebuilt SPA there before cargo runs.
        preBuild = ''
          mkdir -p web/dist
          cp -r ${liveview-web}/. web/dist/
        '';

        buildFeatures = [ "embedded" ];
        cargoBuildFlags = [
          "--bin"
          "lv"
        ];

        # Tests touch the filesystem / network; not relevant for packaging.
        doCheck = false;

        meta = with lib; {
          description = "Live-reloading docs previewer (axum + embedded React SPA)";
          mainProgram = "lv";
          platforms = platforms.linux;
          license = licenses.mit;
        };
      };
    in
    {
      packages.${system} = {
        inherit liveview liveview-web;
        default = liveview;
        # The app-shell SDK source, re-exposed so local dev can materialize
        # web/src/_shell/ via `make shell` (it isn't committed). Pinned by the
        # same locked app-shell input the web build uses.
        app-shell-src = appShellSrc;
      };

      devShells.${system}.default = pkgs.mkShell {
        packages = [
          pkgs.cargo
          pkgs.rustc
          # clippy + rustfmt match this rustc, so `make check` (cargo clippy /
          # cargo fmt) doesn't fall back to a mismatched rustup toolchain.
          pkgs.clippy
          pkgs.rustfmt
          deno
          pkgs.nodejs
          pkgs.pkg-config
          pkgs.sqlite
          edgeTts
        ];
      };
    };
}
