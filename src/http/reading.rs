use super::*;

#[derive(serde::Deserialize)]
pub(crate) struct TreeQuery {
    /// Reading mode whose spine to return. Omitted/unknown ⇒ `text`.
    pub(crate) rendition: Option<String>,
}

/// The sidebar forest for a rendition — the JSON `liveview sync` precomputed
/// and stored in `site_tree`, returned verbatim. Empty `[]` when absent.
pub(crate) async fn api_tree(
    State(state): State<SharedState>,
    Query(q): Query<TreeQuery>,
) -> impl IntoResponse {
    let kind = q
        .rendition
        .as_deref()
        .and_then(RenditionKind::parse)
        .unwrap_or(RenditionKind::Text);
    // A store error is a 503, not an empty `[]`: an empty spine is a valid,
    // cacheable answer that the offline replica would keep until the next root.
    match state.store.get_site_tree(kind.as_str()).await {
        Ok(json) => (
            [(header::CONTENT_TYPE, "application/json")],
            json.unwrap_or_else(|| "[]".to_string()),
        )
            .into_response(),
        Err(error) => store_unavailable("get_site_tree", error),
    }
}

#[derive(serde::Deserialize)]
pub(crate) struct ProgressQuery {
    /// Restrict to one book's chapters (newest first). Omitted ⇒ everything.
    pub(crate) book: Option<String>,
}

/// Reading progress for restoring scroll position / resuming the last-read
/// chapter.
pub(crate) async fn api_progress_get(
    State(state): State<SharedState>,
    Query(q): Query<ProgressQuery>,
) -> impl IntoResponse {
    let Some(slug) = q.book.as_deref() else {
        // `book` is required: the client always restores per-book. Without it,
        // return empty rather than dumping every book's rows.
        return Json(Vec::<ProgressEntry>::new()).into_response();
    };
    match state.store.progress_for_book(slug).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => {
            tracing::warn!(error = %e, "progress read failed");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// The latest-read chapter per book (newest first), for the landing page's
/// "continue reading" indicators.
pub(crate) async fn api_progress_recent(State(state): State<SharedState>) -> impl IntoResponse {
    match state.store.progress_recent_per_rendition().await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => {
            tracing::warn!(error = %e, "progress recent read failed");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[derive(serde::Deserialize)]
pub(crate) struct ProgressUpdate {
    pub(crate) path: String,
    /// Scroll position as a 0..1 ratio of the document's scrollable height.
    pub(crate) scroll: f64,
    /// Client edit time (unix ms). Drives last-write-wins: a stale offline replay
    /// carries the OLD edit time, so the server keeps a newer value written by
    /// another device meanwhile. Absent (legacy/PWA clients) ⇒ stamped `now`, which
    /// always wins — same as the previous unconditional upsert.
    #[serde(default)]
    pub(crate) ts: Option<i64>,
}

/// Save one document's scroll position (debounced by the client).
pub(crate) async fn api_progress_put(
    State(state): State<SharedState>,
    Json(body): Json<ProgressUpdate>,
) -> impl IntoResponse {
    match state
        .store
        .progress_upsert(&body.path, body.scroll, body.ts)
        .await
    {
        // 204 whether or not the LWW guard kept our value — the write was DELIVERED;
        // the client drops it from its queue either way (a rejected stale write is
        // superseded, not retried). Only the network-failure path retries.
        Ok(_applied) => StatusCode::NO_CONTENT,
        Err(e) => {
            tracing::warn!(error = %e, "progress write failed");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

#[derive(serde::Deserialize)]
pub(crate) struct SettingPut {
    pub(crate) key: String,
    pub(crate) value: String,
    /// Client edit time (unix ms) — last-write-wins, see `ProgressUpdate::ts`.
    #[serde(default)]
    pub(crate) ts: Option<i64>,
}

/// Player settings (playback rate, sleep-timer, …) for cross-device sync.
pub(crate) async fn api_settings_get(State(state): State<SharedState>) -> impl IntoResponse {
    match state.store.settings_all().await {
        Ok(rows) => {
            let map: HashMap<String, String> = rows.into_iter().collect();
            Json(map).into_response()
        }
        // Never answer `{}` on failure: the client would reconcile its local
        // settings against an empty server state.
        Err(error) => store_unavailable("settings_all", error),
    }
}

/// Save one player setting.
pub(crate) async fn api_settings_put(
    State(state): State<SharedState>,
    Json(body): Json<SettingPut>,
) -> impl IntoResponse {
    match state
        .store
        .settings_set(&body.key, &body.value, body.ts)
        .await
    {
        // Broadcast ONLY when the LWW guard actually accepted our value — a stale
        // replay that lost to a newer cross-device edit changed nothing, so pushing
        // it would make peers re-reconcile to an older value. `applied=false` ⇒
        // silent 204 (delivered, superseded).
        Ok(applied) => {
            if applied {
                // Mirror `broadcast_tree`: clone before the response so the PUT's
                // own return value is unaffected.
                if let Ok(s) = serde_json::to_string(&WsMessage::SettingUpdate {
                    key: body.key.clone(),
                    value: body.value.clone(),
                }) {
                    let _ = state.tx.send(s);
                }
            }
            StatusCode::NO_CONTENT
        }
        Err(e) => {
            tracing::warn!(error = %e, "settings write failed");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

#[derive(serde::Serialize)]
pub(crate) struct LangInfo {
    pub(crate) lang: String,
    pub(crate) label: String,
}

/// One reading mode of a book, for the rendition toggle.
#[derive(serde::Serialize)]
pub(crate) struct RenditionInfo {
    /// `"text"` / `"audio"`.
    pub(crate) kind: String,
    /// Mode-toggle label ("阅读" / "听书").
    pub(crate) label: String,
    pub(crate) default_lang: String,
    pub(crate) langs: Vec<LangInfo>,
}

#[derive(serde::Serialize)]
pub(crate) struct BookInfo {
    pub(crate) label: String,
    pub(crate) slug: String,
    pub(crate) description: Option<String>,
    /// Author-defined keywords used for local search and faceted discovery.
    pub(crate) tags: Vec<String>,
    /// Optional shelf grouping key (book.toml top-level `collection`).
    pub(crate) collection: Option<String>,
    /// Optional credit line shown on the shelf card (book.toml top-level `author`).
    pub(crate) author: Option<String>,
    /// Whether a cover image is available at `/api/cover?book=<slug>`.
    pub(crate) cover: bool,
    /// Whether wide LiveView artwork is available at `/api/backdrop?book=<slug>`.
    pub(crate) backdrop: bool,
    /// Which rendition the book opens in.
    pub(crate) default_rendition: String,
    /// Every reading mode the book offers (always ≥1).
    pub(crate) renditions: Vec<RenditionInfo>,
    /// Mirrors the default rendition's languages, for clients that still read
    /// the flat language list.
    pub(crate) default_lang: String,
    pub(crate) langs: Vec<LangInfo>,
    /// `true` for a `book.toml`-driven book (the sidebar is a clean, titled
    /// spine — "book" mode); `false` for a plain `[[book]]`/`[[mount]]` whose
    /// sidebar is the raw filesystem tree ("docs" mode). Mirrors the default
    /// rendition. The frontend renders the two modes differently.
    pub(crate) manifest: bool,
    /// Deploy-time stamps (unix ms): when the book first appeared on the shelf
    /// and the last sync that changed its content. 0 ⇒ never stamped (hide in
    /// the UI). NOT git times.
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

/// Lightweight list of books for the landing page ("bookshelf"): the curated
/// label, its slug (entry path), an optional blurb, and the available
/// language editions for the in-book language switcher.
pub(crate) async fn api_books(State(state): State<SharedState>) -> impl IntoResponse {
    use crate::server::catalog::RenditionMeta;
    let lang_infos = |r: &RenditionMeta| -> Vec<LangInfo> {
        r.editions
            .iter()
            .map(|e| LangInfo {
                lang: e.lang.clone(),
                label: e.label.clone(),
            })
            .collect()
    };
    let cat = state.catalog.read().await;
    let books: Vec<BookInfo> = cat
        .books
        .iter()
        .map(|b| {
            let default = b.default_rendition();
            BookInfo {
                label: b.label.clone(),
                slug: b.slug.clone(),
                description: b.description.clone(),
                tags: b.tags.clone(),
                collection: b.collection.clone(),
                author: b.author.clone(),
                cover: b.cover_hash.is_some(),
                backdrop: b.backdrop_hash.is_some(),
                default_rendition: b.default_rendition.as_str().to_string(),
                renditions: b
                    .renditions
                    .iter()
                    .map(|r| RenditionInfo {
                        kind: r.kind.as_str().to_string(),
                        label: r.label.clone(),
                        default_lang: r.default_lang.clone(),
                        langs: lang_infos(r),
                    })
                    .collect(),
                // Mirror the default rendition for back-compat clients.
                default_lang: default.default_lang.clone(),
                langs: lang_infos(default),
                manifest: default.manifest,
                created_at: b.created_at,
                updated_at: b.updated_at,
            }
        })
        .collect();
    axum::Json(books)
}
