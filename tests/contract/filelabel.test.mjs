/* File naming in the library and the tab strip.
 *
 * `displayName` drops the extension because "Quarterly plan" reads better than
 * "Quarterly plan.docx". That is right until two files differ ONLY in the
 * extension: live QA imported `file-sample_1MB.doc` and `file-sample_1MB.docx`
 * and got two library rows both saying "file-sample 1MB", plus two tabs both
 * truncated to "file e…". Nothing on screen told them apart, and opening the
 * wrong one is a real mistake to make when one of them is about to be edited.
 *
 * Runs against the REAL TypeScript source, type-stripped in memory — the same
 * trick viewerparse.test.mjs uses, so there is no compiled copy to drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTypescriptModule } from "../support/source-modules.mjs";

const { displayName, fileLabel, ambiguousDisplayNames } = await import(
  loadTypescriptModule("apps/desktop/src/renderer/workspace/composer.ts"),
);

const files = (...names) => names.map((name) => ({ name }));

test("a name that is unique keeps its tidy form", () => {
  const list = files("Quarterly plan.docx", "Budget.xlsx");
  assert.equal(fileLabel("Quarterly plan.docx", list), "Quarterly plan");
  assert.equal(fileLabel("Budget.xlsx", list), "Budget");
});

test("two files differing only in extension both show the extension", () => {
  // The exact pair live QA could not tell apart.
  const list = files("file-sample_1MB.doc", "file-sample_1MB.docx");
  assert.equal(fileLabel("file-sample_1MB.doc", list), "file-sample_1MB.doc");
  assert.equal(fileLabel("file-sample_1MB.docx", list), "file-sample_1MB.docx");
});

test("only the ambiguous names lose their tidy form", () => {
  const list = files("report.doc", "report.docx", "Notes.md");
  assert.equal(fileLabel("Notes.md", list), "Notes");
  assert.equal(fileLabel("report.doc", list), "report.doc");
});

test("the clash is judged on the DISPLAY name, underscores and all", () => {
  // displayName turns "_" into " ", so these two collide even though their
  // raw names never do — which is exactly how the QA pair collided.
  const list = files("my_notes.md", "my notes.txt");
  assert.equal(displayName("my_notes.md"), "my notes");
  assert.equal(fileLabel("my_notes.md", list), "my_notes.md");
  assert.equal(fileLabel("my notes.txt", list), "my notes.txt");
});

test("the clash is case-insensitive, because the eye is too", () => {
  const list = files("Report.doc", "report.docx");
  assert.equal(fileLabel("Report.doc", list), "Report.doc");
  assert.equal(fileLabel("report.docx", list), "report.docx");
});

test("three-way clashes all disambiguate", () => {
  const list = files("data.csv", "data.xlsx", "data.json");
  for (const f of list) assert.equal(fileLabel(f.name, list), f.name);
});

test("the ambiguity set is memoized on array identity, not rebuilt per row", () => {
  // Every file row asks; rebuilding the set each time would be quadratic in
  // the size of the library.
  const list = files("a.doc", "a.docx");
  const first = ambiguousDisplayNames(list);
  assert.equal(ambiguousDisplayNames(list), first, "same array returned a new set");
  const other = ambiguousDisplayNames(files("b.md"));
  assert.notEqual(other, first, "a different array reused the cached set");
  assert.equal(other.size, 0);
});

test("a new list replaces the answer rather than adding to it", () => {
  // The cache must not let a clash from a previous room survive into this one.
  const clashing = files("x.doc", "x.docx");
  assert.equal(fileLabel("x.doc", clashing), "x.doc");
  const clean = files("x.doc");
  assert.equal(fileLabel("x.doc", clean), "x");
});

test("an extensionless name is left alone", () => {
  const list = files("README", "README.md");
  // displayName keeps a dotless name whole, so these two DO collide.
  assert.equal(fileLabel("README", list), "README");
  assert.equal(fileLabel("README.md", list), "README.md");
});
