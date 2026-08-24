set shell := ["bash", "-euo", "pipefail", "-c"]

native-target-dir := "target/native"

# Show the available project commands.
default:
  @just --list

toolchain-check:
  actual="$(rustc --version --verbose | awk '/^release:/ { print $2 }')"; for manifest in Cargo.toml app/src-tauri/Cargo.toml; do required="$(cargo metadata --manifest-path "$manifest" --no-deps --format-version 1 | jq -r '.packages[0].rust_version')"; test "$required" = "$actual" || { echo "$manifest rust-version $required does not match pinned rustc $actual" >&2; exit 1; }; done

# Verify the repository-owned UI primitives are present.
shell:
  @test -f web/src/_shell/mod.ts

# Verify the standalone product website's metadata, anchors, and local assets.
website-check:
  deno run --allow-read tools/check-website.ts

# Start the frontend and backend development servers.
dev: shell
  #!/usr/bin/env bash
  set -euo pipefail
  echo "Starting development servers..."
  echo "Frontend: http://localhost:5173"
  echo "Backend: http://localhost:4159"
  just dev-web &
  web_pid=$!
  just dev-server &
  server_pid=$!
  trap 'kill "$web_pid" "$server_pid" 2>/dev/null || true' EXIT INT TERM
  wait -n "$web_pid" "$server_pid"

# Start only the frontend development server.
dev-web:
  cd web && deno task dev

# Start only the backend development server.
dev-server:
  cargo run --locked -- --port 4159

# Build the frontend SPA and native bundle.
build-web: shell
  cd web && deno install --frozen --allow-scripts && deno task build

# Build the release binary with the embedded SPA.
build: build-web
  cargo build --release --features embedded --locked

# Install the embedded release binary with Cargo.
install: build-web
  cargo install --locked --path . --features embedded

# Uninstall the Cargo binary.
uninstall:
  cargo uninstall liveview

# Format all Rust workspaces.
fmt:
  cargo fmt
  cargo fmt --manifest-path app/src-tauri/Cargo.toml
  nixfmt flake.nix

# Run formatting, linting, and type checks.
check: shell website-check
  cargo fmt --check
  cargo clippy --locked --all-targets -- -D warnings
  cargo fmt --manifest-path app/src-tauri/Cargo.toml --check
  CARGO_TARGET_DIR={{native-target-dir}} cargo clippy --locked --manifest-path app/src-tauri/Cargo.toml --all-targets -- -D warnings
  nixfmt --check flake.nix
  cd web && deno task typecheck

# Audit each independently locked Rust workspace that can be resolved on Linux.
dependencies:
  cargo deny check
  cargo machete --with-metadata
  cargo deny --manifest-path app/src-tauri/Cargo.toml check --config deny-native.toml
  cargo machete --with-metadata app/src-tauri

# Run all Rust and web tests.
test:
  cargo test --locked --all-targets
  CARGO_TARGET_DIR={{native-target-dir}} cargo test --locked --manifest-path app/src-tauri/Cargo.toml --all-targets
  cd web && deno task test

# Check the native dependency graph without requiring an Apple toolchain.
native-metadata:
  cargo tree --locked --manifest-path app/src-tauri/Cargo.toml --depth 0 >/dev/null

# Faster inner loop; the complete gate retains cargo test for doctests.
check-fast:
  cargo check --locked --bin liveview

test-fast:
  cargo nextest run --locked --all-targets
  CARGO_TARGET_DIR={{native-target-dir}} cargo nextest run --locked --manifest-path app/src-tauri/Cargo.toml --all-targets

# Opt-in clean-rebuild cache until representative A/B measurements justify a
# default wrapper for this repository.
build-cached:
  CC='sccache cc' CXX='sccache c++' RUSTC_WRAPPER=sccache CARGO_INCREMENTAL=0 cargo build --locked --all-targets

cache-stats:
  sccache --show-stats

# Preview bounded local artifact cleanup while preserving recently used builds.
cache-prune-dry root-max="20GB" workspace-max="4GB":
  cargo sweep --dry-run --maxsize {{root-max}} .
  cargo sweep --dry-run --maxsize {{workspace-max}} app/src-tauri

# Bound long-lived local artifact caches without forcing a complete rebuild.
cache-prune root-max="20GB" workspace-max="4GB":
  cargo sweep --maxsize {{root-max}} .
  cargo sweep --maxsize {{workspace-max}} app/src-tauri

# Verify the installed iOS Simulator bridge plugin.
plugin-check:
  bash tools/check-ios-simulator-plugin.sh

# Run the complete local quality gate.
verify: toolchain-check check dependencies test build native-metadata plugin-check

# Remove generated Rust and web build output.
clean:
  cargo clean
  cargo clean --manifest-path app/src-tauri/Cargo.toml
  rm -rf web/dist web/node_modules
