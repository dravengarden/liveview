mod artwork;
mod audio_optimize;
mod bootstrap;
mod check;
mod cli;
mod commands;
mod config;
mod content;
mod http;
mod interactive_view;
mod library;
mod server;
mod shared;
mod speech;
mod store;
mod sync;
mod tags;

use axum::http::{HeaderMap, header};
use bootstrap::*;
use clap::Parser;
use cli::{Cli, Command};
use commands::*;
use config::{Config, Resolved, auto_discover, implicit_resolved};
use http::audio::load_book_end_phrases;
use http::*;
use server::catalog::Catalog;
pub(crate) use server::encoding::{AUDIO_ENCODING_VERSION, AUDIO_VARIANT, transcode_audio};
use server::state::{ApmSink, AppState, SharedState};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use store::objstore::ObjStore;
use store::pg::PgStore;
use tokio::sync::{RwLock, broadcast};
use tracing_subscriber::EnvFilter;

fn main() {
    let cli = Cli::parse();

    let filter = if cli.verbose {
        EnvFilter::new("debug")
    } else {
        EnvFilter::new("info")
    };
    tracing_subscriber::fmt().with_env_filter(filter).init();

    // `liveview check` is fully synchronous + offline — handle it before
    // spinning up the tokio runtime, then exit with its status code.
    if let Some(Command::Check(args)) = cli.command.clone() {
        let code = check::run(&args.paths, args.format, args.deny_warnings);
        std::process::exit(code);
    }

    // `liveview gate` — offline production policy over checker + narration
    // diagnostics. It runs before Tokio like the underlying deterministic passes.
    if let Some(Command::Gate(args)) = cli.command.clone() {
        std::process::exit(check::gate::run(&args));
    }

    // `liveview targets` is likewise synchronous (resolve corpus → list charts).
    if let Some(Command::Targets(args)) = cli.command.clone() {
        std::process::exit(run_targets(&args));
    }

    // `liveview narrate-audit` — offline read-aloud playability dry-run (no model
    // calls, no synth), so it runs before the tokio runtime like `check`.
    if let Some(Command::NarrateAudit(args)) = cli.command.clone() {
        std::process::exit(check::readaloud::run(&args.paths, args.format));
    }

    // `liveview narrate-plan` — offline; emit the skill's to-generate narration list.
    if let Some(Command::NarratePlan(args)) = cli.command.clone() {
        std::process::exit(check::readaloud::plan_run(
            &args.paths,
            &args.lang,
            args.format,
        ));
    }

    let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");

    match cli.command.clone() {
        // `liveview sync` — reconcile the corpus into pg + rustfs.
        Some(Command::Dir(args)) => {
            if let Err(error) = rt.block_on(run_dir(args)) {
                eprintln!("dir error: {error}");
                std::process::exit(1);
            }
        }
        Some(Command::Sync(args)) => {
            if let Err(e) = rt.block_on(run_sync(args)) {
                eprintln!("sync error: {e}");
                std::process::exit(1);
            }
        }
        Some(Command::AudioOptimize(args)) => {
            if let Err(e) = rt.block_on(run_audio_optimize(args)) {
                eprintln!("audio-optimize error: {e}");
                std::process::exit(1);
            }
        }
        // `liveview check` / `targets` are handled (and exit) above, before the
        // runtime is built — they never reach this match.
        Some(Command::Check(_)) => unreachable!("check handled before the tokio runtime"),
        Some(Command::Gate(_)) => unreachable!("gate handled before the tokio runtime"),
        Some(Command::Targets(_)) => unreachable!("targets handled before the tokio runtime"),
        Some(Command::NarrateAudit(_)) => {
            unreachable!("narrate-audit handled before the tokio runtime")
        }
        Some(Command::NarratePlan(_)) => {
            unreachable!("narrate-plan handled before the tokio runtime")
        }
        // `liveview preview` — serve ONE local corpus from the filesystem (no
        // pg/rustfs, no sync), rendering on demand. For local QA / chart-review.
        Some(Command::Preview(args)) => {
            if let Err(e) = rt.block_on(run_preview(args)) {
                eprintln!("preview error: {e}");
                std::process::exit(2);
            }
        }
        // `liveview tasks` — inspect / retry the async audio queue.
        Some(Command::Tasks(args)) => {
            if let Err(e) = rt.block_on(run_tasks(args)) {
                eprintln!("tasks error: {e}");
                std::process::exit(1);
            }
        }
        // Default — run the server. It reads only the `[server]` block (host /
        // port / open) from the config; content comes from pg + rustfs, so it
        // never resolves or touches the corpus filesystem.
        None => {
            let server = load_server_cfg(cli.config.as_deref());
            rt.block_on(run(cli, server));
        }
    }
}
