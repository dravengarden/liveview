# liveview flake — pure-Nix build of the `liveview` binary: the React/MUI SPA
# (bun + vite) and the axum daemon that embeds it via include_dir!.
#
# `nix build` produces a binary equivalent to `bun run build` followed by
# `cargo build --release --features embedded`, with no external build
# orchestration (no docker compile sandbox). The SPA uses a dependencies-only
# fixed-output cache plus an offline, content-addressed Vite build.
{
  description = "liveview — book reader (axum + embedded React SPA, pg + rustfs backed)";

  # Match the NixOS release used by the production host. The frontend's
  # dependency tree is produced through nixpkgs, so the standalone and host
  # builds must use the same release generation for depsHash to stay valid.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  inputs.rust-overlay = {
    url = "github:oxalica/rust-overlay";
    inputs.nixpkgs.follows = "nixpkgs";
  };
  inputs.crane.url = "github:ipetkov/crane";

  outputs =
    {
      self,
      nixpkgs,
      rust-overlay,
      crane,
    }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        overlays = [ rust-overlay.overlays.default ];
      };
      lib = pkgs.lib;
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
          pathString == root || inWeb || inTools;
        name = "liveview-web-source";
      };

      # Keep the web toolchain self-contained so an anonymous clone has no
      # private flake inputs. nixpkgs trails the upstream Bun release, so pin
      # the official binary through nixpkgs' own packaging; remove this once
      # nixpkgs carries the same Bun.
      bun = pkgs.bun.overrideAttrs (_: rec {
        version = "1.4.3";
        src = pkgs.fetchurl {
          url = "https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-linux-x64-baseline.zip";
          hash = "sha256-H8LtrIQxApCeOhvh2NmALMYHHPB05n6IIx9P/g+LOXs=";
        };
      });

      # edge-tts remains an optional reference speech adapter. The default
      # package does not depend on it; deployments may select the adapter bundle.
      edgeTts = pkgs.python3Packages.edge-tts;

      # Vendor only npm dependencies in the fixed-output derivation. Application
      # source is compiled later in a normal derivation, so source changes can
      # never reuse a stale bundle.
      webDeps = pkgs.stdenvNoCC.mkDerivation {
        pname = "liveview-web-deps";
        inherit version;
        src = pkgs.runCommandLocal "liveview-web-deps-src" { } ''
          mkdir -p $out
          for f in package.json bun.lock bunfig.toml; do
            if [ -e "${webBuildSrc}/web/$f" ]; then cp "${webBuildSrc}/web/$f" "$out/$f"; fi
          done
        '';
        nativeBuildInputs = [ bun ];
        dontUnpack = true;
        dontConfigure = true;
        buildPhase = ''
          export HOME=$TMPDIR
          export BUN_INSTALL_CACHE_DIR=$TMPDIR/bun-cache
          export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
          cp -RL $src/. .
          chmod -R u+w .
          # Lifecycle scripts stay off: their output is not part of the
          # lockfile's identity. The hoisted linker and plain copies keep the
          # tree free of cache hardlinks and store references.
          bun install --frozen-lockfile --ignore-scripts --linker=hoisted --backend=copyfile --no-progress
          mkdir -p $out
          cp -R node_modules $out/node_modules
        '';
        dontInstall = true;
        dontFixup = true;
        outputHashMode = "recursive";
        outputHashAlgo = "sha256";
        outputHash = "sha256-0Z3BamxPJ/nntveGc6Eupwo+JynN0iJladzGYa3NSdE=";
      };

      liveview-web = pkgs.stdenvNoCC.mkDerivation {
        pname = "liveview-web";
        inherit version;
        src = webBuildSrc;
        nativeBuildInputs = [ bun ];
        dontConfigure = true;
        buildPhase = ''
          export HOME=$TMPDIR
          cd web
          cp -R ${webDeps}/node_modules node_modules
          chmod -R u+w node_modules
          # Package bins carry a `/usr/bin/env node` shebang, and the sandbox
          # has neither /usr/bin/env nor node. Point them at the pinned Bun
          # under node's name, which is how Bun selects its node mode.
          mkdir -p $TMPDIR/bin
          ln -s ${bun}/bin/bun $TMPDIR/bin/node
          export PATH=$TMPDIR/bin:$PATH
          patchShebangs node_modules
          bun run build
        '';
        installPhase = "cp -R dist $out";
        dontFixup = true;
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

        # sqlx is postgres-only (pure-Rust driver, no libpq) and the S3 client
        # uses rustls. ffmpeg owns format conversion but no speech provider.
        nativeBuildInputs = [
          pkgs.pkg-config
          pkgs.makeWrapper
          pkgs.ffmpeg
        ];

        # Keep only provider-neutral runtime media tooling on PATH.
        postInstall = ''
          wrapProgram $out/bin/liveview --prefix PATH : ${lib.makeBinPath [ pkgs.ffmpeg ]}
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

      liveviewWithEdgeTts = pkgs.symlinkJoin {
        name = "liveview-with-edge-tts-${version}";
        paths = [ liveview ];
        nativeBuildInputs = [ pkgs.makeWrapper ];
        postBuild = ''
          wrapProgram $out/bin/liveview --prefix PATH : ${lib.makeBinPath [ edgeTts ]}
        '';
        meta = liveview.meta // {
          description = "LiveView with the optional edge-tts speech adapter";
        };
      };
    in
    {
      packages.${system} = {
        inherit liveview liveview-web;
        liveview-with-edge-tts = liveviewWithEdgeTts;
        default = liveview;
      };

      checks.${system} = {
        inherit liveview liveview-web;
      };

      devShells.${system}.default = pkgs.mkShell {
        packages = [
          rustToolchain
          pkgs.sccache
          pkgs.cargo-sweep
          pkgs.cargo-nextest
          pkgs.cargo-deny
          pkgs.cargo-machete
          pkgs.rust-analyzer
          pkgs.just
          pkgs.jq
          pkgs.nixfmt
          bun
          pkgs.ffmpeg
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
