export function webSocketUrl(
  bundled: boolean,
  remote: string,
  location: Pick<Location, "protocol" | "host">,
): string {
  if (bundled) {
    const backend = new URL(remote);
    backend.protocol = backend.protocol === "https:" ? "wss:" : "ws:";
    backend.pathname = "/ws";
    backend.search = "";
    backend.hash = "";
    return backend.toString();
  }

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}
