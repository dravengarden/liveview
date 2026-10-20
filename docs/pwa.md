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
and audio LRU eviction as the app. Downloads default on; existing explicit
opt-outs remain respected. Opening a book preloads the selected voice for its
whole spine, prioritizing the current chapter, the next two, the previous one,
and then the remaining chapters. Settings can limit preloading to the current
chapter and next two, or disable automatic preloading. Generation of missing
audio remains a separate server policy.

WiFi and cellular are both allowed by default. Existing WiFi-only choices are
preserved. With WiFi-only enabled, an unidentified connection waits rather than
assuming it is WiFi. Keep LiveView open while downloading. Browser connection
estimates are not native reachability guarantees.

The contents list reports per-chapter cache state and selected-voice book
coverage. “Cached” requires local audio and timing data; server-ready audio alone
does not qualify. Cache inspection is bounded to 32 entries per pass, with at
most two transfers dispatched at once. Completion, navigation, foreground,
network changes and bounded retry deadlines wake the scheduler. Failures back
off up to five minutes, and the storage cap includes pending transfers.
Navigation retains verified cache states and retry deadlines. A failed native
cache probe does not erase disk accounting or stop checks for other chapters.
Browser downloads time out after two minutes without progress, rather than
limiting the total transfer duration; native transfers retain their scheduler
slot until the host reports completion.
Turning preloading off stops new dispatch; at most two already dispatched
transfers can finish. Device preferences and replica bookkeeping persist across
reloads. Reopening the book replans unfinished work against its current hashes.

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
| Text, artwork and audio downloads | Automatic by default, foreground, browser quota | Foreground native file downloads and shared replica |
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
