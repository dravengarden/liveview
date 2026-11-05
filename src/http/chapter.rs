use super::*;

#[derive(serde::Deserialize)]
pub(crate) struct FileQuery {
    pub(crate) path: String,
    /// Language edition to read. Omitted ⇒ the book's default edition.
    pub(crate) lang: Option<String>,
    /// Reading mode (`"text"` / `"audio"`). Omitted ⇒ the book's default
    /// rendition. An unknown value is treated as the default (text-ish) mode.
    pub(crate) rendition: Option<String>,
    /// Audio only: `"bookend"` asks `/api/audio` to append the spoken
    /// "end of the whole book" cue to this chapter's MP3. The client sets it only
    /// for the LAST chapter in the book's queue (it knows the spine order), so
    /// the server needs no spine knowledge. Ignored by the other handlers.
    pub(crate) tail: Option<String>,
}

/// A resolved request: the concrete rendition + the `(lang, default_lang)` pair
/// for overlay→base, plus the slug and the rest-of-path under the book.
pub(crate) struct ReqCtx {
    pub(crate) kind: RenditionKind,
    pub(crate) lang: String,
    pub(crate) default_lang: String,
    pub(crate) slug: String,
    pub(crate) rest: String,
}

impl ReqCtx {
    /// Look up `rel_path` in this book's `kind` rendition, falling back from
    /// the requested edition to the book default. Returns the row and the
    /// edition actually served; each endpoint keeps its own fallback order
    /// and its own mapping of a missing row versus a store error.
    pub(crate) async fn chapter_at(
        &self,
        state: &AppState,
        kind: RenditionKind,
        rel_path: &str,
    ) -> Result<Option<(ChapterRecord, String)>, String> {
        state
            .store
            .get_chapter_fallback(
                &self.slug,
                kind.as_str(),
                &self.lang,
                &self.default_lang,
                rel_path,
            )
            .await
    }

    /// The chapter the request names, in the requested rendition.
    pub(crate) async fn chapter(
        &self,
        state: &AppState,
    ) -> Result<Option<(ChapterRecord, String)>, String> {
        self.chapter_at(state, self.kind, &self.rest).await
    }
}

/// Split a wire path `<slug>/<rel_path>` and validate `rel_path` as a strictly
/// relative, normalized path under the book. `None` for an empty path, an
/// absolute path, or any empty / `.` / `..` / NUL-bearing segment — the
/// filesystem preview joins `rel_path` onto the book's source directory, so a
/// traversal segment would otherwise escape it.
pub(crate) fn split_request_path(path: &str) -> Option<(&str, &str)> {
    let (slug, rest) = path.split_once('/')?;
    if slug.is_empty() || !is_safe_rel_path(rest) {
        return None;
    }
    Some((slug, rest))
}

pub(crate) fn is_safe_rel_path(rest: &str) -> bool {
    !rest.is_empty()
        && rest
            .split('/')
            .all(|seg| !seg.is_empty() && seg != "." && seg != ".." && !seg.contains('\0'))
        && Path::new(rest)
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
}

/// Resolve `(path, rendition token, lang)` against the catalog: the book picks
/// the rendition (the token, else its default); the rendition picks the lang
/// (the query, else its default). `None` ⇒ unknown book or an unsafe path.
pub(crate) async fn resolve_req(state: &AppState, q: &FileQuery) -> Option<ReqCtx> {
    let (slug, rest) = split_request_path(&q.path)?;
    let cat = state.catalog.read().await;
    let book = cat.book(slug)?;
    let kind = q
        .rendition
        .as_deref()
        .and_then(RenditionKind::parse)
        .unwrap_or(book.default_rendition);
    let rend = book.rendition(kind).unwrap_or(book.default_rendition());
    Some(ReqCtx {
        kind: rend.kind,
        lang: q.lang.clone().unwrap_or_else(|| rend.default_lang.clone()),
        default_lang: rend.default_lang.clone(),
        slug: slug.to_string(),
        rest: rest.to_string(),
    })
}

/// Resolve specifically against a book's `audio` rendition (for /api/audio +
/// /api/marks), independent of the request's rendition token. `None` ⇒ unknown
/// book or no audio rendition.
pub(crate) async fn resolve_audio(state: &AppState, q: &FileQuery) -> Option<ReqCtx> {
    let (slug, rest) = split_request_path(&q.path)?;
    let cat = state.catalog.read().await;
    let book = cat.book(slug)?;
    let rend = book.rendition(RenditionKind::Audio)?;
    Some(ReqCtx {
        kind: RenditionKind::Audio,
        lang: q.lang.clone().unwrap_or_else(|| rend.default_lang.clone()),
        default_lang: rend.default_lang.clone(),
        slug: slug.to_string(),
        rest: rest.to_string(),
    })
}

pub(crate) async fn api_file(
    State(state): State<SharedState>,
    Query(query): Query<FileQuery>,
) -> impl IntoResponse {
    let not_found = || {
        (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "File not found"})),
        )
            .into_response()
    };
    let Some(ctx) = resolve_req(&state, &query).await else {
        return not_found();
    };
    let chapter = ctx.chapter(&state).await;
    let (row, served_lang) = match chapter {
        Ok(Some(x)) => x,
        Ok(None) => return not_found(),
        Err(e) => {
            tracing::warn!(error = %e, "chapter read failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, "read failed").into_response();
        }
    };

    let file_type = FileType::from_path(&query.path);
    // Binary files: metadata only — frontend uses /api/raw for the bytes.
    let content = if matches!(file_type, FileType::Image | FileType::Pdf) {
        String::new()
    } else {
        // HTML was pre-rendered at sync time and stored in pg.
        row.html.unwrap_or_default()
    };
    Json(FileContent {
        path: query.path,
        lang: served_lang,
        file_type,
        content,
    })
    .into_response()
}

/// Resolve a chapter's **narration source** over pg: for the text rendition,
/// prefer the distilled `<id>.spoken.md` chapter, else the raw `<id>.md`; for
/// audio, the `<aid>.spoken.md` chapter IS the script. Returns the chapter +
/// the served lang (overlay → base).
///
/// A store error is propagated, never treated as "absent": silently falling
/// back to the raw `.md` would synthesize (and cache under the chapter's
/// content-addressed key) narration from the wrong source.
pub(crate) async fn resolve_narration(
    state: &AppState,
    ctx: &ReqCtx,
) -> Result<Option<(ChapterRecord, String)>, String> {
    if ctx.kind == RenditionKind::Text
        && let Some(stem) = ctx.rest.strip_suffix(".md")
    {
        let spoken = format!("{stem}.spoken.md");
        if let Some(hit) = ctx.chapter_at(state, RenditionKind::Text, &spoken).await? {
            return Ok(Some(hit));
        }
    }
    let direct = ctx.chapter(state).await?;
    if direct.is_some() || ctx.kind != RenditionKind::Audio {
        return Ok(direct);
    }

    // Some `book.toml` corpora expose an audiobook spine as virtual
    // `<id>.spoken.md` paths while storing the generated narration on the source
    // text chapter (`<id>.md`). Prefer a real curated audio row above, then map
    // that virtual path back to its text source. Audio, marks, and transcript all
    // use this same fallback so their sentence indexes stay aligned.
    let Some(text_path) = audio_text_fallback_path(&ctx.rest) else {
        return Ok(None);
    };
    ctx.chapter_at(state, RenditionKind::Text, &text_path).await
}

pub(crate) fn audio_text_fallback_path(path: &str) -> Option<String> {
    path.strip_suffix(".spoken.md")
        .map(|stem| format!("{stem}.md"))
}

#[derive(serde::Serialize)]
pub(crate) struct SpokenContent {
    /// Edition actually served (overlay → base fallback).
    pub(crate) lang: String,
    /// Ordered speakable sentences. Index = the `data-sent` anchor the player
    /// highlights and the marks.json index — one shared segmentation.
    pub(crate) sentences: Vec<String>,
}

/// Read-along narration text segmented into sentences. For the **audio**
/// rendition the chapter's `<aid>.spoken.md` IS the script — read it directly.
/// For the **text** rendition, prefer the distilled `<id>.spoken.md` overlay,
/// else the raw `<id>.md` mechanically stripped. Same overlay → base resolution
/// as /api/file.
pub(crate) async fn api_spoken(
    State(state): State<SharedState>,
    Query(query): Query<FileQuery>,
) -> impl IntoResponse {
    if !matches!(FileType::from_path(&query.path), FileType::Markdown) {
        return (StatusCode::BAD_REQUEST, "not a markdown chapter").into_response();
    }
    let Some(ctx) = resolve_req(&state, &query).await else {
        return (StatusCode::NOT_FOUND, "File not found").into_response();
    };
    match resolve_narration(&state, &ctx).await {
        Ok(Some((row, served_lang))) => {
            let md = row.markdown.unwrap_or_default();
            Json(SpokenContent {
                lang: served_lang,
                sentences: content::spoken::spoken_sentences(&md),
            })
            .into_response()
        }
        Ok(None) => (StatusCode::NOT_FOUND, "File not found").into_response(),
        Err(error) => store_unavailable("resolve_narration", error),
    }
}

#[derive(serde::Serialize)]
pub(crate) struct SpokenUnitsContent {
    /// Edition actually served (overlay → base fallback).
    pub(crate) lang: String,
    /// Ordered read-along units: prose sentences + classified non-prose blocks
    /// (code/image/math/table/html), each carrying a `blk` anchor. `idx` matches
    /// the audio-mark index and the `data-sent` anchor.
    pub(crate) units: Vec<content::spoken::Unit>,
}

/// Read-along units for the in-place highlight (the richer sibling of
/// /api/spoken), derived from the chapter markdown on the fly (a cheap comrak
/// parse — no storage, no schema).
///
/// CRUCIAL: this resolves the **displayed** chapter exactly like `/api/file`
/// (the rendered `.md`), NOT via `resolve_narration` (which prefers a
/// `<id>.spoken.md` audiobook-script overlay). The highlight ranges + `blk`
/// anchors must match the HTML the reader actually shows; an overlay is a
/// different, rewritten document with a different block structure, so using it
/// would land every anchor on the wrong block → whole-block mis-highlighting.
pub(crate) async fn api_units(
    State(state): State<SharedState>,
    Query(query): Query<FileQuery>,
) -> impl IntoResponse {
    if !matches!(FileType::from_path(&query.path), FileType::Markdown) {
        return (StatusCode::BAD_REQUEST, "not a markdown chapter").into_response();
    }
    let Some(ctx) = resolve_req(&state, &query).await else {
        return (StatusCode::NOT_FOUND, "File not found").into_response();
    };
    match ctx.chapter(&state).await {
        Ok(Some((row, served_lang))) => {
            let md = row.markdown.unwrap_or_default();
            Json(SpokenUnitsContent {
                lang: served_lang,
                units: content::spoken::spoken_units(&md),
            })
            .into_response()
        }
        Ok(None) => (StatusCode::NOT_FOUND, "File not found").into_response(),
        Err(error) => store_unavailable("get_chapter_fallback", error),
    }
}

/// Raw binary (image / PDF) bytes for a chapter, streamed from rustfs.
pub(crate) async fn api_raw(
    State(state): State<SharedState>,
    Query(query): Query<FileQuery>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let Some(ctx) = resolve_req(&state, &query).await else {
        return (StatusCode::NOT_FOUND, "File not found").into_response();
    };
    let row = match ctx.chapter(&state).await {
        Ok(Some((row, _))) => row,
        Ok(None) => return (StatusCode::NOT_FOUND, "File not found").into_response(),
        Err(error) => return store_unavailable("get_chapter_fallback", error),
    };
    let Some(hash) = row.asset_hash else {
        return (StatusCode::NOT_FOUND, "not a binary asset").into_response();
    };
    match blob_response(&state, &hash, &headers, "public, max-age=3600").await {
        Some(resp) => resp,
        None => (StatusCode::NOT_FOUND, "File not found").into_response(),
    }
}
