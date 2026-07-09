// NativeAudioController — a NATIVE AVPlayer audio engine for an iOS WKWebView
// shell. The web app drives it as a thin remote; the actual decoding + audio
// session live natively.
//
// WHY (not the web <audio>): WKWebView web audio cannot reliably hold the audio
// session or resume after a long background/locked pause — a known WebKit
// limitation (the background-audio entitlement is system-gated; bugs.webkit.org
// #198277 / #204261). So lock-screen / background / AirPods playback that must
// survive a pause has to be decoded natively. Unlike a half-native bridge
// (native owning only the session while WebKit still decodes — which races
// WebKit on the play gesture and deadens the play button), here native is the
// SOLE audio source, so it owns the session with no conflict.
//
// Protocol (web ⇄ native):
//   web → native   (WKScriptMessage "lvNativeAudio"): {kind, data?}
//       load {url, position, rate, title, artist, album, artworkUrl}
//       play | pause | stop
//       seek {position} | rate {rate}
//   native → web   (CustomEvent "lv-native-audio"): {type, ...}
//       time {position, duration} | durationchange {duration}
//       playing | paused | ended | waiting | canplay
//       next | prev   (remote next/prev track — the WEB owns the queue)
//       error {message}
//
// Lock-screen / AirPods / CarPlay transport runs through MPRemoteCommandCenter +
// MPNowPlayingInfoCenter, applied DIRECTLY to the AVPlayer (play/pause/seek/skip)
// and echoed to the web so its UI + read-along stay in sync.
//
// Offline cache (M2): download-aside, content-addressed. A cached chapter plays
// from the LOCAL file (offline + instant); an uncached one streams the origin AND
// downloads it in the background so the next play is local. Keyed by the web's
// content hash (dedup + survive re-render) when supplied, else the URL. Chosen
// over a single-pass AVAssetResourceLoaderDelegate for robustness (no Range
// bookkeeping); on the tailnet the first-play double-fetch is negligible.
//
// Concurrency: classic main-thread MediaPlayer/AVFoundation. Script messages and
// remote-command callbacks arrive on the main thread.

import AVFoundation
import MediaPlayer
import Network
import UIKit
import WebKit

@objc(NativeAudioController) public final class NativeAudioController: NSObject, WKScriptMessageHandler, URLSessionDownloadDelegate {
  private static var controllers: [ObjectIdentifier: NativeAudioController] = [:]
  private static let messageName = "lvNativeAudio"
  private static let skip: NSNumber = 15

  private weak var webView: WKWebView?
  // Live network-path type so the WiFi-only download gate (web: useAudioPreloadDriver
  // reads `net` from the audio stats) honours "prefetch on WiFi only" for the large
  // audio download. Moved here from the retired LvSyncController — audio IS the
  // WiFi-gated download, so net belongs with it.
  private let netMonitor = NWPathMonitor()
  private var netPath: NWPath?
  private let player = AVPlayer()
  private var nowPlayingInfo: [String: Any] = [:]
  private var artworkURL: String?
  private var rate: Double = 1
  private var duration: Double = 0
  private var sessionActive = false
  private var commandsWired = false

  // Background throttle. When the app is backgrounded the web UI is hidden and
  // the lock-screen scrubber is driven by MPNowPlayingInfoCenter (iOS
  // extrapolates between pushes), so the 4 Hz `time` emit to the web is wasted
  // work that keeps the WebContent process busy in the user's pocket — the
  // native-playback heat regression. Drop the web emit to ~1 Hz there. (The web
  // ALSO skips its re-render when document.hidden; this cuts the bridge IPC at
  // the source so even that cheap path runs 4× less.)
  private var backgrounded = false
  private var lastBgEmitSec = -1

  // Deferred resume seek (applied once the item is readyToPlay, not before — a
  // pre-ready seek to a far offset can stall) + self-heal state (origin URL +
  // cache key of the current track, so a failed CACHED file can be dropped and
  // re-streamed from the origin).
  private var pendingSeek: Double = 0
  private var currentOriginURL: URL?
  private var currentCacheKey: String?
  private var playingFromCache = false

  // Offline audio store (content-addressed when the web supplies the hash), in
  // Application Support (NOT Caches — iOS purges Caches under pressure). DURABLE
  // data, two tiers + a budget:
  //   • PINNED  — books the user explicitly downloaded (🎧). Protected: never
  //     auto-evicted; only a manual remove deletes them. Persisted in _pins.json.
  //   • preload/played — fetched to fill the storage budget or as a side-effect of
  //     playing. Evictable (LRU by access mtime) once the store exceeds `capBytes`.
  // Text is a separate, tiny store (LvSyncController) and is NEVER evicted — its
  // "weight" is effectively infinite vs audio.
  private var inFlight: Set<String> = []
  private lazy var cacheDir: URL = {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    let dir = base.appendingPathComponent("lv-audio", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }()
  // Manual-download protection set (sanitized hashes), persisted across launches.
  private lazy var pinsFile: URL = cacheDir.appendingPathComponent("_pins.json")
  private lazy var pinned: Set<String> = {
    guard let d = try? Data(contentsOf: pinsFile),
          let a = try? JSONDecoder().decode([String].self, from: d) else { return [] }
    return Set(a)
  }()
  private func savePins() { try? JSONEncoder().encode(Array(pinned)).write(to: pinsFile) }

  // SQLite resource INDEX (LvStore.swift): one row per cached blob (key+bytes+
  // pinned+mtime). Lets audioStats/usedBytes be an O(1) aggregate instead of a
  // contentsOfDirectory scan + per-file stat on every 2s poll + panel open — the
  // fix for the slow Downloads panel. Maintained on every publish/evict/unpin/pin.
  private lazy var store: LvStore? = {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    guard let s = LvStore(path: base.appendingPathComponent("lv-index-audio.sqlite").path)
    else { return nil }
    // One-time import: index any blobs already on disk (upgrade from the pre-index
    // build) so stats are correct without re-downloading.
    if s.isEmpty() { importExisting(into: s) }
    return s
  }()

  /// Populate the index from the files currently in cacheDir (one-time migration).
  private func importExisting(into s: LvStore) {
    let fm = FileManager.default
    guard let files = try? fm.contentsOfDirectory(
      at: cacheDir, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey]
    ) else { return }
    for f in files
    where f.pathExtension != "part" && !f.lastPathComponent.hasPrefix("_") {
      // The logical key is the bare content hash; on-disk files carry .caf (see
      // fileURL). Strip it so the index keys match what playback/pins/stats use.
      let key = f.pathExtension == "caf"
        ? String(f.deletingPathExtension().lastPathComponent)
        : f.lastPathComponent
      let v = try? f.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
      let bytes = Int64(v?.fileSize ?? 0)
      let mtime = Int64((v?.contentModificationDate ?? Date(timeIntervalSince1970: 0))
        .timeIntervalSince1970)
      s.upsert(key: key, kind: "audio", bytes: bytes, pinned: pinned.contains(key), mtime: mtime)
    }
  }

  /// Index a freshly-published blob. `now` mtime so LRU treats new files as recent.
  private func indexPut(_ key: String, _ bytes: Int64) {
    store?.upsert(key: key, kind: "audio", bytes: bytes,
                  pinned: pinned.contains(key), mtime: Int64(Date().timeIntervalSince1970))
  }
  // Storage budget for the audio store (bytes). The web owns the setting and pushes
  // it via `setCap`; default 20 GB until told otherwise. Eviction (LRU, pinned-
  // exempt) keeps the store at/under this.
  private var capBytes: Int64 = 20_000_000_000

  // ── Foreground bulk-download scheduler ───────────────────────────────────────
  // The library fill (pin/preload) runs on a POOL of FOREGROUND `.default`
  // URLSessions. WHY not `.background(withIdentifier:)` (an earlier attempt at
  // "download in the background while suspended"): on THIS device the background
  // nsurlsessiond pool made ZERO progress — not even in the foreground — while a
  // `.default` session provably works (audio streaming/prefetch uses one, and the
  // previous `.default` pool is what filled the first ~4327 chapters). The
  // out-of-process daemon path never delivered a single completion here, so the
  // fill stalled AND the on-screen fill regressed. Reverted to `.default`: it
  // reliably advances whenever the app is open. The tradeoff — `.default`
  // transfers suspend when the app leaves the foreground — is the accepted ceiling
  // until true background continuation is solved separately (it needs a working
  // background session + an app-suspend hand-off, hard in this wry app shell).
  //
  // A POOL of N sessions (not one): one URLSession multiplexes ALL its tasks onto a
  // SINGLE HTTP/2 connection to a host; the origin is a TLS domain reached through a
  // relay (NOT the LAN), so over that high-RTT path one connection's congestion +
  // h2 flow-control window caps aggregate throughput to ~one stream's worth NO
  // MATTER how many streams are in flight. N independent sessions = N connections =
  // N parallel windows, restoring the ~tens-of-MB/s fill.
  // `httpMaximumConnectionsPerHost` per session bounds the real concurrency.
  private struct DLItem { let url: URL; let key: String }
  private var dlQueue: [DLItem] = []
  private var dlInflight = 0
  private var dlTimer: Timer?
  private var dlRetries: [String: Int] = [:]
  private static let dlSessionCount = 6

  // "Prefetch on WiFi only": enforced NATIVELY on the pool via
  // `allowsCellularAccess`, a belt-and-braces backstop to the web's own WiFi gate
  // (which only stops ENQUEUING). Persisted in UserDefaults so the pool has the
  // right cellular policy from the first task at launch, before the web re-pushes
  // it. Default true (never surprise-burn cellular).
  private static let wifiOnlyKey = "lv.audio.wifiOnly"
  private lazy var wifiOnly: Bool =
    (UserDefaults.standard.object(forKey: Self.wifiOnlyKey) as? Bool) ?? true

  private var dlSessions: [URLSession] = []
  private var dlRR = 0

  // Download diagnostics surfaced to the Downloads panel via `audioStats`, so a
  // stalled fill is debuggable on-device (we can't stream this app's os_log off a
  // wirelessly-paired phone). `dlDone` = completions since launch; `dlLastErr` =
  // the most recent non-cancel transfer error.
  private var dlDone = 0
  private var dlLastErr: String?

  /// Build the foreground `.default` pool. Called once eagerly at init and again
  /// after a WiFi-only toggle. Assumes `dlSessions` is empty. Delegate-based
  /// downloads (no completion handler) so publish/accounting run in the
  /// URLSessionDownloadDelegate methods below.
  private func setupDownloadSessions() {
    guard dlSessions.isEmpty else { return }
    dlSessions = (0..<Self.dlSessionCount).map { _ in
      let cfg = URLSessionConfiguration.default
      cfg.httpMaximumConnectionsPerHost = 6
      cfg.allowsCellularAccess = !wifiOnly
      // Ride out a brief connectivity blip instead of failing the task outright.
      cfg.waitsForConnectivity = true
      cfg.timeoutIntervalForRequest = 90
      cfg.timeoutIntervalForResource = 24 * 60 * 60
      cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
      cfg.urlCache = nil
      return URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }
  }

  /// Next session from the pool, round-robin — spreads the fill across all N
  /// connections instead of piling every task onto one.
  private func nextDLSession() -> URLSession {
    let s = dlSessions[dlRR % dlSessions.count]
    dlRR &+= 1
    return s
  }

  /// Apply the WiFi-only preference pushed from the web. Rebuilds the pool so the
  /// new `allowsCellularAccess` takes effect (config is immutable). `.default`
  /// sessions carry no shared identifier, so the new pool can be built immediately;
  /// the old sessions' cancelled tasks fire didCompleteWithError(.cancelled), which
  /// we skip-retry, and the web pump re-feeds the (still-uncached) items next round.
  private func applyWifiOnly(_ on: Bool) {
    if dlSessions.isEmpty { // first push at launch — just build with the right policy
      if on != wifiOnly { wifiOnly = on; UserDefaults.standard.set(on, forKey: Self.wifiOnlyKey) }
      setupDownloadSessions()
      return
    }
    if on == wifiOnly { return }
    wifiOnly = on
    UserDefaults.standard.set(on, forKey: Self.wifiOnlyKey)
    let old = dlSessions
    dlSessions = []
    dlInflight = 0
    inFlight.removeAll()
    for s in old { s.invalidateAndCancel() }
    setupDownloadSessions()
    startScheduler()
  }

  // Foreground single-file session for the play-path prefetch (the chapter being
  // streamed right now) + explicit save-offline. Kept a `.default` completion-
  // handler session on purpose: it's a want-it-NOW fetch while the app is active,
  // not part of the background library fill, so it needs no out-of-process
  // continuation. `waitsForConnectivity` rides out a brief drop.
  private lazy var fgSession: URLSession = {
    let cfg = URLSessionConfiguration.default
    cfg.httpMaximumConnectionsPerHost = 6
    cfg.timeoutIntervalForRequest = 90
    cfg.waitsForConnectivity = true
    cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
    cfg.urlCache = nil
    return URLSession(configuration: cfg)
  }()

  private var timeObserver: Any?
  private var statusObs: NSKeyValueObservation?
  private var stallObs: NSKeyValueObservation?
  private var keepUpObs: NSKeyValueObservation?
  private var endObserver: NSObjectProtocol?

  // MARK: Install

  @objc public static func installOnWebView(_ webView: WKWebView) {
    let key = ObjectIdentifier(webView)
    if controllers[key] != nil { return }
    let c = NativeAudioController(webView: webView)
    controllers[key] = c
    webView.configuration.userContentController.add(c, name: messageName)
    c.wireRemoteCommands()
    c.observeAudioSession()
    c.startTimeObserver()
    c.purgeForeignAudio()
    c.reconcileIndex()
  }

  /// Prune index rows whose backing file is gone, so `cachedCount`/`usedBytes` and
  /// the download driver's dedup reflect what's ACTUALLY on disk. Repairs the
  /// damage the old `purgeForeignAudio` key bug left behind (thousands of phantom
  /// rows: indexed as cached but deleted from disk). Without this, those chapters
  /// stay "cached" in the index forever → the driver never re-downloads them, the
  /// count is inflated, and they fail to play offline. Idempotent + cheap (one
  /// existence check per row); self-heals on every launch. `resolveFile` also
  /// migrates a legacy extension-less blob in place, which is harmless here.
  private func reconcileIndex() {
    guard let s = store else { return }
    let fm = FileManager.default
    let known = Set(s.allKeys())
    // Half 1 — prune PHANTOM rows (indexed but the file is gone): the old
    // purgeForeignAudio key bug left thousands behind, inflating the count and
    // making the driver dedup deleted chapters as "cached" forever.
    let gone = known.filter { resolveFile($0) == nil }
    for key in gone {
      s.remove(key: key)
      pinned.remove(key)
    }
    // Half 2 — ADOPT orphan files (on disk but NOT indexed). A completion whose
    // async `indexPut` never ran — the app suspended/killed between `publish`
    // (off-main, writes the file) and the main-queue hop that indexes it — leaves
    // a `.caf` with no row. This is the SECOND wedge: the download DRIVER dedups
    // against the INDEX (`store.allKeys`) while native `preload` dedups against
    // DISK (`onDisk`), so an orphan is invisible to the driver (re-sent every
    // tick) yet skipped by native (already on disk). The driver's front-anchored
    // slice keeps re-feeding the same on-disk orphans and never advances to the
    // truly-missing chapters — inflight/queued/done all 0 with disk > index, the
    // fill frozen with no error. Adopting orphans makes index == disk so the
    // driver's "uncached" set is truthful again and the fill resumes. Idempotent.
    var adopted = 0
    if let files = try? fm.contentsOfDirectory(
      at: cacheDir, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey]) {
      for f in files where f.pathExtension == "caf" {
        let key = String(f.deletingPathExtension().lastPathComponent)
        if known.contains(key) || key.hasPrefix("_") { continue }
        let vals = try? f.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
        let bytes = Int64(vals?.fileSize ?? 0)
        let mtime = Int64(vals?.contentModificationDate?.timeIntervalSince1970
          ?? Date().timeIntervalSince1970)
        s.upsert(key: key, kind: "audio", bytes: bytes, pinned: pinned.contains(key), mtime: mtime)
        adopted += 1
      }
    }
    if !gone.isEmpty { savePins() }
    // Visible via the dl_stats telemetry: cachedCount converges to the true
    // on-disk count on the next poll, then the driver re-enqueues the real gaps.
    if !gone.isEmpty || adopted > 0 {
      NSLog("[lv-audio] reconcileIndex pruned %d phantom rows, adopted %d orphan files",
            gone.count, adopted)
    }
  }

  /// One-time cleanup: delete any audio file that is NOT the current compressed
  /// variant (Opus-in-CAF). Legacy uncompressed MP3s (and any old variant) sit
  /// under the same content-hash keys as the new CAF, so `downloadToCache` skips
  /// them and the store stays bloated (used ≫ what's actually current). Keep only
  /// files whose magic bytes are "caff"; delete the rest — the next preload
  /// re-fetches them compressed. Marker-gated so it runs once; BUMP the marker
  /// name whenever the variant/cleanup changes so it re-runs exactly once more.
  private func purgeForeignAudio() {
    let marker = cacheDir.appendingPathComponent("_purge_caf_v2")
    if FileManager.default.fileExists(atPath: marker.path) { return }
    let fm = FileManager.default
    if let files = try? fm.contentsOfDirectory(at: cacheDir, includingPropertiesForKeys: nil) {
      for f in files
      where f.pathExtension != "part" && !f.lastPathComponent.hasPrefix("_") {
        guard let h = try? FileHandle(forReadingFrom: f) else { continue }
        let head = try? h.read(upToCount: 4)
        try? h.close()
        let isCaf = head?.starts(with: [0x63, 0x61, 0x66, 0x66]) ?? false // "caff"
        if !isCaf {
          // The index/pins key is the BARE hash; the file may carry a `.caf`
          // extension. Strip it before remove — passing the filename-with-`.caf`
          // (the original bug) matched no index row, so deleting foreign audio left
          // a PHANTOM index row behind (indexed as cached, file gone), which
          // inflated the count AND made the download driver dedup the deleted
          // chapter as "already cached" so it never re-downloaded.
          let key = f.pathExtension == "caf"
            ? String(f.deletingPathExtension().lastPathComponent)
            : f.lastPathComponent
          try? fm.removeItem(at: f)
          pinned.remove(key)
          store?.remove(key: key)
        }
      }
    }
    savePins()
    fm.createFile(atPath: marker.path, contents: Data())
  }

  private init(webView: WKWebView) {
    self.webView = webView
    super.init()
    // Keep auto-wait ON (the default): when streaming, AVPlayer buffers enough
    // before it starts. With it OFF + a resume seek to a far (unbuffered) offset
    // and playImmediately, playback stalls forever at 0:00 — the "this chapter
    // won't play" bug on a chapter resumed near its end.
    player.automaticallyWaitsToMinimizeStalling = true
    netMonitor.pathUpdateHandler = { [weak self] p in self?.netPath = p }
    netMonitor.start(queue: DispatchQueue(label: "lv.net"))
    // Force the cache dir's lazy init on THIS (main) thread before any download
    // session exists: a transfer's didFinishDownloadingTo → publish runs on the
    // session's delegate queue (off main) and touches `cacheDir`; a non-thread-safe
    // lazy racing that first access could crash. Pre-touching here closes the window.
    _ = cacheDir
    // Build the download pool eagerly so it's ready before the first preload arrives.
    setupDownloadSessions()
  }

  /// "wifi" (incl. wired / unknown-but-online, e.g. the simulator) | "cell" | "none".
  private func netType() -> String {
    guard let p = netPath, p.status == .satisfied else { return "none" }
    if p.usesInterfaceType(.cellular) && !p.usesInterfaceType(.wifi) { return "cell" }
    return "wifi"
  }

  // MARK: web → native

  public func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    guard let body = m.body as? [String: Any], let kind = body["kind"] as? String else { return }
    let d = body["data"] as? [String: Any]
    switch kind {
    case "load": load(d)
    case "play": play()
    case "pause": pause()
    case "seek": if let p = d?["position"] as? Double { seek(p) }
    case "rate": if let r = d?["rate"] as? Double { setRate(r) }
    case "stop": stop()
    case "state": emitState()
    case "prefetch":
      if let s = d?["url"] as? String, let u = URL(string: s) {
        downloadToCache(u, cacheKey(forURL: u, hash: d?["hash"] as? String))
      }
    case "pin": pin(d)
    case "preload": preload(d)
    case "unpin": unpin(d)
    case "setCap": setCap(d)
    case "setWifiOnly": if let on = d?["on"] as? Bool { applyWifiOnly(on) }
    case "audioStats": audioStats(d)
    default: break
    }
  }

  // MARK: offline downloads (per-book)

  /// MANUAL download (🎧): mark PROTECTED + enqueue at the FRONT (the user wants
  /// this book now, ahead of the background fill). Idempotent.
  private func pin(_ d: [String: Any]?) {
    guard let items = d?["items"] as? [[String: Any]] else { return }
    var front: [DLItem] = []
    for it in items {
      guard let s = it["url"] as? String, let u = URL(string: s) else { continue }
      let key = cacheKey(forURL: u, hash: it["hash"] as? String)
      pinned.insert(key)
      if onDisk(key) {
        store?.setPinned(key: key, pinned: true) // already cached → just flag it
      } else {
        front.append(DLItem(url: u, key: key))
      }
    }
    savePins()
    // Prepend (skip dups already queued/in-flight).
    let queued = Set(dlQueue.map(\.key))
    dlQueue.insert(contentsOf: front.filter { !queued.contains($0.key) && !inFlight.contains($0.key) }, at: 0)
    startScheduler()
  }

  /// AUTO preload (fill the budget): enqueue EVICTABLE (not pinned) at the BACK.
  private func preload(_ d: [String: Any]?) {
    guard let items = d?["items"] as? [[String: Any]] else { return }
    let queued = Set(dlQueue.map(\.key))
    var seen = queued
    for it in items {
      guard let s = it["url"] as? String, let u = URL(string: s) else { continue }
      let key = cacheKey(forURL: u, hash: it["hash"] as? String)
      if onDisk(key) || inFlight.contains(key) || seen.contains(key) { continue }
      seen.insert(key)
      dlQueue.append(DLItem(url: u, key: key))
    }
    startScheduler()
  }

  // MARK: adaptive download scheduler

  /// Start the budget/drain timer (idempotent) + pump.
  private func startScheduler() {
    if dlTimer == nil {
      // Enforce the budget + sweep for drained state every 2s while there's work.
      dlTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
        self?.schedulerTick()
      }
    }
    pump()
  }

  /// Hand every queued item to the background pool. The system daemon paces the
  /// real concurrency (httpMaximumConnectionsPerHost per session); the rest of the
  /// batch waits in the daemon and drains while the app is suspended. Dedup guards
  /// against re-resuming an in-flight / on-disk key.
  private func pump() {
    guard !dlSessions.isEmpty else { return } // pool rebuilding — next tick pumps
    while !dlQueue.isEmpty {
      let item = dlQueue.removeFirst()
      if onDisk(item.key) || inFlight.contains(item.key) { continue }
      runScheduled(item)
    }
  }

  /// Enqueue one bulk download on the background pool. Delegate-based on purpose: a
  /// background session has NO completion handler (that API is a runtime error on a
  /// background config) — publish + accounting happen in the URLSessionDownloadDelegate
  /// methods below. The cache key rides on `taskDescription` so the delegate (which
  /// may fire in a fresh process after relaunch) can recover it.
  private func runScheduled(_ item: DLItem) {
    inFlight.insert(item.key)
    dlInflight += 1
    let task = nextDLSession().downloadTask(with: item.url)
    task.taskDescription = item.key
    task.resume()
  }

  /// 2s tick: stop when the queue has fully drained, else keep the budget and pump.
  /// (Budget check lives here, not per-completion, so the used-bytes read runs
  /// ~every 2s.) The pool's `httpMaximumConnectionsPerHost` paces real concurrency;
  /// pump() hands it the whole queue.
  private func schedulerTick() {
    if dlQueue.isEmpty && dlInflight == 0 {
      dlTimer?.invalidate()
      dlTimer = nil
      return
    }
    if usedBytes() >= capBytes { // budget full → stop filling + evict to fit
      dlQueue.removeAll()
      enforceCap()
    }
    pump()
  }

  // MARK: URLSessionDownloadDelegate (foreground bulk pool)

  /// A finished transfer's temp file is valid ONLY inside this call — publish it
  /// synchronously here (on the session's delegate queue, off main). A "download"
  /// still completes for a 404/500 (the body is the error page), so status-gate:
  /// only a 200 publishes; a non-200 falls through to didCompleteWithError for a
  /// bounded retry. Each task writes a DISTINCT key, so concurrent publishes across
  /// the pool don't race.
  public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                         didFinishDownloadingTo location: URL) {
    guard let key = downloadTask.taskDescription else { return }
    let code = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
    guard code == 200, let n = publish(location, key) else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.dlRetries[key] = nil
      self.dlDone += 1 // diagnostic: completions since launch
      self.indexPut(key, n) // maintain the SQLite stats index
    }
  }

  /// Terminal callback for every bulk task. Decrement in-flight, requeue a bounded
  /// number of times on failure (the file didn't land on disk), and pump. Runs on
  /// the session's delegate queue; hop to main for the shared scheduler state.
  public func urlSession(_ session: URLSession, task: URLSessionTask,
                         didCompleteWithError error: Error?) {
    guard let key = task.taskDescription else { return }
    let url = task.originalRequest?.url
    let urlErr = error as? URLError
    let cancelled = urlErr?.code == .cancelled
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.dlInflight = max(0, self.dlInflight - 1)
      self.inFlight.remove(key)
      // A cancel is a deliberate pool teardown (WiFi-only rebuild); the web pump
      // re-feeds the item, so don't burn its retry budget. Otherwise success ==
      // the file is on disk (didFinishDownloadingTo published it before this fires).
      if !cancelled, !self.onDisk(key), let url {
        if let e = error { self.dlLastErr = (e as NSError).localizedDescription } // diagnostic
        let r = (self.dlRetries[key] ?? 0) + 1
        if r <= 3 { self.dlRetries[key] = r; self.dlQueue.append(DLItem(url: url, key: key)) }
      }
      self.pump()
    }
  }

  /// Move a freshly-downloaded temp file into the cache under `key`; returns bytes.
  private func publish(_ tmp: URL, _ key: String) -> Int64? {
    let dest = fileURL(key) // <key>.caf — see fileURL()
    let part = dest.appendingPathExtension("part")
    let fm = FileManager.default
    try? fm.removeItem(at: part)
    try? fm.removeItem(at: dest)
    do {
      try fm.moveItem(at: tmp, to: part)
      try fm.moveItem(at: part, to: dest)
    } catch {
      try? fm.removeItem(at: part)
      return nil
    }
    return Int64((try? dest.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0)
  }

  /// Remove (delete) the given keys' audio files + unpin them. `keys` are sanitized
  /// content hashes the web computed from the manifest.
  private func unpin(_ d: [String: Any]?) {
    guard let keys = d?["keys"] as? [String] else { return }
    let fm = FileManager.default
    for k in keys {
      let key = cacheKey(forURL: URL(string: "x:")!, hash: k) // sanitize same way
      pinned.remove(key)
      try? fm.removeItem(at: fileURL(key)) // <key>.caf
      try? fm.removeItem(at: cacheDir.appendingPathComponent(key)) // legacy (pre-.caf)
      store?.remove(key: key)
    }
    savePins()
  }

  /// Set the storage budget (bytes) + immediately enforce it (a lowered cap evicts
  /// down to fit). The web confirms destructive lowering with the user first.
  private func setCap(_ d: [String: Any]?) {
    if let c = d?["bytes"] as? Double, c > 0 { capBytes = Int64(c) }
    enforceCap()
  }

  /// Total bytes of cached audio — O(1) from the SQLite index (the budget check
  /// on every 2s scheduler tick used to scan the whole directory here).
  private func usedBytes() -> Int64 {
    store?.stats().bytes ?? 0
  }

  /// LRU eviction (adaptive by access recency — `cachedFileURL` touches mtime on
  /// every play): while OVER the cap, delete the least-recently-used EVICTABLE
  /// (non-pinned) file. Pinned (manual) + the `_pins.json` sidecar are never
  /// touched; if pinned alone exceeds the cap we stop (the user's deliberate choice
  /// wins over the budget). Text is a separate store and is never evicted here.
  private func enforceCap() {
    let total = usedBytes() // O(1) from the index
    guard total > capBytes else { return }
    // LRU candidates (non-pinned, oldest mtime first) straight from the SQLite
    // index — no directory scan. Delete the file + its row for each.
    let fm = FileManager.default
    for key in store?.lruEvictionCandidates(toFree: total - capBytes) ?? [] {
      try? fm.removeItem(at: fileURL(key)) // <key>.caf
      try? fm.removeItem(at: cacheDir.appendingPathComponent(key)) // legacy (pre-.caf)
      store?.remove(key: key)
    }
  }

  /// Report the audio store state for the Downloads UI: total used, the cap,
  /// pinned (protected) bytes, and the cached + pinned key sets (the web maps
  /// keys→books via the manifest). Replied via `window.__lvAudioResolve(id, json)`.
  private func audioStats(_ d: [String: Any]?) {
    guard let id = d?["id"] as? String else { return }
    // O(1) from the SQLite index — no contentsOfDirectory + per-file stat (the old
    // per-poll cost). `cachedCount` lets the web show done/total WITHOUT the full
    // `cached` array; the array is kept (indexed read) for the current consumers
    // until they switch to the count.
    let (count, used, pinnedBytes) = store?.stats() ?? (0, 0, 0)
    let cached: [String] = store?.allKeys() ?? []
    // Diagnostics (temporary): the TRUE on-disk `.caf` count vs the SQLite index
    // `count` above. If diskCount > cachedCount the index has drifted below disk —
    // the driver would keep re-sending "uncached" items that native then skips as
    // already-on-disk, freezing the fill at the index count with no error. Plus the
    // device's real free space: the fill can't grow past the volume's free bytes no
    // matter how large the app budget is. contentsOfDirectory is O(files) but only
    // runs on an explicit stats poll (~every 2-3s), acceptable for diagnosis.
    let diskCount = (try? FileManager.default.contentsOfDirectory(
      at: cacheDir, includingPropertiesForKeys: nil))?
      .filter { $0.pathExtension == "caf" }.count ?? -1
    var freeBytes: Int64 = -1
    if let vals = try? URL(fileURLWithPath: NSHomeDirectory())
      .resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
      let f = vals.volumeAvailableCapacityForImportantUsage {
      freeBytes = Int64(f)
    }
    var obj: [String: Any] = [
      "usedBytes": used, "cap": capBytes, "pinnedBytes": pinnedBytes,
      "cachedCount": count, "cached": cached, "pinned": Array(pinned),
      "net": netType(),
      // Download diagnostics for the Downloads panel (see dlDone/dlLastErr).
      "dlInflight": dlInflight, "dlQueued": dlQueue.count, "dlDone": dlDone,
      "dlDisk": diskCount, "freeBytes": freeBytes,
    ]
    if let e = dlLastErr { obj["dlErr"] = e }
    let json = (try? JSONSerialization.data(withJSONObject: obj))
      .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    let esc = json.replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "'", with: "\\'")
    let safeId = id.replacingOccurrences(of: "'", with: "")
    let js = "window.__lvAudioResolve&&window.__lvAudioResolve('\(safeId)','\(esc)')"
    DispatchQueue.main.async { [weak self] in
      self?.webView?.evaluateJavaScript(js, completionHandler: nil)
    }
  }

  private func load(_ d: [String: Any]?) {
    guard let d, let urlStr = d["url"] as? String, let url = URL(string: urlStr) else { return }
    let position = d["position"] as? Double ?? 0
    rate = d["rate"] as? Double ?? 1
    duration = 0
    let key = cacheKey(forURL: url, hash: d["hash"] as? String)
    currentOriginURL = url
    currentCacheKey = key
    pendingSeek = position

    teardownItem()
    // OFFLINE CACHE: if this chapter's audio is already fully cached on disk
    // (keyed by its content hash when the web supplies one, else the URL), play
    // the LOCAL file — fully offline + instant. Otherwise stream the origin AND
    // download it in the background so the NEXT play (and offline) is local.
    let item: AVPlayerItem
    if let cached = cachedFileURL(key) {
      item = AVPlayerItem(url: cached)
      playingFromCache = true
    } else if netType() == "none" {
      // OFFLINE + not downloaded: streaming would just stall forever (the web shows
      // a spinner that never resolves). Fail FAST + proactively so the UI can show a
      // disabled / "not downloaded" state instead of an endless loading icon.
      emit("{type:'error',message:'offline-uncached'}")
      return
    } else {
      item = AVPlayerItem(url: url)
      playingFromCache = false
      downloadToCache(url, key)
    }
    observeItem(item)
    player.replaceCurrentItem(with: item)
    // The resume seek is DEFERRED to readyToPlay (observeItem) — seeking to a far
    // offset before the item is ready stalls.

    nowPlayingInfo = [:]
    nowPlayingInfo[MPMediaItemPropertyTitle] = d["title"] as? String ?? ""
    nowPlayingInfo[MPMediaItemPropertyArtist] = d["artist"] as? String ?? ""
    nowPlayingInfo[MPMediaItemPropertyAlbumTitle] = d["album"] as? String ?? ""
    artworkURL = nil
    pushNowPlaying(playing: false, position: position)
    loadArtwork(d["artworkUrl"] as? String)
  }

  private func play() {
    activateSession()
    // Setting rate (not playImmediately) so automaticallyWaitsToMinimizeStalling
    // applies — AVPlayer buffers enough before starting instead of stalling on a
    // not-yet-ready stream. rate also carries the chosen speed (2x etc.).
    player.rate = Float(rate)
    pushNowPlaying(playing: true, position: currentPosition())
    emit("{type:'playing'}")
  }

  private func pause() {
    player.pause()
    pushNowPlaying(playing: false, position: currentPosition())
    emit("{type:'paused'}")
  }

  /// Re-emit the CURRENT state on demand. The web loses its in-memory playing/
  /// position when it reloads, but the native player keeps playing — so the web
  /// requests this on mount to re-sync (else it shows a paused button while audio
  /// is actually playing). `time` only fires on a tick/seek, so it can't be relied
  /// on to re-assert play state after a reload.
  private func emitState() {
    let d = duration
    if d > 0 { emit("{type:'durationchange',duration:\(d)}") }
    emit("{type:'time',position:\(currentPosition()),duration:\(d)}")
    emit(isPlaying() ? "{type:'playing'}" : "{type:'paused'}")
  }

  private func seek(_ p: Double) {
    let t = CMTime(seconds: max(0, p), preferredTimescale: 1000)
    player.seek(to: t, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
      guard let self else { return }
      self.pushNowPlaying(playing: self.isPlaying(), position: p)
      self.emit("{type:'time',position:\(p),duration:\(self.duration)}")
    }
  }

  private func setRate(_ r: Double) {
    rate = r
    if isPlaying() { player.rate = Float(r) } // changing rate while paused would start it
    pushNowPlaying(playing: isPlaying(), position: currentPosition())
  }

  private func stop() {
    player.pause()
    teardownItem()
    player.replaceCurrentItem(with: nil)
    nowPlayingInfo = [:]
    artworkURL = nil
    let center = MPNowPlayingInfoCenter.default()
    center.nowPlayingInfo = nil
    center.playbackState = .stopped
    deactivateSession()
  }

  // MARK: AVPlayer observation

  private func startTimeObserver() {
    // ~4 Hz: frequent enough to drive the read-along wipe smoothly, cheap enough
    // to be invisible. iOS extrapolates the lock-screen scrubber between pushes.
    let interval = CMTime(seconds: 0.25, preferredTimescale: 1000)
    timeObserver = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) {
      [weak self] time in
      guard let self else { return }
      let pos = time.seconds
      guard pos.isFinite else { return }
      // Backgrounded → emit at most ~1 Hz to the web (see `backgrounded`).
      if self.backgrounded {
        let sec = Int(pos)
        if sec == self.lastBgEmitSec { return }
        self.lastBgEmitSec = sec
      }
      self.emit("{type:'time',position:\(pos),duration:\(self.duration)}")
    }
  }

  private func observeItem(_ item: AVPlayerItem) {
    statusObs = item.observe(\.status, options: [.new]) { [weak self] it, _ in
      guard let self else { return }
      switch it.status {
      case .readyToPlay:
        // Apply the DEFERRED resume seek now that the item can handle it.
        if self.pendingSeek > 0 {
          let target = self.pendingSeek
          self.pendingSeek = 0
          self.player.seek(to: CMTime(seconds: target, preferredTimescale: 1000))
        }
        let d = it.duration.seconds
        if d.isFinite, d > 0 {
          self.duration = d
          self.nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] = d
          MPNowPlayingInfoCenter.default().nowPlayingInfo = self.nowPlayingInfo
          self.emit("{type:'durationchange',duration:\(d)}")
        }
        self.emit("{type:'canplay'}")
      case .failed:
        // A cached LOCAL file should no longer fail now that it carries a .caf
        // extension (AVURLAsset can infer the container). If it still does, DO NOT
        // delete the download — deleting a perfectly-good offline file was the old
        // "downloads vanish" death-loop (an extension-less CAF read as "corrupt",
        // got wiped, and offline there was nothing left to fall back to). When
        // ONLINE, re-stream from the origin as a fallback but KEEP the file; when
        // OFFLINE, surface the error and keep the file for a later retry.
        if self.playingFromCache, let origin = self.currentOriginURL,
           self.netType() != "none" {
          self.playingFromCache = false
          let wasPlaying = self.isPlaying()
          self.teardownItem() // drop this (now-stale) item's observers
          let fresh = AVPlayerItem(url: origin)
          self.observeItem(fresh)
          self.player.replaceCurrentItem(with: fresh)
          if wasPlaying { self.play() }
        } else {
          self.emit("{type:'error',message:'item failed'}")
        }
      default:
        break
      }
    }
    keepUpObs = item.observe(\.isPlaybackLikelyToKeepUp, options: [.new]) { [weak self] it, _ in
      if it.isPlaybackLikelyToKeepUp { self?.emit("{type:'canplay'}") }
    }
    stallObs = item.observe(\.isPlaybackBufferEmpty, options: [.new]) { [weak self] it, _ in
      if it.isPlaybackBufferEmpty { self?.emit("{type:'waiting'}") }
    }
    endObserver = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
    ) { [weak self] _ in
      guard let self else { return }
      self.pushNowPlaying(playing: false, position: self.duration)
      self.emit("{type:'ended'}")
    }
  }

  private func teardownItem() {
    statusObs?.invalidate(); statusObs = nil
    keepUpObs?.invalidate(); keepUpObs = nil
    stallObs?.invalidate(); stallObs = nil
    if let e = endObserver { NotificationCenter.default.removeObserver(e); endObserver = nil }
  }

  private func currentPosition() -> Double {
    let t = player.currentTime().seconds
    return t.isFinite ? t : 0
  }

  private func isPlaying() -> Bool { player.timeControlStatus == .playing || player.rate > 0 }

  // MARK: Now Playing

  private func pushNowPlaying(playing: Bool, position: Double) {
    nowPlayingInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = position
    nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = playing ? rate : 0.0
    nowPlayingInfo[MPNowPlayingInfoPropertyDefaultPlaybackRate] = rate
    if duration > 0 { nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] = duration }
    let center = MPNowPlayingInfoCenter.default()
    center.nowPlayingInfo = nowPlayingInfo
    center.playbackState = playing ? .playing : .paused
  }

  private func loadArtwork(_ urlString: String?) {
    guard let urlString, urlString != artworkURL, let url = URL(string: urlString) else { return }
    artworkURL = urlString
    URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
      guard let data, let image = UIImage(data: data) else { return }
      let art = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
      DispatchQueue.main.async {
        guard let self, self.artworkURL == urlString else { return }
        self.nowPlayingInfo[MPMediaItemPropertyArtwork] = art
        MPNowPlayingInfoCenter.default().nowPlayingInfo = self.nowPlayingInfo
      }
    }.resume()
  }

  // MARK: AVAudioSession

  private func activateSession() {
    guard !sessionActive else { return }
    do {
      // Category/mode set at launch (.playback/.spokenAudio in the shell tweak);
      // native is the sole source now, so activating here can't race WebKit.
      try AVAudioSession.sharedInstance().setActive(true)
      sessionActive = true
    } catch {
      NSLog("[native-audio] setActive(true) failed: \(error)")
    }
  }

  private func deactivateSession() {
    guard sessionActive else { return }
    sessionActive = false
    do {
      try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    } catch {
      NSLog("[native-audio] setActive(false) failed: \(error)")
    }
  }

  private func observeAudioSession() {
    let nc = NotificationCenter.default
    nc.addObserver(self, selector: #selector(routeChanged(_:)),
                   name: AVAudioSession.routeChangeNotification, object: nil)
    nc.addObserver(self, selector: #selector(interrupted(_:)),
                   name: AVAudioSession.interruptionNotification, object: nil)
    // App lifecycle drives the background emit-throttle (see `backgrounded`).
    nc.addObserver(self, selector: #selector(appDidBackground),
                   name: UIApplication.didEnterBackgroundNotification, object: nil)
    nc.addObserver(self, selector: #selector(appWillForeground),
                   name: UIApplication.willEnterForegroundNotification, object: nil)
  }

  @objc private func appDidBackground() { backgrounded = true }

  @objc private func appWillForeground() {
    backgrounded = false
    lastBgEmitSec = -1
  }

  @objc private func routeChanged(_ note: Notification) {
    guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
          let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }
    if reason == .oldDeviceUnavailable { pause(); emit("{type:'paused'}") }
  }

  @objc private func interrupted(_ note: Notification) {
    guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
    switch type {
    case .began:
      pause(); emit("{type:'paused'}")
    case .ended:
      let opts = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt).map {
        AVAudioSession.InterruptionOptions(rawValue: $0)
      }
      if opts?.contains(.shouldResume) == true { play() }
    @unknown default:
      break
    }
  }

  // MARK: Remote commands (lock screen / AirPods / CarPlay)

  private func wireRemoteCommands() {
    if commandsWired { return }
    commandsWired = true
    let cc = MPRemoteCommandCenter.shared()
    cc.playCommand.addTarget { [weak self] _ in self?.play(); return .success }
    cc.pauseCommand.addTarget { [weak self] _ in self?.pause(); return .success }
    cc.togglePlayPauseCommand.addTarget { [weak self] _ in
      guard let self else { return .commandFailed }
      self.isPlaying() ? self.pause() : self.play()
      return .success
    }
    // Next/prev need the book's chapter queue, which lives in the web — defer.
    cc.nextTrackCommand.addTarget { [weak self] _ in self?.emit("{type:'next'}"); return .success }
    cc.previousTrackCommand.addTarget { [weak self] _ in self?.emit("{type:'prev'}"); return .success }
    cc.skipForwardCommand.preferredIntervals = [Self.skip]
    cc.skipForwardCommand.addTarget { [weak self] e in
      let s = (e as? MPSkipIntervalCommandEvent)?.interval ?? 15
      self?.seek((self?.currentPosition() ?? 0) + s); return .success
    }
    cc.skipBackwardCommand.preferredIntervals = [Self.skip]
    cc.skipBackwardCommand.addTarget { [weak self] e in
      let s = (e as? MPSkipIntervalCommandEvent)?.interval ?? 15
      self?.seek(max(0, (self?.currentPosition() ?? 0) - s)); return .success
    }
    cc.changePlaybackPositionCommand.addTarget { [weak self] e in
      guard let pe = e as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
      self?.seek(pe.positionTime); return .success
    }
    for cmd in [cc.playCommand, cc.pauseCommand, cc.togglePlayPauseCommand,
                cc.nextTrackCommand, cc.previousTrackCommand,
                cc.skipForwardCommand, cc.skipBackwardCommand,
                cc.changePlaybackPositionCommand] {
      cmd.isEnabled = true
    }
  }

  // MARK: Offline cache (content-addressed, LRU)

  /// The cache filename for a track: the web-supplied content hash (so the same
  /// audio dedups + survives a re-render → new hash → new file) when present, else
  /// a stable digest of the origin URL. Sanitized to a safe filename.
  private func cacheKey(forURL url: URL, hash: String?) -> String {
    if let hash, !hash.isEmpty {
      return hash.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
    }
    // No hash → key by the URL via a DETERMINISTIC digest. NOT Swift's
    // `hashValue`, which is randomized per process launch and so would miss the
    // cache on the next app start.
    return "u" + stableDigest(url.absoluteString)
  }

  /// FNV-1a 64-bit — a stable, fast digest for a cache filename.
  private func stableDigest(_ s: String) -> String {
    var h: UInt64 = 14695981039346656037
    for b in s.utf8 { h = (h ^ UInt64(b)) &* 1099511628211 }
    return String(h, radix: 16)
  }

  /// Pure existence check (no mtime touch — used by the scheduler for dedup, which
  /// must NOT mark a not-yet-played file as recently used).
  /// On-disk path for a cache key. Files carry a `.caf` EXTENSION on purpose:
  /// AVURLAsset infers a LOCAL file's container type from its path extension, and
  /// our content-hash keys have none — without it Opus-in-CAF fails to load with
  /// "item failed" on OFFLINE playback (streaming works only because the HTTP
  /// Content-Type supplies the type). The logical KEY stays the bare hash
  /// everywhere (index / pins / stats); only the filename gets the extension.
  private func fileURL(_ key: String) -> URL {
    cacheDir.appendingPathComponent(key + ".caf")
  }

  /// Resolve a key to its on-disk file, lazily migrating a legacy extension-less
  /// blob (`<hash>` → `<hash>.caf`) IN PLACE — instant, same bytes, no re-download.
  /// nil if neither exists.
  private func resolveFile(_ key: String) -> URL? {
    let caf = fileURL(key)
    let fm = FileManager.default
    if fm.fileExists(atPath: caf.path) { return caf }
    let legacy = cacheDir.appendingPathComponent(key)
    if fm.fileExists(atPath: legacy.path) {
      try? fm.moveItem(at: legacy, to: caf)
      return fm.fileExists(atPath: caf.path) ? caf : legacy
    }
    return nil
  }

  private func onDisk(_ key: String) -> Bool {
    resolveFile(key) != nil
  }

  /// The local file for a fully-cached key, or nil. Touches it so the LRU keeps
  /// recently-played audio.
  private func cachedFileURL(_ key: String) -> URL? {
    guard let f = resolveFile(key) else { return nil }
    let now = Date()
    try? FileManager.default.setAttributes([.modificationDate: now], ofItemAtPath: f.path)
    store?.touch(key: key, mtime: Int64(now.timeIntervalSince1970)) // LRU recency in the index
    return f
  }

  /// Download `url` into the cache as `key`, once. Skips if already cached or in
  /// flight. Used as a side-effect of streaming a not-yet-cached chapter AND by an
  /// explicit prefetch (save-offline). Atomic publish (.part → rename) so a crash
  /// never leaves a truncated file masquerading as complete.
  private func downloadToCache(_ url: URL, _ key: String) {
    let dest = fileURL(key) // <key>.caf — see fileURL()
    if onDisk(key) || inFlight.contains(key) { return }
    inFlight.insert(key)
    let task = fgSession.downloadTask(with: url) { [weak self] tmp, resp, _ in
      guard let self else { return }
      defer { DispatchQueue.main.async { self.inFlight.remove(key) } }
      guard let tmp, let code = (resp as? HTTPURLResponse)?.statusCode, code == 200 else { return }
      let fm = FileManager.default
      let part = dest.appendingPathExtension("part")
      try? fm.removeItem(at: part)
      try? fm.removeItem(at: dest)
      do {
        try fm.moveItem(at: tmp, to: part)
        try fm.moveItem(at: part, to: dest)
      } catch {
        try? fm.removeItem(at: part)
        return
      }
      let bytes = Int64((try? dest.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0)
      DispatchQueue.main.async { self.indexPut(key, bytes) } // maintain the index
      // Keep the store within the budget (LRU, pinned-exempt). A no-op while under
      // cap — which, post-compression, is the common case (full audio ≈ 3.7GB ≪
      // a 20GB default).
      DispatchQueue.main.async { self.enforceCap() }
    }
    // Default priority (NOT low): a low URLSessionTask.priority throttles the
    // transfer's scheduling on iOS and capped the fill at a few hundred KB/s.
    // Yielding to foreground is handled by the gate (stop issuing), not priority.
    task.resume()
  }

  // MARK: native → web

  /// Deliver a state event to the web as a `lv-native-audio` CustomEvent. `detail`
  /// is a JS object literal built from NUMBERS/known types only (never string
  /// interpolation of web-supplied strings).
  private func emit(_ detail: String) {
    let js = "window.dispatchEvent(new CustomEvent('lv-native-audio',{detail:\(detail)}))"
    DispatchQueue.main.async { [weak self] in
      self?.webView?.evaluateJavaScript(js, completionHandler: nil)
    }
  }
}
