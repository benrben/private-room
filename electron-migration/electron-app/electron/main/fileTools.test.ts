/**
 * Tests for `fileTools.ts` — the real `list_room_files` / `search_room` /
 * `open_file` / `annotate_file` arms, plus the `closest_snippet` /
 * `build_annotation` / `parse_a1` / `is_a1_range` helpers ported alongside
 * them.
 *
 * REAL FIXTURE ROOMS via `db-host/open.ts`'s `createRoom`
 * (better-sqlite3-multiple-ciphers), matching this directory's established
 * convention (`db-host/files.test.ts`, `db-host/retrieval.test.ts`,
 * `execTool.test.ts`) — every fixture file is built through the real
 * `insertFile`, so the chunks these arms search and the text they match
 * against are exactly what the app really writes.
 *
 * Several cases are direct ports of `src-tauri/src/commands/agent.rs`'s own
 * `mod tests`: `build_annotation_verifies_quote_verbatim`,
 * `build_annotation_falls_back_to_closest_passage`, and
 * `closest_snippet_anchors_paraphrase_verbatim`. `build_annotation` itself
 * stays private here, so those run through `execAnnotateFile` — strictly more
 * than the Rust test covers, since the arm's own argument reading and effect
 * writing are on the path too.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import { insertFile, markSectionOnly, setFileAiSummary } from "./db-host/files.js";
import {
  closestSnippet,
  execAnnotateFile,
  execListRoomFiles,
  execOpenFile,
  execSearchRoom,
  isA1Range,
  parseA1,
} from "./fileTools.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "file-tools-"));
  const roomPath = path.join(tmpDir, `t-${randomUUID()}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

/** One fixture file, inserted the way the app really inserts one. `text` is
 * the extracted text the retrieval/quote layers see. */
function addFile(
  db: Database.Database,
  name: string,
  text: string | null,
  mime = "text/plain"
): string {
  return insertFile(db, name, mime, Buffer.from(text ?? "", "utf8"), text, "upload").id;
}

function noEffects(): { annotation: unknown } {
  return { annotation: null };
}

const THROWING_EMIT = () => {
  throw new Error("the window is gone");
};

// ------------------------------------------------------------- list_room_files

describe("execListRoomFiles", () => {
  it("reports the empty-room notice", () => {
    const db = freshRoom();
    expect(execListRoomFiles(db)).toEqual({ ok: true, text: "The room has no files." });
  });

  it("lists a file's name, mime and size, with no dash-summary when there is none", () => {
    const db = freshRoom();
    addFile(db, "lease.pdf", "The lease permits one cat.", "application/pdf");
    const bytes = Buffer.byteLength("The lease permits one cat.");
    expect(execListRoomFiles(db)).toEqual({
      ok: true,
      text: `- lease.pdf (application/pdf, ${bytes} bytes)`,
    });
  });

  it("appends the cached one-liner when the file has one", () => {
    const db = freshRoom();
    const id = addFile(db, "notes.md", "some notes");
    setFileAiSummary(db, id, "A short summary of the notes.");
    expect(execListRoomFiles(db)).toEqual({
      ok: true,
      text: "- notes.md (text/plain, 10 bytes) — A short summary of the notes.",
    });
  });

  it("treats a whitespace-only cached summary as no summary at all", () => {
    const db = freshRoom();
    const id = addFile(db, "notes.md", "some notes");
    setFileAiSummary(db, id, "   ");
    expect(execListRoomFiles(db)).toEqual({ ok: true, text: "- notes.md (text/plain, 10 bytes)" });
  });

  it("clamps a very long cached one-liner rather than letting it crowd the prompt", () => {
    const db = freshRoom();
    const id = addFile(db, "notes.md", "some notes");
    setFileAiSummary(db, id, `${"word ".repeat(200)}end`);
    const outcome = execListRoomFiles(db);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toContain("…");
      expect(outcome.text).not.toContain("end");
      expect([...outcome.text].length).toBeLessThan(200);
    }
  });

  it("flags a section-only file, and leaves an ordinary Library file unmarked", () => {
    const db = freshRoom();
    addFile(db, "library.txt", "x");
    const sketchId = addFile(db, "sketch.html", "<p>a drawing</p>", "text/html");
    markSectionOnly(db, sketchId, "sketch");
    const outcome = execListRoomFiles(db);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toContain("- library.txt (text/plain, 1 bytes)\n");
      expect(outcome.text).toContain("[section only — in sketch, not in the Library]");
    }
  });

  it("caps the listing at 100 rows and says how many more there are", () => {
    const db = freshRoom();
    for (let i = 0; i < 105; i++) {
      addFile(db, `file-${String(i).padStart(3, "0")}.txt`, `content ${i}`);
    }
    const outcome = execListRoomFiles(db);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const lines = outcome.text.split("\n");
      expect(lines).toHaveLength(101); // 100 files + the overflow line
      expect(lines[100]).toBe(
        "…and 5 more files — use search_room to find content or open_file by name."
      );
    }
  });
});

// ----------------------------------------------------------------- search_room

describe("execSearchRoom", () => {
  it("reports no match against an empty room", () => {
    const db = freshRoom();
    expect(execSearchRoom(db, { query: "anything" })).toEqual({
      ok: true,
      text: "No matching content found.",
    });
  });

  it("finds a keyword match and returns a verbatim, file-labeled excerpt", () => {
    const db = freshRoom();
    addFile(
      db,
      "lease.pdf",
      "The tenant shall pay a security deposit of one thousand dollars before moving in.",
      "application/pdf"
    );
    const outcome = execSearchRoom(db, { query: "security deposit" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toContain("[lease.pdf]");
      expect(outcome.text.toLowerCase()).toContain("security deposit");
    }
  });

  it("never credits the retrieval layer's recent-content padding as a match (CHG-10)", () => {
    const db = freshRoom();
    addFile(db, "lease.pdf", "The lease permits one cat but no dogs.");
    // No embed model is wired (this port always passes a null question
    // embedding), so a query with no keyword signal at all falls back to
    // padding — which must never be presented as found content.
    expect(execSearchRoom(db, { query: "zzqxw nonexistent gibberish" })).toEqual({
      ok: true,
      text: "No matching content found.",
    });
  });

  it("reads a non-string query as empty rather than throwing", () => {
    const db = freshRoom();
    addFile(db, "notes.txt", "Completely unrelated filler text.");
    expect(execSearchRoom(db, { query: 42 })).toEqual({
      ok: true,
      text: "No matching content found.",
    });
  });
});

// -------------------------------------------------------------- A1 cell parsing

describe("parseA1", () => {
  it("parses ordinary cells to zero-based (row, col)", () => {
    expect(parseA1("A1")).toEqual([0, 0]);
    expect(parseA1("B7")).toEqual([6, 1]);
    expect(parseA1("Z1")).toEqual([0, 25]);
    expect(parseA1("AA1")).toEqual([0, 26]);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(parseA1("b7")).toEqual([6, 1]);
    expect(parseA1("  A1  ")).toEqual([0, 0]);
  });

  it("rejects anything that isn't letters-then-digits", () => {
    expect(parseA1("")).toBeNull();
    expect(parseA1("7")).toBeNull(); // no column letters
    expect(parseA1("B")).toBeNull(); // no row digits
    expect(parseA1("7B")).toBeNull();
    expect(parseA1("B7B")).toBeNull();
    expect(parseA1("B-7")).toBeNull();
  });

  it("rejects a column past XFD (more than three letters) and row 0", () => {
    expect(parseA1("AAAA1")).toBeNull();
    expect(parseA1("A0")).toBeNull();
  });

  it("accepts the row ceiling itself and refuses one past it", () => {
    expect(parseA1("A1048576")).toEqual([1_048_575, 0]);
    expect(parseA1("A1048577")).toBeNull();
  });

  it("refuses a row number far too large to be a row rather than overflowing", () => {
    expect(parseA1("A99999999999999999999999")).toBeNull();
  });
});

describe("isA1Range", () => {
  it("accepts a lone cell or a two-cell range", () => {
    expect(isA1Range("B7")).toBe(true);
    expect(isA1Range("B2:D5")).toBe(true);
  });

  it("rejects a range with either end malformed", () => {
    expect(isA1Range("B2:")).toBe(false);
    expect(isA1Range(":D5")).toBe(false);
    expect(isA1Range("not-a-cell")).toBe(false);
    expect(isA1Range("B2:not-a-cell")).toBe(false);
  });

  it("splits only on the FIRST colon, so a third segment fails the second half", () => {
    expect(isA1Range("A1:B2:C3")).toBe(false);
  });
});

// ---------------------------------------------------------------- closestSnippet

describe("closestSnippet", () => {
  it("anchors a paraphrased quote to the real passage, returned verbatim (ported from agent.rs)", () => {
    const text = "The quarterly revenue was four million dollars this year.";
    const snip = closestSnippet(text, "quarterly revenue was five million");
    expect(snip).not.toBeNull();
    expect(text).toContain(snip as string);
    expect((snip as string).toLowerCase()).toContain("quarterly revenue was");
  });

  it("finds no close passage for unrelated text, and never guesses from a short quote", () => {
    const text = "The quarterly revenue was four million dollars this year.";
    expect(closestSnippet(text, "the weather is sunny today outside")).toBeNull();
    expect(closestSnippet(text, "big money")).toBeNull(); // 2 words: too short
  });

  it("returns null against empty extracted text", () => {
    expect(closestSnippet("", "quarterly revenue was five million")).toBeNull();
  });

  it("is safe over multibyte text and never splits a character", () => {
    const text = "החוזה קובע שהשוכר ישלם דמי שכירות בכל חודש בתחילת החודש.";
    const snip = closestSnippet(text, "השוכר ישלם דמי שכירות בחודש");
    expect(snip).not.toBeNull();
    expect(text).toContain(snip as string);
  });

  it("treats Hebrew points as part of a word, exactly as Rust's is_alphanumeric does", () => {
    // `\p{L}` would drop nikud (they are Mn); Rust's `is_alphanumeric` keeps
    // them, so the comparison key of a pointed word must include them here too
    // — otherwise this port would silently match where Rust does not.
    const pointed = "דִּבְרֵי קֹהֶלֶת בֶּן דָּוִד מֶלֶךְ";
    const snip = closestSnippet(pointed, "דִּבְרֵי קֹהֶלֶת בֶּן דָּוִד");
    expect(snip).not.toBeNull();
    expect(pointed).toContain(snip as string);
    // The consonantal spelling shares no comparison key with the pointed text,
    // so there is no close passage — the same answer agent.rs gives.
    expect(closestSnippet(pointed, "דברי קהלת בן דוד")).toBeNull();
  });
});

// -------------------------------------------------------------------- open_file

describe("execOpenFile", () => {
  it("fails with a helpful error when nothing matches", () => {
    const db = freshRoom();
    const outcome = execOpenFile(db, { name: "nope" });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.error).toContain('No file matching "nope"');
  });

  it("opens a short file, showing its whole text with no tail marker", () => {
    const db = freshRoom();
    addFile(db, "short.txt", "hello world");
    expect(execOpenFile(db, { name: "short" })).toEqual({
      ok: true,
      text: 'Opened "short.txt" in the viewer.\nIt begins:\nhello world',
    });
  });

  it("shows both head and tail for a file long enough to need both", () => {
    const db = freshRoom();
    addFile(db, "long.txt", `${"A".repeat(1500)}${"Z".repeat(900)}`);
    const outcome = execOpenFile(db, { name: "long" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toContain("It begins:");
      expect(outcome.text).toContain("\n…\nIt ends:");
    }
  });

  it("targets a page number over anything else", () => {
    const db = freshRoom();
    addFile(db, "sheet.csv", "a,b,c", "text/csv");
    const outcome = execOpenFile(db, { name: "sheet", page: 3, cell: "B7", find: "a,b,c" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toContain(" at page 3.");
      expect(outcome.text).not.toContain("at cell");
    }
  });

  it("targets a valid cell, and ignores an invalid one", () => {
    const db = freshRoom();
    addFile(db, "budget.xlsx", "some numbers");
    expect(execOpenFile(db, { name: "budget", cell: "B7" }).ok).toBe(true);
    const good = execOpenFile(db, { name: "budget", cell: "B7" });
    expect(good.ok && good.text).toContain(" at cell B7.");
    const bad = execOpenFile(db, { name: "budget", cell: "not-a-cell" });
    expect(bad.ok && bad.text).not.toContain("at cell");
  });

  it("finds an exact quote and reports it with no approximation note", () => {
    const db = freshRoom();
    addFile(db, "lease.pdf", "The lease permits one cat but no dogs.", "application/pdf");
    const outcome = execOpenFile(db, { name: "lease", find: "one cat" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toContain('at "one cat"');
      expect(outcome.text).not.toContain("jumped to the closest");
      expect(outcome.text).not.toContain("opened it from the start");
    }
  });

  it("anchors a paraphrased find to the closest real passage, flagged approximate", () => {
    const db = freshRoom();
    addFile(db, "terms.txt", "Payment is due within thirty days of receipt of invoice.");
    const outcome = execOpenFile(db, { name: "terms", find: "payment due within 30 days" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toContain("jumped to the closest");
      expect(outcome.text).toMatch(/at "Payment is due within thirty days/);
    }
  });

  it("opens plainly, with the other note, when find has no close match at all", () => {
    const db = freshRoom();
    addFile(db, "terms.txt", "Payment is due within thirty days of receipt of invoice.");
    const outcome = execOpenFile(db, { name: "terms", find: "the weather is sunny outside today" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toContain("opened it from the start");
      expect(outcome.text).not.toContain(' at "');
    }
  });

  it("passes a find through unjudged when the file has no extracted text to check it against", () => {
    const db = freshRoom();
    addFile(db, "scan.png", null, "image/png");
    const outcome = execOpenFile(db, { name: "scan", find: "anything at all" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toBe('Opened "scan.png" in the viewer at "anything at all".');
    }
  });

  it("emits agent-open-file with the resolved id/page/cell/find", () => {
    const db = freshRoom();
    const id = addFile(db, "lease.pdf", "The lease permits one cat but no dogs.", "application/pdf");
    const emitted: Array<[string, unknown]> = [];
    execOpenFile(db, { name: "lease", find: "one cat" }, (e, p) => emitted.push([e, p]));
    expect(emitted).toEqual([["agent-open-file", { id, page: null, cell: null, find: "one cat" }]]);
  });

  it("survives an emit callback that throws", () => {
    const db = freshRoom();
    addFile(db, "notes.txt", "hello");
    const outcome = execOpenFile(db, { name: "notes" }, THROWING_EMIT);
    expect(outcome.ok).toBe(true);
  });
});

// ----------------------------------------------------------------- annotate_file

describe("execAnnotateFile", () => {
  it("verifies a verbatim quote and reports it (ported from build_annotation_verifies_quote_verbatim)", () => {
    const db = freshRoom();
    addFile(db, "lease.pdf", "The lease permits one cat but no dogs.", "application/pdf");
    const effects = noEffects();
    const outcome = execAnnotateFile(db, { name: "lease", text: "one cat" }, effects);
    expect(outcome).toEqual({ ok: true, text: 'Sent the viewer to "one cat" in "lease.pdf".' });
    expect(effects.annotation).toMatchObject({ quote: "one cat", approx: false, name: "lease.pdf" });
  });

  it("rejects a quote that is not in the file — the anti-fabrication gate (ported from the same Rust test)", () => {
    const db = freshRoom();
    addFile(db, "lease.pdf", "The lease permits one cat but no dogs.", "application/pdf");
    const effects = noEffects();
    const outcome = execAnnotateFile(db, { name: "lease", text: "three cats" }, effects);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.error).toContain('Could not find that text in "lease.pdf"');
    expect(effects.annotation).toBeNull();
  });

  it("rejects a long quote that is absent and has no close passage either", () => {
    const db = freshRoom();
    addFile(db, "lease.pdf", "The lease permits one cat but no dogs.", "application/pdf");
    const outcome = execAnnotateFile(
      db,
      { name: "lease", text: "the weather is sunny outside today" },
      noEffects()
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.error).toContain("Could not find that text");
  });

  it("falls back to the closest passage for a near-paraphrase, flagged approximate (ported from build_annotation_falls_back_to_closest_passage)", () => {
    const db = freshRoom();
    const text = "Payment is due within thirty days of receipt of invoice.";
    addFile(db, "terms.txt", text);
    const effects = noEffects();
    const outcome = execAnnotateFile(db, { name: "terms", text: "payment due within 30 days" }, effects);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toContain("(closest match)");
    }
    const payload = effects.annotation as { approx: boolean; quote: string };
    expect(payload.approx).toBe(true);
    expect(text).toContain(payload.quote); // the highlight must be verbatim
  });

  it("accepts a cell range with no quote text, upper-casing it (ported from the same Rust test)", () => {
    const db = freshRoom();
    addFile(db, "budget.xlsx", null, "text/csv");
    const effects = noEffects();
    const outcome = execAnnotateFile(db, { name: "budget", range: "b2:d5", sheet: "Q3" }, effects);
    expect(outcome).toEqual({ ok: true, text: 'Sent the viewer to cells B2:D5 in "budget.xlsx".' });
    expect(effects.annotation).toMatchObject({ range: "B2:D5", sheet: "Q3" });
  });

  it("rejects a malformed cell range, quoting what it was given", () => {
    const db = freshRoom();
    addFile(db, "budget.xlsx", null, "text/csv");
    const outcome = execAnnotateFile(db, { name: "budget", range: "not-a-range" }, noEffects());
    expect(outcome).toEqual({
      ok: false,
      error: '"NOT-A-RANGE" is not a cell range — use A1 notation like B7 or B2:D5.',
    });
  });

  it("refuses when neither a quote nor a range was given", () => {
    const db = freshRoom();
    addFile(db, "notes.txt", "some text");
    expect(execAnnotateFile(db, { name: "notes" }, noEffects())).toEqual({
      ok: false,
      error: "Provide either exact text to highlight, or a cell range for spreadsheets.",
    });
  });

  it("fails honestly when no file matches", () => {
    const db = freshRoom();
    const outcome = execAnnotateFile(db, { name: "nope", text: "x" }, noEffects());
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.error).toContain('No file matching "nope"');
  });

  it("emits agent-annotate with the same payload it wrote to effects", () => {
    const db = freshRoom();
    const id = addFile(db, "lease.pdf", "The lease permits one cat but no dogs.", "application/pdf");
    const effects = noEffects();
    const emitted: Array<[string, unknown]> = [];
    execAnnotateFile(db, { name: "lease", text: "one cat" }, effects, (e, p) => emitted.push([e, p]));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.[0]).toBe("agent-annotate");
    expect(emitted[0]?.[1]).toBe(effects.annotation);
    expect(emitted[0]?.[1]).toMatchObject({ fileId: id, quote: "one cat" });
  });

  it("survives an emit callback that throws", () => {
    const db = freshRoom();
    addFile(db, "notes.txt", "hello there");
    const outcome = execAnnotateFile(
      db,
      { name: "notes", text: "hello there" },
      noEffects(),
      THROWING_EMIT
    );
    expect(outcome.ok).toBe(true);
  });
});
