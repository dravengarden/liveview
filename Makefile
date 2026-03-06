.PHONY: dev dev-web dev-server build build-web install uninstall clean fmt check

# Development: run frontend and backend in parallel
dev:
	@echo "Starting development servers..."
	@echo "Frontend: http://localhost:5173"
	@echo "Backend: http://localhost:4159"
	@$(MAKE) -j2 dev-web dev-server

dev-web:
	cd web && bun run dev

dev-server:
	cargo run -- --port 4159

# Build frontend SPA
build-web:
	cd web && bun install && bun run build

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
	cd web && bun run typecheck || true

check:
	cargo fmt --check
	cargo clippy -- -D warnings
	cd web && bun run typecheck

clean:
	cargo clean
	rm -rf web/dist web/node_modules
