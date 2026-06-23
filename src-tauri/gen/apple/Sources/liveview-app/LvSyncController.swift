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
//   web → native  (WKScriptMessage "lvSync"): { id, cmd, url?, wifiOnly? }
//     cmd "resolve" → cache-first bytes for `url` (fetch+cache on miss)
//     cmd "stats"   → rich JSON: net + global totals + per-book breakdown (below)
//     cmd "syncAll" → download every non-audio resource; honours `wifiOnly`
//   native → web   window.__lvSyncResolve(id, ok, payload)
//     resolve → payload = base64 of the bytes
//     stats   → payload = JSON {net,cached,total,cb,tb,books:[{s,c,t,cb,tb}]}
//     syncAll → payload = bytes-cached this run, or "busy"/"nowifi" sentinels
//
// Installed from LiveviewNativeTweaks.mm (lv_wk_init) like the other controllers.

import Foundation
import Network
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

  // Live network-path type (wifi / cell / none) so the WiFi-only download
  // preference can be honoured without the web guessing from `navigator`.
  private let monitor = NWPathMonitor()
  private let monitorQueue = DispatchQueue(label: "lvsync.netmon")
  private var currentPath: NWPath?

  // Re-entry guard: the web fires syncAll on a poll/auto loop; one in-flight run
  // is enough (it's idempotent + skips what's cached).
  private var syncing = false

  // Merkle short-circuit for `stats`. The Downloads UI polls every couple seconds;
  // re-fetching the full manifest + re-scanning 10k files each time is wasteful
  // when nothing changed. Cache the computed stats JSON keyed by the server's
  // Merkle root; a write (store) marks it dirty. Steady state = ONE /api/root hash
  // compare → cached reply, no manifest fetch, no file scan.
  private var storeDirty = true
  private var cachedStatsJSON: String?
  private var cachedStatsRoot: String?

  override init() {
    super.init()
    monitor.pathUpdateHandler = { [weak self] p in self?.currentPath = p }
    monitor.start(queue: monitorQueue)
  }

  @objc public static func installOnWebView(_ webView: WKWebView) {
    let key = ObjectIdentifier(webView)
    if controllers[key] != nil { return }
    let c = LvSyncController()
    c.webView = webView
    controllers[key] = c
    webView.configuration.userContentController.add(c, name: messageName)
  }

  /// "wifi" (incl. wired / unknown-but-online, e.g. simulator) | "cell" | "none".
  private func netType() -> String {
    guard let p = currentPath, p.status == .satisfied else { return "none" }
    if p.usesInterfaceType(.cellular) && !p.usesInterfaceType(.wifi) { return "cell" }
    return "wifi"
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
      syncAll(id: id, wifiOnly: (body["wifiOnly"] as? Bool) ?? false)
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

  /// The server's Merkle deploy root (nil offline / on error). Tiny GET — the
  /// cheap "did anything change?" probe.
  private func fetchRoot(_ done: @escaping (String?) -> Void) {
    fetch("/api/root") { data in
      done(data.flatMap {
        (try? JSONSerialization.jsonObject(with: $0) as? [String: Any])?["root"] as? String
      })
    }
  }

  /// Global totals + per-book breakdown + current net type.
  ///
  /// Merkle short-circuit: the Downloads UI polls this every ~2s. When the server
  /// root is unchanged AND nothing was written locally since the last compute, the
  /// answer is identical — return the cached JSON after a single tiny root fetch,
  /// skipping the full manifest fetch + the 10k-file rescan entirely. Only a root
  /// change or a local write (download) forces a recompute.
  private func stats(id: String) {
    fetchRoot { [weak self] serverRoot in
      guard let self else { return }
      if !self.storeDirty, let j = self.cachedStatsJSON, self.cachedStatsRoot == serverRoot {
        self.reply(id, true, j)
        return
      }
      self.manifest { resources in
        var cached = 0, cb = 0, tb = 0
        var books: [String: [Int]] = [:] // slug → [cached, total, cachedBytes, totalBytes]
        for r in resources {
          tb += r.bytes
          var e = books[r.slug] ?? [0, 0, 0, 0]
          e[1] += 1
          e[3] += r.bytes
          // Byte-weighted progress uses declared `bytes` for BOTH cached + total
          // so cb ≤ tb and % ∈ [0,100] (substituting on-disk size for 0-byte
          // units/spoken inflated cb>tb → MUI shifted the bar past 100%).
          if self.cachedSize(self.cacheKey(r.url)) != nil {
            cached += 1
            cb += r.bytes
            e[0] += 1
            e[2] += r.bytes
          }
          books[r.slug] = e
        }
        let bookArr: [[String: Any]] = books.map { (slug, e) in
          ["s": slug, "c": e[0], "t": e[1], "cb": e[2], "tb": e[3]]
        }
        let obj: [String: Any] = [
          "net": self.netType(), "cached": cached, "total": resources.count,
          "cb": cb, "tb": tb, "books": bookArr,
        ]
        let json = (try? JSONSerialization.data(withJSONObject: obj))
          .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        self.cachedStatsJSON = json
        self.cachedStatsRoot = serverRoot
        self.storeDirty = false
        self.reply(id, true, json)
      }
    }
  }

  private func syncAll(id: String, wifiOnly: Bool) {
    if syncing { reply(id, true, "busy"); return }
    if wifiOnly && netType() != "wifi" { reply(id, true, "nowifi"); return }
    syncing = true
    // A dedicated session so WiFi-only can be enforced at the transport layer:
    // with cellular disallowed, requests simply don't fire over cell.
    let cfg = URLSessionConfiguration.default
    cfg.allowsCellularAccess = !wifiOnly
    let session = URLSession(configuration: cfg)
    manifest { [weak self] resources in
      guard let self else { return }
      let group = DispatchGroup()
      let sem = DispatchSemaphore(value: 4) // bounded concurrency
      var done: Int64 = 0
      let lock = NSLock()
      for r in resources {
        let key = self.cacheKey(r.url)
        if self.cachedSize(key) != nil { continue }
        group.enter()
        sem.wait()
        self.fetch(r.url, session: session) { data in
          if let data {
            self.store(key, data)
            lock.lock(); done += Int64(data.count); lock.unlock()
          }
          sem.signal()
          group.leave()
        }
      }
      group.notify(queue: .main) {
        self.syncing = false
        self.reply(id, true, "\(done)")
      }
    }
  }

  // MARK: manifest

  private struct Res { let url: String; let bytes: Int; let slug: String }

  /// Fetch + parse the non-audio resources from /api/dag (cache the raw JSON so
  /// `stats` works offline from the last-known manifest). `slug` = the book, the
  /// first path segment ("<slug>/<rendition>/<lang>/<rel_path>").
  private func manifest(_ done: @escaping ([Res]) -> Void) {
    let parse: (Data) -> [Res] = { data in
      guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let arr = obj["resources"] as? [[String: Any]] else { return [] }
      return arr.compactMap { r in
        guard let url = r["url"] as? String, (r["kind"] as? String) != "audio" else { return nil }
        let path = (r["path"] as? String) ?? ""
        let slug = path.split(separator: "/").first.map(String.init) ?? "?"
        return Res(url: url, bytes: (r["bytes"] as? Int) ?? 0, slug: slug)
      }
    }
    let dagFile = contentDir.appendingPathComponent("dag.json")
    // Merkle short-circuit: if the server root matches our cached manifest's root,
    // the tree is unchanged → reuse the cached dag.json, skip the full fetch.
    fetchRoot { [weak self] serverRoot in
      guard let self else { done([]); return }
      if let serverRoot,
         let cached = try? Data(contentsOf: dagFile),
         let obj = try? JSONSerialization.jsonObject(with: cached) as? [String: Any],
         (obj["root"] as? String) == serverRoot {
        done(parse(cached))
        return
      }
      self.fetch("/api/dag") { data in
        if let data { try? data.write(to: dagFile); done(parse(data)); return }
        // offline → last-known manifest
        if let cached = try? Data(contentsOf: dagFile) { done(parse(cached)); return }
        done([])
      }
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
    try? Data(contentsOf: contentDir.appendingPathComponent(key))
  }

  /// Byte size if cached, else nil — existence/size without loading the blob.
  private func cachedSize(_ key: String) -> Int? {
    let f = contentDir.appendingPathComponent(key)
    guard let a = try? FileManager.default.attributesOfItem(atPath: f.path) else { return nil }
    return (a[.size] as? Int) ?? 0
  }

  private func store(_ key: String, _ data: Data) {
    let dest = contentDir.appendingPathComponent(key)
    let part = dest.appendingPathExtension("part")
    try? data.write(to: part, options: .atomic)
    try? FileManager.default.removeItem(at: dest)
    try? FileManager.default.moveItem(at: part, to: dest)
    storeDirty = true // invalidate the stats short-circuit — disk changed
  }

  /// GET `path` (relative → prepend remote; absolute passes through). Returns the
  /// body Data on a 200, else nil (offline / error).
  private func fetch(_ path: String, session: URLSession = .shared,
                     _ done: @escaping (Data?) -> Void) {
    let full = path.hasPrefix("http") ? path : remote + path
    guard let u = URL(string: full) else { done(nil); return }
    session.dataTask(with: u) { data, resp, _ in
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
