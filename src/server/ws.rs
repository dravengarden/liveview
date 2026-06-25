use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};

use crate::server::state::SharedState;

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

async fn handle_ws(socket: WebSocket, state: SharedState) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.tx.subscribe();

    let send_task = tokio::spawn(async move {
        // Server PUSH of the current app-bundle version, right on connect. A deploy
        // = server restart = every client reconnects = a fresh push, so the native
        // shell picks up a new web bundle instantly (it runs the OTA check on
        // receipt). `None` in dev builds (no embedded bundle) → nothing to push.
        if let Some(version) = crate::app_version() {
            if let Ok(json) =
                serde_json::to_string(&crate::shared::WsMessage::AppVersion { version })
            {
                if sender.send(Message::Text(json.into())).await.is_err() {
                    return;
                }
            }
        }
        while let Ok(msg) = rx.recv().await {
            if sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    let recv_task = tokio::spawn(async move {
        while let Some(Ok(_msg)) = receiver.next().await {
            // Client messages handled here if needed
        }
    });

    tokio::select! {
        _ = send_task => {},
        _ = recv_task => {},
    }
}
