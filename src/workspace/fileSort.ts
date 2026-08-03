import type { FileMeta } from "../api";

/** How the Library lists a room's files.
 *
 * The list was newest-first and nothing else, which is the right default and
 * the wrong only option: a room with a few hundred files is impossible to keep
 * tidy when the one thing you know about a document — its name — cannot be used
 * to find it. Sorting happens HERE, over the rows already loaded, rather than in
 * SQL: the list is fetched whole for the folder tree and the filter box anyway,
 * so a second round trip would buy nothing and would make the order the sidebar
 * shows depend on a fetch that may not have landed yet.
 */
export type FileSort = "newest" | "oldest" | "name" | "name-desc" | "largest";

/** The order a room opens in. Newest-first is what the app has always shown. */
export const DEFAULT_FILE_SORT: FileSort = "newest";

/** Menu labels — one place, so the control and any future one agree. */
export const FILE_SORT_LABELS: Record<FileSort, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  name: "Name (A–Z)",
  "name-desc": "Name (Z–A)",
  largest: "Largest first",
};

export const FILE_SORTS = Object.keys(FILE_SORT_LABELS) as FileSort[];

/** Device-wide, like the theme: it is about how this person reads a list, not
 * about any one room's contents (a room preference would also mean writing it
 * into the encrypted DB for no gain). */
const KEY = "prFileSort";

export function isFileSort(v: unknown): v is FileSort {
  return typeof v === "string" && (FILE_SORTS as string[]).includes(v);
}

export function loadFileSort(): FileSort {
  try {
    const raw = localStorage.getItem(KEY);
    return isFileSort(raw) ? raw : DEFAULT_FILE_SORT;
  } catch {
    return DEFAULT_FILE_SORT;
  }
}

export function saveFileSort(sort: FileSort): void {
  try {
    localStorage.setItem(KEY, sort);
  } catch {
    /* private mode — the order just resets next launch */
  }
}

/** `files` in the reader's chosen order. Never mutates the caller's array: the
 * same list backs the folder tree, the evidence checkboxes and the counts. */
export function sortFiles<T extends FileMeta>(files: readonly T[], sort: FileSort): T[] {
  const out = [...files];
  // `localeCompare` with numeric collation so "Chapter 2" precedes "Chapter 10"
  // — the order a person reading chapter names expects.
  const byName = (a: T, b: T) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  // createdAt is second-resolution ISO, so files imported together tie. Break
  // by name rather than leaving it to sort stability over an order the backend
  // chose: a list that reshuffles between renders reads as files moving.
  const byNewest = (a: T, b: T) =>
    b.createdAt.localeCompare(a.createdAt) || byName(a, b);
  switch (sort) {
    case "oldest":
      return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || byName(a, b));
    case "name":
      return out.sort(byName);
    case "name-desc":
      return out.sort((a, b) => byName(b, a));
    case "largest":
      return out.sort((a, b) => b.sizeBytes - a.sizeBytes || byName(a, b));
    case "newest":
    default:
      return out.sort(byNewest);
  }
}
