//! Runners for the CLI subcommands that are not the server itself.

use super::*;

/// `liveview targets` entry point: resolve the corpus, emit each chart's render
/// target. Returns the process exit code (2 on resolve/read failure, else 0).
pub(crate) fn run_targets(args: &cli::TargetsArgs) -> i32 {
    let resolved = match resolve_config(args.config.as_deref()) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("targets: {e}");
            return 2;
        }
    };
    let targets = match check::targets::collect(&resolved, &args.base_url, args.book.as_deref()) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("targets: {e}");
            return 2;
        }
    };
    match args.format {
        cli::OutputFormat::Json => {
            println!(
                "{}",
                serde_json::to_string_pretty(&targets).unwrap_or_else(|_| "[]".to_string())
            );
        }
        cli::OutputFormat::Human => {
            for t in &targets {
                let kind = serde_json::to_value(t.kind)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_default();
                println!(
                    "{}/{} {}:{}  {}#{}  {}",
                    t.book, t.lang, t.file, t.line, kind, t.nth, t.page_url
                );
            }
            eprintln!("targets: {} chart(s)", targets.len());
        }
    }
    0
}

/// `liveview sync` entry point: resolve the corpus, gather connection params,
/// reconcile into pg + rustfs.
pub(crate) async fn run_sync(args: cli::SyncArgs) -> Result<(), String> {
    let resolved = resolve_config(args.config.as_deref())?;
    let s3_access_key = read_cred(
        "access",
        args.s3_access_key.clone(),
        args.s3_access_key_file.as_deref(),
    )?;
    let s3_secret_key = read_cred(
        "secret",
        args.s3_secret_key.clone(),
        args.s3_secret_key_file.as_deref(),
    )?;
    let cfg = sync::run::SyncCfg {
        database_url: args.database_url,
        s3_endpoint: args.s3_endpoint,
        s3_access_key,
        s3_secret_key,
        s3_bucket: args.s3_bucket,
        tts_voice: args.tts_voice,
        text_audio: args.pregen_text_audio,
        render_version: args.render_version,
        repair: args.repair,
        no_audio: args.no_audio,
    };
    let report = sync::run::run(&resolved, &cfg).await?;
    tracing::info!(
        books = report.books,
        put = report.put,
        enqueued = report.enqueued,
        skipped = report.skipped,
        stale_audio = report.stale_audio,
        dangling_audio = report.dangling_audio,
        deleted = report.deleted,
        orphans_gc = report.orphans_gc,
        check_warnings = report.check_warnings,
        root = %report.root,
        "sync complete"
    );
    let root_short = &report.root[..report.root.len().min(12)];
    println!(
        "sync: {} books, {} put, {} audio queued, {} skipped, {} stale-audio re-baked, {} missing-audio re-baked, {} deleted, {} gc'd, {} check warnings, root {root_short}",
        report.books,
        report.put,
        report.enqueued,
        report.skipped,
        report.stale_audio,
        report.dangling_audio,
        report.deleted,
        report.orphans_gc,
        report.check_warnings
    );
    Ok(())
}

pub(crate) async fn run_audio_optimize(args: cli::AudioOptimizeArgs) -> Result<(), String> {
    let access = read_cred(
        "access",
        args.s3_access_key,
        args.s3_access_key_file.as_deref(),
    )?;
    let secret = read_cred(
        "secret",
        args.s3_secret_key,
        args.s3_secret_key_file.as_deref(),
    )?;
    let pg = PgStore::open(&args.database_url)
        .await
        .map_err(|e| format!("connect postgres: {e}"))?;
    pg.migrate().await.map_err(|e| format!("migrate: {e}"))?;
    let obj = ObjStore::connect(&args.s3_endpoint, &access, &secret, &args.s3_bucket);
    let report = audio_optimize::run(&pg, &obj).await?;
    println!(
        "audio-optimize: {} assets / {} chapter refs promoted, {:.2} GiB MP3 -> {:.2} GiB canonical CAF ({} retranscoded, {} tails preserved); run sync to publish the new root and GC source MP3",
        report.promoted,
        report.chapters,
        report.source_bytes as f64 / 1_073_741_824.0,
        report.canonical_bytes as f64 / 1_073_741_824.0,
        report.retranscoded,
        report.tails,
    );
    Ok(())
}

/// `liveview tasks` entry point: print the audio-generation rollup, or `--retry`
/// re-queues failed tasks.
pub(crate) async fn run_tasks(args: cli::TasksArgs) -> Result<(), String> {
    let pg = PgStore::open(&args.database_url)
        .await
        .map_err(|e| format!("connect postgres: {e}"))?;
    pg.migrate().await.map_err(|e| format!("migrate: {e}"))?;
    if args.retry {
        let n = pg
            .retry_failed_audio_tasks(args.book.as_deref())
            .await
            .map_err(|e| e.to_string())?;
        println!("tasks: re-queued {n} failed task(s)");
        return Ok(());
    }
    let mut rows = pg.audio_task_rollup().await.map_err(|e| e.to_string())?;
    rows.sort_by(|a, z| a.book_slug.cmp(&z.book_slug));
    for r in &rows {
        let who = r.book_slug.as_deref().unwrap_or("(global)");
        println!(
            "  {who:32}  {:>4}/{:<4} done   {:>3} pending   {:>3} failed",
            r.done, r.total, r.pending, r.failed
        );
    }
    if rows.is_empty() {
        println!("tasks: queue empty");
    }
    Ok(())
}

/// Resolve an S3 credential: a key file (rustfs writes its keys to files) wins
/// over a direct value; error if neither is given.
pub(crate) fn read_cred(
    which: &str,
    direct: Option<String>,
    file: Option<&Path>,
) -> Result<String, String> {
    if let Some(f) = file {
        return std::fs::read_to_string(f)
            .map(|s| s.trim().to_string())
            .map_err(|e| format!("read s3 {which} key file {}: {e}", f.display()));
    }
    direct.ok_or_else(|| {
        format!("missing s3 {which} key (set --s3-{which}-key or --s3-{which}-key-file)")
    })
}

pub(crate) async fn run_dir(args: cli::DirArgs) -> Result<(), String> {
    let mut headers = HeaderMap::new();
    if let Some(token) = args.token {
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {token}")
                .parse()
                .map_err(|_| "Invalid access token")?,
        );
    }
    let client = reqwest::Client::builder()
        .default_headers(headers)
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("{}/api/library", args.server.trim_end_matches('/'));
    let response = match args.command {
        cli::DirCommand::Tree => client.get(url).send().await,
        cli::DirCommand::Apply { plan, dry_run } => {
            let bytes = std::fs::read(plan).map_err(|e| e.to_string())?;
            let mut change: library::Change = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            change.dry_run |= dry_run;
            client.post(url).header("Content-Type", "application/json").body(serde_json::to_vec(&change).map_err(|e| e.to_string())?).send().await
        }
        cli::DirCommand::Undo { revision, expected_revision } => client.post(url).header("Content-Type", "application/json").body(serde_json::json!({"revision":expected_revision,"operations":[],"undo_revision":revision}).to_string()).send().await,
    }.map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("{status}: {body}"));
    }
    println!("{body}");
    Ok(())
}
