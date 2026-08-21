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
//       play | pause | stop | state
//       seek {position} | rate {rate}
//       cacheFromUrl {url, hash} | cacheHas {id, hash} | cacheDelete {hash}
//       cacheCount {id} | setAllowsCellular {on}
//   native → web   (CustomEvent "lv-native-audio"): {type, ...}
//       time {position, duration} | durationchange {duration}
//       playing | paused | ended | waiting | canplay
//       next | prev   (remote next/prev track — the WEB owns the queue)
//       error {message} | network {net} | cacheProgress {hash, ok}
//
// Media cache is a generic decode cache + bounded fetch queue, not the store:
// TS owns pin/LRU/cap/worklist. Native never sees a DAG, book, or Downloads
// total. Continuation while suspended is NOT available — do not reintroduce
// `.background(withIdentifier:)`.
//
// Lock-screen / AirPods / CarPlay transport runs through MPRemoteCommandCenter +
// MPNowPlayingInfoCenter, applied DIRECTLY to the AVPlayer (play/pause/seek/skip)
// and echoed to the web so its UI + read-along stay in sync.
//
// Concurrency: classic main-thread MediaPlayer/AVFoundation. Script messages and
// remote-command callbacks arrive on the main thread.

import AVFoundation
import MediaPlayer
import Network
import UIKit
import WebKit
import WidgetKit

@objc(NativeAudioController) public final class NativeAudioController: NSObject, WKScriptMessageHandler, URLSessionDownloadDelegate {
  private static var controllers: [ObjectIdentifier: NativeAudioController] = [:]
  private static let messageName = "lvNativeAudio"
  private static let skip: NSNumber = 15

  private weak var webView: WKWebView?
  // Live network-path type for the native WiFi-only audio-download policy.
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

  // Playback files live in Application Support (NOT Caches — iOS purges Caches
  // under pressure). Keyed by content hash; TS owns pins/LRU/cap.
  private var inFlight: Set<String> = []
  private lazy var cacheDir: URL = {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    let dir = base.appendingPathComponent("lv-audio", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }()

  // In-memory hash-set for cacheCount. Rebuilt OFF-MAIN from the directory if
  // cold; never a UI-path readdir of ~3k files (that jank is why LvStore existed).
  private var cachedHashes: Set<String> = []
  private var hashSetReady = false
  private let hashSetQueue = DispatchQueue(label: "lv.audio.hashset", qos: .utility)

  // ── Foreground bulk-download scheduler ───────────────────────────────────────
  // The library fill runs on a POOL of FOREGROUND `.default` URLSessions. WHY
  // not `.background(withIdentifier:)` (an earlier attempt at "download while
  // suspended"): on THIS device the background nsurlsessiond pool made ZERO
  // progress — not even in the foreground — while a `.default` session
  // provably works. Reverted to `.default`: it reliably advances whenever the
  // app is open. The tradeoff — `.default` transfers suspend when the app
  // leaves the foreground — is the accepted ceiling until true background
  // continuation is solved separately.
  //
  // A POOL of N sessions (not one): one URLSession multiplexes ALL its tasks onto a
  // SINGLE HTTP/2 connection to a host; the origin is a TLS domain reached through a
  // relay (NOT the LAN), so over that high-RTT path one connection's congestion +
  // h2 flow-control window caps aggregate throughput to ~one stream's worth NO
  // MATTER how many streams are in flight. N independent sessions = N connections =
  // N parallel windows, restoring the ~tens-of-MB/s fill.
  private struct DLItem { let url: URL; let key: String }
  private var dlQueue: [DLItem] = []
  private var dlQueueHead = 0
  private var dlQueuedKeys: Set<String> = []
  /// Keys TS `cacheDelete`d. pump / publish / retry must not revive them.
  private var dlDrop: Set<String> = []
  private var dlInflight = 0
  private var dlTimer: Timer?
  private var dlRetries: [String: Int] = [:]
  private static let dlSessionCount = 6
  // Keep only one active bulk task per independent session. Queuing thousands of
  // URLSession tasks at once made task creation and delegate delivery contend
  // with WKWebView's main thread while the user was scrolling.
  private static let dlMaxInflight = dlSessionCount

  // Cellular policy on the pool. Persisted so the pool has the right
  // allowsCellularAccess from the first task at launch, before TS re-pushes it.
  // Default false (never surprise-burn cellular). Migrates the old wifiOnly key.
  private static let allowsCellularKey = "lv.audio.allowsCellular"
  private static let wifiOnlyKey = "lv.audio.wifiOnly"
  private lazy var allowsCellular: Bool = {
    if let v = UserDefaults.standard.object(forKey: Self.allowsCellularKey) as? Bool {
      return v
    }
    let wifiOnly = (UserDefaults.standard.object(forKey: Self.wifiOnlyKey) as? Bool) ?? true
    return !wifiOnly
  }()

  private var dlSessions: [URLSession] = []
  private var dlRR = 0

  /// Build the foreground `.default` pool. Called once eagerly at init and again
  /// after a cellular-policy toggle. Assumes `dlSessions` is empty. Delegate-based
  /// downloads (no completion handler) so publish/accounting run in the
  /// URLSessionDownloadDelegate methods below.
  private func setupDownloadSessions() {
    guard dlSessions.isEmpty else { return }
    dlSessions = (0..<Self.dlSessionCount).map { index in
      let cfg = URLSessionConfiguration.default
      cfg.httpMaximumConnectionsPerHost = 6
      cfg.allowsCellularAccess = allowsCellular
      // Ride out a brief connectivity blip instead of failing the task outright.
      cfg.waitsForConnectivity = true
      cfg.timeoutIntervalForRequest = 90
      cfg.timeoutIntervalForResource = 24 * 60 * 60
      cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
      cfg.urlCache = nil
      let delegateQueue = OperationQueue()
      delegateQueue.name = "lv.audio.download.\(index)"
      delegateQueue.qualityOfService = .utility
      delegateQueue.maxConcurrentOperationCount = 1
      return URLSession(configuration: cfg, delegate: self, delegateQueue: delegateQueue)
    }
  }

  /// Next session from the pool, round-robin — spreads the fill across all N
  /// connections instead of piling every task onto one.
  private func nextDLSession() -> URLSession {
    let s = dlSessions[dlRR % dlSessions.count]
    dlRR &+= 1
    return s
  }

  /// Apply the cellular preference pushed from the web. Rebuilds the pool so the
  /// new `allowsCellularAccess` takes effect (config is immutable). `.default`
  /// sessions carry no shared identifier, so the new pool can be built immediately;
  /// the old sessions' cancelled tasks fire didCompleteWithError(.cancelled), which
  /// we skip-retry; TS re-enqueues misses from its IDB worklist.
  private func applyAllowsCellular(_ on: Bool) {
    if dlSessions.isEmpty {
      if on != allowsCellular {
        allowsCellular = on
        UserDefaults.standard.set(on, forKey: Self.allowsCellularKey)
      }
      setupDownloadSessions()
      return
    }
    if on == allowsCellular { return }
    allowsCellular = on
    UserDefaults.standard.set(on, forKey: Self.allowsCellularKey)
    let old = dlSessions
    dlSessions = []
    dlInflight = 0
    inFlight.removeAll()
    for s in old { s.invalidateAndCancel() }
    setupDownloadSessions()
    startScheduler()
  }

  // Foreground single-file session for the play-path prefetch (the chapter being
  // streamed right now). Kept a `.default` completion-handler session on purpose:
  // it's a want-it-NOW fetch while the app is active, not part of the library
  // fill, so it needs no out-of-process continuation.
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
    c.seedHashSetAndExportLegacy()
  }

  /// One-time cleanup: delete any audio file that is NOT the current compressed
  /// variant (Opus-in-CAF). Marker-gated so it runs once.
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
        }
      }
    }
    fm.createFile(atPath: marker.path, contents: Data())
  }

  /// Scan lv-audio off-main, seed the hash-set, and write `_legacy-index.json`
  /// once so TS can import present/pins without 3k cacheHas round-trips.
  private func seedHashSetAndExportLegacy() {
    let dir = cacheDir
    hashSetQueue.async { [weak self] in
      let (hashes, pins) = Self.scanLegacy(dir)
      let dest = dir.appendingPathComponent("_legacy-index.json")
      if !FileManager.default.fileExists(atPath: dest.path) {
        let obj: [String: Any] = ["hashes": Array(hashes), "pins": Array(pins)]
        if let data = try? JSONSerialization.data(withJSONObject: obj) {
          try? data.write(to: dest, options: .atomic)
        }
      }
      DispatchQueue.main.async {
        guard let self else { return }
        self.cachedHashes = hashes
        self.hashSetReady = true
      }
    }
  }

  /// Directory scan + `.caf`/legacy migration. Must not run on the UI path.
  private static func scanLegacy(_ dir: URL) -> (Set<String>, Set<String>) {
    var hashes = Set<String>()
    let fm = FileManager.default
    if let files = try? fm.contentsOfDirectory(
      at: dir, includingPropertiesForKeys: nil
    ) {
      for f in files
      where f.pathExtension != "part"
        && f.pathExtension != "json"
        && !f.lastPathComponent.hasPrefix("_") {
        let key: String
        if f.pathExtension == "caf" {
          key = String(f.deletingPathExtension().lastPathComponent)
        } else {
          key = f.lastPathComponent
          let caf = dir.appendingPathComponent(key + ".caf")
          if !fm.fileExists(atPath: caf.path) {
            try? fm.moveItem(at: f, to: caf)
          }
        }
        if !key.isEmpty { hashes.insert(key) }
      }
    }
    var pins = Set<String>()
    let pinsFile = dir.appendingPathComponent("_pins.json")
    if let d = try? Data(contentsOf: pinsFile),
       let a = try? JSONDecoder().decode([String].self, from: d) {
      pins = Set(a).intersection(hashes)
    }
    return (hashes, pins)
  }

  private init(webView: WKWebView) {
    self.webView = webView
    super.init()
    // Keep auto-wait ON (the default): when streaming, AVPlayer buffers enough
    // before it starts. With it OFF + a resume seek to a far (unbuffered) offset
    // and playImmediately, playback stalls forever at 0:00 — the "this chapter
    // won't play" bug on a chapter resumed near its end.
    player.automaticallyWaitsToMinimizeStalling = true
    netMonitor.pathUpdateHandler = { [weak self] p in
      guard let self else { return }
      self.netPath = p
      self.emit("{type:'network',net:'\(self.netType())'}")
      if p.status == .satisfied {
        DispatchQueue.main.async { [weak self] in self?.startScheduler() }
      }
    }
    netMonitor.start(queue: DispatchQueue(label: "lv.net"))
    // Force the cache dir's lazy init on THIS (main) thread before any download
    // session exists: a transfer's didFinishDownloadingTo → publish runs on the
    // session's delegate queue (off main) and touches `cacheDir`; a non-thread-safe
    // lazy racing that first access could crash. Pre-touching here closes the window.
    _ = cacheDir
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
    case "cacheFromUrl": cacheFromUrl(d)
    case "cacheHas": cacheHas(d)
    case "cacheDelete": cacheDelete(d)
    case "cacheCount": cacheCount(d)
    case "setAllowsCellular": if let on = d?["on"] as? Bool { applyAllowsCellular(on) }
    case "widgetSnapshot": publishWidgetSnapshot(d)
    default: break
    }
  }

  /// Persist the small state WidgetKit needs. App Group access is optional at
  /// runtime so Personal Team builds keep working through the widget's network
  /// path; once the entitlement is provisioned this becomes the offline source.
  private func publishWidgetSnapshot(_ d: [String: Any]?) {
    guard let d,
          let root = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: "group.top.thundersparrow.liveview"
          ),
          let defaults = UserDefaults(suiteName: "group.top.thundersparrow.liveview")
    else { return }
    let serverURL = d["serverURL"] as? String ?? ""
    if !serverURL.isEmpty { defaults.set(serverURL, forKey: "serverURL") }
    let incoming = d["items"] as? [[String: Any]] ?? []
    let queue = DispatchQueue(label: "lv.widget.snapshot", qos: .utility)
    queue.async {
      var items: [[String: Any]] = []
      for item in incoming.prefix(4) {
        guard let slug = item["slug"] as? String,
              let label = item["label"] as? String else { continue }
        var coverFile: String?
        if let raw = item["coverURL"] as? String, let url = URL(string: raw),
           let bytes = try? Data(contentsOf: url) {
          let safe = slug.map { $0.isLetter || $0.isNumber || $0 == "-" ? $0 : "-" }
          let name = "widget-cover-\(String(safe)).img"
          if (try? bytes.write(to: root.appendingPathComponent(name), options: .atomic)) != nil {
            coverFile = name
          }
        }
        var output: [String: Any] = [
          "label": label,
          "slug": slug,
          "progress": item["progress"] as? Double ?? 0,
        ]
        if let coverFile { output["coverFile"] = coverFile }
        items.append(output)
      }
      let payload: [String: Any] = [
        "updatedAt": Date().timeIntervalSince1970,
        "items": items,
      ]
      if let data = try? JSONSerialization.data(withJSONObject: payload) {
        defaults.set(data, forKey: "widgetSnapshot")
        DispatchQueue.main.async { WidgetCenter.shared.reloadAllTimelines() }
      }
    }
  }

  // MARK: media cache

  private func cacheFromUrl(_ d: [String: Any]?) {
    guard let s = d?["url"] as? String, let u = URL(string: s),
          let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https",
          let hash = d?["hash"] as? String else { return }
    let key = sanitizeKey(hash)
    guard !key.isEmpty else { return }
    if onDisk(key) {
      noteCached(key)
      emitCacheProgress(key, true)
      return
    }
    dlDrop.remove(key)
    if dlQueuedKeys.contains(key) || inFlight.contains(key) { return }
    dlQueue.append(DLItem(url: u, key: key))
    dlQueuedKeys.insert(key)
    startScheduler()
  }

  private func cacheHas(_ d: [String: Any]?) {
    guard let id = d?["id"] as? String, let hash = d?["hash"] as? String else { return }
    reply(id, ["has": onDisk(sanitizeKey(hash))])
  }

  private func cacheDelete(_ d: [String: Any]?) {
    guard let hash = d?["hash"] as? String else { return }
    let key = sanitizeKey(hash)
    dlDrop.insert(key)
    dlQueuedKeys.remove(key)
    if dlQueueHead < dlQueue.count {
      dlQueue = Array(dlQueue[dlQueueHead...].filter { $0.key != key })
      dlQueueHead = 0
    }
    let fm = FileManager.default
    try? fm.removeItem(at: fileURL(key))
    try? fm.removeItem(at: cacheDir.appendingPathComponent(key))
    cachedHashes.remove(key)
  }

  private func cacheCount(_ d: [String: Any]?) {
    guard let id = d?["id"] as? String else { return }
    if hashSetReady {
      reply(id, ["count": cachedHashes.count])
      return
    }
    let dir = cacheDir
    hashSetQueue.async { [weak self] in
      let (hashes, _) = Self.scanLegacy(dir)
      DispatchQueue.main.async {
        guard let self else { return }
        if !self.hashSetReady {
          self.cachedHashes = hashes
          self.hashSetReady = true
        }
        self.reply(id, ["count": self.cachedHashes.count])
      }
    }
  }

  private func noteCached(_ key: String) {
    cachedHashes.insert(key)
  }

  // MARK: adaptive download scheduler

  /// Start the drain timer (idempotent) + pump.
  private func startScheduler() {
    if dlTimer == nil {
      dlTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
        self?.schedulerTick()
      }
    }
    pump()
  }

  /// Keep a small bounded set of real URLSession tasks active. Pending work
  /// stays in our O(1) FIFO rather than becoming thousands of Foundation tasks.
  private func pump() {
    guard !dlSessions.isEmpty else { return } // pool rebuilding — next tick pumps
    while dlInflight < Self.dlMaxInflight, dlQueueHead < dlQueue.count {
      let item = dlQueue[dlQueueHead]
      dlQueueHead += 1
      dlQueuedKeys.remove(item.key)
      if dlDrop.contains(item.key) { continue }
      if onDisk(item.key) || inFlight.contains(item.key) {
        if onDisk(item.key) {
          noteCached(item.key)
          emitCacheProgress(item.key, true)
        }
        continue
      }
      runScheduled(item)
    }
    // Reclaim consumed storage occasionally without shifting the array on every
    // dequeue. This bounds memory while keeping the steady-state hot path O(1).
    if dlQueueHead > 1024 && dlQueueHead * 2 > dlQueue.count {
      dlQueue.removeFirst(dlQueueHead)
      dlQueueHead = 0
    }
  }

  private func runScheduled(_ item: DLItem) {
    inFlight.insert(item.key)
    dlInflight += 1
    let task = nextDLSession().downloadTask(with: item.url)
    task.taskDescription = item.key
    task.resume()
  }

  /// 2s tick: stop when the queue has fully drained, else keep pumping.
  private func schedulerTick() {
    if dlQueueHead >= dlQueue.count && dlInflight == 0 {
      dlTimer?.invalidate()
      dlTimer = nil
      return
    }
    pump()
  }

  // MARK: URLSessionDownloadDelegate (foreground bulk pool)

  /// A finished transfer's temp file is valid ONLY inside this call — publish it
  /// synchronously here (on the session's delegate queue, off main). A "download"
  /// still completes for a 404/500 (the body is the error page), so status-gate:
  /// only a 200 publishes.
  public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                         didFinishDownloadingTo location: URL) {
    guard let key = downloadTask.taskDescription else { return }
    let code = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
    guard code == 200, publish(location, key) != nil else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      if self.dlDrop.contains(key) {
        self.dlDrop.remove(key)
        let fm = FileManager.default
        try? fm.removeItem(at: self.fileURL(key))
        try? fm.removeItem(at: self.cacheDir.appendingPathComponent(key))
        self.cachedHashes.remove(key)
        return
      }
      self.dlRetries[key] = nil
      self.noteCached(key)
      self.emitCacheProgress(key, true)
    }
  }

  /// Terminal callback for every bulk task. Decrement in-flight, requeue a bounded
  /// number of times on failure, and pump. Runs on the session's delegate queue;
  /// hop to main for the shared scheduler state.
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
      if self.dlDrop.contains(key) {
        self.dlDrop.remove(key)
        self.pump()
        return
      }
      if !cancelled, !self.onDisk(key), let url {
        let r = (self.dlRetries[key] ?? 0) + 1
        if r <= 3, !self.dlQueuedKeys.contains(key) {
          self.dlRetries[key] = r
          self.dlQueue.append(DLItem(url: url, key: key))
          self.dlQueuedKeys.insert(key)
        } else if r > 3 {
          self.emitCacheProgress(key, false)
        }
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
    nowPlayingInfo[MPMediaItemPropertyMediaType] = MPMediaType.audioBook.rawValue
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
  /// is actually playing). Also re-pushes `network` so a listener installed after
  /// the first NWPathMonitor fire still gets a snapshot.
  private func emitState() {
    let d = duration
    if d > 0 { emit("{type:'durationchange',duration:\(d)}") }
    emit("{type:'time',position:\(currentPosition()),duration:\(d)}")
    emit(isPlaying() ? "{type:'playing'}" : "{type:'paused'}")
    emit("{type:'network',net:'\(netType())'}")
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
        // "downloads vanish" death-loop. When ONLINE, re-stream from the origin as
        // a fallback but KEEP the file; when OFFLINE, surface the error and keep
        // the file for a later retry.
        if self.playingFromCache, let origin = self.currentOriginURL,
           self.netType() != "none" {
          self.playingFromCache = false
          let wasPlaying = self.isPlaying()
          self.teardownItem()
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
      // Preserve the authored portrait cover. iOS owns compact versus expanded
      // Now Playing layout and derives the appropriate rendition itself.
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

  // MARK: Offline cache (content-addressed)

  private func sanitizeKey(_ hash: String) -> String {
    hash.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
  }

  /// The cache filename for a track: the web-supplied content hash when present,
  /// else a stable digest of the origin URL. Sanitized to a safe filename.
  private func cacheKey(forURL url: URL, hash: String?) -> String {
    if let hash, !hash.isEmpty {
      return sanitizeKey(hash)
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

  /// On-disk path for a cache key. Files carry a `.caf` EXTENSION on purpose:
  /// AVURLAsset infers a LOCAL file's container type from its path extension, and
  /// our content-hash keys have none — without it Opus-in-CAF fails to load with
  /// "item failed" on OFFLINE playback.
  private func fileURL(_ key: String) -> URL {
    cacheDir.appendingPathComponent(key + ".caf")
  }

  /// Resolve a key to its on-disk file, lazily migrating a legacy extension-less
  /// blob (`<hash>` → `<hash>.caf`) IN PLACE — instant, same bytes, no re-download.
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

  /// The local file for a fully-cached key, or nil. Touches mtime so TS LRU can
  /// still treat recently-played audio as recent if it later stats the file.
  private func cachedFileURL(_ key: String) -> URL? {
    guard let f = resolveFile(key) else { return nil }
    try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: f.path)
    return f
  }

  /// Download `url` into the cache as `key`, once. Play-path want-it-NOW fetch.
  private func downloadToCache(_ url: URL, _ key: String) {
    let dest = fileURL(key)
    if onDisk(key) || inFlight.contains(key) { return }
    inFlight.insert(key)
    let task = fgSession.downloadTask(with: url) { [weak self] tmp, resp, _ in
      guard let self else { return }
      defer { DispatchQueue.main.async { self.inFlight.remove(key) } }
      guard let tmp, let code = (resp as? HTTPURLResponse)?.statusCode, code == 200 else {
        DispatchQueue.main.async { self.emitCacheProgress(key, false) }
        return
      }
      let fm = FileManager.default
      let part = dest.appendingPathExtension("part")
      try? fm.removeItem(at: part)
      try? fm.removeItem(at: dest)
      do {
        try fm.moveItem(at: tmp, to: part)
        try fm.moveItem(at: part, to: dest)
      } catch {
        try? fm.removeItem(at: part)
        DispatchQueue.main.async { self.emitCacheProgress(key, false) }
        return
      }
      DispatchQueue.main.async {
        self.noteCached(key)
        self.emitCacheProgress(key, true)
      }
    }
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

  private func emitCacheProgress(_ hash: String, _ ok: Bool) {
    emit("{type:'cacheProgress',hash:'\(hash)',ok:\(ok ? "true" : "false")}")
  }

  private func reply(_ id: String, _ obj: [String: Any]) {
    let json = (try? JSONSerialization.data(withJSONObject: obj))
      .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    let esc = json.replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "'", with: "\\'")
    let safeId = id.replacingOccurrences(of: "'", with: "")
    let js = "window.__lvHostResolve&&window.__lvHostResolve('\(safeId)','\(esc)')"
    DispatchQueue.main.async { [weak self] in
      self?.webView?.evaluateJavaScript(js, completionHandler: nil)
    }
  }
}
