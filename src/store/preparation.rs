//! Bounded, restartable reconciliation of automatic audio preparation.
use super::{
    model::ChapterRecord,
    pg::PgStore,
    speech::{read_legacy_voice, read_policy},
};
use crate::speech::Generation;

impl PgStore {
    pub async fn prepare_speech_page(
        &self,
        cursor: &mut (String, String, String, String),
    ) -> Result<bool, String> {
        let rows: Vec<ChapterRecord> = sqlx::query_as("SELECT * FROM chapters WHERE file_type='markdown' AND (book_slug,rendition,lang,rel_path)>($1,$2,$3,$4) ORDER BY book_slug,rendition,lang,rel_path LIMIT 32")
            .bind(&cursor.0).bind(&cursor.1).bind(&cursor.2).bind(&cursor.3).fetch_all(&self.pool).await.map_err(|e|e.to_string())?;
        if rows.is_empty() {
            *cursor = Default::default();
            return Ok(true);
        }
        for row in rows {
            *cursor = (
                row.book_slug.clone(),
                row.rendition.clone(),
                row.lang.clone(),
                row.rel_path.clone(),
            );
            // Serialize target discovery with configuration writes. The queue
            // insertion independently rechecks policy and the source hash.
            let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
            sqlx::query("SELECT id FROM speech_defaults WHERE id=true FOR SHARE")
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            let options = read_policy(&mut tx, &row.book_slug, &row.rendition)
                .await?
                .effective(&row.lang, &row.rel_path)
                .options;
            if options.generation != Some(Generation::All) {
                sqlx::query("DELETE FROM speech_preparation WHERE book_slug=$1 AND rendition=$2 AND lang=$3 AND rel_path=$4").bind(&row.book_slug).bind(&row.rendition).bind(&row.lang).bind(&row.rel_path).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                sqlx::query("DELETE FROM speech_audio WHERE book_slug=$1 AND rendition=$2 AND lang=$3 AND rel_path=$4 AND priority<100 AND status='queued'").bind(&row.book_slug).bind(&row.rendition).bind(&row.lang).bind(&row.rel_path).execute(&mut *tx).await.map_err(|e|e.to_string())?;
                tx.commit().await.map_err(|e| e.to_string())?;
                continue;
            }
            let legacy = read_legacy_voice(&mut tx, &row.book_slug, &row.rendition).await?;
            let recipe = options.recipe(&options.default_for(&row.lang, legacy.as_deref()));
            let ready = row.audio_hash.is_some()
                && row.marks_hash.is_some()
                && (row.audio_voice.as_deref()
                    == Some(&options.resolve(&row.lang, legacy.as_deref()))
                    || (row.audio_voice.is_none() && !options.has_audio_options()));
            sqlx::query("INSERT INTO speech_preparation(book_slug,rendition,lang,rel_path,content_hash,profile,ready) SELECT book_slug,rendition,lang,rel_path,content_hash,$6,$7 FROM chapters WHERE book_slug=$1 AND rendition=$2 AND lang=$3 AND rel_path=$4 AND content_hash=$5 ON CONFLICT(book_slug,rendition,lang,rel_path) DO UPDATE SET content_hash=EXCLUDED.content_hash,profile=EXCLUDED.profile,ready=EXCLUDED.ready")
                .bind(&row.book_slug).bind(&row.rendition).bind(&row.lang).bind(&row.rel_path).bind(&row.content_hash).bind(recipe.id()).bind(ready).execute(&mut *tx).await.map_err(|e|e.to_string())?;
            if !ready && !options.has_audio_options() {
                let voice = options.resolve(&row.lang, legacy.as_deref());
                let kind = if row.rendition == "audio" {
                    format!(
                        "audio:{}:{voice}:{}",
                        row.render_version,
                        crate::AUDIO_ENCODING_VERSION
                    )
                } else {
                    format!(
                        "text:{}:tts:{voice}:{}",
                        row.render_version,
                        crate::AUDIO_ENCODING_VERSION
                    )
                };
                // Preserve terminal failures and in-flight sync jobs. Only a
                // changed source/recipe starts new work, using legacy encoding.
                sqlx::query("INSERT INTO audio_tasks(book_slug,rendition,lang,rel_path,content_hash,leaf_kind,voice,enqueued_at,automatic) SELECT book_slug,rendition,lang,rel_path,content_hash,$6,$7,$8,true FROM chapters WHERE book_slug=$1 AND rendition=$2 AND lang=$3 AND rel_path=$4 AND content_hash=$5 ON CONFLICT(book_slug,rendition,lang,rel_path) DO UPDATE SET content_hash=EXCLUDED.content_hash,leaf_kind=EXCLUDED.leaf_kind,voice=EXCLUDED.voice,status='queued',attempts=0,error=NULL,automatic=true WHERE audio_tasks.content_hash<>EXCLUDED.content_hash OR audio_tasks.voice<>EXCLUDED.voice")
                    .bind(&row.book_slug).bind(&row.rendition).bind(&row.lang).bind(&row.rel_path).bind(&row.content_hash).bind(kind).bind(voice).bind(super::pg::now_millis()).execute(&mut *tx).await.map_err(|e|e.to_string())?;
            }
            tx.commit().await.map_err(|e| e.to_string())?;
            if !ready && options.has_audio_options() {
                self.queue_speech_priority(&row, &recipe, 0).await?;
            }
        }
        Ok(false)
    }

    pub async fn preparation_status(
        &self,
        paused: Option<bool>,
    ) -> Result<serde_json::Value, String> {
        if let Some(paused) = paused {
            sqlx::query("UPDATE speech_preparation_control SET paused=$1 WHERE id=true")
                .bind(paused)
                .execute(&self.pool)
                .await
                .map_err(|e| e.to_string())?;
        }
        let paused: bool =
            sqlx::query_scalar("SELECT paused FROM speech_preparation_control WHERE id=true")
                .fetch_one(&self.pool)
                .await
                .map_err(|e| e.to_string())?;
        let (total,ready,running,failed):(i64,i64,i64,i64)=sqlx::query_as("SELECT count(*),count(*) FILTER(WHERE p.ready OR s.status='ready'),count(*) FILTER(WHERE NOT p.ready AND (s.status='running' OR (s.status IS NULL AND t.status='running'))),count(*) FILTER(WHERE NOT p.ready AND (s.status='failed' OR (s.status IS NULL AND t.status='failed'))) FROM speech_preparation p JOIN chapters c USING(book_slug,rendition,lang,rel_path) LEFT JOIN speech_audio s ON s.book_slug=p.book_slug AND s.rendition=p.rendition AND s.lang=p.lang AND s.rel_path=p.rel_path AND s.profile=p.profile AND s.content_hash=p.content_hash LEFT JOIN audio_tasks t ON t.book_slug=p.book_slug AND t.rendition=p.rendition AND t.lang=p.lang AND t.rel_path=p.rel_path AND t.content_hash=p.content_hash WHERE p.content_hash=c.content_hash")
            .fetch_one(&self.pool).await.map_err(|e|e.to_string())?;
        Ok(
            serde_json::json!({"paused":paused,"total":total,"ready":ready,"running":running,"failed":failed,"waiting":(total-ready-running-failed).max(0)}),
        )
    }
}
