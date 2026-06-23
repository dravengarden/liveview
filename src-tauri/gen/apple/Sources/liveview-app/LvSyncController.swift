// Offline reader-CONTENT bridge (text/units/spoken/marks) for the liveview shell.
//
// Why this is native Swift and not the Rust lv-sync plugin: on a real iOS device
// the webview→Rust channels don't work from the remote-loaded origin — Tauri's
// plugin IPC falls back to the Swift PluginManager ("not initialized") and a
// custom URL scheme is blocked cross-origin ("Load failed"). The ONE bridge that
// works from the remote origin is a WKScriptMessageHandler — the same mechanism
// NativeAudioController uses successfully. So content caching lives here, in Swift,
// mirroring the audio cache: a persistent content-addressed file cache + URLSession.
//
//   web → native  (WKScriptMessage "lvSync"): { id, cmd, url? }
//     cmd "resolve" → cache-first bytes for `url` (fetch+cache on miss)
//     cmd "stats"   → [cachedCount, totalCount, cachedBytes, totalBytes] (non-audio)
//     cmd "syncAll" → download every non-audio manifest resource
//   native → web   window.__lvSyncResolve(id, ok, payload)
//     resolve → payload = base64 of the bytes
//     stats   → payload = the JSON array text
//     syncAll → payload = bytes-cached count as text
//
// Installed from LiveviewNativeTweaks.mm (lv_wk_init) like the other controllers.

import Foundation
import WebKit

@objc(LvSyncController) public final class LvSyncController: NSObject, WKScriptMessageHandler {
  private static let messageName = "lvSync"
  private static var controllers: [ObjectIdentifier: LvSyncController] = [:]

  private weak var webView: WKWebView?
  private let remote = "https://liveview.hawk.thundersparrow.top"

  // Persistent (Application Support, NOT Caches which iOS may purge) — downloaded
  // text must survive offline. One file per normalized-URL digest.
  private lazy var contentDir: URL = {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    let dir = base.appendingPathComponent("lvcontent", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }()

  private var inFlight = Set<String>()

  @objc public static func installOnWebView(_ webView: WKWebView) {
    let key = ObjectIdentifier(webView)
    if controllers[key] != nil { return }
    let c = LvSyncController()
    c.webView = webView
    controllers[key] = c
    webView.configuration.userContentController.add(c, name: messageName)
  }

  // MARK: web → native

  public func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    guard let body = m.body as? [String: Any],
          let id = body["id"] as? String,
          let cmd = body["cmd"] as? String else { return }
    switch cmd {
    case "resolve":
      guard let url = body["url"] as? String else { reply(id, false, ""); return }
      resolve(id: id, url: url)
    case "stats":
      stats(id: id)
    case "syncAll":
      syncAll(id: id)
    default:
      reply(id, false, "")
    }
  }

  // MARK: commands

  private func resolve(id: String, url: String) {
    let key = cacheKey(url)
    if let data = cachedData(key) {
      reply(id, true, data.base64EncodedString())
      return
    }
    fetch(url) { [weak self] data in
      guard let self else { return }
      guard let data else { self.reply(id, false, ""); return }
      self.store(key, data)
      self.reply(id, true, data.base64EncodedString())
    }
  }

  private func stats(id: String) {
    manifest { [weak self] resources in
      guard let self else { return }
      var cached = 0
      var cb: Int64 = 0
      var tb: Int64 = 0
      for r in resources {
        tb += Int64(r.bytes)
        if self.cachedData(self.cacheKey(r.url)) != nil {
          cached += 1
          cb += Int64(r.bytes)
        }
      }
      self.reply(id, true, "[\(cached),\(resources.count),\(cb),\(tb)]")
    }
  }

  private func syncAll(id: String) {
    manifest { [weak self] resources in
      guard let self else { return }
      let group = DispatchGroup()
      let sem = DispatchSemaphore(value: 4) // bounded concurrency
      var done: Int64 = 0
      let lock = NSLock()
      for r in resources {
        let key = self.cacheKey(r.url)
        if self.cachedData(key) != nil { continue }
        group.enter()
        sem.wait()
        self.fetch(r.url) { data in
          if let data { self.store(key, data); lock.lock(); done += Int64(data.count); lock.unlock() }
          sem.signal()
          group.leave()
        }
      }
      group.notify(queue: .main) { self.reply(id, true, "\(done)") }
    }
  }

  // MARK: manifest

  private struct Res { let url: String; let bytes: Int }

  /// Fetch + parse the non-audio resources from /api/dag (cache the raw JSON so
  /// `stats` works offline from the last-known manifest).
  private func manifest(_ done: @escaping ([Res]) -> Void) {
    let parse: (Data) -> [Res] = { data in
      guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let arr = obj["resources"] as? [[String: Any]] else { return [] }
      return arr.compactMap { r in
        guard let url = r["url"] as? String, (r["kind"] as? String) != "audio" else { return nil }
        return Res(url: url, bytes: (r["bytes"] as? Int) ?? 0)
      }
    }
    let dagFile = contentDir.appendingPathComponent("dag.json")
    fetch("/api/dag") { [weak self] data in
      if let data { try? data.write(to: dagFile); done(parse(data)); return }
      // offline → last-known manifest
      if let self, let cached = try? Data(contentsOf: dagFile) { done(parse(cached)); return }
      done([])
    }
  }

  // MARK: cache + net

  /// FNV-1a 64-bit of the percent-DECODED url, so the web's encoded reads and the
  /// manifest's raw urls map to the SAME key.
  private func cacheKey(_ url: String) -> String {
    let canon = url.removingPercentEncoding ?? url
    var h: UInt64 = 14695981039346656037
    for b in canon.utf8 { h = (h ^ UInt64(b)) &* 1099511628211 }
    return "c" + String(h, radix: 16)
  }

  private func cachedData(_ key: String) -> Data? {
    let f = contentDir.appendingPathComponent(key)
    return try? Data(contentsOf: f)
  }

  private func store(_ key: String, _ data: Data) {
    let dest = contentDir.appendingPathComponent(key)
    let part = dest.appendingPathExtension("part")
    try? data.write(to: part, options: .atomic)
    try? FileManager.default.removeItem(at: dest)
    try? FileManager.default.moveItem(at: part, to: dest)
  }

  /// GET `path` (relative → prepend remote; absolute passes through). Returns the
  /// body Data on a 200, else nil (offline / error).
  private func fetch(_ path: String, _ done: @escaping (Data?) -> Void) {
    let full = path.hasPrefix("http") ? path : remote + path
    guard let u = URL(string: full) else { done(nil); return }
    URLSession.shared.dataTask(with: u) { data, resp, _ in
      let ok = (resp as? HTTPURLResponse)?.statusCode == 200
      done(ok ? data : nil)
    }.resume()
  }

  // MARK: native → web

  /// Resolve the web-side promise for `id`. `payload` is passed as a JS string
  /// literal (base64 / JSON / number text — all safe to single-quote-escape).
  private func reply(_ id: String, _ ok: Bool, _ payload: String) {
    let esc = payload.replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "'", with: "\\'")
    let safeId = id.replacingOccurrences(of: "'", with: "")
    let js = "window.__lvSyncResolve&&window.__lvSyncResolve('\(safeId)',\(ok),'\(esc)')"
    DispatchQueue.main.async { [weak self] in
      self?.webView?.evaluateJavaScript(js, completionHandler: nil)
    }
  }
}
