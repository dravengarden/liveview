# LiveView core requirements

These requirements define product invariants. A feature is incomplete when it
works functionally but violates one of them.

## Reading must stay fluid

LiveView is a reader first. Scrolling, opening contents, changing chapters,
presenting sheets, and using playback controls must remain responsive while
sync, audio download, image loading, progress persistence, and reconnection are
active. Background capability must never borrow unbounded work from an
interaction frame.

This is a cross-layer requirement for the web reader, WKWebView bridge, native
shell, sync engine, and storage code. Moving expensive work from JavaScript into
Swift or Rust does not satisfy it if that work still blocks the main runloop,
creates rendering contention, or sends an unbounded payload back through the
bridge.

### Architecture constraints

- Keep the UI/main thread for interaction and presentation. File enumeration,
  hashing, manifest diffing, database maintenance, image processing, and bulk
  download accounting run on bounded background queues.
- All corpus-sized work must be incremental and bounded. Use O(1) or amortized
  O(1) queue operations, compact summaries, pagination, and fixed-size batches.
  Never create one native task, React update, or bridge object per corpus item in
  a single interaction turn.
- Bound concurrency explicitly. A system scheduler is not a substitute for an
  application-level in-flight limit. Background work uses utility QoS; only the
  chapter the user requests may use interactive/foreground priority.
- Keep bridge messages constant-size during normal operation. Exchange roots,
  counts, cursors, and content hashes; resolve large manifests and blobs in their
  owning layer. Do not periodically serialize full cache indexes or resource
  arrays through WKWebView.
- Coalesce progress, network, playback, and sync updates. Do not poll or enqueue
  unchanged React state on display frames.
- Scrolling surfaces and overlapping fixed chrome must not use live blur,
  `backdrop-filter`, CSS `filter`, or blend modes. See
  [the design system](design-system.md#motion-and-performance).
- Preserve these constraints with focused tests whenever a regression can be
  detected mechanically.

### Performance acceptance gate

Changes touching rendering, navigation, sheets, native bridges, downloads,
offline sync, playback, images, or persistence must be exercised in the actual
iOS Simulator WKWebView with a production-sized library. Browser-only testing is
not sufficient.

For each affected interaction:

1. Record at least 600 animation frames while continuously scrolling or exercise
   the full transition repeatedly.
2. Run the relevant background activity at the same time, including audio
   downloads or sync when the change can interact with them.
3. Require no avoidable frame gap above 50 ms and no periodic long-frame pattern.
   Investigate any p99 regression above the 60 Hz frame budget rather than
   averaging it away.
4. Check both iPhone and iPad layouts. For native scheduling or lifecycle changes,
   also smoke-test a physical device before release.

If the gate fails, the feature is not ready. Reducing visual quality is not the
default fix: first remove main-thread work, unbounded fan-out, bridge volume, and
unnecessary compositing.

## Offline content is verifiable

Text, audio, covers, backdrops, and document assets are content-addressed Merkle
DAG resources. The TypeScript replica (native host + PWA) must be able to
verify, synchronize, retain, garbage-collect, and serve them offline without a
URL-keyed side cache becoming an alternate source of truth.

## Reading and listening survive lifecycle changes

The native shell owns background audio, lock-screen controls, and durable local
state. A browser lifecycle must not be treated as equivalent to iOS native
lifecycle guarantees. Each device owns live playback state; cross-device state
is a resume hint.

## Content remains portable and inspectable

Authored books use documented, renderer-checked formats. The checker and reader
must agree on accepted content, and protocol evolution remains backward
compatible unless the protocol version is deliberately changed.

## A production library remains discoverable

Collection is editorial series structure, not the only navigation model. Every
published book or registered documentation set declares useful lowercase
keywords in its manifest. Search covers title, tags, collection, author,
description, and slug. Faceted filtering is derived from the tags present in the
current catalog, with OR semantics inside one facet and AND semantics across
facets.

Manifest keywords remain open vocabulary so a book can retain precise concepts
such as protocols, libraries, and techniques. A `facet.value` tag explicitly
opts into a named facet; an unnamespaced tag appears in the generic Tags facet.
LiveView ships no subject vocabulary, alias mapping, classification inferred
from collection names, or preferred collection ordering. Manifest-tag changes
are catalog metadata changes and therefore advance the deploy Merkle root so
native offline clients cannot keep a stale bookshelf index.

During active search or filtering, matching series expand in an ephemeral view.
Clearing discovery restores the reader's persisted series-collapse choices.
Core Spotlight indexing is intentionally outside this requirement.
