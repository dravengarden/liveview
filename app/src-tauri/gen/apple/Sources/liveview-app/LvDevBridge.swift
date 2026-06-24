// LvDevBridge — a DEBUG-ONLY headless devtools/eval channel for the native shell.
//
// THE PROBLEM IT SOLVES: an agent developing liveview needs to read the live DOM,
// computed styles, console state, and to eval JS in the running app — i.e. Web
// Inspector access — but HEADLESSLY (over SSH, no GUI). For a physical device,
// ios_webkit_debug_proxy bridges WebKit's inspector. For the iOS SIMULATOR that
// proxy does NOT work (it discovers devices over usbmuxd; the sim is not a usbmux
// device, so its page list is always empty), and Safari's Web Inspector is GUI-only.
//
// THE TECHNIQUE: since this is OUR app, expose a tiny loopback HTTP server that
// runs `webView.evaluateJavaScript` and returns the result. Works identically on
// the simulator AND a device, needs no iwdp / Chrome / Safari, and is fully
// headless. The simulator shares the Mac's loopback, so from the Mac (or hawk over
// SSH) `curl 127.0.0.1:4170/eval -d '<js>'` evaluates JS in the live app.
//
//   curl -s 127.0.0.1:4170/ping                       # → ok
//   curl -s 127.0.0.1:4170/eval -d 'location.href'    # → the URL
//   curl -s 127.0.0.1:4170/eval -d 'JSON.stringify({t:document.title})'
//
// Gated to #if DEBUG so release / device-distribution builds never open the port.
// Wired from LiveviewNativeTweaks.mm lv_wk_init (DEBUG only), same dynamic install
// as the other controllers. See tools/lvsim.sh (`lvsim eval`) and the ios-sim-dev
// skill for the agent-facing playbook.

#if DEBUG
import Foundation
import Network
import WebKit

@objc(LvDevBridge) public final class LvDevBridge: NSObject {
  private static var shared: LvDevBridge?
  // The most-recently-created webview is the one the app actually shows (Tauri makes
  // one). Weak so we never keep a dead webview alive.
  private weak var webView: WKWebView?
  private var listener: NWListener?
  private let port: UInt16 = 4170

  @objc public static func installOnWebView(_ webView: WKWebView) {
    if shared == nil { shared = LvDevBridge() }
    shared?.webView = webView
    shared?.startIfNeeded()
  }

  private func startIfNeeded() {
    guard listener == nil else { return }
    do {
      let params = NWParameters.tcp
      params.allowLocalEndpointReuse = true
      let l = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
      l.newConnectionHandler = { [weak self] conn in self?.handle(conn) }
      l.start(queue: .global(qos: .utility))
      listener = l
      NSLog("[LvDevBridge] eval server on 127.0.0.1:\(port) (DEBUG)")
    } catch {
      NSLog("[LvDevBridge] failed to start: \(error)")
    }
  }

  private func handle(_ conn: NWConnection) {
    conn.start(queue: .global(qos: .utility))
    conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) {
      [weak self] data, _, _, _ in
      guard let self, let data, let req = String(data: data, encoding: .utf8) else {
        conn.cancel(); return
      }
      // Minimal HTTP parse: "<METHOD> <path> HTTP/1.1\r\n...\r\n\r\n<body>".
      let head = req.components(separatedBy: "\r\n").first ?? ""
      let parts = head.split(separator: " ")
      let path = parts.count > 1 ? String(parts[1]) : "/"
      let body = req.range(of: "\r\n\r\n").map { String(req[$0.upperBound...]) } ?? ""

      if path.hasPrefix("/ping") {
        self.respond(conn, "ok"); return
      }
      // /offline?on=1|0 — deterministic airplane mode for the native content layer
      // (forces LvSyncController network fetches to fail) so the offline cache path
      // can be tested in the simulator. DEBUG-only (the flag only exists in DEBUG).
      if path.hasPrefix("/offline") {
        let on = path.contains("on=1")
        LvSyncController.forceOffline = on
        self.respond(conn, "offline=\(on)")
        return
      }
      // /aeval: run the body as an ASYNC function (callAsyncJavaScript) so it can
      // `await` — needed to test fetch/contentFetch (evaluateJavaScript returns the
      // unresolved Promise → "unsupported type"). Body must `return` its value.
      if path.hasPrefix("/aeval") {
        let js = body.isEmpty ? "return undefined" : body
        DispatchQueue.main.async {
          guard let wv = self.webView else { self.respond(conn, "ERR: no webview"); return }
          wv.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success(let v): self.respond(conn, Self.encode(v))
            case .failure(let e): self.respond(conn, "ERR: \(e.localizedDescription)")
            }
          }
        }
        return
      }
      if path.hasPrefix("/eval") {
        let js = body.isEmpty ? "void 0" : body
        DispatchQueue.main.async {
          guard let wv = self.webView else { self.respond(conn, "ERR: no webview"); return }
          wv.evaluateJavaScript(js) { result, error in
            if let error { self.respond(conn, "ERR: \(error.localizedDescription)") }
            else { self.respond(conn, Self.encode(result)) }
          }
        }
        return
      }
      self.respond(conn, "ERR: unknown path \(path)", status: "404 Not Found")
    }
  }

  // Encode an evaluateJavaScript result to a plain string the caller can read.
  // Primitives → their string; arrays/dicts → JSON; nil → "null". For rich objects
  // callers should `JSON.stringify(...)` in the JS (then this just passes it through).
  private static func encode(_ value: Any?) -> String {
    switch value {
    case nil: return "null"
    case let s as String: return s
    case let n as NSNumber: return n.stringValue
    default:
      if let v = value,
         JSONSerialization.isValidJSONObject(v),
         let d = try? JSONSerialization.data(withJSONObject: v),
         let s = String(data: d, encoding: .utf8) {
        return s
      }
      return String(describing: value ?? "null")
    }
  }

  private func respond(_ conn: NWConnection, _ body: String, status: String = "200 OK") {
    let payload = Data(body.utf8)
    let header = "HTTP/1.1 \(status)\r\nContent-Type: text/plain; charset=utf-8\r\n"
      + "Access-Control-Allow-Origin: *\r\nContent-Length: \(payload.count)\r\n"
      + "Connection: close\r\n\r\n"
    conn.send(content: Data(header.utf8) + payload, completion: .contentProcessed { _ in
      conn.cancel()
    })
  }
}
#endif
