//! Optional voice generation does not block requests or replace default audio.
use super::{audio, audio_worker::put_blob, narration, speakable, spoken};
use crate::store::{pg::PgStore, speech::SpeechAsset};
use crate::sync::objstore::ObjStore;
use std::time::Duration;
use tokio::sync::broadcast;

pub fn spawn(pg: PgStore, obj: ObjStore, command: String, tx: broadcast::Sender<String>) {
    let scanner = pg.clone();
    tokio::spawn(async move {
        let mut cursor = Default::default();
        loop {
            let delay = match scanner.prepare_speech_page(&mut cursor).await {
                Ok(true) => Duration::from_secs(30),
                Ok(false) => Duration::from_millis(250),
                Err(error) => {
                    tracing::warn!(%error,"automatic speech scan failed");
                    Duration::from_secs(5)
                }
            };
            tokio::time::sleep(delay).await;
        }
    });
    // One interactive-only slot remains available during a long backfill.
    for interactive in [false, true] {
        let (pg, obj, command, tx) = (pg.clone(), obj.clone(), command.clone(), tx.clone());
        tokio::spawn(async move {
            loop {
                match pg.claim_speech_slot(interactive).await {
                    Ok(Some(job)) => {
                        let work = generate(&pg, &obj, &command, &job);
                        tokio::pin!(work);
                        let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
                        let result = loop {
                            tokio::select! {
                                result = &mut work => break result,
                                _ = heartbeat.tick() => {
                                    if let Err(error) = pg.renew_speech(&job).await {
                                        tracing::warn!(%error,"speech lease renewal failed");
                                    }
                                }
                            }
                        };
                        if let Err(error) = &result {
                            tracing::warn!(%error,book=%job.book_slug,path=%job.rel_path,"voice generation failed");
                        }
                        match pg.finish_speech(&job, result).await {
                            Ok(true) => {
                                let _ = tx.send(serde_json::json!({"type":"chapter-ready","book":job.book_slug,"rendition":job.rendition,"lang":job.lang,"path":job.rel_path}).to_string());
                            }
                            Ok(false) => {}
                            Err(error) => tracing::warn!(%error,"record speech failed"),
                        }
                    }
                    Ok(None) => tokio::time::sleep(Duration::from_millis(1500)).await,
                    Err(error) => {
                        tracing::warn!(%error,"claim speech failed");
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                }
            }
        });
    }
}

async fn generate(
    pg: &PgStore,
    obj: &ObjStore,
    command: &str,
    job: &SpeechAsset,
) -> Result<(String, String), String> {
    let row = pg
        .get_chapter(&job.book_slug, &job.rendition, &job.lang, &job.rel_path)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Chapter removed")?;
    if row.content_hash != job.content_hash {
        return Err("Chapter changed".into());
    }
    let md = row.markdown.unwrap_or_default();
    let texts = if job.rendition == "audio" {
        spoken::spoken_sentences(&md)
    } else {
        let units = spoken::spoken_units(&md);
        let keys = speakable::narration_keys(&units, &job.lang);
        let store = narration::NarrationStore::from_pairs(
            pg.load_narration(&keys).await.map_err(|e| e.to_string())?,
        );
        units
            .iter()
            .map(|u| speakable::unit_speech(u, &job.lang, &store))
            .collect()
    };
    let (mp3, marks) = audio::synthesize(command, &job.recipe, &texts).await?;
    let caf = crate::audio_http::encode_speech_audio(mp3, &job.recipe).await?;
    let audio = put_blob(pg, obj, caf, crate::AUDIO_VARIANT.mime).await?;
    let marks = put_blob(
        pg,
        obj,
        serde_json::to_vec(&marks).map_err(|e| e.to_string())?,
        "application/json",
    )
    .await?;
    Ok((audio, marks))
}
