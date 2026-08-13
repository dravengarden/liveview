#!/bin/bash
# Headless iOS build+sign for the LiveView shell.
# Unlocks the login keychain IN this SSH session (the GUI unlock state does NOT
# carry across macOS security sessions, so codesign fails with
# errSecInternalComponent without this), then builds the signed device .app.
# The caller supplies the keychain password file explicitly; this script never
# owns a deployment credential or distribution channel.
set -euo pipefail

# WidgetKit can't read the Tauri web bundle's compile-time origin. Reuse the
# first configured LiveView origin as an Xcode build setting; an eventual App
# Group snapshot overrides it at runtime and keeps widgets offline-capable.
if [[ -z "${LIVEVIEW_WIDGET_SERVER_URL:-}" && -n "${LIVEVIEW_REMOTE_ORIGINS:-}" ]]; then
  export LIVEVIEW_WIDGET_SERVER_URL="${LIVEVIEW_REMOTE_ORIGINS%%,*}"
fi

# Never install a stale DerivedData product after a real compile failure. Tauri's
# IPA export may fail after xcodebuild has produced a valid .app, so the command
# remains tolerated below; freshness of the signed bundle is the actual gate.
BUILD_MARKER="$(mktemp -t liveview-build.XXXXXX)"
trap 'rm -f "$BUILD_MARKER"' EXIT

KCPW_FILE="${LIVEVIEW_KEYCHAIN_PASSWORD_FILE:-}"
KEYCHAIN="${LIVEVIEW_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"

if [[ -z "$KCPW_FILE" || ! -f "$KCPW_FILE" ]]; then
  echo "FATAL: set LIVEVIEW_KEYCHAIN_PASSWORD_FILE to a readable credential file" >&2
  exit 1
fi

security unlock-keychain -p "$(cat "$KCPW_FILE")" "$KEYCHAIN"

REPO_ROOT="${LIVEVIEW_SOURCE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$REPO_ROOT/app/src-tauri"

# The SPA and default window icon are compiled into Rust. Cargo does not track
# those files as normal source dependencies, so invalidate the device target
# when their bytes change or a successful build can install stale/invalid assets.
BUNDLE_DIR="$REPO_ROOT/web/dist-app"
BUNDLE_STAMP="gen/apple/.liveview-device-embedded-hash"
if [[ ! -d "$BUNDLE_DIR" ]]; then
  echo "FATAL: missing native web bundle: $BUNDLE_DIR" >&2
  exit 1
fi
BUILD_INPUT_HASH="$({
  find "$BUNDLE_DIR" icons -type f -print | LC_ALL=C sort | while IFS= read -r file; do
    shasum -a 256 "$file"
  done
} | shasum -a 256 | awk '{print $1}')"
PREVIOUS_BUILD_INPUT_HASH="$(cat "$BUNDLE_STAMP" 2>/dev/null || true)"
if [[ "$BUILD_INPUT_HASH" != "$PREVIOUS_BUILD_INPUT_HASH" ]]; then
  echo "embedded frontend or icon changed; invalidating Tauri iOS device artifacts"
  rm -rf gen/apple/Externals gen/apple/build target/aarch64-apple-ios/release
  printf '%s\n' "$BUILD_INPUT_HASH" > "$BUNDLE_STAMP"
fi

# project.yml lists gen/apple/assets (build stages the frontend there); empty dir
# git can't track → ensure it exists or xcodegen fails.
mkdir -p gen/apple/assets

# Re-run xcodegen so any NEW Sources/*.swift|*.mm files get globbed into the
# xcodeproj. `cargo tauri ios build` does NOT regenerate the project, so a freshly
# added controller would compile-skip silently (BUILD SUCCEEDED, but the file's
# not in pbxproj → symbol absent → its WKScriptMessageHandler never installs).
# Regenerating from the committed project.yml keeps signing (DEVELOPMENT_TEAM +
# Automatic) intact. xcodegen lives in Homebrew, which a non-login bash lacks.
export PATH="/opt/homebrew/bin:$PATH"
( cd gen/apple && xcodegen generate )

# The BUILD + codesign succeed over SSH, but the final IPA EXPORT step fails with
# "No Accounts" (it needs an Apple ID session). We don't need the .ipa — the signed
# .app is already in DerivedData — so tolerate a non-zero exit and check for the
# signed .app instead. (A REAL build failure leaves no fresh .app → install no-ops.)
cargo tauri ios build --target aarch64 || echo "note: cargo tauri ios build returned non-zero (IPA export failure is expected; using the signed DerivedData .app)"

# This helper proves that Xcode produced a fresh signed development app. Signing,
# distribution, installation, and release metadata remain caller-owned steps.
APP="$(ls -dt "$HOME"/Library/Developer/Xcode/DerivedData/liveview-app-*/Build/Products/release-iphoneos/LiveView.app | head -1)"
if [[ ! "$APP" -nt "$BUILD_MARKER" ]]; then
  echo "FATAL: build did not produce a fresh signed LiveView.app" >&2
  exit 1
fi
echo "BUILT $APP"
echo "LVBUILD_OK (not installed or distributed)"
