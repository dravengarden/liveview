# Directory browsing and discovery

The library answers three questions: where is the content, what is in this
folder, and how do I return to my place? A directory is the primary navigation
unit. Opening one shows its contents; opening a title enters the reader.

Directories belong to the user and support arbitrary nesting. Each has a stable
ID, name and parent; placements reference content slugs independently of authored
metadata. Existing collections are imported once into root directories. Later
content syncs never rebuild or overwrite organization; new content is unfiled at
the root. Directory rename/move keeps content URLs and progress intact. Root and
subdirectory views show their immediate children, with a breadcrumb and parent
back action. The wide sidebar presents the hierarchy in sibling name order.

Multiple Continue entries combine ongoing reading, listening and document use.
Four entries are initially visible, with a control to show all. Text and audio
retain separate progress: finishing one mode never hides an unfinished other
mode. A Continue title tap resumes its latest unfinished mode; explicit read and
listen controls remain available. Document collections show the last document
position without treating the collection as a book that must be completed.

The Organize action opens a responsive sheet/dialog for creating subdirectories,
renaming/moving the current directory, and selecting content to move in bulk.
Deletion returns the directory's content to the root and reparents its children;
it never deletes content. An undo action restores the previous organization.
The undo entry is cleared when an external edit advances the revision.
These writes require connectivity and a server acknowledgement. The last
acknowledged tree remains available through the IDB metadata cache offline.

The UI and CLI share `/api/library`. Each atomic plan includes its expected
revision; stale plans receive HTTP 409, refresh and require a deliberate retry.
Dry runs return the proposed snapshot without persisting it. PostgreSQL stores
organization and change history outside the deployed content tables.
See [the directory CLI](library-cli.md) for AI organization examples.

## Navigation and search

- iPhone: one column, folder drill-down, visible location, and bottom search,
  back, filter, and settings controls. Search expands while typing and respects
  native IME composition.
- iPad windows at least 700 px wide: a persistent folder sidebar and a content
  pane. Below 1000 px, common controls remain at the bottom. Narrow multitasking
  windows return to the single-column layout.
- Desktop: the same folder sidebar with search above the content pane. Results
  gain columns as space permits; controls retain their touch target sizes.

Search is global and explicitly labeled as such. Folder names and their full
paths are searchable, with matching folders shown above content results. Title
results show their current user directory and author, and support the existing title, tag, description, and
slug matching. Matching tolerates typos, ranks results by a fixed tie-breaking
order, and highlights why each result matched; see
[library search](design/library-search.md). Clearing search restores the selected directory and its scroll
position. Filters narrow the current directory when not searching; at the root
they search the whole library. Facet counts use the same scope as results.
Returning from a book preserves the mounted directory, filters, pagination,
and scroll position.

The content list and directory list each initially expose up to 40 items, with
an explicit load-more control. Title rows mount in batches of 16 across animation
frames, restoring deep saved positions after the retained page exists. Plain title rows avoid artwork decoding during
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
