/**
 * Tests for `docxEdit.ts` — ported from `docx_edit.rs`'s own `#[cfg(test)]`
 * module (`apply_paragraph_edits`'s six cases), plus real-room coverage for
 * {@link updateDocxText} and the `registerDocxEditIpc` wiring that Rust file
 * has no equivalent of (a Tauri command needs no separate "is it wired"
 * check the way an `ipcMain.handle` registration does).
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import { getFileFull, insertFile } from "./db-host/files.js";
import { buildZip, readZipEntryText } from "./editMatchZip.js";
import { extractText } from "./editMatch.js";
import {
  applyParagraphEdits,
  registerDocxEditIpc,
  updateDocxText,
  type RoomSource,
} from "./docxEdit.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "docxEdit-"));
  const roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

/** Matches `docx_edit.rs`'s own test helper: one `word/document.xml` entry, a
 * `<w:p><w:r><w:t>…</w:t></w:r></w:p>` per paragraph. */
function doc(paras: readonly string[]): Buffer {
  const body = paras.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  return buildZip([
    { name: "word/document.xml", data: Buffer.from(`<w:document>${body}</w:document>`, "utf8") },
  ]);
}

describe("applyParagraphEdits (ported from docx_edit.rs's apply_paragraph_edits tests)", () => {
  it("writes back one edited paragraph and leaves the rest untouched", () => {
    const bytes = doc(["The fee is 5%.", "Payable monthly.", "Signed in Tel Aviv."]);
    const before = extractText("c.docx", bytes)!;
    const after = before.replace("The fee is 5%.", "The fee is 7%.");
    const patched = applyParagraphEdits(bytes, before, after)!;
    expect(patched).not.toBeNull();
    const text = extractText("c.docx", patched)!;
    expect(text).toContain("The fee is 7%.");
    expect(text).toContain("Payable monthly.");
    expect(text).toContain("Signed in Tel Aviv.");
    expect(text).not.toContain("5%");
  });

  it("changes several paragraphs in one save", () => {
    const bytes = doc(["Alpha", "Beta", "Gamma"]);
    const before = extractText("c.docx", bytes)!;
    const after = before.replace("Alpha", "Alpha!").replace("Gamma", "Gamma!");
    const patched = applyParagraphEdits(bytes, before, after)!;
    const text = extractText("c.docx", patched)!;
    expect(text).toContain("Alpha!");
    expect(text).toContain("Gamma!");
    expect(text).toContain("Beta");
  });

  it("refuses to add or remove a paragraph, in plain language", () => {
    const bytes = doc(["One", "Two"]);
    const before = extractText("c.docx", bytes)!;
    expect(() => applyParagraphEdits(bytes, before, `${before}\nThree`)).toThrowError(
      /not add or remove/
    );
    // …and the count is named, so the person can find what they added.
    try {
      applyParagraphEdits(bytes, before, `${before}\nThree`);
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("2");
      expect(msg).toContain("3");
    }
  });

  it("refuses a paragraph repeated verbatim rather than changing both", () => {
    // Editing one of two identical lines would silently rewrite BOTH — the
    // classic destructive find-and-replace.
    const bytes = doc(["Confidential", "Body text", "Confidential"]);
    const before = extractText("c.docx", bytes)!;
    const after = before.replace("Confidential", "Public");
    expect(() => applyParagraphEdits(bytes, before, after)).toThrowError(/appears 2 times/);
  });

  it("an unchanged save writes nothing and is not a failure", () => {
    // It used to be an Err, which the viewer showed as "Could not save" and
    // the unsaved-edits dialog read as "your edit is still here" — so a
    // stray space made the file unclosable except by discarding.
    const bytes = doc(["Same", "Same again"]);
    const before = extractText("c.docx", bytes)!;
    const out = applyParagraphEdits(bytes, before, before);
    expect(out).toBeNull();
  });

  it("an empty document and empty editor are an unchanged save", () => {
    expect(applyParagraphEdits(doc([]), "", "")).toBeNull();
  });

  it("a whitespace-only change is a no-op, not a failed save", () => {
    // The reported repro: a trailing space and a blank line, nothing else.
    const bytes = doc(["Alpha", "Beta"]);
    const before = extractText("c.docx", bytes)!;
    const after = `${before}   \n\n`;
    const out = applyParagraphEdits(bytes, before, after);
    expect(out).toBeNull();
  });

  it("trailing whitespace and blank lines are not read as an added paragraph", () => {
    // An editor adds a trailing newline on save; that must not be read as "a
    // paragraph was added".
    const bytes = doc(["Alpha", "Beta"]);
    const before = extractText("c.docx", bytes)!;
    const after = `${before.replace("Beta", "Beta!")}   \n\n`;
    const patched = applyParagraphEdits(bytes, before, after)!;
    const text = extractText("c.docx", patched)!;
    expect(text).toContain("Beta!");
  });
});

describe("updateDocxText (real fixture room)", () => {
  it("rewrites a paragraph, restores its version history and re-derives its search text", () => {
    const db = freshRoom();
    const bytes = doc(["The fee is 5%.", "Payable monthly."]);
    const meta = insertFile(db, "contract.docx", "application/vnd.openxmlformats", bytes, extractText("contract.docx", bytes), "upload");
    const before = extractText("contract.docx", bytes)!;
    const after = before.replace("5%", "7%");

    const emit = vi.fn();
    const result = updateDocxText(db, meta.id, after, emit);

    expect(result.id).toBe(meta.id);
    const [, , storedBytes, storedText] = getFileFull(db, meta.id);
    const rewritten = extractText("contract.docx", storedBytes!)!;
    expect(rewritten).toContain("7%");
    expect(rewritten).not.toContain("5%");
    expect(storedText).toContain("7%");
    // The broadcast fired.
    expect(emit).toHaveBeenCalledWith("room-files-changed", undefined);
  });

  it("still broadcasts on a no-op save, matching the Rust source's unconditional emit", () => {
    const db = freshRoom();
    const bytes = doc(["Alpha", "Beta"]);
    const meta = insertFile(db, "c.docx", "application/vnd.openxmlformats", bytes, extractText("c.docx", bytes), "upload");
    const before = extractText("c.docx", bytes)!;

    const emit = vi.fn();
    const result = updateDocxText(db, meta.id, before, emit);

    expect(result.id).toBe(meta.id);
    // Nothing was rewritten — the file's bytes are exactly what they were.
    const [, , storedBytes] = getFileFull(db, meta.id);
    expect(Buffer.compare(storedBytes!, bytes)).toBe(0);
    expect(emit).toHaveBeenCalledWith("room-files-changed", undefined);
  });

  it("does not turn an event-listener failure into a failed save", () => {
    const db = freshRoom();
    const bytes = doc(["Unchanged"]);
    const text = extractText("c.docx", bytes)!;
    const meta = insertFile(db, "c.docx", "application/vnd.openxmlformats", bytes, text, "upload");

    expect(() => updateDocxText(db, meta.id, text, () => {
      throw new Error("fabricated listener failure");
    })).not.toThrow();
    expect(getFileFull(db, meta.id)[3]).toBe(text);
  });

  it("refuses a non-docx file by name", () => {
    const db = freshRoom();
    const meta = insertFile(db, "notes.md", "text/plain", Buffer.from("Hello", "utf8"), "Hello", "upload");
    expect(() => updateDocxText(db, meta.id, "Hello there")).toThrowError(/is not a Word document/);
  });

  it("refuses a docx file with no readable text", () => {
    const db = freshRoom();
    // Bytes that are not a valid zip at all, so extraction returns nothing at
    // insert time — `extracted_text` stays NULL.
    const meta = insertFile(db, "broken.docx", "application/vnd.openxmlformats", Buffer.from("not a zip"), null, "upload");
    expect(() => updateDocxText(db, meta.id, "anything")).toThrowError(/no readable text/);
  });

  it("refuses an edit landing in a header/footer/footnote/comment with the paragraph named", () => {
    const db = freshRoom();
    const bytes = buildZip([
      { name: "word/document.xml", data: Buffer.from("<w:p><w:t>The body clause.</w:t></w:p>", "utf8") },
      {
        name: "word/footnotes.xml",
        data: Buffer.from("<w:p><w:t>Subject to the arbitration rider.</w:t></w:p>", "utf8"),
      },
    ]);
    const extracted = extractText("c.docx", bytes)!;
    expect(extracted).toContain("arbitration rider");
    const meta = insertFile(db, "c.docx", "application/vnd.openxmlformats", bytes, extracted, "upload");
    const after = extracted.replace("Subject to the arbitration rider.", "Subject to a different rider.");
    expect(() => updateDocxText(db, meta.id, after)).toThrowError(/footnote or a comment/);
  });

  it("an edit refused for any reason leaves the stored bytes untouched", () => {
    const db = freshRoom();
    const bytes = doc(["One", "Two"]);
    const extracted = extractText("c.docx", bytes)!;
    const meta = insertFile(db, "c.docx", "application/vnd.openxmlformats", bytes, extracted, "upload");
    expect(() => updateDocxText(db, meta.id, `${extracted}\nThree`)).toThrow();
    const [, , storedBytes] = getFileFull(db, meta.id);
    expect(Buffer.compare(storedBytes!, bytes)).toBe(0);
  });

  it("throws (matching the Rust `?` on db::get_file_full) when no id matches", () => {
    const db = freshRoom();
    expect(() => updateDocxText(db, "no-such-id", "anything")).toThrow();
  });
});

// ============================================================================
// Adversarial: malformed/corrupt archives, and the two Unicode-whitespace
// edges where JS's own `.trimEnd()` disagrees with Rust's `char::is_whitespace`
// in OPPOSITE directions. Neither is covered by `docx_edit.rs`'s own tests.
// ============================================================================

describe("adversarial — a malformed or corrupt .docx", () => {
  it("bytes that are not a zip at all are refused in plain language, and the stored bytes survive byte for byte", () => {
    // The reachable shape: `extracted_text` still holds what the reader last
    // showed (so the viewer happily offers Save), while `original_bytes` have
    // rotted — a half-finished restore, a truncated sync. The save must refuse
    // and must not leave a half-written document behind.
    const db = freshRoom();
    const corrupt = Buffer.from("PK and then nothing at all", "latin1");
    const meta = insertFile(db, "c.docx", "application/vnd.openxmlformats", corrupt, "Alpha\nBeta", "upload");

    expect(() => updateDocxText(db, meta.id, "Alpha!\nBeta")).toThrowError(
      /could not be written back into the Word file, so nothing was saved/
    );
    // …and the underlying reason is carried through rather than swallowed,
    // exactly as the Rust source appends `{e}` to its own message.
    try {
      updateDocxText(db, meta.id, "Alpha!\nBeta");
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("not a readable .docx document");
    }
    const [, , storedBytes] = getFileFull(db, meta.id);
    expect(Buffer.compare(storedBytes!, corrupt)).toBe(0);
  });

  it("a perfectly valid zip with no word/document.xml part is refused the same way", () => {
    const db = freshRoom();
    // A .docx-named archive carrying only the parts this rewrite never
    // touches: `docxReplaceText` has nothing to splice into.
    const bytes = buildZip([
      { name: "word/footnotes.xml", data: Buffer.from("<w:p><w:t>Alpha</w:t></w:p>", "utf8") },
    ]);
    const meta = insertFile(db, "c.docx", "application/vnd.openxmlformats", bytes, "Alpha", "upload");
    expect(() => updateDocxText(db, meta.id, "Alpha!")).toThrowError(/not a readable .docx document/);
    const [, , storedBytes] = getFileFull(db, meta.id);
    expect(Buffer.compare(storedBytes!, bytes)).toBe(0);
  });

  it("an archive truncated past its central directory is refused, never half-written", () => {
    const db = freshRoom();
    const good = doc(["Alpha", "Beta"]);
    const truncated = good.subarray(0, good.length - 6);
    const meta = insertFile(db, "c.docx", "application/vnd.openxmlformats", truncated, "Alpha\nBeta", "upload");
    expect(() => updateDocxText(db, meta.id, "Alpha!\nBeta")).toThrowError(
      /could not be written back into the Word file/
    );
    const [, , storedBytes] = getFileFull(db, meta.id);
    expect(Buffer.compare(storedBytes!, truncated)).toBe(0);
  });
});

describe("adversarial — Rust `char::is_whitespace` parity at a paragraph's trailing edge", () => {
  const NEL = String.fromCharCode(0x85);
  const BOM = String.fromCharCode(0xfeff);

  it("a trailing U+0085 (NEL) IS whitespace to Rust, so the save is a no-op — JS's own .trimEnd() disagrees", () => {
    // Pin the divergence itself, so this test says WHY the hand-written
    // `trimEndUnicode` exists rather than looking like a redundant no-op case.
    expect(`Alpha${NEL}`.trimEnd()).toBe(`Alpha${NEL}`);
    // Rust's `str::trim_end()` reads the Unicode White_Space property, which
    // U+0085 has — so the two paragraphs are equal and nothing is rewritten.
    expect(applyParagraphEdits(doc(["Alpha"]), "Alpha", `Alpha${NEL}`)).toBeNull();
  });

  it("a trailing U+FEFF (BOM) is NOT whitespace to Rust, so it IS a real edit — JS's own .trimEnd() disagrees", () => {
    expect(`Alpha${BOM}`.trimEnd()).toBe("Alpha");
    // Rust treats a BOM as an ordinary character, so this is a genuine change
    // and must reach the document. Native `.trimEnd()` would have made it a
    // silent no-op and the user's edit would have vanished on save.
    const patched = applyParagraphEdits(doc(["Alpha"]), "Alpha", `Alpha${BOM}`);
    expect(patched).not.toBeNull();
    expect(readZipEntryText(patched!, "word/document.xml")).toContain(`Alpha${BOM}`);
  });
});

describe("adversarial — snippet's 60-character boundary in the repeated-paragraph refusal", () => {
  function refusalFor(paraLength: number): string {
    const para = "x".repeat(paraLength);
    const bytes = doc([para, "middle", para]);
    try {
      applyParagraphEdits(bytes, `${para}\nmiddle\n${para}`, `changed\nmiddle\n${para}`);
      throw new Error("the repeated paragraph should have been refused");
    } catch (e) {
      return (e as Error).message;
    }
  }

  it("names a 60-character paragraph in full and elides a 61-character one", () => {
    // Rust: `if trimmed.chars().count() <= 60 { return trimmed }` — 60 is IN.
    const at60 = refusalFor(60);
    expect(at60).toContain(`"${"x".repeat(60)}" appears 2 times`);
    expect(at60).not.toContain("…");

    const at61 = refusalFor(61);
    expect(at61).toContain(`"${"x".repeat(60)}…" appears 2 times`);
    // Exactly 60 characters survive the cut, never 61.
    expect(at61).not.toContain("x".repeat(61));
  });
});

describe("registerDocxEditIpc", () => {
  function roomSource(open: boolean, db?: Database.Database): RoomSource {
    return { currentRoom: () => (open && db ? { db, path: "irrelevant.roomai" } : null) };
  }

  it("registers exactly the update_docx_text channel and reaches real logic", async () => {
    const db = freshRoom();
    const bytes = doc(["Alpha", "Beta"]);
    const meta = insertFile(db, "c.docx", "application/vnd.openxmlformats", bytes, extractText("c.docx", bytes), "upload");
    const before = extractText("c.docx", bytes)!;
    const after = before.replace("Alpha", "Alpha!");

    const handle = vi.fn();
    const emit = vi.fn();
    registerDocxEditIpc({ handle } as unknown as { handle: typeof handle }, roomSource(true, db), emit);

    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]![0]).toBe("update_docx_text");
    const listener = handle.mock.calls[0]![1] as (...args: unknown[]) => unknown;
    const result = (await listener({}, { id: meta.id, content: after })) as { id: string };
    expect(result.id).toBe(meta.id);
    expect(emit).toHaveBeenCalledWith("room-files-changed", undefined);
  });

  it("reports no room open the same way every other channel does", () => {
    const handle = vi.fn();
    registerDocxEditIpc({ handle } as unknown as { handle: typeof handle }, roomSource(false));
    const listener = handle.mock.calls[0]![1] as (...args: unknown[]) => unknown;
    expect(() => listener({}, { id: "x", content: "y" })).toThrowError(/No room is open/);
  });
});
