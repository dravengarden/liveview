// VENDORED from shared-utils/packages/native-media/ios/NativeMediaController.swift
// (canonical source of truth is @shared-utils/native-media; re-sync from there on change)

// NativeMediaController — the native (iOS) half of @shared-utils/native-media.
//
// Moves the OS media-control layer to native while the audio keeps playing in the
// web `<audio>` element:
//   • MPRemoteCommandCenter — play / pause / toggle / skip±15 / next / prev / seek
//     (lock screen, AirPods stem, CarPlay, steering wheel, Control Center). Each
//     fires a `lv-native-media` CustomEvent into the webview; the web applies it to
//     its audio element.
//   • AVAudioSession route-change — AirPods/headphones removed → dispatch `pause`.
//   • AVAudioSession interruption — call/alarm begins → `pause`; ends w/ shouldResume → `play`.
//   • MPNowPlayingInfoCenter — populated from the web's reported metadata + state;
//     iOS extrapolates the lock-screen scrubber from elapsed time + rate.
//
// WHY: in a WKWebView the web MediaSession API is an unreliable proxy for these — the
// page's media session is deactivated on lock/background, and AirPods commands don't
// arrive. Owning MPRemoteCommandCenter + MPNowPlayingInfoCenter natively is reliable.
//
// Concurrency: classic main-thread UIKit/MediaPlayer. Script messages + remote-command
// callbacks arrive on the main thread; reached from ObjC, so a plain @objc NSObject.
//
// Wiring (per app, iOS Tauri shell): on WKWebView creation call
//   [NativeMediaController installOnWebView:webView];
// On the PWA / Android / browser there is no `lvNativeMedia` handler, so the web keeps
// its existing MediaSession path untouched.

import AVFoundation
import MediaPlayer
import UIKit
import WebKit

@objc(NativeMediaController) public final class NativeMediaController: NSObject, WKScriptMessageHandler {
  private static var controllers: [ObjectIdentifier: NativeMediaController] = [:]
  private static let messageName = "lvNativeMedia"
  private static let skip: NSNumber = 15

  private weak var webView: WKWebView?
  private var nowPlayingInfo: [String: Any] = [:]
  private var commandsWired = false
  /// De-dupe artwork fetches — only reload when the URL changes.
  private var artworkURL: String?

  // MARK: Install

  @objc public static func installOnWebView(_ webView: WKWebView) {
    let key = ObjectIdentifier(webView)
    if controllers[key] != nil { return }
    let c = NativeMediaController(webView: webView)
    controllers[key] = c
    webView.configuration.userContentController.add(c, name: messageName)
    c.wireRemoteCommands()
    c.observeAudioSession()
  }

  private init(webView: WKWebView) {
    self.webView = webView
    super.init()
  }

  // MARK: web → native (now-playing + state)

  public func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    guard let body = m.body as? [String: Any], let kind = body["kind"] as? String else { return }
    switch kind {
    case "nowplaying": setNowPlaying(body["data"] as? [String: Any])
    case "state": setState(body["data"] as? [String: Any])
    case "clear": clear()
    default: break
    }
  }

  private func setNowPlaying(_ d: [String: Any]?) {
    guard let d else { return }
    nowPlayingInfo[MPMediaItemPropertyTitle] = d["title"] as? String ?? ""
    nowPlayingInfo[MPMediaItemPropertyArtist] = d["artist"] as? String ?? ""
    nowPlayingInfo[MPMediaItemPropertyAlbumTitle] = d["album"] as? String ?? ""
    if let dur = d["duration"] as? Double, dur > 0 {
      nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] = dur
    }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
    loadArtwork(d["artworkUrl"] as? String)
  }

  private func setState(_ d: [String: Any]?) {
    guard let d else { return }
    let playing = d["playing"] as? Bool ?? false
    let pos = d["position"] as? Double ?? 0
    let rate = d["rate"] as? Double ?? 1
    nowPlayingInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = pos
    // The rate iOS uses to TICK the lock-screen scrubber: the real rate while
    // playing, 0 while paused (so it freezes the displayed position).
    nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = playing ? rate : 0.0
    nowPlayingInfo[MPNowPlayingInfoPropertyDefaultPlaybackRate] = rate
    let center = MPNowPlayingInfoCenter.default()
    center.nowPlayingInfo = nowPlayingInfo
    // EXPLICIT playbackState — REQUIRED for an app whose audio is the web <audio>,
    // not a native AVPlayer. Without it iOS treats the Now Playing info as stale
    // and tears the lock-screen card down a short while after you pause; `.paused`
    // keeps the card alive (frozen at the elapsed time) until you resume or stop.
    //
    // We deliberately do NOT touch AVAudioSession here. Activating it from native
    // (even just to keep the paused card alive) BREAKS the web `<audio>.play()` —
    // WebKit must own session activation on the play gesture, and a native
    // setActive races/clobbers that so the play button does nothing. The web /
    // WebKit owns the session; this controller only mirrors metadata + state.
    center.playbackState = playing ? .playing : .paused
  }

  private func clear() {
    nowPlayingInfo = [:]
    artworkURL = nil
    let center = MPNowPlayingInfoCenter.default()
    center.nowPlayingInfo = nil
    center.playbackState = .stopped
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

  // MARK: native → web (remote commands)

  private func wireRemoteCommands() {
    if commandsWired { return }
    commandsWired = true
    let cc = MPRemoteCommandCenter.shared()
    cc.playCommand.addTarget { [weak self] _ in self?.dispatch("{type:'play'}"); return .success }
    cc.pauseCommand.addTarget { [weak self] _ in self?.dispatch("{type:'pause'}"); return .success }
    cc.togglePlayPauseCommand.addTarget { [weak self] _ in self?.dispatch("{type:'toggle'}"); return .success }
    cc.nextTrackCommand.addTarget { [weak self] _ in self?.dispatch("{type:'next'}"); return .success }
    cc.previousTrackCommand.addTarget { [weak self] _ in self?.dispatch("{type:'prev'}"); return .success }
    cc.skipForwardCommand.preferredIntervals = [Self.skip]
    cc.skipForwardCommand.addTarget { [weak self] e in
      let s = (e as? MPSkipIntervalCommandEvent)?.interval ?? 15
      self?.dispatch("{type:'skipforward',seconds:\(s)}"); return .success
    }
    cc.skipBackwardCommand.preferredIntervals = [Self.skip]
    cc.skipBackwardCommand.addTarget { [weak self] e in
      let s = (e as? MPSkipIntervalCommandEvent)?.interval ?? 15
      self?.dispatch("{type:'skipbackward',seconds:\(s)}"); return .success
    }
    cc.changePlaybackPositionCommand.addTarget { [weak self] e in
      guard let pe = e as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
      self?.dispatch("{type:'seek',position:\(pe.positionTime)}"); return .success
    }
    for cmd in [cc.playCommand, cc.pauseCommand, cc.togglePlayPauseCommand,
                cc.nextTrackCommand, cc.previousTrackCommand,
                cc.skipForwardCommand, cc.skipBackwardCommand,
                cc.changePlaybackPositionCommand] {
      cmd.isEnabled = true
    }
  }

  /// Deliver an OS command to the web as a `lv-native-media` CustomEvent. `detail`
  /// is a JS object literal (numbers only — no string interpolation of web data).
  private func dispatch(_ detail: String) {
    let js = "window.dispatchEvent(new CustomEvent('lv-native-media',{detail:\(detail)}))"
    DispatchQueue.main.async { [weak self] in
      self?.webView?.evaluateJavaScript(js, completionHandler: nil)
    }
  }

  // MARK: AVAudioSession (route change + interruption)

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
    // Headphones / AirPods unplugged → pause (the iOS convention).
    if reason == .oldDeviceUnavailable {
      dispatch("{type:'pause'}")
    }
  }

  @objc private func interrupted(_ note: Notification) {
    guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
    switch type {
    case .began:
      dispatch("{type:'pause'}")
    case .ended:
      let opts = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt).map {
        AVAudioSession.InterruptionOptions(rawValue: $0)
      }
      if opts?.contains(.shouldResume) == true { dispatch("{type:'play'}") }
    @unknown default:
      break
    }
  }
}
