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

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::config::{RenditionKind, Resolved};
use crate::server::{renderer, spoken};
use crate::shared::FileType;
use crate::store::pg::{ChapterRow, PgStore};
use crate::sync::diff::{plan, Plan};
use crate::sync::merkle::{Build, Dag, Leaf};
use crate::sync::objstore::ObjStore;

/// Identity-record separator inside a leaf `path` (round-trips on delete).
const SEP: char = '\u{1f}';

/// Connection + knobs for a sync run.
pub struct SyncCfg {
    pub database_url: String,
    pub s3_endpoint: String,
    pub s3_access_key: String,
    pub s3_secret_key: String,
    pub s3_bucket: String,
    pub tts_cmd: String,
    pub tts_voice: String,
    /// Pre-generate the TEXT read-aloud audio for every markdown chapter (not just
    /// the audiobook rendition). Big one-time backfill; incremental thereafter.
    pub text_audio: bool,
    /// Bumped when the renderer changes, to force a full re-render.
    pub render_version: i32,
}

#[derive(Debug, Default)]
pub struct SyncReport {
    pub books: usize,
    pub put: usize,
    /// Leaves a prior (interrupted) run already applied — skipped this run.
    pub skipped: usize,
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

fn leaf_path(slug: &str, rendition: &str, lang: &str, rel: &str) -> String {
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
    )
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
            .unwrap_or_else(|| cfg.tts_voice.clone());

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
        store
            .upsert_book(
                &book.slug,
                &book.label,
                book.description.as_deref(),
                book.collection.as_deref(),
                cover_hash.as_deref(),
                book.default_rendition.as_str(),
            )
            .await
            .map_err(|e| format!("upsert book {}: {e}", book.slug))?;

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

            let mut edition_nodes: Vec<(String, Build)> = Vec::new();
            for (e_ord, ed) in rend.editions.iter().enumerate() {
                store
                    .upsert_edition(&book.slug, r_kind, &ed.lang, &ed.label, e_ord as i32)
                    .await
                    .map_err(|e| {
                        format!("upsert edition {}/{r_kind}/{}: {e}", book.slug, ed.lang)
                    })?;

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
                    let voice = is_audio
                        .then(|| rend.voice.clone().unwrap_or_else(|| cfg.tts_voice.clone()));
                    // Text read-aloud pre-gen target: a markdown chapter of the
                    // text rendition, when enabled. (Never an audiobook chapter —
                    // that's `voice` above.)
                    let text_voice = (cfg.text_audio
                        && rend.kind == RenditionKind::Text
                        && matches!(&ft, FileType::Markdown))
                    .then(|| text_voice_for_book.clone());

                    // Leaf kind folds the transform + version so a renderer or
                    // voice change re-applies the leaf even with identical source.
                    // A text-audio leaf folds its voice too, so enabling pre-gen
                    // (or changing the voice) re-applies the leaf and backfills it.
                    let kind = if is_audio {
                        format!(
                            "audio:{}:{}",
                            cfg.render_version,
                            voice.as_deref().unwrap_or("")
                        )
                    } else if let Some(tv) = &text_voice {
                        format!("text:{}:tts:{tv}", cfg.render_version)
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

    // ── Load the last-deployed DAG and diff. ────────────────────────────────
    let stored = load_stored(&store).await?;
    let plan = plan(&new, &stored);

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
    apply_plan(&plan, &applies, &store, &obj, cfg, &mut report).await?;
    // Slow pass: generate the audiobook mp3 + marks (edge-tts). Resumable per
    // chapter; the server's on-demand fallback covers anything not reached.
    generate_audio(&plan, &applies, &store, &obj, cfg, &mut report).await?;

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

    // Prune books dropped from the corpus (cascades renditions/editions; their
    // chapters were already deleted via the plan).
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
    report.root = new.root;

    // Nudge a running server to reload its catalog (best-effort).
    let _ = store.notify_reload().await;
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

async fn apply_plan(
    plan: &Plan,
    applies: &BTreeMap<String, LeafApply>,
    store: &PgStore,
    obj: &ObjStore,
    cfg: &SyncCfg,
    report: &mut SyncReport,
) -> Result<(), String> {
    for leaf in &plan.put {
        // Optimistic resume: a leaf whose node is already recorded was applied by
        // a prior (possibly interrupted) run — skip its expensive re-apply (the
        // edge-tts audio especially). This makes the sync resumable per-leaf
        // instead of all-or-nothing.
        let node_hash = crate::sync::merkle::leaf_hash(leaf);
        if store
            .get_merkle_node(&node_hash)
            .await
            .map_err(|e| e.to_string())?
            .is_some()
        {
            report.skipped += 1;
            continue;
        }
        let a = applies
            .get(&leaf.path)
            .ok_or_else(|| format!("internal: no apply for {}", leaf.path))?;
        apply_leaf(a, store, obj, cfg).await?;
        // Audio chapters (audiobook OR text read-aloud pre-gen) land their row
        // here but commit their Merkle node only after the slow audio pass
        // generates the mp3 — so an interrupted run re-generates the audio rather
        // than treating it as done. Leaves with no audio are fully applied →
        // commit now (content first, node = marker).
        if a.voice.is_none() && a.text_voice.is_none() {
            commit_leaf(store, leaf, &node_hash).await?;
            report.put += 1;
        }
    }
    for leaf in &plan.delete {
        let parts: Vec<&str> = leaf.path.split(SEP).collect();
        if let [slug, rendition, lang, rel] = parts.as_slice() {
            store
                .delete_chapter(slug, rendition, lang, rel)
                .await
                .map_err(|e| format!("delete chapter {}: {e}", leaf.path))?;
            report.deleted += 1;
        }
    }
    Ok(())
}

/// Record a leaf's Merkle node — the "this leaf is fully applied" commit marker
/// that makes a re-run skip it.
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

/// Slow audio pass: for each chapter that needs audio and isn't yet generated
/// (its Merkle node is absent), synthesize mp3 + marks via edge-tts, store them in
/// rustfs, record them on the chapter, then commit the node. Resumable per
/// chapter. Covers BOTH the audiobook rendition (`voice`, sentence-level script
/// from the `.spoken.md`) and — when `cfg.text_audio` is on — the text read-aloud
/// (`text_voice`, unit-level synth of the displayed markdown, byte-for-byte the
/// same path the server's on-demand `ensure_text_audio` runs, so pre-gen ≡ lazy).
async fn generate_audio(
    plan: &Plan,
    applies: &BTreeMap<String, LeafApply>,
    store: &PgStore,
    obj: &ObjStore,
    cfg: &SyncCfg,
    report: &mut SyncReport,
) -> Result<(), String> {
    for leaf in &plan.put {
        let a = applies
            .get(&leaf.path)
            .ok_or_else(|| format!("internal: no apply for {}", leaf.path))?;
        if a.voice.is_none() && a.text_voice.is_none() {
            continue; // not an audio leaf
        }
        let node_hash = crate::sync::merkle::leaf_hash(leaf);
        if store
            .get_merkle_node(&node_hash)
            .await
            .map_err(|e| e.to_string())?
            .is_some()
        {
            continue; // already generated by a prior run
        }
        let src = std::fs::read_to_string(&a.source)
            .map_err(|e| format!("read {}: {e}", a.source.display()))?;

        let (mp3, marks, rendition) = if let Some(voice) = &a.voice {
            // Audiobook: the curated `.spoken.md` script, sentence by sentence.
            let sentences = spoken::spoken_sentences(&src);
            let (mp3, marks) =
                crate::server::audio::synthesize(&cfg.tts_cmd, voice, &sentences).await?;
            (mp3, marks, "audio")
        } else {
            // Text read-aloud: one clip per UNIT of the displayed markdown (prose
            // verbatim; non-prose optionally narrated, else a silent dwell), so the
            // mark index matches the in-place highlight — identical to on-demand.
            let voice = a.text_voice.as_deref().unwrap_or(cfg.tts_voice.as_str());
            let units = spoken::spoken_units(&src);
            if units.is_empty() {
                // Nothing speakable (e.g. a pure-code chapter): mark done with no
                // audio, so the sync doesn't retry it every run.
                commit_leaf(store, leaf, &node_hash).await?;
                continue;
            }
            let mut texts: Vec<String> = Vec::with_capacity(units.len());
            for u in &units {
                if u.kind == spoken::UnitKind::Prose {
                    texts.push(u.text.clone());
                } else {
                    texts.push(
                        crate::server::narrate::narrate(u.kind, &u.src, &a.lang)
                            .await
                            .unwrap_or_default(),
                    );
                }
            }
            // NON-fatal, unlike the audiobook above: text read-aloud pre-gen is an
            // optimization over the server's on-demand synth, so a TTS hiccup
            // during the whole-corpus backfill must NOT abort the content sync.
            // Skip (leaf stays uncommitted → retried next sync); on-demand covers
            // it meanwhile.
            let (mp3, marks) =
                match crate::server::audio::synthesize(&cfg.tts_cmd, voice, &texts).await {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::warn!(
                            "text-audio pre-gen {}/{}: {e} — leaving it to on-demand",
                            a.book_slug,
                            a.rel_path
                        );
                        continue;
                    }
                };
            (mp3, marks, "text")
        };

        let marks_json = serde_json::to_vec(&marks).map_err(|e| format!("encode marks: {e}"))?;
        let audio_hash = put_blob(obj, store, mp3, "audio/mpeg").await?;
        let marks_hash = put_blob(obj, store, marks_json, "application/json").await?;
        store
            .set_chapter_audio(
                &a.book_slug,
                rendition,
                &a.lang,
                &a.rel_path,
                &audio_hash,
                &marks_hash,
            )
            .await
            .map_err(|e| format!("set chapter audio {}: {e}", a.rel_path))?;
        commit_leaf(store, leaf, &node_hash).await?;
        report.put += 1;
    }
    Ok(())
}

async fn apply_leaf(
    a: &LeafApply,
    store: &PgStore,
    obj: &ObjStore,
    cfg: &SyncCfg,
) -> Result<(), String> {
    let mut row = ChapterRow {
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
    use crate::config::Config;
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
            tts_cmd: "edge-tts".to_string(),
            tts_voice: "zh-CN-XiaoxiaoNeural".to_string(),
            text_audio: false,
            render_version: 1,
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
             deploy_root, progress, settings",
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
}
