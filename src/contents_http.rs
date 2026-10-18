//! Book contents are one snapshot: titles, voice choices and real durations.
use super::*;
use futures_util::{StreamExt, stream};

pub(crate) async fn api_contents(
    State(state): State<SharedState>,
    axum::extract::Path(slug): axum::extract::Path<String>,
    Query(q): Query<TreeQuery>,
) -> Response {
    match contents(&state, &slug, q.rendition.as_deref().unwrap_or("text")).await {
        Ok(tree) => Json(tree).into_response(),
        Err(error) => store_unavailable("book contents", error),
    }
}

async fn contents(
    state: &AppState,
    slug: &str,
    rendition: &str,
) -> Result<serde_json::Value, String> {
    let json = state
        .store
        .get_site_tree(rendition)
        .await?
        .unwrap_or_else(|| "[]".into());
    let mut tree: Vec<serde_json::Value> =
        serde_json::from_str(&json).map_err(|e| e.to_string())?;
    tree.retain(|node| node["path"].as_str() == Some(slug));
    if tree.is_empty() {
        return Ok(serde_json::json!([]));
    }
    let catalog = speech_http::speech_book(state, slug).await?;
    let mut chapters: Vec<_> = catalog["chapters"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| {
            c["id"]
                .as_str()
                .is_some_and(|id| id.starts_with(&format!("{rendition}/")))
        })
        .cloned()
        .collect();
    let hashes: std::collections::BTreeSet<String> = chapters
        .iter()
        .flat_map(|c| c["voices"].as_array().into_iter().flatten())
        .filter(|v| v["status"] == "ready")
        .filter_map(|v| v["marks_hash"].as_str().map(str::to_owned))
        .collect();
    // Only this book, at most four object reads in flight. Successful timings
    // are immutable by hash and shared by requests, never re-read by the UI.
    let durations: HashMap<_, _> = stream::iter(hashes)
        .map(|hash| async move {
            let cached = state.contents_durations.lock().await.get(&hash).copied();
            let seconds = if let Some(seconds) = cached {
                Some(seconds)
            } else {
                let bytes =
                    tokio::time::timeout(std::time::Duration::from_secs(2), state.obj.get(&hash))
                        .await
                        .ok()
                        .and_then(Result::ok);
                let seconds = bytes.as_deref().and_then(mark_duration);
                if let Some(seconds) = seconds {
                    let mut cache = state.contents_durations.lock().await;
                    if cache.len() >= 4096 {
                        cache.clear();
                    }
                    cache.insert(hash.clone(), seconds);
                }
                seconds
            };
            (hash, seconds)
        })
        .buffer_unordered(4)
        .collect()
        .await;
    for chapter in &mut chapters {
        if let Some(voices) = chapter["voices"].as_array_mut() {
            for voice in voices {
                if let Some(Some(seconds)) =
                    voice["marks_hash"].as_str().and_then(|h| durations.get(h))
                {
                    voice["seconds"] = serde_json::json!(seconds);
                }
            }
        }
    }
    let mut by_path: HashMap<String, serde_json::Map<String, serde_json::Value>> = HashMap::new();
    for chapter in chapters {
        let Some(id) = chapter["id"].as_str() else {
            continue;
        };
        let mut parts = id.splitn(3, '/');
        let (_, Some(lang), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        by_path
            .entry(format!("{slug}/{path}"))
            .or_default()
            .insert(lang.to_owned(), chapter);
    }
    attach(&mut tree, &by_path);
    Ok(serde_json::json!(tree))
}

fn attach(
    nodes: &mut [serde_json::Value],
    chapters: &HashMap<String, serde_json::Map<String, serde_json::Value>>,
) {
    for node in nodes {
        if let Some(audio) = node["path"].as_str().and_then(|p| chapters.get(p)) {
            node["audio"] = serde_json::Value::Object(audio.clone());
        }
        if let Some(children) = node["children"].as_array_mut() {
            attach(children, chapters);
        }
    }
}

fn mark_duration(bytes: &[u8]) -> Option<f64> {
    let marks: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let end = marks.as_array()?.last()?["end_ms"].as_f64()?;
    (end.is_finite() && end > 0.0).then_some(end / 1000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_duration_and_invalid_marks() {
        assert_eq!(
            mark_duration(br#"[{"end_ms":1200},{"end_ms":92345}]"#),
            Some(92.345)
        );
        for bytes in [
            b"[]".as_slice(),
            b"null",
            br#"[{"end_ms":-1}]"#,
            br#"[{"end_ms":"10"}]"#,
        ] {
            assert_eq!(mark_duration(bytes), None);
        }
    }

    #[test]
    fn nested_titles_and_language_choices_travel_together() {
        let mut tree = vec![
            serde_json::json!({"path":"book","children":[{"path":"book/one.md","name":"One","titles":{"fr":"Un"}}]}),
        ];
        let audio = serde_json::json!({"fr":{"default_voice":"voice","voices":[{"id":"voice","seconds":92.345}]}});
        attach(
            &mut tree,
            &HashMap::from([("book/one.md".into(), audio.as_object().unwrap().clone())]),
        );
        assert_eq!(tree[0]["children"][0]["titles"]["fr"], "Un");
        assert_eq!(tree[0]["children"][0]["audio"], audio);
        assert!(tree[0].get("audio").is_none());
    }
}
