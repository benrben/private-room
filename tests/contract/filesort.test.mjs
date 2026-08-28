/* The Library's file order.
 *
 * The list was newest-first and nothing else — no way to ask for it by name,
 * which is the one thing a person usually knows about a document they are
 * hunting for in a room of a few hundred. `sortFiles` is that choice, applied
 * once over the loaded rows so the folder tree, the evidence checkboxes and
 * the counts can never show different orders of the same list.
 *
 * Runs under `npm run test:page` (node --test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");

const SOURCE = readFileSync(join(root, "apps/desktop/src/renderer/workspace/fileSort.ts"), "utf8");
const JS = ts.transpileModule(SOURCE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { sortFiles, isFileSort, FILE_SORTS, FILE_SORT_LABELS, DEFAULT_FILE_SORT } =
  await import(`data:text/javascript;base64,${Buffer.from(JS).toString("base64")}`);

const file = (name, createdAt, sizeBytes) => ({
  id: name,
  name,
  mimeType: "text/plain",
  sizeBytes,
  source: "import",
  hasText: true,
  createdAt,
  folderId: null,
  partiallyIndexed: false,
});

// Two files imported in the SAME second — second-resolution timestamps make
// this the normal case for a multi-file import, not an edge case.
const FILES = [
  file("Chapter 10.md", "2026-01-02T09:00:00Z", 400),
  file("lease.pdf", "2026-03-01T12:00:00Z", 9_000),
  file("Chapter 2.md", "2026-01-02T09:00:00Z", 1_200),
  file("audio.m4a", "2025-12-31T23:59:59Z", 80_000),
];

const names = (sort) => sortFiles(FILES, sort).map((f) => f.name);

test("every order the control offers actually orders the list", () => {
  // The same-second pair ties on time and is broken by name, so the order is
  // stable between renders instead of following whatever the fetch returned.
  assert.deepEqual(names("newest"), [
    "lease.pdf",
    "Chapter 2.md",
    "Chapter 10.md",
    "audio.m4a",
  ]);
  assert.deepEqual(names("oldest"), [
    "audio.m4a",
    "Chapter 2.md",
    "Chapter 10.md",
    "lease.pdf",
  ]);
  // Numeric collation: "Chapter 2" before "Chapter 10", which is what someone
  // reading chapter names means by A–Z.
  assert.deepEqual(names("name"), [
    "audio.m4a",
    "Chapter 2.md",
    "Chapter 10.md",
    "lease.pdf",
  ]);
  assert.deepEqual(names("name-desc"), [
    "lease.pdf",
    "Chapter 10.md",
    "Chapter 2.md",
    "audio.m4a",
  ]);
  assert.deepEqual(names("largest"), [
    "audio.m4a",
    "lease.pdf",
    "Chapter 2.md",
    "Chapter 10.md",
  ]);
  // Every key in the menu is a key the sorter handles.
  for (const k of FILE_SORTS) {
    assert.equal(sortFiles(FILES, k).length, FILES.length, k);
    assert.ok(FILE_SORT_LABELS[k], k);
  }
});

test("the list the caller handed in is never reordered under it", () => {
  const before = FILES.map((f) => f.name);
  sortFiles(FILES, "name");
  assert.deepEqual(
    FILES.map((f) => f.name),
    before,
    "the same array backs the tree, the checkboxes and the counts",
  );
  assert.deepEqual(sortFiles([], "name"), []);
});

test("a stored order that is not one of ours falls back to the old behaviour", () => {
  assert.equal(DEFAULT_FILE_SORT, "newest");
  assert.ok(isFileSort("name"));
  assert.ok(!isFileSort("by-vibes"));
  assert.ok(!isFileSort(null));
  // An unknown key must still produce the app's historical order, not an
  // arbitrary one.
  assert.deepEqual(names("by-vibes"), names("newest"));
});

test("the sidebar sorts the one list every file surface reads", () => {
  const sidebar = readFileSync(join(root, "apps/desktop/src/renderer/workspace/Sidebar.tsx"), "utf8");
  // Home's population is now `libraryFiles(s.files)` rather than `s.files` —
  // a section-only object is a full room file that Home simply does not list.
  // The invariant this test exists for is unchanged: ONE sorted list feeds the
  // folder tree, the AI-sources checkboxes and the count badge, so the three
  // can never disagree about the order the reader chose.
  assert.match(
    sidebar,
    /const shownFiles = sortFiles\(libraryFiles\(s\.files\)\.filter\(matchesFilter\), s\.fileSort\)/,
  );
  assert.match(sidebar, /aria-label="Sort files"/, "the control must exist");
  assert.match(sidebar, /s\.setFileSort\(/, "…and be wired to the setter");
  const state = readFileSync(join(root, "apps/desktop/src/renderer/workspace/state.ts"), "utf8");
  assert.match(state, /saveFileSort\(next\)/, "the choice must be remembered");
  assert.match(state, /fileSort, setFileSort,/, "…and exposed on the state");
});
