import {
  Typography,
  Box,
  Slider,
  ToggleButton,
  ToggleButtonGroup,
} from "@mui/material";
import { Check as CheckIcon } from "@mui/icons-material";
import { SettingsSheet } from "../_shell";
import type { Theme, MenuBarSettings } from "@/types";
import {
  THEME_OPTIONS,
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
  theme: Theme;
  fontId: string;
  menuBarSettings: MenuBarSettings;
  onThemeChange: (theme: Theme) => void;
  onFontChange: (id: string) => void;
  onContentMaxWidthChange: (width: number) => void;
  onLineHeightChange: (lh: number) => void;
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
  theme,
  menuBarSettings,
  fontId,
  onThemeChange,
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

        <Box sx={{ mb: 3 }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 500, mb: 1.5, display: "block" }}>
            {t("settings.theme")}
          </Typography>
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "repeat(5, 1fr)",
              gap: 1,
            }}
          >
            {THEME_OPTIONS.map((option) => {
              const colors = getThemeColors(option.value);
              const isSelected = theme === option.value;
              return (
                <Box
                  key={option.value}
                  onClick={() => onThemeChange(option.value)}
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
                  <Box
                    sx={{
                      height: 40,
                      bgcolor: colors.bg,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      position: "relative",
                    }}
                  >
                    <Box
                      sx={{
                        width: 20,
                        height: 3,
                        bgcolor: colors.accent,
                        borderRadius: 0.5,
                        mb: 0.5,
                      }}
                    />
                    <Box
                      sx={{
                        position: "absolute",
                        bottom: 4,
                        left: "50%",
                        transform: "translateX(-50%)",
                        width: 24,
                        height: 2,
                        bgcolor: colors.fg,
                        borderRadius: 0.5,
                        opacity: 0.5,
                      }}
                    />
                    {isSelected && (
                      <Box
                        sx={{
                          position: "absolute",
                          top: 2,
                          right: 2,
                          width: 14,
                          height: 14,
                          borderRadius: "50%",
                          bgcolor: "primary.main",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <CheckIcon sx={{ fontSize: 10, color: "white" }} />
                      </Box>
                    )}
                  </Box>
                  <Typography
                    variant="caption"
                    sx={{
                      display: "block",
                      textAlign: "center",
                      py: 0.5,
                      px: 0.25,
                      fontSize: "0.65rem",
                      lineHeight: 1.2,
                      bgcolor: "background.paper",
                    }}
                  >
                    {option.label}
                  </Typography>
                </Box>
              );
            })}
          </Box>
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

          {/* Content width — Smaller = bigger left/right margin. The bottom
              of the slider snaps to "Full width" (0) so users can opt out of
              any max-width and let prose span the viewport. */}
          <Box sx={{ px: 1, mb: 2 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5 }}>
              {t("settings.contentWidth")}
            </Typography>
            <Slider
              value={menuBarSettings.contentMaxWidth || CONTENT_WIDTH_MIN}
              onChange={(_, value) => {
                const v = value as number;
                // Snap to "full width" (0) when the user drags past the max.
                onContentMaxWidthChange(v >= CONTENT_WIDTH_MAX ? 0 : v);
              }}
              min={CONTENT_WIDTH_MIN}
              max={CONTENT_WIDTH_MAX}
              step={CONTENT_WIDTH_STEP}
              size="small"
              valueLabelDisplay="auto"
              valueLabelFormat={(v) =>
                v >= CONTENT_WIDTH_MAX ? t("settings.contentWidthFull") : `${v}px`
              }
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
