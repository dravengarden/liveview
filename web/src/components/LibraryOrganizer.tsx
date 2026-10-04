import { Box, Button, Stack, Typography } from "@mui/material";
import { FolderOutlined as FolderIcon } from "@mui/icons-material";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BottomSheet } from "@/_shell";
import { useI18n } from "@/i18n";
import {
  directoryPath,
  type UserDirectory,
  type UserLibrary,
} from "@/libraryOrganization";
import type { LibraryOperation } from "@/userLibrary";
import type { Book } from "@/types";

interface Props {
  library: UserLibrary | null;
  libraryError: string;
  libraryBusy: boolean;
  changeLibrary: (operations: LibraryOperation[]) => Promise<boolean>;
  undoLibrary: (() => Promise<boolean>) | null;
  selectedDirectory: string | null;
  currentDirectory: UserDirectory | undefined;
  directories: UserDirectory[];
  listEntries: Array<{ book: Book }>;
}
/** Own editing state so opening or selecting never re-renders the shelf. */
export function LibraryOrganizer(
  {
    library,
    libraryError,
    libraryBusy,
    changeLibrary,
    undoLibrary,
    selectedDirectory,
    currentDirectory,
    directories,
    listEntries,
  }: Props,
): ReactNode {
  const { t } = useI18n();
  const [visibleLimit, setVisibleLimit] = useState(40);
  const organizeBodyRef = useRef<ReactNode>(null);
  const directoryNameInput = useRef<HTMLInputElement>(null);
  const organizeInputsRef = useRef<unknown[]>([]);
  const prepareClosedBody = useRef(false);
  const [, advancePreparation] = useState(0);
  const [organizeOpen, setOrganizeOpen] = useState(false);
  const [directoryName, setDirectoryName] = useState("");
  const [moveTarget, setMoveTarget] = useState("");
  const [selectedBooks, setSelectedBooks] = useState<string[]>([]);
  // Retain sheet geometry and its closed body. Directory navigation must not
  // reconcile hidden selection controls on each shelf transition.
  const organizeInputs = [
    library,
    libraryBusy,
    libraryError,
    directoryName,
    moveTarget,
    selectedBooks,
    currentDirectory,
    listEntries,
    visibleLimit,
    t,
    !!undoLibrary,
  ];
  if (
    organizeBodyRef.current === null ||
    ((organizeOpen || prepareClosedBody.current) &&
      organizeInputs.some((value, index) =>
        !Object.is(value, organizeInputsRef.current[index])
      ))
  ) {
    prepareClosedBody.current = false;
    organizeInputsRef.current = organizeInputs;
    organizeBodyRef.current = (
      <Stack spacing={2} sx={{ p: 2 }}>
        <Typography variant="body2" color="text.secondary">
          {currentDirectory && library
            ? directoryPath(library, currentDirectory.id)
            : t("landing.directories")}
        </Typography>
        {undoLibrary && (
          <Button disableRipple disabled={libraryBusy} onClick={undoLibrary}>
            {t("landing.undoOrganization")}
          </Button>
        )}
        {!library && (
          <Typography>{t("landing.organizationUnavailable")}</Typography>
        )}
        {libraryError && (
          <Typography role="alert" color="error">{libraryError}</Typography>
        )}
        <Box
          component="label"
          htmlFor="lv-directory-name"
          sx={{ display: "grid", gap: 0.75 }}
        >
          <Typography variant="body2">{t("landing.directoryName")}</Typography>
          <Box
            component="input"
            id="lv-directory-name"
            ref={directoryNameInput}
            defaultValue={directoryName}
            onChange={(event) => setDirectoryName(event.target.value)}
            sx={{
              minHeight: 44,
              p: 1.25,
              border: 1,
              borderColor: "divider",
              borderRadius: "14px",
              bgcolor: "background.paper",
              color: "text.primary",
              font: "inherit",
              width: "100%",
              minWidth: 0,
              boxSizing: "border-box",
            }}
          />
        </Box>
        <Stack direction="row" gap={1}>
          <Button
            disableRipple
            disabled={!library || libraryBusy || !directoryName.trim()}
            onClick={async () => {
              if (
                await changeLibrary([{
                  op: "create",
                  id: crypto.randomUUID(),
                  name: directoryName,
                  parent: selectedDirectory,
                }])
              ) {
                setDirectoryName("");
                if (directoryNameInput.current) {
                  directoryNameInput.current.value = "";
                }
              }
            }}
          >
            {t("landing.newDirectory")}
          </Button>
          {currentDirectory && (
            <Button
              disableRipple
              disabled={!library || libraryBusy || !directoryName.trim()}
              onClick={() =>
                changeLibrary([{
                  op: "rename",
                  id: currentDirectory.id,
                  name: directoryName,
                }])}
            >
              {t("landing.renameDirectory")}
            </Button>
          )}
        </Stack>
        <Box
          component="label"
          htmlFor="lv-directory-destination"
          sx={{ display: "grid", gap: 0.75 }}
        >
          <Typography variant="body2">{t("landing.moveTo")}</Typography>
          <Box
            component="select"
            id="lv-directory-destination"
            value={moveTarget}
            onChange={(event) => setMoveTarget(event.target.value)}
            sx={{
              minHeight: 44,
              p: 1.25,
              border: 1,
              borderColor: "divider",
              borderRadius: "14px",
              bgcolor: "background.paper",
              color: "text.primary",
              font: "inherit",
              width: "100%",
              minWidth: 0,
            }}
          >
            <option value="">{t("landing.directories")}</option>
            {directories.map((dir) => (
              <option key={dir.id} value={dir.id}>
                {library ? directoryPath(library, dir.id) : dir.name}
              </option>
            ))}
          </Box>
        </Box>
        {currentDirectory && (
          <Stack direction="row" gap={1}>
            <Button
              disableRipple
              disabled={!library || libraryBusy}
              onClick={() =>
                changeLibrary([{
                  op: "move_directory",
                  id: currentDirectory.id,
                  parent: moveTarget || null,
                }])}
            >
              {t("landing.moveDirectory")}
            </Button>
            <Button
              disableRipple
              disabled={!library || libraryBusy}
              color="error"
              onClick={() =>
                changeLibrary([{ op: "delete", id: currentDirectory.id }])}
            >
              {t("landing.removeDirectory")}
            </Button>
          </Stack>
        )}
        <Typography variant="body2" color="text.secondary">
          {t("landing.removeDirectoryHint")}
        </Typography>
        <Typography fontWeight={650}>
          {t("landing.moveContent", { n: selectedBooks.length })}
        </Typography>
        <Button
          disableRipple
          disabled={!library || libraryBusy || selectedBooks.length === 0}
          onClick={async () => {
            if (
              await changeLibrary(
                selectedBooks.map((slug) => ({
                  op: "place",
                  slug,
                  directory: moveTarget || null,
                })),
              )
            ) setSelectedBooks([]);
          }}
        >
          {t("landing.moveSelected")}
        </Button>
        <Button
          disableRipple
          onClick={() =>
            setSelectedBooks(listEntries.map((entry) => entry.book.slug))}
        >
          {t("landing.selectAll")}
        </Button>
        {listEntries.slice(0, visibleLimit).map((entry) => (
          <Box
            component="label"
            key={entry.book.slug}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1.5,
              minHeight: 44,
              cursor: "pointer",
              color: "text.primary",
              "& input": {
                width: 20,
                height: 20,
                flexShrink: 0,
                accentColor: "currentColor",
              },
            }}
          >
            <input
              type="checkbox"
              checked={selectedBooks.includes(entry.book.slug)}
              onChange={(event) =>
                setSelectedBooks((slugs) =>
                  event.target.checked
                    ? [...slugs, entry.book.slug]
                    : slugs.filter((slug) => slug !== entry.book.slug)
                )}
            />
            <Typography variant="body2">{entry.book.label}</Typography>
          </Box>
        ))}
        {listEntries.length > visibleLimit && (
          <Button
            disableRipple
            onClick={() => setVisibleLimit((limit) => limit + 40)}
          >
            {t("landing.loadMore", { n: listEntries.length - visibleLimit })}
          </Button>
        )}
      </Stack>
    );
  }

  // Prepare a changed scope after navigation has painted, so the next open
  // reuses its geometry instead of mounting selection rows on the tap frame.
  useEffect(() => {
    if (
      organizeOpen ||
      !organizeInputs.some((value, index) =>
        !Object.is(value, organizeInputsRef.current[index])
      )
    ) return;
    const timer = globalThis.setTimeout(() => {
      prepareClosedBody.current = true;
      advancePreparation((version) => version + 1);
    }, 100);
    return () => globalThis.clearTimeout(timer);
  }, [
    organizeOpen,
    library,
    libraryBusy,
    libraryError,
    currentDirectory,
    listEntries,
    t,
  ]);

  return (
    <>
      <Button
        startIcon={<FolderIcon fontSize="small" />}
        sx={{
          minHeight: 44,
          textTransform: "none",
          whiteSpace: "nowrap",
          flex: { xs: 1, sm: "0 0 auto" },
        }}
        data-lv-organize
        aria-label={t("landing.organize")}
        onClick={() => {
          setOrganizeOpen(true);
          setDirectoryName("");
          if (directoryNameInput.current) directoryNameInput.current.value = "";
          setMoveTarget(currentDirectory?.parent ?? "");
        }}
      >
        {t("landing.organizeAction")}
      </Button>
      {createPortal(
        <BottomSheet
          open={organizeOpen}
          keepMounted
          onClose={() => setOrganizeOpen(false)}
          title={t("landing.organize")}
          wide
          floatingActions={false}
          actions={
            <Button disableRipple onClick={() => setOrganizeOpen(false)}>
              {t("landing.done")}
            </Button>
          }
        >
          {organizeBodyRef.current}
        </BottomSheet>,
        document.body,
      )}
    </>
  );
}
