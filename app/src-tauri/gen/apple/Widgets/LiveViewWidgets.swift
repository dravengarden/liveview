import SwiftUI
import WidgetKit

private let sharedSuite = "group.top.thundersparrow.liveview"

private struct WidgetBook: Decodable, Identifiable {
  let label: String
  let slug: String
  let cover: Bool
  var id: String { slug }
}

private struct WidgetProgress: Decodable {
  let path: String
  let scroll: Double
  let updated_at: Int64

  var slug: String { path.split(separator: "/").first.map(String.init) ?? "" }
}

private struct ReadingItem: Identifiable {
  let book: WidgetBook
  let progress: Double
  let coverData: Data?
  var id: String { book.slug }
}

private struct ReadingEntry: TimelineEntry {
  let date: Date
  let items: [ReadingItem]
}

private enum WidgetSource {
  static var serverURL: URL? {
    if let shared = UserDefaults(suiteName: sharedSuite)?.string(forKey: "serverURL"),
       let url = URL(string: shared), !shared.isEmpty {
      return url
    }
    guard let configured = Bundle.main.object(forInfoDictionaryKey: "LiveViewServerURL") as? String,
          !configured.isEmpty, !configured.contains("$("),
          let url = URL(string: configured) else { return nil }
    return url
  }

  static func cachedEntry() -> ReadingEntry? {
    if let defaults = UserDefaults(suiteName: sharedSuite),
       let data = defaults.data(forKey: "widgetSnapshot"),
       let cached = try? JSONDecoder().decode(CachedEntry.self, from: data) {
      let root = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: sharedSuite
      )
      return cached.entry(root: root)
    }
    guard let data = UserDefaults.standard.data(forKey: "widgetSnapshot"),
          let cached = try? JSONDecoder().decode(CachedEntry.self, from: data)
    else { return nil }
    return cached.entry(root: localRoot)
  }

  private struct CachedItem: Codable {
    let label: String
    let slug: String
    let progress: Double
    let coverFile: String?
  }

  private struct CachedEntry: Codable {
    let updatedAt: Double
    let items: [CachedItem]

    func entry(root: URL?) -> ReadingEntry {
      return ReadingEntry(
        date: Date(timeIntervalSince1970: updatedAt),
        items: items.map { item in
          let data = item.coverFile
            .flatMap { root?.appendingPathComponent($0) }
            .flatMap { try? Data(contentsOf: $0) }
          return ReadingItem(
            book: WidgetBook(label: item.label, slug: item.slug, cover: data != nil),
            progress: item.progress,
            coverData: data
          )
        }
      )
    }
  }

  private static var localRoot: URL? {
    guard let caches = FileManager.default.urls(
      for: .cachesDirectory,
      in: .userDomainMask
    ).first else { return nil }
    let root = caches.appendingPathComponent("LiveViewWidget", isDirectory: true)
    try? FileManager.default.createDirectory(
      at: root,
      withIntermediateDirectories: true
    )
    return root
  }

  static func fetchEntry() async -> ReadingEntry {
    guard let base = serverURL else {
      return cachedEntry() ?? ReadingEntry(date: Date(), items: [])
    }
    do {
      async let booksData = data(base: base, path: "/api/books")
      async let progressData = data(base: base, path: "/api/progress/recent")
      let books = try JSONDecoder().decode([WidgetBook].self, from: await booksData)
      let progress = try JSONDecoder().decode([WidgetProgress].self, from: await progressData)
      let bySlug = Dictionary(uniqueKeysWithValues: books.map { ($0.slug, $0) })
      var seen = Set<String>()
      let recent = progress
        .filter { seen.insert($0.slug).inserted }
        .prefix(4)
      var planned: [(WidgetBook, Double)] = []
      for row in recent {
        guard let book = bySlug[row.slug] else { continue }
        planned.append((book, min(1, max(0, row.scroll))))
      }
      for book in books where planned.count < 4 && !seen.contains(book.slug) {
        planned.append((book, 0))
      }
      let items = await withTaskGroup(of: (Int, ReadingItem).self) { group in
        for (index, candidate) in planned.enumerated() {
          group.addTask {
            let (book, progress) = candidate
            let cover = book.cover
              ? try? await data(base: base, path: "/api/cover?book=\(escaped(book.slug))")
              : nil
            return (index, ReadingItem(book: book, progress: progress, coverData: cover))
          }
        }
        var resolved: [(Int, ReadingItem)] = []
        for await item in group { resolved.append(item) }
        return resolved.sorted { $0.0 < $1.0 }.map(\.1)
      }
      let entry = ReadingEntry(date: Date(), items: items)
      persistLocal(entry)
      return entry
    } catch {
      return cachedEntry() ?? ReadingEntry(date: Date(), items: [])
    }
  }

  private static func data(base: URL, path: String) async throws -> Data {
    guard let url = URL(string: path, relativeTo: base) else { throw URLError(.badURL) }
    var request = URLRequest(url: url)
    request.timeoutInterval = 8
    let (data, response) = try await URLSession.shared.data(for: request)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else {
      throw URLError(.badServerResponse)
    }
    return data
  }

  private static func escaped(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
  }

  /// The extension owns a small last-good cache even without App Groups. Once a
  /// real cover has been fetched, transient network loss must not replace it
  /// with the fallback icon.
  private static func persistLocal(_ entry: ReadingEntry) {
    guard let root = localRoot else { return }
    let items = entry.items.map { item -> CachedItem in
      let name = "cover-\(safe(item.book.slug)).img"
      let stored = item.coverData.flatMap { data -> String? in
        let url = root.appendingPathComponent(name)
        return (try? data.write(to: url, options: .atomic)) != nil ? name : nil
      }
      return CachedItem(
        label: item.book.label,
        slug: item.book.slug,
        progress: item.progress,
        coverFile: stored
      )
    }
    let snapshot = CachedEntry(
      updatedAt: entry.date.timeIntervalSince1970,
      items: items
    )
    if let data = try? JSONEncoder().encode(snapshot) {
      UserDefaults.standard.set(data, forKey: "widgetSnapshot")
    }
  }

  private static func safe(_ value: String) -> String {
    String(value.map { $0.isLetter || $0.isNumber || $0 == "-" ? $0 : "-" })
  }
}

private struct ReadingProvider: TimelineProvider {
  func placeholder(in context: Context) -> ReadingEntry { sampleEntry }

  func getSnapshot(in context: Context, completion: @escaping (ReadingEntry) -> Void) {
    if context.isPreview { completion(sampleEntry); return }
    Task { completion(await WidgetSource.fetchEntry()) }
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<ReadingEntry>) -> Void) {
    Task {
      let entry = await WidgetSource.fetchEntry()
      completion(Timeline(
        entries: [entry],
        policy: .after(Date().addingTimeInterval(15 * 60))
      ))
    }
  }

  private var sampleEntry: ReadingEntry {
    ReadingEntry(date: Date(), items: [
      ReadingItem(
        book: WidgetBook(label: "LiveView", slug: "liveview", cover: false),
        progress: 0.42,
        coverData: nil
      )
    ])
  }
}

private struct CoverView: View {
  let item: ReadingItem?
  let cornerRadius: CGFloat

  var body: some View {
    ZStack {
      fallback
      if let data = item?.coverData, let image = UIImage(data: data) {
        Image(uiImage: image)
          .resizable()
          .widgetCoverRendering()
          .scaledToFit()
      }
    }
    .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    .accessibilityLabel(item?.book.label ?? "Book")
  }

  private var fallback: some View {
    ZStack {
      LinearGradient(
        colors: [Color.indigo.opacity(0.9), Color.purple.opacity(0.76)],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
      )
      Image(systemName: "book.closed.fill")
        .font(.title2)
        .foregroundStyle(.white.opacity(0.9))
    }
  }
}

private extension Image {
  @ViewBuilder
  func widgetCoverRendering() -> some View {
    if #available(iOSApplicationExtension 18.0, *) {
      self.widgetAccentedRenderingMode(.fullColor)
    } else {
      self
    }
  }
}

private struct ReadingWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: ReadingEntry

  var body: some View {
    switch family {
    case .systemMedium:
      medium
    case .accessoryRectangular:
      rectangular
    case .accessoryCircular:
      circular
    default:
      small
    }
  }

  private var current: ReadingItem? { entry.items.first }

  private var small: some View {
    ZStack(alignment: .bottomLeading) {
      CoverView(item: current, cornerRadius: 14)
        .padding(10)
      if let current {
        ProgressView(value: current.progress)
          .tint(.white)
          .padding(12)
      }
    }
    .containerBackground(.background, for: .widget)
  }

  private var medium: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Continue Reading")
        .font(.headline)
      HStack(spacing: 12) {
        ForEach(Array(entry.items.prefix(4))) { item in
          VStack(spacing: 5) {
            CoverView(item: item, cornerRadius: 7)
              .aspectRatio(2.0 / 3.0, contentMode: .fit)
            ProgressView(value: item.progress)
              .tint(.accentColor)
          }
          .frame(maxWidth: .infinity)
        }
        if entry.items.isEmpty {
          CoverView(item: nil, cornerRadius: 7)
            .aspectRatio(2.0 / 3.0, contentMode: .fit)
        }
      }
    }
    .padding(14)
    .containerBackground(.background, for: .widget)
  }

  private var rectangular: some View {
    HStack(spacing: 8) {
      CoverView(item: current, cornerRadius: 4)
        .frame(width: 35, height: 52)
      VStack(alignment: .leading, spacing: 3) {
        Text(current?.book.label ?? "LiveView")
          .font(.headline)
          .lineLimit(1)
        ProgressView(value: current?.progress ?? 0)
        Text(percent(current?.progress ?? 0))
          .font(.caption2)
      }
    }
    .containerBackground(.clear, for: .widget)
  }

  private var circular: some View {
    ZStack {
      CoverView(item: current, cornerRadius: 100)
      Circle()
        .trim(from: 0, to: current?.progress ?? 0)
        .stroke(.primary, style: StrokeStyle(lineWidth: 3, lineCap: .round))
        .rotationEffect(.degrees(-90))
    }
    .containerBackground(.clear, for: .widget)
  }

  private func percent(_ value: Double) -> String {
    "\(Int((value * 100).rounded()))%"
  }
}

struct LiveViewReadingWidget: Widget {
  let kind = "LiveViewReadingWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: ReadingProvider()) { entry in
      ReadingWidgetView(entry: entry)
    }
    .configurationDisplayName("Continue Reading")
    .description("Your recent LiveView books and reading progress.")
    .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryCircular])
  }
}

@main
struct LiveViewWidgetBundle: WidgetBundle {
  var body: some Widget {
    LiveViewReadingWidget()
  }
}
