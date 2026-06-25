import { useCallback, useEffect, useRef } from "react";
import type { FileType, TreeNode, WsMessage } from "@/types";
import { BUNDLED, REMOTE } from "@/apiBase";
import { connectionLost, connectionReady } from "@/connectionStore";
import { emitServerSettingPush } from "@/syncBackends";
import { dispatchChapterReady } from "@/syncStore";
import { runOtaCheck } from "@/otaUpdater";

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
    // BUNDLED (native app, local origin): window.location.host is the LOCAL
    // origin (tauri://localhost), which has no /ws server — point at the REMOTE
    // server instead (https→wss). Offline it simply won't connect (live updates
    // degrade; the reconnect banner handles it). PWA/remote: same-origin /ws.
    const url = BUNDLED
      ? `${REMOTE.replace(/^http/, "ws")}/ws`
      : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;
    const ws = new WebSocket(url);

    ws.onopen = () => {
      // Resets the reconnect counter, flashes the green banner if an outage was
      // surfaced, and probes /version for a redeploy (see connectionStore).
      connectionReady();
      // App-bundle OTA is now SERVER-PUSHED: the server sends an `AppVersion`
      // message right after this connect (see below), so there's nothing to poll
      // here — a deploy = server restart = reconnect = fresh AppVersion push.
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      try {
        // The audio worker pushes a lower-cased `chapter-ready` (not part of the
        // WsMessage union) when a chapter's audio finishes baking.
        const raw = JSON.parse(event.data) as { type?: string } & Record<
          string,
          string
        >;
        if (raw.type === "chapter-ready") {
          dispatchChapterReady({
            book: raw["book"] ?? "",
            rendition: raw["rendition"] ?? "",
            lang: raw["lang"] ?? "",
            path: raw["path"] ?? "",
          });
          return;
        }
        const msg = raw as unknown as WsMessage;
        if (msg.type === "AppVersion") {
          // SERVER PUSH: the server announces its current app-bundle version on
          // connect (and a deploy = restart = reconnect = a fresh push). Ask the
          // native plugin to probe + incrementally pull + flip to it, then reload
          // silently. Off the native shell runOtaCheck is a no-op.
          void runOtaCheck();
        } else if (msg.type === "ContentUpdate") {
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
