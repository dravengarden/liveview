//! Optional voice generation does not block requests or replace default audio.
use super::synthesis;
use crate::config::RenditionKind;
use crate::shared::WsMessage;
use crate::store::objstore::ObjStore;
use crate::store::{pg::PgStore, speech::SpeechAsset};
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
                                let _ = tx.send(
                                    WsMessage::ChapterReady {
                                        book: job.book_slug.clone(),
                                        rendition: Some(job.rendition.clone()),
                                        lang: Some(job.lang.clone()),
                                        path: Some(job.rel_path.clone()),
                                    }
                                    .to_frame(),
                                );
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
    let kind = if RenditionKind::Audio.is(&job.rendition) {
        RenditionKind::Audio
    } else {
        RenditionKind::Text
    };
    let texts = synthesis::speech_texts(pg, kind, &md, &job.lang).await?;
    synthesis::synthesize_chapter(pg, obj, command, &job.recipe, &texts).await
}
