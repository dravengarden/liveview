// The native (AVPlayer) engine adapter: which native event does what to the
// player. The provider supplies a host over its refs and state; this module
// owns the event contract, so it is testable without React or a shell.

import type { NativeAudioEvent, NativePlaybackSnapshot } from "../../native-audio.ts";
import { nativeEventMatches } from "../native-queue.ts";
import { nativeTransportPatch, type TransportPatch } from "./transport.ts";

/** The player state and operations a native event can read or drive. */
export interface NativeEngineHost {
  /** An explicit load is replacing the source; the old item's events are stale. */
  readonly sourcePending: boolean;
  readonly queueId: string | null;
  readonly queueIndex: number;
  readonly playing: boolean;
  readonly buffering: boolean;
  /** The shell advertises the queue capability, so its `playing` is real. */
  readonly queueAuthoritative: boolean;
  adoptSnapshot(snapshot: NativePlaybackSnapshot): void;
  /** Advance after a track the shell finished while the web view was away. */
  goTo(index: number): void;
  /** Media time is before the end again, so a later `ended` is genuine. */
  clearEnded(): void;
  observeSleep(remainingSeconds: number): void;
  position(position: number, duration: number): void;
  duration(duration: number): void;
  startSleepSession(): void;
  resetPlaybackProof(): void;
  /** Hold the control pending until media time proves playback. */
  expectPlayback(): void;
  transport(patch: TransportPatch | null): void;
  /** Persist the paused position and freeze the sleep countdown. */
  paused(): void;
  ended(): void;
  /** Stall bookkeeping: log, clear the optimistic timer, start the proof. */
  stalled(): void;
  next(): void;
  prev(): void;
  error(message: string): void;
}

/** Route one native engine event to the host. */
export function routeNativeEvent(ev: NativeAudioEvent, host: NativeEngineHost): void {
  if (ev.type === "snapshot") {
    // Startup adopts the native pointer after the local queue is hydrated.
    // During an explicit load only that load may replace the current source.
    if (!host.sourcePending && ev.queueId && ev.queueId === host.queueId) {
      host.adoptSnapshot(ev);
      if (ev.needsAdvance) host.goTo(ev.index + 1);
    }
    return;
  }
  if (!nativeEventMatches(ev, host.queueId, host.queueIndex)) return;
  const state = { buffering: host.buffering, queueAuthoritative: host.queueAuthoritative };
  switch (ev.type) {
    case "time":
      if (ev.position < ev.duration) host.clearEnded();
      if (host.queueAuthoritative && ev.sleepRemaining !== undefined) host.observeSleep(ev.sleepRemaining);
      host.position(ev.position, ev.duration);
      break;
    case "durationchange":
      host.duration(ev.duration);
      break;
    case "playing": {
      host.startSleepSession();
      const patch = nativeTransportPatch("playing", state);
      if (patch) {
        host.clearEnded();
        host.resetPlaybackProof();
        host.transport(patch);
      } else if (!host.playing) {
        // Installed protocol-v1 shells report the requested rate, not
        // AVPlayer's state: wait for advancing media time.
        host.expectPlayback();
      }
      break;
    }
    case "paused":
      // The replaced item's pause must not clear the new chapter's play
      // intent or persist its position under the new chapter.
      if (host.sourcePending) break;
      host.resetPlaybackProof();
      host.transport(nativeTransportPatch("paused", state));
      host.paused();
      break;
    case "ended":
      if (host.sourcePending) break;
      host.resetPlaybackProof();
      host.transport(nativeTransportPatch("ended", state));
      host.ended();
      break;
    case "canplay":
      host.transport(nativeTransportPatch("canplay", state));
      break;
    case "waiting":
      host.stalled();
      host.transport(nativeTransportPatch("waiting", state));
      break;
    case "next":
      host.next();
      break;
    case "prev":
      host.prev();
      break;
    case "error":
      // Clear the spinner and the playing state so the UI never sits on an
      // endless loading icon; the error drives the disabled state.
      host.error(ev.message);
      host.resetPlaybackProof();
      host.transport(nativeTransportPatch("error", state));
      break;
    case "network":
    case "cacheProgress":
      // Connectivity and the replica consume these; playback has no work.
      break;
  }
}
