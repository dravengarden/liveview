import { useEffect, useRef } from "react";
import type { FileType, TreeNode, WsMessage } from "@/types";
import { BUNDLED, REMOTE } from "@/apiBase";
import { connectionLost, connectionReady } from "@/connectionStore";
import { emitServerSettingPush } from "@/syncBackends";
import { dispatchChapterReady } from "@/syncStore";
import { runOtaCheck } from "@/otaUpdater";
import { webSocketUrl } from "@/webSocketUrl";

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
  // Message consumers can change as App state changes. Keep their latest
  // implementations in refs so those renders never tear down the transport.
  // A LiveView page owns exactly one socket for its entire mounted lifetime.
  const onContentUpdateRef = useRef(onContentUpdate);
  const onTreeUpdateRef = useRef(onTreeUpdate);
  onContentUpdateRef.current = onContentUpdate;
  onTreeUpdateRef.current = onTreeUpdate;

  useEffect(() => {
    let stopped = false;
    let activeSocket: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

    const connect = (): void => {
      if (stopped) return;

      // The native shell runs from lvsync://localhost, so its WebSocket must use
      // the backend selected by selectRemote(). Browser/PWA stays same-origin.
      const url = webSocketUrl(BUNDLED, REMOTE, window.location);
      const ws = new WebSocket(url);
      activeSocket = ws;

      ws.onopen = () => {
        if (stopped || activeSocket !== ws) return;
        // Resets the reconnect counter, flashes the green banner if an outage was
        // surfaced, and probes /version for a redeploy (see connectionStore).
        connectionReady();
        // App-bundle OTA is now SERVER-PUSHED: the server sends an `AppVersion`
        // message right after this connect (see below), so there's nothing to poll
        // here — a deploy = server restart = reconnect = fresh AppVersion push.
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        if (stopped || activeSocket !== ws) return;
        try {
          // The audio worker pushes a lower-cased `chapter-ready` (not part of the
          // WsMessage union) when a chapter's audio finishes baking.
          const raw = JSON.parse(event.data) as
            & { type?: string }
            & Record<
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
            onContentUpdateRef.current(
              msg.path,
              msg.lang,
              msg.file_type,
              msg.content,
            );
          } else if (msg.type === "TreeUpdate") {
            onTreeUpdateRef.current(msg.tree);
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
        // Cleanup closes the socket too. Do not turn that intentional close into
        // a new reconnect loop, and ignore events from a superseded socket.
        if (stopped || activeSocket !== ws) return;
        activeSocket = null;
        // Raises the warning past the failure threshold and hands back the
        // exponential-backoff delay to wait before retrying.
        reconnectTimeout = setTimeout(() => {
          reconnectTimeout = null;
          connect();
        }, connectionLost());
      };

      ws.onerror = (error) => {
        if (stopped || activeSocket !== ws) return;
        console.error("WebSocket error:", error);
        ws.close();
      };
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimeout !== null) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
      if (activeSocket !== null) {
        // Detach close handling before the intentional shutdown. WebKit may
        // deliver close asynchronously, after a StrictMode remount has opened a
        // replacement socket.
        activeSocket.onclose = null;
        activeSocket.close();
        activeSocket = null;
      }
    };
  }, []);
}
