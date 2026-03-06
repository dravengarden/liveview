import { useEffect, useRef, useCallback } from "react";
import type { WsMessage, TreeNode, FileType } from "@/types";

interface UseWebSocketOptions {
  onContentUpdate: (path: string, fileType: FileType, content: string) => void;
  onTreeUpdate: (tree: TreeNode[]) => void;
}

export function useWebSocket({ onContentUpdate, onTreeUpdate }: UseWebSocketOptions): void {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      console.log("WebSocket connected");
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(event.data) as WsMessage;
        if (msg.type === "ContentUpdate") {
          onContentUpdate(msg.path, msg.file_type, msg.content);
        } else if (msg.type === "TreeUpdate") {
          onTreeUpdate(msg.tree);
        }
      } catch (e) {
        console.error("Failed to parse WebSocket message:", e);
      }
    };

    ws.onclose = () => {
      console.log("WebSocket disconnected, reconnecting...");
      reconnectTimeoutRef.current = setTimeout(connect, 1000);
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
