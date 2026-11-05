import { useState } from "react";
import {
  Box,
  Button,
  Chip,
  Collapse,
  FormControlLabel,
  Radio,
  RadioGroup,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { ExpandMore as ExpandMoreIcon } from "@mui/icons-material";
import { BottomSheet } from "@/_shell";
import { setShelfSort, type ShelfSort } from "@/hooks";
import { useI18n } from "@/i18n";
import {
  facetStartsFolded,
  type LibraryTaxonomy,
  type ReadingFilter,
  tagLabel,
} from "@/libraryDiscovery";
import type { FilterKind } from "./discovery.ts";

/** Bookshelf sort options, in display order. */
const SHELF_SORTS: ShelfSort[] = ["updated", "read", "added", "name"];

export const FILTER_KIND_LABEL: Record<Exclude<FilterKind, "all">, string> = {
  book: "landing.filterBooks",
  docs: "landing.filterDocs",
};

/** Sort & filter: both shelf-organizing controls in one surface. */
export function SortFilterSheet(
  {
    open,
    onClose,
    taxonomy,
    selectedTags,
    tagById,
    tagCounts,
    onToggleTag,
    reading,
    onReading,
    sort,
    kind,
    onKind,
    showKindFilter,
    activeFilterCount,
    onClear,
    resultCount,
  }: {
    open: boolean;
    onClose: () => void;
    taxonomy: LibraryTaxonomy;
    selectedTags: ReadonlySet<string>;
    tagById: ReadonlyMap<string, { label: string }>;
    tagCounts: ReadonlyMap<string, number>;
    onToggleTag: (id: string) => void;
    reading: ReadingFilter;
    onReading: (value: ReadingFilter) => void;
    sort: ShelfSort;
    kind: FilterKind;
    onKind: (value: FilterKind) => void;
    /** The kind segments only make sense when the shelf has both books and docs. */
    showKindFilter: boolean;
    activeFilterCount: number;
    onClear: () => void;
    resultCount: number;
  },
): React.JSX.Element {
  const { t } = useI18n();
  // Explicit fold choices per facet; absent facets use `facetStartsFolded`.
  const [facetOpen, setFacetOpen] = useState<Record<string, boolean>>({});
  const libraryTaxonomy = taxonomy;
  return (
      <BottomSheet
        open={open}
        onClose={onClose}
        title={t("landing.sortFilter")}
        wide
        // This catalog can contain thousands of facet chips. Keep its actions
        // in a real footer so they never obscure the choices being reviewed.
        floatingActions={false}
        actions={
          <>
            <Button
              onClick={onClear}
              disabled={activeFilterCount === 0}
            >
              {t("landing.clearFilters")}
            </Button>
            <Button
              variant="contained"
              onClick={onClose}
            >
              {t("landing.showResults", { n: resultCount })}
            </Button>
          </>
        }
      >
        <Stack spacing={3} sx={{ pb: 1 }}>
          {selectedTags.size > 0 && (
            <Stack spacing={1}>
              <Typography variant="overline" color="text.secondary">
                {t("landing.selectedFilters")}
              </Typography>
              <Stack direction="row" useFlexGap flexWrap="wrap" gap={0.75}>
                {[...selectedTags].map((id) => {
                  const tag = tagById.get(id);
                  return (
                    <Chip
                      key={id}
                      label={tag?.label ?? tagLabel(id)}
                      color="primary"
                      onDelete={() => onToggleTag(id)}
                    />
                  );
                })}
              </Stack>
            </Stack>
          )}
          {libraryTaxonomy.facets.map((facet) => {
            const facetTags = libraryTaxonomy.tags.filter((tag) =>
              tag.facet === facet.id
            );
            const selectedInFacet = facetTags.filter((tag) =>
              selectedTags.has(tag.id)
            ).length;
            const open = facetOpen[facet.id] ??
              !facetStartsFolded(facetTags.length);
            return (
              <Stack key={facet.id} spacing={1}>
                <Box
                  component="button"
                  type="button"
                  aria-expanded={open}
                  onClick={() =>
                    setFacetOpen((current) => ({
                      ...current,
                      [facet.id]: !open,
                    }))}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    width: "100%",
                    minHeight: 40,
                    p: 0,
                    border: 0,
                    bgcolor: "transparent",
                    color: "text.secondary",
                    font: "inherit",
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  <Typography variant="overline" sx={{ flex: 1, minWidth: 0 }}>
                    {facet.id === "tags" ? t("landing.tags") : facet.label}
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {selectedInFacet > 0
                      ? t("landing.facetSelected", {
                        n: selectedInFacet,
                        total: facetTags.length,
                      })
                      : facetTags.length}
                  </Typography>
                  <ExpandMoreIcon
                    fontSize="small"
                    sx={{
                      transition: "transform .2s",
                      transform: open ? "rotate(180deg)" : "none",
                    }}
                  />
                </Box>
                {
                  /* Folded facets don't mount their chips: a catalog-wide
                    facet can hold hundreds of them. */
                }
                <Collapse in={open} timeout={180} unmountOnExit>
                  <Stack direction="row" useFlexGap flexWrap="wrap" gap={0.75}>
                    {facetTags.map((tag) => {
                      const selected = selectedTags.has(tag.id);
                      const count = tagCounts.get(tag.id) ?? 0;
                      return (
                        <Chip
                          key={tag.id}
                          label={`${tag.label} · ${count}`}
                          color={selected ? "primary" : "default"}
                          variant={selected ? "filled" : "outlined"}
                          disabled={!selected && count === 0}
                          onClick={() => onToggleTag(tag.id)}
                          sx={{ minHeight: 40 }}
                        />
                      );
                    })}
                  </Stack>
                </Collapse>
              </Stack>
            );
          })}
          <Stack spacing={1}>
            <Typography variant="overline" color="text.secondary">
              {t("landing.readingState")}
            </Typography>
            <ToggleButtonGroup
              exclusive
              fullWidth
              size="small"
              value={reading}
              onChange={(_e, value: ReadingFilter | null) =>
                value && onReading(value)}
            >
              {(["all", "unread", "progress", "finished"] as const).map((
                value,
              ) => (
                <ToggleButton key={value} value={value}>
                  {t(`reading.${value}`)}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Stack>
          <Stack spacing={0.5}>
            <Typography variant="overline" color="text.secondary">
              {t("landing.sortBy")}
            </Typography>
            <RadioGroup
              value={sort}
              onChange={(e) => setShelfSort(e.target.value as ShelfSort)}
            >
              {SHELF_SORTS.map((s) => (
                <FormControlLabel
                  key={s}
                  value={s}
                  control={<Radio />}
                  label={t(`sort.${s}`)}
                />
              ))}
            </RadioGroup>
          </Stack>
          {showKindFilter && (
            <Stack spacing={1}>
              <Typography variant="overline" color="text.secondary">
                {t("landing.kind")}
              </Typography>
              <ToggleButtonGroup
                exclusive
                fullWidth
                size="small"
                value={kind}
                onChange={(_e, v: FilterKind | null) => v && onKind(v)}
                aria-label={t("landing.filter")}
              >
                <ToggleButton value="all">{t("landing.kindAll")}</ToggleButton>
                <ToggleButton value="book">
                  {t(FILTER_KIND_LABEL.book)}
                </ToggleButton>
                <ToggleButton value="docs">
                  {t(FILTER_KIND_LABEL.docs)}
                </ToggleButton>
              </ToggleButtonGroup>
            </Stack>
          )}
        </Stack>
      </BottomSheet>
  );
}
