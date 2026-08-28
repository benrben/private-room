/**
 * Tests for `docsHtml.ts` — the scratch-pad/HTML-first slice of
 * `commands/docs_html.rs` that `execCreateFile` (`organizeTools.ts`)
 * depends on. `htmlDocument`'s wrapping/pass-through behaviour is exercised
 * end-to-end through `execCreateFile` in `organizeTools.test.ts`; these
 * tests cover the smaller pure helpers directly.
 *
 * EXTENDED (2026-08, the `chat_commands/knowledge.rs` batch) with
 * `docs_html.rs`'s own `#[cfg(test)] mod tests` coverage for the five
 * additions that batch made — `refs_context_keeps_every_file_whole`,
 * `name_from_topic_is_path_safe`, `html_note_name_defaults_to_html`, and the
 * `title_from_name`/`doc_hero`/`html_titled_doc` half of `doc_helpers_render`
 * (`file_glyph`, the other half, is still not ported — see this file's own
 * module doc).
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import { insertFile } from "./db-host/files.js";
import {
  htmlDocument,
  htmlEscape,
  htmlNoteName,
  htmlTitledDoc,
  isFullHtmlDoc,
  isScratchPadName,
  nameFromTopic,
  noteMime,
  refsContext,
  refsFiles,
  SCRATCH_PAD_NAME,
  titleFromName,
} from "./docsHtml.js";

describe("SCRATCH_PAD_NAME", () => {
  it("is the canonical name", () => {
    expect(SCRATCH_PAD_NAME).toBe("Scratch pad.md");
  });
});

describe("isScratchPadName", () => {
  it("matches the bare stem, any case, with or without .md", () => {
    expect(isScratchPadName("Scratch pad")).toBe(true);
    expect(isScratchPadName("scratch pad")).toBe(true);
    expect(isScratchPadName("SCRATCH PAD.md")).toBe(true);
    expect(isScratchPadName("  Scratch pad  ")).toBe(true);
  });

  it("never hijacks a deliberate other extension", () => {
    expect(isScratchPadName("Scratch pad.html")).toBe(false);
    expect(isScratchPadName("Scratch pad.txt")).toBe(false);
  });

  it("does not match an unrelated name", () => {
    expect(isScratchPadName("Weekly brief.md")).toBe(false);
  });
});

describe("htmlEscape", () => {
  it("escapes the five HTML-sensitive characters", () => {
    expect(htmlEscape(`<b>"AT&T" & sons</b>`)).toBe("&lt;b&gt;&quot;AT&amp;T&quot; &amp; sons&lt;/b&gt;");
  });
});

describe("isFullHtmlDoc", () => {
  it("recognizes a doctype or html start, case- and whitespace-insensitive", () => {
    expect(isFullHtmlDoc("<!doctype html><html></html>")).toBe(true);
    expect(isFullHtmlDoc("  <HTML><body>x</body></html>")).toBe(true);
    expect(isFullHtmlDoc("<h2>just a fragment</h2>")).toBe(false);
  });
});

describe("noteMime", () => {
  it("maps known extensions and defaults everything else to text/plain", () => {
    expect(noteMime("notes.md")).toBe("text/markdown");
    expect(noteMime("page.html")).toBe("text/html");
    expect(noteMime("data.CSV")).toBe("text/csv");
    expect(noteMime("mystery.xyz")).toBe("text/plain");
    expect(noteMime("noext")).toBe("text/plain");
  });
});

describe("htmlDocument", () => {
  it("wraps a body fragment in a standalone page carrying the title and the inlined notebook CSS", () => {
    const out = htmlDocument("My Page", "<h2>hi</h2>");
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out).toContain("<title>My Page</title>");
    expect(out).toContain("<h2>hi</h2>");
    expect(out).toContain(".doc{max-width:52rem"); // DOC_STYLE landed
    expect(out).toContain(":root{"); // NOTEBOOK_CSS landed
    expect(out).toContain("Arcelle · generated on this Mac");
  });

  it("escapes the title", () => {
    const out = htmlDocument("<script>", "<p>x</p>");
    expect(out).toContain("<title>&lt;script&gt;</title>");
  });

  it("passes a whole document through unwrapped, never double-wrapping it", () => {
    const full = "<!doctype html><html><body>already whole</body></html>";
    expect(htmlDocument("ignored", full)).toBe(full);
  });
});

describe("refsContext / refsFiles", () => {
  let tmpDir: string | null = null;
  let db: Database.Database | null = null;
  afterEach(() => {
    db?.close();
    db = null;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("refs_context_keeps_every_file_whole", () => {
    // The regression this replaces: each file was clamped to 6000 bytes and
    // any file past a shared budget was dropped entirely — which is what
    // made #minutes cover only the opening minutes of a long meeting.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "docs-html-refs-"));
    db = createRoom(path.join(tmpDir, `pr-test-${randomUUID()}.roomai`), "correct horse battery staple", "Test");
    const big = "x".repeat(40_000);
    const a = insertFile(db, "meeting.txt", "text/plain", Buffer.from(big), big, "upload");
    const b = insertFile(db, "notes.md", "text/markdown", Buffer.from("the last word"), "the last word", "upload");
    const [ctx, names] = refsContext(db, [a.id, b.id]);
    expect(names).toEqual(["meeting.txt", "notes.md"]);
    expect(ctx).toContain(big);
    expect(ctx).toContain("the last word");
  });

  it("a ref that no longer resolves is skipped, not an error", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "docs-html-refs-"));
    db = createRoom(path.join(tmpDir, `pr-test-${randomUUID()}.roomai`), "correct horse battery staple", "Test");
    const a = insertFile(db, "real.txt", "text/plain", Buffer.from("hi"), "hi", "upload");
    expect(refsFiles(db, [a.id, "does-not-exist"])).toEqual([["real.txt", "hi"]]);
  });
});

describe("nameFromTopic", () => {
  it("name_from_topic_is_path_safe", () => {
    expect(nameFromTopic("Q3 revenue: AAPL/MSFT!")).toBe("Q3 revenue AAPL MSFT.md");
    expect(nameFromTopic("")).toBe("Note.md");
  });
});

describe("htmlNoteName", () => {
  it("html_note_name_defaults_to_html", () => {
    expect(htmlNoteName("Q3 report")).toBe("Q3 report.html");
    expect(htmlNoteName("")).toBe("Note.html");
  });
});

describe("titleFromName / htmlTitledDoc", () => {
  it("doc_helpers_render", () => {
    expect(titleFromName("Q3 report.html")).toBe("Q3 report");
    expect(titleFromName("notes")).toBe("notes");
    // A model body gets a title header prepended…
    const doc = htmlTitledDoc("Apple.html", "Apple", "<p>Hi</p>");
    expect(doc).toContain("<h1>Apple</h1>");
    expect(doc).toContain("<p>Hi</p>");
    // …but a full page the model already returned passes through untouched.
    const full = "<!doctype html><html><body>x</body></html>";
    expect(htmlTitledDoc("f.html", "F", full)).toBe(full);
  });
});
