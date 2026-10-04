/** User organization is independent of authored collections and content URLs. */
export interface UserDirectory {
  id: string;
  name: string;
  parent: string | null;
}
export interface UserLibrary {
  revision: number;
  directories: UserDirectory[];
  placements: Record<string, string>;
}
export function directoryAncestors(
  library: UserLibrary,
  id: string,
): UserDirectory[] {
  const byId = new Map(library.directories.map((dir) => [dir.id, dir]));
  const trail: UserDirectory[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    trail.unshift(current);
    current = current.parent ? byId.get(current.parent) : undefined;
  }
  return trail;
}
export function directoryPath(library: UserLibrary, id: string): string {
  return directoryAncestors(library, id).map((dir) => dir.name).join(" / ");
}
export function directoryTree(
  library: UserLibrary,
  locale: string,
): Array<UserDirectory & { depth: number; path: string }> {
  const children = new Map<string | null, UserDirectory[]>();
  for (const dir of library.directories) {
    const siblings = children.get(dir.parent) ?? [];
    siblings.push(dir);
    children.set(dir.parent, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => a.name.localeCompare(b.name, locale));
  }
  const result: Array<UserDirectory & { depth: number; path: string }> = [];
  const queue = [...(children.get(null) ?? [])].reverse().map((dir) => ({
    ...dir,
    depth: 0,
    path: dir.name,
  }));
  const seen = new Set<string>();
  while (queue.length) {
    const dir = queue.pop()!;
    if (seen.has(dir.id)) continue;
    seen.add(dir.id);
    result.push(dir);
    queue.push(
      ...[...(children.get(dir.id) ?? [])].reverse().map((child) => ({
        ...child,
        depth: dir.depth + 1,
        path: `${dir.path} / ${child.name}`,
      })),
    );
  }
  return result;
}
