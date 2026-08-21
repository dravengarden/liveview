# LiveView native shell

This is the Tauri 2 shell for LiveView. It bundles the app-mode SPA, serves it
from the local `lvsync://` origin, and connects to one or more configured
LiveView servers. The backend is not embedded in the application.

## Why a native shell?

The PWA covers normal browser reading. The native shell adds capabilities that
mobile browsers cannot provide reliably:

- background and lock-screen audiobook playback;
- cover-first Home Screen and Lock Screen reading widgets;
- native media controls and haptics;
- a thin `lvsync://localhost` overlay host (protocol v1; OTA files native-fetched from baked origins);
- TypeScript IndexedDB as the content replica (`web/src/replica/`, same origin). No Service Worker in this shell.

## Configure backend origins

Set the same comma-separated origin list for the Web and Rust layers when
building the app:

```sh
export VITE_LIVEVIEW_ORIGINS="https://reader.example.com,http://192.168.1.10:4160"
export LIVEVIEW_REMOTE_ORIGINS="$VITE_LIVEVIEW_ORIGINS"
```

Both layers race the configured origins and keep the first healthy route. A
plain checkout defaults to `http://127.0.0.1:4160` and contains no deployment-
specific endpoints.

`tools/lvbuild.sh` also compiles the first remote origin into the WidgetKit
extension. The widget keeps its own last-good cover/progress cache, and uses an
App Group snapshot opportunistically when that entitlement is available. A
missing or unreadable cover is the only case that uses the solid-color book
fallback; landscape `backdrop` artwork is never substituted for a cover.

## Prerequisites

iOS and macOS builds require a Mac with:

- Xcode and the command line tools;
- `cargo-tauri` 2.x;
- the required Rust targets (`aarch64-apple-ios`,
  `aarch64-apple-ios-sim`, and optionally `x86_64-apple-ios`).

Build the app-mode frontend from the repository root before invoking Tauri:

```sh
nix develop -c just build-web
cd app/src-tauri
cargo tauri dev
cargo tauri build
cargo tauri ios dev
cargo tauri ios build
```

`gen/apple` is committed so routine builds do not need to regenerate the Xcode
project. Run `cargo tauri ios init` only when intentionally refreshing generated
platform scaffolding, then review the generated diff carefully.

## Native customizations

- `Info.ios.plist` enables background audio.
- `LiveviewNativeTweaks.mm` configures `AVAudioSession` for spoken playback and
  removes the WKWebView keyboard accessory strip.
- `LaunchScreen.storyboard` and `LaunchBackground` provide matching light and
  dark launch surfaces.
- `src/host.rs` owns the thin `lvsync://` overlay, origins, and host-info.
  Content replica is TypeScript IndexedDB (`web/src/replica/`), not SQLite.

If background playback pauses on a physical device, verify that the web audio
element has an active MediaSession, confirm the Playback/SpokenAudio session is
active, and inspect interruption handling before changing WebView behavior.
