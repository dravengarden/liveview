// VENDORED from shared-utils/packages/native-nav/ios/SnapshotNavController.swift
// (canonical source of truth is @shared-utils/native-nav; re-sync from there on change)

// SnapshotNavController — the native (iOS) half of @shared-utils/native-nav.
//
// THE PROBLEM IT SOLVES: in a single-WKWebView SPA shell (Tauri), returning from a
// detail view to a list froze ~480ms on real iOS devices. WebKit re-composites the
// whole view in one frame on the swipe-back; the main thread is idle (mc<<paint),
// the compositor stalls. No web-side change fixed it.
//
// THE TECHNIQUE (borrowed from Hotwire Native, not the framework): wrap the web
// transition in a NATIVE one over the single webview.
//   • PUSH (list → detail): snapshot the current LIST pixels and push them on a
//     stack, then slide the webview (now rendering the detail) in from the trailing
//     edge over the easing-out list snapshot.
//   • POP (detail → list): snapshot the current DETAIL pixels as a cover; reveal the
//     LIST snapshot from the stack immediately (the destination appears instantly,
//     no freeze) by sliding the detail cover off; the webview re-renders the live
//     list UNDERNEATH; when the web posts `ready`, swap the list snapshot out for the
//     now-painted live webview — seamless, identical pixels. The ~480ms re-composite
//     happens entirely behind snapshots and is never seen.
//
// Concurrency: deliberately classic main-thread UIKit. WKScriptMessageHandler
// callbacks arrive on the main thread, and this class is reached from ObjC (the
// shell's WKWebView-init hook), so a plain @objc NSObject keeps interop trivial and
// is iOS-14 safe.
//
// Wiring (per app, in the iOS Tauri shell): on WKWebView creation call
//   [SnapshotNavController installOnWebView:webView];   // ObjC
// It registers the "lvNativeNav" script-message handler and overlays a transition
// container on the webview. The web half (native-nav.ts) posts
// { type:"push"|"pop"|"ready" }; off the native shell there is no handler so the
// PWA / Android / browser keep their existing web navigation untouched.
//
// STATUS: stack push/pop with destination-snapshot reveal + hold-until-ready are
// implemented. The interactive edge-pan (drag-to-go-back, interruptible) and timing
// tuning are validated on a real device in M2 — the simulator's Mac GPU does not
// reproduce the freeze, so the fix can only be confirmed on device.

import UIKit
import WebKit

@objc(SnapshotNavController) public final class SnapshotNavController: NSObject, WKScriptMessageHandler {
  private static var controllers: [ObjectIdentifier: SnapshotNavController] = [:]
  private static let messageName = "lvNativeNav"
  /// Reveal a held pop anyway if `ready` never arrives, so a web error can't strand
  /// the user behind a snapshot.
  private static let readyTimeout: TimeInterval = 1.2
  private static let slide: TimeInterval = 0.33

  private weak var webView: WKWebView?
  /// Snapshots of LIST views we pushed away from, newest last — the destination of
  /// the matching pop.
  private var stack: [UIView] = []
  /// While a pop is mid-flight: the list snapshot now showing live underneath, to be
  /// removed on `ready`.
  private var pendingListSnap: UIView?
  private var pendingPop = false

  /// A clear, full-screen container above the webview that hosts transition layers.
  private let overlay = UIView()

  // MARK: Install

  @objc public static func installOnWebView(_ webView: WKWebView) {
    let key = ObjectIdentifier(webView)
    if controllers[key] != nil { return }
    let c = SnapshotNavController(webView: webView)
    controllers[key] = c
    webView.configuration.userContentController.add(c, name: messageName)
  }

  private init(webView: WKWebView) {
    self.webView = webView
    super.init()
    overlay.isUserInteractionEnabled = false
    overlay.translatesAutoresizingMaskIntoConstraints = false
  }

  // MARK: Message handling (main thread)

  public func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    guard let body = m.body as? [String: Any], let type = body["type"] as? String else { return }
    switch type {
    case "push": handlePush()
    case "pop": handlePop()
    case "ready": handleReady()
    default: break
    }
  }

  // MARK: Overlay / snapshot helpers

  private func ensureOverlay() {
    guard let webView, let host = webView.superview else { return }
    if overlay.superview === host {
      host.bringSubviewToFront(overlay)
      return
    }
    overlay.removeFromSuperview()
    host.addSubview(overlay)
    NSLayoutConstraint.activate([
      overlay.leadingAnchor.constraint(equalTo: webView.leadingAnchor),
      overlay.trailingAnchor.constraint(equalTo: webView.trailingAnchor),
      overlay.topAnchor.constraint(equalTo: webView.topAnchor),
      overlay.bottomAnchor.constraint(equalTo: webView.bottomAnchor),
    ])
    host.layoutIfNeeded()
  }

  /// Current webview pixels, captured synchronously and cheaply (no screen update).
  private func snapshotOfWeb() -> UIView? { webView?.snapshotView(afterScreenUpdates: false) }

  // MARK: PUSH (list → detail)

  private func handlePush() {
    // Entering a detail never froze, so push just CAPTURES the current list as the
    // destination for the future pop — no animation; the web's own route change
    // shows the detail. Called before the SPA changes route, so the snapshot is the
    // list as the user left it.
    ensureOverlay()
    guard overlay.bounds.width > 0, let listSnap = snapshotOfWeb() else { return }
    stack.append(listSnap)
    // Bound the stack — a runaway (deep chapter chains) shouldn't leak snapshots.
    if stack.count > 8 { stack.removeFirst(stack.count - 8) }
  }

  // MARK: POP (detail → list)

  private func handlePop() {
    ensureOverlay()
    let w = overlay.bounds.width
    guard w > 0, let detailCover = snapshotOfWeb() else { return }
    overlay.isUserInteractionEnabled = true

    // Destination shown immediately: the list snapshot from the stack, full screen,
    // BELOW the detail cover. If the stack is empty (deep-linked straight into a
    // detail), fall back to holding the detail cover until `ready`.
    let listSnap = stack.popLast()
    if let listSnap {
      listSnap.frame = overlay.bounds
      listSnap.transform = .identity
      overlay.addSubview(listSnap)
      pendingListSnap = listSnap
    }
    detailCover.frame = overlay.bounds
    overlay.addSubview(detailCover)
    pendingPop = true

    // Slide the detail cover off → reveals the list snapshot beneath (or the live
    // webview if no snapshot). The live list re-renders underneath the overlay.
    let a = UIViewPropertyAnimator(duration: Self.slide, dampingRatio: 1) {
      detailCover.transform = CGAffineTransform(translationX: w, y: 0)
    }
    a.addCompletion { detailCover.removeFromSuperview() }
    a.startAnimation()

    DispatchQueue.main.asyncAfter(deadline: .now() + Self.readyTimeout) { [weak self] in
      guard let self, self.pendingPop else { return }
      self.finishPop()
    }
  }

  /// Web finished painting the destination list — swap the held snapshot for the now
  /// painted live webview.
  private func handleReady() {
    guard pendingPop else { return }
    finishPop()
  }

  private func finishPop() {
    pendingPop = false
    // Cross-fade the list snapshot out so the swap to the (identical) live webview is
    // invisible even if a pixel differs.
    guard let snap = pendingListSnap else {
      overlay.isUserInteractionEnabled = false
      return
    }
    pendingListSnap = nil
    let a = UIViewPropertyAnimator(duration: 0.12, dampingRatio: 1) { snap.alpha = 0 }
    a.addCompletion { [weak self] _ in
      snap.removeFromSuperview()
      self?.overlay.isUserInteractionEnabled = false
    }
    a.startAnimation()
  }
}
