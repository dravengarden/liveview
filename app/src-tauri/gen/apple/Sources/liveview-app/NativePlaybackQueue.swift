import Foundation

/// Generic transport queue. The web resolves voices/URLs; native only retains
/// opaque track descriptors so advancing never needs a running WKWebView.
struct NativePlaybackQueue {
  static let batchLimit = 16
  private(set) var id: String?
  private(set) var index = -1
  private(set) var count = 0
  private var tracks: [Int: [String: Any]] = [:]
  private var completed: [[String: Any]] = []
  private var completedHead = 0
  private var completionSerial = 0

  var current: [String: Any]? { tracks[index] }
  var readyCount: Int { tracks.count }
  var completions: [[String: Any]] {
    Array(completed.dropFirst(completedHead).prefix(Self.batchLimit))
  }

  mutating func reset(_ track: [String: Any]? = nil) {
    self = NativePlaybackQueue()
    guard let track, let queue = track["queue"] as? [String: Any],
          let id = queue["id"] as? String, !id.isEmpty, id.utf8.count <= 128,
          let index = queue["index"] as? Int,
          let count = queue["count"] as? Int,
          count > 0, count <= 100_000, index >= 0, index < count,
          Self.valid(track) else { return }
    self.id = id
    self.index = index
    self.count = count
    tracks[index] = track
  }

  @discardableResult
  mutating func append(id: String, start: Int, items: [Any]) -> Bool {
    guard self.id == id, start >= 0, items.count <= Self.batchLimit,
          start <= count, items.count <= count - start else { return false }
    // Preserve holes: a voice which is not ready must not silently become a
    // different voice, nor shift all subsequent chapter indexes.
    for (offset, raw) in items.enumerated() {
      let at = start + offset
      guard at != index else { continue }
      if var track = raw as? [String: Any], Self.valid(track) {
        if let old = tracks[at], old["url"] as? String == track["url"] as? String {
          track["position"] = old["position"]
        }
        tracks[at] = track
      } else {
        tracks.removeValue(forKey: at)
      }
    }
    return true
  }

  mutating func select(_ at: Int) -> [String: Any]? {
    guard let track = tracks[at] else { return nil }
    index = at
    return track
  }

  mutating func finishCurrent() {
    guard let context = current?["context"] as? String else { return }
    completionSerial += 1
    completed.append(["serial": completionSerial, "context": context])
    // Replaying a completed item starts from the beginning.
    tracks[index]?["position"] = 0.0
  }

  mutating func rememberPosition(_ position: Double) {
    guard position.isFinite, position >= 0 else { return }
    tracks[index]?["position"] = position
  }

  mutating func acknowledge(id: String, through: Int) {
    guard self.id == id,
          completions.contains(where: { $0["serial"] as? Int == through }) else { return }
    while completedHead < completed.count,
          let serial = completed[completedHead]["serial"] as? Int, serial <= through {
      completedHead += 1
    }
    if completedHead == completed.count {
      completed.removeAll(keepingCapacity: true)
      completedHead = 0
    } else if completedHead >= 128 {
      completed.removeFirst(completedHead)
      completedHead = 0
    }
  }

  private static func valid(_ track: [String: Any]) -> Bool {
    guard let raw = track["url"] as? String, raw.utf8.count <= 8192,
          let url = URL(string: raw), ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
          url.host != nil,
          let context = track["context"] as? String, context.utf8.count <= 8192,
          let position = track["position"] as? Double, position.isFinite, position >= 0
    else { return false }
    return true
  }
}

/// Counts real listening time, independent of speed and web timers. A pause,
/// buffering gap, seek, or chapter replacement never consumes the allowance.
struct NativeSleepTimer {
  private(set) var remaining: Double = 0
  private var lastTick: Double?

  mutating func set(_ seconds: Double) {
    remaining = seconds.isFinite ? max(0, seconds) : 0
    lastTick = nil
  }

  @discardableResult
  mutating func tick(now: Double, playing: Bool) -> Bool {
    defer { lastTick = playing && remaining > 0 ? now : nil }
    guard remaining > 0 else { return false }
    if let lastTick { remaining = max(0, remaining - max(0, now - lastTick)) }
    return remaining == 0
  }
}
