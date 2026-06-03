use clap::{Args, Parser, Subcommand};
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
pub enum Command {
    /// Reconcile the book corpus into the postgres + rustfs content store
    /// (the git-driven incremental deploy). Connection params default to the
    /// env vars the systemd unit sets.
    Sync(SyncArgs),
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
    #[arg(long, env = "LIVEVIEW_TTS_VOICE", default_value = "zh-CN-XiaoxiaoNeural")]
    pub tts_voice: String,

    /// Bump to force a full re-render (renderer upgrade).
    #[arg(long, default_value_t = 1)]
    pub render_version: i32,
}
