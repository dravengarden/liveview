import { useCallback, useEffect, useRef } from "react";
import type { FileType, TreeNode, WsMessage } from "@/types";
import { connectionLost, connectionReady } from "@/connectionStore";
import { emitServerSettingPush } from "@/syncBackends";

interface UseWebSocketOptions {
  onContentUpdate: (
    path: string,
    lang: string,
    fileType: FileType,
    content: string,
  ) => void;
  onTreeUpdate: (tree: TreeNode[]) => void;
}

export function useWebSocket(
  { onContentUpdate, onTreeUpdate }: UseWebSocketOptions,
): void {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const connect = useCallback(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      // Resets the reconnect counter, flashes the green banner if an outage was
      // surfaced, and probes /version for a redeploy (see connectionStore).
      connectionReady();
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(event.data) as WsMessage;
        if (msg.type === "ContentUpdate") {
          onContentUpdate(msg.path, msg.lang, msg.file_type, msg.content);
        } else if (msg.type === "TreeUpdate") {
          onTreeUpdate(msg.tree);
        } else if (msg.type === "SettingUpdate") {
          // Live cross-device settings push: feed the value to any mirrored
          // store subscribed on this key (it re-reconciles). The client also
          // sees the echo of its OWN PUT here — that's a no-op (remote == local).
          emitServerSettingPush(msg.key, msg.value);
        }
      } catch (e) {
        console.error("Failed to parse WebSocket message:", e);
      }
    };

    ws.onclose = () => {
      // Raises the red banner past the failure threshold and hands back the
      // exponential-backoff delay to wait before retrying.
      reconnectTimeoutRef.current = setTimeout(connect, connectionLost());
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      ws.close();
    };

    wsRef.current = ws;
  }, [onContentUpdate, onTreeUpdate]);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current !== null) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      wsRef.current?.close();
    };
  }, [connect]);
}
