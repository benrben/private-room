/**
 * Tests for `spreadsheetTools.ts` — real-room coverage for {@link setCell}
 * (the `set_cell` `#[tauri::command]` port) and the `registerSpreadsheetIpc`
 * wiring, which has no Rust equivalent to port tests FROM (a Tauri command
 * needs no separate "is it wired" check the way an `ipcMain.handle`
 * registration does — same shape as `docxEdit.test.ts`'s own split).
 *
 * The pure CSV/TSV cell-editing logic itself (`setCellInBytes`,
 * `parseDelim`, `guessSep`, …) is already covered by `editMatchCells.test.ts`
 * and `fileTools.test.ts` (`parseA1`/`isA1Range`) — not re-tested here, per
 * this batch's "reuse rather than duplicate" instruction. These tests only
 * exercise the glue `spreadsheet.rs`'s `set_cell` actually adds: resolving a
 * real room file by id, writing the result back through `storeFileBytes`,
 * and the two-event broadcast (or its absence on every error path).
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import { getFileFull, insertFile, trashFile } from "./db-host/files.js";
import { listFileVersions } from "./db-host/fileVersionsList.js";
import { registerSpreadsheetIpc, setCell, type RoomSource } from "./spreadsheetTools.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "spreadsheetTools-"));
  const roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

describe("setCell", () => {
  it("writes one cell into a real room's csv file and re-derives its searchable text", () => {
    const db = freshRoom();
    const meta = insertFile(db, "budget.csv", "text/csv", Buffer.from("name,total\nalpha,5\n", "utf8"), "name,total\nalpha,5\n", "upload");

    setCell(db, meta.id, null, "B2", "7");

    const [, , storedBytes, extracted] = getFileFull(db, meta.id);
    expect(storedBytes!.toString("utf8")).toBe("name,total\nalpha,7\n");
    expect(extracted).toBe("name,total\nalpha,7\n");
  });

  it("snapshots the prior version, matching storeFileBytes's single write path", () => {
    const db = freshRoom();
    const meta = insertFile(db, "t.csv", "text/csv", Buffer.from("a,b\n1,2\n", "utf8"), "a,b\n1,2\n", "upload");
    setCell(db, meta.id, null, "B2", "9");
    const versions = listFileVersions(db, meta.id);
    expect(versions.length).toBeGreaterThan(0);
  });

  it("guesses the separator the grid actually shows, same as a semicolon-delimited file", () => {
    // The grid's reader guesses the separator, so writing on a hard-coded
    // comma would land the value at the end of the row instead of at B2.
    const db = freshRoom();
    const meta = insertFile(db, "data.csv", "text/csv", Buffer.from("name;total\nalpha;5\n", "utf8"), "name;total\nalpha;5\n", "upload");
    setCell(db, meta.id, null, "B2", "7");
    const [, , storedBytes] = getFileFull(db, meta.id);
    expect(storedBytes!.toString("utf8")).toBe("name;total\nalpha;7\n");
  });

  it("quotes a written value that starts with a formula-trigger character", () => {
    const db = freshRoom();
    const meta = insertFile(db, "t.csv", "text/csv", Buffer.from("a,b\n1,2\n", "utf8"), "a,b\n1,2\n", "upload");
    setCell(db, meta.id, null, "B2", "=SUM(A1:A2)");
    const [, , storedBytes] = getFileFull(db, meta.id);
    expect(storedBytes!.toString("utf8")).toBe('a,b\n1,"=SUM(A1:A2)"\n');
  });

  it("throws (matching the Rust `?` on get_file_bytes_named) when no id matches", () => {
    const db = freshRoom();
    expect(() => setCell(db, "no-such-id", null, "A1", "x")).toThrow();
  });

  it("throws 'File has no stored content.' for a NULL bytes column — the Rust source's own .ok_or(...) guard", () => {
    const db = freshRoom();
    const meta = insertFile(db, "t.csv", "text/csv", Buffer.from("a,b\n1,2\n", "utf8"), "a,b\n1,2\n", "upload");
    // insertFile always writes a real (possibly empty) buffer; force the
    // NULL case directly, matching visionTools.test.ts's/previewTools.test.ts's
    // own precedent for reaching this otherwise-unreachable-via-API branch.
    db.prepare("UPDATE files SET original_bytes = NULL WHERE id = ?").run(meta.id);
    expect(() => setCell(db, meta.id, null, "A1", "x")).toThrowError("File has no stored content.");
  });

  it("an empty (but non-null) bytes column is not the same as 'no content' — the grid just grows to reach the cell", () => {
    // Empty bytes are still Some(vec![]) in Rust, not None — parse_delim on
    // empty text yields no rows, and set_cell_in_bytes grows the grid to
    // reach the cell rather than refusing. Pin the two branches apart.
    const db = freshRoom();
    const meta = insertFile(db, "t.csv", "text/csv", Buffer.alloc(0), null, "upload");
    setCell(db, meta.id, null, "A1", "x");
    const [, , storedBytes] = getFileFull(db, meta.id);
    expect(storedBytes!.toString("utf8")).toBe("x\n");
  });

  it("rejects a malformed cell reference in plain language", () => {
    const db = freshRoom();
    const meta = insertFile(db, "t.csv", "text/csv", Buffer.from("a,b\n1,2\n", "utf8"), "a,b\n1,2\n", "upload");
    expect(() => setCell(db, meta.id, null, "not-a-cell", "x")).toThrowError(/is not a cell/);
    // Nothing was written on the refused call.
    const [, , storedBytes] = getFileFull(db, meta.id);
    expect(storedBytes!.toString("utf8")).toBe("a,b\n1,2\n");
  });

  it("refuses a non-UTF-8 csv file rather than mangling it, and leaves the bytes untouched", () => {
    const db = freshRoom();
    const latin1 = Buffer.from([0x6e, 0x6f, 0x6d, 0x2c, 0x76, 0x69, 0x6c, 0x6c, 0x65, 0x0a, 0x52, 0x65, 0x6e, 0xe9, 0x2c, 0x4e, 0x0a]); // "nom,ville\nRen\xE9,N\n"
    const meta = insertFile(db, "t.csv", "text/csv", latin1, null, "upload");
    expect(() => setCell(db, meta.id, null, "B2", "Paris")).toThrowError(/UTF-8/);
    const [, , storedBytes] = getFileFull(db, meta.id);
    expect(Buffer.compare(storedBytes!, latin1)).toBe(0);
  });

  it("reports the honest not-yet-supported refusal for .xlsx rather than fabricating a write", () => {
    const db = freshRoom();
    const meta = insertFile(db, "sheet.xlsx", "application/vnd.openxmlformats", Buffer.from("PK fake"), null, "upload");
    expect(() => setCell(db, meta.id, null, "A1", "x")).toThrowError(/not supported by this port/i);
  });

  it("refuses an unsupported file type outright", () => {
    const db = freshRoom();
    const meta = insertFile(db, "notes.txt", "text/plain", Buffer.from("hi"), "hi", "upload");
    expect(() => setCell(db, meta.id, null, "A1", "x")).toThrowError(/not an editable spreadsheet/);
  });

  it("refuses to edit a TRASHED file, and fires no event — the read is trash-aware", () => {
    // ADVERSARIAL ADDITION (verification pass): `get_file_bytes_named`'s SQL
    // carries `AND trashed_at IS NULL`, and the whole point of that clause on
    // the READ side is that the viewer's grid cannot write into a row the user
    // has already deleted (the same class of "silently rewritten where nobody
    // can see it" bug `write_room_summary`'s own re-check exists for). Nothing
    // in this suite exercised the trashed case: every existing test hits a
    // live row or a wholly unknown id, so a port that dropped `trashed_at IS
    // NULL` from the query would have passed all of them.
    const db = freshRoom();
    const meta = insertFile(db, "t.csv", "text/csv", Buffer.from("a,b\n1,2\n", "utf8"), "a,b\n1,2\n", "upload");
    trashFile(db, meta.id, { kind: "user" });

    const emit = vi.fn();
    expect(() => setCell(db, meta.id, null, "B2", "9", emit)).toThrow();
    expect(emit).not.toHaveBeenCalled();
    // The trashed row's bytes are untouched, so restoring it from the trash
    // still hands back what the user actually deleted.
    const row = db.prepare("SELECT original_bytes FROM files WHERE id = ?").get(meta.id) as {
      original_bytes: Buffer;
    };
    expect(row.original_bytes.toString("utf8")).toBe("a,b\n1,2\n");
  });

  it("edits a .tsv on the TAB grid the viewer shows — the delimiter comes from the content, never the extension", () => {
    // ADVERSARIAL ADDITION (verification pass): the `.tsv` half of the
    // csv|tsv branch had no end-to-end coverage here at all. It matters
    // because the delimiter is NOT derived from the extension — `read_as`
    // runs SheetJS's `guess_sep` over the text, which is what decides which
    // field the address "B2" names. A port that shortcut ".tsv means tab"
    // would look right on this file and land the wrong cell on the next two.
    const db = freshRoom();
    const tsv = insertFile(db, "grid.tsv", "text/tab-separated-values", Buffer.from("name\ttotal\nalpha\t5\n", "utf8"), null, "upload");
    setCell(db, tsv.id, null, "B2", "7");
    expect((getFileFull(db, tsv.id)[2] as Buffer).toString("utf8")).toBe("name\ttotal\nalpha\t7\n");

    // A .tsv whose content is actually comma-separated is edited on the COMMA
    // grid, because that is the grid the viewer drew.
    const oddly = insertFile(db, "commas.tsv", "text/tab-separated-values", Buffer.from("name,total\nalpha,5\n", "utf8"), null, "upload");
    setCell(db, oddly.id, null, "B2", "7");
    expect((getFileFull(db, oddly.id)[2] as Buffer).toString("utf8")).toBe("name,total\nalpha,7\n");
  });

  it("fires room-files-changed then file-updated, in order, only after a real write", () => {
    const db = freshRoom();
    const meta = insertFile(db, "t.csv", "text/csv", Buffer.from("a,b\n1,2\n", "utf8"), "a,b\n1,2\n", "upload");
    const emit = vi.fn();
    setCell(db, meta.id, null, "B2", "9", emit);
    expect(emit.mock.calls).toEqual([
      ["room-files-changed", undefined],
      ["file-updated", meta.id],
    ]);
  });

  it("fires no event at all on a refused edit — both emits sit after the write in the Rust source", () => {
    const db = freshRoom();
    const meta = insertFile(db, "t.csv", "text/csv", Buffer.from("a,b\n1,2\n", "utf8"), "a,b\n1,2\n", "upload");
    const emit = vi.fn();
    expect(() => setCell(db, meta.id, null, "not-a-cell", "x", emit)).toThrow();
    expect(emit).not.toHaveBeenCalled();
  });

  it("a best-effort emit that itself throws never turns a successful edit into a failure", () => {
    const db = freshRoom();
    const meta = insertFile(db, "t.csv", "text/csv", Buffer.from("a,b\n1,2\n", "utf8"), "a,b\n1,2\n", "upload");
    const emit = vi.fn(() => {
      throw new Error("renderer window is gone");
    });
    expect(() => setCell(db, meta.id, null, "B2", "9", emit)).not.toThrow();
    const [, , storedBytes] = getFileFull(db, meta.id);
    expect(storedBytes!.toString("utf8")).toBe("a,b\n1,9\n");
  });
});

describe("registerSpreadsheetIpc", () => {
  function roomSource(open: boolean, db?: Database.Database): RoomSource {
    return { currentRoom: () => (open && db ? { db, path: "irrelevant.roomai" } : null) };
  }

  it("registers exactly the set_cell channel and reaches real logic", async () => {
    const db = freshRoom();
    const meta = insertFile(db, "t.csv", "text/csv", Buffer.from("a,b\n1,2\n", "utf8"), "a,b\n1,2\n", "upload");

    const handle = vi.fn();
    const emit = vi.fn();
    registerSpreadsheetIpc({ handle } as unknown as { handle: typeof handle }, roomSource(true, db), emit);

    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]![0]).toBe("set_cell");
    const listener = handle.mock.calls[0]![1] as (...args: unknown[]) => unknown;
    const result = await listener({}, { id: meta.id, sheet: null, cell: "B2", value: "9" });
    expect(result).toBeUndefined();
    const [, , storedBytes] = getFileFull(db, meta.id);
    expect(storedBytes!.toString("utf8")).toBe("a,b\n1,9\n");
    expect(emit).toHaveBeenCalledWith("room-files-changed", undefined);
    expect(emit).toHaveBeenCalledWith("file-updated", meta.id);
  });

  it("reports no room open the same way every other channel does", () => {
    const handle = vi.fn();
    registerSpreadsheetIpc({ handle } as unknown as { handle: typeof handle }, roomSource(false));
    const listener = handle.mock.calls[0]![1] as (...args: unknown[]) => unknown;
    expect(() => listener({}, { id: "x", sheet: null, cell: "A1", value: "y" })).toThrowError(/No room is open/);
  });
});
