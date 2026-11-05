use super::*;

/// `GET /api/tasks` — the audio-generation rollup (per-book + a NULL-slug global
/// row) the Sync sheet renders: `{done, total, failed, pending}` per book.
pub(crate) async fn api_tasks(State(state): State<SharedState>) -> impl IntoResponse {
    match state.store.audio_task_rollup().await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => {
            tracing::warn!(error = %e, "audio task rollup failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "rollup").into_response()
        }
    }
}

/// `GET /api/blob/<content_hash>` — an immutable content-addressed blob (audio,
/// marks, image bytes) from rustfs, for the SW's offline cache. `immutable` ⇒
/// the SW caches forever, never revalidates; Range supports audio seeking.
pub(crate) async fn api_blob(
    State(state): State<SharedState>,
    axum::extract::Path(hash): axum::extract::Path<String>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    // The bytes are content-addressed, but the MIME type comes from the asset
    // row. A store error is a 503; a missing row (the object is written before
    // its row) serves generic bytes with a short, revalidating cache so a wrong
    // content type is never pinned as `immutable`.
    let (mime, cache_control) = match state.store.get_asset(&hash).await {
        Ok(Some(a)) => (a.mime, "public, max-age=31536000, immutable"),
        Ok(None) => ("application/octet-stream".to_string(), "no-cache"),
        Err(error) => return store_unavailable("get_asset", error),
    };
    stored_blob_response(&state, &hash, &headers, &mime, cache_control)
        .await
        .unwrap_or_else(|_| (StatusCode::NOT_FOUND, "blob not found").into_response())
}

/// `GET /api/manifest/<slug>` — one book's content-addressed chapters (audio +
/// assets) with blob sizes + audio-task status (the SW's Lane-B prefetch index +
/// the per-chapter readiness signal). Text/HTML is Lane A, not here.
pub(crate) async fn api_manifest_book(
    State(state): State<SharedState>,
    axum::extract::Path(slug): axum::extract::Path<String>,
) -> impl IntoResponse {
    let chapters = match state.store.manifest_chapters(&slug).await {
        Ok(value) => value,
        Err(error) => return store_unavailable("manifest_chapters", error),
    };
    let arr: Vec<_> = chapters
        .iter()
        .map(|c| {
            serde_json::json!({
                "id": format!("{}/{}/{}", c.rendition, c.lang, c.rel_path),
                // TEXT content-addressing: the source hash (+ file type) so the
                // client caches /api/file by hash and refetches only on change.
                "content_hash": c.content_hash,
                "file_type": c.file_type,
                "audio": {
                    "status": c.status,
                    "hash": c.audio_hash,
                    "marks_hash": c.marks_hash,
                    "bytes": c.audio_size,
                    "mime": c.audio_mime,
                },
                "asset": c.asset_hash.as_ref().map(|h| serde_json::json!({
                    "hash": h, "bytes": c.asset_size,
                })),
            })
        })
        .collect();
    Json(serde_json::json!({ "slug": slug, "chapters": arr })).into_response()
}

/// Version of the manifest wire format behind `/api/root` and `/api/dag`.
pub(crate) const MANIFEST_PROTOCOL_VERSION: u32 = 1;

pub(crate) fn manifest_etag(root: &str) -> String {
    format!("\"{root}\"")
}

pub(crate) fn manifest_not_modified(headers: &HeaderMap, root: &str) -> bool {
    !root.is_empty()
        && headers
            .get(header::IF_NONE_MATCH)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value.split(',').any(|candidate| {
                    let candidate = candidate.trim();
                    candidate == "*"
                        || candidate
                            .strip_prefix("W/")
                            .unwrap_or(candidate)
                            .trim_matches('"')
                            == root
                })
            })
}

pub(crate) fn manifest_json_response(root: &str, body: axum::body::Bytes) -> Response {
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-cache");
    if !root.is_empty() {
        response = response.header(header::ETAG, manifest_etag(root));
    }
    response
        .body(Body::from(body))
        .expect("valid manifest response")
}

pub(crate) fn manifest_not_modified_response(root: &str) -> Response {
    Response::builder()
        .status(StatusCode::NOT_MODIFIED)
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::ETAG, manifest_etag(root))
        .body(Body::empty())
        .expect("valid manifest response")
}

/// `GET /api/root` — just the Merkle deploy root, the CHEAPEST possible "did
/// anything change?" probe. The offline client compares this against its cached
/// manifest's root: if equal, the whole tree is unchanged → reuse everything,
/// skip the full `/api/dag` fetch + the per-resource rescan. One hash, no work.
pub(crate) async fn api_root(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let root = match state.store.manifest_root().await {
        Ok(value) => value.unwrap_or_default(),
        Err(error) => return store_unavailable("manifest_root", error),
    };
    if manifest_not_modified(&headers, &root) {
        return manifest_not_modified_response(&root);
    }
    let body = axum::body::Bytes::from(
        serde_json::json!({
            "protocol_version": MANIFEST_PROTOCOL_VERSION,
            "root": root,
        })
        .to_string(),
    );
    manifest_json_response(&root, body)
}

/// `GET /api/dag` — the WHOLE-corpus manifest the lv-sync client mirrors: the
/// deploy root + every resource (artwork / text / units / spoken / audio / marks / asset)
/// as `{ path, hash, kind, bytes, url }`. `hash` is the content address (cache
/// key); `url` is where to fetch it; `bytes` drives the byte-weighted offline %.
/// One round-trip → the client has the full content-addressed index.
pub(crate) async fn api_dag(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let root = match state.store.manifest_root().await {
        Ok(value) => value.unwrap_or_default(),
        Err(error) => return store_unavailable("manifest_root", error),
    };
    if manifest_not_modified(&headers, &root) {
        return manifest_not_modified_response(&root);
    }

    let mut cache = state.dag_cache.lock().await;
    if let Some(cached) = cache.as_ref().filter(|cached| cached.root == root) {
        return manifest_json_response(&root, cached.body.clone());
    }
    let chapters = match state.store.dag_chapters().await {
        Ok(value) => value,
        Err(error) => return store_unavailable("dag_chapters", error),
    };
    let artwork = match state.store.dag_artwork().await {
        Ok(value) => value,
        Err(error) => return store_unavailable("dag_artwork", error),
    };
    let mut resources: Vec<serde_json::Value> = Vec::new();
    let speech_assets = match state.store.speech_assets(None).await {
        Ok(value) => value,
        Err(error) => return store_unavailable("speech_assets", error),
    };
    for asset in speech_assets.iter().filter(|a| a.status == "ready") {
        // Older bundles strip fragments when indexing default audio. A separate
        // synthetic path also protects those installed readers from collisions.
        let doc = format!(
            "{}/{}/{}/@speech/{}/{}",
            asset.book_slug, asset.rendition, asset.lang, asset.profile, asset.rel_path
        );
        for (kind, hash, bytes) in [
            ("audio", &asset.audio_hash, asset.audio_size),
            ("marks", &asset.marks_hash, asset.marks_size),
        ] {
            if let Some(hash) = hash {
                resources.push(serde_json::json!({"path":format!("{doc}#{kind}@{}",asset.profile),"hash":hash,"kind":kind,"bytes":bytes.unwrap_or(0),"url":format!("/api/blob/{hash}")}));
            }
        }
    }
    let slugs: std::collections::BTreeSet<_> = chapters.iter().map(|c| &c.book_slug).collect();
    for slug in slugs {
        for rendition in ["text", "audio"] {
            let url = format!(
                "/api/contents/{}?rendition={rendition}",
                encode_query_value(slug)
            );
            resources.push(serde_json::json!({"path":url,"hash":format!("{root}:{url}"),"kind":"list","bytes":0,"url":url}));
        }
        let url = format!("/api/speech/{}", encode_query_value(slug));
        resources.push(serde_json::json!({"path":url,"hash":format!("{root}:{url}"),"kind":"list","bytes":0,"url":url}));
    }
    for book in &artwork {
        if let Some(hash) = &book.cover_hash {
            resources.push(artwork_resource(
                &book.book_slug,
                "cover",
                hash,
                book.cover_size.unwrap_or(0),
            ));
        }
        if let Some(hash) = &book.backdrop_hash {
            resources.push(artwork_resource(
                &book.book_slug,
                "backdrop",
                hash,
                book.backdrop_size.unwrap_or(0),
            ));
        }
        if let Some(hash) = &book.card_backdrop_hash {
            resources.push(artwork_resource(
                &book.book_slug,
                "card-backdrop",
                hash,
                book.card_backdrop_size.unwrap_or(0),
            ));
        }
    }
    // `<stem>.spoken.md` overlays by edition, so a text chapter's transcript
    // address can fold in the overlay `/api/spoken` actually narrates.
    let overlays: HashMap<(&str, &str, &str), &str> = chapters
        .iter()
        .filter(|c| c.rendition == "text" && c.rel_path.ends_with(".spoken.md"))
        .map(|c| {
            (
                (c.book_slug.as_str(), c.lang.as_str(), c.rel_path.as_str()),
                c.content_hash.as_str(),
            )
        })
        .collect();
    for c in &chapters {
        let doc = format!("{}/{}/{}/{}", c.book_slug, c.rendition, c.lang, c.rel_path);
        // Wire path /api/file expects `<slug>/<rel_path>` + lang/rendition query.
        // Values are percent-encoded so `&`, `+`, `#`, `%`, spaces and non-ASCII
        // in a rel_path survive the handlers' form-urlencoded query decoding.
        let q = format!(
            "path={}&lang={}&rendition={}",
            encode_query_value(&format!("{}/{}", c.book_slug, c.rel_path)),
            encode_query_value(&c.lang),
            encode_query_value(&c.rendition)
        );
        if c.file_type == "markdown" || c.file_type == "html" {
            let overlay = (c.rendition == "text")
                .then(|| c.rel_path.strip_suffix(".md"))
                .flatten()
                .and_then(|stem| {
                    overlays
                        .get(&(
                            c.book_slug.as_str(),
                            c.lang.as_str(),
                            format!("{stem}.spoken.md").as_str(),
                        ))
                        .copied()
                });
            let hashes = derived_text_hashes(&c.content_hash, c.render_version, overlay);
            resources.push(serde_json::json!({
                "path": doc, "hash": hashes.text, "kind": "text",
                "bytes": c.html_bytes.unwrap_or(0), "url": format!("/api/file?{q}"),
            }));
            // Read-along extras, keyed off content_hash so they're stable per
            // source; tiny, so bytes=0 (audio dominates the % anyway).
            //
            // `spoken` (the sentence transcript) backs the read-along for BOTH the
            // text read-aloud AND the AUDIOBOOK page, so cache it for EVERY
            // rendition. It was text-only before — so navigating offline to an
            // un-played audiobook chapter left /api/spoken?rendition=audio uncached
            // (504) and the AudiobookPlayer showed a blank skeleton forever. The
            // native text-sync pulls every non-audio dag resource, so listing it
            // here is all it takes to make the transcript available offline.
            resources.push(serde_json::json!({
                "path": format!("{doc}#spoken"), "hash": hashes.spoken,
                "kind": "spoken", "bytes": 0, "url": format!("/api/spoken?{q}"),
            }));
            // `units` (word-level tap-to-seek) is a text-read-aloud feature only.
            if c.rendition == "text" {
                resources.push(serde_json::json!({
                    "path": format!("{doc}#units"), "hash": hashes.units,
                    "kind": "units", "bytes": 0, "url": format!("/api/units?{q}"),
                }));
            }
        }
        if let Some(h) = &c.audio_hash {
            // Canonical CAF makes the manifest hash, stored object, served bytes,
            // native cache key, and integrity identity the SAME value.
            resources.push(serde_json::json!({
                "path": format!("{doc}#audio"), "hash": h, "kind": "audio",
                "bytes": c.audio_size.unwrap_or(0),
                "url": format!("/api/audio?{q}"),
            }));
        }
        if let Some(h) = &c.marks_hash {
            resources.push(serde_json::json!({
                "path": format!("{doc}#marks"), "hash": h, "kind": "marks",
                "bytes": c.marks_size.unwrap_or(0), "url": format!("/api/blob/{h}"),
            }));
        }
        if let Some(h) = &c.asset_hash {
            resources.push(serde_json::json!({
                "path": format!("{doc}#asset"), "hash": h, "kind": "asset",
                "bytes": c.asset_size.unwrap_or(0), "url": format!("/api/blob/{h}"),
            }));
        }
    }
    // List/spine endpoints — REQUIRED for offline book-OPEN, not just offline read.
    // The chapter bytes above let a cached chapter render, but opening a book from
    // the shelf first resolves its rendition SPINE (`/api/tree?rendition=…`, the
    // ordered chapter list) and the shelf itself needs `/api/books`. Those are live
    // (not content-addressed) and were absent from the dag, so the native cache had
    // every chapter yet a card tap did nothing offline (spine resolve → 504 → the
    // book couldn't be entered). Cache them like everything else, keyed on the
    // merkle `root` so they refresh on every corpus change. These are the exact URLs
    // the client requests via contentFetch (App.tsx enterBook/backToLanding + the
    // shelf load), so the offline cache-first hit matches. Bytes 0 (tiny; the size
    // accounting is dominated by audio anyway).
    //
    // Without a deploy root (filesystem preview) these lists have no content
    // address: a constant key would pin the first copy in the replica forever,
    // so a preview edit never reached the shelf. Leave them url-keyed there.
    let root_key = root.clone();
    let lists: &[&str] = if root.is_empty() {
        &[]
    } else {
        &[
            "/api/books",
            "/api/tree",
            "/api/tree?rendition=text",
            "/api/tree?rendition=audio",
        ]
    };
    for u in lists {
        resources.push(serde_json::json!({
            "path": u, "hash": format!("{root_key}:{u}"), "kind": "list",
            "bytes": 0, "url": u,
        }));
    }
    let body = axum::body::Bytes::from(
        serde_json::json!({
            "protocol_version": MANIFEST_PROTOCOL_VERSION,
            "root": root,
            "resources": resources,
        })
        .to_string(),
    );
    *cache = Some(CachedJson {
        root: root.clone(),
        body: body.clone(),
    });
    manifest_json_response(&root, body)
}

/// Manifest addresses of a text chapter's rendered body and read-along extras.
pub(crate) struct DerivedTextHashes {
    pub(crate) text: String,
    pub(crate) spoken: String,
    pub(crate) units: String,
}

/// The replica keeps a body for as long as its address is unchanged, so each
/// address folds in everything the served bytes derive from: the source hash,
/// the renderer version (a re-render of unchanged source must still reach
/// devices), and for the transcript the `.spoken.md` overlay it narrates.
/// Version 1 keeps the source hash alone, the address every device already has.
pub(crate) fn derived_text_hashes(
    content_hash: &str,
    render_version: i32,
    overlay: Option<&str>,
) -> DerivedTextHashes {
    let base = if render_version <= 1 {
        content_hash.to_string()
    } else {
        format!("{content_hash}:r{render_version}")
    };
    let spoken = match overlay {
        Some(overlay) => format!("{base}:spoken:{overlay}"),
        None => format!("{base}:spoken"),
    };
    DerivedTextHashes {
        units: format!("{base}:units"),
        spoken,
        text: base,
    }
}

pub(crate) fn artwork_resource(
    slug: &str,
    kind: &str,
    hash: &str,
    bytes: i64,
) -> serde_json::Value {
    serde_json::json!({
        "path": format!("{slug}/@{kind}"),
        "hash": hash,
        "kind": kind,
        "bytes": bytes.max(0),
        "url": format!("/api/{kind}?book={}", encode_query_value(slug)),
    })
}

/// Percent-encode one query-string value for the `/api/*` handlers, whose
/// `Query` extractor decodes `application/x-www-form-urlencoded`. Unreserved
/// characters and `/` stay literal so ordinary chapter URLs are byte-identical
/// to the historical unencoded form; everything else (including `+`, which the
/// form decoder would read as a space) is encoded as UTF-8 `%XX`.
pub(crate) fn encode_query_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'/') {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `GET /api/sizes` — PRECOMPUTED download totals (per-book + global), keyed by
/// the deploy root, so the Downloads UI gets a TINY response instead of fetching
/// + parsing the ~4 MB `/api/dag` just to sum sizes. Same byte accounting as the
///
/// dag (canonical audio uses its exact object size). The client caches this by `root` and
/// re-fetches only when the root changes; the per-device CACHED progress is the
/// client's own index — this endpoint is the denominator, not the numerator.
pub(crate) async fn api_sizes(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let root = match state.store.manifest_root().await {
        Ok(value) => value.unwrap_or_default(),
        Err(error) => return store_unavailable("manifest_root", error),
    };
    if manifest_not_modified(&headers, &root) {
        return manifest_not_modified_response(&root);
    }

    let mut cache = state.sizes_cache.lock().await;
    if let Some(cached) = cache.as_ref().filter(|cached| cached.root == root) {
        return manifest_json_response(&root, cached.body.clone());
    }
    let chapters = match state.store.dag_chapters().await {
        Ok(value) => value,
        Err(error) => return store_unavailable("dag_chapters", error),
    };
    #[derive(Default)]
    struct Agg {
        audio_bytes: i64,
        audio_count: i64,
        text_bytes: i64,
        text_count: i64,
    }
    let mut books: std::collections::BTreeMap<String, Agg> = std::collections::BTreeMap::new();
    let mut total = Agg::default();
    for c in &chapters {
        let e = books.entry(c.book_slug.clone()).or_default();
        if c.file_type == "markdown" || c.file_type == "html" {
            let b = c.html_bytes.unwrap_or(0);
            e.text_bytes += b;
            e.text_count += 1;
            total.text_bytes += b;
            total.text_count += 1;
        }
        if c.audio_hash.is_some() {
            let b = c.audio_size.unwrap_or(0);
            e.audio_bytes += b;
            e.audio_count += 1;
            total.audio_bytes += b;
            total.audio_count += 1;
        }
    }
    let speech_assets = match state.store.speech_assets(None).await {
        Ok(value) => value,
        Err(error) => return store_unavailable("speech_assets", error),
    };
    for asset in speech_assets.iter().filter(|a| a.status == "ready") {
        let bytes = asset.audio_size.unwrap_or(0);
        let entry = books.entry(asset.book_slug.clone()).or_default();
        entry.audio_bytes += bytes;
        entry.audio_count += 1;
        total.audio_bytes += bytes;
        total.audio_count += 1;
    }
    let books_json: Vec<serde_json::Value> = books
        .into_iter()
        .map(|(slug, a)| {
            serde_json::json!({
                "slug": slug,
                "audio_bytes": a.audio_bytes, "audio_count": a.audio_count,
                "text_bytes": a.text_bytes, "text_count": a.text_count,
            })
        })
        .collect();
    let body = axum::body::Bytes::from(
        serde_json::json!({
            "protocol_version": MANIFEST_PROTOCOL_VERSION,
            "root": root,
            "audio_bytes": total.audio_bytes, "audio_count": total.audio_count,
            "text_bytes": total.text_bytes, "text_count": total.text_count,
            "books": books_json,
        })
        .to_string(),
    );
    *cache = Some(CachedJson {
        root: root.clone(),
        body: body.clone(),
    });
    manifest_json_response(&root, body)
}
