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
        .speech_policy(&row.book_slug, &row.rendition)
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
        let config = state.store.speech_policy(slug, rendition).await?;
        policies.insert(
            rendition.into(),
            serde_json::to_value(&config).map_err(|e| e.to_string())?,
        );
        let legacy = legacy_voice(state, slug, rendition).await;
        for source in sources.iter().filter(|s| s.rendition == rendition) {
            let effective = config.effective(&source.lang, &source.rel_path);
            let options = &effective.options;
            let default = options.default_for(&source.lang, legacy.as_deref());
            let available = if !options.has_audio_options() {
                Vec::new()
            } else {
                options.available_voices(&source.lang, legacy.as_deref())
            };
            let recipes: Vec<_> = available
                .into_iter()
                .map(|voice| {
                    let recipe = options.recipe(&voice);
                    let label = speech::label(&voice);
                    (voice, recipe.encode(), recipe.id(), label)
                })
                .collect();
            let choices: Vec<_> = recipes.iter().map(|(voice, recipe, profile, label)| {
                let asset = assets.get(&(rendition,source.lang.as_str(),source.rel_path.as_str(),profile.as_str()));
                let is_baked_default = (source.audio_voice.as_deref()==Some(recipe) || (!options.has_audio_options() && source.audio_voice.as_deref().is_none_or(|v|v==voice))) && source.audio_hash.is_some() && source.marks_hash.is_some();
                let (status,audio,marks,bytes) = if is_baked_default {
                    ("ready",source.audio_hash.as_ref(),source.marks_hash.as_ref(),source.audio_size)
                } else if let Some(asset) = asset {
                    (asset.status.as_str(),asset.audio_hash.as_ref(),asset.marks_hash.as_ref(),asset.audio_size)
                } else if source.task_voice.as_deref().and_then(|v|speech::Recipe::decode(v).ok()) == speech::Recipe::decode(recipe).ok() && source.task_status.as_deref().is_some_and(|s|matches!(s,"queued"|"running"|"failed")) {
                    (source.task_status.as_deref().unwrap_or("available"),None,None,None)
                } else { ("available",None,None,None) };
                serde_json::json!({"id":voice,"label":label,"status":status,"audio_hash":audio,"marks_hash":marks,"bytes":bytes})
            }).collect();
            let bitrate = if !options.has_audio_options() {
                24
            } else {
                options.bitrate_kbps.unwrap_or(96)
            };
            chapters.push(serde_json::json!({"id":format!("{rendition}/{}/{}",source.lang,source.rel_path),"default_voice":default,"voices":choices,"effective":{"default_voice":default,"bitrate_kbps":bitrate,"speed_percent":options.speed_percent.unwrap_or(100),"sources":effective.sources},"encoding":{"container":"caf","codec":"mp3","sample_rate_hz":24000,"channels":1,"bitrate_kbps":bitrate,"speed_percent":options.speed_percent.unwrap_or(100)}}));
        }
    }
    let mut installed = Vec::new();
    if std::env::var_os("LIVEVIEW_KOKORO_TTS_CMD").is_some() {
        installed.extend(["kokoro:af_heart", "kokoro:af_bella"]);
    }
    Ok(
        serde_json::json!({"chapters":chapters,"policies":policies,"installed_voices":installed,"bitrates_kbps":[32,48,64,96,128,160]}),
    )
}

#[derive(serde::Deserialize)]
pub(crate) struct PolicyRequest {
    #[serde(default)]
    rendition: Option<String>,
    #[serde(default)]
    chapter: Option<String>,
    speech: speech::SpeechConfig,
}

pub(crate) async fn api_speech_defaults(State(state): State<SharedState>) -> Response {
    match state.store.speech_policy("", "").await {
        Ok(policy) => Json(policy.global).into_response(),
        Err(error) => store_unavailable("speech defaults", error),
    }
}

pub(crate) async fn api_preparation(State(state): State<SharedState>) -> Response {
    match state.store.preparation_status(None).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => store_unavailable("audio preparation", error),
    }
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PreparationRequest {
    paused: bool,
}
pub(crate) async fn api_set_preparation(
    State(state): State<SharedState>,
    Json(request): Json<PreparationRequest>,
) -> Response {
    match state.store.preparation_status(Some(request.paused)).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => store_unavailable("audio preparation", error),
    }
}
pub(crate) async fn api_set_speech_defaults(
    State(state): State<SharedState>,
    Json(config): Json<speech::SpeechConfig>,
) -> Response {
    if let Err(error) = config.validate() {
        return (StatusCode::BAD_REQUEST, error).into_response();
    }
    match state
        .store
        .set_speech_scope(None, None, None, &config)
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => store_unavailable("speech defaults", error),
    }
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
    let exists = match &request.rendition {
        Some(rendition) => RenditionKind::parse(rendition)
            .and_then(|kind| cat.book(&slug).and_then(|b| b.rendition(kind)))
            .is_some(),
        None => cat.book(&slug).is_some() && request.chapter.is_none(),
    };
    drop(cat);
    if !exists {
        return StatusCode::NOT_FOUND.into_response();
    }
    match state
        .store
        .set_speech_scope(
            Some(&slug),
            request.rendition.as_deref(),
            request.chapter.as_deref(),
            &request.speech,
        )
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
            .speech_policy(&row.book_slug, &row.rendition)
            .await?;
        let config = config.effective(&row.lang, &row.rel_path).options;
        if !config
            .available_voices(
                &row.lang,
                legacy_voice(&state, &row.book_slug, &row.rendition)
                    .await
                    .as_deref(),
            )
            .contains(&request.voice)
        {
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
