# LiveView PWA

LiveView's web build is an installable reader. It shares the React UI, content
replica, reading progress, preferences, and media-session controls with the native
app. Each browser installation has its own storage; it does not import the native
app's downloads or live playback state.

## Install and download

Open the HTTPS deployment in Safari on iPhone or iPad, then use Share → Add to Home
Screen. Enable “Open as Web App” if that option is offered. The manifest keeps a
stable `/` identity and scope. On other browsers use their installation menu.

Settings → Downloads exposes the same content and audio accounting, storage cap,
and audio LRU eviction as the app. Browser library downloads require an explicit
opt-in. Keep LiveView open while downloading. WiFi-only remains enabled by
default. When the browser cannot identify the connection, automatic audio waits;
turning WiFi-only off explicitly permits the current connection, including
cellular. Browser connection estimates are not native reachability guarantees.

The browser's quota is shown separately from the desired download cap. Persistent
storage can be requested, but the browser decides whether to grant it. Installing
on the Home Screen can improve retention; clearing browser data still removes
the library. Keep important original files independently of the reader cache.

## Offline and updates

The complete app shell, lazy reader routes, worker code, fonts, math renderer,
syntax highlighter, and diagram renderer install as one version. A failed install
leaves the previous worker active. Navigation never updates HTML independently of
its matching asset graph. A new version is offered as a button; applying it
activates the installed worker before reloading and preserves content/audio.

Content uses the shared IndexedDB replica. Audio bodies use `lv-audio-blobs` in
Cache Storage, keyed by the canonical `/api/blob/<hash>` URL. A dedicated worker
downloads at most two bodies concurrently, validates byte reservations and
BLAKE3 identity, then reports completion to the existing replica. The replica
owns the manifest, worklist, audio byte accounting, pin/LRU policy, and evictions.
Legacy `lv-blobs` audio is verified and moved on the next download pass.

The service worker serves cached audio with byte-range responses, including
suffix ranges and HTTP 416 for unsatisfiable requests. Every chapter, including
the final chapter and text read-aloud, uses its canonical hash when available.
The optional server-generated final spoken cue is omitted on this browser path;
it does not make the final chapter depend on the network.

## Native differences

| Capability | PWA | Native app |
|---|---|---|
| Reading, search, themes, progress and resume | Shared UI and replica | Shared UI and replica |
| Text, artwork and audio downloads | Opt-in, foreground, browser quota | Foreground native file downloads and shared replica |
| Offline audio seeking | Service worker range responses | Native local files |
| Playback and lock-screen integration | HTML audio and available Media Session APIs | AVPlayer, AVAudioSession and native media controls |
| Background/resume guarantees | Browser-managed; suspension can stop JavaScript or transfers | Native audio lifecycle |
| WiFi classification | Feature detection; unknown on unsupported browsers | NWPathMonitor |
| Storage retention | Browser-managed; persistent storage is discretionary | App-owned storage |
| Haptics and OS widgets | Browser capabilities only | Native integrations |

The current canonical audio is Opus in CAF. Verify HTML-audio decoding on each
target browser rather than assuming native AVPlayer support implies browser
support. The iOS WKWebView decoder can play this format; browsers without CAF
support download text and artwork only and require a future content-addressed
portable audio rendition. Do not silently
cache a transcoded body under the original CAF hash.

Release acceptance includes the production PWA with the backend unavailable,
cached audio ranges, failed and successful update transactions, actual iPhone
and iPad WKWebView performance with concurrent downloads, and installation and
background playback on a physical iOS device. Simulator verification cannot
prove Home Screen retention or physical-device background behavior.
