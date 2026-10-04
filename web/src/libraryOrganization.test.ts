import {
  directoryAncestors,
  directoryPath,
  directoryTree,
  type UserLibrary,
} from "./libraryOrganization.ts";
declare const Deno: { test(name: string, body: () => void): void };
const library: UserLibrary = {
  revision: 4,
  placements: { book: "b" },
  directories: [
    { id: "b", name: "Child", parent: "a" },
    { id: "z", name: "Other", parent: null },
    { id: "a", name: "Learning", parent: null },
  ],
};
Deno.test("hierarchy keeps nested siblings together and breadcrumb IDs stable after rename", () => {
  const actual = directoryTree(library, "en").map((
    { id, depth },
  ) => [id, depth]);
  if (
    JSON.stringify(actual) !== JSON.stringify([["a", 0], ["b", 1], ["z", 0]])
  ) throw new Error("Incorrect tree order");
  const renamed = {
    ...library,
    directories: library.directories.map((dir) =>
      dir.id === "a" ? { ...dir, name: "Study" } : dir
    ),
  };
  if (directoryPath(renamed, "b") !== "Study / Child") {
    throw new Error("Incorrect path");
  }
  if (renamed.placements["book"] !== "b") {
    throw new Error("Rename changed membership");
  }
});
Deno.test("cached malformed ancestors terminate instead of trapping navigation", () => {
  const cyclic = {
    ...library,
    directories: [{ id: "a", name: "A", parent: "b" }, {
      id: "b",
      name: "B",
      parent: "a",
    }],
  };
  if (directoryAncestors(cyclic, "a").length !== 2) {
    throw new Error("Cycle was not bounded");
  }
  if (directoryAncestors(library, "removed").length !== 0) {
    throw new Error("Unknown directory");
  }
});
