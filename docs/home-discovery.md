# Directory browsing and discovery

The library answers three questions: where is the content, what is in this
folder, and how do I return to my place? A directory is the primary navigation
unit. Opening one shows its contents; opening a title enters the reader.

The root lists every authored collection as a folder with its full title count
and a preview of three titles. Books without a collection appear directly at
the root. Collection names are opaque, locale-sorted metadata: punctuation
does not introduce inferred subfolders, and no preferred subject order is
built into the app. Counts are computed before pagination, so a folder cannot
disappear because its books sort below the first page of content.

One compact resume link appears above the folders when unfinished reading or
listening exists. It follows the most recently used rendition. There is no
separate dashboard or duplicate set of catalog tabs.

## Navigation and search

- iPhone: one column, folder drill-down, visible location, and bottom search,
  back, filter, and settings controls. Search expands while typing and respects
  native IME composition.
- iPad windows at least 700 px wide: a persistent folder sidebar and a content
  pane. Below 1000 px, common controls remain at the bottom. Narrow multitasking
  windows return to the single-column layout.
- Desktop: the same folder sidebar with search above the content pane. Results
  gain columns as space permits; controls retain their touch target sizes.

Search is global and explicitly labeled as such. Results include their authored
collection and author, and support the existing title, tag, description, and
slug matching. Clearing search restores the selected directory and its scroll
position. Filters narrow the current directory when not searching; at the root
they search the whole library. Facet counts use the same scope as results.
Returning from a book preserves the mounted directory, filters, pagination,
and scroll position.

The content list and directory list each initially expose up to 40 items, with
an explicit load-more control. Plain title rows avoid artwork decoding during
browsing. Chrome and scrolling surfaces use solid materials. The web bundle
uses the existing native interface and is distributed through reader OTA.

## Design references

[Apple Files](https://support.apple.com/en-za/guide/iphone/iphe4bff8827/ios)
provides a familiar browse-and-open folder model. The
[split-view guidance](https://developer.apple.com/design/human-interface-guidelines/split-views)
describes adjacent navigation and content panes that adapt to available window
width. These inform the interaction model; bottom controls and compact folder
previews are choices made for LiveView's reading workflow.

The release gate is the repository verification suite plus actual iPhone and
iPad Simulator WKWebView navigation, light/dark, and 600-frame scroll captures
with concurrent audio transfers. A wide WKWebView viewport is responsive-layout
evidence, not a substitute for a native desktop browser test.
