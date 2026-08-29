import { rem } from "@/px";
import {
  Box,
  MenuItem,
  Select,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import type { SxProps, Theme as MuiTheme } from "@mui/material/styles";
import {
  Check as CheckIcon,
  ExpandLess as CollapseIcon,
  ExpandMore as ExpandIcon,
} from "@mui/icons-material";
import { useState } from "react";
import { SettingsSheet } from "../_shell";
import type { MenuBarSettings, Theme, ThemeMode, ThemeVariant } from "@/types";
import { THEME_VARIANTS, VARIANT_OPTIONS } from "@/types";
import { FONT_PRESETS } from "@/fonts";
import { UI_LANGUAGES, useI18n } from "@/i18n";
import { OfflineSection } from "./OfflineSection";
import { SegmentedPill } from "./SegmentedPill";
import { nativeSyncAvailable } from "@/native-sync";

interface SettingsButtonProps {
  variant: ThemeVariant;
  mode: ThemeMode;
  fontId: string;
  menuBarSettings: MenuBarSettings;
  onVariantChange: (v: ThemeVariant) => void;
  onModeChange: (m: ThemeMode) => void;
  onFontChange: (id: string) => void;
  onContentMaxWidthChange: (width: number) => void;
  onLineHeightChange: (lh: number) => void;
  onFontScaleChange: (scale: number) => void;
}

const MODE_OPTIONS: ThemeMode[] = ["auto", "light", "dark"];

// The running web build's content hash (the entry chunk's hashed filename). The
// native app version is a static 0.1.0, so on a device this is the ONLY reliable
// way to tell which web bundle is actually live — i.e. whether a deploy/cold-launch
// truly picked up new code. Shown in Settings → About. "dev" off the bundle.
const BUILD_ID = ((): string => {
  try {
    const src = [...document.querySelectorAll<HTMLScriptElement>("script[src]")]
      .map((e) => e.src)
      .find((s) => /\/(?:assets\/)?index-/.test(s));
    return src ? (/index-([A-Za-z0-9_-]+)\.js/.exec(src)?.[1] ?? "dev") : "dev";
  } catch {
    return "dev";
  }
})();

// Discrete presets for the reading-layout dropdowns — a slider was fiddly on
// touch and a number field would pop the keyboard; a small set taps cleanly.
// Values mirror cowboy's latest (margin = its reading padding) so the two apps'
// reading controls line up.
const MARGIN_PRESETS = [8, 12, 16, 20, 24, 32, 48];
const LINE_HEIGHT_PRESETS = [1.3, 1.4, 1.5, 1.6, 1.8, 2.0];
// App-wide font-size multipliers (1 = unchanged), shown as percentages — the
// exact set cowboy offers.
const FONT_SCALE_PRESETS = [
  0.55,
  0.6,
  0.65,
  0.7,
  0.75,
  0.8,
  0.85,
  0.9,
  1,
  1.1,
  1.25,
];

/** Snap a stored value (e.g. from the old slider) to the nearest preset, so the
 *  dropdown always shows something selected. */
function nearest(value: number, presets: number[]): number {
  return presets.reduce(
    (a, b) => (Math.abs(b - value) < Math.abs(a - value) ? b : a),
    presets[0] ?? value,
  );
}

/** Shared card chrome for the font picker (collapsed summary + expanded rows),
 *  matching the cowboy settings idiom: a 2px ring that turns accent when active. */
const fontCardSx = (active: boolean): SxProps<MuiTheme> => ({
  cursor: "pointer",
  borderRadius: 1,
  border: 2,
  borderColor: active ? "primary.main" : "divider",
  px: 1.5,
  py: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 1,
  transition: "border-color 0.15s ease",
  "&:hover": { borderColor: active ? "primary.main" : "text.secondary" },
});

interface ThemeColors {
  bg: string;
  fg: string;
  accent: string;
}

function getThemeColors(themeValue: Theme): ThemeColors {
  switch (themeValue) {
    case "light":
      return { bg: "#f6f3ee", fg: "#242129", accent: "#754b86" };
    case "sepia":
      return { bg: "#f3ecdf", fg: "#453c35", accent: "#754b86" };
    case "lavender":
      return { bg: "#f4f1f7", fg: "#29232f", accent: "#754b86" };
    case "dark":
      return { bg: "#11131a", fg: "#f2efe9", accent: "#ae8dde" };
    case "night":
      return { bg: "#191715", fg: "#e5ddd1", accent: "#ae8dde" };
    case "plum":
      return { bg: "#171321", fg: "#f0ebf7", accent: "#ae8dde" };
  }
}

/** A settings row: a label + one-line description on the left, a compact control
 *  on the right (the cowboy settings pattern — taps cleanly, self-documents). */
function Row(
  { label, desc, control }: {
    label: string;
    desc: string;
    control: React.ReactNode;
  },
): React.JSX.Element {
  return (
    <Stack
      direction="row"
      alignItems="center"
      justifyContent="space-between"
      spacing={2}
    >
      <Stack sx={{ minWidth: 0 }}>
        <Typography variant="body2">{label}</Typography>
        <Typography variant="caption" color="text.secondary">
          {desc}
        </Typography>
      </Stack>
      {control}
    </Stack>
  );
}

export function SettingsButton({
  variant,
  mode,
  menuBarSettings,
  fontId,
  onVariantChange,
  onModeChange,
  onFontChange,
  onContentMaxWidthChange,
  onLineHeightChange,
  onFontScaleChange,
}: SettingsButtonProps): React.JSX.Element {
  const { t, lang, setLang } = useI18n();
  // The font picker is collapsed by default — its 7 preview cards would
  // otherwise dominate the sheet. Collapsed shows just the current face,
  // previewed in itself; expanding drops the full list, and picking a face
  // re-collapses (cowboy's pattern).
  const [fontOpen, setFontOpen] = useState(false);
  const selectedFont = FONT_PRESETS.find((p) => p.id === fontId) ??
    FONT_PRESETS[0];

  // Two segments (cowboy SegmentedPill): all the Settings in one scroll + a
  // Downloads segment for the offline cache. The Downloads segment only exists on
  // the native shell (the PWA caches via the SW, nothing to manage here).
  const hasDownloads = nativeSyncAvailable();
  const [seg, setSeg] = useState<"settings" | "downloads">("settings");

  return (
    <SettingsSheet title={t("settings.title")} wide cover>
      {
        /* A continuous grouped list (iOS-settings rhythm): each section is an
          overline header + its controls, with a single consistent gap between
          sections. No floating <Divider>s — they sat in a big gap and read as
          stray lines / wasted space; the headers do the separating. */
      }
      <Stack spacing={2}>
        {hasDownloads && (
          <SegmentedPill
            value={seg}
            onChange={setSeg}
            options={[
              { value: "settings", label: t("settings.title") },
              { value: "downloads", label: t("offline.downloads") },
            ]}
            sx={{ alignSelf: "center" }}
          />
        )}

        {seg === "settings" && (
          <Stack spacing={2.25}>
            {/* ── Theme: palette pair + light/dark mode ──────────────────────── */}
            <Stack spacing={1.5}>
              <Typography variant="overline" color="text.secondary">
                {t("settings.theme")}
              </Typography>

              {/* Palette — a light/dark colour pair (each swatch previews both). */}
              <Stack spacing={1}>
                <Typography variant="body2">{t("settings.palette")}</Typography>
                <Box
                  sx={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, 1fr)",
                    gap: 1,
                  }}
                >
                  {VARIANT_OPTIONS.map((option) => {
                    const isSelected = variant === option.value;
                    const lightC = getThemeColors(
                      THEME_VARIANTS[option.value].light,
                    );
                    const darkC = getThemeColors(
                      THEME_VARIANTS[option.value].dark,
                    );
                    return (
                      <Box
                        key={option.value}
                        onClick={() => onVariantChange(option.value)}
                        sx={{
                          cursor: "pointer",
                          borderRadius: 1,
                          border: 2,
                          borderColor: isSelected ? "primary.main" : "divider",
                          overflow: "hidden",
                          transition: "border-color 0.15s ease",
                          "&:hover": {
                            borderColor: isSelected
                              ? "primary.main"
                              : "text.secondary",
                          },
                        }}
                      >
                        <Box
                          sx={{
                            height: 44,
                            display: "flex",
                            position: "relative",
                          }}
                        >
                          {[lightC, darkC].map((c, i) => (
                            <Box
                              key={i}
                              sx={{
                                flex: 1,
                                bgcolor: c.bg,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              <Box
                                sx={{
                                  width: 18,
                                  height: 3,
                                  bgcolor: c.accent,
                                  borderRadius: 0.5,
                                }}
                              />
                            </Box>
                          ))}
                          {isSelected && (
                            <Box
                              sx={{
                                position: "absolute",
                                top: 3,
                                right: 3,
                                width: 16,
                                height: 16,
                                borderRadius: "50%",
                                bgcolor: "primary.main",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              <CheckIcon
                                sx={{ fontSize: rem(11), color: "white" }}
                              />
                            </Box>
                          )}
                        </Box>
                        <Typography
                          variant="caption"
                          sx={{
                            display: "block",
                            textAlign: "center",
                            py: 0.5,
                            fontSize: "0.72rem",
                            bgcolor: "background.paper",
                          }}
                        >
                          {t(`theme.${option.value}`)}
                        </Typography>
                      </Box>
                    );
                  })}
                </Box>
              </Stack>

              {/* Mode — which half of the pair, or follow the OS. */}
              <Stack spacing={1}>
                <Typography variant="body2">{t("settings.mode")}</Typography>
                <ToggleButtonGroup
                  size="small"
                  exclusive
                  value={mode}
                  onChange={(_, value: ThemeMode | null) => {
                    if (value) onModeChange(value);
                  }}
                  sx={{ width: "100%", "& .MuiToggleButton-root": { flex: 1 } }}
                >
                  {MODE_OPTIONS.map((m) => (
                    <ToggleButton key={m} value={m}>
                      {t(`mode.${m}`)}
                    </ToggleButton>
                  ))}
                </ToggleButtonGroup>
              </Stack>
            </Stack>

            {/* ── Reading: font + layout ─────────────────────────────────────── */}
            <Stack spacing={1.5}>
              <Typography variant="overline" color="text.secondary">
                {t("settings.reading")}
              </Typography>

              {
                /* Font — collapsible. Collapsed shows the current face previewed in
              itself; expanding drops the full picker; choosing auto-collapses.
              Each card previews its own @fontsource woff2 (lazy once selected). */
              }
              {fontOpen
                ? (
                  <Stack spacing={0.75}>
                    <Box
                      onClick={() => setFontOpen(false)}
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        cursor: "pointer",
                        px: 0.5,
                      }}
                    >
                      <Typography variant="body2">
                        {t("settings.font")}
                      </Typography>
                      <CollapseIcon sx={{ color: "text.secondary" }} />
                    </Box>
                    {FONT_PRESETS.map((preset) => {
                      const isSelected = fontId === preset.id;
                      return (
                        <Box
                          key={preset.id}
                          onClick={() => {
                            onFontChange(preset.id);
                            setFontOpen(false);
                          }}
                          sx={fontCardSx(isSelected)}
                        >
                          <Box sx={{ minWidth: 0 }}>
                            <Typography
                              sx={{
                                fontFamily: preset.stack,
                                fontSize: "1.05rem",
                                lineHeight: 1.3,
                              }}
                              noWrap
                            >
                              {preset.label} · 阅读 Aa
                            </Typography>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              noWrap
                            >
                              {preset.note}
                            </Typography>
                          </Box>
                          {isSelected && (
                            <CheckIcon fontSize="medium" color="primary" />
                          )}
                        </Box>
                      );
                    })}
                  </Stack>
                )
                : (
                  // Collapsed summary — the current face, tap to change.
                  <Box
                    onClick={() => setFontOpen(true)}
                    aria-label={t("settings.font")}
                    sx={fontCardSx(false)}
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="caption" color="text.secondary">
                        {t("settings.font")}
                      </Typography>
                      <Typography
                        sx={{
                          fontFamily: selectedFont?.stack,
                          fontSize: "1.05rem",
                          lineHeight: 1.3,
                        }}
                        noWrap
                      >
                        {selectedFont?.label} · 阅读 Aa
                      </Typography>
                    </Box>
                    <ExpandIcon sx={{ color: "text.secondary" }} />
                  </Box>
                )}

              {
                /* Reading font size — a multiplier on the reading text only (shown
              as a percentage); the chrome stays at its fixed size. */
              }
              <Row
                label={t("settings.fontSize")}
                desc={t("settings.fontSizeDesc")}
                control={
                  <Select
                    size="small"
                    value={nearest(
                      menuBarSettings.fontScale,
                      FONT_SCALE_PRESETS,
                    )}
                    onChange={(e) => onFontScaleChange(Number(e.target.value))}
                    sx={{ minWidth: 104 }}
                  >
                    {FONT_SCALE_PRESETS.map((v) => (
                      <MenuItem key={v} value={v}>
                        {`${Math.round(v * 100)}%`}
                      </MenuItem>
                    ))}
                  </Select>
                }
              />

              {
                /* Reading margin — left/right padding of the reading column (works on
              mobile, unlike a max-width). */
              }
              <Row
                label={t("settings.margin")}
                desc={t("settings.marginDesc")}
                control={
                  <Select
                    size="small"
                    value={nearest(
                      menuBarSettings.contentMaxWidth,
                      MARGIN_PRESETS,
                    )}
                    onChange={(e) =>
                      onContentMaxWidthChange(Number(e.target.value))}
                    sx={{ minWidth: 104 }}
                  >
                    {MARGIN_PRESETS.map((v) => (
                      <MenuItem key={v} value={v}>
                        {`${v}px`}
                      </MenuItem>
                    ))}
                  </Select>
                }
              />

              <Row
                label={t("settings.lineHeight")}
                desc={t("settings.lineHeightDesc")}
                control={
                  <Select
                    size="small"
                    value={nearest(
                      menuBarSettings.lineHeight,
                      LINE_HEIGHT_PRESETS,
                    )}
                    onChange={(e) => onLineHeightChange(Number(e.target.value))}
                    sx={{ minWidth: 104 }}
                  >
                    {LINE_HEIGHT_PRESETS.map((v) => (
                      <MenuItem key={v} value={v}>
                        {v.toFixed(1)}
                      </MenuItem>
                    ))}
                  </Select>
                }
              />
            </Stack>

            {
              /* Bookshelf grouping (and sort + kind filter) now live in the shelf's
            own Sort & Filter control — organizing the shelf belongs there, not in
            app preferences. */
            }

            {/* ── Interface language ─────────────────────────────────────────── */}
            <Stack spacing={1}>
              <Typography variant="overline" color="text.secondary">
                {t("settings.language")}
              </Typography>
              <ToggleButtonGroup
                size="small"
                exclusive
                value={lang}
                onChange={(_, value: string | null) => {
                  const language = UI_LANGUAGES.find(({ id }) => id === value);
                  if (language) setLang(language.id);
                }}
              >
                {UI_LANGUAGES.map(({ id, label }) => (
                  <ToggleButton key={id} value={id}>{label}</ToggleButton>
                ))}
              </ToggleButtonGroup>
            </Stack>

            {/* ── About ──────────────────────────────────────────────────────── */}
            <Stack spacing={0.5}>
              <Typography variant="overline" color="text.secondary">
                {t("settings.about")}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t("settings.aboutText")}
              </Typography>
              <Typography variant="caption" color="text.disabled">
                build {BUILD_ID}
              </Typography>
            </Stack>
          </Stack>
        )}

        {seg === "downloads" && <OfflineSection />}
      </Stack>
    </SettingsSheet>
  );
}
