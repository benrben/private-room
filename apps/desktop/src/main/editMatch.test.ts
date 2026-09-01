/**
 * Vitest port of `src-tauri/src/commands/edit_match.rs`'s own `mod tests` —
 * every test in that module is ported here (same fixtures, same assertions)
 * except the five that exercise `fuzzy_find` directly, which live in
 * `editMatchFuzzy.test.ts` alongside the module that owns it.
 *
 * FIXTURE ROOMS: a real `.roomai` file via `createRoom`
 * (better-sqlite3-multiple-ciphers), matching `db-host/files.test.ts`'s own
 * established convention — no bare mocks. `db::open_in_memory_schema()` (the
 * Rust tests' fixture) has no port in this batch, so `freshRoom()` stands in
 * for it the way `files.test.ts` already does. `db::list_file_versions` has no
 * port either (`db-host/versions.ts` deliberately stops short of the History
 * strip's read surface), so a local helper reads `file_versions` back with raw
 * SQL — the same stand-in convention `files.test.ts`'s header documents.
 *
 * Coverage this port adds beyond the Rust suite — including regressions for
 * three real defects found while merging two independent candidate ports — is
 * grouped in its own block at the end.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it } from "vitest";
import { createRoom } from "./db-host/open.js";
import { findFileLikeFull, getFileBytes, getFileName, insertFile } from "./db-host/files.js";
import { searchChunksFtsRanked } from "./db-host/embeddings.js";
import { buildZip } from "./editMatchZip.js";
import {
  EditError,
  MAX_BATCH_EDITS,
  MAX_FUZZY_BYTES,
  PREVIEW_CLIP,
  commitPlans,
  computeEdit,
  computeEditBytes,
  countBatchOps,
  extractText,
  parseBatchOps,
  planBatch,
  planBatchWorkspace,
  planSetCells,
  planSetCellsWorkspace,
  planSingleEdit,
  planSingleEditWorkspace,
  planWriteFile,
  planWriteFileWorkspace,
  runEditFile,
  runEditFileRefined,
  runEditFiles,
  type BatchOp,
  type PreviewEdit,
} from "./editMatch.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "edit-match-"));
  const roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

/** Matches the Rust test module's own `seed_text_file`. */
function seedTextFile(db: Database.Database, name: string, content: string): string {
  return insertFile(db, name, "text/plain", Buffer.from(content, "utf8"), content, "upload").id;
}

function currentBytes(db: Database.Database, id: string): Buffer {
  const b = getFileBytes(db, id);
  if (b === null) {
    throw new Error("file has no bytes");
  }
  return b;
}

function currentText(db: Database.Database, id: string): string {
  return currentBytes(db, id).toString("utf8");
}

/** Stand-in for `db::list_file_versions` — see this file's own module doc. */
function listFileVersions(db: Database.Database, fileId: string): Array<{ cause: string }> {
  return db
    .prepare("SELECT cause FROM file_versions WHERE file_id = ? ORDER BY saved_at DESC, rowid DESC")
    .all(fileId) as Array<{ cause: string }>;
}

/** The JS analogue of `crate::extraction::fake_office_zip`. */
function fakeOfficeZip(entry: string, xml: string): Buffer {
  return buildZip([{ name: entry, data: Buffer.from(xml, "utf8") }]);
}

function expectEditError(fn: () => unknown): EditError {
  try {
    fn();
  } catch (e) {
    if (e instanceof EditError) {
      return e;
    }
    throw e;
  }
  throw new Error("expected an EditError to be thrown");
}

function expectPlainError(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    if (e instanceof Error) {
      return e;
    }
    throw e;
  }
  throw new Error("expected an Error to be thrown");
}

function dbWithPrepareFailure(
  db: Database.Database,
  blocked: (sql: string) => boolean,
): Database.Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          if (blocked(sql)) throw new Error("storage unavailable");
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Database.Database;
}

// ------------------------------------------------------------------ single edit

describe("edit_match — single edit (ported from edit_match.rs::tests)", () => {
  it("exact multi-occurrence errors without all, and replaces with all", () => {
    const db = freshRoom();
    const id = seedTextFile(db, "notes.md", "cost is 5. cost is 5. done.");
    // Without `all`, a doubly-present exact needle errors (no write).
    const err = expectEditError(() => runEditFile(db, "notes.md", "cost is 5", "cost is 7", false));
    expect(err.outcome).toBe("ambiguous");
    expect(err.message).toContain("appears 2 times");
    expect(err.message).toContain("all: true");
    expect(currentText(db, id)).toBe("cost is 5. cost is 5. done.");
    // With `all`, both are replaced.
    const ok = runEditFile(db, "notes.md", "cost is 5", "cost is 7", true);
    expect(ok.method).toBe("exact_all");
    expect(ok.count).toBe(2);
    expect(currentText(db, id)).toBe("cost is 7. cost is 7. done.");
  });

  it("a batch ambiguity never advises an option edit_files does not have", () => {
    // `edit_files` has no `all` field, so "pass all: true" is advice the model
    // cannot act on: it retries, gets the identical error, and only then falls
    // back to adding surrounding text. Steer it there first.
    const db = freshRoom();
    seedTextFile(db, "n.md", "cost is 5. cost is 5. done.");
    const err = expectPlainError(() =>
      planBatch(db, [{ op: "edit", name: "n.md", oldText: "cost is 5", newText: "cost is 7" }])
    );
    expect(err.message).not.toContain("all: true");
    expect(err.message).toContain("edit_file");
    // The single-file tool still offers it, because it still honours it.
    expect(expectEditError(() => runEditFile(db, "n.md", "cost is 5", "cost is 7", false)).message).toContain("all: true");
  });

  it("fuzzy ambiguous match error does not advise all: true when all is false", () => {
    // The fuzzy path never honors `all`, so that advice would loop a 4B model.
    const db = freshRoom();
    seedTextFile(db, "n.md", "say \u{201C}hi\u{201D} and say \u{201C}hi\u{201D}");
    const err = expectEditError(() => runEditFile(db, "n.md", 'say "hi"', "say bye", false));
    expect(err.outcome).toBe("ambiguous");
    expect(err.message).not.toContain("all: true");
    expect(err.message).toContain("more surrounding text");
  });

  it("all: true with only a fuzzy match is refused, not silently applied", () => {
    // Previously this fell through to the fuzzy matcher and replaced whatever
    // it found — one match if unique — never telling the model whether `all`
    // was honored. One clean rule now: `all: true` always needs an exact quote.
    const db = freshRoom();
    const id = seedTextFile(db, "n.md", "say \u{201C}hi\u{201D} once");
    const err = expectEditError(() => runEditFile(db, "n.md", 'say "hi"', "say bye", true));
    expect(err.outcome).toBe("all_needs_exact");
    expect(err.message).toContain("all: true");
    expect(err.message).toContain("byte-for-byte");
    // Untouched — the refusal must not write anything.
    expect(currentText(db, id)).toBe("say \u{201C}hi\u{201D} once");
    // Dropping all: true still succeeds via the ordinary fuzzy path.
    const ok = runEditFile(db, "n.md", 'say "hi"', "say bye", false);
    expect(ok.method).toBe("fuzzy");
    expect(ok.count).toBe(1);
  });

  it("all: true with a fuzzy ambiguous match gets the same refusal as unique", () => {
    const db = freshRoom();
    seedTextFile(db, "n.md", "say \u{201C}hi\u{201D} and say \u{201C}hi\u{201D}");
    const err = expectEditError(() => runEditFile(db, "n.md", 'say "hi"', "say bye", true));
    expect(err.outcome).toBe("all_needs_exact");
    expect(err.message).toContain("all: true");
  });

  it("occurrence selects the nth and leaves the rest", () => {
    const db = freshRoom();
    seedTextFile(db, "n.md", "cost is 5. cost is 5. cost is 5.");
    const applied = runEditFileRefined(db, "n.md", "cost is 5", "cost is 9", { occurrence: 2 });
    expect(applied.count).toBe(1);
    expect(currentText(db, applied.fileId)).toBe("cost is 5. cost is 9. cost is 5.");
  });

  it("occurrence out of range reports the real count", () => {
    const db = freshRoom();
    seedTextFile(db, "n.md", "cost is 5. cost is 5.");
    const err = expectEditError(() => runEditFileRefined(db, "n.md", "cost is 5", "cost is 9", { occurrence: 3 }));
    expect(err.message).toContain("matches 2 place");
    expect(err.message).toContain("between 1 and 2");
  });

  it("context disambiguates a repeated quote", () => {
    const db = freshRoom();
    seedTextFile(db, "n.md", "Q1: cost is 5. Q2: cost is 5.");
    const applied = runEditFileRefined(db, "n.md", "cost is 5", "cost is 9", { prefixContext: "Q2: " });
    expect(currentText(db, applied.fileId)).toBe("Q1: cost is 5. Q2: cost is 9.");
  });

  it("wrong context reports it rather than guessing", () => {
    const db = freshRoom();
    seedTextFile(db, "n.md", "Q1: cost is 5. Q2: cost is 5.");
    const err = expectEditError(() => runEditFileRefined(db, "n.md", "cost is 5", "cost is 9", { prefixContext: "Q3: " }));
    expect(err.outcome).toBe("not_found");
    expect(err.message).toContain("doesn't appear next to it");
  });

  it("occurrence still narrows correctly on its own (all is a separate concern)", () => {
    const db = freshRoom();
    seedTextFile(db, "n.md", "cost is 5. cost is 5.");
    expect(runEditFileRefined(db, "n.md", "cost is 5", "cost is 9", { occurrence: 1 }).count).toBe(1);
  });

  it("refinements are not available for html or docx yet", () => {
    const db = freshRoom();
    insertFile(db, "note.html", "text/html", Buffer.from("<p>cost is 5. cost is 5.</p>"), "cost is 5. cost is 5.", "generated");
    const err = expectEditError(() => runEditFileRefined(db, "note.html", "cost is 5", "cost is 9", { occurrence: 1 }));
    expect(err.outcome).toBe("wrong_type");
    expect(err.message).toContain("aren't available");
  });
});

// -------------------------------------------------------------- section scoping

describe("edit_match — section scoping (E6)", () => {
  it("section scopes an html edit to one heading", () => {
    const db = freshRoom();
    const id = insertFile(
      db,
      "report.html",
      "text/html",
      Buffer.from("<h1>Q1</h1><p>total is 5</p><h1>Q2</h1><p>total is 5</p>"),
      "Q1 total is 5 Q2 total is 5",
      "generated"
    ).id;
    // Unscoped, "total is 5" is ambiguous (it appears in both sections).
    expect(expectEditError(() => runEditFile(db, "report.html", "total is 5", "total is 9", false)).outcome).toBe("ambiguous");
    const applied = runEditFileRefined(db, "report.html", "total is 5", "total is 9", { section: "Q2" });
    expect(applied.count).toBe(1);
    expect(currentText(db, id)).toBe("<h1>Q1</h1><p>total is 5</p><h1>Q2</h1><p>total is 9</p>");
  });

  it("unknown html section lists the real headings instead of searching the whole page", () => {
    const db = freshRoom();
    insertFile(
      db,
      "report.html",
      "text/html",
      Buffer.from("<h1>Q1</h1><p>total is 5</p><h1>Q2</h1><p>total is 5</p>"),
      "Q1 total is 5 Q2 total is 5",
      "generated"
    );
    const err = expectEditError(() => runEditFileRefined(db, "report.html", "total is 5", "total is 9", { section: "Q3" }));
    expect(err.outcome).toBe("not_found");
    expect(err.message).toContain('"Q1"');
    expect(err.message).toContain('"Q2"');
  });

  it("section scopes a markdown edit to one heading", () => {
    const db = freshRoom();
    const id = seedTextFile(db, "report.md", "# Q1\ntotal is 5\n\n# Q2\ntotal is 5\n");
    expect(expectEditError(() => runEditFile(db, "report.md", "total is 5", "total is 9", false)).outcome).toBe("ambiguous");
    const applied = runEditFileRefined(db, "report.md", "total is 5", "total is 9", { section: "Q2" });
    expect(applied.count).toBe(1);
    expect(currentText(db, id)).toBe("# Q1\ntotal is 5\n\n# Q2\ntotal is 9\n");
  });

  it("markdown sub-section ends at the next same-or-higher heading", () => {
    // Scoped to "A" (h1), the match inside its "A.1" sub-heading is still in
    // scope — a sub-heading doesn't end its parent's section — but sibling
    // "B"'s occurrence is out of scope, so exactly one candidate remains.
    const db = freshRoom();
    seedTextFile(db, "report.md", "# A\nintro\n## A.1\nvalue is 5\n# B\nvalue is 5\n");
    expect(runEditFileRefined(db, "report.md", "value is 5", "value is 9", { section: "A" }).count).toBe(1);
  });

  it("a section-scoped markdown edit still gets the forgiving match", () => {
    // `section` says WHERE to look, not "this quote is byte-perfect".
    const db = freshRoom();
    const id = seedTextFile(db, "report.md", "## Q1\nnothing here\n\n## Q2\nFee is \u{201C}5%\u{201D} today\n");
    const applied = runEditFileRefined(db, "report.md", 'Fee is "5%" today', 'Fee is "7%" today', { section: "Q2" });
    expect(applied.method).toBe("fuzzy");
    expect(currentText(db, id)).toBe('## Q1\nnothing here\n\n## Q2\nFee is "7%" today\n');
  });

  it("a drifted quote outside the named section is still refused", () => {
    // The scoping must survive the fallback: the forgiving matcher runs over
    // the SECTION, not the file.
    const db = freshRoom();
    const src = "## Q1\nFee is \u{201C}5%\u{201D} today\n\n## Q2\nnothing here\n";
    const id = seedTextFile(db, "report.md", src);
    const err = expectEditError(() =>
      runEditFileRefined(db, "report.md", 'Fee is "5%" today', 'Fee is "7%" today', { section: "Q2" })
    );
    expect(err.outcome).toBe("not_found");
    expect(err.message).toContain('"Q2" section');
    expect(err.message).not.toContain("occurrence");
    expect(currentText(db, id)).toBe(src);
  });

  it("a refinement miss names only the refinements that were passed", () => {
    const db = freshRoom();
    seedTextFile(db, "n.md", "Q1: cost is 5.");
    const err = expectEditError(() => runEditFileRefined(db, "n.md", "cost is 9", "cost is 7", { prefixContext: "Q1: " }));
    expect(err.message).toContain("prefix_context needs");
    expect(err.message).not.toContain("occurrence");
    expect(err.message).not.toContain("suffix_context");
  });

  it("section-scoped all replaces every match in that section only", () => {
    // The ambiguity error offers `all: true`; the refined path used to drop
    // the flag, so passing it returned the identical error.
    const content = "# Q1\ncost is 5\ncost is 5\n\n# Q2\ncost is 5\n";
    const result = computeEditBytes("report.md", Buffer.from(content, "utf8"), "cost is 5", "cost is 7", true, {
      section: "Q1",
    });
    expect(result.count).toBe(2);
    expect(result.method).toBe("exact_all");
    expect(result.bytes.toString("utf8")).toBe("# Q1\ncost is 7\ncost is 7\n\n# Q2\ncost is 5\n");
  });

  it("section is refused on a file type it does not support", () => {
    const db = freshRoom();
    seedTextFile(db, "notes.txt", "Q1: total is 5. Q2: total is 5.");
    const err = expectEditError(() => runEditFileRefined(db, "notes.txt", "total is 5", "total is 9", { section: "Q2" }));
    expect(err.outcome).toBe("wrong_type");
    expect(err.message).toContain("section isn't available");
  });
});

// ---------------------------------------------------------------------- e2e

describe("edit_match — end-to-end write path", () => {
  it("run_edit_file snapshots and reindexes", () => {
    const db = freshRoom();
    const id = seedTextFile(db, "memo.md", "The \u{201C}smart quotes\u{201D} and\u{00A0}the septillion figure.\r\n");
    // Straight quotes, plain space, LF — all drifted from the file.
    const applied = runEditFile(db, "memo.md", '"smart quotes" and the septillion figure.', "the corrected octillion figure.", false);
    expect(applied.method).toBe("fuzzy");
    expect(applied.fileId).toBe(id);
    expect(applied.realName).toBe("memo.md");
    expect(currentText(db, id)).toContain("octillion");
    expect(currentText(db, id)).not.toContain("septillion");
    // One snapshot with the AI-edit cause.
    const versions = listFileVersions(db, id);
    expect(versions.length).toBe(1);
    expect(versions[0]!.cause).toBe("AI edit");
    // FTS finds the new text.
    expect(searchChunksFtsRanked(db, "octillion", 5).length).toBeGreaterThan(0);
  });

  it("docx: multi-occurrence errors without all, replaces with all", () => {
    // The replace-all kill applies to .docx too.
    const db = freshRoom();
    const docx = fakeOfficeZip("word/document.xml", "<w:document><w:p><w:t>fee is 5% and fee is 5%</w:t></w:p></w:document>");
    const id = insertFile(db, "c.docx", "application/docx", docx, "fee is 5% and fee is 5%", "upload").id;
    const err = expectEditError(() => runEditFile(db, "c.docx", "fee is 5%", "fee is 7%", false));
    expect(err.outcome).toBe("ambiguous");
    expect(err.message).toContain("all: true");
    // Untouched.
    expect(currentBytes(db, id).equals(docx)).toBe(true);
    // With all → both replaced, round-trips through extractText.
    const ok = runEditFile(db, "c.docx", "fee is 5%", "fee is 7%", true);
    expect(ok.method).toBe("docx");
    expect(extractText("c.docx", currentBytes(db, id))).toContain("fee is 7% and fee is 7%");
  });

  it("html edit replaces text in place", () => {
    const db = freshRoom();
    const id = insertFile(db, "note.html", "text/html", Buffer.from("<p>Q3 revenue was $4M.</p>"), "Q3 revenue was $4M.", "generated").id;
    const applied = runEditFile(db, "note.html", "$4M", "$5M", false);
    expect(applied.method).toBe("html");
    expect(applied.count).toBe(1);
    expect(currentText(db, id)).toBe("<p>Q3 revenue was $5M.</p>");
    const versions = listFileVersions(db, id);
    expect(versions.length).toBe(1);
    expect(versions[0]!.cause).toBe("AI edit");
  });

  it("html edit escapes the replacement before splicing", () => {
    const db = freshRoom();
    const id = insertFile(db, "note.html", "text/html", Buffer.from("<p>old</p>"), "old", "generated").id;
    runEditFile(db, "note.html", "old", "A & B <script>", false);
    expect(currentText(db, id)).toBe("<p>A &amp; B &lt;script&gt;</p>");
  });

  it("html edit multi-occurrence errors without all, replaces with all", () => {
    const db = freshRoom();
    const id = insertFile(
      db,
      "note.html",
      "text/html",
      Buffer.from("<p>cost is 5.</p><p>cost is 5.</p>"),
      "cost is 5. cost is 5.",
      "generated"
    ).id;
    const err = expectEditError(() => runEditFile(db, "note.html", "cost is 5", "cost is 7", false));
    expect(err.outcome).toBe("ambiguous");
    expect(err.message).toContain("appears 2 times");
    expect(err.message).toContain("all: true");
    expect(currentText(db, id)).toBe("<p>cost is 5.</p><p>cost is 5.</p>");
    const ok = runEditFile(db, "note.html", "cost is 5", "cost is 7", true);
    expect(ok.method).toBe("html");
    expect(ok.count).toBe(2);
    expect(currentText(db, id)).toBe("<p>cost is 7.</p><p>cost is 7.</p>");
  });

  it("html edit never matches across a paragraph even with all", () => {
    // The block-boundary sentinel applies regardless of `all` — there is no
    // way to ask for a cross-paragraph splice, by design.
    const db = freshRoom();
    insertFile(db, "note.html", "text/html", Buffer.from("<p>Hello</p><p>Hello</p>"), "Hello Hello", "generated");
    expect(expectEditError(() => runEditFile(db, "note.html", "HelloHello", "x", true)).outcome).toBe("not_found");
  });

  it("html edit not-found carries a closest hint from the readable text", () => {
    const db = freshRoom();
    insertFile(
      db,
      "note.html",
      "text/html",
      Buffer.from("<p>Payment is due within thirty days of invoice.</p>"),
      "Payment is due within thirty days of invoice.",
      "generated"
    );
    const err = expectEditError(() => runEditFile(db, "note.html", "payment due within ninety days of invoice", "x", false));
    expect(err.outcome).toBe("not_found");
    expect(err.message).toContain("closest text");
  });

  it("run_edit_file not-found carries a closest hint", () => {
    const db = freshRoom();
    seedTextFile(db, "terms.txt", "Payment is due within thirty days of invoice.");
    const err = expectEditError(() => runEditFile(db, "terms.txt", "payment due within ninety days of invoice", "x", false));
    expect(err.outcome).toBe("not_found");
    expect(err.message).toContain("closest text");
  });
});

// --------------------------------------------------------------------- batch

describe("edit_match — batch (edit_files)", () => {
  it("is atomic on late failure", () => {
    const db = freshRoom();
    const a = seedTextFile(db, "a.md", "alpha here");
    const b = seedTextFile(db, "b.md", "beta here");
    const err = expectPlainError(() =>
      runEditFiles(db, [
        { op: "edit", name: "a.md", oldText: "alpha", newText: "ALPHA" },
        { op: "edit", name: "b.md", oldText: "nonexistent", newText: "x" },
      ])
    );
    expect(err.message.startsWith("Edit 2 of 2")).toBe(true);
    // Neither file changed; zero version rows.
    expect(currentText(db, a)).toBe("alpha here");
    expect(currentText(db, b)).toBe("beta here");
    expect(listFileVersions(db, a).length).toBe(0);
    expect(listFileVersions(db, b).length).toBe(0);
  });

  it("applies all and tags a shared cause", () => {
    const db = freshRoom();
    const a = seedTextFile(db, "a.md", "the wibble value");
    const b = seedTextFile(db, "b.md", "another wobble value");
    const applied = runEditFiles(db, [
      { op: "edit", name: "a.md", oldText: "wibble", newText: "quux" },
      { op: "edit", name: "b.md", oldText: "wobble", newText: "quux" },
    ]);
    expect(applied.edits).toBe(2);
    expect(applied.files.length).toBe(2);
    expect(currentText(db, a)).toContain("quux");
    expect(currentText(db, b)).toContain("quux");
    const va = listFileVersions(db, a);
    const vb = listFileVersions(db, b);
    expect(va[0]!.cause).toBe(vb[0]!.cause);
    expect(va[0]!.cause).toContain(`batch ${applied.batchId}`);
    expect(searchChunksFtsRanked(db, "quux", 5).length).toBeGreaterThan(0);
  });

  it("chains edits to the same file into one snapshot", () => {
    const db = freshRoom();
    const a = seedTextFile(db, "a.md", "one two three");
    runEditFiles(db, [
      { op: "edit", name: "a.md", oldText: "one", newText: "1" },
      { op: "edit", name: "a.md", oldText: "three", newText: "3" },
    ]);
    expect(currentText(db, a)).toBe("1 two 3");
    // Two edits to one file → exactly one snapshot.
    expect(listFileVersions(db, a).length).toBe(1);
  });

  it("rename and edit are atomic together", () => {
    const db = freshRoom();
    const a = seedTextFile(db, "draft.md", "hello world");
    const applied = runEditFiles(db, [
      { op: "rename", name: "draft.md", newName: "final" },
      { op: "edit", name: "draft.md", oldText: "hello", newText: "goodbye" },
    ]);
    expect(applied.renames).toBe(1);
    expect(applied.edits).toBe(1);
    // One touched file (same id resolved for both ops), renamed + edited.
    expect(applied.files.length).toBe(1);
    expect(applied.files[0]![1]).toBe("final.md"); // extension kept
    expect(currentText(db, a)).toBe("goodbye world");
    expect(getFileName(db, a)).toBe("final.md");
    expect(listFileVersions(db, a).length).toBe(1);
  });

  it("rolls back a failing rename together with a valid edit", () => {
    const db = freshRoom();
    const a = seedTextFile(db, "a.md", "keep me");
    const err = expectPlainError(() =>
      runEditFiles(db, [
        { op: "edit", name: "a.md", oldText: "keep", newText: "drop" },
        { op: "rename", name: "does-not-exist", newName: "x" },
      ])
    );
    expect(err.message.startsWith("Rename 2 of 2")).toBe(true);
    expect(currentText(db, a)).toBe("keep me");
    expect(listFileVersions(db, a).length).toBe(0);
  });

  it("rejects an oversize batch", () => {
    const db = freshRoom();
    seedTextFile(db, "a.md", "x");
    const ops: BatchOp[] = Array.from({ length: MAX_BATCH_EDITS + 1 }, () => ({
      op: "edit" as const,
      name: "a.md",
      oldText: "x",
      newText: "y",
    }));
    expect(expectPlainError(() => runEditFiles(db, ops)).message).toContain("Too many");
  });

  it("counts edits and renames separately", () => {
    expect(
      countBatchOps([
        { op: "edit", name: "a", oldText: "x", newText: "y" },
        { op: "rename", name: "a", newName: "b" },
        { op: "edit", name: "c", oldText: "x", newText: "y" },
      ])
    ).toEqual({ edits: 2, renames: 1 });
  });
});

// ---------------------------------------------------------------- byte safety

describe("edit_match — byte/encoding safety", () => {
  it("refuses a non-UTF-8 file instead of mangling it", () => {
    // Read lossily, every unreadable byte becomes U+FFFD, so a one-word edit
    // used to replace the file's accented letters with boxes and write it back.
    const db = freshRoom();
    const latin1 = Buffer.from("Le siège social est à Paris.", "latin1");
    const id = insertFile(db, "note.txt", "text/plain", latin1, null, "upload").id;
    const err = expectEditError(() => runEditFile(db, "note.txt", "Paris", "Lyon", false));
    expect(err.outcome).toBe("wrong_type");
    expect(err.message).toContain("UTF-8");
    expect(currentBytes(db, id).equals(latin1)).toBe(true);
  });

  it("a huge file skips the forgiving match but still edits exactly", () => {
    const db = freshRoom();
    let body = "filler line of ordinary prose.\n".repeat(200_000); // ~6 MB
    body += "the target phrase here";
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(MAX_FUZZY_BYTES);
    const id = seedTextFile(db, "big.txt", body);
    // An EXACT quote still works at any size.
    runEditFile(db, "big.txt", "the target phrase here", "replaced", false);
    expect(currentText(db, id).endsWith("replaced")).toBe(true);
    // A drifted quote gets an honest "has to be exact", not a freeze.
    const err = expectEditError(() => runEditFile(db, "big.txt", "the  target\u{00A0}phrase", "x", false));
    expect(err.outcome).toBe("not_found");
    expect(err.message).toContain("has to be exact");
  }, 60_000);
});

// -------------------------------------------------------------------- preview

describe("edit_match — diff preview", () => {
  it("a rename that changes the type still previews the real content", () => {
    // The preview used to be rendered with the NEW name, so renaming a .md to
    // a .docx in the same batch drew both panes through the docx reader and
    // the approval card came up empty.
    const db = freshRoom();
    seedTextFile(db, "notes.md", "hello world");
    const plans = planBatch(db, [
      { op: "edit", name: "notes.md", oldText: "hello", newText: "goodbye" },
      { op: "rename", name: "notes.md", newName: "notes.docx" },
    ]);
    expect(plans.length).toBe(1);
    expect(plans[0]!.before).toContain("hello world");
    expect(plans[0]!.after).toContain("goodbye world");
    expect(plans[0]!.renameTo).toBe("notes.docx");
  });

  it("a clipped preview shows the changed region, not the first page", () => {
    // Both panes used to be clipped from position 0, so a change past
    // PREVIEW_CLIP produced two IDENTICAL heads: a card with no visible diff
    // that still asked for approval.
    const db = freshRoom();
    let body = "filler line of ordinary prose.\n".repeat(20_000); // ~600 KB
    body += "the closing sentence.\n";
    expect(body.length).toBeGreaterThan(PREVIEW_CLIP * 2);
    seedTextFile(db, "big.md", body);
    const edit: PreviewEdit = {
      name: "big.md",
      oldText: "the closing sentence.",
      newText: "the corrected sentence.",
      all: false,
    };
    const plans = planSingleEdit(db, edit);
    expect(plans[0]!.clipped).toBe(true);
    expect(plans[0]!.before).toContain("the closing sentence.");
    expect(plans[0]!.after).toContain("the corrected sentence.");
    expect(plans[0]!.before).not.toBe(plans[0]!.after);
    // Still bounded (the window, plus the leading ellipsis marking it).
    expect(plans[0]!.after.length).toBeLessThanOrEqual(PREVIEW_CLIP + 4);
  }, 30_000);

  it("a small file's preview is the whole file, unclipped", () => {
    const db = freshRoom();
    seedTextFile(db, "small.md", "hello world");
    const plans = planWriteFile(db, "small.md", "goodbye world");
    expect(plans[0]!.clipped).toBe(false);
    expect(plans[0]!.before).toBe("hello world");
    expect(plans[0]!.after).toBe("goodbye world");
  });

  it("a clipped unchanged preview keeps the complete boundary-safe head", () => {
    // The clip ends exactly between an astral character's surrogate halves.
    // An unchanged preview also takes firstDifference's prefix path and the
    // start-at-zero branch, so it must neither split the emoji nor invent a
    // leading ellipsis.
    const db = freshRoom();
    const content = `${"x".repeat(PREVIEW_CLIP - 1)}\u{1F600}`;
    seedTextFile(db, "boundary.md", content);
    const [plan] = planWriteFile(db, "boundary.md", content);
    expect(plan!.clipped).toBe(true);
    expect(plan!.before).toBe("x".repeat(PREVIEW_CLIP - 1));
    expect(plan!.after).toBe(plan!.before);
  });

  it("a legacy-encoded file previews as text, not replacement boxes", () => {
    // windows-1252 bytes read lossily became U+FFFD everywhere, so the
    // approval card showed boxes for every accented letter.
    const db = freshRoom();
    const latin1 = Buffer.from("Le siège social de la société est à Paris, près de la gare.", "latin1");
    insertFile(db, "note.txt", "text/plain", latin1, null, "upload");
    const plans = planWriteFile(db, "note.txt", "Le siege social est a Lyon.");
    expect(plans[0]!.before).not.toContain("\u{FFFD}");
    expect(plans[0]!.before).toContain("Paris");
  });

  it("a batch rename that changes the type indexes the bytes as they are", () => {
    // The searchable text used to be derived with the NEW name, so editing a
    // .docx and renaming it to .md in one batch stored the zip decoded as
    // text, and search got binary mojibake.
    const db = freshRoom();
    const docx = fakeOfficeZip("word/document.xml", "<w:document><w:p><w:t>fee is 5%</w:t></w:p></w:document>");
    insertFile(db, "contract.docx", "application/docx", docx, "fee is 5%", "upload");
    const plans = planBatch(db, [
      { op: "edit", name: "contract.docx", oldText: "5%", newText: "7%" },
      { op: "rename", name: "contract.docx", newName: "contract.md" },
    ]);
    commitPlans(db, plans, "AI edit");
    const [, name, text] = findFileLikeFull(db, "contract");
    expect(name).toBe("contract.md");
    expect(text).not.toBeNull();
    expect(text).toContain("fee is 7%");
    expect(text).not.toContain("word/document.xml");
  });
});

// --------------------------------------------------------------------- parse

describe("edit_match — batch op parsing", () => {
  it("parses both the tagged and untagged shapes", () => {
    // The tolerance that must NOT regress: the untagged form a 4B emits.
    expect(
      parseBatchOps({
        edits: [
          { op: "edit", name: "a", old_text: "x", new_text: "y" },
          { op: "rename", name: "a", new_name: "b" },
        ],
      })
    ).toEqual([
      { op: "edit", name: "a", oldText: "x", newText: "y" },
      { op: "rename", name: "a", newName: "b" },
    ]);
    expect(
      parseBatchOps({
        edits: [
          { name: "a.md", old_text: "x", new_text: "y" },
          { name: "old.md", new_name: "new.md" },
        ],
      })
    ).toEqual([
      { op: "edit", name: "a.md", oldText: "x", newText: "y" },
      { op: "rename", name: "old.md", newName: "new.md" },
    ]);
  });

  it("an explicit op is matched case-insensitively", () => {
    expect(parseBatchOps({ edits: [{ op: "RENAME", name: "a.md", new_name: "b.md" }] })).toEqual([
      { op: "rename", name: "a.md", newName: "b.md" },
    ]);
  });

  it("a nameless entry fails the whole batch instead of being skipped", () => {
    const err = expectPlainError(() =>
      parseBatchOps({
        edits: [
          { name: "a.md", old_text: "x", new_text: "y" },
          { old_text: "p", new_text: "q" },
          { name: "c.md", old_text: "m", new_text: "n" },
        ],
      })
    );
    // Numbered like planBatch's errors, and 1-based for a human/model.
    expect(err.message).toContain("Edit 2 of 3");
    expect(err.message).toContain("name is required");
    // It must say plainly that nothing landed — the whole point.
    expect(err.message).toContain("Nothing was changed");
  });

  it("a blank name is the same failure as a missing one", () => {
    const err = expectPlainError(() => parseBatchOps({ edits: [{ name: "   ", old_text: "x", new_text: "y" }] }));
    expect(err.message).toContain("Edit 1 of 1");
    expect(err.message).toContain("name is required");
  });

  it("an entry with a name but no operation is caught downstream, atomically", () => {
    // Parse accepts it (it looks like an edit); planBatch then refuses the
    // BATCH with a numbered error, so nothing is written.
    const ops = parseBatchOps({ edits: [{ name: "a.md" }] });
    const db = freshRoom();
    seedTextFile(db, "a.md", "hello");
    expect(expectPlainError(() => planBatch(db, ops)).message).toContain("old_text is required");
  });

  it("an empty edits array still says so", () => {
    expect(expectPlainError(() => parseBatchOps({ edits: [] })).message).toContain("No edits given");
  });

  it("rejects args with no edits array at all", () => {
    expect(expectPlainError(() => parseBatchOps({})).message).toContain("Pass edits:");
  });
});

// ------------------------------------------------------------------ set_cells

describe("edit_match — planSetCells", () => {
  it("plans a csv cell write with a before/after preview", () => {
    const db = freshRoom();
    const id = seedTextFile(db, "sheet.csv", "a,b\n1,2\n");
    const plans = planSetCells(db, "sheet.csv", null, [["B2", "9"]]);
    expect(plans.length).toBe(1);
    expect(plans[0]!.fileId).toBe(id);
    expect(plans[0]!.count).toBe(1);
    expect(plans[0]!.newBytes!.toString("utf8")).toBe("a,b\n1,9\n");
    expect(plans[0]!.before).toBe("a,b\n1,2\n");
    expect(plans[0]!.after).toBe("a,b\n1,9\n");
    // Planning writes nothing.
    expect(currentText(db, id)).toBe("a,b\n1,2\n");
  });

  it("chains several cell updates over the working bytes", () => {
    const db = freshRoom();
    seedTextFile(db, "sheet.csv", "a,b\n1,2\n");
    const plans = planSetCells(db, "sheet.csv", null, [
      ["A2", "7"],
      ["B2", "8"],
    ]);
    expect(plans[0]!.count).toBe(2);
    expect(plans[0]!.newBytes!.toString("utf8")).toBe("a,b\n7,8\n");
  });

  it("reports a name that doesn't resolve as not_found", () => {
    const db = freshRoom();
    seedTextFile(db, "present.csv", "a\n1\n");
    const err = expectEditError(() => planSetCells(db, "does-not-exist.csv", null, [["A1", "1"]]));
    expect(err.outcome).toBe("not_found");
  });

  it("refuses .xlsx honestly rather than corrupting the archive", () => {
    const db = freshRoom();
    const id = insertFile(db, "sheet.xlsx", "application/xlsx", Buffer.from("fake xlsx bytes"), null, "upload").id;
    const err = expectEditError(() => planSetCells(db, "sheet.xlsx", null, [["B7", "42"]]));
    expect(err.message).toMatch(/not supported by this port/i);
    // Refused, not corrupted.
    expect(currentText(db, id)).toBe("fake xlsx bytes");
  });
});

// ============================================================================
// Coverage beyond edit_match.rs's own test module — including regressions for
// three defects found while merging two independent candidate ports.
// ============================================================================

describe("edit_match — additional coverage and merge regressions", () => {
  it("REGRESSION: a `$`-pattern in new_text is written LITERALLY, never expanded", () => {
    // Rust's `String::replace` treats both arguments as literal text. JS's
    // `String.prototype.replace` interprets `$&`, "$`", `$'`, `$1` and `$$` in
    // the REPLACEMENT, so a candidate port that used it silently expanded them
    // — a replacement of "$&" wrote the matched text back instead, corrupting
    // the file for any new_text containing a dollar sign.
    const content = "cost is 5";
    for (const newText of ["$& and more", "a $` b", "x $' y", "$$100", "$1"]) {
      const out = computeEditBytes("n.md", Buffer.from(content, "utf8"), "5", newText, false, {});
      expect(out.bytes.toString("utf8")).toBe(`cost is ${newText}`);
    }
    // The replace-EVERY-occurrence path must be just as literal.
    const all = computeEditBytes("n.md", Buffer.from("5 and 5", "utf8"), "5", "$&!", true, {});
    expect(all.bytes.toString("utf8")).toBe("$&! and $&!");
    expect(all.count).toBe(2);
  });

  it("REGRESSION: a plain-text file's extracted text keeps its own whitespace verbatim", () => {
    // `extraction::extract_text` returns EARLY for a text extension, with the
    // file's decoded text unchanged; only the binary/markup readers run their
    // output through `normalize_whitespace`. A candidate port applied the
    // normalizer to every branch, so a .md file's indentation and blank lines
    // were silently collapsed in the search index and in everything the model
    // later read back as that file's content.
    const md = "# Title\n\n\n    indented   code\n\ttabbed\n";
    expect(extractText("notes.md", Buffer.from(md, "utf8"))).toBe(md);
    // An HTML/docx read, by contrast, IS normalized (and an empty read is null).
    expect(extractText("page.html", Buffer.from("<p>hello   <b>world</b></p>", "utf8"))?.trim()).toBe("hello world");
    expect(extractText("blank.html", Buffer.from("<p>   </p>", "utf8"))).toBeNull();
  });

  it("REGRESSION: the fuzzy-size ceiling is measured in UTF-8 BYTES, not code units", () => {
    // `MAX_FUZZY_BYTES` guards the matcher's ALLOCATION, and Rust measures it
    // with `content.len()` — UTF-8 bytes. Measuring JS code units instead lets
    // a 4.5 MB CJK/Hebrew document (well under 4 M code units) through to the
    // forgiving matcher the ceiling exists to keep it out of.
    const body = `${"文字".repeat(750_000)} end`; // 1.5 M code units, ~4.5 MB
    expect(body.length).toBeLessThan(MAX_FUZZY_BYTES);
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(MAX_FUZZY_BYTES);
    const err = expectEditError(() => computeEditBytes("big.txt", Buffer.from(body, "utf8"), "no such quote here", "x", false, {}));
    expect(err.outcome).toBe("not_found");
    expect(err.message).toContain("has to be exact");
  }, 30_000);

  it("REGRESSION: an html heading followed by a length-changing uppercase letter still scopes correctly", () => {
    // `scan_headings` locates a heading's closing tag in an ASCII-lowered copy
    // of the page. A candidate port used Unicode `toLowerCase()`, which
    // expands `İ` (U+0130) to two code units — so the index it found no longer
    // addressed the original, the heading swallowed the text after it, and a
    // `section`-scoped edit landed on the wrong byte range.
    const db = freshRoom();
    const prefix = "\u{0130}".repeat(10);
    const html = `<h1>${prefix} Q1</h1><p>total is 5</p><h1>Q2</h1><p>total is 5</p>`;
    const id = insertFile(db, "report.html", "text/html", Buffer.from(html, "utf8"), "x", "generated").id;
    const applied = runEditFileRefined(db, "report.html", "total is 5", "total is 9", { section: "Q2" });
    expect(applied.count).toBe(1);
    expect(currentText(db, id)).toBe(`<h1>${prefix} Q1</h1><p>total is 5</p><h1>Q2</h1><p>total is 9</p>`);
  });

  it("edit_file rejects an empty old_text before touching any file", () => {
    const db = freshRoom();
    seedTextFile(db, "a.md", "hello");
    const err = expectEditError(() => planSingleEdit(db, { name: "a.md", oldText: "", newText: "x", all: false }));
    expect(err.outcome).toBe("not_found");
    expect(err.message).toContain("old_text is required");
  });

  it("edit_file on a missing file reports not_found and names what the room does have", () => {
    const db = freshRoom();
    seedTextFile(db, "present.md", "hi");
    const err = expectEditError(() => runEditFile(db, "absent.md", "x", "y", false));
    expect(err.outcome).toBe("not_found");
    expect(err.message).toContain("present.md");
  });

  it("xlsx is refused with a set_cells pointer, not a generic wrong_type message", () => {
    const db = freshRoom();
    insertFile(db, "sheet.xlsx", "application/xlsx", Buffer.from("not a real xlsx"), null, "upload");
    const err = expectEditError(() => runEditFile(db, "sheet.xlsx", "x", "y", false));
    expect(err.outcome).toBe("wrong_type");
    expect(err.message).toContain("set_cells");
  });

  it("pdf edit_file is refused with an annotate_file/create_file pointer", () => {
    const db = freshRoom();
    insertFile(db, "doc.pdf", "application/pdf", Buffer.from("%PDF-1.4 fake"), null, "upload");
    const err = expectEditError(() => runEditFile(db, "doc.pdf", "x", "y", false));
    expect(err.outcome).toBe("wrong_type");
    expect(err.message).toContain("annotate_file");
  });

  it("an unrecognized binary extension is refused with a create_file pointer", () => {
    const db = freshRoom();
    insertFile(db, "image.png", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47]), null, "upload");
    const err = expectEditError(() => runEditFile(db, "image.png", "x", "y", false));
    expect(err.outcome).toBe("wrong_type");
    expect(err.message).toBe(
      "This file type cannot be edited in place. Use create_file to save an edited copy of its text instead."
    );
  });

  it("write_file refuses a file that is neither text nor HTML", () => {
    const db = freshRoom();
    insertFile(db, "sheet.xlsx", "application/xlsx", Buffer.from("fake"), null, "upload");
    const err = expectEditError(() => planWriteFile(db, "sheet.xlsx", "new content"));
    expect(err.outcome).toBe("wrong_type");
    expect(err.message).toContain("not a plain-text file");
  });

  it("write_file accepts html, and counts characters not code units", () => {
    const db = freshRoom();
    insertFile(db, "page.html", "text/html", Buffer.from("<p>old</p>"), "old", "generated");
    // An astral character is ONE char to `content.chars().count()`.
    const plans = planWriteFile(db, "page.html", "<p>\u{1F600}</p>");
    expect(plans[0]!.count).toBe("<p></p>".length + 1);
  });

  it("prefix_context and suffix_context together narrow to one occurrence", () => {
    const db = freshRoom();
    seedTextFile(db, "n.md", "A: cost is 5 (old). B: cost is 5 (new).");
    const applied = runEditFileRefined(db, "n.md", "cost is 5", "cost is 9", {
      prefixContext: "B: ",
      suffixContext: " (new)",
    });
    expect(applied.count).toBe(1);
    expect(currentText(db, applied.fileId)).toBe("A: cost is 5 (old). B: cost is 9 (new).");
  });

  it("suffix_context alone can disambiguate without a prefix", () => {
    const db = freshRoom();
    seedTextFile(db, "n.md", "cost is 5 today. cost is 5 tomorrow.");
    const applied = runEditFileRefined(db, "n.md", "cost is 5", "cost is 9", { suffixContext: " tomorrow" });
    expect(currentText(db, applied.fileId)).toBe("cost is 5 today. cost is 9 tomorrow.");
  });

  it("markdown section scoping tolerates a heading whose text has drifted typographically", () => {
    // The needle "Q1's Numbers" (straight apostrophe) must match a heading
    // spelled with a curly one, via the SAME fold table the matcher uses.
    const db = freshRoom();
    seedTextFile(db, "report.md", "# Q1\u{2019}s Numbers\ntotal is 5\n\n# Q2\ntotal is 5\n");
    const applied = runEditFileRefined(db, "report.md", "total is 5", "total is 9", { section: "Q1's Numbers" });
    expect(applied.count).toBe(1);
    expect(currentText(db, applied.fileId)).toBe("# Q1\u{2019}s Numbers\ntotal is 9\n\n# Q2\ntotal is 5\n");
  });

  it("a markdown heading needs a space after its hashes (CommonMark's rule)", () => {
    // `#!/usr/bin/env` must not be misread as a heading.
    const db = freshRoom();
    seedTextFile(db, "report.md", "#!/usr/bin/env node\nvalue is 5\n# Real\nvalue is 5\n");
    const err = expectEditError(() => runEditFileRefined(db, "report.md", "value is 5", "value is 9", { section: "!/usr/bin/env node" }));
    expect(err.outcome).toBe("not_found");
    expect(err.message).toContain('"Real"');
  });

  it("a rename that already carries an extension is not double-suffixed", () => {
    const db = freshRoom();
    const id = seedTextFile(db, "draft.md", "content");
    runEditFiles(db, [{ op: "rename", name: "draft.md", newName: "final.txt" }]);
    expect(getFileName(db, id)).toBe("final.txt");
  });

  it("a rename-only batch keeps the extension and takes no snapshot", () => {
    const db = freshRoom();
    const id = seedTextFile(db, "draft.md", "content");
    const applied = runEditFiles(db, [{ op: "rename", name: "draft.md", newName: "final" }]);
    expect(applied.renames).toBe(1);
    expect(applied.edits).toBe(0);
    expect(getFileName(db, id)).toBe("final.md");
    // Rename-only: no byte change, so no snapshot.
    expect(listFileVersions(db, id).length).toBe(0);
    const plans = planBatch(db, [{ op: "rename", name: "final.md", newName: "again" }]);
    expect(plans[0]!.newBytes).toBeNull();
    expect(plans[0]!.staleness).toBeNull();
    expect(plans[0]!.before).toBe("name: final.md");
    expect(plans[0]!.after).toBe("name: again.md");
  });

  it("a blank new_name in a batch rename is refused before any work", () => {
    const db = freshRoom();
    seedTextFile(db, "a.md", "x");
    expect(expectPlainError(() => planBatch(db, [{ op: "rename", name: "a.md", newName: "   " }])).message).toContain(
      "Rename 1 of 1: new_name is required"
    );
  });

  it("edit_files never advises `all` even when the batch edit is docx-ambiguous", () => {
    const db = freshRoom();
    const docx = fakeOfficeZip("word/document.xml", "<w:document><w:p><w:t>fee is 5% and fee is 5%</w:t></w:p></w:document>");
    insertFile(db, "c.docx", "application/docx", docx, "fee is 5% and fee is 5%", "upload");
    const err = expectPlainError(() => planBatch(db, [{ op: "edit", name: "c.docx", oldText: "fee is 5%", newText: "fee is 7%" }]));
    expect(err.message).toContain("Edit 1 of 1");
    expect(err.message).not.toContain("all: true");
    expect(err.message).toContain("edit_files has no all option");
  });

  it("computeEditBytes never runs the fuzzy fallback when all: true and no exact match exists", () => {
    const err = expectEditError(() =>
      computeEditBytes("n.md", Buffer.from("say \u{201C}hi\u{201D} once", "utf8"), 'say "hi"', "say bye", true, {})
    );
    expect(err.outcome).toBe("all_needs_exact");
  });

  it("REGRESSION: an occurrence that is not a whole number ≥ 1 is refused, never a TypeError", () => {
    // Rust's `occurrence` is an `Option<usize>`, so its `n == 0 || n > len`
    // check is complete — a negative or fractional value cannot be constructed.
    // A JS `number` can be either, and `filtered[-1]`/`filtered[0.5]` is
    // `undefined`: destructuring it threw a TypeError that sailed past every
    // `instanceof EditError` handler (planBatch rethrows a non-EditError as-is),
    // so a malformed tool argument crashed the arm instead of returning the
    // honest, model-readable range error.
    const content = Buffer.from("cost is 5. cost is 5.", "utf8");
    for (const occurrence of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const err = expectEditError(() => computeEditBytes("n.md", content, "cost is 5", "X", false, { occurrence }));
      expect(err.outcome).toBe("not_found");
      expect(err.message).toContain("between 1 and 2");
    }
    // The valid values Rust CAN represent are untouched.
    expect(computeEditBytes("n.md", content, "cost is 5", "X", false, { occurrence: 2 }).bytes.toString("utf8")).toBe(
      "cost is 5. X."
    );
  });

  it("one exact match plus one drifted twin edits the EXACT one, with no ambiguity", () => {
    // The exact pass runs first and finds exactly one hit, so the forgiving
    // matcher — which would have seen TWO — is never consulted. Checked
    // against the Rust source, which reports `exact` and the same bytes.
    const out = computeEditBytes(
      "n.md",
      Buffer.from("say \"hi\" and say \u{201C}hi\u{201D}", "utf8"),
      'say "hi"',
      "say bye",
      false,
      {}
    );
    expect(out.method).toBe("exact");
    expect(out.count).toBe(1);
    expect(out.bytes.toString("utf8")).toBe("say bye and say \u{201C}hi\u{201D}");
  });

  it("a quote that is a PREFIX of a longer near-duplicate is ambiguous, not the first one", () => {
    // "cost is 5" also sits inside "cost is 50", so there are genuinely two
    // matches. Picking the first would rewrite a number the model never quoted.
    const err = expectEditError(() =>
      computeEditBytes("n.md", Buffer.from("cost is 5. cost is 50.", "utf8"), "cost is 5", "X", false, {})
    );
    expect(err.outcome).toBe("ambiguous");
    expect(err.message).toContain("appears 2 times");
  });

  it("a whitespace-only difference is forgiven, but never ACROSS a blank line", () => {
    // Both quotes differ from the file by whitespace alone. The wrapped line
    // folds and matches; the one separated by a blank line must not, or a
    // single-space quote would splice two paragraphs into one.
    const wrapped = computeEditBytes("n.md", Buffer.from("cost is\n5 today", "utf8"), "cost is 5", "cost is 7", false, {});
    expect(wrapped.method).toBe("fuzzy");
    expect(wrapped.bytes.toString("utf8")).toBe("cost is 7 today");
    const err = expectEditError(() =>
      computeEditBytes("n.md", Buffer.from("cost is\n\n5 today", "utf8"), "cost is 5", "cost is 7", false, {})
    );
    expect(err.outcome).toBe("not_found");
  });

  it("a refined replace-all splices adjacent, non-overlapping spans right-to-left", () => {
    // "aaaa" holds two back-to-back "aa" candidates. Splicing left-to-right
    // would invalidate the second span's offsets mid-rewrite; right-to-left
    // keeps them valid, which is what Rust's `.rev()` is for.
    const out = computeEditBytes("n.md", Buffer.from("aaaa", "utf8"), "aa", "B", true, { prefixContext: "" });
    expect(out.method).toBe("exact_all");
    expect(out.count).toBe(2);
    expect(out.bytes.toString("utf8")).toBe("BB");
  });

  it("a candidate that STRADDLES the section boundary is out of scope, not clamped into it", () => {
    // "value\n# B" starts inside section A and ends inside B's heading line.
    // The filter is `start >= r.start && end <= r.end`, so it is dropped
    // entirely — a partial overlap must never be edited.
    const err = expectEditError(() =>
      computeEditBytes("r.md", Buffer.from("# A\nvalue\n# B\nvalue\n", "utf8"), "value\n# B", "x", false, { section: "A" })
    );
    expect(err.outcome).toBe("not_found");
    expect(err.message).toContain('"A" section');
  });

  it("REGRESSION: positional refinement inside a section keeps full-document offsets", () => {
    // Slicing to the section and then applying candidate offsets to the full
    // document changes the similarly named quote before the heading. The
    // candidates must instead retain full-document positions while filtering.
    const out = computeEditBytes(
      "report.md",
      Buffer.from("intro: value\n# Target\nvalue\n# Later\nvalue\n", "utf8"),
      "value",
      "changed",
      false,
      { section: "Target", prefixContext: "# Target\n" },
    );
    expect(out.bytes.toString("utf8")).toBe("intro: value\n# Target\nchanged\n# Later\nvalue\n");
  });

  it("REGRESSION: unsupported extraction stays absent instead of decoding binary preview bytes", () => {
    expect(extractText("opaque.bin", Buffer.from([0xff, 0x00, 0xfe]))).toBeNull();
  });

  it("section validation reports a heading-less document without searching it", () => {
    const err = expectEditError(() =>
      computeEditBytes("plain.md", Buffer.from("ordinary prose", "utf8"), "ordinary", "changed", false, { section: "Target" })
    );
    expect(err.outcome).toBe("not_found");
    expect(err.message).toContain("has no headings");
  });

  it("section fallback preserves its all and ambiguity safeguards", () => {
    const unique = Buffer.from("# Target\nFee is \u{201C}5%\u{201D}\n", "utf8");
    const allError = expectEditError(() =>
      computeEditBytes("report.md", unique, 'Fee is "5%"', 'Fee is "7%"', true, { section: "Target" })
    );
    expect(allError.outcome).toBe("all_needs_exact");

    const ambiguous = Buffer.from("# Target\nFee is \u{201C}5%\u{201D}\nFee is \u{201C}5%\u{201D}\n", "utf8");
    const ambiguousError = expectEditError(() =>
      computeEditBytes("report.md", ambiguous, 'Fee is "5%"', 'Fee is "7%"', false, { section: "Target" })
    );
    expect(ambiguousError.outcome).toBe("ambiguous");
    expect(ambiguousError.message).toContain('"Target" section');
  });

  it("section fallback observes the UTF-8 fuzzy-size ceiling", () => {
    const content = `# Target\n${"文".repeat(Math.ceil(MAX_FUZZY_BYTES / 3))}`;
    const err = expectEditError(() =>
      computeEditBytes("large.md", Buffer.from(content, "utf8"), "missing quote", "x", false, { section: "Target" })
    );
    expect(err.outcome).toBe("not_found");
    expect(err.message).toContain("has to be exact");
  }, 30_000);

  it("positional empty quotes return the refinement diagnostic instead of matching boundaries", () => {
    const err = expectEditError(() =>
      computeEditBytes("notes.md", Buffer.from("content", "utf8"), "", "x", false, { occurrence: 1 })
    );
    expect(err.outcome).toBe("not_found");
    expect(err.message).toContain("occurrence needs");
  });

  it("workspace planners read current bytes while retaining DB name resolution", async () => {
    const db = freshRoom();
    const noteId = seedTextFile(db, "note.md", "old value");
    const sheetId = seedTextFile(db, "sheet.csv", "a,b\n1,2\n");
    let reads = 0;
    const workspace = {
      readBuffer: async (id: string) => {
        reads += 1;
        return currentBytes(db, id);
      },
    } as unknown as Parameters<typeof planSingleEditWorkspace>[1];

    expect((await planSingleEditWorkspace(db, workspace, { name: "note.md", oldText: "old", newText: "new", all: false }))[0]!.newBytes!.toString()).toBe("new value");
    expect((await planWriteFileWorkspace(db, workspace, "note.md", "replacement"))[0]!.newBytes!.toString()).toBe("replacement");
    expect((await planSetCellsWorkspace(db, workspace, "sheet.csv", null, [["B2", "9"]]))[0]!.newBytes!.toString()).toBe("a,b\n1,9\n");

    const batch = await planBatchWorkspace(db, workspace, [
      { op: "edit", name: "note.md", oldText: "old", newText: "new" },
      { op: "edit", name: "note.md", oldText: "new", newText: "latest" },
      { op: "rename", name: "note.md", newName: "renamed" },
    ]);
    expect(batch).toHaveLength(1);
    expect(batch[0]!.fileId).toBe(noteId);
    expect(batch[0]!.newBytes!.toString()).toBe("latest value");
    expect(batch[0]!.renameTo).toBe("renamed.md");
    // Single/batch calls read current storage; the batch itself caches repeated
    // edits of the same id before it delegates to the shared planner.
    expect(reads).toBe(4);
    expect(currentBytes(db, sheetId).toString()).toBe("a,b\n1,2\n");
  });

  it("refined exact ambiguity keeps the positional-retry guidance", () => {
    const err = expectEditError(() =>
      computeEditBytes(
        "report.md",
        Buffer.from("# Target\ncost is 5\ncost is 5\n", "utf8"),
        "cost is 5",
        "cost is 7",
        false,
        { section: "Target" },
      )
    );
    expect(err.outcome).toBe("ambiguous");
    expect(err.message).toContain("Add prefix_context/suffix_context");
  });

  it("preserves storage-read failures and absent-byte diagnostics across planners", () => {
    const db = freshRoom();
    const id = seedTextFile(db, "note.md", "old");
    const unreadable = dbWithPrepareFailure(db, (sql) => sql.includes("SELECT original_bytes FROM files"));

    expect(expectEditError(() => computeEdit(unreadable, "note.md", "old", "new", false, {})).outcome).toBe("wrong_type");
    expect(expectEditError(() => planWriteFile(unreadable, "note.md", "new")).outcome).toBe("error");
    expect(expectEditError(() => planSetCells(unreadable, "note.md", null, [["A1", "new"]])).outcome).toBe("error");
    expect(expectPlainError(() => planBatch(unreadable, [{ op: "edit", name: "note.md", oldText: "old", newText: "new" }])).message).toContain("storage unavailable");

    db.prepare("UPDATE files SET original_bytes = NULL WHERE id = ?").run(id);
    expect(expectEditError(() => computeEdit(db, "note.md", "old", "new", false, {})).message).toContain("no stored content");
    expect(expectEditError(() => planSetCells(db, "note.md", null, [["A1", "new"]])).message).toContain("no stored content");
  });

  it("workspace validation retains the public planner error categories", async () => {
    const db = freshRoom();
    seedTextFile(db, "note.md", "old");
    insertFile(db, "image.png", "image/png", Buffer.from([1]), null, "upload");
    const workspace = { readBuffer: async () => Buffer.from("old") } as unknown as Parameters<typeof planSingleEditWorkspace>[1];

    expect(expectEditError(() => planWriteFile(db, "missing.md", "x")).outcome).toBe("not_found");
    await expect(planSingleEditWorkspace(db, workspace, { name: "note.md", oldText: "", newText: "x", all: false })).rejects.toMatchObject({ outcome: "not_found" });
    await expect(planSingleEditWorkspace(db, workspace, { name: "missing.md", oldText: "old", newText: "x", all: false })).rejects.toMatchObject({ outcome: "not_found" });
    await expect(planWriteFileWorkspace(db, workspace, "missing.md", "x")).rejects.toMatchObject({ outcome: "not_found" });
    await expect(planWriteFileWorkspace(db, workspace, "image.png", "x")).rejects.toMatchObject({ outcome: "wrong_type" });
    await expect(planSetCellsWorkspace(db, workspace, "missing.csv", null, [["A1", "x"]])).rejects.toMatchObject({ outcome: "not_found" });
    await expect(planBatchWorkspace(db, workspace, [{ op: "edit", name: "missing.md", oldText: "old", newText: "x" }])).rejects.toThrow("missing.md");
  });

  it("wraps commit write failures as an edit error and retains the batch-failure tag", () => {
    const db = freshRoom();
    seedTextFile(db, "note.md", "old");
    const unwritable = dbWithPrepareFailure(db, (sql) => sql.includes("UPDATE files SET original_bytes"));
    const err = expectEditError(() => runEditFile(unwritable, "note.md", "old", "new", false));
    expect(err.outcome).toBe("error");
    expect(EditError.batchFailure("batch message")).toMatchObject({ message: "batch message", outcome: "failed" });
  });

  it("a replacement that CONTAINS the quote is spliced once, never re-scanned", () => {
    // `split`/`join` rewrites the original string in one pass, exactly like
    // Rust's `String::replace` — a `new_text` of "aa" for an "a" must not
    // cascade into the text it just wrote.
    expect(computeEditBytes("n.md", Buffer.from("a", "utf8"), "a", "aa", false, {}).bytes.toString("utf8")).toBe("aa");
    const all = computeEditBytes("n.md", Buffer.from("a a", "utf8"), "a", "aa", true, {});
    expect(all.count).toBe(2);
    expect(all.bytes.toString("utf8")).toBe("aa aa");
  });

  it("BatchOp carries no refinement fields at all — they are edit_file-only", () => {
    const op: BatchOp = { op: "edit", name: "a.md", oldText: "x", newText: "y" };
    expect("occurrence" in op).toBe(false);
    expect("section" in op).toBe(false);
    expect("all" in op).toBe(false);
  });
});
