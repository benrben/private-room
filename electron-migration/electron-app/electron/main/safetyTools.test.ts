/**
 * Tests for `safetyTools.ts` — the `commands/safety.rs` port (room/data
 * safety: file versions, quarantine, export, password/duplicate/compact).
 * Real fixture rooms via `createRoom`/`writeCheckpoint`, matching this
 * directory's convention (`fileVersionsList.test.ts`'s own header, and
 * `rekey.test.ts`'s).
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom, openRoom } from "./db-host/open.js";
import {
  deleteFile,
  getFileExtractedText,
  insertFile,
  restoreFile,
  trashFile,
  updateFileContent,
} from "./db-host/files.js";
import { snapshotFileVersion, setFileProvenance } from "./db-host/versions.js";
import { listFileVersions as dbListFileVersions } from "./db-host/fileVersionsList.js";
import { verifyPassword, rekeyCopy } from "./db-host/rekey.js";
import { checkpointCkPaths, checkpointsDir, writeCheckpoint } from "./db-host/checkpoints.js";
import { hasRecovery, writeRecovery } from "./db-host/recovery.js";
import {
  changePassword,
  changePasswordCore,
  compactRoom,
  contentText,
  deleteFileVersion,
  duplicateRoom,
  duplicateRoomCore,
  exportAll,
  exportFile,
  fileVersionsKept,
  getFileProvenance,
  listFileVersions,
  markAsDownloaded,
  pinFileVersion,
  quarantineValue,
  registerSafetyIpc,
  restoreVersionInto,
  safeExportName,
  uniqueExportName,
  versionContent,
  type SafetyRoomSource,
} from "./safetyTools.js";

let tmpDir: string;
let db: Database.Database;
let roomPath = "";

afterEach(() => {
  try {
    db?.close();
  } catch {
    // already closed
  }
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(prefix = "safetyTools-"): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  db = createRoom(roomPath, "correct horse battery staple", "Test Room");
  return db;
}

function addFile(name: string, text: string, mime = "text/plain"): string {
  return insertFile(db, name, mime, Buffer.from(text, "utf8"), text, "upload").id;
}

// ============================================================================
// File versions — thin readers/writers
// ============================================================================

describe("fileVersionsKept / listFileVersions / pinFileVersion / deleteFileVersion", () => {
  it("reaches the real db-host layer, not a stub", () => {
    freshRoom();
    expect(fileVersionsKept()).toBe(10);

    const id = addFile("Plan.md", "v1");
    snapshotFileVersion(db, id, "manual save");
    const versions = listFileVersions(db, id);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.pinned).toBe(false);

    pinFileVersion(db, versions[0]!.id, true);
    expect(listFileVersions(db, id)[0]?.pinned).toBe(true);

    pinFileVersion(db, versions[0]!.id, false);
    deleteFileVersion(db, versions[0]!.id);
    expect(listFileVersions(db, id)).toHaveLength(0);
  });

  it("pinning/deleting an unknown version id refuses rather than silently doing nothing", () => {
    freshRoom();
    expect(() => pinFileVersion(db, "no-such-version", true)).toThrow(
      "That version is no longer available."
    );
    expect(() => deleteFileVersion(db, "no-such-version")).toThrow(
      "That version is no longer available."
    );
  });
});

describe("getFileProvenance", () => {
  it("answers null for a file with no recorded provenance, and the recorded one otherwise", () => {
    freshRoom();
    const id = addFile("Brief.md", "draft");
    expect(getFileProvenance(db, id)).toBeNull();

    setFileProvenance(db, id, JSON.stringify({ agent: "Documents agent", runId: "job-1" }));
    expect(getFileProvenance(db, id)).toEqual({ agent: "Documents agent", runId: "job-1" });
  });
});

// ============================================================================
// contentText — narrow classify_file(...).text slice
// ============================================================================

describe("contentText", () => {
  it("raw-text extensions decode the bytes themselves, ignoring extracted text", () => {
    const bytes = Buffer.from("line one\n  indented two", "utf8");
    expect(contentText("note.txt", "text/plain", bytes, "IGNORED")).toBe("line one\n  indented two");
  });

  it("rich/binary formats show the EXTRACTED text, not the raw bytes", () => {
    const bytes = Buffer.from("%PDF-1.4 binary junk", "utf8");
    expect(contentText("scan.pdf", "application/pdf", bytes, "extracted prose")).toBe("extracted prose");
    expect(contentText("scan.pdf", "application/pdf", bytes, null)).toBeNull();
  });

  it("media (audio/video) shows the transcript, never the raw container bytes", () => {
    const bytes = Buffer.from([0, 1, 2, 3]);
    expect(contentText("clip.mp3", "audio/mpeg", bytes, "hello there")).toBe("hello there");
    expect(contentText("clip.mp3", "audio/mpeg", bytes, null)).toBeNull();
  });

  it("a raw-text row past its byte ceiling degrades to extracted/plain", () => {
    const over = Buffer.alloc(10 * 1024 * 1024 + 1, "a");
    // csv is normally Raw — past MAX_RAW_TEXT_BYTES it must show extracted text
    // (or null), never the raw bytes.
    expect(contentText("big.csv", "text/csv", over, "extracted summary")).toBe("extracted summary");
    expect(contentText("big.csv", "text/csv", over, null)).toBeNull();
  });

  it("an unregistered image extension/mime shows OCR (extracted) text", () => {
    const bytes = Buffer.alloc(64);
    expect(contentText("photo.tiff", "image/tiff", bytes, "scanned text")).toBe("scanned text");
  });

  it("an unregistered plain-text-extension file (code) shows the raw bytes", () => {
    const bytes = Buffer.from("fn main() {}", "utf8");
    expect(contentText("main.rs", "text/plain", bytes, null)).toBe("fn main() {}");
  });

  it("clips a huge text at 1,000,000 UTF-8 bytes with the truncation marker appended after", () => {
    const huge = "a".repeat(1_000_500);
    const clipped = contentText("notes.txt", "text/plain", Buffer.from(huge, "utf8"), null);
    expect(clipped).not.toBeNull();
    expect(clipped!.endsWith("\n\n… (truncated preview)")).toBe(true);
    // 1,000,000 bytes of the original content plus the marker, not reserved
    // out of the 1,000,000 — matching `clip_preview`'s own truncate-then-append.
    expect(Buffer.byteLength(clipped!, "utf8")).toBe(1_000_000 + Buffer.byteLength("\n\n… (truncated preview)"));
  });

  it("EXACTLY MAX_RAW_TEXT_BYTES is still raw; one byte over degrades to extracted", () => {
    // `classify_file`'s ceiling is `len <= max`, so the boundary itself is on
    // the raw side. An off-by-one here is invisible until someone opens a
    // 10 MB CSV and sees the wrong pane.
    const exact = Buffer.alloc(10 * 1024 * 1024, 0x61);
    expect(contentText("big.csv", "text/csv", exact, "extracted")?.startsWith("aaa")).toBe(true);
    const over = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61);
    expect(contentText("big.csv", "text/csv", over, "extracted")).toBe("extracted");
  });

  it("clips on a UTF-8 CHAR boundary, never mid-codepoint (3-byte and 4-byte)", () => {
    // Rust's `clip_preview` walks `cut` back while `!t.is_char_boundary(cut)`.
    // 1,000,000 is not divisible by 3, so a 3-byte-char text must cut at
    // 999,999; an astral char (a JS surrogate PAIR) must not be halved either.
    const marker = "\n\n… (truncated preview)";
    const jp = contentText("notes.txt", "text/plain", Buffer.from("あ".repeat(400_000), "utf8"), null)!;
    const jpBody = jp.slice(0, jp.length - marker.length);
    expect(Buffer.byteLength(jpBody, "utf8")).toBe(999_999);
    expect(jpBody).toBe("あ".repeat(333_333));

    const emoji = contentText("notes.txt", "text/plain", Buffer.from("😀".repeat(250_001), "utf8"), null)!;
    const emojiBody = emoji.slice(0, emoji.length - marker.length);
    expect(emojiBody, "a lone high surrogate was left at the cut").not.toMatch(/[\uD800-\uDBFF]$/);
    expect(Buffer.byteLength(emojiBody, "utf8")).toBe(1_000_000);
  });
});

// ============================================================================
// versionContent (Idea 11) + restoreVersionInto
// ============================================================================

describe("versionContent", () => {
  it("a compound version diffs its stored text against the file's current text", () => {
    freshRoom();
    const fid = addFile("note.txt", "line one\n  indented two");
    snapshotFileVersion(db, fid, "Edited");
    const vid = dbListFileVersions(db, fid)[0]!.id;
    updateFileContent(db, fid, Buffer.from("line one\n  changed two", "utf8"), "line one\n  changed two");

    const vc = versionContent(db, vid);
    expect(vc.fileName).toBe("note.txt");
    expect(vc.versionText).toBe("line one\n  indented two");
    expect(vc.currentText).toBe("line one\n  changed two");
  });

  it("a pre-compound version row with NULL text re-derives it via strict UTF-8", () => {
    freshRoom();
    const fid = addFile("old.txt", "current");
    db.prepare(
      "INSERT INTO file_versions(id, file_id, bytes, text, rec_meta, cause) VALUES ('v-legacy', ?, ?, NULL, NULL, 'legacy')"
    ).run(fid, Buffer.from("legacy bytes", "utf8"));

    const vc = versionContent(db, "v-legacy");
    expect(vc.versionText).toBe("legacy bytes");
    expect(vc.currentText).toBe("current");
  });

  it("a pre-compound version row of BINARY (non-UTF-8) bytes answers null text, not garbled text", () => {
    // Documents this port's one honest fidelity gap: Rust would re-derive this
    // via `extraction::extract_text` (not ported anywhere in this migration);
    // this port falls straight to a STRICT utf8 decode, which correctly fails
    // (rather than a lossy decode inventing replacement-character "text").
    freshRoom();
    const fid = addFile("old.bin", "current");
    const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
    db.prepare(
      "INSERT INTO file_versions(id, file_id, bytes, text, rec_meta, cause) VALUES ('v-bin', ?, ?, NULL, NULL, 'legacy')"
    ).run(fid, invalidUtf8);

    const vc = versionContent(db, "v-bin");
    expect(vc.versionText).toBeNull();
  });

  it("restoring a LEGACY html version indexes its PROSE, never the raw markup", () => {
    // Rust re-derives a NULL-text version through
    // `extraction::extract_text(name, bytes)` BEFORE falling back to a raw
    // UTF-8 decode. Skipping that first arm is not equivalent for any format
    // whose bytes happen to BE valid UTF-8: html markup passes the strict
    // decode, so `<h1>…</h1>` went into `extracted_text` — the search index —
    // where the shipped app puts the stripped text. Expected value is spelled
    // out rather than computed from `extractText`, so this cannot pass by
    // agreeing with itself.
    freshRoom();
    const fid = addFile("page.html", "current", "text/html");
    db.prepare(
      "INSERT INTO file_versions(id, file_id, bytes, text, rec_meta, cause) VALUES ('v-html', ?, ?, NULL, NULL, 'legacy')"
    ).run(fid, Buffer.from("<h1>Hi</h1><p>There  now</p>", "utf8"));

    expect(restoreVersionInto(db, "v-html")).toBe(fid);
    expect(getFileExtractedText(db, fid)).toBe("Hi\nThere now\n");
  });

  it("restoring a LEGACY non-UTF-8 .txt version keeps its text instead of losing it to a strict decode", () => {
    // cp1252/latin-1 bytes fail `String::from_utf8`, so the raw-decode arm
    // alone answered null and the restored file came back with NO indexed
    // text at all. `extract_text`'s text-extension branch reads it.
    freshRoom();
    const fid = addFile("note.txt", "current");
    db.prepare(
      "INSERT INTO file_versions(id, file_id, bytes, text, rec_meta, cause) VALUES ('v-l1', ?, ?, NULL, NULL, 'legacy')"
    ).run(fid, Buffer.from([0x63, 0x61, 0x66, 0xe9])); // "café" in latin-1

    expect(restoreVersionInto(db, "v-l1")).toBe(fid);
    expect(getFileExtractedText(db, fid)).toBe("café");
  });

  it("an unknown version id errors", () => {
    freshRoom();
    expect(() => versionContent(db, "does-not-exist")).toThrow("That version is no longer available.");
  });

  it("a version of a trashed file can neither be read nor restored through, and restores clean afterward", () => {
    freshRoom();
    const fid = addFile("offer.txt", "we offer 90 days");
    snapshotFileVersion(db, fid, "Edited");
    const vid = dbListFileVersions(db, fid)[0]!.id;
    updateFileContent(db, fid, Buffer.from("we offer 30 days", "utf8"), "we offer 30 days");

    trashFile(db, fid, { kind: "user" });

    expect(() => versionContent(db, vid)).toThrow();
    expect(() => restoreVersionInto(db, vid)).toThrow("That file is no longer in this room.");

    // The row is untouched by the refused restore.
    const row = db.prepare("SELECT text FROM file_versions WHERE id = ?").get(vid) as
      | { text: string }
      | undefined;
    expect(row?.text).toBe("we offer 90 days");

    // Restore the file from the trash — everything works again.
    restoreFile(db, fid);
    expect(getFileExtractedText(db, fid)).toBe("we offer 30 days");
    expect(dbListFileVersions(db, fid)).toHaveLength(1);
    expect(restoreVersionInto(db, vid)).toBe(fid);
    expect(getFileExtractedText(db, fid)).toBe("we offer 90 days");
  });

  it("restoring moves ART-1 provenance back with the bytes, clearing it when the version had none", () => {
    freshRoom();
    const fid = addFile("draft.txt", "v1 by a person");
    snapshotFileVersion(db, fid, "hand save"); // version has NO provenance
    const vid = dbListFileVersions(db, fid)[0]!.id;

    // The CURRENT head now claims an AI run.
    setFileProvenance(db, fid, JSON.stringify({ agent: "Documents agent", runId: "job-9" }));
    updateFileContent(db, fid, Buffer.from("v2 by an agent", "utf8"), "v2 by an agent");

    restoreVersionInto(db, vid);

    const row = db.prepare("SELECT provenance FROM files WHERE id = ?").get(fid) as
      | { provenance: string | null }
      | undefined;
    expect(row?.provenance).toBeNull();
    expect(getFileExtractedText(db, fid)).toBe("v1 by a person");
  });
});

// ============================================================================
// quarantine mark
// ============================================================================

describe("quarantineValue", () => {
  it("is flags;hex-timestamp;Arcelle; with no origin URL", () => {
    expect(quarantineValue(0x6890_0000)).toBe("0001;68900000;Arcelle;");
    expect(quarantineValue(0x6890_0000).split(";")).toHaveLength(4);
  });
});

describe.skipIf(process.platform !== "darwin")("markAsDownloaded (macOS only)", () => {
  it("marks a downloaded file but leaves a hand-made file untouched", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "safetyTools-qtn-"));
    const downloaded = path.join(tmpDir, "installer.dmg");
    const handMade = path.join(tmpDir, "notes.txt");
    writeFileSync(downloaded, "payload");
    writeFileSync(handMade, "mine");

    markAsDownloaded(downloaded);

    let value = "";
    try {
      value = execFileSync("xattr", ["-p", "com.apple.quarantine", downloaded], {
        encoding: "utf8",
      }).trim();
    } catch {
      // xattr binary unavailable in this sandbox — nothing to assert.
      return;
    }
    expect(value.split(";")[0]).toBe("0001");
    expect(value).not.toContain("http");
    expect(value.split(";")).toHaveLength(4);

    expect(() =>
      execFileSync("xattr", ["-p", "com.apple.quarantine", handMade], { encoding: "utf8" })
    ).toThrow();
  });
});

// ============================================================================
// safeExportName / uniqueExportName
// ============================================================================

describe("safeExportName", () => {
  it("can never escape the chosen folder", () => {
    expect(safeExportName("../../Library/LaunchAgents/evil.plist")).toBe("evil.plist");
    expect(safeExportName("/etc/passwd")).toBe("passwd");
    expect(safeExportName("a\\b\\c.txt")).toBe("c.txt");
    expect(safeExportName("..")).toBe("unnamed");
    expect(safeExportName("   ")).toBe("unnamed");
    expect(safeExportName("with\0nul.txt")).toBe("with_nul.txt");
    expect(safeExportName("Lease 2026.pdf")).toBe("Lease 2026.pdf");
  });

  it("trims Rust's whitespace set, not JavaScript's — a BOM is a character, a NEL is not", () => {
    // A stored name is never validated on the way IN (a download, a
    // model-generated file and a skill resource all name themselves), so
    // these really can arrive. Rust's `str::trim` is the Unicode
    // `White_Space` property: it KEEPS U+FEFF and REMOVES U+0085.
    // `String.prototype.trim` does the exact opposite on both, which changed
    // the name a file was exported under.
    const BOM = "\u{FEFF}";
    const NEL = "\u{0085}";
    expect(safeExportName(BOM), "a BOM-only name is a name in Rust").toBe(BOM);
    expect(safeExportName(`${BOM}report.pdf`)).toBe(`${BOM}report.pdf`);
    expect(safeExportName(`${NEL}report.pdf${NEL}`)).toBe("report.pdf");
    expect(safeExportName(NEL)).toBe("unnamed");
    // The ordinary whitespace both agree on is unaffected.
    expect(safeExportName("\t\n report.pdf \r\n")).toBe("report.pdf");
    expect(safeExportName(" \u{3000}\u{2009} ")).toBe("unnamed");
  });

  it("a name that is nothing but separators, or a trailing separator, lands on 'unnamed'", () => {
    // `rsplit(['/','\\']).next()` takes the LAST segment, which for a
    // trailing separator is the empty string.
    expect(safeExportName("a/b/")).toBe("unnamed");
    expect(safeExportName("///")).toBe("unnamed");
    expect(safeExportName("")).toBe("unnamed");
    expect(safeExportName(".")).toBe("unnamed");
    // …but a dot-file is a real name, not a "." to be discarded.
    expect(safeExportName("/etc/.gitignore")).toBe(".gitignore");
  });
});

describe("uniqueExportName", () => {
  it("suffixes on a clash and keeps counting", () => {
    const taken = new Set<string>();
    expect(uniqueExportName("fresh.txt", (c) => taken.has(c))).toBe("fresh.txt");

    taken.add("report.pdf");
    expect(uniqueExportName("report.pdf", (c) => taken.has(c))).toBe("report (2).pdf");

    taken.add("report (2).pdf");
    expect(uniqueExportName("report.pdf", (c) => taken.has(c))).toBe("report (3).pdf");

    taken.add("README");
    expect(uniqueExportName("README", (c) => taken.has(c))).toBe("README (2)");

    taken.add(".gitignore");
    expect(uniqueExportName(".gitignore", (c) => taken.has(c))).toBe(".gitignore (2)");
  });

  it("built from the sanitized name, matching the export-all pipeline", () => {
    const taken = new Set(["evil.plist"]);
    expect(uniqueExportName(safeExportName("../evil.plist"), (c) => taken.has(c))).toBe("evil (2).plist");
  });
});

// ============================================================================
// export_file / export_all
// ============================================================================

describe("exportFile", () => {
  it("writes the file's bytes out and refuses a file with no stored content", () => {
    freshRoom();
    const id = addFile("letter.txt", "Dear diary");
    const dest = path.join(tmpDir, "out.txt");
    exportFile(db, id, dest);
    expect(readFileSync(dest, "utf8")).toBe("Dear diary");
  });

  it("refuses when the file id has nothing stored", () => {
    freshRoom();
    expect(() => exportFile(db, "no-such-file", path.join(tmpDir, "x.txt"))).toThrow();
  });
});

describe("exportAll", () => {
  it("writes every file, deduping same-named files against each other", async () => {
    freshRoom();
    addFile("note.txt", "first");
    addFile("../note.txt", "second"); // sanitizes to the SAME name as above

    const outDir = path.join(tmpDir, "out");
    mkdirSync(outDir);
    const written = await exportAll(db, outDir);

    expect(written).toBe(2);
    const names = readdirSync(outDir).sort();
    expect(names).toEqual(["note (2).txt", "note.txt"]);
  });

  it("refuses a destination that isn't a folder", async () => {
    freshRoom();
    await expect(exportAll(db, path.join(tmpDir, "does-not-exist"))).rejects.toThrow(
      "Choose a folder to export into."
    );
  });
});

// ============================================================================
// change_password (SEC-4)
// ============================================================================

describe("changePassword / changePasswordCore", () => {
  it("rekeys the live connection and re-keys every whole-room checkpoint", () => {
    freshRoom();
    addFile("a.txt", "hi");
    const dir = checkpointsDir(roomPath);
    const ckId = writeCheckpoint(db, dir, "cp", false).id;
    const ckPath = checkpointCkPaths(roomPath).find((p) => p.includes(ckId))!;

    expect(() => verifyPassword(ckPath, "correct horse battery staple")).not.toThrow();

    return changePasswordCore(db, roomPath, "correct horse battery staple", "new-password-xx").then(
      (code) => {
        expect(code).toBeNull(); // no recovery sidecar was set up

        // The live connection now answers to the new password.
        expect(() => db.prepare("SELECT 1").get()).not.toThrow();
        db.close();
        const reopened = openRoom(roomPath, "new-password-xx");
        reopened.close();

        // The checkpoint was re-keyed too.
        expect(() => verifyPassword(ckPath, "new-password-xx")).not.toThrow();
        expect(() => verifyPassword(ckPath, "correct horse battery staple")).toThrow();
      }
    );
  });

  it("reports (not silently swallows) a checkpoint that missed the rekey", async () => {
    freshRoom();
    addFile("a.txt", "hi");
    const dir = checkpointsDir(roomPath);
    writeCheckpoint(db, dir, "Before the big edit", false);
    writeCheckpoint(db, dir, "Weekly", false);
    const paths = checkpointCkPaths(roomPath);
    expect(paths).toHaveLength(2);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Sabotage ONE checkpoint file so its rekey fails, exactly like a busy/
    // corrupt copy would in production.
    writeFileSync(paths[0]!, "not a sqlite file");

    const code = await changePasswordCore(db, roomPath, "correct horse battery staple", "new-password-xx");
    expect(code).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("1 checkpoint(s) could not be re-keyed"));

    // The other checkpoint WAS re-keyed.
    expect(() => verifyPassword(paths[1]!, "new-password-xx")).not.toThrow();
    errSpy.mockRestore();
  });

  it("re-wraps the recovery sidecar under the new password when one exists", async () => {
    freshRoom();
    await writeRecovery(roomPath, "correct horse battery staple");
    expect(hasRecovery(roomPath)).toBe(true);

    const newCode = await changePasswordCore(db, roomPath, "correct horse battery staple", "new-password-xx");
    expect(newCode).not.toBeNull();
    expect(typeof newCode).toBe("string");
  });

  it("changePassword refuses a short new password without touching the room", async () => {
    freshRoom();
    await expect(changePassword(db, roomPath, "correct horse battery staple", "short")).rejects.toThrow(
      "Password must be at least 8 characters."
    );
    // Untouched: the original password still opens it.
    expect(() => verifyPassword(roomPath, "correct horse battery staple")).not.toThrow();
  });

  it("changePassword refuses while a rollback is in flight", async () => {
    freshRoom();
    await expect(
      changePassword(db, roomPath, "correct horse battery staple", "new-password-xx", () => true)
    ).rejects.toThrow("The room is rolling back — try again in a moment.");
  });

  it("changePassword rejects the wrong current password and leaves the room untouched", async () => {
    freshRoom();
    await expect(changePassword(db, roomPath, "not-the-password", "new-password-xx")).rejects.toThrow(
      "The current password is not correct."
    );
    expect(() => verifyPassword(roomPath, "correct horse battery staple")).not.toThrow();
  });
});

// ============================================================================
// duplicate_room (ADD-4)
// ============================================================================

describe("duplicateRoom / duplicateRoomCore", () => {
  it("copies the room, keeping the same password when none is given", async () => {
    freshRoom();
    addFile("a.txt", "hello");
    const dest = path.join(tmpDir, "copy.roomai");

    await duplicateRoom(db, "correct horse battery staple", dest, null);

    expect(existsSync(dest)).toBe(true);
    const copy = openRoom(dest, "correct horse battery staple");
    copy.close();
    // The original is unaffected.
    expect(() => verifyPassword(roomPath, "correct horse battery staple")).not.toThrow();
  });

  it("re-keys the copy to a new password without touching the original", async () => {
    freshRoom();
    addFile("a.txt", "hello");
    const dest = path.join(tmpDir, "copy2.roomai");

    await duplicateRoom(db, "correct horse battery staple", dest, "another-password");

    expect(() => verifyPassword(dest, "correct horse battery staple")).toThrow();
    const copy = openRoom(dest, "another-password");
    copy.close();
    expect(() => verifyPassword(roomPath, "correct horse battery staple")).not.toThrow();
  });

  it("refuses a destination that already exists", async () => {
    freshRoom();
    const dest = path.join(tmpDir, "exists.roomai");
    writeFileSync(dest, "already here");
    await expect(duplicateRoom(db, "correct horse battery staple", dest, null)).rejects.toThrow(
      "A file already exists at that location."
    );
  });

  it("refuses a too-short new password before ever touching disk", async () => {
    freshRoom();
    const dest = path.join(tmpDir, "wontexist.roomai");
    await expect(duplicateRoom(db, "correct horse battery staple", dest, "short")).rejects.toThrow(
      "Password must be at least 8 characters."
    );
    expect(existsSync(dest)).toBe(false);
  });

  it("cleans up the copy if re-keying it fails", () => {
    freshRoom();
    addFile("a.txt", "hello");
    const dest = path.join(tmpDir, "bad-rekey.roomai");
    expect(() => duplicateRoomCore(db, "wrong-current-password", dest, "another-password")).toThrow();
    expect(existsSync(dest)).toBe(false);
  });
});

// ============================================================================
// compact_room (SEC-7)
// ============================================================================

describe("compactRoom", () => {
  it("reports nothing to recover on a freshly created room", async () => {
    freshRoom();
    expect(await compactRoom(db)).toBe("Nothing to recover.");
  });

  it("compacts and reports the reclaimed size after deleting a large blob", async () => {
    freshRoom();
    const big = Buffer.alloc(2 * 1024 * 1024, 65);
    const id = insertFile(db, "big.bin", "application/octet-stream", big, null, "upload").id;
    deleteFile(db, id);

    const report = await compactRoom(db);
    expect(report).toMatch(/^Recovered \d+\.\d MB\.$/);
  });
});

// ============================================================================
// IPC wiring shape (not bootstrapped — rule 4)
// ============================================================================

function listener(
  handle: ReturnType<typeof vi.fn>,
  channel: string
): (...args: unknown[]) => unknown {
  const entry = handle.mock.calls.find((c) => c[0] === channel);
  if (entry === undefined) {
    throw new Error(`channel ${channel} was not registered`);
  }
  return entry[1] as (...args: unknown[]) => unknown;
}

describe("registerSafetyIpc", () => {
  const EXPECTED_CHANNELS = [
    "list_file_versions",
    "file_versions_kept",
    "pin_file_version",
    "delete_file_version",
    "get_file_provenance",
    "get_file_version",
    "restore_file_version",
    "export_file",
    "export_all",
    "change_password",
    "duplicate_room",
    "compact_room",
  ];

  function roomSource(open: boolean): SafetyRoomSource {
    return {
      currentRoom: () =>
        open ? { conn: db, path: roomPath, password: "correct horse battery staple" } : null,
    };
  }

  it("registers every channel exactly once", () => {
    freshRoom();
    const handle = vi.fn();
    registerSafetyIpc({ handle }, roomSource(true));
    const channels = handle.mock.calls.map((c) => c[0] as string);
    expect(channels.sort()).toEqual([...EXPECTED_CHANNELS].sort());
    expect(new Set(channels).size).toBe(channels.length);
  });

  it("every handler refuses with NO_ROOM_OPEN when no room is open", async () => {
    freshRoom();
    const handle = vi.fn();
    registerSafetyIpc({ handle }, roomSource(false));

    const argsByChannel: Record<string, unknown> = {
      list_file_versions: { id: "x" },
      pin_file_version: { versionId: "x", pinned: true },
      delete_file_version: { versionId: "x" },
      get_file_provenance: { id: "x" },
      get_file_version: { versionId: "x" },
      restore_file_version: { versionId: "x" },
      export_file: { id: "x", destPath: "/tmp/x" },
      export_all: { destDir: "/tmp" },
      change_password: { current: "a", newPassword: "12345678" },
      duplicate_room: { destPath: "/tmp/x.roomai", newPassword: null },
    };

    for (const [channel, args] of Object.entries(argsByChannel)) {
      await expect(
        Promise.resolve().then(() => listener(handle, channel)({}, args))
      ).rejects.toThrowError("No room is open.");
    }
    await expect(
      Promise.resolve().then(() => listener(handle, "compact_room")({}))
    ).rejects.toThrowError("No room is open.");
    expect(() => listener(handle, "file_versions_kept")({})).not.toThrow(); // needs no open room
  });

  it("restore_file_version emits room-files-changed and file-updated", async () => {
    freshRoom();
    const fid = addFile("a.txt", "one");
    snapshotFileVersion(db, fid, "manual save");
    const vid = dbListFileVersions(db, fid)[0]!.id;
    updateFileContent(db, fid, Buffer.from("two", "utf8"), "two");

    const handle = vi.fn();
    const emitted: [string, unknown][] = [];
    registerSafetyIpc({ handle }, roomSource(true), { emit: (e, p) => emitted.push([e, p]) });

    await listener(handle, "restore_file_version")({}, { versionId: vid });

    expect(emitted).toContainEqual(["room-files-changed", undefined]);
    expect(emitted).toContainEqual(["file-updated", fid]);
  });

  it("change_password calls onPasswordChanged after a successful rotation", async () => {
    freshRoom();
    const handle = vi.fn();
    let changedTo: string | null = null;
    registerSafetyIpc({ handle }, roomSource(true), { onPasswordChanged: (p) => (changedTo = p) });

    await listener(handle, "change_password")(
      {},
      { current: "correct horse battery staple", newPassword: "new-password-xx" }
    );
    expect(changedTo).toBe("new-password-xx");
  });
});
