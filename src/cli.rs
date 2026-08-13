use clap::{Args, Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

/// liveview - LiveView
///
/// Live-reloading previewer for Markdown, images, PDFs and more. Driven by a
/// config file declaring one or more "virtual mounts" — each surfaces as a
/// top-level folder in the sidebar with its own filters and ordering.
///
/// Config formats supported: `.toml`, `.yaml` / `.yml`, `.json`. Format is
/// inferred from the file extension.
///
/// Config resolution order:
///   1. `--config <path>` if given.
///   2. `liveview.{toml,yaml,yml,json}` in the current directory.
///   3. Implicit fallback — single mount over `.` with built-in include
///      / exclude defaults (handy for ad-hoc previews).
#[derive(Parser, Debug, Clone)]
#[command(name = "liveview", version, about, long_about = None)]
pub struct Cli {
    /// Subcommand. Omitted ⇒ run the server (the default).
    #[command(subcommand)]
    pub command: Option<Command>,

    /// Path to a TOML / YAML / JSON config. Overrides auto-discovery.
    #[arg(short, long)]
    pub config: Option<PathBuf>,

    /// Bind port. Overrides `server.port` from the config; if neither sets a
    /// port, auto-picks starting at 4159.
    #[arg(short, long)]
    pub port: Option<u16>,

    /// Bind host. Overrides `server.host` from the config.
    #[arg(long)]
    pub host: Option<String>,

    /// Open the browser once the server is up.
    #[arg(short, long)]
    pub open: bool,

    /// Verbose tracing (`debug` level instead of `info`).
    #[arg(short, long)]
    pub verbose: bool,
}

#[derive(Subcommand, Debug, Clone)]
// `Sync` carries many connection/credential flags and is much larger than
// `Check`; this enum is parsed once at startup and immediately destructured, so
// the size difference has no runtime cost worth boxing for.
#[allow(clippy::large_enum_variant)]
pub enum Command {
    /// Reconcile the book corpus into the postgres + rustfs content store
    /// (the git-driven incremental deploy). Connection params default to the
    /// env vars the systemd unit sets.
    Sync(SyncArgs),

    /// Promote legacy MP3-backed chapter audio to canonical content-addressed
    /// Opus/CAF blobs. Idempotent and safe to resume after interruption.
    AudioOptimize(AudioOptimizeArgs),

    /// Structurally check book content offline, with the *same* engines the
    /// server renders with — so "clean" means "renders". Covers markdown
    /// (dangling/unused footnotes, broken reference links, missing assets),
    /// math (real KaTeX), mermaid diagram types, inline SVG (XML well-formed),
    /// typst syntax, and JSON / Excalidraw. Exit code is non-zero on any error
    /// (or any warning with `--deny-warnings`).
    Check(CheckArgs),

    /// Enforce the production content policy for one book or an entire shelf.
    /// Renderer errors always fail; legacy warnings are allowed only up to the
    /// checked-in per-book/per-rule baseline, so debt can ratchet down without
    /// permitting new regressions. Includes read-aloud resource coverage.
    Gate(GateArgs),

    /// Enumerate the renderable charts (inline SVG + mermaid) in the corpus, with
    /// each chart's reader URL + DOM kind/index — the render targets the visual-QA
    /// loop (the `chart-review` skill) screenshots. Content authority only:
    /// liveview says what/where, the skill + Chrome MCP do the screenshotting.
    Targets(TargetsArgs),

    /// Serve ONE local corpus straight from the filesystem — no postgres/rustfs,
    /// no `sync`. The SAME reader + render engines as the deployed server,
    /// rendering each chapter on demand. For local preview and the visual-QA
    /// loop (`chart-review`), which needs a real reader URL without deploying.
    Preview(PreviewArgs),

    /// Inspect / manage the async audio-generation queue the in-server worker
    /// drains (sync enqueues; the worker synthesizes). Prints per-book progress
    /// by default; `--retry` re-queues failed tasks.
    Tasks(TasksArgs),

    /// Evaluate read-aloud playability: a dry-run of the speech registry over the
    /// corpus reporting, per non-prose resource (table / diagram / formula / code
    /// / figure) and per read-hostile inline span (URL / address / phone), what
    /// it will be SPOKEN as — narrated (stored) vs needs-narration vs SILENT.
    /// Offline, no model calls, no synth; shares the exact decision the runtime
    /// synth uses, and reads the book's `.narration/<lang>.json` sidecar.
    NarrateAudit(NarrateAuditArgs),

    /// Emit the to-generate narration work for a book + language: the unique
    /// non-prose resources NOT already in `.narration/<lang>.json`, deduped, as
    /// `{key, kind, lang, src}`. The SKILL's input — it fills each key's spoken
    /// text back into the sidecar. Prose never appears (zero tokens); re-running
    /// after the skill fills the sidecar yields an empty plan.
    NarratePlan(NarratePlanArgs),
}

/// Args for `liveview narrate-plan`. Point it at a book root (or its `<lang>/`
/// dir); `--lang` selects the language edition + sidecar.
#[derive(Args, Debug, Clone)]
pub struct NarratePlanArgs {
    /// Book root or directory to plan. Recurses for markdown.
    #[arg(default_value = ".")]
    pub paths: Vec<PathBuf>,

    /// Language edition to plan narration for (sidecar `.narration/<lang>.json`).
    #[arg(long, default_value = "zh")]
    pub lang: String,

    /// Output: `json` (array of {key,kind,lang,src} for the skill) or `human`.
    #[arg(long, value_enum, default_value = "json")]
    pub format: OutputFormat,
}

/// Args for `liveview narrate-audit`. Paths default to `.` (recurse for
/// `*.md` / `*.markdown`); a file argument is evaluated as-is.
#[derive(Args, Debug, Clone)]
pub struct NarrateAuditArgs {
    /// Files or directories to evaluate. Directories recurse for markdown.
    #[arg(default_value = ".")]
    pub paths: Vec<PathBuf>,

    /// Output format: `human` (grouped, file:blk) or `json` (a serde array of
    /// Diagnostic, for tooling / agents).
    #[arg(long, value_enum, default_value = "human")]
    pub format: OutputFormat,
}

/// Args for `liveview tasks`.
#[derive(Args, Debug, Clone)]
pub struct TasksArgs {
    /// `postgres://…` URL for the private liveview db.
    #[arg(long, env = "DATABASE_URL")]
    pub database_url: String,

    /// Re-queue failed tasks (instead of printing status).
    #[arg(long)]
    pub retry: bool,

    /// Limit `--retry` to one book by slug.
    #[arg(long)]
    pub book: Option<String>,
}

/// Args for `liveview preview`. Resolves the corpus the same way `sync` /
/// `targets` do, then serves it from memory on a local port.
#[derive(Args, Debug, Clone)]
pub struct PreviewArgs {
    /// Corpus config (`liveview.toml`); auto-discovered from cwd when omitted.
    #[arg(short, long)]
    pub config: Option<PathBuf>,

    /// Bind port. Auto-picks from 4159 upward when omitted.
    #[arg(short, long)]
    pub port: Option<u16>,

    /// Bind host (default `127.0.0.1`).
    #[arg(long)]
    pub host: Option<String>,

    /// Open the browser once the server is up.
    #[arg(short, long)]
    pub open: bool,
}

/// Args for `liveview targets`. Resolves the corpus the same way `sync` does.
#[derive(Args, Debug, Clone)]
pub struct TargetsArgs {
    /// Limit to one book by slug (default: every book in the corpus).
    pub book: Option<String>,

    /// Corpus config (`liveview.toml`); auto-discovered from cwd when omitted.
    #[arg(long)]
    pub config: Option<PathBuf>,

    /// Reader origin to build each chart's `page_url` against.
    #[arg(long, default_value = "http://127.0.0.1:4160")]
    pub base_url: String,

    /// Output format: `json` (array of ChartTarget, for the skill) or `human`.
    #[arg(long, value_enum, default_value = "json")]
    pub format: OutputFormat,
}

/// Args for `liveview check`. Paths default to `.` (recurse the cwd for
/// `*.md` / `*.markdown`); a file argument is checked as-is.
#[derive(Args, Debug, Clone)]
pub struct CheckArgs {
    /// Files or directories to check. Directories recurse for markdown.
    #[arg(default_value = ".")]
    pub paths: Vec<PathBuf>,

    /// Output format: `human` (grouped, file:line:col) or `json` (a serde array
    /// of Diagnostic, for tooling / agents).
    #[arg(long, value_enum, default_value = "human")]
    pub format: OutputFormat,

    /// Treat warnings as failures (exit non-zero if any warning is found).
    #[arg(long)]
    pub deny_warnings: bool,
}

/// Args for `liveview gate`.
#[derive(Args, Debug, Clone)]
pub struct GateArgs {
    /// Book roots or shelf roots. Shelf roots are discovered by `book.toml`.
    #[arg(default_value = ".")]
    pub paths: Vec<PathBuf>,

    /// Checked-in warning budget generated by `--write-baseline`.
    #[arg(long, default_value = ".liveview-gate.json")]
    pub baseline: PathBuf,

    /// Named policy profile inside the baseline.
    #[arg(long, default_value = "production")]
    pub profile: String,

    /// Replace this profile with the current warning counts. Renderer errors
    /// can never be baselined and make this operation fail.
    #[arg(long)]
    pub write_baseline: bool,

    /// Output format for a gate evaluation.
    #[arg(long, value_enum, default_value = "human")]
    pub format: OutputFormat,
}

/// How `liveview check` prints its diagnostics.
#[derive(ValueEnum, Debug, Clone, Copy)]
pub enum OutputFormat {
    /// Human-readable, grouped by file.
    Human,
    /// A JSON array of `Diagnostic` (stable schema for tooling).
    Json,
}

/// Args for `liveview sync`. The S3 credentials accept either a direct value
/// or a file path (rustfs writes its keys to files); the file wins if both are
/// given. Most fields read their env var when the flag is omitted.
#[derive(Args, Debug, Clone)]
pub struct SyncArgs {
    /// Corpus config (same format as the server's). Auto-discovered if omitted.
    #[arg(short, long)]
    pub config: Option<PathBuf>,

    /// `postgres://…` URL for the private liveview db.
    #[arg(long, env = "DATABASE_URL")]
    pub database_url: String,

    /// rustfs S3 endpoint, e.g. `http://127.0.0.1:9001`.
    #[arg(long, env = "LIVEVIEW_S3_ENDPOINT")]
    pub s3_endpoint: String,

    /// Bucket for book blobs.
    #[arg(long, env = "LIVEVIEW_S3_BUCKET", default_value = "liveview")]
    pub s3_bucket: String,

    #[arg(long, env = "LIVEVIEW_S3_ACCESS_KEY")]
    pub s3_access_key: Option<String>,
    #[arg(long, env = "LIVEVIEW_S3_ACCESS_KEY_FILE")]
    pub s3_access_key_file: Option<PathBuf>,
    #[arg(long, env = "LIVEVIEW_S3_SECRET_KEY")]
    pub s3_secret_key: Option<String>,
    #[arg(long, env = "LIVEVIEW_S3_SECRET_KEY_FILE")]
    pub s3_secret_key_file: Option<PathBuf>,

    /// Optional fallback voice; a book's `[renditions.audio].voice` overrides it.
    #[arg(long, env = "LIVEVIEW_TTS_VOICE")]
    pub tts_voice: Option<String>,

    /// Pre-generate the TEXT read-aloud audio task for every
    /// markdown chapter during sync, so the reader's first play is instant
    /// instead of waiting on an on-demand synth. Incremental + resumable like the
    /// audiobook pre-gen. Off by default — enabling it triggers a large one-time
    /// TTS backfill of the whole corpus (the server's on-demand path covers
    /// anything not yet reached, so the reader keeps working meanwhile).
    #[arg(
        long,
        env = "LIVEVIEW_PREGEN_TEXT_AUDIO",
        action = clap::ArgAction::Set,
        default_value_t = false
    )]
    pub pregen_text_audio: bool,

    /// Bump to force a full re-render (renderer upgrade).
    #[arg(long, default_value_t = 1)]
    pub render_version: i32,

    /// Self-heal a chapters↔merkle desync. A normal sync trusts the Merkle
    /// cache: a leaf whose `merkle_nodes` row exists is assumed applied and
    /// skipped. If a book's `chapters` rows were lost while its Merkle nodes
    /// survived (e.g. a partial store wipe), the content can NEVER come back —
    /// both the subtree-hash prune and the per-leaf skip say "done", so the book
    /// renders empty forever. `--repair` plans against an empty deployed DAG
    /// (every leaf becomes a candidate) and re-applies ONLY the leaves whose
    /// content row is actually missing; unchanged, present content is still
    /// skipped, so it's cheap and safe to run anytime. Also reconciles STALE
    /// audio: for each already-baked audio leaf it checks the baked marks count
    /// against the current text's segment count and, on a mismatch (a chapter
    /// edited after its bake, so the read-along highlight tracks the wrong
    /// paragraph), drops the stale mp3/marks and re-enqueues the chapter for the
    /// worker to re-synthesize.
    #[arg(long, default_value_t = false)]
    pub repair: bool,

    /// Re-render content (markdown → HTML) WITHOUT touching audio: skip the
    /// text/audio TTS enqueue and preserve each chapter's existing mp3 + marks.
    /// Use after a change that didn't alter the spoken prose — e.g. a mermaid
    /// label tweak — where a full re-synth of every touched chapter would be
    /// hours of wasted edge-tts for identical audio. The diagrams/HTML update;
    /// read-aloud keeps playing its existing audio.
    #[arg(long, default_value_t = false)]
    pub no_audio: bool,
}

/// Connection arguments for `liveview audio-optimize`. Source MP3 objects are
/// deliberately retained; the next successful `liveview sync` verifies the new
/// DAG and reclaims them through the ordinary orphan-asset GC.
#[derive(Args, Debug, Clone)]
pub struct AudioOptimizeArgs {
    /// `postgres://…` URL for the private liveview db.
    #[arg(long, env = "DATABASE_URL")]
    pub database_url: String,

    /// S3-compatible object-store endpoint.
    #[arg(long, env = "LIVEVIEW_S3_ENDPOINT")]
    pub s3_endpoint: String,

    /// Bucket for book blobs.
    #[arg(long, env = "LIVEVIEW_S3_BUCKET", default_value = "liveview")]
    pub s3_bucket: String,

    #[arg(long, env = "LIVEVIEW_S3_ACCESS_KEY")]
    pub s3_access_key: Option<String>,
    #[arg(long, env = "LIVEVIEW_S3_ACCESS_KEY_FILE")]
    pub s3_access_key_file: Option<PathBuf>,
    #[arg(long, env = "LIVEVIEW_S3_SECRET_KEY")]
    pub s3_secret_key: Option<String>,
    #[arg(long, env = "LIVEVIEW_S3_SECRET_KEY_FILE")]
    pub s3_secret_key_file: Option<PathBuf>,
}
