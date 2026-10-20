import Foundation

@main
struct NativePlaybackTests {
  static func main() {
    func track(_ i: Int) -> [String: Any] {
      ["url": "https://example.test/\(i).caf", "position": 0.0, "context": "track-\(i)"]
    }
    var first = track(0)
    first["queue"] = ["id": "one", "index": 0, "count": 40]
    var queue = NativePlaybackQueue()
    queue.reset(first)
    assert(queue.id == "one" && queue.index == 0)
    assert(!queue.append(id: "old", start: 1, items: [track(1)]))
    assert(!queue.append(id: "one", start: 1, items: (1...17).map(track)))
    assert(queue.append(id: "one", start: 1, items: [track(1), NSNull(), track(3)]))
    assert(queue.select(2) == nil && queue.index == 0)
    assert(queue.select(1)?["context"] as? String == "track-1")
    queue.rememberPosition(9)
    assert(queue.select(3) != nil)
    assert(queue.append(id: "one", start: 1, items: [track(1)]))
    assert(queue.select(1)?["position"] as? Double == 9)
    queue.finishCurrent()
    assert(queue.current?["position"] as? Double == 0)
    assert(queue.completions.count == 1)
    queue.acknowledge(id: "old", through: 1)
    assert(queue.completions.count == 1)
    queue.acknowledge(id: "one", through: 1)
    assert(queue.completions.isEmpty)
    for start in stride(from: 0, to: 40, by: NativePlaybackQueue.batchLimit) {
      assert(queue.append(id: "one", start: start, items: (start..<min(start + 16, 40)).map(track)))
    }
    for i in 0..<40 {
      assert(queue.select(i) != nil)
      queue.finishCurrent()
    }
    assert(queue.select(40) == nil && queue.index == 39)
    assert(queue.completions.count == 16)
    queue.acknowledge(id: "one", through: 9999)
    assert(queue.completions.count == 16)
    while let through = queue.completions.last?["serial"] as? Int {
      queue.acknowledge(id: "one", through: through)
    }
    assert(queue.completions.isEmpty)
    queue.reset()
    assert(queue.id == nil && queue.select(0) == nil)
    assert(!queue.append(id: "one", start: 0, items: [first]))

    var timer = NativeSleepTimer()
    timer.set(5)
    assert(!timer.tick(now: 0, playing: true))
    assert(!timer.tick(now: 2, playing: false))
    assert(timer.remaining == 3)
    assert(!timer.tick(now: 200, playing: true))
    assert(timer.remaining == 3, "pause does not consume listening time")
    assert(!timer.tick(now: 202, playing: false))
    assert(timer.remaining == 1)
    assert(!timer.tick(now: 300, playing: true))
    assert(timer.tick(now: 301, playing: true))
    assert(!timer.tick(now: 302, playing: true), "expiry fires once")
    timer.set(.infinity)
    assert(timer.remaining == 0)
    print("Native playback queue and sleep timer tests passed")
  }
}
