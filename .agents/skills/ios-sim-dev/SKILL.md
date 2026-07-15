---
name: ios-sim-dev
description: Build, launch, inspect, and visually verify the liveview Tauri app in the Mac iOS Simulator from hawk. Use for liveview native app UI debugging, simulator self-tests, WebView DOM inspection, screenshots, themes, or JavaScript evaluation.
---

# Verify liveview in the iOS Simulator

The native app is the primary target. Browser behavior is not sufficient evidence because the bundled Tauri app has a different origin, target, service-worker state, and native data path. Chrome tooling is reserved for book chart review.

Use the installed `ios-simulator-bridge` plugin for generic SSH, Simulator, and
evidence conventions. This project skill remains authoritative for LiveView's
source sync, build graph, bundle identity, selectors, and acceptance criteria.

## Control surface

Drive the Mac helper over SSH:

```bash
ssh macbook-air liveview/tools/lvsim.sh status
ssh macbook-air liveview/tools/lvsim.sh ping
ssh macbook-air liveview/tools/lvsim.sh url
ssh macbook-air liveview/tools/lvsim.sh launch
ssh macbook-air liveview/tools/lvsim.sh log
```

The debug-only bridge evaluates JavaScript inside the actual simulator WKWebView:

```bash
ssh macbook-air liveview/tools/lvsim.sh eval \
  '(()=>JSON.stringify({origin:location.origin,target:globalThis.__TARGET__,ua:navigator.userAgent}))()'
```

Require an iPhone user agent and the expected bundled app origin. Port 9222 is Mac Chrome, not the simulator. Do not use `ios_webkit_debug_proxy` for simulator WebViews.

Prefer selector-driven interaction through `eval` over pixel taps. Use computed styles and DOM state for behavior claims; use screenshots for visual claims.

## Build, install, and launch

From the liveview worktree on hawk:

```bash
nix develop -c just build-web
rsync -a --delete web/dist-app/ macbook-air:liveview/web/dist-app/
rsync -a --exclude target/ --exclude gen/apple/build/ --exclude gen/apple/Externals/ app/ macbook-air:liveview/app/
rsync -a --exclude target/ lv-sync/ macbook-air:liveview/lv-sync/
rsync -a --exclude target/ plugins/lvsync/ macbook-air:liveview/plugins/lvsync/
ssh macbook-air 'bash -s' < tools/lvbuild-sim.sh
```

Build and sync the native SPA plus all three native trees. `app/src-tauri` uses
path dependencies outside `app/`, so syncing only the shell can silently compile
stale native code already present on the Mac. Tauri embeds `dist-app` in the Rust
static library; `lvbuild-sim.sh` hashes it and invalidates `gen/apple/Externals`
when its bytes change. A successful Xcode build without this invalidation can
still launch an older UI.

Native Swift, Objective-C++, Rust, manifest, or Tauri configuration changes require a rebuild. Pure SPA changes may use the project's documented HMR loop when available.

## Verification loop

1. Check simulator and bridge status.
2. Build and launch when the installed bundle may be stale.
3. Confirm identity with `origin`, `target`, and user agent.
4. Exercise the changed flow using stable selectors.
5. Test both appearances:

   ```bash
   ssh macbook-air liveview/tools/lvsim.sh appearance light
   ssh macbook-air liveview/tools/lvsim.sh appearance dark
   ```

6. Capture each important visual state:

   ```bash
   ssh macbook-air liveview/tools/lvsim.sh shot
   scp macbook-air:lvsim.png /tmp/lvsim.png
   ```

7. Inspect the local image with the image viewing tool and record DOM/computed-style evidence for regressions that screenshots alone cannot prove.

If the bridge is down, relaunch once and retry. If it remains down, rebuild the debug app and inspect native logs. Release builds intentionally omit the bridge.
