.PHONY: dev dev-web dev-server build build-web install uninstall clean fmt check shell

# Materialize the shared-utils ui SDK into web/src/_shell/ from the Nix
# package (it is NOT committed in this repo — gitignored). Run once after a
# fresh checkout and whenever the SDK changes; dev/build targets depend on it.
shell:
	nix build .#shared-ui-src -o .shell-src
	mkdir -p web/src/_shell
	cp -f .shell-src/* web/src/_shell/
	chmod -R u+w web/src/_shell
	rm -f .shell-src

# Development: run frontend and backend in parallel
dev: shell
	@echo "Starting development servers..."
	@echo "Frontend: http://localhost:5173"
	@echo "Backend: http://localhost:4159"
	@$(MAKE) -j2 dev-web dev-server

dev-web:
	cd web && deno task dev

dev-server:
	cargo run -- --port 4159

# Build frontend SPA
build-web: shell
	cd web && deno install --allow-scripts && deno task build

# Build release binary with embedded SPA
build: build-web
	cargo build --release --features embedded

# Install using cargo install
install: build-web
	cargo install --path . --features embedded

uninstall:
	cargo uninstall liveview

fmt:
	cargo fmt
	cd web && deno task typecheck || true

check:
	cargo fmt --check
	cargo clippy -- -D warnings
	cd web && deno task typecheck

clean:
	cargo clean
	rm -rf web/dist web/node_modules
