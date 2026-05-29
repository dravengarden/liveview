# liveview flake — pure-Nix build of the `lv` binary: the React/MUI SPA
# (bun + vite) and the axum daemon that embeds it via include_dir!.
#
# `nix build` produces a binary equivalent to `bun run build` followed by
# `cargo build --release --features embedded`, with no external build
# orchestration (no docker compile sandbox). Mirrors heimdall's flake; the
# bun build runs in a fixed-output derivation so `bun install` gets network
# (the box's omega TUN proxies the sandbox egress, same as heimdall-ui).
{
  description = "liveview — live-reloading docs previewer (axum + embedded React SPA)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      lib = pkgs.lib;

      # ── liveview-web: bun install + vite build → dist/ ────────────────
      # Single fixed-output derivation: `bun install` needs the npm
      # registry (FODs are allowed network), then an offline vite build.
      liveview-web = pkgs.stdenv.mkDerivation {
        pname = "liveview-web";
        version = "0.1.0";

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
            ]);
        };

        # nodejs because vite.js starts with `#!/usr/bin/env node` — bun
        # honors the shebang on posix_spawn. cacert for npm registry TLS.
        nativeBuildInputs = [
          pkgs.bun
          pkgs.nodejs
          pkgs.cacert
        ];

        buildPhase = ''
          runHook preBuild
          export HOME=$TMPDIR
          bun install --frozen-lockfile --no-progress
          # Invoke vite directly: the package.json `build` script is
          # `tsc && vite build`; the embedded bundle only needs vite's
          # esbuild output, and `bun run build` trips bun's posix_spawn
          # script resolver (see heimdall-ui).
          bun ./node_modules/vite/bin/vite.js build
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
        outputHash = "sha256-MC0GLl/BR4zoif5KNSKxSrTbJ6+D3soaKY/mAsnY0/M=";
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

        # Vendor via fetchCargoVendor (cargo's own downloader → sparse index
        # + static.crates.io), NOT importCargoLock: this box's omega proxy
        # 403s the crates.io API download endpoint that importCargoLock uses,
        # while static.crates.io returns 200.
        cargoHash = "sha256-5/nOlg/EsI5X+GKrGJl+qY+GQGosiSCJ4Hbo4TltaB8=";

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
      };

      devShells.${system}.default = pkgs.mkShell {
        packages = [
          pkgs.cargo
          pkgs.rustc
          pkgs.bun
          pkgs.nodejs
        ];
      };
    };
}
