# liveview native shell (Tauri 2)

A **thin native WebView wrapper** around the liveview UI. It bundles no frontend
and embeds no backend — the window loads the already-https remote UI:

```
https://liveview.hawk.thundersparrow.top   (caddy → localhost:4160, tailnet-only)
```

This mirrors cowboy's `tauri-shell` strategy: **code on hawk, build on the Mac.**
The cross-platform scaffolding in this dir is authored on hawk and synced to the
Mac; the platform-specific generation + builds happen on the Mac (Xcode).

## Why this exists

liveview's backend (axum + pg + rustfs) only runs on hawk, so the client is a
pure reader over the remote UI. As a web PWA it already works well — EXCEPT for
one hard iOS limit that **only a native WKWebView can fix**:

- **Background / lock-screen audiobook playback.** A web PWA's `<audio>` is
  suspended the moment the screen locks or the app backgrounds, and it can't own
  the lock-screen / Control Center transport. The audiobook is liveview's
  headline feature, so this is the whole point of the shell.

The native fix has two halves, both wired up here:

1. `UIBackgroundModes = [audio]` in `Info.ios.plist` (merged into the app
   Info.plist every build).
2. An `AVAudioSession` in the **Playback / SpokenAudio** category, set in
   `gen/apple/Sources/liveview-app/LiveviewNativeTweaks.mm`. The web layer's
   existing MediaSession code then drives the lock-screen controls.

No Tauri IPC is exposed to the remote origin
(`dangerousRemoteDomainIpcAccess` is intentionally unset) — the native value is
purely the WKWebView + the audio-session tweak.

## Prerequisites (build host = a Mac)

iOS/macOS builds need Xcode — they **cannot** run on hawk (Linux). On the Mac:

- Xcode + command line tools
- `cargo-tauri` (`cargo install tauri-cli --version '^2'`)
- iOS Rust targets: `aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios`
- the device/simulator must be on the **tailnet** to reach the remote URL

## Workflow (code on hawk, build on Mac)

```sh
# Sync this dir hawk → Mac (rsync src-tauri/, like the cowboy shell).
# Then, on the Mac, from src-tauri/:

# 0. one-time: generate the icon set from liveview's PWA icon
cargo tauri icon ../web/public/icon-512.png

# 1. one-time: generate the iOS Xcode project. This creates gen/apple/* (pbxproj,
#    project.yml, the Info.plist template, main.mm, bindings). It PRESERVES the
#    hand-authored files already committed here — LaunchScreen.storyboard, the
#    LaunchBackground colour set, and Sources/liveview-app/LiveviewNativeTweaks.mm
#    — and re-globs Sources/ so the tweak file compiles in. Commit gen/apple after.
cargo tauri ios init

# 2. desktop dev (fastest smoke test that the remote URL loads natively)
cargo tauri dev

# 3. iOS dev on a simulator / connected device
cargo tauri ios dev

# 4. release bundles
cargo tauri build              # macOS .app/.dmg
cargo tauri ios build          # iOS .ipa
```

`gen/apple` is committed so the app builds without re-running init; `gen/schemas`
and `target/` are gitignored.

## Native-layer customizations

- **Background / lock-screen audio** — `Info.ios.plist` (`UIBackgroundModes`) +
  `LiveviewNativeTweaks.mm` (AVAudioSession Playback/SpokenAudio). The web app
  already calls the MediaSession API, so the lock-screen artwork + transport
  light up once the session is Playback.
- **Keyboard accessory bar removed** — same `.mm` swizzles the private
  `WKContentView`'s `inputAccessoryView` to nil, so focusing the shelf search box
  shows only the QuickType bar, not the ∧∨+Done strip.
- **Branded launch screen** — `LaunchScreen.storyboard` fills with the
  `LaunchBackground` colour set (light `#ffffff` / dark `#0d1117`), matching the
  web app's pre-mount splash so cold start has no white flash.

- **Local Network loader** — `../loader/index.html` is bundled as `frontendDist`
  instead of the remote URL. On iOS the first connection to the tailnet host
  trips the one-time "Local Network" prompt; the old direct-to-remote load
  white-screened until force-quit. The loader boots locally (never white), probes
  the remote, then redirects — granting reconnects automatically, denying shows
  an error card with a "去设置开启" deep-link (opener plugin → `app-settings:`).
  See the comment at the top of `loader/index.html` for the full flow. Exposes
  `tauri-plugin-opener` + `opener:allow-open-url` (the only IPC the shell grants).

Safe-area insets (`env(safe-area-inset-*)`) are reported correctly by the native
WebView with no extra code.

### Rebuilding after the Local Network loader change (do this on the Mac)

No `tauri ios init` re-gen needed — the loader is `frontendDist` (re-embedded by
the Rust rebuild) and the opener is a normal dependency. From `src-tauri/`:

```sh
export PATH=/opt/homebrew/bin:$PATH
cargo tauri ios build        # first run adds tauri-plugin-opener to Cargo.lock — commit it
```

Then re-sign + reinstall, and verify on-device (identical flow to the cowboy
shell — see `projects/cowboy/tauri-shell/src-tauri/README.md`):

1. **Delete the app first** so iOS re-shows the Local Network prompt.
2. Launch → Allow → connects within ~1–3s, no white screen, no reopen.
3. Re-install → Don't Allow → error card; **去设置开启** opens Settings on
   LiveView's page; toggle on + swipe back → auto-reconnects (no tap).
4. If 去设置开启 doesn't open Settings, the opener invoke shape may differ —
   check `openSettings()` in `loader/index.html` (it degrades to a manual hint).

### If background audio still pauses on lock (on-device tuning)

The Info.plist `audio` mode + Playback category is the documented baseline, but
WKWebView background audio can need device testing. If it still pauses:

- confirm the web `<audio>` is actually playing through MediaSession with a valid
  `setPositionState` (liveview already does this);
- the session may need re-asserting (`setActive:YES`) when playback starts or on
  `AVAudioSessionInterruptionNotification` — add that to the `.mm` if needed;
- AVFoundation is linked explicitly in `gen/apple/project.yml` (the `#import`
  does NOT auto-link it — the first build failed on `_AVAudioSession*` undefined
  symbols until it was added). `cargo tauri ios init` regenerates project.yml and
  DROPS that line, so re-add it + `xcodegen generate` if you ever re-init.

## Gotchas (from the cowboy shell, same toolchain)

- **Homebrew isn't on the non-interactive PATH.** `tauri ios init`/`build` shell
  out to `xcodegen` / `pod`; over SSH `export PATH=/opt/homebrew/bin:$PATH` first
  or it fails trying to `brew install` them.
- **`cargo tauri ios init` regenerates the in-project `Info.plist` and the
  pbxproj from templates.** It wipes hand edits to the generated `Info.plist`
  (→ use `Info.ios.plist`, which it merges) but leaves `LaunchScreen.storyboard`,
  Assets, and extra `Sources/*.mm` alone. Re-running init is how a newly added
  source file gets into the build (it makes xcodegen re-glob `Sources/`).
- **Free Apple ID provisioning profiles expire ~weekly.** Like the cowboy shell
  (see the `cowboy-ios-resign` skill), a free-tier signed build stops launching
  after ~7 days; rebuild + reinstall to re-sign. A paid developer account avoids
  this.
- **Simulator software keyboard won't appear** while "Connect Hardware Keyboard"
  is on (`defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false`,
  then reboot the sim) — needed to verify the accessory-bar change.
