use axum::{
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::broadcast::error::RecvError;

use crate::server::state::SharedState;
use crate::shared::{TreeNode, WsMessage};

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

/// What the send loop does with one broadcast receive result.
#[derive(Debug, PartialEq, Eq)]
enum Forward {
    /// Forward this message to the client.
    Send(String),
    /// The subscriber fell behind and missed messages: keep going, after
    /// re-sending the current state that can be recomputed.
    Resync,
    /// The broadcast channel is gone: end the connection.
    Stop,
}

fn classify(received: Result<String, RecvError>) -> Forward {
    match received {
        Ok(msg) => Forward::Send(msg),
        Err(RecvError::Lagged(_)) => Forward::Resync,
        Err(RecvError::Closed) => Forward::Stop,
    }
}

/// The current text sidebar tree as a `TreeUpdate` frame, if available.
async fn current_tree_message(state: &SharedState) -> Option<String> {
    let json = state.store.get_site_tree("text").await.ok().flatten()?;
    let tree = serde_json::from_str::<Vec<TreeNode>>(&json).ok()?;
    serde_json::to_string(&WsMessage::TreeUpdate { tree }).ok()
}

async fn handle_ws(socket: WebSocket, state: SharedState) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.tx.subscribe();

    let mut send_task = tokio::spawn(async move {
        // Server PUSH of the current app-bundle version, right on connect. A deploy
        // = server restart = every client reconnects = a fresh push, so the native
        // shell picks up a new web bundle instantly (it runs the OTA check on
        // receipt). `None` in dev builds (no embedded bundle) → nothing to push.
        if let Some(version) = crate::app_version()
            && let Ok(json) = serde_json::to_string(&WsMessage::AppVersion { version })
            && sender.send(Message::Text(json.into())).await.is_err()
        {
            return;
        }
        loop {
            let msg = match classify(rx.recv().await) {
                Forward::Send(msg) => msg,
                // A slow client that lagged must not become a zombie socket that
                // silently receives nothing: skip the dropped backlog and push
                // the current tree so the sidebar converges again.
                Forward::Resync => {
                    tracing::debug!("websocket subscriber lagged; resyncing tree");
                    match current_tree_message(&state).await {
                        Some(msg) => msg,
                        None => continue,
                    }
                }
                Forward::Stop => break,
            };
            if sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    let mut recv_task = tokio::spawn(async move {
        loop {
            let next = receiver.next().await;
            let Some(Ok(_msg)) = next else {
                break;
            };
            // Client messages handled here if needed
        }
    });

    // Whichever half finishes first ends the connection; abort the other so a
    // closed client never leaves a subscribed sender (or vice versa) behind.
    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::broadcast;

    #[tokio::test]
    async fn lagged_receiver_resyncs_and_keeps_receiving() {
        let (tx, mut rx) = broadcast::channel::<String>(2);
        for i in 0..5 {
            tx.send(format!("m{i}")).unwrap();
        }
        assert_eq!(classify(rx.recv().await), Forward::Resync);
        // After a lag the receiver continues with the retained tail.
        assert_eq!(classify(rx.recv().await), Forward::Send("m3".into()));
        assert_eq!(classify(rx.recv().await), Forward::Send("m4".into()));
        tx.send("m5".into()).unwrap();
        assert_eq!(classify(rx.recv().await), Forward::Send("m5".into()));
    }

    #[tokio::test]
    async fn closed_channel_stops() {
        let (tx, mut rx) = broadcast::channel::<String>(2);
        drop(tx);
        assert_eq!(classify(rx.recv().await), Forward::Stop);
    }
}
