import { createPortal } from "react-dom";
import { Box, Button, IconButton, Stack } from "@mui/material";
import {
  ExpandMore,
  FolderOutlined as FolderIcon,
  DriveFileMove as OrganizeIcon,
} from "@mui/icons-material";
import { BottomSheet } from "@/_shell";
import { useI18n } from "@/i18n";

export interface Ancestor {
  id: string;
  name: string;
}

/**
 * The toolbar's location control. At the root it is a folder icon; inside a
 * folder it shows the folder's name. Either opens the location sheet, which
 * holds the path and the library organizer, so both stay bottom-reachable.
 */
export function LocationButton(
  { name, onOpen }: { name: string | null; onOpen: () => void },
): React.JSX.Element {
  const { t } = useI18n();
  if (name === null) {
    return (
      <IconButton
        data-lv-location
        aria-label={t("landing.location")}
        aria-haspopup="dialog"
        onClick={onOpen}
        sx={{ width: 44, height: 44, flexShrink: 0 }}
      >
        <FolderIcon />
      </IconButton>
    );
  }
  return (
    <Button
      data-lv-location
      data-lv-directory-path
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={`${t("landing.location")}: ${name}`}
      startIcon={<FolderIcon />}
      endIcon={<ExpandMore />}
      sx={{
        // Fills the phone row; beside a search field it stays a label.
        flex: { xs: 1, sm: "0 1 auto" },
        maxWidth: { sm: 320 },
        minWidth: 0,
        minHeight: 44,
        justifyContent: "flex-start",
        textTransform: "none",
        color: "text.primary",
        "& .MuiButton-endIcon": { ml: "auto", pl: 0.5 },
      }}
    >
      <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {name}
      </Box>
    </Button>
  );
}

/** Where you are in the library, every ancestor one tap away, and the
 *  organizer for this level. */
export function LocationSheet(
  { open, onClose, ancestors, navigate, onOrganize }: {
    open: boolean;
    onClose: () => void;
    ancestors: Ancestor[];
    navigate: (id: string | null) => void;
    onOrganize: () => void;
  },
): React.JSX.Element {
  const { t } = useI18n();
  const visit = (id: string | null): void => {
    onClose();
    navigate(id);
  };
  return createPortal(
    <BottomSheet
      open={open}
      onClose={onClose}
      title={t("landing.location")}
      floatingActions={false}
      actions={<Button onClick={onClose}>{t("landing.done")}</Button>}
    >
      <Stack component="nav" aria-label={t("landing.location")} spacing={0.5}>
        <Button
          data-lv-root
          onClick={() => visit(null)}
          aria-current={ancestors.length === 0 ? "page" : undefined}
          sx={{ justifyContent: "flex-start", minHeight: 44 }}
        >
          {t("landing.directories")}
        </Button>
        {ancestors.map((dir, depth) => (
          <Button
            key={dir.id}
            onClick={() => visit(dir.id)}
            aria-current={depth === ancestors.length - 1 ? "page" : undefined}
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
        <Button
          data-lv-organize
          startIcon={<OrganizeIcon />}
          onClick={() => {
            onClose();
            onOrganize();
          }}
          sx={{ justifyContent: "flex-start", minHeight: 44, mt: 1, color: "text.secondary" }}
        >
          {t("landing.organize")}
        </Button>
      </Stack>
    </BottomSheet>,
    document.body,
  );
}
