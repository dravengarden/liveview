// App-wide signals. Each one names a fact that changed; the modules that care
// subscribe directly. These replace the former `lv-*` window events, which
// crossed no runtime boundary and only hid who talked to whom. Native bridge
// events (`lv-native-*`) are not signals: they come from the WKWebView host.

import { createSignal } from "@/_store/signal.ts";

/** A download policy input changed: PWA downloads on/off, Wi-Fi-only, the
 *  storage cap, the audio preload strategy, or backend connectivity. */
export const downloadPolicy = createSignal();

/** The locally stored voice preference for some book/rendition/edition
 *  changed (a user choice or a server-pushed value). */
export const voicePreference = createSignal();

/** The audio preloader wants its driver to run a tick soon. */
export const audioCacheWake = createSignal();

/** A surface asked for the shared playback-control sheet to open. */
export const playbackControls = createSignal();
