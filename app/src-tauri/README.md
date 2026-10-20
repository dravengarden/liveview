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
specific endpoints. That loopback default is only reachable from the same
host: **iOS Simulator and physical devices cannot use it**. Device and
simulator builds must bake a host those runtimes can reach (LAN or public
HTTPS). Do not commit private addresses.

The LiveView server always CORS-allows `lvsync://localhost`. Redeploy the
server before expecting a thin-host IPA to `fetch` `/api/dag` or `/api/blob`.

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

## Background chapter continuation

`NativeAudioController` owns decoding, transport, and a generic in-memory
`NativePlaybackQueue`. The reader resolves each chapter's selected voice and
passes URL/hash/byte count plus an opaque context in batches of at most 16
tracks. A native end notification directly replaces the item and resumes the
existing audio session. Neither IndexedDB nor JavaScript is on that path.
Unready voices retain their queue position; they never fall back to another
voice or skip a chapter. Bulk cache downloads retain their foreground policy.

This is an additive protocol-v1 capability, advertised by
`state -> snapshot.queueVersion = 1`. `load` optionally includes
`queue: {id,index,count}` and `context`. The capability adds `queueTracks`,
`queueGo`, `queueAck`, and `sleep`. Old bundles keep their single-track behavior;
new bundles use the existing path when the shell does not advertise support.
Playback events carry the queue identity/index, so delayed events cannot change
a newer source. Hidden queued playback suppresses transient web events and
returns a current snapshot on foreground/resync. Completion acknowledgements
are bounded batches; sleep time counts native listening time across chapters.

On reload the native active track takes precedence over local/server resume
hints. The web restores its matching chapter spine and loads read-along data
without replacing, pausing, or seeking the native player.

`tools/lvbuild-sim.sh` runs the Swift queue/sleep model tests before the simulator
build. The DEBUG bridge's `/audio` endpoint (also `lvsim.sh audio`) reads native
state or sends a transport command without waking WKWebView. Use it to verify
multiple background transitions, then check foreground chapter/position,
reload, speed, sleep expiry, and manual transport. Confirm the Playback/
SpokenAudio session and inspect interruption handling on physical devices.
