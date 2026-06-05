import {
  Typography,
  Box,
  Slider,
  ToggleButton,
  ToggleButtonGroup,
} from "@mui/material";
import { Check as CheckIcon } from "@mui/icons-material";
import { SettingsSheet } from "../_shell";
import type { Theme, ThemeVariant, ThemeMode, MenuBarSettings } from "@/types";
import {
  VARIANT_OPTIONS,
  THEME_VARIANTS,
  CONTENT_WIDTH_MIN,
  CONTENT_WIDTH_MAX,
  CONTENT_WIDTH_STEP,
  LINE_HEIGHT_MIN,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_STEP,
} from "@/types";
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
    <SettingsSheet title={t("settings.title")}>
        <Box sx={{ mb: 3 }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 500, mb: 1.5, display: "block" }}>
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
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 500, mb: 1.5, display: "block" }}>
            {t("settings.palette")}
          </Typography>
          <Box sx={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 1 }}>
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
                    "&:hover": { borderColor: isSelected ? "primary.main" : "text.secondary" },
                  }}
                >
                  <Box sx={{ height: 44, display: "flex", position: "relative" }}>
                    {[lightC, darkC].map((c, i) => (
                      <Box key={i} sx={{ flex: 1, bgcolor: c.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <Box sx={{ width: 18, height: 3, bgcolor: c.accent, borderRadius: 0.5 }} />
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
                    sx={{ display: "block", textAlign: "center", py: 0.5, fontSize: "0.72rem", bgcolor: "background.paper" }}
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
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 500, mb: 1.5, display: "block" }}>
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
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 500, mb: 1.5, display: "block" }}>
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
                    {/* Preview rendered in the preset's own font (loads lazily
                        once selected; shows the fallback stack until then). */}
                    <Typography
                      sx={{ fontFamily: preset.stack, fontSize: "1.05rem", lineHeight: 1.3 }}
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
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 500, mb: 1.5, display: "block" }}>
            {t("settings.reading")}
          </Typography>

          {/* Reading margin — left/right padding of the reading column (works on
              mobile, unlike a max-width). A fixed column cap keeps desktop lines
              readable; this just adds side gutter. */}
          <Box sx={{ px: 1, mb: 2 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5 }}>
              {t("settings.margin")}
            </Typography>
            <Slider
              value={menuBarSettings.contentMaxWidth}
              onChange={(_, value) => onContentMaxWidthChange(value as number)}
              min={CONTENT_WIDTH_MIN}
              max={CONTENT_WIDTH_MAX}
              step={CONTENT_WIDTH_STEP}
              size="small"
              valueLabelDisplay="auto"
              valueLabelFormat={(v) => `${v as number}px`}
            />
          </Box>

          <Box sx={{ px: 1 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5 }}>
              {t("settings.lineHeight")}
            </Typography>
            <Slider
              value={menuBarSettings.lineHeight}
              onChange={(_, value) => onLineHeightChange(value as number)}
              min={LINE_HEIGHT_MIN}
              max={LINE_HEIGHT_MAX}
              step={LINE_HEIGHT_STEP}
              size="small"
              valueLabelDisplay="auto"
              valueLabelFormat={(v) => (v as number).toFixed(1)}
            />
          </Box>
        </Box>
    </SettingsSheet>
  );
}
