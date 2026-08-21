// App-bundle OTA updater (native shell only).
//
// TypeScript owns policy (ETag, which hashed files to skip, when to activate).
// Native fetches overlay bytes path-only from baked origins (`putFromUrl` has
// no `u=`). On success we `location.replace` a versioned `lvsync://localhost/app`
// URL so WKWebView cannot satisfy the navigation from its current-document
// cache. Playback survives because AVPlayer is native.

import { remoteUrl } from "./apiBase.ts";
import {
  appshellActivate,
  appshellCurrent,
  appshellHas,
  hostInfo,
  putFromUrl,
} from "./native-host.ts";
import { nativeSyncAvailable } from "./native-sync.ts";
import { otaReloadUrl } from "./otaReloadUrl.ts";

let applying = false;

interface WebManifest {
  version?: string;
  files?: string[];
}

/** Probe + (if newer) incrementally download the app bundle, then reload into it.
 *  Called on load and on every server `AppVersion` WS push. Idempotent. */
export async function runOtaCheck(): Promise<void> {
  if (applying || !nativeSyncAvailable()) return;
  try {
    const info = await hostInfo();
    // Native `web_get` already returns None in debug; skip the apply so a
    // just-built simulator bundle is not replaced by production OTA files.
    if (info?.debugEmbedded === true) return;

    const current = await appshellCurrent();
    const headers: Record<string, string> = {};
    if (current) headers["If-None-Match"] = current;
    const response = await fetch(remoteUrl("/app-dist/manifest.json"), {
      cache: "no-store",
      headers,
    });
    if (response.status === 304) return;
    if (!response.ok) return;

    const manifest = (await response.json()) as WebManifest;
    const version = manifest.version?.trim() ?? "";
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    if (!version || files.length === 0) return;
    if (version === current) return;

    const hashed = files.filter((f) => f !== "index.html" && !f.includes(".."));
    for (const path of hashed) {
      if (await appshellHas(path)) continue;
      const put = await putFromUrl(path);
      if (put == null) return;
    }
    const indexPut = await putFromUrl("index.html", version);
    if (indexPut == null) return;
    const ok = await appshellActivate(version, hashed);
    if (!ok) return;

    applying = true;
    globalThis.location.replace(
      otaReloadUrl(globalThis.location.href, version),
    );
  } catch {
    // offline / transient / not the native shell — ignore
  }
}

/** One on-load check (safety net before the WS connects). The live path is the
 *  server's AppVersion WS push → runOtaCheck. No-op off the native shell. */
export function startOtaUpdater(): void {
  if (!nativeSyncAvailable()) return;
  void runOtaCheck();
}
