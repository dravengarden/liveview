import {
  Dialog,
  DialogTitle,
  DialogContent,
  IconButton,
  Typography,
  Box,
  Slider,
  Chip,
  Button,
} from "@mui/material";
import { Close as CloseIcon, Check as CheckIcon } from "@mui/icons-material";
import type { Theme, MenuBarSettings, ExtensionSettings } from "@/types";
import { THEME_OPTIONS, EXTENSION_GROUPS } from "@/types";

interface SettingsDialogProps {
  open: boolean;
  theme: Theme;
  menuBarSettings: MenuBarSettings;
  extensionSettings: ExtensionSettings;
  onClose: () => void;
  onThemeChange: (theme: Theme) => void;
  onFloatOpacityChange: (opacity: number) => void;
  onToggleExtensionGroup: (groupName: string) => void;
  onEnableAllExtensions: () => void;
  onDisableAllExtensions: () => void;
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
    case "dark":
      return { bg: "#0d1117", fg: "#e6edf3", accent: "#58a6ff" };
    case "solarized-light":
      return { bg: "#fdf6e3", fg: "#657b83", accent: "#268bd2" };
    case "solarized-dark":
      return { bg: "#002b36", fg: "#839496", accent: "#268bd2" };
    case "dracula":
      return { bg: "#282a36", fg: "#f8f8f2", accent: "#bd93f9" };
    case "nord":
      return { bg: "#2e3440", fg: "#eceff4", accent: "#88c0d0" };
    case "monokai":
      return { bg: "#272822", fg: "#f8f8f2", accent: "#fd971f" };
    case "one-dark":
      return { bg: "#282c34", fg: "#abb2bf", accent: "#61afef" };
    case "gruvbox-light":
      return { bg: "#fbf1c7", fg: "#3c3836", accent: "#d65d0e" };
    case "gruvbox-dark":
      return { bg: "#282828", fg: "#ebdbb2", accent: "#d65d0e" };
  }
}

export function SettingsDialog({
  open,
  theme,
  menuBarSettings,
  extensionSettings,
  onClose,
  onThemeChange,
  onFloatOpacityChange,
  onToggleExtensionGroup,
  onEnableAllExtensions,
  onDisableAllExtensions,
}: SettingsDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        Settings
        <IconButton size="small" onClick={onClose} edge="end">
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ p: 2 }}>
        <Box sx={{ mb: 3 }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 500, mb: 1.5, display: "block" }}>
            THEME
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
          <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1.5 }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 500 }}>
              FILE TYPES
            </Typography>
            <Box sx={{ display: "flex", gap: 0.5 }}>
              <Button size="small" onClick={onEnableAllExtensions} sx={{ minWidth: 0, px: 1, fontSize: "0.7rem" }}>
                All
              </Button>
              <Button size="small" onClick={onDisableAllExtensions} sx={{ minWidth: 0, px: 1, fontSize: "0.7rem" }}>
                None
              </Button>
            </Box>
          </Box>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
            {EXTENSION_GROUPS.map((group) => {
              const isEnabled = extensionSettings.enabledGroups.includes(group.name);
              return (
                <Chip
                  key={group.name}
                  label={group.name}
                  size="small"
                  onClick={() => onToggleExtensionGroup(group.name)}
                  color={isEnabled ? "primary" : "default"}
                  variant={isEnabled ? "filled" : "outlined"}
                  sx={{
                    transition: "all 0.15s ease",
                    cursor: "pointer",
                  }}
                />
              );
            })}
          </Box>
        </Box>

        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 500, mb: 1, display: "block" }}>
            MENU BAR OPACITY
          </Typography>
          <Box sx={{ px: 1 }}>
            <Slider
              value={menuBarSettings.floatOpacity}
              onChange={(_, value) => onFloatOpacityChange(value as number)}
              min={0.1}
              max={1}
              step={0.1}
              size="small"
              valueLabelDisplay="auto"
              valueLabelFormat={(v) => `${Math.round(v * 100)}%`}
            />
          </Box>
        </Box>
      </DialogContent>
    </Dialog>
  );
}
