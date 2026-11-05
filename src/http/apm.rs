use super::*;

pub(crate) const APM_MAX_EVENTS: usize = 1_000;
pub(crate) const APM_MAX_BODY_BYTES: usize = 256 * 1024;

/// Dedicated APM credential header. `Authorization` is owned by the optional
/// LIVEVIEW_ACCESS_TOKEN proxy policy (the trusted proxy overwrites it on every
/// upstream request), so a client behind that proxy cannot also carry the APM
/// bearer there. This header carries the APM token independently.
pub(crate) const APM_TOKEN_HEADER: &str = "x-liveview-apm-token";

/// The APM token may arrive in [`APM_TOKEN_HEADER`] or, for existing clients,
/// as `Authorization: Bearer <token>`.
pub(crate) fn apm_token_matches(headers: &HeaderMap, want: &str) -> bool {
    let dedicated = headers
        .get(APM_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::trim);
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let matches =
        |got: Option<&str>| got.is_some_and(|got| secret_eq(got.as_bytes(), want.as_bytes()));
    // Evaluate both so the response time does not reveal which one was tried.
    matches(dedicated) | matches(bearer)
}

/// Compare a presented secret without an early exit on the first differing
/// byte, so response timing does not leak how much of a guess was right.
pub(crate) fn secret_eq(got: &[u8], want: &[u8]) -> bool {
    got.len() == want.len() && got.iter().zip(want).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// Batched client APM events → an explicitly configured VictoriaLogs sink. The native app buffers operation /
/// perf / error events offline and POSTs them here in batches when the network is
/// good; we stamp each with `received_at` + a `_msg` summary and forward the batch
/// as jsonline to the host VL, where it's queried/debugged with LogsQL. Auth: a
/// shared bearer token when configured (else open, for dev). We return 200 ONLY
/// when VL accepted the batch — a VL hiccup returns 502 so the client keeps the
/// events and retries (at-least-once; `event_id` dedups a re-send at query time).
pub(crate) async fn api_ingest(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(mut events): Json<Vec<serde_json::Map<String, serde_json::Value>>>,
) -> impl IntoResponse {
    let Some(apm) = state.apm.as_ref() else {
        // No VL configured (preview) — accept + drop so a dev client doesn't spin.
        return StatusCode::OK;
    };
    // Token auth when a token is configured; an open sink requires explicit
    // LIVEVIEW_APM_ALLOW_UNAUTHENTICATED configuration at startup.
    if let Some(want) = apm.token.as_deref()
        && !apm_token_matches(&headers, want)
    {
        return StatusCode::UNAUTHORIZED;
    }
    if events.is_empty() {
        return StatusCode::OK;
    }
    // Reject rather than silently truncate: a successful response makes the
    // client acknowledge the WHOLE batch, so truncation would lose the tail.
    if events.len() > APM_MAX_EVENTS {
        return StatusCode::PAYLOAD_TOO_LARGE;
    }
    let received_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    // NDJSON: one enriched event object per line.
    let mut body = String::new();
    for ev in &mut events {
        if !ev.contains_key("received_at") {
            ev.insert("received_at".to_string(), serde_json::json!(received_at));
        }
        // VL's default message column: the event type, for readable log rows.
        let msg = ev
            .get("event_type")
            .and_then(|v| v.as_str())
            .unwrap_or("event")
            .to_string();
        ev.insert("_msg".to_string(), serde_json::json!(msg));
        if let Ok(line) = serde_json::to_string(ev) {
            body.push_str(&line);
            body.push('\n');
        }
    }
    match apm
        .client
        .post(&apm.vl_url)
        .header("content-type", "application/x-ndjson")
        .body(body)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => StatusCode::OK,
        Ok(r) => {
            tracing::warn!(status = %r.status(), "apm forward to VictoriaLogs rejected");
            StatusCode::BAD_GATEWAY
        }
        Err(e) => {
            tracing::warn!(error = %e, "apm forward to VictoriaLogs failed");
            StatusCode::BAD_GATEWAY
        }
    }
}
