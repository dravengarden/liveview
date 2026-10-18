#!/bin/bash
# Headless iOS SIMULATOR build + install + launch for fast, signing-free testing.
# Runs ON the Mac (ssh macbook-air 'bash -s' < tools/lvbuild-sim.sh [SIM_UDID]).
# Builds from ~/liveview/app (synced from hawk app/) and ~/liveview/web/dist-app.
# `lv-sync` / `plugins/lvsync` are gone; content lives in the TS IDB replica.
#
# Why: the device build (lvbuild.sh) needs keychain unlock + provisioning and
# installs to physical iPhone/iPad. A SIMULATOR build needs NO code-signing, so
# it's the fast inner loop for verifying the app (bundled SPA, thin host,
# IDB replica, native audio) without the device. Screenshot is captured to ~/lvsim.png.
#
# Bake a reachable backend: `LIVEVIEW_REMOTE_ORIGINS` is compile-time. The iOS
# Simulator cannot use the host's 127.0.0.1. Forward the var from hawk, e.g.
# ssh macbook-air "LIVEVIEW_REMOTE_ORIGINS='$LIVEVIEW_REMOTE_ORIGINS' bash -s" < tools/lvbuild-sim.sh
set -euo pipefail
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"
export LIVEVIEW_WIDGET_SERVER_URL="${LIVEVIEW_WIDGET_SERVER_URL:-}"
if ! xcodebuild -checkFirstLaunchStatus; then
  echo "FATAL: Xcode first-launch setup is incomplete; an administrator must run sudo xcodebuild -runFirstLaunch" >&2
  exit 69
fi
# Fail before building when Xcode's SDK setup is incomplete.
xcrun --sdk iphonesimulator --show-sdk-path >/dev/null
if [[ -z "${LIVEVIEW_REMOTE_ORIGINS:-}" || "${LIVEVIEW_REMOTE_ORIGINS}" == *127.0.0.1* ]]; then
  echo "WARN: LIVEVIEW_REMOTE_ORIGINS is unset or loopback; the Simulator cannot reach the Mac/hawk 127.0.0.1" >&2
fi

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
  rm -rf gen/apple/Externals gen/apple/build
  cargo clean --target aarch64-apple-ios-sim --package liveview-app
fi

# project.yml lists gen/apple/assets (where the build stages the frontend); it's
# an empty dir git can't track, so ensure it exists or xcodegen spec-validation
# fails ("missing source directory ... /assets").
mkdir -p gen/apple/assets

# Re-glob any new Sources/*.swift (cargo tauri ios build won't regenerate the
# xcodeproj on its own — a newly added controller would compile-skip silently).
( cd gen/apple && xcodegen generate )

# Keep Tauri's supported Xcode options server alive while Xcode targets the
# installed simulator. This also supports a simulator runtime older than the
# SDK when Xcode lists it as a valid destination. Embed the SPA, not a dev URL.
# Use a dedicated output and require build success; never launch a stale app
# from an unrelated DerivedData directory after a compiler or setup failure.
BUILD_DIR="$HOME/liveview/.simulator-build"
OPTIONS_LOG="$HOME/liveview/.simulator-options.log"
cargo tauri ios dev --open --no-dev-server --no-dev-server-wait --no-watch \
  --config '{"build":{"devUrl":null}}' >"$OPTIONS_LOG" 2>&1 &
OPTIONS_PID=$!
stop_options() {
  kill "$OPTIONS_PID" 2>/dev/null || true
  wait "$OPTIONS_PID" 2>/dev/null || true
}
trap stop_options EXIT
sleep 3
if ! kill -0 "$OPTIONS_PID" 2>/dev/null; then
  cat "$OPTIONS_LOG" >&2
  echo "FATAL: Tauri Xcode options server did not start" >&2
  exit 1
fi
xcodebuild -project gen/apple/liveview-app.xcodeproj -scheme liveview-app_iOS \
  -configuration debug -sdk iphonesimulator -destination "id=$SIM" \
  -derivedDataPath "$BUILD_DIR" CODE_SIGNING_ALLOWED=NO build
APP="$BUILD_DIR/Build/Products/debug-iphonesimulator/LiveView.app"
if [ ! -f "$APP/LiveView" ]; then echo "FATAL: simulator build did not produce $APP" >&2; exit 1; fi
printf '%s\n' "$BUILD_INPUT_HASH" > "$BUNDLE_STAMP"
echo "APP=$APP"

xcrun simctl boot "$SIM" 2>/dev/null || true   # idempotent; already-booted is fine
xcrun simctl install "$SIM" "$APP"
xcrun simctl terminate "$SIM" "$BID" 2>/dev/null || true
xcrun simctl launch "$SIM" "$BID"
sleep 6
xcrun simctl io "$SIM" screenshot "$HOME/lvsim.png" 2>/dev/null && echo "screenshot: ~/lvsim.png"
echo "LVSIM_OK"
