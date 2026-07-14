#!/bin/bash
# Headless iOS SIMULATOR build + install + launch for fast, signing-free testing.
# Runs ON the Mac (ssh macbook-air 'bash -s' < tools/lvbuild-sim.sh [SIM_UDID]).
# Builds from the consolidated layout: ~/liveview/app (synced from main/app) with
# the plugin at ~/liveview/plugins/lvsync (../../plugins/lvsync from src-tauri).
#
# Why: the device build (lvbuild.sh) needs keychain unlock + provisioning and
# installs to physical iPhone/iPad. A SIMULATOR build needs NO code-signing, so
# it's the fast inner loop for verifying the app (build split, bundled SPA,
# SQLite, offline) without the device. Screenshot is captured to ~/lvsim.png.
set -euo pipefail
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"
export LIVEVIEW_WIDGET_SERVER_URL="${LIVEVIEW_WIDGET_SERVER_URL:-}"

# Default sim: iPhone 17 (was Booted in `simctl list`). Override via $1.
SIM="${1:-D89613B8-4B25-4486-A690-5A7205AC2788}"
BID="top.thundersparrow.liveview"

cd "$HOME/liveview/app/src-tauri"

# Tauri embeds frontendDist in the Rust static library under Externals. Xcode's
# normal dependency graph does not notice that dist-app changed, so an otherwise
# successful incremental build can keep serving an older SPA. Invalidate only
# when the actual bundle bytes change; native-only rebuilds stay incremental.
BUNDLE_DIR="$HOME/liveview/web/dist-app"
BUNDLE_STAMP="gen/apple/.liveview-sim-embedded-hash"
if [ ! -d "$BUNDLE_DIR" ]; then
  echo "FATAL: missing native web bundle: $BUNDLE_DIR" >&2
  exit 1
fi
BUILD_INPUT_HASH="$({
  find "$BUNDLE_DIR" icons -type f -print | LC_ALL=C sort | while IFS= read -r file; do
    shasum -a 256 "$file"
  done
} | shasum -a 256 | awk '{print $1}')"
PREVIOUS_BUILD_INPUT_HASH="$(cat "$BUNDLE_STAMP" 2>/dev/null || true)"
if [ "$BUILD_INPUT_HASH" != "$PREVIOUS_BUILD_INPUT_HASH" ]; then
  echo "embedded frontend or icon changed; invalidating Tauri iOS Externals"
  rm -rf gen/apple/Externals gen/apple/build target/aarch64-apple-ios-sim/debug
  printf '%s\n' "$BUILD_INPUT_HASH" > "$BUNDLE_STAMP"
fi

# project.yml lists gen/apple/assets (where the build stages the frontend); it's
# an empty dir git can't track, so ensure it exists or xcodegen spec-validation
# fails ("missing source directory ... /assets").
mkdir -p gen/apple/assets

# Re-glob any new Sources/*.swift (cargo tauri ios build won't regenerate the
# xcodeproj on its own — a newly added controller would compile-skip silently).
( cd gen/apple && xcodegen generate )

# Simulator build: no signing, no IPA export. Tolerate a non-zero exit (the IPA
# export step has nothing to export for a sim) and locate the .app ourselves.
cargo tauri ios build --debug --target aarch64-sim --ci \
  || echo "note: cargo tauri ios build returned non-zero (sim has no IPA export; using the .app)"

APP="$(ls -dt "$HOME"/Library/Developer/Xcode/DerivedData/liveview-app-*/Build/Products/*-iphonesimulator/LiveView.app 2>/dev/null | head -1)"
if [ -z "$APP" ]; then echo "FATAL: no simulator .app found in DerivedData" >&2; exit 1; fi
echo "APP=$APP"

xcrun simctl boot "$SIM" 2>/dev/null || true   # idempotent; already-booted is fine
xcrun simctl install "$SIM" "$APP"
xcrun simctl terminate "$SIM" "$BID" 2>/dev/null || true
xcrun simctl launch "$SIM" "$BID"
sleep 6
xcrun simctl io "$SIM" screenshot "$HOME/lvsim.png" 2>/dev/null && echo "screenshot: ~/lvsim.png"
echo "LVSIM_OK"
