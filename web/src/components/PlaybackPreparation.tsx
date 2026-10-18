import { useEffect, useState, type ReactNode } from "react";
import { Box, Button, LinearProgress, Typography } from "@mui/material";
import { useAudioPlayer, useAudioPreparation } from "@/audio/player";
import { fmtTime } from "@/audio/playback-ui";
import { useI18n } from "@/i18n";

/** The waiting clock belongs to this small label, never the player context or
 * reader. Stop ticking hidden pages and closed playback sheets. */
function WaitingTime({ startedAt, active }: { startedAt: number; active: boolean }): React.JSX.Element {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const update = (): void => {
      clearInterval(timer);
      if (active && document.visibilityState !== "hidden") {
        setNow(Date.now());
        timer = setInterval(() => setNow(Date.now()), 1000);
      }
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, [active]);
  return <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
    {t("audiobook.waited", { time: fmtTime(Math.max(0, (now - startedAt) / 1000)) })}
  </Typography>;
}

/** Replaces a meaningless 0:00 / disabled scrubber with the actual preparation
 * stage. The server reports stages, not a completion fraction: no fake percent
 * or countdown. Once audio is playable, the ordinary timeline returns. */
export function PlaybackPreparation({ children, active = true }: { children: ReactNode; active?: boolean }): React.JSX.Element {
  const { t } = useI18n();
  const preparation = useAudioPreparation();
  const { loading, voiceBusy, error, voiceError, nowPlaying, togglePlay, chooseVoice } = useAudioPlayer();
  const failed = Boolean(error || voiceError);
  if (!preparation && !loading && !voiceBusy && !failed) {
    return <Box sx={{ display: "flex", alignItems: "center", gap: 1, flex: 1, minWidth: 0 }}>{children}</Box>;
  }
  const phase = failed ? "failed" : preparation?.phase ?? "loading";
  const title = t(`audiobook.preparation.${phase}`);
  const hint = failed ? error ?? voiceError
    : phase === "reconnecting" ? t("audiobook.preparationReconnectHint")
    : phase === "loading" ? t("audiobook.preparationLoadHint")
    : voiceBusy ? t("audiobook.voicePreparing") : t("audiobook.preparationHint");
  const retry = (): void => {
    if (error) togglePlay();
    else chooseVoice(preparation?.voice ?? "", !preparation?.voice || preparation.voice === nowPlaying?.voice);
  };
  return (
    <Box data-testid="playback-preparation" data-phase={phase} sx={{ flex: 1, minWidth: 0, py: 0.75 }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1 }}>
        <Typography variant="body2" color={failed ? "error" : "text.primary"} fontWeight={600} role="status" aria-live={active ? "polite" : "off"} noWrap>
          {title}{preparation?.label && !failed ? ` · ${preparation.label.split(" · ")[0]}` : ""}
        </Typography>
        {!failed && preparation && <WaitingTime startedAt={preparation.startedAt} active={active} />}
        {failed && <Button size="small" onClick={retry} sx={{ minHeight: 40, py: 0 }}>{t("content.retry")}</Button>}
      </Box>
      {!failed && <LinearProgress aria-label={title} sx={{ my: 0.75, height: 3, borderRadius: 1,
        "@media (prefers-reduced-motion: reduce)": { "& .MuiLinearProgress-bar": { animation: "none", transform: "none", width: "35%" } },
      }} />}
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {hint}
      </Typography>
    </Box>
  );
}
