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
import UIKit
import WebKit

@objc(NativeAudioController) public final class NativeAudioController: NSObject, WKScriptMessageHandler {
  private static var controllers: [ObjectIdentifier: NativeAudioController] = [:]
  private static let messageName = "lvNativeAudio"
  private static let skip: NSNumber = 15

  private weak var webView: WKWebView?
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
  // Storage budget for the audio store (bytes). The web owns the setting and pushes
  // it via `setCap`; default 20 GB until told otherwise. Eviction (LRU, pinned-
  // exempt) keeps the store at/under this.
  private var capBytes: Int64 = 20_000_000_000

  // ── Adaptive bulk-download scheduler ────────────────────────────────────────
  // Bulk pin/preload no longer fire all tasks at once (under HTTP/2 they'd pile
  // onto one connection with NO cap). A worker pool keeps up to `dlLimit` in
  // flight; `dlLimit` adapts by hill-climbing aggregate throughput (find the
  // bandwidth knee) and backs off hard on overload. Default task priority + full
  // concurrency saturate the link (~45 MB/s); the currently-PLAYING chapter
  // downloads immediately, bypassing this queue.
  private struct DLItem { let url: URL; let key: String }
  private var dlQueue: [DLItem] = []
  private var dlInflight = 0
  // High concurrency on purpose, SPREAD across the session pool (see dlSessions):
  // a high-BDP path (device → tunnel → host) needs many in-flight transfers over
  // SEVERAL connections to fill the pipe — one connection's streams are each
  // flow-control-window-limited and share one congestion window. The old unbounded
  // webview prefetch hit ~45 MB/s precisely because it had many concurrent
  // transfers; we match that with dlLimit tasks fanned over N pool connections.
  private var dlLimit = 48
  private let dlMin = 16
  private let dlMax = 100
  private var dlWindowBytes: Int64 = 0
  private var dlWindowStart: TimeInterval = 0
  private var dlLastTput: Double = 0
  private var dlTimer: Timer?
  private var dlRetries: [String: Int] = [:]

  // POOL of independent download sessions. URLSession multiplexes ALL of a
  // session's tasks onto a SINGLE HTTP/2 connection to a host; the remote origin
  // is a TLS domain reached through a relay (NOT the LAN), so over that high-RTT
  // path one connection's congestion + h2 flow-control window caps aggregate
  // throughput to ~one stream's worth (~200–350 KB/s) NO MATTER how many streams
  // are in flight — which is exactly the slowdown vs the old webview `fetch()`
  // path (a separate network stack with its own connections). N independent
  // sessions = N separate connections = N parallel windows, restoring the old
  // ~tens-of-MB/s fill. Tasks are spread round-robin across the pool.
  private lazy var dlSessions: [URLSession] = (0..<8).map { _ in
    let cfg = URLSessionConfiguration.default
    cfg.httpMaximumConnectionsPerHost = 8
    cfg.timeoutIntervalForRequest = 90
    cfg.waitsForConnectivity = true
    // Don't let the shared URL cache intercept/store these large blobs — we cache
    // them ourselves on disk, content-addressed.
    cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
    cfg.urlCache = nil
    return URLSession(configuration: cfg)
  }
  private var dlRR = 0
  /// Next session from the pool, round-robin — spreads the fill across all N
  /// connections instead of piling every task onto one.
  private func nextDLSession() -> URLSession {
    let s = dlSessions[dlRR % dlSessions.count]
    dlRR &+= 1
    return s
  }

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
          try? fm.removeItem(at: f)
          pinned.remove(f.lastPathComponent)
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
      if !onDisk(key) { front.append(DLItem(url: u, key: key)) }
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

  /// Start the worker pool + the hill-climb timer (idempotent).
  private func startScheduler() {
    if dlTimer == nil {
      dlWindowStart = Date.timeIntervalSinceReferenceDate
      dlWindowBytes = 0
      // Adjust the limit + sweep stuck tasks every 2s while there's work.
      dlTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
        self?.schedulerTick()
      }
    }
    pump()
  }

  /// Keep up to `dlLimit` downloads in flight. No foreground gate: with the MP3
  /// hog gone (compressed CAF) + default priority, the bulk and the foreground
  /// stream/reads share the one H2 connection fine — the gate's hard throttle was
  /// capping the whole fill at ~1 stream (~260 KB/s) while audio played. Full
  /// concurrency matches the old unbounded path's ~45 MB/s.
  private func pump() {
    while dlInflight < dlLimit, !dlQueue.isEmpty {
      let item = dlQueue.removeFirst()
      if onDisk(item.key) || inFlight.contains(item.key) { continue }
      runScheduled(item)
    }
  }

  /// One scheduled (bulk) download with throughput accounting + bounded retry.
  private func runScheduled(_ item: DLItem) {
    inFlight.insert(item.key)
    dlInflight += 1
    let task = nextDLSession().downloadTask(with: item.url) { [weak self] tmp, resp, _ in
      DispatchQueue.main.async {
        guard let self else { return }
        self.dlInflight -= 1
        self.inFlight.remove(item.key)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 200, let tmp, let n = self.publish(tmp, item.key) {
          self.dlWindowBytes += n
          self.dlRetries[item.key] = nil
          // (Budget enforced on the 2s tick, not per-completion — see schedulerTick.)
        } else {
          // Overload → hard multiplicative decrease. Retryable → requeue (bounded).
          if code == 429 || code == 503 || code == 0 {
            self.dlLimit = max(self.dlMin, Int(Double(self.dlLimit) * 0.7))
          }
          let r = (self.dlRetries[item.key] ?? 0) + 1
          if r <= 3 { self.dlRetries[item.key] = r; self.dlQueue.append(item) }
        }
        self.pump()
      }
    }
    // NOTE: do NOT set a low task.priority — on iOS URLSession that doesn't just
    // hint H2 stream priority (deprecated/ignored anyway), it THROTTLES the
    // transfer's scheduling, which capped the bulk fill at ~349 KB/s vs the
    // ~45 MB/s a default-priority fill reaches. Yielding to foreground is the
    // gate's job (stop issuing), not priority.
    task.resume()
  }

  /// 2s tick: hill-climb `dlLimit` on aggregate throughput, enforce the budget,
  /// stop when drained. (Budget check lives here, not in `pump`, so the O(files)
  /// dir scan runs ~every 2s instead of after every completion.)
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
    let now = Date.timeIntervalSinceReferenceDate
    let dt = now - dlWindowStart
    let tput = dt > 0 ? Double(dlWindowBytes) / dt : 0
    dlWindowStart = now
    dlWindowBytes = 0
    // Hill-climb toward the throughput knee (grow while saturated + improving;
    // shrink if it drops). Bounded [dlMin, dlMax].
    if tput > dlLastTput * 1.05 {
      if dlInflight >= dlLimit { dlLimit = min(dlMax, dlLimit + 4) }
    } else if tput < dlLastTput * 0.90 {
      dlLimit = max(dlMin, dlLimit - 2)
    }
    dlLastTput = max(tput, dlLastTput * 0.5) // decay the reference so it re-probes
    // Stalled tasks: a hung connection just fails (or hits URLSession's timeout) →
    // the completion handler requeues it (bounded). We keep no per-task handle, so
    // a slow-but-progressing task simply holds its slot and the limit compensates.
    pump()
  }

  /// Move a freshly-downloaded temp file into the cache under `key`; returns bytes.
  private func publish(_ tmp: URL, _ key: String) -> Int64? {
    let dest = cacheDir.appendingPathComponent(key)
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
      try? fm.removeItem(at: cacheDir.appendingPathComponent(key))
    }
    savePins()
  }

  /// Set the storage budget (bytes) + immediately enforce it (a lowered cap evicts
  /// down to fit). The web confirms destructive lowering with the user first.
  private func setCap(_ d: [String: Any]?) {
    if let c = d?["bytes"] as? Double, c > 0 { capBytes = Int64(c) }
    enforceCap()
  }

  /// Total bytes of complete (non-`.part`, non-sidecar) audio files.
  private func usedBytes() -> Int64 {
    let fm = FileManager.default
    guard let files = try? fm.contentsOfDirectory(
      at: cacheDir, includingPropertiesForKeys: [.fileSizeKey]
    ) else { return 0 }
    var total: Int64 = 0
    for f in files
    where f.pathExtension != "part" && !f.lastPathComponent.hasPrefix("_") {
      total += Int64((try? f.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0)
    }
    return total
  }

  /// LRU eviction (adaptive by access recency — `cachedFileURL` touches mtime on
  /// every play): while OVER the cap, delete the least-recently-used EVICTABLE
  /// (non-pinned) file. Pinned (manual) + the `_pins.json` sidecar are never
  /// touched; if pinned alone exceeds the cap we stop (the user's deliberate choice
  /// wins over the budget). Text is a separate store and is never evicted here.
  private func enforceCap() {
    let fm = FileManager.default
    guard let files = try? fm.contentsOfDirectory(
      at: cacheDir, includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey]
    ) else { return }
    var total: Int64 = 0
    var evictable: [(url: URL, date: Date, size: Int64)] = []
    for f in files
    where f.pathExtension != "part" && !f.lastPathComponent.hasPrefix("_") {
      let v = try? f.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
      let size = Int64(v?.fileSize ?? 0)
      total += size
      if !pinned.contains(f.lastPathComponent) {
        evictable.append((f, v?.contentModificationDate ?? .distantPast, size))
      }
    }
    guard total > capBytes else { return }
    for e in evictable.sorted(by: { $0.date < $1.date }) { // oldest first
      if total <= capBytes { break }
      try? fm.removeItem(at: e.url)
      total -= e.size
    }
  }

  /// Report the audio store state for the Downloads UI: total used, the cap,
  /// pinned (protected) bytes, and the cached + pinned key sets (the web maps
  /// keys→books via the manifest). Replied via `window.__lvAudioResolve(id, json)`.
  private func audioStats(_ d: [String: Any]?) {
    guard let id = d?["id"] as? String else { return }
    let fm = FileManager.default
    var cached: [String] = []
    var used: Int64 = 0
    var pinnedBytes: Int64 = 0
    if let files = try? fm.contentsOfDirectory(
      at: cacheDir, includingPropertiesForKeys: [.fileSizeKey]
    ) {
      for f in files
      where f.pathExtension != "part" && !f.lastPathComponent.hasPrefix("_") {
        let key = f.lastPathComponent
        cached.append(key)
        let sz = Int64((try? f.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0)
        used += sz
        if pinned.contains(key) { pinnedBytes += sz }
      }
    }
    let obj: [String: Any] = [
      "usedBytes": used, "cap": capBytes, "pinnedBytes": pinnedBytes,
      "cached": cached, "pinned": Array(pinned),
    ]
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
        // SELF-HEAL: a failed CACHED file is likely corrupt — drop it and
        // re-stream from the origin (once). A failed STREAM surfaces as an error.
        if self.playingFromCache, let key = self.currentCacheKey,
           let origin = self.currentOriginURL {
          self.playingFromCache = false
          try? FileManager.default.removeItem(at: self.cacheDir.appendingPathComponent(key))
          let wasPlaying = self.isPlaying()
          self.teardownItem() // drop this (now-stale) item's observers
          let fresh = AVPlayerItem(url: origin)
          self.observeItem(fresh)
          self.player.replaceCurrentItem(with: fresh)
          self.downloadToCache(origin, key)
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
  private func onDisk(_ key: String) -> Bool {
    FileManager.default.fileExists(atPath: cacheDir.appendingPathComponent(key).path)
  }

  /// The local file for a fully-cached key, or nil. Touches it so the LRU keeps
  /// recently-played audio.
  private func cachedFileURL(_ key: String) -> URL? {
    let f = cacheDir.appendingPathComponent(key)
    guard FileManager.default.fileExists(atPath: f.path) else { return nil }
    try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: f.path)
    return f
  }

  /// Download `url` into the cache as `key`, once. Skips if already cached or in
  /// flight. Used as a side-effect of streaming a not-yet-cached chapter AND by an
  /// explicit prefetch (save-offline). Atomic publish (.part → rename) so a crash
  /// never leaves a truncated file masquerading as complete.
  private func downloadToCache(_ url: URL, _ key: String) {
    let dest = cacheDir.appendingPathComponent(key)
    if FileManager.default.fileExists(atPath: dest.path) || inFlight.contains(key) { return }
    inFlight.insert(key)
    let task = nextDLSession().downloadTask(with: url) { [weak self] tmp, resp, _ in
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
