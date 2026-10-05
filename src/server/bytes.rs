//! Byte-body HTTP responses with `Content-Length`, `Accept-Ranges`, and
//! single-range support, for content-addressed blobs and audio.

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};

use crate::server::state::AppState;
use crate::store::range::{RangeSpec, RangedBlob};

/// The single byte range a request asks for; `None` serves the full body.
fn request_range(headers: &HeaderMap) -> Option<RangeSpec> {
    headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(RangeSpec::parse)
}

/// Serve a stored blob, reading only the requested range from the blob store
/// so audio seeks do not load the whole object per request.
pub async fn stored_blob_response(
    state: &AppState,
    key: &str,
    headers: &HeaderMap,
    mime: &str,
    cache_control: &str,
) -> Result<Response, String> {
    let response = match request_range(headers) {
        Some(range) => match state.obj.get_range(key, range).await? {
            RangedBlob::Partial {
                bytes,
                start,
                end,
                total,
            } => partial_response(bytes.into(), start, end, total, mime, cache_control),
            RangedBlob::Full(bytes) => full_response(bytes.into(), mime, cache_control),
        },
        None => full_response(state.obj.get(key).await?.into(), mime, cache_control),
    };
    Ok(response)
}

/// Serve `data` with `Content-Length`, `Accept-Ranges` and single-range
/// support. A satisfiable `Range` yields a zero-copy 206 slice of the buffer.
pub fn ranged_bytes_response(
    data: Vec<u8>,
    headers: &HeaderMap,
    mime: &str,
    cache_control: &str,
) -> Response {
    let data = Bytes::from(data);
    let total = data.len() as u64;
    match request_range(headers).and_then(|range| range.resolve(total)) {
        Some((start, end)) => partial_response(
            data.slice(start as usize..=end as usize),
            start,
            end,
            total,
            mime,
            cache_control,
        ),
        None => full_response(data, mime, cache_control),
    }
}

fn bytes_response_base(mime: &str, cache_control: &str) -> axum::http::response::Builder {
    Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, cache_control)
}

fn partial_response(
    data: Bytes,
    start: u64,
    end: u64,
    total: u64,
    mime: &str,
    cache_control: &str,
) -> Response {
    bytes_response_base(mime, cache_control)
        .status(StatusCode::PARTIAL_CONTENT)
        .header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total}"),
        )
        .header(header::CONTENT_LENGTH, data.len())
        .body(Body::from(data))
        .unwrap()
        .into_response()
}

fn full_response(data: Bytes, mime: &str, cache_control: &str) -> Response {
    bytes_response_base(mime, cache_control)
        .status(StatusCode::OK)
        .header(header::CONTENT_LENGTH, data.len())
        .body(Body::from(data))
        .unwrap()
        .into_response()
}
