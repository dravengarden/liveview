//! The LLM execution layer for spoken narration of non-prose blocks — a thin,
//! generic "run this prompt through the installed CLI" runner.
//!
//! WHAT to say for each resource kind (the per-type prompt + length target) is
//! the [`crate::server::speakable`] registry's job; this module only *runs* a
//! finished prompt. Invoked at synth time and cached at the chapter level (the
//! whole chapter's audio is content-addressed + recorded on the row), so the
//! model is called at most once per non-prose block per chapter — never on a
//! cached replay. The command is `LV_NARRATE_CMD` (default `claude`), invoked
//! headless as `<cmd> -p <prompt> --output-format text`; set it empty to
//! disable. ANY failure (disabled, CLI missing, timeout, error, empty) returns
//! `None` and the caller falls back to a brief silent step-over — so narration
//! is purely additive and never blocks or breaks read-aloud.

use std::time::Duration;

/// A narration call must not hang a synth: cap it and kill the child on timeout.
const NARRATE_TIMEOUT: Duration = Duration::from_secs(45);

/// The narration command, or `None` when disabled (`LV_NARRATE_CMD=""`).
fn narrate_cmd() -> Option<String> {
    let c = std::env::var("LV_NARRATE_CMD").unwrap_or_else(|_| "claude".to_string());
    if c.trim().is_empty() {
        None
    } else {
        Some(c)
    }
}

/// Run one finished narration `prompt` through the LLM CLI and return its single
/// spoken line, or `None` when narration is disabled or the CLI is unavailable /
/// errors / times out (the caller then leaves the block a brief silent
/// step-over). The prompt already carries all per-kind instructions + the
/// (truncated) resource source — see [`crate::server::speakable`].
pub(crate) async fn run(prompt: &str) -> Option<String> {
    let cmd = narrate_cmd()?;
    let exec = tokio::process::Command::new(&cmd)
        .args(["-p", prompt, "--output-format", "text"])
        .kill_on_drop(true)
        .output();
    let out = match tokio::time::timeout(NARRATE_TIMEOUT, exec).await {
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
