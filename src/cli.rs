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

    /// Structurally check book content offline, with the *same* engines the
    /// server renders with — so "clean" means "renders". Covers markdown
    /// (dangling/unused footnotes, broken reference links, missing assets),
    /// math (real KaTeX), mermaid diagram types, inline SVG (XML well-formed),
    /// typst syntax, and JSON / Excalidraw. Exit code is non-zero on any error
    /// (or any warning with `--deny-warnings`).
    Check(CheckArgs),

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

    /// `edge-tts` executable for audiobook pre-generation.
    #[arg(long, env = "LIVEVIEW_EDGE_TTS_CMD", default_value = "edge-tts")]
    pub edge_tts_cmd: String,

    /// Default edge-tts voice; a book's `[renditions.audio].voice` overrides it.
    #[arg(
        long,
        env = "LIVEVIEW_TTS_VOICE",
        default_value = "zh-CN-XiaoxiaoNeural"
    )]
    pub tts_voice: String,

    /// Bump to force a full re-render (renderer upgrade).
    #[arg(long, default_value_t = 1)]
    pub render_version: i32,
}
