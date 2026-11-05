use super::*;

pub(crate) async fn api_library_get(State(state): State<SharedState>) -> axum::response::Response {
    match state.store.library_get().await {
        Ok(library) => Json(library).into_response(),
        Err(error) => store_unavailable("library_get", error),
    }
}
pub(crate) async fn api_library_change(
    State(state): State<SharedState>,
    Json(change): Json<library::Change>,
) -> axum::response::Response {
    match state.store.library_change(&change).await {
        Ok(library) => {
            // Every organization write (UI or `liveview dir`) goes through here,
            // so this push lets connected clients refetch instead of polling.
            if let Ok(s) = serde_json::to_string(&WsMessage::LibraryUpdate {
                revision: library.revision,
            }) {
                let _ = state.tx.send(s);
            }
            Json(library).into_response()
        }
        Err(error) => (
            if error.starts_with("Revision conflict") {
                StatusCode::CONFLICT
            } else {
                StatusCode::BAD_REQUEST
            },
            error,
        )
            .into_response(),
    }
}
