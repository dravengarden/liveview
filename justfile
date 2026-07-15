set shell := ["bash", "-euo", "pipefail", "-c"]

# Show the available project commands.
default:
  @just --list

# Materialize the shared UI SDK when the checkout does not use a development link.
shell:
  @if [[ -L web/src/_shell ]]; then \
    echo "Using linked shared UI: $(readlink web/src/_shell)"; \
  else \
    nix build .#shared-ui-src -o .shell-src; \
    mkdir -p web/src/_shell; \
    cp -f .shell-src/* web/src/_shell/; \
    chmod -R u+w web/src/_shell; \
    rm -f .shell-src; \
  fi

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
  cargo run -- --port 4159

# Build the frontend SPA and native bundle.
build-web: shell
  cd web && deno install --frozen --allow-scripts && deno task build

# Build the release binary with the embedded SPA.
build: build-web
  cargo build --release --features embedded

# Install the embedded release binary with Cargo.
install: build-web
  cargo install --path . --features embedded

# Uninstall the Cargo binary.
uninstall:
  cargo uninstall liveview

# Format all Rust workspaces.
fmt:
  cargo fmt
  cargo fmt --manifest-path lv-sync/Cargo.toml
  cargo fmt --manifest-path plugins/lvsync/Cargo.toml
  cargo fmt --manifest-path app/src-tauri/Cargo.toml

# Run formatting, linting, and type checks.
check:
  cargo fmt --check
  cargo clippy --all-targets -- -D warnings
  cargo fmt --manifest-path lv-sync/Cargo.toml --check
  cargo clippy --manifest-path lv-sync/Cargo.toml --all-targets -- -D warnings
  cargo fmt --manifest-path plugins/lvsync/Cargo.toml --check
  cargo clippy --locked --manifest-path plugins/lvsync/Cargo.toml --all-targets -- -D warnings
  cargo fmt --manifest-path app/src-tauri/Cargo.toml --check
  cd web && deno task typecheck

# Run all Rust and web tests.
test:
  cargo test --locked --all-targets
  cargo test --locked --manifest-path lv-sync/Cargo.toml
  cargo test --locked --manifest-path plugins/lvsync/Cargo.toml --all-targets
  cd web && deno task test

# Check the native dependency graph without requiring an Apple toolchain.
native-metadata:
  cargo metadata --locked --manifest-path app/src-tauri/Cargo.toml --format-version 1 >/dev/null

# Verify the installed iOS Simulator bridge plugin.
plugin-check:
  bash tools/check-ios-simulator-plugin.sh

# Run the complete local quality gate.
verify: check test build-web native-metadata plugin-check

# Remove generated Rust and web build output.
clean:
  cargo clean
  rm -rf web/dist web/node_modules
