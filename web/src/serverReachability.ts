// Whether the LiveView server answers — distinct from whether the device has a
// network. WKWebView and NWPathMonitor report "online" on a captive portal, a
// network that cannot route to the server, or while the server is down; an
// offline-first reader must still answer from its replica at once there instead
// of spending a full fetch timeout on every read.
//
// Evidence, newest wins: an open live socket or any HTTP response from the server
// is "reachable"; a thrown fetch (network error, timeout) or a gateway error is
// "unreachable". Before any evidence the state is "unknown".

export type ServerReachability = "unknown" | "reachable" | "unreachable";

let state: ServerReachability = "unknown";
let staleRead = false;
const listeners = new Set<(state: ServerReachability) => void>();

export function serverReachability(): ServerReachability {
  return state;
}

function set(next: ServerReachability): void {
  if (state === next) return;
  state = next;
  for (const listener of listeners) listener(next);
}

/** The server answered (any status a gateway did not synthesize). */
export function noteServerReachable(): void {
  set("reachable");
}

/** A request to the server failed without a server answer. */
export function noteServerUnreachable(): void {
  set("unreachable");
}

/** Record a completed fetch to the server: 502/503/504 come from a proxy or
 *  the replica's own offline fallback, so they are not evidence of a live
 *  server. */
export function noteServerStatus(status: number): void {
  if (status === 502 || status === 503 || status === 504) noteServerUnreachable();
  else noteServerReachable();
}

export function onServerReachability(
  listener: (state: ServerReachability) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A read was answered from the local copy instead of the server. The next
 *  live-socket connect must catch up even if it is the first one. */
export function noteStaleRead(): void {
  staleRead = true;
}

/** Whether a stale read happened since the last call; clears the flag. */
export function takeStaleRead(): boolean {
  const had = staleRead;
  staleRead = false;
  return had;
}

/** Test hook. */
export function resetServerReachability(): void {
  state = "unknown";
  staleRead = false;
  listeners.clear();
}
