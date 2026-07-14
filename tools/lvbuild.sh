#!/bin/bash
# Headless iOS build+sign for the liveview shell over SSH.
# Unlocks the login keychain IN this SSH session (the GUI unlock state does NOT
# carry across macOS security sessions, so codesign fails with
# errSecInternalComponent without this), then builds the signed device .app.
# Password lives only in ~/.lvbuild-kcpw (chmod 600, user-created).
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

KCPW_FILE="$HOME/.lvbuild-kcpw"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if [[ ! -f "$KCPW_FILE" ]]; then
  echo "FATAL: $KCPW_FILE missing (create it: printf '%s' '<login password>' > ~/.lvbuild-kcpw && chmod 600 ~/.lvbuild-kcpw)" >&2
  exit 1
fi

security unlock-keychain -p "$(cat "$KCPW_FILE")" "$KEYCHAIN"

# Build from the consolidated layout (~/liveview/app, synced from main/app; the
# plugin is at ../../plugins/lvsync, the bundled SPA at ../../web/dist-app).
cd "$HOME/liveview/app/src-tauri"

# The SPA and default window icon are compiled into Rust. Cargo does not track
# those files as normal source dependencies, so invalidate the device target
# when their bytes change or a successful build can install stale/invalid assets.
BUNDLE_DIR="$HOME/liveview/web/dist-app"
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

# Install the freshly-signed .app to both paired devices (devicectl works over
# SSH; only codesign needed the keychain unlock above).
APP="$(ls -dt "$HOME"/Library/Developer/Xcode/DerivedData/liveview-app-*/Build/Products/release-iphoneos/LiveView.app | head -1)"
if [[ ! "$APP" -nt "$BUILD_MARKER" ]]; then
  echo "FATAL: build did not produce a fresh signed LiveView.app" >&2
  exit 1
fi
echo "INSTALLING $APP"
xcrun devicectl device install app --device 919779F8-8032-5B80-BA56-59646E340761 "$APP" >/dev/null 2>&1 && echo "iPhone: installed" || echo "iPhone: install FAILED"
xcrun devicectl device install app --device C3C4A814-5DBB-53B7-9B23-EB05F4A77FBE "$APP" >/dev/null 2>&1 && echo "iPad: installed" || echo "iPad: install FAILED"
echo "LVBUILD_OK"
