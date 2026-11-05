use super::*;

#[derive(serde::Deserialize)]
pub(crate) struct CoverQuery {
    pub(crate) book: String,
}

/// Stream a content-addressed blob from rustfs with its stored MIME.
pub(crate) async fn blob_response(state: &AppState, hash: &str, cache: &str) -> Option<Response> {
    let bytes = state.obj.get(hash).await.ok()?;
    // Degraded metadata (store error or missing asset row) ⇒ generic bytes that
    // the client must revalidate, never the caller's long-lived cache policy.
    let (mime, cache) = match state.store.get_asset(hash).await {
        Ok(Some(asset)) => (asset.mime, cache),
        Ok(None) => ("application/octet-stream".to_string(), "no-cache"),
        Err(error) => {
            tracing::warn!(%error, hash, "asset metadata read failed");
            ("application/octet-stream".to_string(), "no-store")
        }
    };
    Some(
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::CACHE_CONTROL, cache)
            .body(Body::from(bytes))
            .unwrap()
            .into_response(),
    )
}

/// A book's cover image (from rustfs). 404 when the book is unknown or coverless.
pub(crate) async fn api_cover(
    State(state): State<SharedState>,
    Query(q): Query<CoverQuery>,
) -> impl IntoResponse {
    let hash = {
        let cat = state.catalog.read().await;
        cat.book(&q.book).and_then(|b| b.cover_hash.clone())
    };
    match hash {
        Some(h) => match blob_response(&state, &h, "public, max-age=3600").await {
            Some(resp) => resp,
            None => (StatusCode::NOT_FOUND, "no cover").into_response(),
        },
        None => (StatusCode::NOT_FOUND, "no cover").into_response(),
    }
}

/// A book's wide LiveView card/hero artwork. 404 when absent; callers use a
/// deterministic gradient rather than cropping the portrait cover.
pub(crate) async fn api_backdrop(
    State(state): State<SharedState>,
    Query(q): Query<CoverQuery>,
) -> impl IntoResponse {
    let hash = {
        let cat = state.catalog.read().await;
        cat.book(&q.book).and_then(|b| b.backdrop_hash.clone())
    };
    match hash {
        Some(h) => match blob_response(&state, &h, "public, max-age=3600").await {
            Some(resp) => resp,
            None => (StatusCode::NOT_FOUND, "no backdrop").into_response(),
        },
        None => (StatusCode::NOT_FOUND, "no backdrop").into_response(),
    }
}

/// A compact, opaque rendition of the wide artwork for scrolling shelf cards.
/// It is generated at deploy time, content-addressed, and mirrored by native
/// clients through `/api/dag`; the original backdrop remains available for
/// larger hero surfaces.
pub(crate) async fn api_card_backdrop(
    State(state): State<SharedState>,
    Query(q): Query<CoverQuery>,
) -> impl IntoResponse {
    let hash = {
        let cat = state.catalog.read().await;
        cat.book(&q.book).and_then(|b| b.card_backdrop_hash.clone())
    };
    match hash {
        Some(h) => match blob_response(&state, &h, "public, max-age=3600").await {
            Some(resp) => resp,
            None => (StatusCode::NOT_FOUND, "no card backdrop").into_response(),
        },
        None => (StatusCode::NOT_FOUND, "no card backdrop").into_response(),
    }
}

/// Media Session artwork — never 404s for a known book: the real cover from
/// rustfs, else a deterministic slug-keyed gradient PNG (iOS lock-screen tiles
/// need a real raster URL, not CSS/data:).
pub(crate) async fn api_artwork(
    State(state): State<SharedState>,
    Query(q): Query<CoverQuery>,
) -> impl IntoResponse {
    let hash = {
        let cat = state.catalog.read().await;
        match cat.book(&q.book) {
            Some(b) => b.cover_hash.clone(),
            None => return (StatusCode::NOT_FOUND, "no such book").into_response(),
        }
    };
    if let Some(h) = hash
        && let Some(resp) = blob_response(&state, &h, "public, max-age=3600").await
    {
        return resp;
    }
    // No (readable) cover: synthesize the slug's gradient as a PNG off the
    // async workers (the deflate pass is CPU-bound).
    let slug = q.book.clone();
    let png = match tokio::task::spawn_blocking(move || artwork::gradient_png(&slug)).await {
        Ok(Ok(png)) => png,
        Ok(Err(error)) => {
            tracing::warn!(%error, "gradient cover synthesis failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, "artwork").into_response();
        }
        Err(error) => {
            tracing::warn!(%error, "gradient cover task failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, "artwork").into_response();
        }
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .body(Body::from(png))
        .unwrap()
        .into_response()
}
