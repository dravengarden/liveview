import { type RefObject, useRef } from "react";
import { IconButton, InputAdornment, TextField } from "@mui/material";
import {
  Clear as ClearIcon,
  KeyboardHide as KeyboardHideIcon,
  Search as SearchIcon,
} from "@mui/icons-material";
import { useI18n } from "@/i18n";

/**
 * The library's global search field. The native input stays uncontrolled:
 * iOS WebKit owns marked text while a CJK IME composes, and feeding each
 * provisional value back through React would replace that range and freeze
 * the field. Discovery updates only when composition commits.
 */
export function SearchField(
  { inputRef, query, editing, onQuery, onFocusChange, onEscape, onDismiss }: {
    inputRef: RefObject<HTMLInputElement | null>;
    /** The committed query (drives the clear button). */
    query: string;
    /** Phone editing mode: the field owns the toolbar row. */
    editing: boolean;
    onQuery: (query: string) => void;
    onFocusChange: (focused: boolean) => void;
    /** Escape: leave search and filters. */
    onEscape: () => void;
    /** Hide the on-screen keyboard. */
    onDismiss: () => void;
  },
): React.JSX.Element {
  const { t } = useI18n();
  const composingRef = useRef(false);
  const clear = (): void => {
    composingRef.current = false;
    if (inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.focus();
    }
    onQuery("");
  };
  return (
    <TextField
      size="small"
      inputRef={inputRef}
      data-lv-search-field="true"
      defaultValue=""
      onFocus={() => onFocusChange(true)}
      onBlur={() => onFocusChange(false)}
      onKeyDown={(e) => {
        const nativeEvent = e.nativeEvent as KeyboardEvent;
        if (e.key === "Escape" && !nativeEvent.isComposing) {
          e.preventDefault();
          onEscape();
        }
        if (
          e.key === "Enter" && !composingRef.current &&
          !nativeEvent.isComposing
        ) {
          e.preventDefault();
          onDismiss();
        }
      }}
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={(e) => {
        composingRef.current = false;
        onQuery(
          inputRef.current?.value ??
            (e.target as HTMLInputElement).value,
        );
      }}
      onChange={(e) => {
        const nativeEvent = e.nativeEvent as InputEvent;
        if (
          !composingRef.current && !nativeEvent.isComposing
        ) {
          onQuery(e.currentTarget.value);
        }
      }}
      placeholder={t("landing.searchLibrary")}
      aria-label={t("landing.searchLibrary")}
      inputProps={{
        "data-lv-search-input": "true",
        "aria-label": t("landing.searchLibrary"),
        enterKeyHint: "search",
      }}
      InputProps={{
        startAdornment: (
          <InputAdornment position="start">
            <SearchIcon fontSize="medium" />
          </InputAdornment>
        ),
        endAdornment: query || editing
          ? (
            // ui.md §7: no edge="end" (negative margin pins the target to the
            // iOS back-swipe edge); floor to a ≥40px touch target on phones and
            // keep the adornment off the safe-area edge.
            <InputAdornment
              position="end"
              sx={{
                gap: 0.25,
                pr: "max(env(safe-area-inset-right), 8px)",
              }}
            >
              <IconButton
                size="small"
                data-lv-search-clear="true"
                disabled={!query}
                onPointerDown={(e) => e.preventDefault()}
                onClick={clear}
                aria-label={t("landing.searchClear")}
                sx={{
                  width: { xs: 40, lg: 32 },
                  height: { xs: 40, lg: 32 },
                }}
              >
                <ClearIcon fontSize="medium" />
              </IconButton>
              {editing && (
                <IconButton
                  size="small"
                  data-lv-search-dismiss="true"
                  onPointerDown={(e) => {
                    // Perform the blur before this focused-only
                    // control unmounts. onClick remains for keyboard
                    // activation and non-pointer assistive input.
                    e.preventDefault();
                    onDismiss();
                  }}
                  onClick={onDismiss}
                  aria-label={t("landing.searchHideKeyboard")}
                  sx={{ width: 40, height: 40 }}
                >
                  <KeyboardHideIcon fontSize="medium" />
                </IconButton>
              )}
            </InputAdornment>
          )
          : null,
      }}
      sx={{
        flexGrow: 1,
        minWidth: 0,
        flexBasis: 0,
        "& input::placeholder": {
          fontSize: "0.875rem",
          opacity: 0.65,
          color: "text.secondary",
        },
      }}
    />
  );
}
