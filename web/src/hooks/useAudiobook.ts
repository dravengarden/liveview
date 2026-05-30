import { useCallback, useEffect, useRef, useState } from "react";
import type { Mark, SpokenContent } from "@/types";

/** Resume position cache (audio seconds), client-only — avoids overloading the
 *  scroll-ratio progress store. */
const posKey = (path: string, lang: string): string => `lv-audio-pos:${path}:${lang}`;

export interface UseAudiobook {
  /** Read-along sentences (the narrated text), in spoken order. */
  sentences: string[];
  /** Index of the sentence currently being spoken, or -1. */
  currentIdx: number;
  playing: boolean;
  /** True while fetching sentences + synthesizing audio (first play is slow). */
  loading: boolean;
  error: string | null;
  rate: number;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  togglePlay: () => void;
  /** Seek to a sentence and play (used by clicking a sentence). */
  seekToSentence: (idx: number) => void;
  setRate: (r: number) => void;
}

/** Drives the audiobook read-along: fetches the spoken sentences + per-sentence
 *  time marks, points an <audio> element at the lazily-synthesized chapter MP3,
 *  and maps playback time → current sentence index. Audio, marks, and sentence
 *  indices share one server-side segmentation, so they align exactly.
 *
 *  `rendition` is forwarded to `/api/spoken|audio|marks` so the audio rendition
 *  reads the `<aid>.spoken.md` script directly (no `.md` fallback). Always
 *  `"audio"` at the only call site today; defaulted for safety. */
export function useAudiobook(path: string, lang: string, rendition = "audio"): UseAudiobook {
  const [sentences, setSentences] = useState<string[]>([]);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [currentIdx, setCurrentIdx] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rate, setRateState] = useState(1);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Fetch sentences (instant), then marks (triggers server synth — slow on
  // first play), then point the audio element at the cached MP3.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSentences([]);
    setMarks([]);
    setCurrentIdx(-1);
    setPlaying(false);
    const q = `path=${encodeURIComponent(path)}&lang=${encodeURIComponent(lang)}&rendition=${encodeURIComponent(rendition)}`;
    void (async () => {
      try {
        const sres = await fetch(`/api/spoken?${q}`);
        if (!sres.ok) throw new Error(`spoken: ${sres.status}`);
        const sdata = (await sres.json()) as SpokenContent;
        if (cancelled) return;
        setSentences(sdata.sentences);

        const mres = await fetch(`/api/marks?${q}`);
        if (!mres.ok) throw new Error(`marks: ${mres.status}`);
        const mdata = (await mres.json()) as Mark[];
        if (cancelled) return;
        setMarks(mdata);

        const audio = audioRef.current;
        if (audio) {
          audio.src = `/api/audio?${q}`;
          audio.playbackRate = rate;
          audio.load();
          const saved = Number(localStorage.getItem(posKey(path, lang)) ?? "");
          if (Number.isFinite(saved) && saved > 0) {
            audio.currentTime = saved;
          }
        }
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Keyed on (path, lang, rendition) only — a speed change must not re-fetch
    // the audio.
  }, [path, lang, rendition]);

  // Map playback time → sentence index (binary search; marks are contiguous).
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;

    const onTimeUpdate = (): void => {
      const ms = audio.currentTime * 1000;
      let lo = 0;
      let hi = marks.length - 1;
      let idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const m = marks[mid];
        if (!m) break;
        if (ms < m.start_ms) hi = mid - 1;
        else if (ms >= m.end_ms) lo = mid + 1;
        else {
          idx = mid;
          break;
        }
      }
      setCurrentIdx(idx);
      if (audio.currentTime > 0) {
        localStorage.setItem(posKey(path, lang), String(audio.currentTime));
      }
    };
    const onPlay = (): void => {
      setPlaying(true);
    };
    const onPause = (): void => {
      setPlaying(false);
    };
    const onEnded = (): void => {
      setPlaying(false);
      setCurrentIdx(-1);
      localStorage.removeItem(posKey(path, lang));
    };

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
    };
  }, [marks, path, lang]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  }, []);

  const seekToSentence = useCallback(
    (idx: number) => {
      const audio = audioRef.current;
      const m = marks[idx];
      if (!audio || !m) return;
      audio.currentTime = m.start_ms / 1000;
      void audio.play();
    },
    [marks]
  );

  const setRate = useCallback((r: number) => {
    setRateState(r);
    if (audioRef.current) audioRef.current.playbackRate = r;
  }, []);

  return {
    sentences,
    currentIdx,
    playing,
    loading,
    error,
    rate,
    audioRef,
    togglePlay,
    seekToSentence,
    setRate,
  };
}
