import { afterEach, describe, expect, it } from "vitest";
import type { FileMeta } from "../api";
import {
  DEFAULT_FILE_SORT,
  FILE_SORT_LABELS,
  FILE_SORTS,
  isFileSort,
  loadFileSort,
  saveFileSort,
  sortFiles,
} from "./fileSort";

const originalStorage = Reflect.get(globalThis, "localStorage");

function file(name: string, overrides: Partial<FileMeta> = {}): FileMeta {
  return {
    id: name,
    name,
    mimeType: "application/octet-stream",
    sizeBytes: 0,
    source: "library",
    hasText: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    folderId: null,
    partiallyIndexed: false,
    aiSummary: null,
    originDestination: "library",
    libraryVisibility: "linked",
    ...overrides,
  };
}

function installStorage(values: Record<string, string | null> = {}): Map<string, string> {
  const entries = new Map(
    Object.entries(values).flatMap(([key, value]) => (value === null ? [] : [[key, value]])),
  );
  Reflect.set(globalThis, "localStorage", {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
  });
  return entries;
}

afterEach(() => {
  if (originalStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
  else Reflect.set(globalThis, "localStorage", originalStorage);
});

describe("fileSort", () => {
  it("recognizes only exposed choices and keeps labels aligned", () => {
    expect(FILE_SORTS).toEqual(["newest", "oldest", "name", "name-desc", "largest"]);
    expect(Object.keys(FILE_SORT_LABELS)).toEqual(FILE_SORTS);
    expect(isFileSort("name")).toBe(true);
    expect(isFileSort("recent")).toBe(false);
    expect(isFileSort(1)).toBe(false);
  });

  it("loads a valid persisted sort and falls back for absent or invalid values", () => {
    installStorage({ prFileSort: "largest" });
    expect(loadFileSort()).toBe("largest");

    installStorage({ prFileSort: "recent" });
    expect(loadFileSort()).toBe(DEFAULT_FILE_SORT);

    installStorage();
    expect(loadFileSort()).toBe(DEFAULT_FILE_SORT);
  });

  it("treats unavailable storage as a default and ignores save failures", () => {
    Reflect.set(globalThis, "localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(loadFileSort()).toBe(DEFAULT_FILE_SORT);
    expect(() => saveFileSort("name")).not.toThrow();
  });

  it("persists the selected order when storage is available", () => {
    const values = installStorage();
    saveFileSort("name-desc");
    expect(values.get("prFileSort")).toBe("name-desc");
  });

  it("sorts each order without mutating its caller and makes ties deterministic", () => {
    const files = [
      file("Chapter 10", { createdAt: "2026-01-01T00:00:00.000Z", sizeBytes: 4 }),
      file("chapter 2", { createdAt: "2026-01-03T00:00:00.000Z", sizeBytes: 7 }),
      file("Alpha", { createdAt: "2026-01-03T00:00:00.000Z", sizeBytes: 7 }),
    ];

    expect(sortFiles(files, "newest").map(({ name }) => name)).toEqual(["Alpha", "chapter 2", "Chapter 10"]);
    expect(sortFiles(files, "oldest").map(({ name }) => name)).toEqual(["Chapter 10", "Alpha", "chapter 2"]);
    expect(sortFiles(files, "name").map(({ name }) => name)).toEqual(["Alpha", "chapter 2", "Chapter 10"]);
    expect(sortFiles(files, "name-desc").map(({ name }) => name)).toEqual(["Chapter 10", "chapter 2", "Alpha"]);
    expect(sortFiles(files, "largest").map(({ name }) => name)).toEqual(["Alpha", "chapter 2", "Chapter 10"]);
    expect(files.map(({ name }) => name)).toEqual(["Chapter 10", "chapter 2", "Alpha"]);
  });
});
