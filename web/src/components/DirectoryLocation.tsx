import { useState } from "react";
import { createPortal } from "react-dom";
import { Box, Button, Stack } from "@mui/material";
import { ChevronRight, ExpandMore } from "@mui/icons-material";
import { BottomSheet } from "@/_shell";
import { useI18n } from "@/i18n";

/** Reachable directory navigation; long paths expand without growing chrome. */
export function DirectoryLocation({ ancestors, navigate }: {
  ancestors: { id: string; name: string }[];
  navigate: (id: string | null) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const visit = (id: string | null) => {
    setOpen(false);
    navigate(id);
  };
  return (
    <>
      <Stack
        component="nav"
        aria-label={t("landing.location")}
        data-lv-directory-location
        direction="row"
        alignItems="center"
        sx={{ minHeight: 44, minWidth: 0 }}
      >
        <Button
          data-lv-root
          onClick={() => visit(null)}
          sx={{ minHeight: 44, flexShrink: 0, color: "text.secondary" }}
        >
          {t("landing.directories")}
        </Button>
        <ChevronRight fontSize="small" color="disabled" />
        <Button
          data-lv-directory-path
          onClick={() => setOpen(true)}
          endIcon={<ExpandMore />}
          aria-haspopup="dialog"
          aria-expanded={open}
          sx={{ minWidth: 0, minHeight: 44, textTransform: "none" }}
        >
          <Box
            component="span"
            sx={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {ancestors.at(-1)?.name ?? t("landing.searchResults")}
          </Box>
        </Button>
      </Stack>
      {createPortal(
        <BottomSheet
          open={open}
          onClose={() => setOpen(false)}
          title={t("landing.location")}
          floatingActions={false}
          actions={
            <Button onClick={() => setOpen(false)}>{t("landing.done")}</Button>
          }
        >
          <Stack
            component="nav"
            aria-label={t("landing.location")}
            spacing={0.5}
          >
            <Button
              onClick={() => visit(null)}
              sx={{ justifyContent: "flex-start", minHeight: 44 }}
            >
              {t("landing.directories")}
            </Button>
            {ancestors.map((dir, depth) => (
              <Button
                key={dir.id}
                onClick={() => visit(dir.id)}
                aria-current={depth === ancestors.length - 1
                  ? "page"
                  : undefined}
                sx={{
                  justifyContent: "flex-start",
                  minHeight: 44,
                  pl: 2 + Math.min(depth, 6),
                  textTransform: "none",
                  overflowWrap: "anywhere",
                }}
              >
                {dir.name}
              </Button>
            ))}
          </Stack>
        </BottomSheet>,
        document.body,
      )}
    </>
  );
}
