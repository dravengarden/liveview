// Shared playback-config widgets, so the speed + sleep controls are ONE
// implementation reused by every surface that configures playback (the audio
// read-along transport AND the portable PlaybackSheet). Before this they were
// copy-pasted in AudiobookPlayer + FloatingBubble, which drifted independently.
//
// Each chip is self-contained: it reads/writes the engine via useAudioPlayer, so
// a caller just drops <SpeedChip/> / <SleepChip/> in — no prop wiring. The chip
// follows the ui.md "no caret, the value IS the affordance" pattern: a Select
// stripped of underline + dropdown icon, value shown via renderValue.

import { rem } from "@/px";
import { MenuItem, Select, Typography } from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";
import { Bedtime } from "@mui/icons-material";
import { useAudioPlayer } from "@/audio/player";
import { useI18n } from "@/i18n";

export const RATES = [
  0.75,
  1,
  1.25,
  1.5,
  1.75,
  2,
  2.25,
  2.5,
  2.75,
  3,
  3.25,
  3.5,
  3.75,
];
/** Sleep-timer options in minutes (0 = off). Capped at 90. */
export const SLEEP_MINUTES = [15, 30, 45, 60, 90];

export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Compact sleep-timer label: 15m / 60→1h / 90→1h30m. Used for both the menu
 *  options and the live remaining display. */
export function fmtSleep(min: number): string {
  if (min >= 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m === 0 ? `${h}h` : `${h}h${m}m`;
  }
  return `${min}m`;
}

// No underline, no caret, value-centred. Callers can layer on a pill/background
// via `sx` (the transport uses it bare in a 40px "ear"; the sheet gives it a
// rounded button surface).
const chipSelectSx = {
  "& .MuiSelect-select": {
    py: 0.5,
    // MUI reserves padding-right (24px) for the dropdown icon even with
    // IconComponent removed; force it off both sides so nothing is clipped.
    px: "0 !important",
    minHeight: "44px !important",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 0.25,
  },
} as const;

/** Playback-speed chip (0.75×–3×). Self-wired to the engine. */
export function SpeedChip(
  { sx }: { sx?: SxProps<Theme> },
): React.JSX.Element {
  const { t } = useI18n();
  const { rate, setRate } = useAudioPlayer();
  return (
    <Select
      variant="standard"
      disableUnderline
      IconComponent={() => null}
      value={rate}
      onChange={(e) => setRate(Number(e.target.value))}
      aria-label={t("audiobook.speed")}
      renderValue={(v) => (
        <Typography
          component="span"
          variant="body2"
          fontWeight={700}
          sx={{ fontVariantNumeric: "tabular-nums" }}
        >
          {`${v}×`}
        </Typography>
      )}
      sx={[chipSelectSx, ...(Array.isArray(sx) ? sx : [sx])]}
    >
      {RATES.map((r) => (
        <MenuItem key={r} value={r}>
          {r}×
        </MenuItem>
      ))}
    </Select>
  );
}

/** Sleep-timer chip: moon when off, the live remaining time (accent) when armed.
 *  Self-wired to the engine. */
export function SleepChip(
  { sx }: { sx?: SxProps<Theme> },
): React.JSX.Element {
  const { t } = useI18n();
  const { sleepMinutes, sleepRemainingMin, setSleepTimer } = useAudioPlayer();
  const sleepActive = sleepRemainingMin > 0;
  return (
    <Select
      variant="standard"
      disableUnderline
      IconComponent={() => null}
      value={sleepMinutes}
      onChange={(e) => setSleepTimer(Number(e.target.value))}
      aria-label={t("audiobook.sleepTimer")}
      renderValue={() =>
        // Off → just the moon. Armed → only the remaining time (no moon), so the
        // longest label (e.g. "1h30m") fits without the icon crowding it.
        sleepActive
          ? (
            <Typography
              component="span"
              variant="body2"
              fontWeight={700}
              color="primary"
              sx={{ fontVariantNumeric: "tabular-nums" }}
            >
              {fmtSleep(sleepRemainingMin)}
            </Typography>
          )
          : <Bedtime sx={{ fontSize: rem(22), color: "text.secondary" }} />}
      sx={[chipSelectSx, ...(Array.isArray(sx) ? sx : [sx])]}
    >
      <MenuItem value={0}>{t("audiobook.sleepOff")}</MenuItem>
      {SLEEP_MINUTES.map((m) => (
        <MenuItem key={m} value={m}>
          {fmtSleep(m)}
        </MenuItem>
      ))}
    </Select>
  );
}
