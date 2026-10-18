//! Durable voice variants. Claims have renewable leases and compare-and-swap
//! publication, so crashes and source/config edits cannot publish stale audio.
use serde::Serialize;
use sqlx::FromRow;

use super::{model::ChapterRecord, pg::PgStore};
use crate::speech::{Recipe, SpeechConfig};

#[derive(Clone, Debug, FromRow, Serialize)]
pub struct SpeechAsset {
    pub book_slug: String,
    pub rendition: String,
    pub lang: String,
    pub rel_path: String,
    pub profile: String,
    pub recipe: String,
    pub content_hash: String,
    pub status: String,
    pub attempts: i32,
    pub audio_hash: Option<String>,
    pub marks_hash: Option<String>,
    pub audio_size: Option<i64>,
    pub marks_size: Option<i64>,
}

#[derive(FromRow)]
pub struct SpeechSource {
    pub rendition: String,
    pub lang: String,
    pub rel_path: String,
    pub audio_voice: Option<String>,
    pub audio_hash: Option<String>,
    pub marks_hash: Option<String>,
    pub audio_size: Option<i64>,
}

impl PgStore {
    pub async fn speech_config(&self, book: &str, rendition: &str) -> Result<SpeechConfig, String> {
        let value: Option<String> = sqlx::query_scalar(
            "SELECT config FROM speech_configs WHERE book_slug=$1 AND rendition=$2",
        )
        .bind(book)
        .bind(rendition)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        value
            .map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
            .transpose()
            .map(Option::unwrap_or_default)
    }

    pub async fn set_speech_config(
        &self,
        book: &str,
        rendition: &str,
        config: &SpeechConfig,
    ) -> Result<(), String> {
        config.validate()?;
        let config = serde_json::to_string(config).map_err(|e| e.to_string())?;
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let old: Option<String> = sqlx::query_scalar(
            "SELECT config FROM speech_configs WHERE book_slug=$1 AND rendition=$2 FOR UPDATE",
        )
        .bind(book)
        .bind(rendition)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        if old.as_deref() != Some(&config) {
            sqlx::query("INSERT INTO speech_configs VALUES($1,$2,$3) ON CONFLICT(book_slug,rendition) DO UPDATE SET config=EXCLUDED.config")
                .bind(book).bind(rendition).bind(&config).execute(&mut *tx).await.map_err(|e| e.to_string())?;
            // A removed voice or edited pronunciation must not survive in the
            // advertised DAG, even when the old worker is still synthesizing.
            sqlx::query("DELETE FROM speech_audio WHERE book_slug=$1 AND rendition=$2")
                .bind(book)
                .bind(rendition)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("UPDATE deploy_root SET content_epoch=content_epoch+1 WHERE id=1")
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        }
        tx.commit().await.map_err(|e| e.to_string())
    }

    pub async fn speech_sources(&self, book: &str) -> Result<Vec<SpeechSource>, String> {
        sqlx::query_as("SELECT c.rendition,c.lang,c.rel_path,c.audio_voice,c.audio_hash,c.marks_hash,a.size AS audio_size FROM chapters c LEFT JOIN assets a ON a.content_hash=c.audio_hash WHERE c.book_slug=$1 AND c.file_type='markdown'")
            .bind(book).fetch_all(&self.pool).await.map_err(|e| e.to_string())
    }

    pub async fn speech_assets(&self, book: Option<&str>) -> Result<Vec<SpeechAsset>, String> {
        sqlx::query_as("SELECT s.*,a.size AS audio_size,m.size AS marks_size FROM speech_audio s JOIN chapters c USING(book_slug,rendition,lang,rel_path) LEFT JOIN assets a ON a.content_hash=s.audio_hash LEFT JOIN assets m ON m.content_hash=s.marks_hash WHERE c.content_hash=s.content_hash AND ($1::text IS NULL OR s.book_slug=$1)")
            .bind(book).fetch_all(&self.pool).await.map_err(|e| e.to_string())
    }

    pub async fn queue_speech(&self, row: &ChapterRecord, recipe: &Recipe) -> Result<(), String> {
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        // Serializes against policy changes; do not let an HTTP request that
        // read the previous config resurrect a removed recipe after pruning.
        let config: Option<String> = sqlx::query_scalar(
            "SELECT config FROM speech_configs WHERE book_slug=$1 AND rendition=$2 FOR SHARE",
        )
        .bind(&row.book_slug)
        .bind(&row.rendition)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        let config: SpeechConfig =
            serde_json::from_str(config.as_deref().unwrap_or("{}")).map_err(|e| e.to_string())?;
        if !config.voices.contains(&recipe.voice) || config.recipe(&recipe.voice) != *recipe {
            return Err("Voice policy changed; reload this book".into());
        }
        // Reuse an in-flight default instead of generating the same recipe twice.
        let promoted = sqlx::query("UPDATE audio_tasks SET priority=100 WHERE book_slug=$1 AND rendition=$2 AND lang=$3 AND rel_path=$4 AND content_hash=$5 AND voice=$6 AND status IN ('queued','running')")
            .bind(&row.book_slug).bind(&row.rendition).bind(&row.lang).bind(&row.rel_path)
            .bind(&row.content_hash).bind(recipe.encode()).execute(&mut *tx).await.map_err(|e| e.to_string())?.rows_affected()>0;
        if promoted {
            return tx.commit().await.map_err(|e| e.to_string());
        }
        sqlx::query("INSERT INTO speech_audio(book_slug,rendition,lang,rel_path,profile,recipe,content_hash) SELECT book_slug,rendition,lang,rel_path,$5,$6,content_hash FROM chapters WHERE book_slug=$1 AND rendition=$2 AND lang=$3 AND rel_path=$4 AND content_hash=$7 ON CONFLICT(book_slug,rendition,lang,rel_path,profile) DO UPDATE SET content_hash=EXCLUDED.content_hash,status='queued',attempts=speech_audio.attempts+1,lease_until=NULL,error=NULL,audio_hash=NULL,marks_hash=NULL WHERE speech_audio.content_hash<>EXCLUDED.content_hash OR speech_audio.status='failed'")
            .bind(&row.book_slug).bind(&row.rendition).bind(&row.lang).bind(&row.rel_path)
            .bind(recipe.id()).bind(recipe.encode()).bind(&row.content_hash)
            .execute(&mut *tx).await.map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())
    }

    pub async fn claim_speech(&self) -> Result<Option<SpeechAsset>, String> {
        sqlx::query_as("WITH next AS (SELECT s.ctid FROM speech_audio s JOIN chapters c USING(book_slug,rendition,lang,rel_path) WHERE s.content_hash=c.content_hash AND (s.status='queued' OR (s.status='running' AND s.lease_until<now())) ORDER BY s.attempts,s.book_slug,s.rel_path FOR UPDATE OF s SKIP LOCKED LIMIT 1) UPDATE speech_audio s SET status='running',attempts=s.attempts+1,lease_until=now()+interval '2 minutes' FROM next WHERE s.ctid=next.ctid RETURNING s.*,NULL::bigint AS audio_size,NULL::bigint AS marks_size")
            .fetch_optional(&self.pool).await.map_err(|e| e.to_string())
    }

    pub async fn renew_speech(&self, job: &SpeechAsset) -> Result<(), String> {
        sqlx::query("UPDATE speech_audio SET lease_until=now()+interval '2 minutes' WHERE book_slug=$1 AND rendition=$2 AND lang=$3 AND rel_path=$4 AND profile=$5 AND content_hash=$6 AND attempts=$7 AND status='running'")
            .bind(&job.book_slug).bind(&job.rendition).bind(&job.lang).bind(&job.rel_path).bind(&job.profile).bind(&job.content_hash).bind(job.attempts)
            .execute(&self.pool).await.map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn finish_speech(
        &self,
        job: &SpeechAsset,
        result: Result<(String, String), String>,
    ) -> Result<bool, String> {
        let (audio, marks, error) = match result {
            Ok((a, m)) => (Some(a), Some(m), None),
            Err(e) => (None, None, Some(e)),
        };
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let config: Option<String> = sqlx::query_scalar(
            "SELECT config FROM speech_configs WHERE book_slug=$1 AND rendition=$2 FOR SHARE",
        )
        .bind(&job.book_slug)
        .bind(&job.rendition)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        let config: SpeechConfig =
            serde_json::from_str(config.as_deref().unwrap_or("{}")).map_err(|e| e.to_string())?;
        let publish_default =
            error.is_none() && config.resolve(&job.lang, &job.rel_path, None) == job.recipe;
        // Match sync's chapter → variant lock order and recheck the source
        // after waiting. A source edit atomically prunes its old variants.
        let source: Option<String> = sqlx::query_scalar("SELECT content_hash FROM chapters WHERE book_slug=$1 AND rendition=$2 AND lang=$3 AND rel_path=$4 FOR UPDATE")
            .bind(&job.book_slug).bind(&job.rendition).bind(&job.lang).bind(&job.rel_path)
            .fetch_optional(&mut *tx).await.map_err(|e|e.to_string())?;
        if source.as_deref() != Some(&job.content_hash) {
            return Ok(false);
        }
        let applied=sqlx::query("UPDATE speech_audio s SET audio_hash=$8,marks_hash=$9,error=$10,status=CASE WHEN $10::text IS NULL THEN 'ready' ELSE 'failed' END,lease_until=NULL FROM chapters c WHERE s.book_slug=$1 AND s.rendition=$2 AND s.lang=$3 AND s.rel_path=$4 AND s.profile=$5 AND s.content_hash=$6 AND s.attempts=$7 AND s.status='running' AND c.book_slug=s.book_slug AND c.rendition=s.rendition AND c.lang=s.lang AND c.rel_path=s.rel_path AND c.content_hash=s.content_hash")
            .bind(&job.book_slug).bind(&job.rendition).bind(&job.lang).bind(&job.rel_path).bind(&job.profile).bind(&job.content_hash).bind(job.attempts)
            .bind(audio).bind(marks).bind(error).execute(&mut *tx).await.map_err(|e| e.to_string())?.rows_affected()>0;
        if applied {
            if publish_default {
                // Keep the canonical representation usable by installed older
                // readers. Personal alternative choices never enter this path.
                sqlx::query("UPDATE chapters c SET audio_hash=s.audio_hash,marks_hash=s.marks_hash,audio_voice=s.recipe FROM speech_audio s WHERE s.book_slug=$1 AND s.rendition=$2 AND s.lang=$3 AND s.rel_path=$4 AND s.profile=$5 AND c.book_slug=s.book_slug AND c.rendition=s.rendition AND c.lang=s.lang AND c.rel_path=s.rel_path AND c.content_hash=s.content_hash")
                    .bind(&job.book_slug).bind(&job.rendition).bind(&job.lang).bind(&job.rel_path).bind(&job.profile)
                    .execute(&mut *tx).await.map_err(|e|e.to_string())?;
                // Invalidate any older default task's publication token.
                sqlx::query("UPDATE audio_tasks SET voice=$6,status='done',error=NULL WHERE book_slug=$1 AND rendition=$2 AND lang=$3 AND rel_path=$4 AND content_hash=$5")
                    .bind(&job.book_slug).bind(&job.rendition).bind(&job.lang).bind(&job.rel_path).bind(&job.content_hash).bind(&job.recipe)
                    .execute(&mut *tx).await.map_err(|e|e.to_string())?;
            }
            sqlx::query("UPDATE deploy_root SET content_epoch=content_epoch+1 WHERE id=1")
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        }
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(applied)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::model::BookUpsert;

    #[tokio::test]
    async fn variants_survive_gc_and_reject_stale_workers_and_removed_policy() {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            return;
        };
        let pg = PgStore::open(&url).await.unwrap();
        pg.migrate().await.unwrap();
        let slug = "speech-variants-test";
        pg.delete_book(slug).await.unwrap();
        pg.upsert_book(&BookUpsert {
            slug,
            label: "Speech test",
            description: None,
            tags: &[],
            collection: None,
            author: None,
            cover_hash: None,
            backdrop_hash: None,
            card_backdrop_hash: None,
            default_rendition: "text",
        })
        .await
        .unwrap();
        pg.upsert_rendition(slug, "text", "Read", "en", None, true, 0)
            .await
            .unwrap();
        pg.upsert_edition(slug, "text", "en", "English", 0)
            .await
            .unwrap();
        let mut row = ChapterRecord {
            book_slug: slug.into(),
            rendition: "text".into(),
            lang: "en".into(),
            rel_path: "22.md".into(),
            file_type: "markdown".into(),
            html: Some("<p>Hello</p>".into()),
            markdown: Some("Hello".into()),
            asset_hash: None,
            audio_hash: None,
            marks_hash: None,
            content_hash: "source-one".into(),
            render_version: 1,
            audio_voice: None,
        };
        pg.upsert_chapter(&row).await.unwrap();
        let mut config = SpeechConfig {
            voices: vec!["kokoro:af_heart".into(), "kokoro:af_bella".into()],
            ..Default::default()
        };
        pg.set_speech_config(slug, "text", &config).await.unwrap();
        let recipe = config.recipe("kokoro:af_bella");
        pg.queue_speech(&row, &recipe).await.unwrap();
        pg.queue_speech(&row, &recipe).await.unwrap();
        let first = pg.claim_speech().await.unwrap().unwrap();
        assert!(pg.claim_speech().await.unwrap().is_none());
        pg.renew_speech(&first).await.unwrap();
        sqlx::query(
            "UPDATE speech_audio SET lease_until=now()-interval '1 second' WHERE book_slug=$1",
        )
        .bind(slug)
        .execute(&pg.pool)
        .await
        .unwrap();
        let second = pg.claim_speech().await.unwrap().unwrap();
        assert!(second.attempts > first.attempts);
        assert!(
            !pg.finish_speech(&first, Ok(("wrong".into(), "wrong-marks".into())))
                .await
                .unwrap()
        );
        pg.upsert_asset("speech-audio", "audio/x-caf", 100)
            .await
            .unwrap();
        pg.upsert_asset("speech-marks", "application/json", 50)
            .await
            .unwrap();
        assert!(
            pg.finish_speech(&second, Ok(("speech-audio".into(), "speech-marks".into())))
                .await
                .unwrap()
        );
        assert!(
            pg.get_chapter(slug, "text", "en", "22.md")
                .await
                .unwrap()
                .unwrap()
                .audio_hash
                .is_none()
        );
        assert!(
            !pg.orphan_asset_hashes(i64::MAX)
                .await
                .unwrap()
                .iter()
                .any(|h| h == "speech-audio" || h == "speech-marks")
        );
        pg.queue_speech(&row, &recipe).await.unwrap();
        assert!(pg.claim_speech().await.unwrap().is_none());
        row.content_hash = "source-two".into();
        pg.upsert_chapter(&row).await.unwrap();
        assert!(pg.speech_assets(Some(slug)).await.unwrap().is_empty());
        pg.queue_speech(&row, &recipe).await.unwrap();
        let stale = pg.claim_speech().await.unwrap().unwrap();
        config.voices.retain(|v| v != "kokoro:af_bella");
        pg.set_speech_config(slug, "text", &config).await.unwrap();
        assert!(pg.queue_speech(&row, &recipe).await.is_err());
        assert!(
            !pg.finish_speech(&stale, Ok(("speech-audio".into(), "speech-marks".into())))
                .await
                .unwrap()
        );
        assert!(pg.speech_assets(Some(slug)).await.unwrap().is_empty());
        assert!(
            pg.orphan_asset_hashes(i64::MAX)
                .await
                .unwrap()
                .contains(&"speech-audio".into())
        );
        let heart = config.recipe("kokoro:af_heart");
        pg.queue_speech(&row, &heart).await.unwrap();
        let default_job = pg.claim_speech().await.unwrap().unwrap();
        assert!(
            pg.finish_speech(
                &default_job,
                Ok(("speech-audio".into(), "speech-marks".into()))
            )
            .await
            .unwrap()
        );
        let canonical = pg
            .get_chapter(slug, "text", "en", "22.md")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            canonical.audio_voice.as_deref(),
            Some(heart.encode().as_str())
        );
        assert_eq!(canonical.audio_hash.as_deref(), Some("speech-audio"));
        pg.delete_book(slug).await.unwrap();
    }
}
