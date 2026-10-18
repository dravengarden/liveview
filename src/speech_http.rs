//! Book-scoped speech choices. URLs and hashes always refer to one recipe;
//! choosing a voice never mutates the shared book default or another device.
use super::*;

async fn legacy_voice(state: &AppState, book: &str, rendition: &str) -> Option<String> {
    let cat = state.catalog.read().await;
    cat.book(book)
        .and_then(|b| {
            RenditionKind::parse(rendition)
                .and_then(|kind| b.rendition(kind))
                .and_then(|r| r.voice.clone())
                .or_else(|| {
                    b.rendition(RenditionKind::Audio)
                        .and_then(|r| r.voice.clone())
                })
        })
        .or_else(|| state.tts_voice.clone())
}

pub(crate) async fn default_voice(state: &AppState, row: &ChapterRecord) -> Result<String, String> {
    let config = state
        .store
        .speech_config(&row.book_slug, &row.rendition)
        .await?;
    Ok(config.resolve(
        &row.lang,
        &row.rel_path,
        legacy_voice(state, &row.book_slug, &row.rendition)
            .await
            .as_deref(),
    ))
}

pub(crate) async fn api_speech_book(
    State(state): State<SharedState>,
    axum::extract::Path(slug): axum::extract::Path<String>,
) -> Response {
    match speech_book(&state, &slug).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => store_unavailable("speech choices", error),
    }
}

async fn speech_book(state: &AppState, slug: &str) -> Result<serde_json::Value, String> {
    let sources = state.store.speech_sources(slug).await?;
    let assets = state.store.speech_assets(Some(slug)).await?;
    let assets: HashMap<_, _> = assets
        .iter()
        .map(|asset| {
            (
                (
                    asset.rendition.as_str(),
                    asset.lang.as_str(),
                    asset.rel_path.as_str(),
                    asset.profile.as_str(),
                ),
                asset,
            )
        })
        .collect();
    let mut chapters = Vec::new();
    let mut policies = serde_json::Map::new();
    for rendition in ["text", "audio"] {
        let config = state.store.speech_config(slug, rendition).await?;
        policies.insert(
            rendition.into(),
            serde_json::to_value(&config).map_err(|e| e.to_string())?,
        );
        if config.voices.is_empty() {
            continue;
        }
        let legacy = legacy_voice(state, slug, rendition).await;
        let recipes: Vec<_> = config
            .voices
            .iter()
            .map(|voice| {
                let recipe = config.recipe(voice);
                (voice, recipe.encode(), recipe.id(), speech::label(voice))
            })
            .collect();
        for source in sources.iter().filter(|s| s.rendition == rendition) {
            let default = config.default_for(&source.lang, &source.rel_path, legacy.as_deref());
            let choices: Vec<_> = recipes.iter().map(|(voice, recipe, profile, label)| {
                let asset = assets.get(&(rendition,source.lang.as_str(),source.rel_path.as_str(),profile.as_str()));
                let is_baked_default = source.audio_voice.as_deref()==Some(recipe) && source.audio_hash.is_some() && source.marks_hash.is_some();
                let (status,audio,marks,bytes) = if is_baked_default {
                    ("ready",source.audio_hash.as_ref(),source.marks_hash.as_ref(),source.audio_size)
                } else if let Some(asset) = asset {
                    (asset.status.as_str(),asset.audio_hash.as_ref(),asset.marks_hash.as_ref(),asset.audio_size)
                } else { ("available",None,None,None) };
                serde_json::json!({"id":voice,"label":label,"status":status,"audio_hash":audio,"marks_hash":marks,"bytes":bytes})
            }).collect();
            chapters.push(serde_json::json!({"id":format!("{rendition}/{}/{}",source.lang,source.rel_path),"default_voice":default,"voices":choices}));
        }
    }
    Ok(serde_json::json!({"chapters":chapters,"policies":policies}))
}

#[derive(serde::Deserialize)]
pub(crate) struct PolicyRequest {
    rendition: String,
    speech: speech::SpeechConfig,
}

pub(crate) async fn api_set_speech(
    State(state): State<SharedState>,
    axum::extract::Path(slug): axum::extract::Path<String>,
    Json(request): Json<PolicyRequest>,
) -> Response {
    if let Err(error) = request.speech.validate() {
        return (StatusCode::BAD_REQUEST, error).into_response();
    }
    let cat = state.catalog.read().await;
    let exists = RenditionKind::parse(&request.rendition)
        .and_then(|kind| cat.book(&slug).and_then(|b| b.rendition(kind)))
        .is_some();
    drop(cat);
    if !exists {
        return StatusCode::NOT_FOUND.into_response();
    }
    match state
        .store
        .set_speech_config(&slug, &request.rendition, &request.speech)
        .await
    {
        Ok(()) => {
            let _=state.tx.send(serde_json::json!({"type":"chapter-ready","book":slug,"rendition":request.rendition}).to_string());
            StatusCode::NO_CONTENT.into_response()
        }
        Err(error) => store_unavailable("speech policy", error),
    }
}

#[derive(serde::Deserialize)]
pub(crate) struct VoiceRequest {
    voice: String,
}

pub(crate) async fn api_request_speech(
    State(state): State<SharedState>,
    Query(query): Query<FileQuery>,
    Json(request): Json<VoiceRequest>,
) -> Response {
    let Some(ctx) = resolve_req(&state, &query).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let result = async {
        let (row, _) = state
            .store
            .get_chapter_fallback(
                &ctx.slug,
                ctx.kind.as_str(),
                &ctx.lang,
                &ctx.default_lang,
                &ctx.rest,
            )
            .await?
            .ok_or("Chapter not found")?;
        let config = state
            .store
            .speech_config(&row.book_slug, &row.rendition)
            .await?;
        if !config.voices.contains(&request.voice) {
            return Err("This voice is not allowed for this book".to_string());
        }
        if state.tts_cmd.is_none()
            || (request.voice.starts_with("kokoro:")
                && std::env::var_os("LIVEVIEW_KOKORO_TTS_CMD").is_none())
        {
            return Err("This speech engine is unavailable on the server".into());
        }
        state
            .store
            .queue_speech(&row, &config.recipe(&request.voice))
            .await
    }
    .await;
    match result {
        Ok(()) => (
            StatusCode::ACCEPTED,
            Json(serde_json::json!({"status":"queued"})),
        )
            .into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, error).into_response(),
    }
}
