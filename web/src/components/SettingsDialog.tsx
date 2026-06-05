import {
  Box,
  MenuItem,
  Select,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { Check as CheckIcon } from "@mui/icons-material";
import { SettingsSheet } from "../_shell";
import type { MenuBarSettings, Theme, ThemeMode, ThemeVariant } from "@/types";
import { THEME_VARIANTS, VARIANT_OPTIONS } from "@/types";
import { FONT_PRESETS } from "@/fonts";
import { useI18n } from "@/i18n";

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
}

const MODE_OPTIONS: ThemeMode[] = ["auto", "light", "dark"];

// Discrete presets for the reading-layout dropdowns — a slider was fiddly on
// touch and a number field would pop the keyboard; a small set taps cleanly.
const MARGIN_PRESETS = [0, 8, 16, 24, 32, 48, 64];
const LINE_HEIGHT_PRESETS = [1.4, 1.5, 1.6, 1.7, 1.8, 2.0, 2.2];

/** Snap a stored value (e.g. from the old slider) to the nearest preset, so the
 *  dropdown always shows something selected. */
function nearest(value: number, presets: number[]): number {
  return presets.reduce(
    (a, b) => (Math.abs(b - value) < Math.abs(a - value) ? b : a),
    presets[0] ?? value,
  );
}

interface ThemeColors {
  bg: string;
  fg: string;
  accent: string;
}

function getThemeColors(themeValue: Theme): ThemeColors {
  switch (themeValue) {
    case "light":
      return { bg: "#ffffff", fg: "#1f2328", accent: "#0969da" };
    case "sepia":
      return { bg: "#f4ecd8", fg: "#5b4636", accent: "#9a5b3d" };
    case "dark":
      return { bg: "#0d1117", fg: "#e6edf3", accent: "#58a6ff" };
    case "night":
      return { bg: "#1b1714", fg: "#d6cbbd", accent: "#d9a066" };
  }
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
}: SettingsButtonProps): React.JSX.Element {
  const { t, lang, setLang } = useI18n();
  return (
    <SettingsSheet title={t("settings.title")} wide>
      <Box sx={{ mb: 3 }}>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ fontWeight: 500, mb: 1.5, display: "block" }}
        >
          {t("settings.language")}
        </Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={lang}
          onChange={(_, value: string | null) => {
            if (value === "en" || value === "zh") {
              setLang(value);
            }
          }}
        >
          <ToggleButton value="en">English</ToggleButton>
          <ToggleButton value="zh">中文</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      {/* Palette — a light/dark colour pair (each swatch previews both halves). */}
      <Box sx={{ mb: 3 }}>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ fontWeight: 500, mb: 1.5, display: "block" }}
        >
          {t("settings.palette")}
        </Typography>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "repeat(2, 1fr)",
            gap: 1,
          }}
        >
          {VARIANT_OPTIONS.map((option) => {
            const isSelected = variant === option.value;
            const lightC = getThemeColors(THEME_VARIANTS[option.value].light);
            const darkC = getThemeColors(THEME_VARIANTS[option.value].dark);
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
                  transition: "all 0.15s ease",
                  "&:hover": {
                    borderColor: isSelected ? "primary.main" : "text.secondary",
                  },
                }}
              >
                <Box sx={{ height: 44, display: "flex", position: "relative" }}>
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
                      <CheckIcon sx={{ fontSize: 11, color: "white" }} />
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
      </Box>

      {/* Mode — which half of the pair, or follow the OS. */}
      <Box sx={{ mb: 3 }}>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ fontWeight: 500, mb: 1.5, display: "block" }}
        >
          {t("settings.mode")}
        </Typography>
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
      </Box>

      <Box sx={{ mb: 3 }}>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ fontWeight: 500, mb: 1.5, display: "block" }}
        >
          {t("settings.font")}
        </Typography>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
          {FONT_PRESETS.map((preset) => {
            const isSelected = fontId === preset.id;
            return (
              <Box
                key={preset.id}
                onClick={() => onFontChange(preset.id)}
                sx={{
                  cursor: "pointer",
                  borderRadius: 1,
                  border: 2,
                  borderColor: isSelected ? "primary.main" : "divider",
                  px: 1.5,
                  py: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 1,
                  transition: "border-color 0.15s ease",
                  "&:hover": {
                    borderColor: isSelected ? "primary.main" : "text.secondary",
                  },
                }}
              >
                <Box sx={{ minWidth: 0 }}>
                  {
                    /* Preview rendered in the preset's own font (loads lazily
                        once selected; shows the fallback stack until then). */
                  }
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
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {preset.note}
                  </Typography>
                </Box>
                {isSelected && <CheckIcon fontSize="medium" color="primary" />}
              </Box>
            );
          })}
        </Box>
      </Box>

      <Box sx={{ mb: 3 }}>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ fontWeight: 500, mb: 1.5, display: "block" }}
        >
          {t("settings.reading")}
        </Typography>

        {
          /* Reading margin — left/right padding of the reading column (works on
              mobile, unlike a max-width). A fixed column cap keeps desktop lines
              readable; this just adds side gutter. */
        }
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 1,
            mb: 1.5,
          }}
        >
          <Typography variant="caption" color="text.secondary">
            {t("settings.margin")}
          </Typography>
          <Select
            size="small"
            value={nearest(menuBarSettings.contentMaxWidth, MARGIN_PRESETS)}
            onChange={(e) => onContentMaxWidthChange(Number(e.target.value))}
            sx={{ minWidth: 110 }}
          >
            {MARGIN_PRESETS.map((v) => (
              <MenuItem key={v} value={v}>
                {v === 0 ? t("settings.marginNone") : `${v}px`}
              </MenuItem>
            ))}
          </Select>
        </Box>

        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 1,
          }}
        >
          <Typography variant="caption" color="text.secondary">
            {t("settings.lineHeight")}
          </Typography>
          <Select
            size="small"
            value={nearest(menuBarSettings.lineHeight, LINE_HEIGHT_PRESETS)}
            onChange={(e) => onLineHeightChange(Number(e.target.value))}
            sx={{ minWidth: 110 }}
          >
            {LINE_HEIGHT_PRESETS.map((v) => (
              <MenuItem key={v} value={v}>
                {v.toFixed(1)}
              </MenuItem>
            ))}
          </Select>
        </Box>
      </Box>
    </SettingsSheet>
  );
}
