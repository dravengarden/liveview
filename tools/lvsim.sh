#!/bin/bash
# lvsim — the agent's iOS-SIMULATOR control surface for liveview. Runs ON the Mac
# (the simulator, Xcode, ios_webkit_debug_proxy and osascript all live there).
# Drive it from hawk over SSH, e.g.:
#
#   ssh macbook-air liveview/tools/lvsim.sh eval 'document.title'
#   ssh macbook-air liveview/tools/lvsim.sh shot && scp macbook-air:lvsim.png .
#
# This is the canonical way to VERIFY liveview now — the iOS app is the primary
# target. Use Chrome/chrome-devtools-mcp ONLY for chart-review of book content,
# never to validate the app's UI/behaviour (the PWA build differs from native).
#
# The crown jewel is `eval`: real headless devtools on the running WebView via the
# in-app LvDevBridge (a loopback HTTP eval server, DEBUG builds only) — NOT
# ios_webkit_debug_proxy, which can't see the simulator (it discovers devices over
# usbmuxd; the sim isn't one, so its page list is always empty). The sim shares the
# Mac's loopback, so the bridge on 127.0.0.1:4170 is reachable directly. Prefer
# eval-driven interaction (`eval 'document.querySelector(sel).click()'`) over pixel
# `tap` — robust to window placement and theme. See .agents/skills/ios-sim-dev.
#
# CAUTION: port 9222 on the Mac is Mac CHROME's CDP (the chrome-tunnel + chrome-
# debug-bridge), NOT the sim. Inspecting :9222 talks to Chrome viewing the remote
# PWA, never the iOS app — that mix-up is exactly why we use the in-app bridge.
set -euo pipefail
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"
HERE="$(cd "$(dirname "$0")" && pwd)"

BID="top.thundersparrow.liveview"
DEVPORT=4170   # LvDevBridge eval server (must match LvDevBridge.swift)
# Auto-detect the booted sim (fall back to iPhone 17) so we don't hardcode a UDID
# that drifts when the simulator set changes.
sim_udid() {
  local b; b="$(xcrun simctl list devices booted 2>/dev/null | grep -oE '[0-9A-F-]{36}' | head -1 || true)"
  echo "${b:-D89613B8-4B25-4486-A690-5A7205AC2788}"
}
SIM="$(sim_udid)"

# Eval JS in the live app via the in-app bridge. --data-binary keeps the JS exactly
# (no curl form-encoding). Retries briefly so a just-launched app has time to listen.
dev_eval() {
  local js="$1" tries=0 out=""
  while [ $tries -lt 8 ]; do
    out="$(curl -s -m 6 --data-binary "$js" "http://127.0.0.1:$DEVPORT/eval" 2>/dev/null)" && {
      [ -n "$out" ] && { printf '%s\n' "$out"; return 0; }
    }
    tries=$((tries+1)); sleep 1
  done
  echo "FATAL: LvDevBridge not answering on 127.0.0.1:$DEVPORT — is a DEBUG build running? (curl /ping)" >&2
  return 1
}

cmd="${1:-help}"; shift || true
case "$cmd" in
  boot)        xcrun simctl boot "$SIM" 2>/dev/null || true; echo "booted $SIM" ;;
  launch)      xcrun simctl terminate "$SIM" "$BID" 2>/dev/null || true
               xcrun simctl launch "$SIM" "$BID"; sleep 2 ;;
  appearance)  xcrun simctl ui "$SIM" appearance "${1:-dark}"; echo "appearance=${1:-dark}" ;;
  shot)        out="${1:-$HOME/lvsim.png}"; xcrun simctl io "$SIM" screenshot "$out"; echo "$out" ;;
  tap)         # pixel tap (fragile — depends on Simulator window placement). Prefer `eval`+click.
               osascript -e "tell application \"System Events\" to click at {$1, $2}"; echo "tap $1 $2" ;;
  ping)        curl -s -m 4 "http://127.0.0.1:$DEVPORT/ping" || echo "(down)" ;;
  offline)     # deterministic airplane mode for the Rust content fetcher (DEBUG):
               # `lvsim offline on` / `lvsim offline off`. Forces lvsync:// network
               # misses to fail fast so the offline cache path can be tested. Driven
               # through the webview (the toggle lives in the Rust plugin now).
               on=$([ "${1:-on}" = "off" ] && echo 0 || echo 1)
               curl -s -m 8 --data-binary "return await (await fetch('lvsync://localhost/offline?on=$on')).text()" "http://127.0.0.1:$DEVPORT/aeval" ;;
  eval)        dev_eval "$1" ;;
  aeval)       # async eval: body runs as an async function; use `return` + `await`
               # (for fetch/contentFetch). e.g. aeval 'return (await fetch("/x")).status'
               curl -s -m 20 --data-binary "$1" "http://127.0.0.1:$DEVPORT/aeval" ;;
  url)         dev_eval 'location.href' ;;
  reload)      dev_eval 'location.reload()' ;;
  log)         # native NSLog / os_log for the app (catches Swift-side prints, incl. LvDevBridge)
               xcrun simctl spawn "$SIM" log stream --level debug --predicate "processImagePath CONTAINS[c] 'LiveView'" ;;
  status)      echo "sim=$SIM"; xcrun simctl list devices booted | grep -i booted || true
               printf "LvDevBridge: "; curl -s -m 3 "http://127.0.0.1:$DEVPORT/ping" 2>/dev/null || echo "down"
               echo; printf "app origin: "; dev_eval 'location.origin' 2>/dev/null || true ;;
  help|*)      sed -n '2,24p' "$0" ;;
esac
