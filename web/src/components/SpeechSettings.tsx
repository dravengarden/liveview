import { useEffect, useState } from "react";
import { Alert, Box, Button, FormControl, FormControlLabel, InputLabel, MenuItem, Select, Switch, TextField, Typography } from "@mui/material";
import { useI18n } from "@/i18n";
import type { NowPlaying } from "@/audio/player";
import { speechCatalog, type SpeechCatalog, type SpeechConfig, type SpeechOptions } from "@/audio/speech";
import { BUNDLED, REMOTE } from "@/apiBase";

type Scope = "chapter" | "rendition" | "book" | "global";
const labelVoice = (id: string): string => id === "kokoro:af_heart" ? "Heart · Kokoro" : id === "kokoro:af_bella" ? "Bella · Kokoro" : id.replace(/^edge:/, "").replace(/Neural$/, "");

export function SpeechSettings({ np, onSaved }: { np: NowPlaying; onSaved: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<SpeechCatalog | null>(null);
  const [scope, setScope] = useState<Scope>("chapter");
  const [draft, setDraft] = useState<SpeechConfig>({});
  const [words, setWords] = useState("");
  const [speakers, setSpeakers] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const rel = np.chapterPath.replace(`${np.bookSlug}/`, "");
  const article = `${np.lang}/${rel}`;
  const chapter = catalog?.chapters.find(c => c.id === `${np.rendition}/${article}`);
  useEffect(() => {
    let active = true;
    void speechCatalog(np, true).then(value => {
      if (!active) return;
      if (value?.policies?.[np.rendition]?.global) setCatalog(value);
      else setError(t("speech.unavailable"));
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [np.bookSlug, np.chapterPath, np.rendition, np.lang, t]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!catalog) return;
    const policy = catalog.policies[np.rendition]!;
    const raw = scope === "chapter" ? policy.rendition.chapters?.[article] : policy[scope];
    const value = typeof raw === "string" ? { default_voice: raw } : raw ?? {};
    setDraft(value);
    setWords(Object.entries(value.pronunciations ?? {}).map(([a,b]) => `${a} = ${b}`).join("\n"));
    setSpeakers((value.omit_speakers ?? []).join(", "));
  }, [catalog, scope, np.rendition, article]);

  function field(key: keyof SpeechOptions, value: SpeechOptions[keyof SpeechOptions] | undefined): void {
    setDraft(previous => { const next = { ...previous }; if (value === undefined) delete next[key]; else Object.assign(next, { [key]: value }); if (key === "default_voice" && typeof value === "string" && next.voices && !next.voices.includes(value)) next.voices = [...next.voices, value]; return next; });
    setSaved(false);
  }
  const voices = [...new Set([...(catalog?.installed_voices ?? []), ...(chapter?.voices.map(v => v.id) ?? []), ...(draft.voices ?? []), ...(draft.default_voice ? [draft.default_voice] : [])])];
  const source = (field: string): string => {
    const value = chapter?.effective?.sources[field];
    return t(value?.includes("chapter") ? "speech.chapter" : `speech.${value?.split(":")[0] ?? "builtin"}`);
  };
  async function save(): Promise<void> {
    setBusy(true); setError(null); setSaved(false);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const next = { ...draft };
      if (next.pronunciations) {
        const rules: Record<string, string> = {};
        for (const line of words.split("\n").filter(s => s.trim())) {
          const at = line.indexOf("=");
          if (at < 1 || !line.slice(at + 1).trim()) throw new Error(t("speech.ruleError"));
          rules[line.slice(0, at).trim()] = line.slice(at + 1).trim();
        }
        next.pronunciations = rules;
      }
      if (next.omit_speakers) next.omit_speakers = speakers.split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
      const url = scope === "global" ? "/api/speech-defaults" : `/api/speech/${encodeURIComponent(np.bookSlug)}`;
      const body = scope === "global" ? next : { speech: next, ...(scope !== "book" ? { rendition: np.rendition } : {}), ...(scope === "chapter" ? { chapter: article } : {}) };
      const response = await fetch(`${BUNDLED ? REMOTE : ""}${url}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      if (!response.ok) throw new Error(await response.text());
      const updated = await speechCatalog(np, true);
      if (updated) setCatalog(updated);
      setSaved(true); onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { clearTimeout(timer); setBusy(false); }
  }
  return <Box sx={{ display: "flex", flexDirection: "column", gap: 2, borderTop: 1, borderColor: "divider", pt: 2 }} data-testid="speech-settings">
    <Typography variant="subtitle2">{t("speech.title")}</Typography>
    <FormControl fullWidth size="small"><InputLabel id="speech-scope-label">{t("speech.scope")}</InputLabel><Select labelId="speech-scope-label" label={t("speech.scope")} value={scope} onChange={e => {setScope(e.target.value as Scope);setSaved(false);}} disabled={busy} data-testid="speech-scope">
      {(["chapter", "rendition", "book", "global"] as Scope[]).map(s => <MenuItem key={s} value={s}>{t(s === "rendition" && np.rendition === "audio" ? "speech.audiobook" : `speech.${s}`)}</MenuItem>)}
    </Select></FormControl>
    <Typography variant="caption" color="text.secondary">{t("speech.inheritanceHint")}</Typography>
    <FormControl fullWidth size="small"><InputLabel shrink id="speech-generation-label">{t("speech.automatic")}</InputLabel><Select displayEmpty labelId="speech-generation-label" label={t("speech.automatic")} value={draft.generation ?? ""} onChange={e => field("generation", e.target.value || undefined)} disabled={busy || !catalog} data-testid="speech-generation">
      <MenuItem value="">{t("speech.inherit")}</MenuItem><MenuItem value="all">{t("speech.all")}</MenuItem><MenuItem value="on_demand">{t("speech.onDemand")}</MenuItem>
    </Select></FormControl>
    <FormControl fullWidth size="small"><InputLabel shrink id="speech-default-label">{t("speech.defaultVoice")}</InputLabel><Select displayEmpty labelId="speech-default-label" label={t("speech.defaultVoice")} value={draft.default_voice ?? ""} onChange={e => field("default_voice", e.target.value || undefined)} disabled={busy || !catalog} data-testid="speech-default-voice">
      <MenuItem value="">{t("speech.inherit")}</MenuItem>{voices.map(v => <MenuItem key={v} value={v}>{labelVoice(v)}</MenuItem>)}
    </Select></FormControl>
    <FormControl fullWidth size="small"><InputLabel shrink id="speech-bitrate-label">{t("speech.bitrate")}</InputLabel><Select displayEmpty labelId="speech-bitrate-label" label={t("speech.bitrate")} value={draft.bitrate_kbps ?? ""} onChange={e => field("bitrate_kbps", String(e.target.value) === "" ? undefined : Number(e.target.value))} disabled={busy || !catalog} data-testid="speech-bitrate">
      <MenuItem value="">{t("speech.inherit")}</MenuItem>{(catalog?.bitrates_kbps ?? [32,48,64,96,128,160]).map(n => <MenuItem key={n} value={n}>{n} kbps{n === 96 ? ` · ${t("speech.recommended")}` : ""}</MenuItem>)}
    </Select></FormControl>
    <Typography variant="caption" color="text.secondary">{t("speech.currentBitrate", { value: chapter?.encoding?.bitrate_kbps ?? 96, source: source("bitrate_kbps") })}</Typography>
    <FormControl fullWidth size="small"><InputLabel shrink id="speech-speed-label">{t("speech.generationSpeed")}</InputLabel><Select displayEmpty labelId="speech-speed-label" label={t("speech.generationSpeed")} value={draft.speed_percent ?? ""} onChange={e => field("speed_percent", String(e.target.value) === "" ? undefined : Number(e.target.value))} disabled={busy || !catalog} data-testid="speech-speed">
      <MenuItem value="">{t("speech.inherit")}</MenuItem>{[...new Set([50,75,90,100,110,125,150,...(draft.speed_percent ? [draft.speed_percent] : [])])].sort((a,b)=>a-b).map(n => <MenuItem key={n} value={n}>{n / 100}×</MenuItem>)}
    </Select></FormControl>
    <Typography variant="caption" color="text.secondary">{t("speech.speedHint")}</Typography>
    <FormControlLabel control={<Switch checked={draft.voices !== undefined} disabled={busy || !catalog} onChange={(_, value) => field("voices", value ? chapter?.voices.length ? chapter.voices.map(v=>v.id) : voices.slice(0,1) : undefined)} />} label={t("speech.customVoices")} />
    {draft.voices && <FormControl fullWidth size="small"><InputLabel id="speech-allowed-label">{t("speech.allowedVoices")}</InputLabel><Select multiple labelId="speech-allowed-label" label={t("speech.allowedVoices")} value={draft.voices} renderValue={value => value.map(labelVoice).join(", ")} onChange={e => field("voices", typeof e.target.value === "string" ? e.target.value.split(",") : e.target.value)} disabled={busy}>{voices.map(v => <MenuItem key={v} value={v}>{labelVoice(v)}</MenuItem>)}</Select></FormControl>}
    <FormControlLabel control={<Switch checked={draft.pronunciations !== undefined} disabled={busy || !catalog} onChange={(_, value) => field("pronunciations", value ? {} : undefined)} />} label={t("speech.customPronunciation")} />
    {draft.pronunciations && <TextField multiline minRows={2} label={t("speech.pronunciation")} helperText={t("speech.ruleHint")} value={words} onChange={e => {setWords(e.target.value);setSaved(false);}} disabled={busy} />}
    <FormControlLabel control={<Switch checked={draft.omit_speakers !== undefined} disabled={busy || !catalog} onChange={(_, value) => field("omit_speakers", value ? [] : undefined)} />} label={t("speech.customSpeakers")} />
    {draft.omit_speakers && <TextField label={t("speech.speakers")} helperText={t("speech.speakerHint")} value={speakers} onChange={e => {setSpeakers(e.target.value);setSaved(false);}} disabled={busy} />}
    {error && <Alert severity="error">{error}</Alert>}
    {saved && <Typography role="status" color="success.main">{t("speech.saved")}</Typography>}
    <Button variant="contained" onClick={() => void save()} disabled={busy || !catalog} data-testid="speech-save">{t(busy ? "speech.saving" : "speech.save")}</Button>
  </Box>;
}
