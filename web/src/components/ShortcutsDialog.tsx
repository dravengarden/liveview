import { Box, Dialog, DialogContent, DialogTitle, Typography } from "@mui/material";
import {
  SHORTCUTS,
  type ShortcutGroup,
} from "@/hooks/useKeyboardShortcuts";
import { useI18n } from "@/i18n";

const GROUP_ORDER: readonly ShortcutGroup[] = [
  "playback",
  "chapter",
  "speed",
  "general",
];

/** The desktop keyboard-shortcut cheat-sheet — a centred Dialog (NOT the mobile
 *  DetentSheet). Renders the SHORTCUTS source directly, so it never drifts from
 *  the real bindings. Opened by `?` (see useKeyboardShortcuts); desktop-only by
 *  virtue of where it's mounted + the `?` handler being desktop-gated. */
export function ShortcutsDialog(
  { open, onClose }: { open: boolean; onClose: () => void },
): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>{t("shortcut.title")}</DialogTitle>
      <DialogContent sx={{ pb: 3 }}>
        {GROUP_ORDER.map((group) => {
          const rows = SHORTCUTS.filter((s) => s.group === group);
          if (rows.length === 0) return null;
          return (
            <Box key={group} sx={{ mb: 2, "&:last-child": { mb: 0 } }}>
              <Typography
                variant="overline"
                color="text.secondary"
                sx={{ display: "block", mb: 0.5 }}
              >
                {t(`shortcut.group.${group}`)}
              </Typography>
              {rows.map((s) => (
                <Box
                  key={s.id}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 2,
                    py: 0.5,
                  }}
                >
                  <Typography variant="body2">{t(`shortcut.${s.id}`)}</Typography>
                  <Box sx={{ display: "flex", gap: 0.5, flexShrink: 0 }}>
                    {s.keys.map((k, i) => <Kbd key={i}>{k}</Kbd>)}
                  </Box>
                </Box>
              ))}
            </Box>
          );
        })}
      </DialogContent>
    </Dialog>
  );
}

function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Box
      component="kbd"
      sx={{
        px: 0.75,
        py: 0.25,
        minWidth: 24,
        textAlign: "center",
        fontFamily: "inherit",
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1.5,
        color: "text.primary",
        bgcolor: "action.hover",
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        boxShadow: (th) => `0 1px 0 ${th.palette.divider}`,
      }}
    >
      {children}
    </Box>
  );
}
