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

    for book in &resolved.books {
        corpus_slugs.push(book.slug.clone());

        // Cover → rustfs (content-addressed). Referenced by books.cover_hash, so
        // the orphan GC spares it (see orphan_asset_hashes).
        let cover_hash = match &book.cover {
            Some(p) => {
                let bytes = std::fs::read(p).map_err(|e| format!("read cover {}: {e}", p.display()))?;
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
                    .map_err(|e| format!("upsert edition {}/{r_kind}/{}: {e}", book.slug, ed.lang))?;

                // Files included by this edition's globsets, relative to source.
                let mut files: Vec<(String, PathBuf)> = Vec::new();
                walk(&ed.source, &ed.source, ed, &mut files)?;
                files.sort_by(|a, b| a.0.cmp(&b.0));

                let mut leaf_nodes: Vec<(String, Build)> = Vec::new();
                for (rel, abs) in files {
                    let bytes = std::fs::read(&abs)
                        .map_err(|e| format!("read {}: {e}", abs.display()))?;
                    let content_hash = blake3::hash(&bytes).to_hex().to_string();
                    let ft = FileType::from_path(&rel);
                    let is_audio = rend.kind == RenditionKind::Audio && rel.ends_with(".spoken.md");
                    let voice = is_audio
                        .then(|| rend.voice.clone().unwrap_or_else(|| cfg.tts_voice.clone()));

                    // Leaf kind folds the transform + version so a renderer or
                    // voice change re-applies the leaf even with identical source.
                    let kind = if is_audio {
                        format!("audio:{}:{}", cfg.render_version, voice.as_deref().unwrap_or(""))
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

    // ── Apply. ──────────────────────────────────────────────────────────────
    let mut report = SyncReport {
        books: resolved.books.len(),
        ..Default::default()
    };
    apply_plan(&plan, &applies, &store, &obj, cfg, &mut report).await?;

    // Persist the new Merkle nodes (content-addressed → stable, idempotent).
    for (hash, node) in &new.nodes {
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
    for hash in store.orphan_asset_hashes().await.map_err(|e| e.to_string())? {
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
fn walk(
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
        // Commit the leaf node AFTER its content lands (content first, node =
        // the commit marker), so an interrupted run resumes here.
        let payload = serde_json::json!({
            "path": leaf.path, "kind": leaf.kind, "content_hash": leaf.content_hash
        })
        .to_string();
        store
            .put_merkle_node(&node_hash, "leaf", &payload)
            .await
            .map_err(|e| format!("commit leaf node: {e}"))?;
        report.put += 1;
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

    if let Some(voice) = &a.voice {
        // Audiobook chapter: store the script (html+md) and pre-generate audio.
        let src = std::fs::read_to_string(&a.source)
            .map_err(|e| format!("read {}: {e}", a.source.display()))?;
        row.html = Some(renderer::render_markdown(&src));
        row.markdown = Some(src.clone());
        let sentences = spoken::spoken_sentences(&src);
        let (mp3, marks) = crate::server::audio::synthesize(&cfg.tts_cmd, voice, &sentences).await?;
        let marks_json = serde_json::to_vec(&marks).map_err(|e| format!("encode marks: {e}"))?;
        row.audio_hash = Some(put_blob(obj, store, mp3, "audio/mpeg").await?);
        row.marks_hash = Some(put_blob(obj, store, marks_json, "application/json").await?);
    } else if is_text(&a.file_type) {
        let src = std::fs::read_to_string(&a.source)
            .map_err(|e| format!("read {}: {e}", a.source.display()))?;
        row.html = Some(renderer::render_file(&src, &a.file_type));
        row.markdown = Some(src);
    } else {
        // Binary asset: bytes → rustfs (key = its blake3 = the leaf hash).
        let bytes = std::fs::read(&a.source).map_err(|e| format!("read {}: {e}", a.source.display()))?;
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
            render_version: 1,
        })
    }

    async fn count(pool: &sqlx::PgPool, sql: &str) -> i64 {
        sqlx::query_scalar::<_, i64>(sql).fetch_one(pool).await.unwrap()
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
