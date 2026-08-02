export function otaReloadUrl(href: string, version: string): string {
  const next = new URL(href);
  next.searchParams.set("lv-ota", version);
  return next.href;
}
