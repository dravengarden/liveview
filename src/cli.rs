use clap::Parser;
use std::path::PathBuf;

/// lv - LiveView
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
#[command(name = "lv", version, about, long_about = None)]
pub struct Cli {
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
