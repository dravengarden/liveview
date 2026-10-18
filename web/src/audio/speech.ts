import { contentFetch } from "@/native-sync";
import { BUNDLED, REMOTE } from "@/apiBase";
import { loadServerSetting, putServerSetting } from "@/syncBackends";
import type { Mark } from "@/types";
import type { NowPlaying } from "./player";
import { voicePreferenceKey } from "./voice-model";
export { sentencePosition, voicePreferenceKey } from "./voice-model";

export interface VoiceChoice {
  id: string;
  label: string;
  status: "available" | "queued" | "running" | "ready" | "failed";
  audio_hash: string | null;
  marks_hash: string | null;
  bytes: number | null;
}

export interface SpeechPreparation {
  phase: "checking" | "queued" | "generating" | "reconnecting" | "loading" | "failed";
  voice: string;
  label: string;
  /** Time this device started waiting, not an estimate of server work. */
  startedAt: number;
}
export interface ChapterVoices {
  id: string;
  default_voice: string;
  voices: VoiceChoice[];
  effective?: SpeechOptions & { sources: Record<string, string> };
  encoding?: { bitrate_kbps: number; speed_percent: number };
}

export interface SpeechOptions {
  generation?: "all" | "on_demand";
  voices?: string[];
  default_voice?: string;
  bitrate_kbps?: number;
  speed_percent?: number;
  pronunciations?: Record<string, string>;
  omit_speakers?: string[];
}
export interface SpeechConfig extends SpeechOptions {
  languages?: Record<string, string | SpeechOptions>;
  chapters?: Record<string, string | SpeechOptions>;
}
export interface SpeechCatalog {
  chapters: ChapterVoices[];
  policies: Record<string, { global: SpeechConfig; book: SpeechConfig; rendition: SpeechConfig }>;
  installed_voices: string[];
  bitrates_kbps: number[];
}

export async function speechCatalog(np: NowPlaying, fresh = false): Promise<SpeechCatalog | null> {
  const path = `/api/speech/${encodeURIComponent(np.bookSlug)}`;
  if (!fresh) {
    const response = await contentFetch(path, { cacheFirst: true, connectMs: 2000 });
    return response.ok ? await response.json() as SpeechCatalog : null;
  }
  // The offline catalog is a hashed DAG resource: even a network-first replica
  // read returns that immutable version until its manifest advances. Settings
  // read-after-write and synthesis polling need the current server snapshot.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${BUNDLED ? REMOTE : ""}${path}`, { cache: "no-store", signal: controller.signal });
    return response.ok ? await response.json() as SpeechCatalog : null;
  } finally {
    clearTimeout(timer);
  }
}

export function saveVoicePreference(np: NowPlaying, voice: string): void {
  const key = voicePreferenceKey(np);
  localStorage.setItem(key, voice);
  void putServerSetting(key, voice);
}

export async function chapterVoices(np: NowPlaying, fresh = false): Promise<ChapterVoices | null> {
  const data = await speechCatalog(np, fresh);
  if (!data) return null; // Older servers have no optional voice API.
  const rel = np.chapterPath.startsWith(`${np.bookSlug}/`) ? np.chapterPath.slice(np.bookSlug.length + 1) : np.chapterPath;
  return data.chapters.find(c => c.id === `${np.rendition}/${np.lang}/${rel}`) ?? null;
}

export async function preferredVoice(np: NowPlaying, chapter: ChapterVoices): Promise<VoiceChoice | undefined> {
  const key = voicePreferenceKey(np);
  const local = localStorage.getItem(key);
  // Settings already share one bulk read with player startup. Bound that read
  // so cached audio stays immediate when a server cannot be reached.
  const remote = await Promise.race([
    loadServerSetting(key),
    new Promise<null>(resolve => setTimeout(() => resolve(null), 500)),
  ]);
  if (remote !== null) localStorage.setItem(key, remote);
  return selectPreferredVoice(chapter, remote ?? local, np.voice);
}

export function selectPreferredVoice(chapter: ChapterVoices, preference: string | null, explicit?: string): VoiceChoice | undefined {
  const articleDefault = chapter.effective?.sources["default_voice"]?.includes("chapter") ? chapter.default_voice : undefined;
  const id = explicit ?? articleDefault ?? preference ?? chapter.default_voice;
  return chapter.voices.find(v => v.id === id) ?? chapter.voices.find(v => v.id === chapter.default_voice);
}

export async function prepareVoice(
  np: NowPlaying,
  choice: VoiceChoice,
  current: () => boolean,
  onProgress?: (progress: SpeechPreparation) => void,
): Promise<VoiceChoice> {
  if (!current()) throw new Error("Cancelled");
  if (choice.status === "ready" && choice.audio_hash && choice.marks_hash) return choice;
  const startedAt = Date.now();
  let previousPhase: SpeechPreparation["phase"] | undefined;
  const report = (phase: SpeechPreparation["phase"]): void => {
    if (!current() || phase === previousPhase) return;
    previousPhase = phase;
    onProgress?.({ phase, voice: choice.id, label: choice.label, startedAt });
  };
  report("checking");
  const query = new URLSearchParams({ path: np.chapterPath, lang: np.lang, rendition: np.rendition });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${BUNDLED ? REMOTE : ""}/api/speech?${query}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice: choice.id }), signal: controller.signal,
    });
    if (!response.ok) throw new Error(await response.text());
  } finally {
    clearTimeout(timer);
  }
  report(choice.status === "running" ? "generating" : "queued");
  for (let attempt = 0; attempt < 300 && current(); attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 2000));
    if (!current()) throw new Error("Cancelled");
    let chapter: ChapterVoices | null;
    try {
      chapter = await chapterVoices(np, true);
    } catch {
      // A transient disconnect must not turn a server-side job into a failed
      // job. Keep observing it without submitting duplicate generation work.
      report("reconnecting");
      continue;
    }
    if (!current()) throw new Error("Cancelled");
    const ready = chapter?.voices.find(v => v.id === choice.id);
    if (chapter && !ready) throw new Error("Voice settings changed. Please choose a voice again.");
    if (ready?.status === "ready" && ready.audio_hash && ready.marks_hash) {
      report("loading");
      return ready;
    }
    if (ready?.status === "failed") throw new Error("Voice generation failed. Please retry.");
    report(!chapter ? "reconnecting" : ready?.status === "running" ? "generating" : ready?.status === "queued" ? "queued" : "checking");
  }
  if (!current()) throw new Error("Cancelled");
  throw new Error("Voice is still preparing. You can retry later.");
}

export async function voiceMarks(choice: VoiceChoice): Promise<Mark[]> {
  if (!choice.marks_hash) throw new Error("Voice timing is unavailable");
  const response = await contentFetch(`/api/blob/${choice.marks_hash}`, { cacheFirst: true });
  if (!response.ok) throw new Error("Voice timing is unavailable offline");
  const marks = await response.json() as Mark[];
  if (!Array.isArray(marks) || marks.length === 0 || marks.some((m, i) => m.idx !== i || !Number.isFinite(m.start_ms) || !Number.isFinite(m.end_ms) || m.start_ms < 0 || m.end_ms < m.start_ms || (i > 0 && marks[i - 1]!.end_ms > m.start_ms))) {
    throw new Error("Invalid voice timing");
  }
  return marks;
}
