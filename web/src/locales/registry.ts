export const UI_LOCALES = [
  { id: "en", label: "English", htmlLang: "en" },
  { id: "zh", label: "中文", htmlLang: "zh-CN" },
] as const;

/** A locale's string table: key → UI text with `{placeholder}` slots. */
export type Dict = Record<string, string>;

export type Language = (typeof UI_LOCALES)[number]["id"];

export function resolveLocale(value: string | null): Language | undefined {
  if (!value) return undefined;
  const normalized = value.toLocaleLowerCase();
  return UI_LOCALES.find(({ id }) =>
    normalized === id || normalized.startsWith(`${id}-`)
  )?.id;
}

export function localeDescriptor(language: Language) {
  return UI_LOCALES.find(({ id }) => id === language)!;
}
