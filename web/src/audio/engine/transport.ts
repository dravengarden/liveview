// How a native engine event moves the transport's visible flags. `playing` is
// real playback, `buffering` is play intent waiting on media, and `loading`
// drives the spinner. A patch names only the flags the event changes.

export interface TransportPatch {
  playing?: boolean;
  buffering?: boolean;
  loading?: boolean;
}

export type NativeTransportEvent = "playing" | "paused" | "ended" | "canplay" | "waiting" | "error";

const STOPPED: TransportPatch = { playing: false, buffering: false, loading: false };

/** The transport patch for a native event, or `null` when the event leaves
 *  the flags alone.
 *
 *  - `playing` is authoritative only from shells that advertise the queue
 *    capability. Installed protocol-v1 shells report the requested rate, not
 *    AVPlayer's state, so their `playing` waits for advancing media time.
 *  - `waiting` keeps `playing` truthful (false) while `buffering` remembers the
 *    play intent, so the spinner stays tappable as Pause.
 *  - `canplay` cannot end a stall: only `playing` or a stop clears buffering.
 *  - `ended` leaves `playing` to the auto-advance that follows. */
export function nativeTransportPatch(
  event: NativeTransportEvent,
  state: { buffering: boolean; queueAuthoritative: boolean },
): TransportPatch | null {
  switch (event) {
    case "playing":
      return state.queueAuthoritative ? { playing: true, buffering: false, loading: false } : null;
    case "waiting":
      return { playing: false, buffering: true, loading: true };
    case "canplay":
      return state.buffering ? null : { loading: false };
    case "ended":
      return { buffering: false, loading: false };
    case "paused":
    case "error":
      return STOPPED;
  }
}
