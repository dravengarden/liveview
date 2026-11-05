// Repository-owned state-sync tier: a local-first reactive value mirrored to a
// passive remote key-value store (settings, progress, playback session), with
// optional device-local persistence. See src/mirrored.ts.

export { mirroredStore } from "./src/mirrored.ts";
export type { MirroredOpts, MirroredStore, SyncStatus } from "./src/mirrored.ts";
export type { LocalPersistence, RemoteBackend } from "./src/types.ts";
