# Design: incremental book pipeline, async audio, offline prefetch, status UX

Status: **proposed** (design only — no code yet). Tracks task #7.

Goal in one line: a book becomes usable the moment *it* finishes (text now,
audio as it bakes); changes regenerate only what changed; the app prefetches
into the service worker so it works offline (read + listen); and the user is
quietly, never loudly, told what's still generating or syncing.

---

## 1. What we build on (research findings)

The hard parts already exist. This design mostly *exposes* and *reshapes* them.

- **Content-addressed Merkle DAG** over the corpus: `root → book → rendition →
  lang → chapter`; leaves are chapters + assets; blake3 hashes; identical
  subtrees dedup (`src/sync/merkle.rs`). A pure lockstep reconcile emits the
  minimal `put`/`delete` leaf set — unchanged subtrees prune to nothing
  (`src/sync/diff.rs`). This already does **all** add/delete/modify. The DAG is
  persisted in `merkle_nodes` but **not exposed over HTTP**.
- **Two-pass sync** (`src/sync/run.rs`): a FAST pass renders text → pg + uploads
  asset blobs (reader navigable in seconds), then a SLOW pass runs edge-tts to
  bake audio mp3 + marks. Per-leaf resumable: an audio leaf's Merkle node is
  committed **only after** its mp3 lands — so `merkle_nodes` *already* encodes
  "audio ready" per chapter, just not queryably.
- **No `deploy_root` read-gate.** `deploy_root` is read only inside `sync::run`;
  **no API handler consults it.** The server serves `chapters`/`assets`/
  `site_tree` directly, so **text is visible the instant its chapter row
  upserts** — incremental per-book availability is *largely already true for
  text*. `deploy_root` is purely the next sync's diff baseline.
- **Audio always "works"**: `api_audio`/`api_marks` fall back to on-demand synth
  (`ensure_chapter_audio` / `ensure_text_audio`, `src/main.rs`) when not
  pre-baked — but **inline in the HTTP request** (stalls the response seconds),
  and the long backfill **blocks the `liveview-sync` oneshot ~1h** (the
  documented "switch stays busy" pain). `chapters.audio_hash IS NULL` is the
  natural "not yet baked" signal; `assets` carry a `size` column (manifest gets
  byte sizes free).
- **Frontend content surface** is all *path-keyed, mutable* URLs: `/api/file`
  (html), `/api/raw` (images, srcs rewritten in `MarkdownViewer`), `/api/units`
  + `/api/marks` (read-aloud), `/api/audio` (mp3, set as `<audio>.src` with HTTP
  Range), `/api/spoken`, `/api/cover`, `/api/tree`, `/api/books`. The SW
  (`web/public/sw.js`) is network-first for `/api/*`, stale-while-revalidate for
  assets, nukes all caches on `VERSION` bump — **no prefetch, no offline-complete**.
- **Delivery gate** (`projects/books/AGENTS.md`): `liveview check` + `/fix-book`
  (structural, checker==renderer) + `/chart-review` (visual). Skills:
  `extract-book` / `translate-book` / `narrate-book` / `fix-book` /
  `chart-review`; deploy via `liveview sync` (working tree, Merkle incremental).

**Conclusion of the research:** Merkle is the right backbone for *both* the
server reconcile (already) and the client/SW cache (proposed) — it gives the
root-hash O(1) "anything changed?", subtree pruning, content-addressed dedup,
and clean evict-of-stale for free. The missing pieces are: (a) generation as a
managed async task instead of an inline/oneshot blob; (b) the DAG + readiness
exposed over HTTP; (c) hash-addressable blobs; (d) the SW sync/evict loop; (e) a
quiet status surface; (f) skill tweaks.

---

## 2. The spine: audio generation as a liveview-managed async task

Today generation is split across an hour-long sync pass and an inline HTTP
fallback. Replace both with **one durable queue liveview owns**. This single
change dissolves the oneshot-blocks-deploy problem AND produces the readiness
signal that the not-ready UX, the indicators, the incremental availability, and
the offline prefetch all consume.

### 2.1 Data model

```sql
CREATE TABLE audio_tasks (
  book_slug    TEXT NOT NULL,
  rendition    TEXT NOT NULL,          -- 'audio' (audiobook) | 'text' (read-aloud)
  lang         TEXT NOT NULL,
  rel_path     TEXT NOT NULL,
  content_hash TEXT NOT NULL,          -- the chapter source hash this task is for
  voice        TEXT NOT NULL,
  status       TEXT NOT NULL,          -- 'queued'|'running'|'done'|'failed'
  priority     INTEGER NOT NULL DEFAULT 0,  -- higher = sooner (interactive = 100)
  attempts     INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  enqueued_at  BIGINT NOT NULL,
  started_at   BIGINT,
  finished_at  BIGINT,
  PRIMARY KEY (book_slug, rendition, lang, rel_path)
);
```

The PK is the chapter leaf. `content_hash` means a re-edited chapter's new task
**supersedes** the old (upsert resets status→queued) — Merkle stays the source
of truth. `failed` rows keep `error` for the status surface; a retry resets.

### 2.2 Worker

A **background loop inside the `liveview` server process** (a tokio task spawned
at startup) — "liveview manages the task". It drains `audio_tasks` ordered by
`priority DESC, enqueued_at ASC`, with a small concurrency cap (edge-tts is
network-bound, ~2–4 concurrent), reserving ≥1 slot for interactive (priority)
tasks so a tap doesn't queue behind the backfill. Per task: synth (the existing
`server::audio::synthesize`), store mp3 + marks as content-addressed blobs, set
`chapters.audio_hash/marks_hash`, **commit the Merkle leaf node**, mark `done`,
**push a `chapter-ready` event over `/ws`**. Failures → `attempts++`, backoff,
`failed` after N. A startup reaper resets stale `running` rows (server restart)
back to `queued`.

*Decision:* in-server worker (no extra unit, shares pg/rustfs/catalog, resumes
from the durable queue on restart) vs. a separate `liveview-audio-worker.service`.
Recommend **in-server** for simplicity; revisit only if synth load hurts request
latency (it won't — it's network-bound and async).

### 2.3 Sync only enqueues

`sync::run`'s slow `generate_audio` pass is deleted. The fast pass, when it
applies an audio/text-audio leaf, **upserts an `audio_tasks` row (queued)**
instead of generating inline, and commits *text/asset* leaf nodes immediately
(audio leaf nodes are committed by the worker). Result: **`liveview sync`
returns in seconds** (text live), the oneshot stops blocking the switch, and the
NixOS `liveview-sync` unit becomes a fast reconcile (the worker, in the
always-running server, does the slow part). The `liveview-sync.timer` /
`systemctl start --no-block` triggers are unchanged.

### 2.4 On-demand collapses into the queue

`api_audio`/`api_marks` for a not-yet-baked chapter stop synthesizing inline.
Instead they **high-priority-enqueue** (priority 100) and return **`202` +
`{status:"generating"}`**. The client renders the not-ready UX (§5) and waits for
the `chapter-ready` WS push (or polls), then loads the audio. One code path for
backfill + interactive; the "good UX for not-ready" you asked for falls straight
out of this status instead of a silent multi-second stall.

### 2.5 CLI / ops

`liveview tasks [status|retry [--book X]|drain]` for skills + ops. `status`
prints per-book `done/total` + failures.

---

## 3. The Merkle manifest (exposed DAG + readiness)

The client needs to answer two questions cheaply: "did anything change since my
cache?" and "what's ready vs generating?". Expose the DAG + task status as a
sharded manifest so the Merkle subtree-prune works over the wire.

- **`GET /api/manifest`** → `{ root, books: [{ slug, subtree_hash, updated_at,
  audio: {done, total} }] }`. Tiny (~one row/book). The `root` is the O(1)
  early-out; per-book `subtree_hash` lets the client skip unchanged books; the
  `audio.{done,total}` rollup feeds the shelf badge + indicator.
- **`GET /api/manifest/<slug>`** → that book's chapters, **scoped to the
  content-addressed + readiness payload** (text/HTML is Lane A's job, §4.1, and
  is *not* in the manifest): `[{ id: "rendition/lang/rel", audio: {status,
  hash?, marks_hash?, bytes?}, assets: [{path, hash, bytes}] }]`. Cheap to derive
  from `chapters`+`assets`+`audio_tasks`.

So the manifest is the **audio-readiness + heavy-blob index** — the two things
Merkle is for: the `status` field powers the readiness UX (§5), and the
`hash`/`bytes` fields power Lane B's prefetch + eviction (§4.2). The Merkle
subtree-prune the *server* already enjoys is handed to the client: compare book
`subtree_hash`es (~50 numbers), fetch sub-manifests only for changed books.

---

## 4. Offline: two lanes — standard PWA for text, Merkle for heavy blobs

Don't force one mechanism on everything. Text/HTML is small, mutable, and reads
fine with the **industry-standard PWA recipe**; audio is GBs, content-addressed,
and genuinely needs precise prefetch + size-aware eviction + a readiness gate —
that's where Merkle earns its keep. So: two lanes.

### 4.1 Lane A — standard PWA offline (the app + all text)

The boring, proven recipe — a PWA must just work offline:

- **Precache the app shell** at SW install: `index.html` + the hashed JS/CSS
  bundles (today's `sw.js` only precaches the nav shell and lazy-catches bundles;
  strengthen it so the app *boots* offline). Bump on `VERSION` as now.
- **Runtime-cache the text API responses** stale-while-revalidate, keyed by URL:
  `/api/file`, `/api/units`, `/api/spoken`, `/api/marks` (text), `/api/tree`,
  `/api/books`, `/api/cover`, `/api/artwork`. Served instantly from cache,
  revalidated in the background when online. Reading a chapter caches it; a
  cheap **prefetch-all-text** sweep (these are KBs) makes *every* book readable
  offline without Merkle bookkeeping.
- **Freshness:** SWR keeps it current online; a `/ws` "reload" push (or the
  manifest root advancing) nudges a revalidate of the open views. Text is cheap
  to refetch, so we don't need content-addressed precision here.

This fully delivers "离线也能看" with zero Merkle on the HTML path — your call,
and the right one.

### 4.2 Lane B — content-addressed blobs (audio + images)

The heavy, dedup-able, evictable resources go content-addressed:

- **`GET /api/blob/<content_hash>`** → `state.obj.get(hash)`, `Cache-Control:
  public, max-age=31536000, immutable`. Serves audio mp3 + marks + image bytes —
  *already* content-addressed in rustfs. Immutable ⇒ the SW caches forever, never
  revalidates, dedups across books/chapters. Audio keeps Range (the SW serves
  Range from the cached full blob); `/api/audio` and `/api/raw` resolve their
  `path` → `content_hash` (via the manifest) → the cached blob, so existing
  callers are unchanged.
- **Manifest = the audio/asset index + readiness** (`/api/manifest` §3): per
  chapter, `{audio:{status,hash,bytes}, assets:[{hash,bytes}]}`. This is the only
  thing Merkle governs now — exactly the resources where content-addressing,
  size budgeting, and the `ready` gate matter.

**SW sync loop (blobs only):** on app open / periodic / pull-to-refresh / `/ws`
push → `GET /api/manifest`; if `root === cachedRoot` stop. Else, for each changed
**subscribed** book, `GET /api/manifest/<slug>`, diff blob hashes → fetch new
(images first, then audio, only `ready` ones; a `generating` leaf is pulled on
its `chapter-ready` push), under a byte budget.

**Eviction (blobs):**
- *Stale GC:* drop blobs whose `content_hash` is unreachable from the new
  manifest — deletes + updates fall out for free (the server's orphan GC,
  client-side).
- *Capacity:* LRU within the reachable set to fit the storage quota — keep the
  currently-reading book + "saved offline" books; evict cold audio first (it's
  the GBs).

### 4.3 Prefetch policy

Default: **all text** (Lane A, cheap, every book readable offline) + **audio for
books you opened or toggled "save offline"** (Lane B, quota-bounded LRU). A
per-book "save offline" switch lives in the Sync sheet (§5.2); a global "save
everything" is a later opt-in. Delivers "断网也尽可能能看能听" without unbounded
growth.

---

## 5. Readiness UX — quiet, never loud

Principle (yours): **the user knows it exists, but it must not weigh on the UI.**
Ambient + low-weight + *detail-on-tap*. Everything below reads one signal — the
manifest's per-leaf status + the `chapter-ready` WS push.

### 5.1 The ambient indicator (≈ 2px) + the Sync DetentSheet

**At rest: a 2px filament.** A thin progress line along the very top edge (under
the status bar), app-wide, that appears *only* while audio is generating **or**
the SW is prefetching, and quietly fades when idle. Determinate when there's a
known total (audio N/total), a soft indeterminate shimmer otherwise. No number,
no label, no chrome at rest — calm-tech. (Reuses the reading-progress filament
pattern from `MarkdownViewer`.) Tapping it (or a tiny optional dot in the
toolbar) opens the Sync sheet.

**On tap: the Sync DetentSheet** — a calm status *and control* center, built on
the SDK `DetentSheet` (the same iOS bottom sheet as settings/playback), with two
detents for progressive disclosure:

- **Peek (~42%) — "what's happening now," at a glance.** A hero line + a
  determinate bar for the dominant activity:
  - generating → "生成朗读音频 · 《算法导论》 12 / 40"
  - prefetching → "离线下载 · 8 章"
  - idle → "✓ 全部最新" + "离线已存 1.2 GB"

  plus compact chips for any *other* concurrent activity ("另 2 本生成中 · 同步 3
  章"). When fully idle the peek is just "✓ 最新 · 离线 1.2 GB" — nothing alarming.

- **Full (~88%, drag up) — the breakdown + controls,** three groups, each shown
  *only when relevant* (an idle sheet is nearly empty):
  1. **生成中 (Generating)** — per book: cover-dot · title · "音频 12 / 40" · thin
     bar · ⟳. Failed chapters surface inline: "第 5 章 · 失败 [重试]" →
     `liveview tasks retry`.
  2. **离线 (Offline)** — the management list. Per book: title · state ("文本 ✓ ·
     音频 1.2 GB" / "文本 ✓ · 音频未保存") · a **"保存到离线"** toggle. Header
     meter: "离线 1.2 GB / 4 GB" · "清理冷数据" (evict). This is where you choose
     what's kept offline.
  3. **新内容 (New content)** — appears only when the server manifest root advanced
     past the loaded version: "有新内容 [刷新]".

Why this is the optimal shape:
- **Low-weight by construction.** Ambient footprint = 2px; the sheet is opt-in
  and *calm at rest*. Nothing nags — matches your "用户知道，但不重要" principle
  exactly.
- **Progressive disclosure** rides the detent mechanic the SDK already has: peek
  = glance, drag = manage. No new interaction vocabulary.
- **Grouped by the user's real concerns** — what's cooking, what's safe offline,
  is there new content — and each group hides when empty.
- **Actionable, never required.** Retry / save-offline / clear / refresh live
  here, but everything degrades fine without ever opening it.

### 5.2 Per-surface "audio not ready" states

The whole UI must degrade gracefully when audio isn't baked (your requirement):

- **Shelf card** (`Landing`): a book with an audio rendition still baking shows a
  faint micro-badge on the 🎧 affordance (e.g. a hairline ring / "·· "), not a
  banner. Text stays fully usable ("尽可能能看"). On hover/tap detail: "Audio
  12/40".
- **🎧 listen toggle** (App navbar): tapping into an audiobook whose *current*
  chapter is `queued`/`generating` → the play button shows the existing
  `audiobook.loading` ("正在合成朗读音频…") state **with intent** (we *know* it's
  generating, not a blank spinner), and auto-plays on the `chapter-ready` push.
- **🗣 read-aloud** (text): same — tapping read-aloud on a chapter whose
  text-audio is `generating` shows the generating caption, then starts.
- **PlaybackBar**: the play button's spinner is now a *meaningful* "generating"
  state, optionally with the chapter's queue position if it's behind the backfill.
- **Offline + uncached**: "Not saved for offline" hint (info, not error) with a
  "download now" affordance when back online.
- **Failed**: a quiet "audio unavailable — retry" on that chapter (drives
  `liveview tasks retry`).

All of these are *states of one component each*, switched by the readiness
signal — no new heavy surfaces.

---

## 6. Skills + incremental per-book delivery

- **Sync is now fast** → `narrate-book` / delivery no longer blocks ~1h. After
  `liveview check` + `/fix-book` + `/chart-review` pass, `liveview sync` delivers
  **text immediately** and **enqueues audio**; the skill can `liveview tasks
  status --book X` to watch the backfill but delivery is "done" at text-validated.
- **Per-book, incremental**: `liveview sync` reads the working tree and Merkle-
  diffs, so editing one book re-applies only that book's changed leaves and
  re-enqueues only its changed audio. "做完一本就能看一本" is the default; a book
  can be synced the instant it's authored, independently.
- **Gate unchanged in spirit**: structural (`liveview check`) + visual
  (`/chart-review`) still gate *text* delivery; audio is async and never blocks.
- **books/AGENTS.md** updated to describe: deliver text → it's live; audio
  backfills as managed tasks; check `liveview tasks` for progress; changes are
  incremental per book.

---

## 7. Phasing (each independently shippable)

1. **Async audio task system** (backend): `audio_tasks` + in-server worker +
   sync enqueues (drop the slow pass) + on-demand→priority-enqueue + `/ws`
   `chapter-ready` + `liveview tasks` CLI. *Unblocks the oneshot; emits the
   readiness signal.* Highest value.
2. **Readiness UX** (frontend): consume per-chapter status + the WS push; the
   "generating" states on listen/read-aloud/play + the ambient filament + shelf
   micro-badge. *Delivers the not-ready UX you emphasized.*
3. **Merkle manifest + blob route** (backend): `/api/manifest` (+ per-book) +
   `/api/blob/<hash>`.
4. **SW offline** (frontend SW): manifest-driven prefetch, content-addressed
   cache, Merkle stale-GC + LRU capacity eviction, the background-fetch share of
   the ambient indicator, offline read+listen, per-book "save offline".
5. **Skills + per-book delivery**: adjust `narrate-book`/delivery + books/AGENTS.md;
   wire `liveview tasks`.

1→2 stand alone and address the most-emphasized asks (async generation +
not-ready UX). 3→4 add offline. 5 closes the authoring loop.

---

## 8. Decisions (resolved)

1. **Worker placement** → **in the liveview service** (an in-server worker
   "extension" module spawned by the server; durable queue survives restarts).
2. **HTML/text + app shell** → **standard PWA caching, no Merkle** (Lane A, §4.1).
   Merkle is reserved for audio + image blobs (Lane B, §4.2). The manifest is
   therefore audio/asset-only.
3. **Default prefetch** → **all text (Lane A) + audio for opened/"saved" books
   (Lane B), quota-bounded LRU**; a per-book "save offline" toggle in the Sync
   sheet.
4. **Not-ready on tap** → **show "generating…" + auto-play on the `chapter-ready`
   push** (on-demand = a high-priority enqueue; a single chapter synth is
   ~seconds, so first play stays quick without an inline request stall).
5. **Manifest** → **per-book sharded**, audio/asset-scoped (~50 books today; the
   top-level manifest stays tiny).
6. **Indicator** → a 2px ambient filament that opens the **Sync DetentSheet**
   (§5.1) for full per-resource progress + offline controls.
