.PHONY: dev dev-web dev-server build build-web install uninstall clean fmt check

# Development: run frontend and backend in parallel
dev:
	@echo "Starting development servers..."
	@echo "Frontend: http://localhost:5173"
	@echo "Backend: http://localhost:4159"
	@$(MAKE) -j2 dev-web dev-server

dev-web:
	cd web && deno task dev

dev-server:
	cargo run -- --port 4159

# Build frontend SPA
build-web:
	cd web && deno install --allow-scripts && deno task build

# Build release binary with embedded SPA
build: build-web
	cargo build --release --features embedded

# Install using cargo install
install: build-web
	cargo install --path . --features embedded

uninstall:
	cargo uninstall lv

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
