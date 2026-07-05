# Design: Interactive View — sound, mobile-first interactive charts & widgets

Status: **SHIPPED.** This file is the original design *rationale*; some of it is
historical (charts are a **closed mark catalog**, not Vega-Lite; the reactive
graph now spans signals **and derived datasets**; selection & cross-filter are
wired). **To author, read [interactive-view-authoring.md](interactive-view-authoring.md)**
— the shipped catalog, linkage, and soundness contract. Keep this doc for the
"why".

Goal in one line: let a book describe **reports and technical-metric
explanations as interactive, linked components** — declarative JSON charts
(Vega-Lite) wired to Block-Kit-style widgets through a Pluto-style reactive
signal graph — behind a **Rust soundness checker so strong that a document
which type-checks needs no LLM/human visual review**: if it compiles, it renders,
it looks good, and it reflows correctly on every screen from phone to desktop.

The name is **Interactive View** (no abbreviations). File type
`FileType::InteractiveView`, extension `*.interactive-view.json`; also embeddable
as a ` ```interactive-view ` fence inside a book's markdown. Both forms share one
IR, one checker, one renderer.

---

## 1. Why this, and the two guarantees it rests on

Today the reader renders prose (Rust → HTML, baked at sync) plus **free-form**
diagrams (mermaid / inline-`<svg>`) hydrated client-side. Free-form is why those
still need a screenshot review loop (`liveview targets` + `chart-review`): an
author can draw an SVG that clips, or a mermaid label that truncates
(see the `mermaid-lightbox-font-clip` memory) and no static checker catches it.

Interactive View is deliberately **not** free-form. It is a small, closed design
system the author *composes*, never a canvas the author *paints*. That is the only
way a static checker can promise "looks good" without eyes on it.

The system makes **two distinct guarantees** — conflating them is the trap:

| Guarantee | Owner | Scope |
|---|---|---|
| **Deploy-time soundness** — "compiles ⇒ the document and its *deployed* assets are mutually consistent, render, and are visually good + responsive on all screens" | the Rust checker + sync | authoring / deploy |
| **Runtime resilience** — "a missing/late/corrupt asset, an offline device, or a renderer bug **degrades gracefully, never crashes the page**" | the web renderer | serve / view |

The checker cannot promise a network fetch will succeed at view time (offline is
the *common* case on the native shell). So resilience is a separate, always-on
layer (§9). Both are required; neither substitutes for the other.

---

## 2. Selection of building blocks (researched)

- **Charts → Vega-Lite.** A true declarative JSON *grammar of interactive
  graphics*: brushing one chart to filter another is JSON, not host code
  (`params` + `filter:{param}`). Ships a formal JSON Schema. Its schema is only
  *syntactic*, though — it does **not** catch field-reference, encoding↔mark, or
  param-reference errors (vega-lite#4236 and others). That semantic gap is exactly
  what our Rust checker fills (§7). Plotly-JSON is trace-oriented/imperative;
  ECharts `option` embeds JS callbacks — neither is soundly type-checkable.
- **Widgets/layout shape → Slack Block Kit.** A flat, tagged block array. Perfect
  for mobile (stacks naturally) and for an open, growing widget set. But Block Kit
  is *stateless* (POST-back), so we take its shape, not its state model.
- **Reactivity → Julia Pluto.** `@bind var Slider(...)`: "reactivity and widget
  interactivity are the same concept." A widget *is* a variable; dependents
  recompute. We express this as a JSON signal graph.
- **Chart checker fidelity → the existing math validator.** `src/check/math.rs`
  already runs the **real** KaTeX inside an in-process quickjs engine. Vega-Lite's
  `vl.compile()` is a pure spec→spec transform (no DOM), so we run the **real**
  vega-lite compiler the same way — gold-standard checker==renderer for charts.

---

## 3. The document — three layers

```jsonc
{
  "interactiveView": 1,          // schema version; renderer refuses unknown majors

  // ── data: named datasets. Small schema lives here; big rows live in rustfs. ──
  "data": {
    "returns": {
      "columns": { "date": "temporal", "ret": "number" },   // declared, checked
      "source":  "/finance/data/returns.arrow"              // absolute content path (§8)
    },
    "constants": { "columns": { "k": "string", "v": "number" },
                   "values": [ { "k": "alpha", "v": 0.3 } ] } // tiny → inline allowed
  },

  // ── signals: the single source of state (Pluto variables). One source each. ──
  "signals": {
    "rf":     { "type": "number", "init": 0.02,
                "widget": { "type": "slider", "min": 0, "max": 0.1, "step": 0.005,
                            "label": "Risk-free rate" } },
    "window": { "type": "number", "init": 60,
                "widget": { "type": "segmented",
                            "options": [ { "label": "30d", "value": 30 },
                                         { "label": "60d", "value": 60 } ] } },
    "sel":    { "type": "interval<temporal>",                // written by a chart brush
                "from": { "chart": "price", "select": "brush" } },
    "sharpe": { "type": "number",                            // derived (a Pluto cell)
                "derived": "mean(returns.ret - rf) / std(returns.ret) * sqrt(252)" }
  },

  // ── view: an ordered Block-Kit-style list. Mobile-first single column. ──
  "view": [
    { "block": "section", "md": "Sharpe at a risk-free rate of **{{rf}}** is **{{sharpe | round(2)}}**." },
    { "block": "metricGroup", "items": [
        { "label": "Sharpe", "value": "{{sharpe}}", "format": "0.00", "audio": { "narrate": true } },
        { "label": "Window", "value": "{{window}}", "format": "0d" } ] },
    { "block": "chart", "id": "price", "data": "returns",
      "vega": { "mark": "line", "encoding": {
                  "x": { "field": "date", "type": "temporal" },
                  "y": { "field": "ret",  "type": "quantitative" } },
                "params": [ { "name": "brush", "select": { "type": "interval", "encodings": ["x"] } } ] } }
  ]
}
```

### 3.1 Data layer

Named datasets. Each declares a `columns` schema (name → column type) and a
`source` (absolute content path, §8) **or** inline `values` (only under a small
byte budget the checker enforces). The declared schema is what the checker
type-checks field references against — and sync verifies the real bytes conform
to it (§8), so the declaration is *truthful*, not just present.

Column types: `number` · `integer` · `string` · `boolean` · `temporal`.

### 3.2 Signal layer (Pluto variables — the only mutable state)

Every signal is declared once with a `type` and **exactly one** source:

- `widget` — a Block-Kit-style input renders it and writes it (§5).
- `from: { chart, select }` — a chart selection (brush/click) writes it.
- `derived` — a total expression over other signals & datasets (§6). This is a
  Pluto cell; it never has a widget.

Signal types: `number` · `integer` · `boolean` · `string` · `temporal` ·
`enum(values)` · `interval<T>` (a `[lo, hi]` pair) · `array<T>`.

Signals are read by `{{signal | fmt}}` interpolation in prose/metrics, by Vega
`params`/`filter` in charts, and by other derived signals. The whole
signal/derived/selection dependency graph must be a **DAG** (§7 S7) so a change
propagates once and terminates — no reactive divergence, ever.

### 3.3 View layer (Block-Kit-style, mobile-first)

An ordered block array. Blocks split into **layout**, **display**, and **input**.
The IR has **no** pixel, CSS, position, font, color, or margin fields — a bad
layout is unrepresentable (§4). Everything visual comes from design tokens
(`web/src/theme` / `conventions/ui.md`), light+dark already proven.

| Block | Kind | Notes |
|---|---|---|
| `section` | display | markdown + `{{signal｜fmt}}` interpolation |
| `metric` / `metricGroup` | display | KPI tile(s); `metricGroup` is an auto-fit grid |
| `chart` | display+input | a Vega-Lite spec (§7 profile); may host selection signals |
| `table` | display | data table over a dataset; paginated; horizontally scroll-contained |
| `callout` | display | note/warning/tip; token-styled |
| `input` | input | renders a widget for a signal that declared one inline, or a standalone control |
| `stack` | layout | vertical; children get full width (always safe) |
| `columns` | layout | multi-column on wide screens; **auto-collapses to stack** on narrow (§4) |
| `tabs` | layout | wide: tabs; narrow: accordion/swipe (renderer decides, author doesn't) |

Adding a block or widget is an open-registry operation (§5, §11) — the core IR,
reactive kernel, checker skeleton and renderer skeleton do not change.

---

## 4. Visual soundness — how "compiles ⇒ looks good on every screen" is proven

A static checker cannot审美-review pixels. So we remove the freedom to be ugly and
prove goodness structurally. Define, for a rendered block at container width `w`:

> **P(block, w)** ≜ at any `w ≥ W_min` (= 320 px, smallest supported viewport) the
> block fits within `w` with **no horizontal overflow, no content clipping, no
> info-losing truncation**, and uses **only design tokens**.

The whole page is visually sound iff every top-level block satisfies P. We get
that by structural induction over two independently-established facts:

**(a) Leaf invariant — proven once, offline, over a finite catalog.** Each leaf
primitive (every widget, `section`, `metric`, `chart`, `table`, `callout`),
rendered at the extreme viewports (320 px and 1920 px) with the checker's
**worst-case bounded content** (§7 V4), satisfies P. This is verified by a
**golden visual-regression suite over the primitive catalog** — reusing the
existing screenshot infra (`liveview targets`, `chart-review`), but run on the
*finite alphabet of primitives*, in CI, **not per author document**.

**(b) Container invariant — checked per document, statically.** Each container
*preserves* P: given children that satisfy P, it assigns each child a width
`≥ W_min` **or collapses to a stack** when it cannot.

- `stack` → each child full width. Preserves P trivially.
- `metricGroup` → CSS `repeat(auto-fit, minmax(minCell, 1fr))`, `minCell` a token
  `≤ W_min`. Reflows many-columns → one automatically. Preserves P by construction.
- `columns`(N) → container query: below the width where each child would drop under
  `W_min`, it **collapses to stack**. The checker **forces `collapse:true`** (the
  default) or, if the author disables it, requires `N × minChildWidth + gaps ≤`
  the widest declared breakpoint; otherwise **reject**.
- Nesting depth ≤ 4 (belt-and-suspenders against width starvation).

By induction: any type-checking document is a composition of catalog-proven
primitives under P-preserving containers ⇒ **P holds for the whole tree at every
screen size** ⇒ no visual review needed. **The finite alphabet is reviewed once;
the infinite set of sentences is guaranteed, not inspected.**

Typography/spacing/color are token-only and unrepresentable by the author, so
"visually good" (as opposed to "objectively broken") is a property of the design
system, fixed once — not of any document.

The honest boundary: this guarantees **rendering & layout** ("does it work and fit
well"), which is what the user asked to remove review for. It does **not** judge
whether the author picked the *right data or the right chart to express an intent*
— that is **content correctness**, a different review, out of scope here.

---

## 5. Widget registry — mobile-first, open for growth

Widgets are the input surface. The set will grow; the contract that keeps growth
from rotting soundness is: **every widget = one aligned entry in three places**,
and the core never changes.

```
new widget =
  1. Rust AST: one #[serde(tag="type")] enum variant
  2. impl Widget: { output_type(), check(scope), mobile_verdict() }
  3. Web: one component registered by `type` string; TS type generated from the Rust AST
```

```rust
trait Widget {
    fn output_type(&self) -> SignalType;      // slider→Number, segmented→its option type…
    fn check(&self, scope: &Scope) -> Vec<Diagnostic>;  // this widget's own obligations
    fn mobile_verdict(&self) -> MobileVerdict; // COMPILE-TIME forced; no hover-only semantics
}
```

Because the TS types are generated from the Rust AST and the web dispatch is an
**exhaustive** `switch` (with a `never` default), forgetting the web component for
a new variant is a **TypeScript compile error** — drift cannot ship.

### 5.1 Initial catalog (v1)

| `type` | writes | props (excerpt) | mobile rule |
|---|---|---|---|
| `slider` | number | min, max, step, label | full-width track; ≥44 pt thumb |
| `rangeSlider` | interval\<number\> | min, max, step | two thumbs, ≥44 pt each |
| `numberInput` | number | min, max, step | native numeric keypad |
| `stepper` | integer | min, max | ≥44 pt +/- targets |
| `toggle` | boolean | label | — |
| `segmented` | enum | options (**≤ 5**, else use `select`) | equal segments; overflow-guarded by option cap |
| `radioGroup` | enum | options | stacks vertically |
| `select` | enum | options (any count) | native picker on mobile |
| `multiSelect` | array\<enum\> | options | native multi-picker |
| `checkboxGroup` | array\<enum\> | options | stacks vertically |
| `textInput` | string | maxLength (checker-bounded) | — |
| `datePicker` | temporal | min, max | native date UI |
| `dateRange` | interval\<temporal\> | min, max | native date UI ×2 |
| `button` | (momentary event signal) | label, action | ≥44 pt |

Charts also produce input signals via `params`/selection (brush=interval,
click=point) — the same signal namespace, so a chart brush and a `rangeSlider` are
interchangeable drivers of the same downstream.

---

## 6. Derived expressions — total, typed, terminating

`derived` is a tiny **total** expression language (a Pluto cell). Totality +
absence of user-defined recursion ⇒ it always terminates and never throws, which
is a precondition of the runtime "no crash" guarantee.

- Values: numbers, strings, booleans, temporals, and **datasets** (column refs
  `ds.col`).
- Ops (whitelist): arithmetic, comparison, boolean, `if(cond, a, b)`, string
  concat/format; aggregations `sum/mean/std/min/max/count/median` over a column;
  `filter(ds, predicate)`; `sqrt/abs/round/clamp`.
- **Three-valued totality:** a dataset is `loaded | loading | unavailable`; every
  op over a non-`loaded` dataset (or an empty aggregate) yields **`unavailable`**
  (SQL-NULL-like), propagated to the reader as `—` / a skeleton — **never NaN, never
  an exception**. This is what lets `sharpe` stay well-defined when `returns` fails
  to load (§9).
- Type-checked against signal + column types (§7 S6). No recursion, no I/O.

---

## 7. The Rust checker — obligations & how each is discharged

Registered as `InteractiveViewValidator` in `src/check/mod.rs`'s `validators_for`
(the single extension point, `mod.rs:58`); sync's per-leaf `check_source`
(`src/sync/run.rs:238`) then fires it automatically. Diagnostics use the shared
`Diagnostic` type (`src/check/diagnostic.rs`).

**Structural & reactive (pure Rust over the IR):**

| # | Obligation | Discharge |
|---|---|---|
| S1 | Every signal name unique, declared once | symbol table |
| S2 | Each signal has exactly one source (widget \| from \| derived) | symbol table |
| S3 | Every reference (`{{}}`, derived, vega param, option value) resolves | scope resolution |
| S4 | widget out-type == signal type == every consumer's expected type | type propagation |
| S5 | Every dataset & column referenced exists and is type-compatible | vs declared schema |
| S6 | Derived language total & well-typed (no recursion ⇒ terminates) | mini type-checker |
| S7 | signal/derived/selection graph is a **DAG** | topological sort; cycle ⇒ error |
| S10 | Each `audio`/narrate ref is generatable or explicitly `skippable`; else error | asset resolution |

**Visual (pure Rust over the IR):** V1 no pixel/CSS/typography fields exist ·
V2 containers preserve P (`columns` collapse or `N×min ≤ width`) · V3 nesting ≤ 4 ·
V4 content bounded (label/option/text lengths; chart categorical cardinality vs
`W_min`) · V5 every chart carries responsive-safe config (`width:"container"`,
min-height token, `labelOverlap`, axis rotation, ≥44 pt interactive marks) ·
V6 primitive covered by the golden catalog (CI, not per-doc).

**Chart semantics (Rust + embedded real compiler):** S8 —
1. Rust semantic checks Vega-Lite's own schema misses: encoding `field`s exist in
   the chart's dataset; encoding-type ↔ column-type compatible; mark ↔ channel
   within our **profile subset**; every `param`/`filter` reference declared.
2. Then the **real `vl.compile()`** (bundled vega-lite, run in quickjs like KaTeX)
   must succeed. If it compiles in the checker, it compiles in the reader — because
   they are pinned to the **same version** (§10). A `tools/interactive-view-lint.ts`
   (mirroring `tools/mermaid-lint.ts`) runs full vega-lite under node as a
   delivery-gate second check.

**Data (Rust at sync, content-addressed):** the referenced blob is streaming-
validated to conform to the declared `columns` schema, and its client-ship size is
checked against a budget (§8). Schema mismatch / over-budget = **Error** severity
(like `json/parse-error`) → the document is held back, not shipped broken.

**The theorem.** If `check` passes, the renderer — consuming the checker's
**normalized IR** (parse-don't-validate: the IR exists only because it type-checked)
— has (a) a total rendering for every block/widget variant (exhaustive registry),
(b) every signal read resolving with the right type, (c) a terminating reactive
push (DAG + total evaluator), (d) a chart spec that compiles & runs (baked at sync,
§10), and (e) P at every screen (§4). ∴ no runtime type error, no dangling ref, no
divergence, no un-renderable/overflowing block — **without visual review.**

---

## 8. Data placement — rustfs mirrors the filesystem; (path, hash) addressing

Big chart data must not bloat the IR or break a phone. It lives as a
content leaf in **rustfs**, addressed to feel like the local filesystem:

**Three views share one structure** (only the host prefix differs):

| View | Path | Read by |
|---|---|---|
| Local working tree | `…/books/finance/data/returns.arrow` | **sync only** (the `/home` prefix) |
| rustfs object key | `finance/data/returns.arrow` | server at serve time |
| Document `source` (content-root absolute) | `/finance/data/returns.arrow` | checker + client |

**`source` is an absolute *content* path** (`/`-rooted, no `.`/`..`), never a host
FS path — the latter crash-loops under the unit's `ProtectHome` (see
`docs/lessons` 2026-06-03). The server serves **only from rustfs by (path, hash)**;
only sync touches `/home`.

**(path, hash) dual addressing** (fixes the atomicity trap of mutable path keys):
the document references data by **path *and* content hash**; rustfs retains the
object per hash under its human-readable path prefix, so multiple content versions
of a path coexist. During a deploy, an old document keeps reading its pinned hash
and a new one reads the new hash — **a referenced hash never 404s mid-deploy**.
The path stays filesystem-like (browsable); the hash restores snapshot consistency.
Cross-path dedup is traded for ETag revalidation (acceptable; path readability wins).

**Format:** Apache Arrow (`.arrow`) for large data (compact, Vega-Lite-native);
CSV/JSON allowed for small (existing `FileType::Csv/Json` validators). gzip at rest.

**Loading:** lazy per visible chart; blobs pinned for offline by the existing
native sync tiers (the `audio-store-durable-pinned-tier` model) so an offline book
keeps its charts. **Client-ship size budget** (checker-enforced, incl. offline pin
cost) turns "too big to load on mobile" into a compile error, not a runtime hang.

---

## 9. Runtime resilience — "data not found ⇒ degrade, never crash"

The checker owns deploy-time consistency; the renderer owns view-time survival.
Three always-on layers:

1. **Total reactive evaluator (§6):** a dataset that 404s / is offline-unpinned /
   corrupts resolves to `unavailable`; every dependent derived/metric/section shows
   `—` or a skeleton. No thrown exception reaches React.
2. **Per-block error boundary:** each rendered block is wrapped; a failure (even a
   renderer bug) collapses that one block to a fallback tile — **never a white
   screen**. One bad chart cannot take the report down.
3. **Fetch lifecycle UI:** skeleton → retry → "data unavailable" for each dataset
   and each pre-compiled chart spec. Offline is the *common* path on the native
   shell, so this is the main flow, not an edge case.

Audio follows the existing skip philosophy in **two tiers** (§10, §7 S10):
generation-time (pre-gen fails ⇒ block stays interactive, marked
`audio: unavailable`, non-fatal) and playback-time (asset 404s/won't decode ⇒
auto-advance via the existing `audio_ended`/error hooks, never stall).

---

## 10. Deploy pipeline — data first, atomic, pre-baked

Interactive View slots into `liveview sync` (Merkle-incremental, blake3). Within a
sync run the order is **data before documents**:

1. **Data first.** Ingest each referenced dataset → validate against its declared
   schema → hash → upload to rustfs under its path (content-addressed, so a repeat
   is a Merkle no-op). *Then* the document's hashes/schemas are known.
2. **Compile documents.** Bake each chart: run `vl.compile()` at sync and store the
   resulting **Vega runtime spec** in pg (exactly as markdown→HTML is baked,
   `apply_leaf` `run.rs:642`). The client then ships only the vega *runtime*, not
   the vega-lite compiler — smaller, and it executes the checker's own output.
3. **Atomic flip.** Nothing is live until `deploy_root` flips last (the existing
   contract; poll `deploy_root`, not `is-active`). The whole snapshot — documents +
   their data — is consistent at the instant it goes live. Unlike hour-long audio
   pre-gen, `vl.compile` + schema validation are fast, so they gate the deploy
   rather than deferring to a background worker.

**Version pinning (soundness-critical):** the checker's embedded vega-lite (quickjs)
and the client's vendored vega runtime are **one pinned version pair**, asserted at
startup (as KaTeX is pinned in both `Cargo.toml` and `web/public`). Baking vl→vega
at sync shrinks the client's version surface to the vega runtime alone.

---

## 11. Book lifecycle — update, cleanup, rollback

- **Update** = Merkle re-deploy: changed leaves re-upload, new snapshot, atomic
  flip. Data no longer referenced by the new snapshot becomes a GC *candidate* — not
  an immediate delete.
- **GC = mark-sweep / refcount over ALL retained deploy roots** (current + every
  rollback-retained generation). **Never** `rm -rf /finance/` by path prefix: data
  is cross-book-referenceable via absolute content paths, so a blob under one book's
  prefix may be reachable from another book or an older generation. Only blobs
  unreachable from *every* retained root are swept.
- **Delete a book** ⇒ its leaves become unreachable from the new root, but a shared
  blob survives until no retained root references it (protects shared data + the
  ability to roll back).
- **Rollback safety:** GC honoring retained generations means a rollback can never
  resurrect a document whose data was already swept.
- **Rename/move** data ⇒ the path index entry moves, the blob (by hash) dedups/stays;
  the document `source` must be updated in the same change or the checker flags a
  dangling reference at the next sync.
- **Mid-interaction update:** signal state is ephemeral client state; a new IR
  resets signals to their `init` (a half-dragged slider snaps back). Acceptable;
  noted so it is not surprising.

---

## 12. Web rendering — integration points

- New viewer `web/src/components/viewers/InteractiveViewViewer.tsx`, dispatched
  from `ContentViewer.tsx` on `file_type` (standalone files) and hydrated in
  `MarkdownViewer.tsx` `processContent` for the ` ```interactive-view ` fence
  (mirroring the mermaid path at `MarkdownViewer.tsx:302`).
- **Vendored, lazy-loaded** vega + vega-embed under `web/public/` via
  `ensureScript` (exactly like mermaid, ~comparable size, lazy). No `package.json`
  dep; consistent with the existing vendoring approach.
- **Reactive kernel** (~100 lines): signals + derived, topologically pushed (the
  checker guarantees a DAG, so no scheduler/heavy lib). Widgets write signals; each
  Vega `View` is wired both ways (`view.signal(name,v)` / `view.addSignalListener`);
  `section`/`metric` blocks subscribe and re-render their `{{}}` interpolations.
- Built on the shared design tokens / MUI theme (`conventions/ui.md`,
  liveview's own `useTheme`), so light/dark and the mobile chrome are inherited.

---

## 13. Verification — the demo book (all widgets, all states)

A **demo book** is the review artifact and the golden-catalog source. It is a book
in `examples/` (added to `examples/liveview.toml`) that exercises **every** widget,
every layout container, charts with linked selections, and every resilience state —
so a human review of *this one finite book* certifies the whole primitive alphabet
(§4). Contents:

1. `examples/interactive/all-widgets.interactive-view.json` — one standalone
   document instancing **every** widget in §5.1, each bound to a live signal shown
   back in a `section`/`metric`, so every control is visibly wired.
2. `examples/interactive/linked-charts.interactive-view.json` — two charts where a
   brush on one cross-filters the other (Vega-Lite linked views) plus a
   `rangeSlider` driving the same signal (proving chart-selection ≡ widget).
3. `examples/interactive/metrics-report.interactive-view.json` — the target use
   case: a technical-metrics explanation (prose + `metricGroup` + a chart) whose
   numbers update live from a slider; a `metric` with `audio.narrate`.
4. `examples/interactive/responsive-matrix.interactive-view.json` — `columns`,
   `tabs`, `metricGroup` at worst-case content, the fixture for the 320 px/1920 px
   golden shots.
5. `examples/interactive/resilience.interactive-view.json` — a chart pointing at a
   deliberately-absent dataset + one that loads, to demonstrate `unavailable`/`—`,
   the per-block fallback tile, and the audio skip — proving "not found ⇒ no crash."
6. `examples/interactive-views.md` — a prose page embedding ` ```interactive-view `
   fences, proving the in-markdown embedding path.

Review flow: `liveview preview` the demo book on a phone-width and desktop-width
viewport; `liveview check` must be clean; `liveview targets` feeds the golden shots.
A green `check` + the catalog goldens is the standing proof that any future
type-checking document needs no per-document visual review.

---

## 14. Phased implementation

1. **IR + Rust checker skeleton** (S1–S7, S9, S10, V1–V4) + `FileType::InteractiveView`
   registration + reactive kernel + the non-chart blocks (`section`, `metric`,
   `metricGroup`, inputs, `stack`, `columns`). Ships the Pluto layer (widgets ⇄
   signals ⇄ text) sound and mobile-first, **no charts yet**. Demo items 1 & 3.
2. **Vega-Lite** — vendor libs; `chart` block; S8 (Rust semantics + real
   `vl.compile` in quickjs); sync bakes vl→vega; version-pin assertion. Demo item 2.
3. **Data layer** — (path, hash) addressing in rustfs, schema-conformance + size
   budget at sync, lazy client fetch + offline pinning, `table` block. Demo item 5.
4. **Visual soundness hardening** — golden catalog via `liveview targets`, `tabs`,
   `responsive-matrix` fixture (item 4), the markdown fence path (item 6), and the
   full runtime-resilience layer (§9).

---

## 15. Open decisions (resolved to recommendations; change if you disagree)

- **Standalone file first**, fence second (one clean reactive + checker scope to
  start). ✅ assumed.
- **quickjs** for the embedded `vl.compile` (same stack as the `katex` crate). ✅
- **Bake vl→vega at sync** (smaller/safer client, executes the checker's output). ✅
- Name **Interactive View** (no abbreviations). ✅
