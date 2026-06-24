#!/bin/bash
# macOS DESKTOP build of the liveview app (A5). Runs ON the Mac:
#   ssh macbook-air 'bash -s' < tools/lvbuild-mac.sh
#
# Unlike iOS (gen/apple xcodeproj, built by lvbuild.sh / lvbuild-sim.sh), the macOS
# target is a plain Tauri DESKTOP build from the SAME app/src-tauri crate + the same
# bundled SPA (web/dist-app). The offline data layer is the cross-platform Rust
# `tauri-plugin-lvsync` (lv-sync + SqliteBlobStore) — the SAME store as iOS — served
# to the webview over the `lvsync://` scheme. There are NO Swift controllers on macOS
# (those are the iOS gen/apple Sources); audio falls back to the web <audio> element,
# which on the desktop has none of iOS's background/lock-screen limitations.
#
# Output: target/debug/bundle/macos/LiveView.app (+ a .dmg). The Rust plugin opens
# ~/Library/Application Support/top.thundersparrow.liveview/lvsync.sqlite and caches
# the corpus there, so the macOS app reads + plays offline just like iOS.
set -euo pipefail
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"
cd "$HOME/liveview/app/src-tauri"

# Build the bundled .app (+ .dmg). --debug skips release optimisation/notarisation;
# drop it for a release build (ad-hoc signed; a Developer ID is only needed for
# distribution outside the Mac).
cargo tauri build --debug

APP="$HOME/liveview/app/src-tauri/target/debug/bundle/macos/LiveView.app"
echo "APP=$APP"
[ -d "$APP" ] && echo "LVMAC_OK" || { echo "FATAL: no macOS .app produced" >&2; exit 1; }
