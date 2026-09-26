//! `liveview sync` orchestration — the git-driven incremental content deploy.
//!
//! Walks the resolved corpus, builds a Merkle DAG of its content, diffs it
//! against the last-deployed DAG (from `merkle_nodes`), and applies only the
//! difference: render changed markdown → pg, upload changed blobs → rustfs,
//! pre-generate changed audiobook chapters (edge-tts) → rustfs, delete what's
//! gone, GC orphaned blobs, then advance the deploy root. Re-running with no
//! source change is a no-op (the root matches and the diff is empty).
//!
//! Crash-safety: the deploy root is written last, so an interrupted run leaves
//! the old root in place and the next run re-reconciles from it (idempotent).

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use crate::config::{BookState, Layout, RenditionKind, Resolved};
use crate::server::renderer;
use crate::shared::FileType;
use crate::store::model::{AudioTask, AudioTaskUpsert, BookUpsert, ChapterRecord, ChapterState};
use crate::store::pg::PgStore;
use crate::sync::diff::{Plan, plan};
use crate::sync::merkle::{Build, Dag, Leaf, Node};
use crate::sync::objstore::ObjStore;

/// Identity-record separator inside a leaf `path` (round-trips on delete).
pub(crate) const SEP: char = '\u{1f}';

/// Connection + knobs for a sync run.
pub struct SyncCfg {
    pub database_url: String,
    pub s3_endpoint: String,
    pub s3_access_key: String,
    pub s3_secret_key: String,
    pub s3_bucket: String,
    pub tts_voice: Option<String>,
    /// Pre-generate the TEXT read-aloud audio for every markdown chapter (not just
    /// the audiobook rendition). Big one-time backfill; incremental thereafter.
    pub text_audio: bool,
    /// Bumped when the renderer changes, to force a full re-render.
    pub render_version: i32,
    /// Full-verify mode: treat every leaf as a candidate (each is still gated on
    /// its chapter row, so only drifted rows are re-applied) and additionally
    /// check baked audio marks against the current text. Row drift itself is
    /// reconciled on every sync. See `SyncArgs`.
    pub repair: bool,
    /// Re-render content (HTML rows) but DON'T (re)generate audio: skip the
    /// audio enqueue and keep each chapter's existing mp3/marks (via upsert
    /// COALESCE), marking changed leaves done immediately. For a change that
    /// didn't touch the spoken prose (e.g. a mermaid label) so a full re-synth
    /// would be pure waste. See `SyncArgs`.
    pub no_audio: bool,
}

#[derive(Debug, Default)]
pub struct SyncReport {
    pub books: usize,
    pub put: usize,
    /// Audio leaves enqueued for the background worker this run (sync no longer
    /// generates audio inline — it queues it for the in-server worker).
    pub enqueued: usize,
    /// Candidate leaves whose chapter row already held their content (applied by
    /// a prior, possibly interrupted, run) — skipped this run.
    pub skipped: usize,
    /// `--repair` only: chapters whose baked marks no longer matched their text
    /// (count desync) — the stale bake was dropped and the leaf re-enqueued.
    pub stale_audio: usize,
    pub deleted: usize,
    pub orphans_gc: usize,
    /// Content-check diagnostics found this run (warn-only — never blocks the
    /// deploy; logged so a broken book shows up without failing the sync).
    pub check_warnings: usize,
    pub root: String,
}

/// How to apply a content leaf — the side table the Merkle layer doesn't carry.
struct LeafApply {
    book_slug: String,
    rendition: String,
    lang: String,
    rel_path: String,
    file_type: FileType,
    source: PathBuf,
    /// `Some(voice)` ⇒ an audiobook `.spoken.md` (pre-generate mp3 + marks).
    voice: Option<String>,
    /// `Some(voice)` ⇒ a TEXT markdown chapter to pre-generate read-aloud audio
    /// for (units-driven synth, like the server's on-demand path). Set only when
    /// `cfg.text_audio` is on. Mutually exclusive with `voice` above.
    text_voice: Option<String>,
    /// blake3 of the source bytes (= the Merkle leaf hash input).
    content_hash: String,
}

pub(crate) fn leaf_path(slug: &str, rendition: &str, lang: &str, rel: &str) -> String {
    format!("{slug}{SEP}{rendition}{SEP}{lang}{SEP}{rel}")
}

fn is_text(ft: &FileType) -> bool {
    matches!(
        ft,
        FileType::Markdown
            | FileType::Html
            | FileType::Csv
            | FileType::Json
            | FileType::Excalidraw
            | FileType::Latex
            | FileType::Typst
            // A standalone `*.interactive-view.json` is a text document the client
            // renders (like json/html); it must be stored as rendered text, not a
            // binary blob, or `/api/file` serves empty content.
            | FileType::InteractiveView
    )
}

/// Hash the catalog-facing state that lives outside chapter leaves.
///
/// Native clients cache `/api/books` and `/api/tree` under the deploy root. If
/// this metadata is omitted from the DAG, changing artwork, labels, editions,
/// or layout leaves the root unchanged and a correct client can keep serving a
/// stale catalog forever. The marker built from this hash is structural (an
/// empty tree), so it invalidates manifests without pretending metadata is a
/// chapter that needs to be applied or deleted.
fn catalog_hash(
    book: &BookState,
    cover_hash: Option<&str>,
    backdrop_hash: Option<&str>,
    card_backdrop_hash: Option<&str>,
) -> String {
    fn field(hasher: &mut blake3::Hasher, value: &str) {
        hasher.update(&(value.len() as u64).to_le_bytes());
        hasher.update(value.as_bytes());
    }

    fn optional(hasher: &mut blake3::Hasher, value: Option<&str>) {
        match value {
            Some(value) => {
                hasher.update(b"some\0");
                field(hasher, value);
            }
            None => {
                hasher.update(b"none\0");
            }
        };
    }

    fn layout(hasher: &mut blake3::Hasher, value: &Layout) {
        hasher.update(b"layout\0");
        for entry in &value.order {
            field(hasher, entry);
        }
        let mut children: Vec<_> = value.subtree.iter().collect();
        children.sort_by(|a, b| a.0.cmp(b.0));
        for (name, child) in children {
            field(hasher, name);
            layout(hasher, child);
        }
    }

    let mut hasher = blake3::Hasher::new();
    // v4 removes the old build-time taxonomy from catalog identity. Discovery
    // metadata is now derived entirely from the author-owned tags hashed below.
    hasher.update(b"liveview-book-catalog-v4\0");
    field(&mut hasher, &book.slug);
    field(&mut hasher, &book.label);
    optional(&mut hasher, book.description.as_deref());
    for tag in &book.tags {
        field(&mut hasher, tag);
    }
    optional(&mut hasher, book.collection.as_deref());
    optional(&mut hasher, book.author.as_deref());
    optional(&mut hasher, cover_hash);
    optional(&mut hasher, backdrop_hash);
    optional(&mut hasher, card_backdrop_hash);
    field(&mut hasher, book.default_rendition.as_str());
    for rendition in &book.renditions {
        field(&mut hasher, rendition.kind.as_str());
        field(&mut hasher, &rendition.label);
        field(&mut hasher, &rendition.default_lang);
        optional(&mut hasher, rendition.voice.as_deref());
        field(
            &mut hasher,
            if rendition.manifest {
                "manifest"
            } else {
                "implicit"
            },
        );
        match &rendition.layout {
            Some(value) => layout(&mut hasher, value),
            None => {
                hasher.update(b"no-layout\0");
            }
        };
        for edition in &rendition.editions {
            field(&mut hasher, &edition.lang);
            field(&mut hasher, &edition.label);
        }
    }
    hasher.finalize().to_hex().to_string()
}

fn catalog_marker(hash: String) -> Build {
    // The digest is a child name because tree names are identity-bearing. The
    // empty subtree contributes no leaves to the reconcile apply/delete plan.
    Build::Tree(vec![(hash, Build::Tree(Vec::new()))])
}

/// Run a full reconcile. Returns the counts applied.
pub async fn run(resolved: &Resolved, cfg: &SyncCfg) -> Result<SyncReport, String> {
    let store = PgStore::open(&cfg.database_url)
        .await
        .map_err(|e| format!("connect pg: {e}"))?;
    store.migrate().await.map_err(|e| format!("migrate: {e}"))?;
    let obj = ObjStore::connect(
        &cfg.s3_endpoint,
        &cfg.s3_access_key,
        &cfg.s3_secret_key,
        &cfg.s3_bucket,
    );
    obj.ensure_bucket().await?;

    // ── Walk the corpus → structure rows + leaves + apply map. ──────────────
    let mut applies: BTreeMap<String, LeafApply> = BTreeMap::new();
    let mut book_nodes: Vec<(String, Build)> = Vec::new();
    let mut corpus_slugs: Vec<String> = Vec::new();
    // Warn-only content check, accumulated as we read each source file (the
    // SyncReport isn't built until after this walk). Folded into the report and
    // logged below; a non-zero count never fails the sync.
    let mut check_warnings = 0usize;

    for book in &resolved.books {
        corpus_slugs.push(book.slug.clone());

        // The voice text read-aloud uses for this book: its audiobook rendition's
        // voice if any, else the global default — same choice the server's
        // on-demand `ensure_text_audio` makes, so pre-gen ≡ on-demand output.
        let text_voice_for_book = book
            .renditions
            .iter()
            .find(|r| r.kind == RenditionKind::Audio)
            .and_then(|r| r.voice.clone())
            .or_else(|| cfg.tts_voice.clone());
        if cfg.text_audio && text_voice_for_book.is_none() {
            return Err(format!(
                "book {:?}: text-audio generation requires a rendition voice or --tts-voice",
                book.slug
            ));
        }

        // Cover → rustfs (content-addressed). Referenced by books.cover_hash, so
        // the orphan GC spares it (see orphan_asset_hashes).
        let cover_hash = match &book.cover {
            Some(p) => {
                let bytes =
                    std::fs::read(p).map_err(|e| format!("read cover {}: {e}", p.display()))?;
                let mime = mime_guess::from_path(p).first_or_octet_stream().to_string();
                Some(put_blob(&obj, &store, bytes, &mime).await?)
            }
            None => None,
        };
        let (backdrop_hash, card_backdrop_hash) = match &book.backdrop {
            Some(p) => {
                let bytes =
                    std::fs::read(p).map_err(|e| format!("read backdrop {}: {e}", p.display()))?;
                let card_bytes = crate::artwork::card_backdrop(&bytes)
                    .map_err(|e| format!("derive card backdrop {}: {e}", p.display()))?;
                let mime = mime_guess::from_path(p).first_or_octet_stream().to_string();
                let backdrop_hash = put_blob(&obj, &store, bytes, &mime).await?;
                let card_backdrop_hash = put_blob(&obj, &store, card_bytes, "image/jpeg").await?;
                (Some(backdrop_hash), Some(card_backdrop_hash))
            }
            None => (None, None),
        };
        store
            .upsert_book(&BookUpsert {
                slug: &book.slug,
                label: &book.label,
                description: book.description.as_deref(),
                tags: &book.tags,
                collection: book.collection.as_deref(),
                author: book.author.as_deref(),
                cover_hash: cover_hash.as_deref(),
                backdrop_hash: backdrop_hash.as_deref(),
                card_backdrop_hash: card_backdrop_hash.as_deref(),
                default_rendition: book.default_rendition.as_str(),
            })
            .await
            .map_err(|e| format!("upsert book {}: {e}", book.slug))?;

        let desired_renditions: Vec<String> = book
            .renditions
            .iter()
            .map(|rendition| rendition.kind.as_str().to_string())
            .collect();
        store
            .retain_renditions(&book.slug, &desired_renditions)
            .await
            .map_err(|e| format!("prune renditions {}: {e}", book.slug))?;

        let mut rendition_nodes: Vec<(String, Build)> = Vec::new();
        for (r_ord, rend) in book.renditions.iter().enumerate() {
            let r_kind = rend.kind.as_str();
            store
                .upsert_rendition(
                    &book.slug,
                    r_kind,
                    &rend.label,
                    &rend.default_lang,
                    rend.voice.as_deref(),
                    rend.manifest,
                    r_ord as i32,
                )
                .await
                .map_err(|e| format!("upsert rendition {}/{r_kind}: {e}", book.slug))?;

            let desired_editions: Vec<String> = rend
                .editions
                .iter()
                .map(|edition| edition.lang.clone())
                .collect();
            store
                .retain_editions(&book.slug, r_kind, &desired_editions)
                .await
                .map_err(|e| format!("prune editions {}/{r_kind}: {e}", book.slug))?;

            let mut edition_nodes: Vec<(String, Build)> = Vec::new();
            for (e_ord, ed) in rend.editions.iter().enumerate() {
                store
                    .upsert_edition(&book.slug, r_kind, &ed.lang, &ed.label, e_ord as i32)
                    .await
                    .map_err(|e| {
                        format!("upsert edition {}/{r_kind}/{}: {e}", book.slug, ed.lang)
                    })?;

                // Ingest this edition's read-aloud narration sidecar
                // (`<book_root>/.narration/<lang>.json`, a skill's output) into the
                // content-addressed `narration` table, so the text synth resolves
                // each non-prose resource's spoken text by key — no model in the
                // deploy path. Only the TEXT rendition has read-aloud narration;
                // idempotent (ON CONFLICT), so re-syncs are cheap no-ops.
                if r_kind == "text"
                    && let Some(book_root) = ed.source.parent()
                {
                    match crate::server::narration::Sidecar::load(book_root, &ed.lang) {
                        Ok(sc) => {
                            for (key, e) in &sc.entries {
                                store
                                    .upsert_narration(key, &e.kind, &ed.lang, &e.text)
                                    .await
                                    .map_err(|err| {
                                        format!("upsert narration {}/{}: {err}", book.slug, ed.lang)
                                    })?;
                            }
                        }
                        Err(e) => {
                            tracing::warn!("narration sidecar {}/{}: {e}", book.slug, ed.lang)
                        }
                    }
                }

                // Files included by this edition's globsets, relative to source.
                let mut files: Vec<(String, PathBuf)> = Vec::new();
                walk(&ed.source, &ed.source, ed, &mut files)?;
                files.sort_by(|a, b| a.0.cmp(&b.0));

                let mut leaf_nodes: Vec<(String, Build)> = Vec::new();
                for (rel, abs) in files {
                    let bytes =
                        std::fs::read(&abs).map_err(|e| format!("read {}: {e}", abs.display()))?;
                    let content_hash = blake3::hash(&bytes).to_hex().to_string();
                    let ft = FileType::from_path(&rel);

                    // Warn-only structural check on the bytes we just read. Logs
                    // each finding with its source location; never blocks deploy.
                    if let Ok(src) = std::str::from_utf8(&bytes) {
                        let dir = abs.parent().unwrap_or_else(|| Path::new("."));
                        for d in crate::check::check_source(&rel, src, dir, ft.clone()) {
                            tracing::warn!(
                                rule = %d.rule,
                                "check {}/{}/{} {}:{}:{}: {}",
                                book.slug, r_kind, ed.lang, d.file, d.line, d.col, d.message
                            );
                            check_warnings += 1;
                        }
                    }
                    let is_audio = rend.kind == RenditionKind::Audio && rel.ends_with(".spoken.md");
                    let voice = if is_audio {
                        Some(
                            rend.voice
                                .clone()
                                .or_else(|| cfg.tts_voice.clone())
                                .ok_or_else(|| {
                                    format!(
                                        "book {:?} audio rendition requires a voice or --tts-voice",
                                        book.slug
                                    )
                                })?,
                        )
                    } else {
                        None
                    };
                    // Text read-aloud pre-gen target: a markdown chapter of the
                    // text rendition, when enabled. (Never an audiobook chapter —
                    // that's `voice` above.)
                    let text_voice = (cfg.text_audio
                        && rend.kind == RenditionKind::Text
                        && matches!(&ft, FileType::Markdown))
                    .then(|| text_voice_for_book.clone())
                    .flatten();

                    // Leaf kind folds the transform + version so a renderer or
                    // voice change re-applies the leaf even with identical source.
                    // A text-audio leaf folds its voice too, so enabling pre-gen
                    // (or changing the voice) re-applies the leaf and backfills it.
                    let kind = if is_audio {
                        format!(
                            "audio:{}:{}:{}",
                            cfg.render_version,
                            voice.as_deref().unwrap_or(""),
                            crate::AUDIO_ENCODING_VERSION,
                        )
                    } else if let Some(tv) = &text_voice {
                        format!(
                            "text:{}:tts:{tv}:{}",
                            cfg.render_version,
                            crate::AUDIO_ENCODING_VERSION
                        )
                    } else if is_text(&ft) {
                        format!("text:{}", cfg.render_version)
                    } else {
                        "asset".to_string()
                    };

                    let path = leaf_path(&book.slug, r_kind, &ed.lang, &rel);
                    leaf_nodes.push((
                        rel.clone(),
                        Build::Leaf {
                            path: path.clone(),
                            kind,
                            content_hash: content_hash.clone(),
                        },
                    ));
                    applies.insert(
                        path,
                        LeafApply {
                            book_slug: book.slug.clone(),
                            rendition: r_kind.to_string(),
                            lang: ed.lang.clone(),
                            rel_path: rel,
                            file_type: ft,
                            source: abs,
                            voice,
                            text_voice,
                            content_hash,
                        },
                    );
                }
                edition_nodes.push((ed.lang.clone(), Build::Tree(leaf_nodes)));
            }
            rendition_nodes.push((r_kind.to_string(), Build::Tree(edition_nodes)));
        }
        rendition_nodes.push((
            "@catalog".to_string(),
            catalog_marker(catalog_hash(
                book,
                cover_hash.as_deref(),
                backdrop_hash.as_deref(),
                card_backdrop_hash.as_deref(),
            )),
        ));
        book_nodes.push((book.slug.clone(), Build::Tree(rendition_nodes)));
    }

    let new = Dag::build(Build::Tree(book_nodes));

    // Store the sidebar forest now — it's cheap, filesystem-derived, and
    // independent of the slow content apply below, so the reader's sidebar works
    // as soon as a sync starts (even while audiobook TTS backfills for minutes).
    for kind in [RenditionKind::Text, RenditionKind::Audio] {
        let tree = crate::server::tree::build_virtual_tree(&resolved.books, kind);
        let json = serde_json::to_string(&tree).map_err(|e| format!("encode tree: {e}"))?;
        store
            .set_site_tree(kind.as_str(), &json)
            .await
            .map_err(|e| format!("set site_tree {}: {e}", kind.as_str()))?;
    }

    // ── Load the last-deployed DAG + the live chapter rows, and plan. ────────
    //
    // The Merkle diff names what changed since the last deploy, but the
    // chapters table is the truth of what is actually served. Stored Merkle
    // nodes only say "this leaf was applied at some point": an A→B→A revert
    // finds A's old node, and a lost row keeps its node. So every candidate
    // leaf is gated on its ROW (see `row_current`), and the plan is widened by
    // any leaf whose row drifted from the corpus. Deletes are likewise computed
    // from rows (actual − expected), so rows the stored DAG never recorded (an
    // audio leaf deleted before its node was committed) are removed too.
    let stored = load_stored(&store).await?;
    let rows = load_rows(&store).await?;
    let leaves = leaves_by_path(&new);
    let diff = plan(&new, &stored);
    let put = put_candidates(&leaves, &diff, &applies, &rows, cfg)?;
    let extra: Vec<&ChapterState> = rows
        .iter()
        .filter(|(path, _)| !leaves.contains_key(path.as_str()))
        .map(|(_, row)| row)
        .collect();
    let drifted = put.len().saturating_sub(diff.put.len());
    if !cfg.repair && (drifted > 0 || extra.len() > diff.delete.len()) {
        tracing::warn!(
            drifted,
            extra_rows = extra.len(),
            "chapter rows differ from the deployed Merkle state; reconciling"
        );
    }

    // ── Stamp book deploy-times. created_at on a book's first appearance;
    // updated_at on each sync where its subtree hash differs from the last
    // deploy (the root's per-book child hash). Pure pg metadata. ─────────────
    {
        let now = crate::store::pg::now_millis();
        let root_children =
            |dag: &crate::sync::merkle::Dag| -> std::collections::HashMap<String, String> {
                match dag.nodes.get(&dag.root) {
                    Some(crate::sync::merkle::Node::Tree(c)) => c.iter().cloned().collect(),
                    _ => std::collections::HashMap::new(),
                }
            };
        let new_books = root_children(&new);
        let stored_books = root_children(&stored);
        for (slug, hash) in &new_books {
            let changed = stored_books.get(slug) != Some(hash);
            store
                .mark_book(slug, now, changed)
                .await
                .map_err(|e| format!("mark book {slug}: {e}"))?;
        }
    }

    // ── Apply. ──────────────────────────────────────────────────────────────
    let mut report = SyncReport {
        books: resolved.books.len(),
        check_warnings,
        ..Default::default()
    };
    if check_warnings > 0 {
        tracing::warn!(
            "content check: {check_warnings} diagnostic(s) across the corpus \
             (warn-only — deploy continues; run `liveview check <dir>` for details)"
        );
    }
    // Fast pass: structure + text + binaries + audio chapter ROWS (no mp3 yet),
    // so the reader is fully navigable in seconds.
    apply_plan(
        &put,
        &extra,
        &applies,
        &rows,
        &store,
        &obj,
        cfg,
        &mut report,
    )
    .await?;
    // Audio is no longer generated here — sync only ENQUEUES each audio leaf
    // that lacks current audio onto the `audio_tasks` queue. The in-server
    // worker drains it in the background (so this oneshot returns in seconds and
    // never blocks the deploy; the on-demand HTTP fallback still covers a
    // chapter requested before its task runs). `cfg.text_audio` still gates
    // whether text read-aloud is queued. --no-audio skips this entirely:
    // existing mp3/marks are preserved (upsert COALESCE).
    if !cfg.no_audio {
        enqueue_audio(&leaves, &applies, &store, &obj, cfg, &mut report).await?;
    }
    store
        .delete_orphan_audio_tasks()
        .await
        .map_err(|e| format!("delete orphan audio tasks: {e}"))?;

    // Persist the TREE Merkle nodes. Leaf nodes are committed per-leaf as their
    // content lands (audio leaves only after their mp3), so an interrupted run
    // resumes instead of marking un-generated audio as done.
    for (hash, node) in &new.nodes {
        if matches!(node, crate::sync::merkle::Node::Leaf(_)) {
            continue;
        }
        let (kind, payload) = encode_node(node);
        store
            .put_merkle_node(hash, kind, &payload)
            .await
            .map_err(|e| format!("put merkle node: {e}"))?;
    }

    // Prune books dropped from the corpus (cascades renditions/editions,
    // chapters, and audio tasks; the chapters were normally already deleted as
    // extra rows above).
    for slug in store.book_slugs().await.map_err(|e| e.to_string())? {
        if !corpus_slugs.contains(&slug) {
            store.delete_book(&slug).await.map_err(|e| e.to_string())?;
        }
    }

    // GC blobs no chapter references anymore (in pg and rustfs).
    for hash in store
        .orphan_asset_hashes()
        .await
        .map_err(|e| e.to_string())?
    {
        obj.delete(&hash).await?;
        store.delete_asset(&hash).await.map_err(|e| e.to_string())?;
        report.orphans_gc += 1;
    }

    // Advance the root LAST — crash before this and the next run re-reconciles.
    store
        .set_deploy_root(&new.root)
        .await
        .map_err(|e| format!("set deploy root: {e}"))?;
    // Nodes of superseded deploys are dead weight once the new root is live
    // (nothing trusts a node as "applied" anymore). Best-effort: a failure only
    // leaves garbage for the next run.
    let keep: Vec<String> = new.nodes.keys().cloned().collect();
    if let Err(e) = store.prune_merkle_nodes(&keep).await {
        tracing::warn!(error = %e, "prune superseded merkle nodes failed");
    }
    report.root = new.root;

    // The content is committed at this point, but clients must not be told the
    // deploy completed cleanly if the running server could not be nudged to
    // reload its catalog. Re-running sync is idempotent and retries this signal.
    store
        .notify_reload()
        .await
        .map_err(|e| format!("content committed but reload notification failed: {e}"))?;
    Ok(report)
}

/// Recursively collect files under `root` that this edition includes, keyed by
/// path relative to the edition source.
pub(crate) fn walk(
    root: &Path,
    dir: &Path,
    ed: &crate::config::EditionState,
    out: &mut Vec<(String, PathBuf)>,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("read dir {}: {e}", dir.display()))?;
    for entry in entries.filter_map(Result::ok) {
        let abs = entry.path();
        let Ok(rel_path) = abs.strip_prefix(root) else {
            continue;
        };
        let rel = rel_path.to_string_lossy().replace('\\', "/");
        if ed.exclude_set.is_match(&rel) {
            continue;
        }
        if abs.is_dir() {
            walk(root, &abs, ed, out)?;
        } else if ed.include_set.is_match(&rel) {
            out.push((rel, abs));
        }
    }
    Ok(())
}

/// Chapter rows keyed by their leaf path.
async fn load_rows(store: &PgStore) -> Result<HashMap<String, ChapterState>, String> {
    Ok(store
        .chapter_states()
        .await
        .map_err(|e| format!("load chapter rows: {e}"))?
        .into_iter()
        .map(|row| {
            (
                leaf_path(&row.book_slug, &row.rendition, &row.lang, &row.rel_path),
                row,
            )
        })
        .collect())
}

/// Every content leaf of `dag`, keyed (and so ordered) by leaf path.
fn leaves_by_path(dag: &Dag) -> BTreeMap<String, &Leaf> {
    dag.nodes
        .values()
        .filter_map(|node| match node {
            Node::Leaf(l) => Some((l.path.clone(), l)),
            Node::Tree(_) => None,
        })
        .collect()
}

/// Whether a chapter row already holds this leaf's content: same source bytes
/// and, for rendered (text / audiobook script) rows, the same renderer version.
/// Binary assets are not rendered, so a renderer bump leaves them current.
fn row_current(
    row: Option<&ChapterState>,
    content_hash: &str,
    rendered: bool,
    render_version: i32,
) -> bool {
    row.is_some_and(|row| {
        row.content_hash == content_hash && (!rendered || row.render_version == render_version)
    })
}

fn leaf_row_current(
    a: &LeafApply,
    rows: &HashMap<String, ChapterState>,
    path: &str,
    cfg: &SyncCfg,
) -> bool {
    let rendered = a.voice.is_some() || is_text(&a.file_type);
    row_current(
        rows.get(path),
        &a.content_hash,
        rendered,
        cfg.render_version,
    )
}

/// The leaves to (re)apply: every leaf under `--repair`, otherwise the Merkle
/// diff's puts plus any leaf whose row drifted from the corpus. Path-ordered.
fn put_candidates(
    leaves: &BTreeMap<String, &Leaf>,
    diff: &Plan,
    applies: &BTreeMap<String, LeafApply>,
    rows: &HashMap<String, ChapterState>,
    cfg: &SyncCfg,
) -> Result<Vec<Leaf>, String> {
    let mut put: BTreeMap<&str, &Leaf> = diff.put.iter().map(|l| (l.path.as_str(), l)).collect();
    for (path, leaf) in leaves {
        let a = applies
            .get(path)
            .ok_or_else(|| format!("internal: no apply for {path}"))?;
        if cfg.repair || !leaf_row_current(a, rows, path, cfg) {
            put.insert(path.as_str(), leaf);
        }
    }
    Ok(put.into_values().cloned().collect())
}

// Each argument is a distinct piece of reconcile state; bundling them into a
// struct for this single call site would only add indirection.
#[allow(clippy::too_many_arguments)]
async fn apply_plan(
    put: &[Leaf],
    extra: &[&ChapterState],
    applies: &BTreeMap<String, LeafApply>,
    rows: &HashMap<String, ChapterState>,
    store: &PgStore,
    obj: &ObjStore,
    cfg: &SyncCfg,
    report: &mut SyncReport,
) -> Result<(), String> {
    for leaf in put {
        let a = applies
            .get(&leaf.path)
            .ok_or_else(|| format!("internal: no apply for {}", leaf.path))?;
        // Resume + revert safety: skip only when the ROW already holds this
        // leaf's content (a prior, possibly interrupted, run applied it). A
        // Merkle node alone proves nothing — it survives a later edit, so an
        // A→B→A revert would otherwise keep serving B.
        if leaf_row_current(a, rows, &leaf.path, cfg) {
            report.skipped += 1;
            continue;
        }
        apply_leaf(a, store, obj, cfg).await?;
        // Audio chapters (audiobook OR text read-aloud pre-gen) land their row
        // here; their Merkle node is committed by the worker once the audio is
        // generated. Leaves with no audio are fully applied → commit now. Under
        // --no-audio the existing mp3/marks are kept via upsert COALESCE, so an
        // audio leaf IS fully applied here too.
        if cfg.no_audio || (a.voice.is_none() && a.text_voice.is_none()) {
            commit_leaf(store, leaf, &crate::sync::merkle::leaf_hash(leaf)).await?;
            report.put += 1;
        }
    }
    // Rows the corpus no longer declares — whether or not the stored DAG ever
    // recorded their leaf — are deleted together with their audio task.
    for row in extra {
        store
            .delete_chapter(&row.book_slug, &row.rendition, &row.lang, &row.rel_path)
            .await
            .map_err(|e| {
                format!(
                    "delete chapter {}/{}/{}/{}: {e}",
                    row.book_slug, row.rendition, row.lang, row.rel_path
                )
            })?;
        report.deleted += 1;
    }
    Ok(())
}

/// Record a leaf's Merkle node — the "this leaf is fully applied" commit marker.
async fn commit_leaf(store: &PgStore, leaf: &Leaf, node_hash: &str) -> Result<(), String> {
    let payload = serde_json::json!({
        "path": leaf.path, "kind": leaf.kind, "content_hash": leaf.content_hash
    })
    .to_string();
    store
        .put_merkle_node(node_hash, "leaf", &payload)
        .await
        .map_err(|e| format!("commit leaf node: {e}"))
}

/// Enqueue each audio leaf without current audio onto the `audio_tasks` queue
/// for the in-server worker (`server::audio_worker`). Covers BOTH the audiobook
/// rendition (`voice`) and — when `cfg.text_audio` is on — the text read-aloud
/// (`text_voice`). The task carries the leaf's `kind` + `content_hash` so the
/// worker can commit the exact Merkle node when it finishes.
///
/// Decided from in-memory state (rows re-read after the apply pass + every
/// task), not a per-leaf node lookup: a leaf whose row already carries audio
/// for this content is done; a leaf whose identical task already exists is
/// left alone (queued / running / done-silent / failed-until-retry). Every
/// other audio leaf is (re)queued — including one whose task was lost.
async fn enqueue_audio(
    leaves: &BTreeMap<String, &Leaf>,
    applies: &BTreeMap<String, LeafApply>,
    store: &PgStore,
    obj: &ObjStore,
    cfg: &SyncCfg,
    report: &mut SyncReport,
) -> Result<(), String> {
    let rows = load_rows(store).await?;
    let tasks: HashMap<String, AudioTask> = store
        .all_audio_tasks()
        .await
        .map_err(|e| format!("load audio tasks: {e}"))?
        .into_iter()
        .map(|t| {
            (
                leaf_path(&t.book_slug, &t.rendition, &t.lang, &t.rel_path),
                t,
            )
        })
        .collect();
    for (path, leaf) in leaves {
        let a = applies
            .get(path)
            .ok_or_else(|| format!("internal: no apply for {path}"))?;
        let voice = match (&a.voice, &a.text_voice) {
            (Some(v), _) | (_, Some(v)) => v.clone(),
            _ => continue, // not an audio leaf
        };
        let row = rows.get(path);
        let mut baked = row.is_some_and(|r| {
            r.content_hash == a.content_hash && r.audio_hash.is_some() && r.marks_hash.is_some()
        });
        let mut force = false;
        // Under --repair, verify the baked marks STILL match the current text: a
        // chapter edited after its bake could keep its old audio/marks (the
        // pre-fix upsert COALESCE), so the marks describe the PREVIOUS sentence
        // segmentation while /api/spoken serves the new one → the read-along
        // highlight lands on the wrong paragraph. Forget the stale bake and
        // force a re-queue (an identical `done` task would otherwise stay done).
        if baked && cfg.repair && audio_marks_stale(store, obj, a).await? {
            store
                .clear_chapter_audio(&a.book_slug, &a.rendition, &a.lang, &a.rel_path)
                .await
                .map_err(|e| e.to_string())?;
            report.stale_audio += 1;
            tracing::warn!(path = %leaf.path, "repair: stale audio marks — re-baking");
            baked = false;
            force = true;
        }
        if baked {
            continue;
        }
        let same_task = tasks
            .get(path)
            .is_some_and(|t| t.content_hash == a.content_hash && t.leaf_kind == leaf.kind);
        if same_task && !force {
            continue;
        }
        store
            .enqueue_audio_task(&AudioTaskUpsert {
                book_slug: &a.book_slug,
                rendition: &a.rendition,
                lang: &a.lang,
                rel_path: &a.rel_path,
                content_hash: &a.content_hash,
                leaf_kind: &leaf.kind,
                voice: &voice,
                priority: 0, // backfill; an on-demand request promotes to 100
                force,
            })
            .await
            .map_err(|e| format!("enqueue audio {}: {e}", a.rel_path))?;
        report.enqueued += 1;
    }
    Ok(())
}

/// True when a chapter's baked timing marks no longer match its current text: the
/// number of marks differs from the number of segments the reader renders (audio
/// rendition = `spoken_sentences`; text read-aloud = `spoken_units`). A count
/// mismatch is a definitive desync — an inserted / removed / reordered segment
/// shifts every `data-sent` index against the marks, so the highlight tracks the
/// wrong paragraph. Same-count edits (a reworded sentence) mis-TIME but don't
/// index-shift; they aren't caught here and are covered going forward by
/// `upsert_chapter`'s content-change guard. Only consulted under `--repair`.
async fn audio_marks_stale(store: &PgStore, obj: &ObjStore, a: &LeafApply) -> Result<bool, String> {
    let Some(row) = store
        .get_chapter(&a.book_slug, &a.rendition, &a.lang, &a.rel_path)
        .await
        .map_err(|e| e.to_string())?
    else {
        return Ok(false); // row gone — apply_plan's repair path handles that case
    };
    let Some(marks_hash) = row.marks_hash else {
        return Ok(false); // not baked yet — the normal enqueue path will bake it
    };
    let md = row.markdown.unwrap_or_default();
    let expected = if a.rendition == "audio" {
        crate::server::spoken::spoken_sentences(&md).len()
    } else {
        crate::server::spoken::spoken_units(&md).len()
    };
    let bytes = obj.get(&marks_hash).await.map_err(|e| e.to_string())?;
    // Count-only decode: the marks blob is a JSON array; we don't need the Mark
    // shape here, just its length against the segment count.
    let marks: Vec<serde_json::Value> =
        serde_json::from_slice(&bytes).map_err(|e| format!("decode marks: {e}"))?;
    Ok(marks.len() != expected)
}

async fn apply_leaf(
    a: &LeafApply,
    store: &PgStore,
    obj: &ObjStore,
    cfg: &SyncCfg,
) -> Result<(), String> {
    let mut row = ChapterRecord {
        book_slug: a.book_slug.clone(),
        rendition: a.rendition.clone(),
        lang: a.lang.clone(),
        rel_path: a.rel_path.clone(),
        file_type: file_type_tag(&a.file_type).to_string(),
        html: None,
        markdown: None,
        asset_hash: None,
        audio_hash: None,
        marks_hash: None,
        content_hash: a.content_hash.clone(),
        render_version: cfg.render_version,
    };

    if a.voice.is_some() {
        // Audiobook chapter — FAST pass: store the script (html + md) now so the
        // chapter exists and the reader can navigate to it. The mp3 + marks are
        // generated by the slow audio pass (`generate_audio`) or lazily by the
        // server on first play; audio_hash/marks_hash stay NULL until then.
        let src = std::fs::read_to_string(&a.source)
            .map_err(|e| format!("read {}: {e}", a.source.display()))?;
        row.html = Some(renderer::render_markdown(&src));
        row.markdown = Some(src);
    } else if is_text(&a.file_type) {
        let src = std::fs::read_to_string(&a.source)
            .map_err(|e| format!("read {}: {e}", a.source.display()))?;
        row.html = Some(renderer::render_file(&src, &a.file_type));
        row.markdown = Some(src);
    } else {
        // Binary asset: bytes → rustfs (key = its blake3 = the leaf hash).
        let bytes =
            std::fs::read(&a.source).map_err(|e| format!("read {}: {e}", a.source.display()))?;
        let mime = mime_guess::from_path(&a.rel_path)
            .first_or_octet_stream()
            .to_string();
        let hash = put_blob(obj, store, bytes, &mime).await?;
        row.asset_hash = Some(hash);
    }

    store
        .upsert_chapter(&row)
        .await
        .map_err(|e| format!("upsert chapter {}: {e}", a.rel_path))
}

/// Upload `bytes` to rustfs under their blake3 (content-addressed, skip if
/// present) and record the asset row. Returns the content hash.
async fn put_blob(
    obj: &ObjStore,
    store: &PgStore,
    bytes: Vec<u8>,
    mime: &str,
) -> Result<String, String> {
    let hash = blake3::hash(&bytes).to_hex().to_string();
    let size = bytes.len() as i64;
    obj.put_if_absent(&hash, bytes, mime).await?;
    store
        .upsert_asset(&hash, mime, size)
        .await
        .map_err(|e| format!("upsert asset {hash}: {e}"))?;
    Ok(hash)
}

fn file_type_tag(ft: &FileType) -> &'static str {
    match ft {
        FileType::Markdown => "markdown",
        FileType::Image => "image",
        FileType::Pdf => "pdf",
        FileType::Html => "html",
        FileType::Csv => "csv",
        FileType::Json => "json",
        FileType::Excalidraw => "excalidraw",
        FileType::Latex => "latex",
        FileType::Typst => "typst",
        FileType::InteractiveView => "interactive-view",
        FileType::Unknown => "unknown",
    }
}

/// Reconstruct the last-deployed DAG from `merkle_nodes` + the deploy root.
async fn load_stored(store: &PgStore) -> Result<Dag, String> {
    let Some(root) = store.deploy_root().await.map_err(|e| e.to_string())? else {
        return Ok(Dag::default());
    };
    let mut nodes = std::collections::HashMap::new();
    for n in store.all_merkle_nodes().await.map_err(|e| e.to_string())? {
        nodes.insert(n.node_hash, decode_node(&n.kind, &n.payload)?);
    }
    Ok(Dag { root, nodes })
}

// Merkle node (de)serialization for the `merkle_nodes` table. Leaves carry
// their identity payload (path/kind/content_hash); trees carry sorted children.
fn encode_node(node: &crate::sync::merkle::Node) -> (&'static str, String) {
    use crate::sync::merkle::Node;
    match node {
        Node::Leaf(l) => (
            "leaf",
            serde_json::json!({"path": l.path, "kind": l.kind, "content_hash": l.content_hash})
                .to_string(),
        ),
        Node::Tree(children) => ("tree", serde_json::to_string(children).unwrap_or_default()),
    }
}

fn decode_node(kind: &str, payload: &str) -> Result<crate::sync::merkle::Node, String> {
    use crate::sync::merkle::Node;
    match kind {
        "leaf" => {
            let v: serde_json::Value =
                serde_json::from_str(payload).map_err(|e| format!("decode leaf: {e}"))?;
            Ok(Node::Leaf(Leaf {
                path: v["path"].as_str().unwrap_or_default().to_string(),
                kind: v["kind"].as_str().unwrap_or_default().to_string(),
                content_hash: v["content_hash"].as_str().unwrap_or_default().to_string(),
            }))
        }
        "tree" => {
            let children: Vec<(String, String)> =
                serde_json::from_str(payload).map_err(|e| format!("decode tree: {e}"))?;
            Ok(Node::Tree(children))
        }
        other => Err(format!("unknown merkle node kind {other:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Config, EditionState, RenditionState};
    use globset::GlobSetBuilder;
    use std::fs;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(prefix: &str) -> Self {
            let mut p = std::env::temp_dir();
            p.push(format!(
                "{prefix}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn catalog_test_book() -> BookState {
        let empty_globs = || GlobSetBuilder::new().build().unwrap();
        BookState {
            label: "Book".into(),
            slug: "book".into(),
            description: Some("Description".into()),
            tags: vec!["subject.natural-history".into()],
            collection: Some("Collection".into()),
            author: Some("Author".into()),
            cover: None,
            backdrop: None,
            default_rendition: RenditionKind::Text,
            renditions: vec![RenditionState {
                kind: RenditionKind::Text,
                label: "Read".into(),
                default_lang: "en".into(),
                voice: None,
                layout: None,
                manifest: true,
                editions: vec![EditionState {
                    lang: "en".into(),
                    label: "English".into(),
                    source: PathBuf::from("content"),
                    include_set: empty_globs(),
                    exclude_set: empty_globs(),
                }],
            }],
        }
    }

    #[test]
    fn catalog_artwork_changes_deploy_root_without_content_operations() {
        let book = catalog_test_book();
        let old = Dag::build(Build::Tree(vec![(
            book.slug.clone(),
            Build::Tree(vec![(
                "@catalog".into(),
                catalog_marker(catalog_hash(
                    &book,
                    Some("cover"),
                    Some("old-backdrop"),
                    Some("old-card-backdrop"),
                )),
            )]),
        )]));
        let new = Dag::build(Build::Tree(vec![(
            book.slug.clone(),
            Build::Tree(vec![(
                "@catalog".into(),
                catalog_marker(catalog_hash(
                    &book,
                    Some("cover"),
                    Some("new-backdrop"),
                    Some("new-card-backdrop"),
                )),
            )]),
        )]));

        assert_ne!(
            old.root, new.root,
            "backdrop identity must invalidate the catalog"
        );
        assert!(
            plan(&new, &old).is_empty(),
            "a catalog marker must not become a synthetic chapter operation"
        );

        let old_card = Dag::build(Build::Tree(vec![(
            book.slug.clone(),
            Build::Tree(vec![(
                "@catalog".into(),
                catalog_marker(catalog_hash(
                    &book,
                    Some("cover"),
                    Some("backdrop"),
                    Some("old-card"),
                )),
            )]),
        )]));
        let new_card = Dag::build(Build::Tree(vec![(
            book.slug.clone(),
            Build::Tree(vec![(
                "@catalog".into(),
                catalog_marker(catalog_hash(
                    &book,
                    Some("cover"),
                    Some("backdrop"),
                    Some("new-card"),
                )),
            )]),
        )]));
        assert_ne!(
            old_card.root, new_card.root,
            "card rendition identity must invalidate the catalog"
        );
    }

    #[test]
    fn catalog_tags_change_deploy_root_without_content_operations() {
        let mut old_book = catalog_test_book();
        let mut new_book = old_book.clone();
        old_book.tags = vec!["field-notes".into()];
        new_book.tags = vec!["field-notes".into(), "subject.ecology".into()];

        let old = Dag::build(Build::Tree(vec![(
            old_book.slug.clone(),
            Build::Tree(vec![(
                "@catalog".into(),
                catalog_marker(catalog_hash(&old_book, None, None, None)),
            )]),
        )]));
        let new = Dag::build(Build::Tree(vec![(
            new_book.slug.clone(),
            Build::Tree(vec![(
                "@catalog".into(),
                catalog_marker(catalog_hash(&new_book, None, None, None)),
            )]),
        )]));

        assert_ne!(
            old.root, new.root,
            "tag identity must invalidate the catalog"
        );
        assert!(
            plan(&new, &old).is_empty(),
            "tag metadata must not become a synthetic chapter operation"
        );
    }

    #[test]
    fn catalog_layout_hash_is_stable_across_map_insertion_order() {
        let mut left = catalog_test_book();
        let mut right = catalog_test_book();
        let a = Layout {
            order: vec!["01.md".into()],
            ..Default::default()
        };
        let b = Layout {
            order: vec!["02.md".into()],
            ..Default::default()
        };
        let mut left_layout = Layout::default();
        left_layout.subtree.insert("a".into(), a.clone());
        left_layout.subtree.insert("b".into(), b.clone());
        let mut right_layout = Layout::default();
        right_layout.subtree.insert("b".into(), b);
        right_layout.subtree.insert("a".into(), a);
        left.renditions[0].layout = Some(left_layout);
        right.renditions[0].layout = Some(right_layout);

        assert_eq!(
            catalog_hash(&left, None, None, None),
            catalog_hash(&right, None, None, None),
            "hash-map iteration order must not churn the deploy root"
        );
    }

    fn state(path: &str, content: &str, rv: i32, audio: bool) -> (String, ChapterState) {
        let key = leaf_path("b", "text", "en", path);
        (
            key,
            ChapterState {
                book_slug: "b".into(),
                rendition: "text".into(),
                lang: "en".into(),
                rel_path: path.into(),
                content_hash: content.into(),
                render_version: rv,
                audio_hash: audio.then(|| "a".into()),
                marks_hash: audio.then(|| "m".into()),
                audio_voice: None,
            },
        )
    }

    fn offline_cfg(repair: bool) -> SyncCfg {
        SyncCfg {
            database_url: String::new(),
            s3_endpoint: String::new(),
            s3_access_key: String::new(),
            s3_secret_key: String::new(),
            s3_bucket: String::new(),
            tts_voice: None,
            text_audio: false,
            render_version: 2,
            repair,
            no_audio: false,
        }
    }

    /// One-edition corpus of markdown chapters `(rel, content_hash)`.
    fn corpus(chapters: &[(&str, &str)]) -> (Dag, BTreeMap<String, LeafApply>) {
        let mut applies = BTreeMap::new();
        let mut leaves = Vec::new();
        for (rel, content) in chapters {
            let path = leaf_path("b", "text", "en", rel);
            leaves.push((
                (*rel).to_string(),
                Build::Leaf {
                    path: path.clone(),
                    kind: "text:2".into(),
                    content_hash: (*content).into(),
                },
            ));
            applies.insert(
                path,
                LeafApply {
                    book_slug: "b".into(),
                    rendition: "text".into(),
                    lang: "en".into(),
                    rel_path: (*rel).into(),
                    file_type: FileType::Markdown,
                    source: PathBuf::from(rel),
                    voice: None,
                    text_voice: None,
                    content_hash: (*content).into(),
                },
            );
        }
        (Dag::build(Build::Tree(leaves)), applies)
    }

    #[test]
    fn row_gate_requires_matching_content_and_render_version() {
        let (_, row) = state("00.md", "A", 2, false);
        assert!(row_current(Some(&row), "A", true, 2));
        // A→B→A: the row still holds B, whatever Merkle nodes survive.
        let (_, stale) = state("00.md", "B", 2, false);
        assert!(!row_current(Some(&stale), "A", true, 2));
        // Renderer bump re-renders text, but not unrendered binary assets.
        let (_, old_render) = state("00.md", "A", 1, false);
        assert!(!row_current(Some(&old_render), "A", true, 2));
        assert!(row_current(Some(&old_render), "A", false, 2));
        assert!(
            !row_current(None, "A", true, 2),
            "missing row is not applied"
        );
    }

    #[test]
    fn unchanged_root_still_reapplies_drifted_rows() {
        // Deployed DAG == corpus (empty diff), but one row reverted to stale
        // content and one row vanished: both must be re-applied.
        let (new, applies) = corpus(&[("00.md", "A"), ("01.md", "B"), ("02.md", "C")]);
        let rows: HashMap<_, _> = [
            state("00.md", "A", 2, false),
            state("01.md", "stale", 2, false),
        ]
        .into_iter()
        .collect();
        let leaves = leaves_by_path(&new);
        let diff = plan(&new, &new);
        assert!(diff.is_empty());
        let put = put_candidates(&leaves, &diff, &applies, &rows, &offline_cfg(false)).unwrap();
        let paths: Vec<_> = put.iter().map(|l| l.path.clone()).collect();
        assert_eq!(
            paths,
            vec![
                leaf_path("b", "text", "en", "01.md"),
                leaf_path("b", "text", "en", "02.md")
            ]
        );
        // Repair considers everything (the row gate then skips current rows).
        let all = put_candidates(&leaves, &diff, &applies, &rows, &offline_cfg(true)).unwrap();
        assert_eq!(all.len(), 3);
    }

    /// Build a `SyncCfg` from the gated env, or `None` to skip. Run with:
    ///   DATABASE_URL=postgres://draven@%2Frun%2Fpostgresql/liveview_test \
    ///   LIVEVIEW_TEST_S3=1 S3_ENDPOINT=http://127.0.0.1:9000 \
    ///   S3_ACCESS_KEY=$(sudo cat /var/lib/rustfs/access_key) \
    ///   S3_SECRET_KEY=$(sudo cat /var/lib/rustfs/secret_key) \
    ///   cargo test sync::run -- --ignored --test-threads=1
    fn cfg() -> Option<SyncCfg> {
        if std::env::var("LIVEVIEW_TEST_S3").ok().as_deref() != Some("1") {
            return None;
        }
        Some(SyncCfg {
            database_url: std::env::var("DATABASE_URL").ok()?,
            s3_endpoint: std::env::var("S3_ENDPOINT").ok()?,
            s3_access_key: std::env::var("S3_ACCESS_KEY").ok()?,
            s3_secret_key: std::env::var("S3_SECRET_KEY").ok()?,
            s3_bucket: "liveview-itest".to_string(),
            tts_voice: Some("en-US-AriaNeural".to_string()),
            text_audio: false,
            render_version: 1,
            repair: false,
            no_audio: false,
        })
    }

    async fn count(pool: &sqlx::PgPool, sql: &str) -> i64 {
        sqlx::query_scalar::<_, i64>(sql)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    #[ignore = "needs live pg + rustfs (LIVEVIEW_TEST_S3=1 + DATABASE_URL + S3_*)"]
    async fn incremental_reconcile_text_and_blob() {
        let Some(cfg) = cfg() else { return };

        // Ensure the schema exists (first run on a fresh db), then start clean.
        PgStore::open(&cfg.database_url)
            .await
            .unwrap()
            .migrate()
            .await
            .unwrap();
        let pool = sqlx::PgPool::connect(&cfg.database_url).await.unwrap();
        sqlx::query(
            "TRUNCATE books, renditions, editions, chapters, assets, merkle_nodes, \
             deploy_root, progress, settings, audio_tasks",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Temp corpus: one book, two markdown chapters + one binary asset.
        let dir = TempDir::new("liveview-itest");
        fs::write(
            dir.path().join("liveview.toml"),
            "[[book]]\nlabel = \"IT\"\nslug = \"it\"\nsource = \"content\"\n",
        )
        .unwrap();
        let content = dir.path().join("content");
        fs::create_dir_all(&content).unwrap();
        fs::write(content.join("00.md"), "# One\n\nhello").unwrap();
        fs::write(content.join("01.md"), "# Two\n\nworld").unwrap();
        fs::write(content.join("pic.png"), b"\x89PNG\r\nfake-bytes").unwrap();

        let toml = dir.path().join("liveview.toml");
        let resolved = Config::load(&toml).unwrap().resolve(dir.path()).unwrap();

        // 1) first sync puts all three leaves.
        let r = run(&resolved, &cfg).await.unwrap();
        assert_eq!(r.put, 3, "2 md + 1 png");
        assert_eq!(r.deleted, 0);
        assert_eq!(count(&pool, "SELECT count(*) FROM chapters").await, 3);
        assert_eq!(count(&pool, "SELECT count(*) FROM assets").await, 1);
        // Sidebar forest pre-built for both renditions; text tree names the book.
        assert_eq!(count(&pool, "SELECT count(*) FROM site_tree").await, 2);
        let tj: String = sqlx::query_scalar("SELECT json FROM site_tree WHERE rendition = 'text'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(tj.contains("it"), "text tree mentions the book: {tj}");

        // 2) re-run with no change is a no-op (Merkle root matches).
        let r = run(&resolved, &cfg).await.unwrap();
        assert_eq!((r.put, r.deleted, r.orphans_gc), (0, 0, 0), "idempotent");

        // 3) edit one chapter → only that leaf re-applies.
        fs::write(content.join("00.md"), "# One\n\nCHANGED").unwrap();
        let r = run(&resolved, &cfg).await.unwrap();
        assert_eq!((r.put, r.deleted), (1, 0), "only the edited chapter");

        // 3b) revert the edit (A→B→A): the surviving Merkle node of A must not
        // mask the re-apply — the row has to hold A again.
        fs::write(content.join("00.md"), "# One\n\nhello").unwrap();
        let r = run(&resolved, &cfg).await.unwrap();
        assert_eq!((r.put, r.deleted), (1, 0), "revert re-applies");
        let md: String =
            sqlx::query_scalar("SELECT markdown FROM chapters WHERE rel_path = '00.md'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(md, "# One\n\nhello");

        // 3c) delete then restore a chapter: the restore must re-create the row.
        fs::remove_file(content.join("01.md")).unwrap();
        let r = run(&resolved, &cfg).await.unwrap();
        assert_eq!((r.put, r.deleted), (0, 1), "chapter deleted");
        fs::write(content.join("01.md"), "# Two\n\nworld").unwrap();
        let r = run(&resolved, &cfg).await.unwrap();
        assert_eq!((r.put, r.deleted), (1, 0), "chapter restored");
        assert_eq!(count(&pool, "SELECT count(*) FROM chapters").await, 3);

        // 3d) row drift under an unchanged root: a lost row is re-applied and a
        // row the corpus never declared is deleted.
        sqlx::query("DELETE FROM chapters WHERE rel_path = '01.md'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO chapters (book_slug, rendition, lang, rel_path, file_type, content_hash)
             VALUES ('it', 'text', 'en', 'ghost.md', 'markdown', 'x')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let r = run(&resolved, &cfg).await.unwrap();
        assert_eq!((r.put, r.deleted), (1, 1), "drift reconciled");
        assert_eq!(count(&pool, "SELECT count(*) FROM chapters").await, 3);

        // 4) delete the image → chapter gone + its blob GC'd from pg + rustfs.
        fs::remove_file(content.join("pic.png")).unwrap();
        let r = run(&resolved, &cfg).await.unwrap();
        assert_eq!(r.deleted, 1, "the image chapter");
        assert_eq!(r.orphans_gc, 1, "the now-unreferenced blob");
        assert_eq!(count(&pool, "SELECT count(*) FROM chapters").await, 2);
        assert_eq!(count(&pool, "SELECT count(*) FROM assets").await, 0);

        // 5) settle.
        let r = run(&resolved, &cfg).await.unwrap();
        assert_eq!((r.put, r.deleted), (0, 0), "settled");
    }

    /// Fresh schema + empty tables + a one-book markdown corpus.
    async fn audio_fixture(cfg: &SyncCfg) -> (sqlx::PgPool, TempDir, Resolved) {
        PgStore::open(&cfg.database_url)
            .await
            .unwrap()
            .migrate()
            .await
            .unwrap();
        let pool = sqlx::PgPool::connect(&cfg.database_url).await.unwrap();
        sqlx::query(
            "TRUNCATE books, renditions, editions, chapters, assets, merkle_nodes, \
             deploy_root, progress, settings, audio_tasks",
        )
        .execute(&pool)
        .await
        .unwrap();
        let dir = TempDir::new("liveview-itest-audio");
        fs::write(
            dir.path().join("liveview.toml"),
            "[[book]]\nlabel = \"AU\"\nslug = \"au\"\nsource = \"content\"\n",
        )
        .unwrap();
        let content = dir.path().join("content");
        fs::create_dir_all(&content).unwrap();
        fs::write(content.join("00.md"), "# One\n\nhello").unwrap();
        fs::write(content.join("01.md"), "# Two\n\nworld").unwrap();
        let resolved = Config::load(&dir.path().join("liveview.toml"))
            .unwrap()
            .resolve(dir.path())
            .unwrap();
        (pool, dir, resolved)
    }

    #[tokio::test]
    #[ignore = "needs live pg + rustfs (LIVEVIEW_TEST_S3=1 + DATABASE_URL + S3_*)"]
    async fn unbaked_audio_leaf_deletion_removes_row_and_task() {
        let Some(mut cfg) = cfg() else { return };
        cfg.text_audio = true;
        let (pool, dir, resolved) = audio_fixture(&cfg).await;

        // Both chapters become text read-aloud leaves: rows land, tasks queue,
        // and (no worker runs here) no audio leaf node is ever committed.
        let r = run(&resolved, &cfg).await.unwrap();
        assert_eq!(r.enqueued, 2);
        assert_eq!(count(&pool, "SELECT count(*) FROM audio_tasks").await, 2);
        // An identical re-run does not re-queue what is already queued.
        let r = run(&resolved, &cfg).await.unwrap();
        assert_eq!(r.enqueued, 0);

        // Delete one chapter before its audio was ever baked: its row and task
        // must go even though the stored DAG never recorded its leaf.
        fs::remove_file(dir.path().join("content/01.md")).unwrap();
        let r = run(&resolved, &cfg).await.unwrap();
        assert_eq!(r.deleted, 1);
        assert_eq!(count(&pool, "SELECT count(*) FROM chapters").await, 1);
        assert_eq!(count(&pool, "SELECT count(*) FROM audio_tasks").await, 1);
    }
}
