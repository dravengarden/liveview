# Structural refactor plan

Status: proposal (2026-11-05), revised after the Astra Max design review
(call `call-bfbaa45b5dd906ca87525321`); its 19 findings are folded into the
sections they concern. Scope: the web reader
(`web/src`), the shared shell primitives (`web/src/_shell`), and the server
(`src/`). The native shell (`app/`) is out of scope except where the web side
stops depending on it incorrectly.

## 1. Verdict

The repository is not uniformly rotten, but its two most-edited files have
become accretion points where every fix was layered on the previous one:

| File | Lines | Commits | Symptom |
|---|---|---|---|
| `web/src/App.tsx` | 1968 | 183 | 20+ state slots, 4 state-mirroring refs, 6 overlapping navigation flows, 14 effects, 492 comment lines |
| `web/src/components/Landing.tsx` | 1627 | 91 | 13 state slots, 19 memos; browsing, search, facets, paging, scroll restore, keyboard inset and two sheets in one component |
| `web/src/audio/player.tsx` | 2121 | 58 | 29 refs; two playback engines (web `<audio>`, native AVPlayer) interleaved in one provider |
| `src/main.rs` | 2871 | 99 | CLI runners, bootstrap, router, 1,400 lines of handlers, and 309 lines of tests in one file |
| `src/config.rs` | 1820 | 19 | ~60% corpus discovery and filesystem I/O, not configuration |

The rest of the tree is in reasonable shape: `_shell/` (sheets, navigation,
spatial drawer), `replica/`, `audio/*` helpers, and the `library*` modules are
cohesive and tested. The current gate is green (`tsc`, `oxlint`, 216 web tests,
270 Rust tests), so the refactor can proceed in small verified steps.

## 2. Evidence

### 2.1 Reader state (`App.tsx`)

- The reading location is spread over `currentPath`, `lang`, `rendition`,
  `tree`, `audioTree`, `activeBook`, the URL hash, the `lv-resume` slot, the
  server-side `bookPrefs`, and the native navigation snapshot. Six flows each
  rebuild part of that state: `enterBook`, `openAudiobook`, `openFile`,
  `loadFile`, `restoreFromHash`, `backToLanding`, plus the engine→view effect.
- The same derivations repeat: `path.split("/")[0]` 12 times, `books.find`
  7 times, "pick the edition language for a rendition" in 4 places
  (`pickInitialLang`, `langForHashEntry`, two `prefLang` blocks), the
  "pin lang, omit default rendition" hash rule in 3 places.
- `currentPathRef`, `renditionRef`, `nowPlayingRef`, `openFileRef`,
  `syncedChapterRef` and `fileLoadSeq` exist only to let effects and callbacks
  read state without declaring dependencies. The comments on the view↔engine
  effects describe a feedback loop ("the two leapfrog forever … the tab
  freezes") that the refs suppress rather than remove.
- `tree` holds whichever spine was loaded last; `renditionRef` records which
  one; `handleTreeUpdate` and `backToLanding` guard against clobbering it;
  `audioTree` exists because the shelf meter needs the audio spine while
  `tree` holds the text spine. This is one mutable slot serving two needs
  (per-book spine for the reader, both forests for the shelf).
- There are no tests for any of this. The riskiest code in the web app has no
  safety net beyond the type checker.

### 2.2 Shell geometry

Bottom chrome is composed by five CSS custom properties that components
publish on `documentElement` and read back in `calc()` chains:

- `--shell-bar-h` (NavShell), `--lv-transport-h` (PlaybackBar),
  `--lv-syncbar-h` (SyncIndicator), `--lv-toolbar-h` (Landing),
  `--lv-kb-inset` (Landing).
- Ten files consume them. `MarkdownViewer`, `AudiobookPlayer`, `Landing`,
  `ScrollToTopButton`, `ReconnectBanner` and `SyncIndicator` each assemble
  their own sum, with slightly different terms.
- `PlaybackBar` paints a "slab" that spans itself and the nav bar, and
  `NavShell` has a `barTransparent` prop so the bar can sit on that slab.
  `SyncIndicator` is mounted twice (shelf root and inside NavShell) with
  different offset formulas.

There is no single owner of "the bottom of the screen".

### 2.3 Hidden coupling

- Custom `window` events used as a message bus: `lv-open-playback-controls`
  (3 emitters → `PlaybackSheet`), `lv-download-policy` (5 emitters → 4
  listeners), `lv-voice-preference`, `lv-audio-cache-wake`.
- `i18n.tsx` is one 741-line file with both locales inline. 19 keys have no
  caller (`group.*`, `landing.browseAll`, `landing.home*`, `landing.series`,
  `landing.recent`, `landing.history`, `landing.results`, `landing.seeAll`,
  `landing.resumeEmpty`, `landing.search`, `landing.filtersN`,
  `landing.group`, `landing.otherGroup`, `landing.collapseAllSeries`,
  `landing.expandAllSeries`, `settings.group`). Nothing checks the two
  locales against each other.
- Comment style: comments narrate the bug that motivated a line ("the v181
  mistake", "断网点不开", "11% looks wrong") instead of the invariant the
  line maintains. `App.tsx` is 25% comment lines. This is a maintenance cost:
  readers cannot tell which comments are still true.

### 2.4 Data and sync layer

The replica (`replica/`) and the mirrored stores (`_sync/mirrored.ts`) are
sound and tested, but the layer around them has accumulated dead paths and
inverted dependencies:

- `replicaFlag()` always returns `"idb"` (`replica/policy.ts:27-31`), so the
  branches in `replica/mod.ts:191`, `main.tsx:60`, `native-sync.ts:45,55` and
  most of `prefetch.ts` (≈130 of 193 lines) are unreachable. `App.tsx` still
  calls `prefetchAllBooks`, `prefetchBookText` and `prefetchBookAudio` with
  comments describing behaviour they no longer have.
- `_sync/` is a vendored engine of which only `mirroredStore` is used; the
  operation-based tier (`createClient`, `createArbiter`, `replicatedStore`,
  ≈590 lines) has no caller and no test. `_sync-idb/` opens a second
  IndexedDB database for one value (`sessionStore`).
- Upward imports: `connectionStore.ts` imports the whole `@/_shell` barrel
  (MUI + react-dom) to create a store; `replica/policy.ts` imports
  `audio/preload.ts` to fill a field nothing reads; the PWA audio worker's
  import chain reaches window-only code (`media-bridge.ts`). One runtime
  cycle: `replica/blobs ↔ gc ↔ media-bridge`.
- Connectivity is tracked in seven places (`serverReachability`, `liveSocket`,
  `pwa.ts`, `native-sync.ts`, `apm.ts`, `replica/resolve.ts`, the banner
  store); shell detection is written inline six times while
  `platform/target.ts` has no importer.
- Settings are written three different ways (`mirroredStore`, a hand-rolled
  `sleepPreference`, imperative `putServerSetting` + localStorage + event).
- Debug globals (`__lvReplica*`, `replica/spike.ts`) and the 738-line
  in-memory IDB test fixture ship in the production directory.
- Eight test files assert on source text with regular expressions
  (`scrollMaterials`, `nativeAudioRecovery`, `readAlongRecovery`,
  `native-host`, `otaUpdater`, `pwa`, `replica`, `codeTheme`). These break on
  behaviour-preserving moves; the plan treats them as part of each phase's
  work. Tests are split between `bun:test` (8 files) and `node:test` (29).

### 2.5 Server (`src/`)

From a read-only audit of all 54 files:

- `main.rs` holds the router (`1559-1699`), 1,400 lines of handlers and DTOs,
  the CLI runners (`run_sync`, `run_tasks`, `run_dir`, …), environment
  parsing, the Postgres LISTEN loop, two `AppState` constructions, and a test
  module named `apm_tests` whose 15 tests mostly cover other things.
  `audio_http.rs`, `contents_http.rs`, `speech_http.rs` and `http_tests.rs`
  are crate-root children that start with `use super::*;` so they can reach
  private items in `main.rs`.
- Duplicates: the 5-argument `get_chapter_fallback` call 6 times; content
  addressed blob writes 4 times; the synthesis pipeline 4 times; the "legacy
  voice" fallback 5 times; the book→rendition→edition model 4 times
  (`config::*State`, `store::model`, `server::catalog::*Meta`,
  `main::BookInfo`); four directory walkers; rendition parsing by raw string
  comparison in 9 places; `resolve_cover`/`resolve_backdrop` identical.
- Cycles: `server ↔ sync`, `store → server`, `store → sync` (the S3 blob
  store lives in `sync/objstore.rs`), `check → server/sync/cli`.
- Dead or stale: `#[allow(dead_code)]` on all of `store/` and `sync/` with
  stale justifications ("until Phase F"), hiding `PgStore::get_chapter_fallback`
  and three test-only functions; `Resolved.{debounce_ms,port,open}` never
  read; `WsMessage::ContentUpdate` never sent; book-level `langs`/`default_lang`
  in `/api/books` read by nobody; comments contradicting the code in
  `server/audio.rs`, `sync/run.rs`, `server/state.rs`, `cli.rs`, `check/mod.rs`.
- Error handling by string matching (`starts_with("Revision conflict")`), store
  errors as `String`, and the same failure mapped to 500 in one handler and
  503 in the next.
- Tests: `http_tests.rs` duplicates `apm_tests` (fixture, CORS, APM auth);
  19 database tests pass silently when `DATABASE_URL` is unset; `TempDir` is
  hand-rolled twice although `tempfile` is a dependency.

### 2.6 What stays as it is

- `_shell/detent-sheet.tsx`, `bottom-sheet.tsx`, `spatial-drawer*.ts`,
  `haptic*`, `image-lightbox*`: cohesive, documented, keep.
- `replica/*`, `_sync/*`, `_store/*`, `librarySearch.ts`,
  `libraryDiscovery.ts`, `libraryHome.ts`, `libraryOrganization.ts`: pure and
  tested, keep.
- `audio/{mark-index,native-queue,native-playback-truth,sleep-timer,speech}.ts`:
  tested; `player.tsx` is only the integration shell around them.
- The product documents (`core-requirements.md`, `design-system.md`,
  `home-discovery.md`) describe the intended UX accurately; the refactor
  implements them, it does not replace them.

## 3. Principles

1. Behaviour first, structure second. Every phase ships with the existing UX
   unless §6 lists an explicit change, and every explicit change is approved
   before it is built.
2. Extract pure logic, test it, then move the React code onto it. No
   navigation or playback rule is rewritten without a characterization test of
   the current behaviour.
3. One owner per concern: one reading location, one spine cache, one bottom
   dock, one event mechanism, one chapter resolver on the server.
4. Comments state invariants, not history. A comment that explains a past bug
   is replaced by the test that pins the fix, or by one sentence stating the
   rule.
5. Every phase is independently shippable through the OTA path. Nothing in
   this plan changes the native host interface.

## 4. Target architecture — web

### 4.1 Reader session (`web/src/reader/`)

```
reader/
  location.ts      ReaderLocation, hash <-> location, history policy, resume slot
  entry.ts         resolveEntry(): which rendition + edition + chapter a book opens in
  spines.ts        SpineCache keyed by slug:rendition; useSpine(); useShelfSpines()
  chapter.ts       useChapterContent(location): fetch, seq token, 404 self-heal, view transition
  navigation.ts    useReaderNavigation(): open/back/switchLang/switchRendition + side effects
  readAlongSync.ts useReadAlongSync(): the view<->engine policy as one pure decision
  progress.ts      shelfProgress(), widgetSnapshot() (pure)
```

- `ReaderLocation = { kind: "shelf" } | { kind: "chapter"; slug; path; lang; rendition }`.
  It is the only reading-position state. Hash, resume slot, document title,
  native nav snapshots and APM logging are side effects of a location change,
  applied in one place (`navigation.ts`).
- `resolveEntry(book, request, ctx)` merges `defaultRendition`,
  `pickInitialLang`, `enterBook`'s preference logic and both `openAudiobook`
  `prefLang` blocks. `request` is `{ kind?, chapterPath? }`; `ctx` is
  `{ prefs, uiLang, recentProgress, bookRows? }`.
- History is decided by navigation *intent*, not by comparing locations:
  `open(target, { source })` with `source ∈ contents | link | pager | lang |
  rendition | resume | deeplink | history | engine`. The policy table
  preserves today's behaviour exactly: `contents` replaces (lateral move),
  `link`, `pager` and `lang` push (as `openFile` does now), `rendition`
  replaces, `history` and `engine` write no entry. Tests assert the stack
  contents and forward-history retention per source.
- `SpineCache` is `audio/contents.ts`'s existing lifecycle behind one keyed
  store: `loadContentsTree` (cache-first, `/api/tree` fallback for older or
  offline replicas, DAG-backed persistence of a fresh snapshot) plus
  `useContentsSnapshot`'s refresh rules (path-index adoption, foreground,
  reconnect, bounded polling while synthesis is unfinished, last snapshot
  retained on failure). The store is keyed by `slug:rendition`, shared by
  the reader and the shelf meter, and invalidated by `TreeUpdate`,
  `refreshShelf` and the replica's applied-root change. `tree`, `audioTree`,
  `renditionRef`, `handleTreeUpdate`'s guard and `backToLanding`'s refetch
  disappear; the voice-readiness and duration refresh behaviour does not.
- `useReadAlongSync` replaces effects A and B with one event-driven decision
  `readAlongStep(state, event) → { location?, engine? }` where `event` carries
  provenance (`user` navigation, `engine` chapter change, `hydration`) and the
  playback identity (book, rendition, lang, chapter). The engine side returns
  commands (`play(chapter, queue, autoplay)`), so opening an audio chapter from
  a stopped session or picking another audio chapter still seeds the queue
  (today's effect A), and only an engine-led advance while in sync moves the
  view (today's effect B). Tests: auto-advance while synced, user navigation
  away, re-entry without restarting playback, delayed engine acknowledgement,
  text read-aloud staying opt-in and carrying into the next chapter.
- The navigation controller keeps one navigation-wide epoch (today's
  `fileLoadSeq`): every `open`, restore and back-to-shelf claims it before any
  await, and every async continuation (spine, progress, chapter body) checks
  it. Chapter fetching does not own the epoch.
- Native navigation snapshots are three ordered steps, not a post-commit
  effect: capture the current pixels before the route commits (`nativeNavPush`
  from the shelf only), commit, then signal `nativeNavReady` after the shelf
  has painted (double rAF) on the way back. Capability detection and the
  browser no-op stay. A mocked ordering test pins the sequence.
- `LibraryScreen` stays mounted while a book is open (today's `display:none`
  retention) and its browsing state (directory, query, filters, page limits,
  scroll map) lives in the `library/browser.ts` store, so returning from a book
  restores the exact view. A return-from-book test covers nested folders,
  active filters and more than 40 loaded entries.
- `useEdgeBackGesture(enabled, onBack)` moves to `_shell/` and shares the
  28 px reserved edge constant with the spatial drawer.

`App.tsx` becomes providers plus a screen switch (< 150 lines).
`screens/ReaderScreen.tsx` composes NavShell, Sidebar, content, dock and the
reader actions (< 400 lines). `screens/LibraryScreen.tsx` is §4.5.

### 4.2 Bottom dock (`_shell/bottom-dock.tsx`)

One component owns the bottom edge of a screen surface:

```
<BottomDock>
  <BottomDock.Strip>      sync filament (SyncIndicator)
  <BottomDock.Accessory>  PlaybackTransport | NowPlayingRow
  <BottomDock.Bar>        reader nav bar | library toolbar
</BottomDock>
```

- The dock publishes a single `--lv-dock-h` on the surface element, defined
  as the total bottom occlusion: its measured height plus the keyboard inset
  while it is lifted. Scrollers pad with `calc(var(--lv-dock-h, 0px) + 16px)`
  and set `scroll-padding-bottom: var(--lv-dock-h, 0px)`; the FAB lifts by it.
  Safe-area padding is applied once, inside the dock. No variable is mirrored
  on `documentElement`.
- Global overlays that must clear the dock (the update pill now rendered by
  `ReconnectBanner` above the screen stack) move into a dock-owned `overlay`
  slot inside the surface, driven by the same connection store. Modal sheets
  keep portalling outside the translated reader container and keep their
  suppression rules during drawer gestures.
- The dock applies the keyboard inset itself (`useKeyboardInset`, moved from
  Landing, including the focused-editor guard and the dismissal reset) so the
  library toolbar's keyboard avoidance is a dock property. Keyboard open and
  dismiss, hardware-keyboard changes and rotation are gated on both touch
  layouts.
- NavShell gets `bar: "top" | "dock"`. On the compact tier the bar is a dock
  row inside the translated surface, so it moves with the spatial drawer as
  today. `barFrosted`, `barTransparent`, `barPosition`, the PlaybackBar slab,
  and the second `SyncIndicator` mount are removed. The dock is opaque
  (`background.default`) with one hairline on top, matching the current
  material; no `backdrop-filter`.
- Desktop keeps the top bar and persistent sidebar; the dock then holds only
  the accessory and strip rows at the bottom of the content column, which is
  where the transport already sits.

### 4.3 Playback surfaces

- `PlaybackTransport` (renamed from PlaybackBar): on widths ≥ 680 px the
  existing single row (follow · prev · −15 · play · +15 · next · time ·
  scrubber · time · speed · sleep · more). On narrower widths a thin scrubber
  row (24 px hit area, 4 px rail, times hidden) above one control row
  `◎ ⏮ −15 ▶ +15 ⏭ ⋯`. Speed and sleep live in the PlaybackSheet (`⋯`), which
  already has them. See §6.3.
- `NowPlayingRow`: a dock accessory shown when a session is loaded and the
  current screen does not show its transport: cover 36 px · chapter / book ·
  play-pause · `⋯`. Tapping the text goes to the playing page (replaces
  `openPlayingAudio`/`goToNowPlaying`). See §6.4.
- `PlaybackSheet` stays the single full panel. It opens through
  `playbackControls.open()` (§4.6) instead of a window event.
- `AudiobookPlayer` keeps its full transport; it is the player page.

### 4.4 Library screen (`web/src/library/`)

```
library/
  browser.ts         reducer: directory, query, kind, readingFilter, tags, sort, page limits
  derive.ts          visibleEntries(), facetCounts(), directoryMatches() (pure, tested)
  LibraryScreen.tsx  layout: rail (≥700 px), content, dock toolbar
  LibraryToolbar.tsx back · search · filter · settings
  SearchField.tsx    uncontrolled input with the IME composition rules
  LibraryList.tsx    header, continue, folders, cards, load-more, batched paint, scroll restore
  SortFilterSheet.tsx
  LocationSheet.tsx  ancestors + "Organize…" (DirectoryLocation's sheet, extended)
```

`ShelfCard`, `LibraryOrganizer`, `AudioPreparation` move alongside. Pure
derivations that already exist in `libraryDiscovery.ts`/`librarySearch.ts`
stay there; `derive.ts` only composes them. The reducer gets tests for the
positionKey/page-limit/scroll-restore rules that are currently implicit.

### 4.5 Events → signals

`_store/signal.ts`: `createSignal<T>() → { emit(v), subscribe(cb), useSignal(cb) }`.
Replaces the four app-level window events with imported signals:
`playbackControls` (open sheet), `downloadPolicy`, `voicePreference`,
`audioCacheWake`. Native bridge events (`lv-native-*`) remain window events;
they cross the WKWebView boundary.

### 4.6 Audio engine split (`web/src/audio/`)

Behaviour-preserving extraction, last in the schedule (§7):

```
audio/engine/types.ts   Engine: load(track), play(), pause(), seek(), setRate(), on(event)
audio/engine/web.ts     HTMLAudioElement adapter: playAudio recovery, position state, sync events
audio/engine/native.ts  AVPlayer adapter: snapshot adoption, queue staging, playback proof
audio/session.ts        NowPlaying + queue persistence, startup hydrate/connect/reconcile
audio/read-along.ts     sentences + marks loading
audio/player.tsx        provider: contexts, sleep timer, media session wiring
```

Behavioural coverage is written before the extraction, not after: protocol-v1
playback proof, queue-capable snapshot adoption after an OTA reload, stale
queue/index events, exactly-once auto-advance, stop during hydration,
buffering cancellation, and the resume/reconcile decisions as pure functions
(`session.test.ts`). The regex-on-source checks in `nativeAudioRecovery` and
`readAlongRecovery` are replaced by these tests, which also define the
adapter's capability and event-ownership contract.

### 4.7 i18n

`locales/en.ts`, `locales/zh.ts`, `i18n.tsx` (provider + `t`).
`locales/keys.test.ts` asserts: both locales have the same key set; every
`t("…")` literal in `web/src` exists; every key has a caller (dynamic prefixes
allow-listed). The 19 dead keys are deleted.

### 4.8 Data layer hygiene

- Delete the `replicaFlag` branches and the dead `prefetch.ts` paths; keep
  only what `ensureAutoSync` and the replica fill actually run.
- Trim `_sync/` to the state tier that is used (`mirroredStore` + types) and
  stop calling it vendored. `_sync-idb` keeps its own database
  (`shared-utils-sync`): it holds the device-local audio session, an offline
  OTA launch must not lose it, and older bundles may still write it. Folding
  it into the replica database would be a persistence migration and is out of
  scope.
- `connectionStore` is created from a UI-free factory (`_shell/connection-store.ts`
  split out of `connection-banner.tsx`).
- One `platform/target.ts` for shell detection; one `connectivity.ts` that
  composes `serverReachability` + `liveSocket` + the native network class and
  is the only source the UI and the replica read.
- Move `memory-idb.ts` and `spike.ts` under `replica/testing/` and strip the
  `__lvReplica*` globals from production builds.
- Convert the regex-on-source tests that guard behaviour (`nativeAudioRecovery`,
  `readAlongRecovery`) into behavioural tests of the moved code; keep
  `scrollMaterials.test.ts` as the material gate but point it at the new
  files. Standardise on `bun:test`.

### 4.9 Comment policy

- Keep comments that state a rule the code cannot express (an iOS WKWebView
  constraint, a protocol invariant, a performance gate).
- Replace bug narratives with a one-line rule plus the test name that pins it.
- Delete comments that describe removed code or a previous approach.

## 5. Target architecture — server

### 5.1 Layout

```
src/
  main.rs            parse CLI, dispatch (< 120 lines)
  cli/               args.rs (clap), run.rs (sync/tasks/targets/audio-optimize/dir runners)
  bootstrap.rs       AppState::build(deps) once; env + credential loading
  server/
    app.rs           router, middleware, HttpPolicy, compression predicate, serve()
    handlers/        books.rs tree.rs chapter.rs (file/spoken/units/raw) progress.rs
                     settings.rs library.rs artwork.rs manifest.rs (root/dag/sizes/blob)
                     audio.rs speech.rs contents.rs apm.rs version.rs ws.rs
    error.rs         StoreError -> HTTP status, one mapping
    tests/           one fixture, the merged apm_tests + http_tests
  content/           renderer.rs tree.rs narration/{spoken,units,speakable}.rs (shared by server, sync, check)
  corpus/            discover.rs (manifest discovery, artwork lookup, implicit books) — from config.rs
  model/             rendition.rs (RenditionKind, BookState/RenditionState/EditionState)
  store/             content.rs pg.rs fs.rs objstore.rs (moved from sync/) blobs.rs (put_blob once)
  sync/              run.rs split into stages: scan, render, narrate, merkle, gc, notify
  check/             unchanged, imports content/ and output.rs instead of server/cli
```

### 5.2 Primitives introduced once

- `ChapterRef { slug, kind, lang, default_lang, rest }` + `resolve_chapter(purpose)`
  replaces the six `get_chapter_fallback` call sites. The call sites encode
  different contracts, not one: `/api/audio` without a rendition resolves the
  audio rendition even when the book defaults to text (`main.rs:2247`), and
  text read-aloud synthesizes the displayed chapter rather than its
  `.spoken.md` overlay (`audio_http.rs:415`). Each endpoint's fallback order,
  served language, unsafe-path rejection and missing-versus-error behaviour is
  characterized by tests before any implementation is shared.
- `RenditionKind::parse` at every query boundary; no raw `"text"`/`"audio"`
  comparisons outside `model/`.
- `FileType` wire string from `shared.rs` only.
- `store::blobs::put_blob` and `content::narration::synthesize_chapter`
  replace the four copies each.
- `WsMessage::ChapterReady` typed; `TreeUpdate` built by one function.
- `blob_response` with Range and a consistent status map for every blob
  route, built on the existing `server/bytes.rs` helpers.
- `StoreError` enum implementing `IntoResponse`; `library.rs` returns a typed
  conflict instead of a string the handler matches.

### 5.3 Cleanup

- Remove the stale module-wide `#[allow(dead_code)]` on `store/` and `sync/`;
  delete `PgStore::get_chapter_fallback`, the dead `Resolved` fields and the
  contradicted comments listed in §2.5.
- Wire compatibility is preserved: the server keeps emitting the book-level
  `langs`/`default_lang` aliases (`main.rs:1980,2036`) and the web decoder
  keeps accepting `ContentUpdate`; only the unused TypeScript declarations go.
  Removing the unsent `ContentUpdate` producer is allowed. `WsMessage::ChapterReady`
  gets a serialization fixture pinning the existing lowercase `chapter-ready`
  tag before the hand-built JSON is replaced.
- Database and object-store tests move behind an explicit `just test-db`
  target that runs them (`--ignored` selection) and fails when
  `DATABASE_URL`/S3 are missing, instead of passing silently; it is mandatory
  for phases 5 and 7. `tempfile` for every temp directory.

## 6. UX decisions

Operating style to preserve: bottom-first controls on phone and tablet,
directory-first library, one tap for the frequent actions, calm chrome.

### 6.1 Keep (no behaviour change)

Directory browsing, global search with IME rules, Filter & sort sheet,
Continue section, folder cards, 40-item pages and batched paint; compact-tier
bottom bar and desktop top bar + sidebar; the spatial Contents drawer and its
gesture; chapter pager, edge-swipe back, status-bar tap to top, scroll-to-top
FAB; read-aloud and audiobook actions in the reader bar; language switcher in
Contents; PlaybackSheet as the full control panel; the audiobook read-along
page; the Settings surface; shelf cards with read/listen actions; the
reconnect/update banner.

### 6.2 Change: library toolbar is one row

Today on a phone the bottom toolbar wraps into two rows (search; then
Filter & sort · Organize · settings) and a third breadcrumb row appears inside
a folder. New: always one row.

- At the root: search · `Filter & sort` (badge) · `⚙`.
- Inside a folder: `⬅` · location chip (`Folder name ▾`, flex, opens the
  Location sheet) · `🔍` · `Filter & sort` · `⚙`. Tapping `🔍` expands the
  search field in place (today's phone editing mode, which already hides the
  other controls while focused). The location stays bottom-reachable without
  scrolling back to the page header.
- `⬅` keeps today's two meanings: while search or filters are active it
  exits discovery and restores the selected directory and scroll position;
  otherwise it goes up one level. It is shown at the root only while discovery
  is active.
- The Location sheet gains an `Organize…` action; Organize leaves the toolbar.
  It is an infrequent administrative action and should not occupy a permanent
  primary slot.

Desktop and the ≥ 700 px rail keep their layout; the rail's folder list gains
the same `Organize…` entry. Validation uses a nested library with deep scroll
positions, not the sparse example corpus.

### 6.3 Change: compact read-aloud transport

When read-aloud narrates the text chapter on a phone, the current transport
stacks two 48 px rows above the nav bar, plus the sync strip when audio is
generating — up to four rows over the text. New compact layout: one control
row `◎ ⏮ −15 ▶ +15 ⏭ ⋯` (every target 44 px) with a 3 px non-interactive
progress filament along the row's top edge. Seeking stays available two ways
that already exist: sentence-level in place (tap or long-press a sentence) and
the full scrubber in the `⋯` sheet; speed and sleep are in the same sheet. A
24 px inline slider was considered and rejected: it violates the 40–44 px
touch-target rule and would compete with the control row and the reader
gestures. Widths ≥ 680 px keep the complete single row with the real scrubber.
The audiobook page is unchanged.

### 6.4 Change (decision requested): now-playing row instead of the floating puck

The draggable puck is the only floating control in the app and contradicts
the shell's own rule against floating affordances. A dock row shows what is
playing, offers play/pause in one tap instead of two (puck → sheet → button),
and keeps every control at the bottom edge. Cost: 56 px of dock height while
something plays away from its page; the puck is remembered-position and costs
none. Recommendation: the row. Alternative: keep the puck but exclude it from
the reader's scroll path (it is already outside the scroller).

### 6.5 Change: audio preparation status moves off the shelf

The server-side "Audio ready: n/total" summary with its pause control is
system status, not library content. It moves into Settings → Downloads (an
always-reachable surface) and the Sync sheet links to it. It cannot live only
behind the strip: the strip renders nothing while `/api/tasks` reports no
pending audio tasks, and that rollup does not include speech preparation or
its persistent pause state, so paused and zero-pending states would become
unreachable. The shelf body shows only Continue, folders and titles.

### 6.6 Keep: the rail play button while Contents is open

`SpatialPlaybackPreview` stays. While Contents is open on a phone the
translated transport is clipped and covered by the drawer's close backdrop and
the puck is suppressed, so the rail control is the only reachable play/pause
(and the only way to start read-aloud without closing Contents). It is
re-homed as the dock's stationary accessory for the open-drawer state rather
than a NavShell prop, and tested in the active, paused and unloaded states.

### 6.7 Keep: reader title tap scrolls to the end

Contents already has its own control (`≡`); the title tap remains the only
bottom-reachable jump to the end of a chapter, so it stays.

## 7. Phases

Each phase ends with `nix develop -c just verify` green (the full gate,
including the production bundle build that OTA delivery depends on), the
scroll-material test unchanged, screenshots at 390×844, 820×1180 and
1440×900 compared with the previous phase, and one or more focused commits.
Every phase that touches navigation, rendering, persistence, downloads or
playback (1b, 2, 3, 4, 6, 8) also requires the iOS Simulator WKWebView pass
from `core-requirements.md` — production-sized iPhone and iPad libraries,
concurrent background work, 600-frame captures or repeated transitions, and
the frame-gap/p99 thresholds — before it ships.

| Phase | Scope | UX change | Gate |
|---|---|---|---|
| 0 | `reader/location.ts`, `reader/entry.ts`, `reader/progress.ts` extracted with characterization tests; `_store/signal.ts` replaces the four window events; i18n split + keys test; dead keys removed | none | tests for hash/resume/history/entry rules |
| 1a | `SpineCache` (contents lifecycle behind one keyed store) and `useChapterContent`; `tree`/`audioTree`/`renditionRef` removed | none | spine store tests (refresh rules, fallback, invalidation); chapter load tests (epoch, 404 vs transient, offline retry) |
| 1b | `useReaderNavigation` (intent-based history, epoch, native snapshot ordering), `useReadAlongSync` (`readAlongStep`), `useEdgeBackGesture`; `ReaderScreen`; `App.tsx` reduced to composition; library retained across the switch | none | controller tests written first: competing restores/loads, stale success and failure after shelf/audio navigation, hash-over-resume precedence, initial resume, pinned and fallback editions, engine/user races, return-from-book state; simulator pass |
| 2 | `BottomDock` + `--lv-dock-h` (occlusion), overlay slot for the update pill, keyboard inset; NavShell `bar: "dock"`; PlaybackBar slab, mirrored vars, `barTransparent`, dual SyncIndicator removed | none (pixel-equivalent) | screenshot diff; simulator scroll capture; keyboard/rotation checks |
| 3 | `library/` decomposition; one-row toolbar with location chip; Location sheet with Organize; preparation status into Settings → Downloads | §6.2, §6.5 | browser store tests (discovery exit, directory restore, paging); nested-library screenshots; simulator |
| 4 | `PlaybackTransport` compact row; `NowPlayingRow` (or puck kept); rail control re-homed on the dock | §6.3, §6.4 as approved | screenshots; simulator with audio |
| 5 | Server layout (§5.1) and primitives (§5.2): mechanical moves first, then the shared resolvers | none | `cargo test`, `http_tests` consolidated, route table unchanged |
| 6 | Behavioural audio tests first (§4.6), then the engine split | none | the new behavioural tests; simulator background audio, OTA reload adopting a running native queue |
| 7 | Server cleanup (§5.3), cycles broken (`content/`, `corpus/`, `model/`, `store/objstore.rs`), sync stages | none | `cargo deny`, `cargo machete`, full `just verify` |
| 8 | Data layer hygiene (§4.8): dead replica/prefetch paths, `_sync` trimmed, `_sync-idb` folded, `connectivity.ts`, `platform/target.ts`, test fixtures moved, regex tests converted | none | replica + sync tests; offline cold start, resume and settings sync checked in the simulator |

Phase 1 gate record (2026-11-05, iOS Simulator WKWebView, production
library over the deployed server, bundle hash verified in the web view):
continuous 620-frame scroll on the shelf and in the reader had no frame over
50 ms on iPhone 17 or iPad Air 11-inch (p99 17–25 ms). Repeated shelf ⇄ book
transitions produce one 66–82 ms frame per transition on both the branch and
the pre-refactor baseline (`b1c7a30`), so it predates this work; it is a
Phase 2 target, since the dock removes mirrored-variable writes from that
transition. The first seconds after a fresh install, while the replica fills,
also showed isolated long frames on both builds.

Phase 2 gate record (2026-11-05, iPhone 17 Simulator, production library):
the shelf dock (strip + toolbar) and reader dock (transport + bar) publish
`--lv-dock-h` on their surfaces, the retained hidden shelf dock measures 0,
and `--lv-dock-max-h` follows the visible one. Scrolling the shelf, the reader
and the reader with the read-aloud transport open had at most one frame over
50 ms in 3,000 frames (p99 17 ms); shelf ⇄ book transitions are unchanged
from the baseline. Chrome comparisons against the previous commit show
identical bars, foot padding and Contents drawer geometry on all three tiers.
The software-keyboard lift was not exercised (the Simulator used a hardware
keyboard); the lift logic itself is unchanged.

Phases 3–4 gate record (2026-11-05, iPhone 17 and iPad Air Simulators,
production library): the library toolbar is one 44–48 px row at the root and
inside folders on both devices; shelf and reader scrolling had at most one
frame over 50 ms per 600 (p99 17–22 ms); transitions stayed at the baseline.
Playback states were verified in Chrome against the local preview with the
media element stubbed, because real playback on the deployed server would
overwrite the owner's cross-device resume session: the compact read-aloud
transport is 66 px (was 127 px) and the now-playing row appears in the
reader and shelf docks only while audio plays away from its transport.
The Contents drawer's playback companion was kept as a NavShell accessory
(§6.6) rather than re-homed, since its geometry already passed Phase 2.

Phases 5–8 record (2026-11-05): `main.rs` is split into `bootstrap`,
`commands` and `http/*`; the shared primitives (`FileType::as_wire`, one
`ChapterReady` frame, `store::blobs::put_blob`, `config::resolve_artwork`, one
tree-update frame) replace their copies; the module cycles through `content/`
and `store/` are broken; the route table is unchanged (35 routes) and
`cargo test` passes, with the database tests runnable through `just test-db`.
On the web side the replica flag, the unused OP-based sync tier and
`platform/target.ts` are removed, and the in-memory IndexedDB fixture lives
under `replica/testing/`. Phase 6 extracted the pure resume rules
(`audio/resume.ts`: storage keys, server blob parsing, the cross-device
adopt decision with its `SYNC_POS_LEAD_S` margin shared with `posStore`)
with tests.

Follow-up record (2026-11-05): the items first deferred above are done.

- Audio engine split (§4.6): `audio/engine/native.ts` owns the native event
  contract (snapshot adoption, stale queue and index events, protocol-v1
  playback proof, stalls, the pending-load guard) behind a host interface the
  provider implements over its refs; `audio/engine/web.ts` owns the
  `<audio>` element listeners, media-session position and interruption
  recovery; `audio/engine/transport.ts` is the pure transport-flag
  transition. Contract tests cover each without React. The provider's
  observable behaviour was compared before and after in Chrome against the
  local preview, once with a stubbed media element and once with a fake
  queue-capable AVPlayer bridge: identical outputs for play, pause, stalls,
  stale events, position persistence and media errors.
- Server primitives (§5.2): `server::synthesis` (one synthesize, encode and
  store pipeline for both workers and the on-demand fallbacks),
  `server::encoding`, one ranged `blob_response` for artwork and raw assets,
  and `LibraryError` (a store failure during a library change is now a 503).
- `connectivity.ts` (§4.8): one module for the device network state, the
  replica's offline probe and `readingOffline`. A network-class change now
  updates the offline flag before notifying listeners.
- The `nativeAudioRecovery` and `readAlongRecovery` checks on moved code are
  behavioural tests (`hooks/readAlongCache.ts` holds the read-along cache
  rules). Checks that read Swift and component markup stay source checks.

- Chapter lookup (§5.2): the request context (`ReqCtx::chapter` and
  `chapter_at`) is the one place that applies the edition fallback; the
  nine HTTP call sites no longer repeat the five-argument store call. Each
  endpoint deliberately keeps its own fallback order (the narration overlay,
  the audio-to-text source mapping, the displayed chapter for text
  read-aloud) and its own missing-versus-error mapping, so no single
  `resolve_chapter(purpose)` was introduced: it would have merged contracts
  the characterization showed to be different.

`spike.ts` stays in `replica/` because `tools/lvsim.sh` depends on its
globals.

Order rationale: 0–1 remove the largest source of regressions with the least
visible change and create the tests the later phases rely on; 2 must precede
3–4 because both redesigns are dock rows; 5 is independent and can interleave
with 3–4; 6 is last because it touches background audio on iOS, which has the
weakest automated coverage.

## 8. Risks

- Navigation regressions (deep links, resume, history) — mitigated by the
  phase-0 characterization tests written against the current behaviour before
  any move.
- Bottom geometry on real devices (safe areas, keyboard, rotation) — the dock
  is pixel-matched by screenshots and then validated in the simulator; the
  phase ships only after that pass.
- Native audio — phase 6 is pure extraction with no semantic change and runs
  last; if the simulator smoke fails the phase is reverted, not patched.
- Server moves — handler moves are mechanical; the route table in §2.5's audit
  is the contract and is re-verified by `http_tests`.
- Source-text tests — eight test files match regular expressions against
  source; a move that preserves behaviour can still fail them. Each phase
  updates or converts the affected tests in the same commit, never by
  loosening the scroll-material gate.
- Scope creep — every UX change is enumerated in §6; anything else found
  during the work is logged, not done.

## 9. Decisions

Resolved by the design review: keep the rail play button (§6.6), keep the
title-to-end tap (§6.7), keep the server's compatibility fields (§5.3), keep
`_sync-idb`'s database (§4.8), write the navigation and audio behaviour tests
before the code they guard moves (§7).

Resolved by the owner: the now-playing dock row replaces the floating puck
(§6.4); the one-row toolbar and the compact read-aloud row ship as specified
(§6.2, §6.3); each phase is committed on its own.
