//! Optional spoken narration of non-prose blocks (code / math / image) via an
//! installed LLM CLI, so a listener who can't see the block still follows along.
//!
//! Runs at synth time and is cached at the chapter level (the whole chapter's
//! audio is content-addressed + recorded on the row), so the model is called at
//! most once per non-prose block per chapter — never on a cached replay. The
//! command is `LV_NARRATE_CMD` (default `claude`), invoked headless as
//! `<cmd> -p <prompt> --output-format text`; set it empty to disable. ANY
//! failure (disabled, no source, CLI missing, timeout, error, empty) returns
//! `None` and the caller falls back to a brief silent step-over — so narration
//! is purely additive and never blocks or breaks read-aloud.

use std::time::Duration;

use crate::server::spoken::UnitKind;

/// A narration call must not hang a synth: cap it and kill the child on timeout.
const NARRATE_TIMEOUT: Duration = Duration::from_secs(45);
/// Don't ship an enormous code block to the model — the gist is in the head.
const MAX_SRC_CHARS: usize = 4000;

/// The narration command, or `None` when disabled (`LV_NARRATE_CMD=""`).
fn narrate_cmd() -> Option<String> {
    let c = std::env::var("LV_NARRATE_CMD").unwrap_or_else(|_| "claude".to_string());
    if c.trim().is_empty() {
        None
    } else {
        Some(c)
    }
}

fn kind_word(kind: UnitKind) -> &'static str {
    match kind {
        UnitKind::Code => "code block",
        UnitKind::Math => "math formula",
        UnitKind::Image => "image",
        UnitKind::Table => "table",
        UnitKind::Html => "embedded HTML",
        UnitKind::Prose => "text",
    }
}

/// One short spoken sentence describing a non-prose block, or `None` when
/// narration is disabled, the block has no source, or the CLI is unavailable /
/// errors / times out (caller then leaves the block a brief silent step-over).
pub(crate) async fn narrate(kind: UnitKind, src: &str, lang: &str) -> Option<String> {
    let src = src.trim();
    if src.is_empty() {
        return None;
    }
    let cmd = narrate_cmd()?;
    let input: String = src.chars().take(MAX_SRC_CHARS).collect();
    let prompt = format!(
        "You are narrating a document aloud for a listener who cannot see it. In \
         ONE short, natural spoken sentence, in the same language as the document \
         (language code: {lang}), say what this {word} conveys — its purpose or \
         result, not a literal read-out. Output ONLY that one sentence, with no \
         preamble, quotes, or markdown.\n\n{word} content:\n{input}",
        word = kind_word(kind),
    );
    let run = tokio::process::Command::new(&cmd)
        .args(["-p", &prompt, "--output-format", "text"])
        .kill_on_drop(true)
        .output();
    let out = match tokio::time::timeout(NARRATE_TIMEOUT, run).await {
        Ok(Ok(out)) if out.status.success() => out,
        Ok(Ok(out)) => {
            tracing::warn!(
                cmd,
                stderr = %String::from_utf8_lossy(&out.stderr),
                "narrate: CLI returned non-zero; skipping"
            );
            return None;
        }
        Ok(Err(e)) => {
            tracing::warn!(cmd, error = %e, "narrate: spawn failed; skipping");
            return None;
        }
        Err(_) => {
            tracing::warn!(cmd, "narrate: timed out; skipping");
            return None;
        }
    };
    // First non-empty line, trimmed — guard against a stray trailing newline or a
    // model that adds a second explanatory line.
    let text = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default()
        .to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}
