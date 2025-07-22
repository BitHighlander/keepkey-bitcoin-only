# KeepKey Bitcoin-Only Vault Build System
#
# Main targets:
#   make vault        - Build and run vault-v2 in development mode (with keepkey-rust)
#   make vault-build  - Build vault-v2 for production 
#   make vault-dev    - Quick development build (skips dependency checks)
#   make keepkey-rust - Build keepkey-rust library only
#   make clean        - Clean all build artifacts
#   make rebuild      - Clean and rebuild everything
#   make check-deps   - Verify keepkey-rust dependency linking
#   make test-keepkey-rust - Run keepkey-rust tests
#
# Dependencies:
#   - Rust/Cargo (for keepkey-rust and Tauri backend)
#   - Bun (for frontend dependencies)
#   - jq (for dependency verification)
.PHONY: all firmware kkcli rest vault-ui vault test test-rest clean keepkey-rust vault-build rebuild check-deps help

# Display help information
help:
	@echo "KeepKey Bitcoin-Only Vault Build System"
	@echo ""
	@echo "Main targets:"
	@echo "  vault         - Build and run vault-v2 in development mode (with keepkey-rust)"
	@echo "  vault-build   - Build vault-v2 for production"
	@echo "  vault-dev     - Quick development build (skips dependency checks)"
	@echo "  keepkey-rust  - Build keepkey-rust library only"
	@echo "  clean         - Clean all build artifacts"
	@echo "  rebuild       - Clean and rebuild everything"
	@echo "  check-deps    - Verify keepkey-rust dependency linking"
	@echo "  test-keepkey-rust - Run keepkey-rust tests"
	@echo ""
	@echo "Dependencies:"
	@echo "  - Rust/Cargo (for keepkey-rust and Tauri backend)"
	@echo "  - Bun (for frontend dependencies)"
	@echo "  - jq (for dependency verification)"

all: firmware kkcli rest vault-ui vault

test:
	cargo test --manifest-path projects/keepkey-rest/Cargo.toml --all-features

# Test keepkey-rust specifically
test-keepkey-rust:
	@echo "🧪 Testing keepkey-rust library..."
	cd projects/keepkey-rust && cargo test --all-features
	@echo "✅ keepkey-rust tests passed"

firmware:
	$(MAKE) -C firmware

kkcli:
	cd projects/kkcli && cargo build && target/debug/kkcli server

# Build keepkey-rust separately to ensure it's up to date
keepkey-rust:
	@echo "🔧 Building keepkey-rust library..."
	cd projects/keepkey-rust && cargo check --all-features
	cd projects/keepkey-rust && cargo build --release
	@echo "✅ keepkey-rust built successfully"

# Check dependencies and linking
check-deps:
	@echo "🔍 Checking keepkey-rust dependency in vault-v2..."
	cd projects/vault-v2/src-tauri && cargo tree | grep -E "(keepkey_rust|keepkey-rust)" || echo "⚠️  keepkey-rust not found in dependency tree"
	@echo "🔍 Verifying path dependency..."
	cd projects/vault-v2/src-tauri && cargo metadata --format-version 1 | jq -r '.packages[] | select(.name == "keepkey_rust") | .manifest_path' || echo "⚠️  Could not verify keepkey-rust path"

# Vault now depends on keepkey-rust being built first
vault: keepkey-rust check-deps
	@echo "🔧 Building vault-v2 with latest keepkey-rust..."
	cd projects/vault-v2 && bun i && tauri dev

# Build vault for production
vault-build: keepkey-rust check-deps
    lsof -ti:1420 | xargs kill -9 \
	@echo "🔧 Building vault-v2 for production with latest keepkey-rust..."
	cd projects/vault-v2 && bun i && tauri build

# Clean all build artifacts to force fresh builds
clean:
	@echo "🧹 Cleaning all build artifacts..."
	cd projects/keepkey-rust && cargo clean
	cd projects/vault-v2 && cargo clean
	rm -rf projects/vault-v2/node_modules
	rm -rf projects/vault-v2/dist
	rm -rf projects/vault-v2/src-tauri/target
	@echo "✅ All build artifacts cleaned"

# Force rebuild everything
rebuild: clean all

# Quick development build (skips some checks)
vault-dev:
	@echo "🚀 Quick vault-v2 development build..."
	cd projects/vault-v2 && bun i && tauri dev
