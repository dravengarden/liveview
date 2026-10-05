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
            RangedBlob::Unsatisfiable { total } => unsatisfiable_response(total),
        },
        None => full_response(state.obj.get(key).await?.into(), mime, cache_control),
    };
    Ok(response)
}

/// Serve `data` with `Content-Length`, `Accept-Ranges` and single-range
/// support. A satisfiable `Range` yields a zero-copy 206 slice of the buffer;
/// an unsatisfiable one yields 416, and a malformed one is ignored (200).
pub fn ranged_bytes_response(
    data: Vec<u8>,
    headers: &HeaderMap,
    mime: &str,
    cache_control: &str,
) -> Response {
    let data = Bytes::from(data);
    let total = data.len() as u64;
    let Some(range) = request_range(headers) else {
        return full_response(data, mime, cache_control);
    };
    match range.resolve(total) {
        Some((start, end)) => partial_response(
            data.slice(start as usize..=end as usize),
            start,
            end,
            total,
            mime,
            cache_control,
        ),
        None => unsatisfiable_response(total),
    }
}

/// `416 Range Not Satisfiable` with the object size, so a client can retry
/// with a valid range (RFC 9110 §15.5.17).
fn unsatisfiable_response(total: u64) -> Response {
    Response::builder()
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_RANGE, format!("bytes */{total}"))
        .body(Body::empty())
        .unwrap()
        .into_response()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn with_range(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, value.parse().unwrap());
        headers
    }

    #[test]
    fn in_memory_ranges_follow_rfc_9110() {
        let data = || vec![1u8; 10];
        let ok = ranged_bytes_response(data(), &HeaderMap::new(), "audio/x-caf", "c");
        assert_eq!(ok.status(), StatusCode::OK);

        let partial = ranged_bytes_response(data(), &with_range("bytes=8-99"), "audio/x-caf", "c");
        assert_eq!(partial.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(partial.headers()[header::CONTENT_RANGE], "bytes 8-9/10");

        let past = ranged_bytes_response(data(), &with_range("bytes=10-"), "audio/x-caf", "c");
        assert_eq!(past.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(past.headers()[header::CONTENT_RANGE], "bytes */10");

        let malformed = ranged_bytes_response(data(), &with_range("bytes=x-"), "audio/x-caf", "c");
        assert_eq!(malformed.status(), StatusCode::OK);
    }
}
