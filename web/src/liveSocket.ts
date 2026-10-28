import { takeStaleRead } from "./serverReachability.ts";

// Live WebSocket state shared with background refreshers. While the socket is
// connected the server pushes corpus (`TreeUpdate`), audio (`chapter-ready`),
// and organization (`LibraryUpdate`) changes, so pollers drop to a slow safety
// net instead of a fixed short interval.

type Listener = () => void;

/** Safety-net interval for polls while the socket pushes changes: it bounds a
 *  missed push (server listener reconnect, a coalesced epoch) without a
 *  short fixed poll. */
export const CONNECTED_POLL_INTERVAL_MS = 5 * 60_000;

let connected = false;
let everConnected = false;
const reconnectListeners = new Set<Listener>();
const libraryListeners = new Set<(revision: number) => void>();

export function isLiveSocketConnected(): boolean {
  return connected;
}

/** Record the socket state. A reconnect notifies listeners so they can catch
 *  up on pushes missed while disconnected. The first connect does too when a
 *  startup read was answered from the local copy (a launch without the server),
 *  since the startup fetches did not cover it then. */
export function setLiveSocketConnected(next: boolean): void {
  const opened = next && !connected;
  const reconnected = opened && (takeStaleRead() || everConnected);
  connected = next;
  if (next) everConnected = true;
  if (reconnected) { for (const listener of reconnectListeners) listener(); }
}

export function onLiveSocketReconnect(listener: Listener): () => void {
  reconnectListeners.add(listener);
  return () => reconnectListeners.delete(listener);
}

export function dispatchLibraryUpdate(revision: number): void {
  for (const listener of libraryListeners) listener(revision);
}

export function onLibraryUpdate(
  listener: (revision: number) => void,
): () => void {
  libraryListeners.add(listener);
  return () => libraryListeners.delete(listener);
}

/** Whether a background poll tick should fetch: always while disconnected,
 *  otherwise only once the connected safety-net interval has elapsed. */
export function pollTickDue(
  socketConnected: boolean,
  lastCheckAt: number,
  now: number,
): boolean {
  return !socketConnected || now - lastCheckAt >= CONNECTED_POLL_INTERVAL_MS;
}
