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

  // Offline cache (content-addressed when the web supplies the hash).
  private var inFlight: Set<String> = []
  private let cacheCapBytes: Int64 = 1_500_000_000 // ~1.5 GB, LRU-evicted
  private lazy var cacheDir: URL = {
    let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    let dir = base.appendingPathComponent("lv-audio", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
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
  }

  private init(webView: WKWebView) {
    self.webView = webView
    super.init()
    // REQUIRED for precise control + the M2 resource loader: with auto-wait on,
    // AVPlayer second-guesses our explicit play()/rate and stalls unexpectedly.
    player.automaticallyWaitsToMinimizeStalling = false
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
    case "prefetch":
      if let s = d?["url"] as? String, let u = URL(string: s) {
        downloadToCache(u, cacheKey(forURL: u, hash: d?["hash"] as? String))
      }
    default: break
    }
  }

  private func load(_ d: [String: Any]?) {
    guard let d, let urlStr = d["url"] as? String, let url = URL(string: urlStr) else { return }
    let position = d["position"] as? Double ?? 0
    rate = d["rate"] as? Double ?? 1
    duration = 0
    let key = cacheKey(forURL: url, hash: d["hash"] as? String)

    teardownItem()
    // OFFLINE CACHE: if this chapter's audio is already fully cached on disk
    // (keyed by its content hash when the web supplies one, else the URL), play
    // the LOCAL file — fully offline + instant. Otherwise stream the origin AND
    // download it in the background so the NEXT play (and offline) is local.
    let item: AVPlayerItem
    if let cached = cachedFileURL(key) {
      item = AVPlayerItem(url: cached)
    } else {
      item = AVPlayerItem(url: url)
      downloadToCache(url, key)
    }
    observeItem(item)
    player.replaceCurrentItem(with: item)
    if position > 0 {
      player.seek(to: CMTime(seconds: position, preferredTimescale: 1000))
    }

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
    player.playImmediately(atRate: Float(rate)) // applies rate AND starts
    pushNowPlaying(playing: true, position: currentPosition())
    emit("{type:'playing'}")
  }

  private func pause() {
    player.pause()
    pushNowPlaying(playing: false, position: currentPosition())
    emit("{type:'paused'}")
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
      if pos.isFinite {
        self.emit("{type:'time',position:\(pos),duration:\(self.duration)}")
      }
    }
  }

  private func observeItem(_ item: AVPlayerItem) {
    statusObs = item.observe(\.status, options: [.new]) { [weak self] it, _ in
      guard let self else { return }
      switch it.status {
      case .readyToPlay:
        let d = it.duration.seconds
        if d.isFinite, d > 0 {
          self.duration = d
          self.nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] = d
          MPNowPlayingInfoCenter.default().nowPlayingInfo = self.nowPlayingInfo
          self.emit("{type:'durationchange',duration:\(d)}")
        }
        self.emit("{type:'canplay'}")
      case .failed:
        self.emit("{type:'error',message:'item failed'}")
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
    URLSession.shared.downloadTask(with: url) { [weak self] tmp, resp, _ in
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
      DispatchQueue.main.async { self.enforceCacheCap() }
    }.resume()
  }

  /// LRU eviction: while the cache exceeds the cap, delete the least-recently-used
  /// (oldest modification date) complete files. `.part` files are left alone.
  private func enforceCacheCap() {
    let fm = FileManager.default
    guard let files = try? fm.contentsOfDirectory(
      at: cacheDir, includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey]
    ) else { return }
    var entries: [(url: URL, date: Date, size: Int64)] = []
    var total: Int64 = 0
    for f in files where f.pathExtension != "part" {
      let v = try? f.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
      let size = Int64(v?.fileSize ?? 0)
      entries.append((f, v?.contentModificationDate ?? .distantPast, size))
      total += size
    }
    guard total > cacheCapBytes else { return }
    for e in entries.sorted(by: { $0.date < $1.date }) { // oldest first
      if total <= cacheCapBytes { break }
      try? fm.removeItem(at: e.url)
      total -= e.size
    }
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
