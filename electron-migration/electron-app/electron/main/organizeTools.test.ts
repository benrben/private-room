/**
 * Tests for `organizeTools.ts` — the real `mark_image` / `create_file` /
 * `rename_file` / `move_file` / `set_in_library` / `organize_files` /
 * `trash_files` / `merge_files` exec-tool arms — plus dispatch-level coverage
 * through `execTool.ts` proving the wiring itself (args validation via
 * `missingRequiredArg`, a "No room is open" refusal, and a real success).
 * Mirrors `fileTools.test.ts` (direct arm tests) and `execTool.test.ts`
 * (dispatch-level tests) side by side.
 *
 * REAL FIXTURE ROOMS via `db-host/open.ts`'s `createRoom`, this directory's
 * established convention (`fileTools.test.ts`, `organize.test.ts`,
 * `db-host/artifacts.test.ts`): every fixture file goes through the real
 * `insertFile`, so what these arms resolve, move, rename and write is exactly
 * what the app really stores.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import { createFolder, listFolders } from "./db-host/folders.js";
import {
  fileByExactName,
  getFileExtractedText,
  getFileMeta,
  insertFile,
  listFiles,
  listTrashedFiles,
} from "./db-host/files.js";
import { createToolEffects, execTool, type ExecToolDeps, type ToolEffects } from "./execTool.js";
import {
  execCreateFile,
  execMarkImage,
  execMergeFiles,
  execMoveFile,
  execOrganizeFiles,
  execRenameFile,
  execSetInLibrary,
  execTrashFiles,
  type OrganizeToolOutcome,
} from "./organizeTools.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "organize-tools-"));
  const roomPath = path.join(tmpDir, `t-${randomUUID()}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

function addFile(db: Database.Database, name: string, text: string, mime = "text/plain"): string {
  return insertFile(db, name, mime, Buffer.from(text, "utf8"), text, "upload").id;
}

function addImage(db: Database.Database, name: string): string {
  return insertFile(db, name, "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47]), null, "upload").id;
}

function effects(): ToolEffects {
  return createToolEffects();
}

/** A spy `emit` that records every event fired, for asserting the room's
 * notifications without a real window. */
function events(): { log: Array<[string, unknown]>; emit: (e: string, p: unknown) => void } {
  const log: Array<[string, unknown]> = [];
  return { log, emit: (e, p) => log.push([e, p]) };
}

function text(outcome: OrganizeToolOutcome): string {
  return outcome.ok ? outcome.text : outcome.error;
}

function versionCount(db: Database.Database, fileId: string): number {
  const row = db
    .prepare("SELECT count(*) AS n FROM file_versions WHERE file_id = ?")
    .get(fileId) as { n: number };
  return row.n;
}

function provenanceOf(db: Database.Database, fileId: string): { runId?: string; tool?: string } {
  const row = db.prepare("SELECT provenance FROM files WHERE id = ?").get(fileId) as {
    provenance: string | null;
  };
  return row.provenance === null ? {} : (JSON.parse(row.provenance) as { runId?: string; tool?: string });
}

// ---------------------------------------------------------------- mark_image

describe("execMarkImage", () => {
  it("refuses with the real domain error when no image matches", () => {
    const db = freshRoom();
    const out = execMarkImage(db, { image_name: "vacation", find: "the dog" }, effects());
    expect(out.ok).toBe(false);
    expect(text(out)).toContain('No image matching "vacation"');
  });

  it("reuses an already-marked image this turn (CHG-17) rather than re-grounding it", () => {
    const db = freshRoom();
    const id = addImage(db, "vacation.png");
    const eff = effects();
    eff.boxes = { fileId: id, name: "vacation.png", boxes: [] };
    const out = execMarkImage(db, { image_name: "vacation", find: "the dog" }, eff);
    expect(out).toEqual({ ok: true, text: 'The image "vacation.png" is already marked.' });
  });

  it("finds the image for real, then reports the grounding pass is unported — never a fabricated mark", () => {
    const db = freshRoom();
    addImage(db, "vacation.png");
    const out = execMarkImage(db, { image_name: "vacation", find: "the dog" }, effects());
    expect(out.ok).toBe(false);
    expect(text(out)).toMatch(/^NOT_IMPLEMENTED: /);
    expect(text(out)).toContain('"vacation.png"');
    expect(text(out)).toContain("vision grounding pass");
  });

  it("never claims a fact about what vision models are installed on this Mac", () => {
    // Rust's own refusal says "no vision model is installed on this Mac" —
    // a true statement there, a fabrication here, where the whole subsystem
    // is unported and nothing was ever asked.
    const db = freshRoom();
    addImage(db, "vacation.png");
    const out = execMarkImage(db, { image_name: "vacation", find: "the dog" }, effects());
    expect(text(out)).not.toContain("installed on this Mac");
  });

  it("does not confuse a different image's boxes with this one's (dedupe keys on fileId)", () => {
    const db = freshRoom();
    addImage(db, "vacation.png");
    addImage(db, "other.png");
    const eff = effects();
    eff.boxes = { fileId: "some-other-id", name: "other.png", boxes: [] };
    const out = execMarkImage(db, { image_name: "vacation", find: "the dog" }, eff);
    expect(out.ok).toBe(false);
    expect(text(out)).toMatch(/^NOT_IMPLEMENTED: /);
  });
});

// --------------------------------------------------------------- create_file

describe("execCreateFile — the HTML-first document branch", () => {
  it("defaults an extension-less document to a self-contained HTML page (ADD-22)", () => {
    const db = freshRoom();
    const eff = effects();
    const out = execCreateFile(db, { name: "Q3 plan", content: "<h2>Q3</h2>" }, eff);
    expect(out).toEqual({ ok: true, text: 'Created "Q3 plan.html" in the room.' });
    expect(eff.wrote).toBe(true);
    const meta = fileByExactName(db, "Q3 plan.html")!;
    expect(meta.mimeType).toBe("text/html");
    const body = getFileExtractedText(db, meta.id) ?? "";
    expect(body.trim().toLowerCase().startsWith("<!doctype html>")).toBe(true);
    expect(body).toContain("<h2>Q3</h2>");
  });

  it("wraps with the app's REAL inlined design system, not a look-alike shell", () => {
    // The wrap is `docs_html.rs`'s own `html_document`, whose one `<style>`
    // element carries NOTEBOOK_CSS then DOC_STYLE. A page that opened without
    // them would look like a foreign document inside the room.
    const db = freshRoom();
    execCreateFile(db, { name: "Q3 plan", content: "<h2>Q3</h2>" }, effects());
    const body = getFileExtractedText(db, fileByExactName(db, "Q3 plan.html")!.id) ?? "";
    expect(body).toContain(".doc{max-width:52rem");
    expect(body).toContain("Arcelle · generated on this Mac");
    expect(body).toContain("<title>Q3 plan.html</title>");
  });

  it("does not double-wrap a document the model already returned as a full HTML page", () => {
    const db = freshRoom();
    const full = "<!doctype html><html><body>already whole</body></html>";
    execCreateFile(db, { name: "page.html", content: full }, effects());
    expect(getFileExtractedText(db, fileByExactName(db, "page.html")!.id)).toBe(full);
  });

  it("keeps a non-HTML extension as plain content, unwrapped, with the right mime", () => {
    const db = freshRoom();
    const out = execCreateFile(db, { name: "notes.md", content: "# Notes" }, effects());
    expect(out).toEqual({ ok: true, text: 'Created "notes.md" in the room.' });
    const meta = fileByExactName(db, "notes.md")!;
    expect(meta.mimeType).toBe("text/markdown");
    expect(getFileExtractedText(db, meta.id)).toBe("# Notes");
  });

  it("regenerating the same generated name versions it rather than duplicating it", () => {
    const db = freshRoom();
    const first = execCreateFile(db, { name: "Weekly brief.md", content: "week one" }, effects());
    expect(first).toEqual({ ok: true, text: 'Created "Weekly brief.md" in the room.' });

    const second = execCreateFile(db, { name: "Weekly brief.md", content: "week two" }, effects());
    expect(text(second)).toContain('"Weekly brief.md" already existed');
    expect(listFiles(db)).toHaveLength(1);
    const meta = fileByExactName(db, "Weekly brief.md")!;
    expect(getFileExtractedText(db, meta.id)).toBe("week two");
  });

  it("refuses an empty generated artifact rather than saving a file that looks like finished work", () => {
    const db = freshRoom();
    const eff = effects();
    const out = execCreateFile(db, { name: "Empty.md" }, eff);
    expect(out.ok).toBe(false);
    expect(text(out)).toContain("Nothing was generated");
    expect(fileByExactName(db, "Empty.md")).toBeNull();
    expect(eff.wrote).toBe(false);
  });

  it("honours a Stop pressed before a fresh artifact is committed, and stages nothing behind it", () => {
    const db = freshRoom();
    const eff = effects();
    const out = execCreateFile(db, { name: "Deck.html", content: "<p>slides</p>" }, eff, {
      cancel: { load: () => true },
    });
    expect(out.ok).toBe(false);
    expect(text(out)).toContain("nothing was written to the room");
    expect(fileByExactName(db, "Deck.html")).toBeNull();
    expect(eff.wrote).toBe(false);
    // The staging row was discarded too — a cancelled write leaves no orphan.
    const staged = db.prepare("SELECT count(*) AS n FROM staged_artifacts").get() as { n: number };
    expect(staged.n).toBe(0);
  });

  it("records the run and the tool in the file's provenance", () => {
    const db = freshRoom();
    execCreateFile(db, { name: "notes.md", content: "hi" }, effects(), { runId: "run-42" });
    const prov = provenanceOf(db, fileByExactName(db, "notes.md")!.id);
    expect(prov.tool).toBe("create_file");
    expect(prov.runId).toBe("run-42");
  });

  it("records only the tool when there is no run behind the call (the room bridge's path)", () => {
    const db = freshRoom();
    execCreateFile(db, { name: "notes.md", content: "hi" }, effects());
    const prov = provenanceOf(db, fileByExactName(db, "notes.md")!.id);
    expect(prov).toEqual({ tool: "create_file" });
  });
});

describe("execCreateFile — the shared scratch pad's get-or-create convention", () => {
  it("creates the pad under its CANONICAL name, never an HTML-defaulted variant", () => {
    const db = freshRoom();
    const { emit, log } = events();
    const out = execCreateFile(db, { name: "scratch pad", content: "first note" }, effects(), { emit });
    expect(out).toEqual({ ok: true, text: 'Created "Scratch pad.md" in the room.' });
    expect(getFileExtractedText(db, fileByExactName(db, "Scratch pad.md")!.id)).toBe("first note");
    expect(listFiles(db)).toHaveLength(1);
    expect(log).toEqual([["room-files-changed", undefined]]);
  });

  it("rewrites the existing pad instead of creating a duplicate, and says the notes are kept", () => {
    const db = freshRoom();
    execCreateFile(db, { name: "Scratch pad.md", content: "v1" }, effects());
    const before = fileByExactName(db, "Scratch pad.md")!;

    const eff = effects();
    const { emit, log } = events();
    const out = execCreateFile(db, { name: "scratch pad", content: "v2" }, eff, { emit });
    expect(text(out)).toContain('"Scratch pad.md" already exists — rewrote it');
    expect(eff.wrote).toBe(true);
    expect(listFiles(db)).toHaveLength(1);
    expect(getFileExtractedText(db, before.id)).toBe("v2");
    expect(log.map((e) => e[0])).toEqual(["room-files-changed", "file-updated"]);
  });

  it("keeps the previous notes in History — the pad rewrite really snapshots before it overwrites", () => {
    // `store_file_bytes` is snapshot + overwrite as ONE write. Without the
    // snapshot the sentence above ("the previous notes are kept in History")
    // would be a claim with nothing behind it.
    const db = freshRoom();
    execCreateFile(db, { name: "Scratch pad.md", content: "v1" }, effects());
    const pad = fileByExactName(db, "Scratch pad.md")!;
    expect(versionCount(db, pad.id)).toBe(0);

    execCreateFile(db, { name: "scratch pad", content: "v2" }, effects());
    expect(versionCount(db, pad.id)).toBe(1);
    const version = db
      .prepare("SELECT text, cause FROM file_versions WHERE file_id = ?")
      .get(pad.id) as { text: string; cause: string };
    expect(version.text).toBe("v1");
    expect(version.cause).toBe("AI edit");
  });

  it("moves the head's provenance onto the rewrite", () => {
    const db = freshRoom();
    execCreateFile(db, { name: "Scratch pad.md", content: "v1" }, effects());
    const pad = fileByExactName(db, "Scratch pad.md")!;
    execCreateFile(db, { name: "scratch pad", content: "v2" }, effects(), { runId: "run-9" });
    expect(provenanceOf(db, pad.id)).toEqual({ tool: "create_file", runId: "run-9" });
  });

  it("refuses to blank the pad on empty content, leaving the previous notes intact", () => {
    const db = freshRoom();
    execCreateFile(db, { name: "Scratch pad.md", content: "kept" }, effects());
    const eff = effects();
    const out = execCreateFile(db, { name: "scratch pad", content: "   " }, eff);
    expect(out.ok).toBe(false);
    expect(text(out)).toContain("left as it was");
    expect(getFileExtractedText(db, fileByExactName(db, "Scratch pad.md")!.id)).toBe("kept");
    expect(eff.wrote).toBe(false);
  });

  it("honours a Stop pressed before the pad rewrite lands", () => {
    const db = freshRoom();
    execCreateFile(db, { name: "Scratch pad.md", content: "kept" }, effects());
    const out = execCreateFile(db, { name: "scratch pad", content: "new" }, effects(), {
      cancel: { load: () => true },
    });
    expect(out.ok).toBe(false);
    expect(text(out)).toContain("nothing was written to the room");
    const pad = fileByExactName(db, "Scratch pad.md")!;
    expect(getFileExtractedText(db, pad.id)).toBe("kept");
    expect(versionCount(db, pad.id)).toBe(0);
  });

  it("honours a Stop pressed before a fresh pad is ever saved", () => {
    const db = freshRoom();
    const out = execCreateFile(db, { name: "scratch pad", content: "new" }, effects(), {
      cancel: { load: () => true },
    });
    expect(out.ok).toBe(false);
    expect(text(out)).toContain("nothing was written to the room");
    expect(fileByExactName(db, "Scratch pad.md")).toBeNull();
  });

  it("never hijacks a deliberate other extension — 'Scratch pad.html' is an ordinary document", () => {
    const db = freshRoom();
    const out = execCreateFile(db, { name: "Scratch pad.html", content: "<p>x</p>" }, effects());
    expect(out).toEqual({ ok: true, text: 'Created "Scratch pad.html" in the room.' });
    expect(fileByExactName(db, "Scratch pad.md")).toBeNull();
  });
});

// --------------------------------------------------------------- rename_file

describe("execRenameFile", () => {
  it("requires new_name", () => {
    const db = freshRoom();
    addFile(db, "draft.md", "x");
    const out = execRenameFile(db, { name: "draft.md", new_name: "  " }, effects());
    expect(out).toEqual({ ok: false, error: "new_name is required." });
  });

  it("refuses with the real domain error when nothing matches", () => {
    const db = freshRoom();
    const out = execRenameFile(db, { name: "nope", new_name: "x" }, effects());
    expect(out.ok).toBe(false);
    expect(text(out)).toContain("No file matching");
  });

  it("keeps the original extension when the new name omits one, and reports the write", () => {
    const db = freshRoom();
    addFile(db, "draft.md", "x");
    const eff = effects();
    const { emit, log } = events();
    const out = execRenameFile(db, { name: "draft.md", new_name: "Q3 plan" }, eff, emit);
    expect(out).toEqual({ ok: true, text: 'Renamed "draft.md" to "Q3 plan.md".' });
    expect(eff.wrote).toBe(true);
    expect(listFiles(db)[0]!.name).toBe("Q3 plan.md");
    expect(log.map((e) => e[0])).toEqual(["room-files-changed", "file-updated"]);
  });

  it("honours an explicit new extension rather than forcing the old one", () => {
    const db = freshRoom();
    addFile(db, "draft.md", "x");
    const out = execRenameFile(db, { name: "draft.md", new_name: "notes.txt" }, effects());
    expect(out).toEqual({ ok: true, text: 'Renamed "draft.md" to "notes.txt".' });
  });

  it("resolves the folder-qualified name list_room_files itself prints", () => {
    const db = freshRoom();
    const folder = createFolder(db, "Invoices");
    const id = addFile(db, "q3.pdf", "x");
    db.prepare("UPDATE files SET folder_id = ? WHERE id = ?").run(folder.id, id);
    const out = execRenameFile(db, { name: "Invoices/q3.pdf", new_name: "Q3" }, effects());
    expect(out).toEqual({ ok: true, text: 'Renamed "q3.pdf" to "Q3.pdf".' });
  });
});

// ------------------------------------------------------------ set_in_library

describe("execSetInLibrary", () => {
  it("refuses with the real domain error when nothing matches", () => {
    const db = freshRoom();
    const out = execSetInLibrary(db, { name: "nope", in_library: true }, effects());
    expect(out.ok).toBe(false);
    expect(text(out)).toContain("No file matching");
  });

  it("adds a section-only object to the Library without moving or copying it", () => {
    const db = freshRoom();
    const id = addFile(db, "sketch.png", "");
    db.prepare(
      "UPDATE files SET origin_destination = 'sketch', library_visibility = 'sectionOnly' WHERE id = ?"
    ).run(id);
    const eff = effects();
    const { emit, log } = events();
    const out = execSetInLibrary(db, { name: "sketch.png", in_library: true }, eff, emit);
    expect(out).toEqual({
      ok: true,
      text: 'Added "sketch.png" to the Library. It is still in its own section, and no copy was made.',
    });
    expect(eff.wrote).toBe(true);
    expect(getFileMeta(db, id).libraryVisibility).toBe("linked");
    expect(log).toEqual([
      ["room-files-changed", undefined],
      ["assistant-organized", { id, name: "sketch.png", linked: true }],
    ]);
  });

  it("removes an object from the Library, leaving the object itself untouched", () => {
    const db = freshRoom();
    const id = addFile(db, "sketch.png", "");
    const out = execSetInLibrary(db, { name: "sketch.png", in_library: false }, effects());
    expect(text(out)).toContain('Removed "sketch.png" from the Library');
    expect(getFileMeta(db, id).libraryVisibility).toBe("sectionOnly");
  });

  it("defaults in_library to true when the model omits it", () => {
    const db = freshRoom();
    addFile(db, "sketch.png", "");
    const out = execSetInLibrary(db, { name: "sketch.png" }, effects());
    expect(text(out)).toContain("Added");
  });
});

// ----------------------------------------------------------------- move_file

describe("execMoveFile", () => {
  it("refuses with the real domain error when nothing matches", () => {
    const db = freshRoom();
    const out = execMoveFile(db, { name: "nope", folder: "Invoices" }, effects());
    expect(out.ok).toBe(false);
    expect(text(out)).toContain("No file matching");
  });

  it("creates the destination folder on the way in when it does not exist", () => {
    const db = freshRoom();
    const id = addFile(db, "q3.pdf", "");
    const eff = effects();
    const { emit, log } = events();
    const out = execMoveFile(db, { name: "q3.pdf", folder: "Invoices" }, eff, emit);
    expect(out).toEqual({ ok: true, text: 'Moved "q3.pdf" to "Invoices".' });
    expect(eff.wrote).toBe(true);
    expect(listFolders(db).map((f) => f.name)).toEqual(["Invoices"]);
    expect(getFileMeta(db, id).folderId).toBe(listFolders(db)[0]!.id);
    expect(log).toEqual([["room-files-changed", undefined]]);
  });

  it("reuses an existing folder case-insensitively rather than making a second one", () => {
    const db = freshRoom();
    const folder = createFolder(db, "Invoices");
    addFile(db, "q3.pdf", "");
    execMoveFile(db, { name: "q3.pdf", folder: "invoices" }, effects());
    expect(listFolders(db).map((f) => f.id)).toEqual([folder.id]);
  });

  it("an empty folder argument means the top level", () => {
    const db = freshRoom();
    const folder = createFolder(db, "Invoices");
    const id = addFile(db, "q3.pdf", "");
    execMoveFile(db, { name: "q3.pdf", folder: folder.name }, effects());
    const out = execMoveFile(db, { name: "q3.pdf", folder: "" }, effects());
    expect(out).toEqual({ ok: true, text: 'Moved "q3.pdf" to the top level.' });
    expect(getFileMeta(db, id).folderId).toBeNull();
  });

  it('accepts the whole "top level" vocabulary, case-insensitively, without making a folder', () => {
    const db = freshRoom();
    addFile(db, "q3.pdf", "");
    for (const word of ["none", "TOP", "Top Level", "root", "/"]) {
      const out = execMoveFile(db, { name: "q3.pdf", folder: word }, effects());
      expect(out, word).toEqual({ ok: true, text: 'Moved "q3.pdf" to the top level.' });
    }
    expect(listFolders(db)).toEqual([]);
  });
});

// ------------------------------------------------------------ organize_files

describe("execOrganizeFiles", () => {
  it("refuses an entirely empty plan rather than reporting a cheerful nothing", () => {
    const db = freshRoom();
    const out = execOrganizeFiles(db, {}, effects());
    expect(out).toEqual({
      ok: false,
      error: "organize_files needs at least one entry in files, make_folders or remove_folders.",
    });
  });

  it("a dry run changes nothing, emits nothing, and never flips effects.wrote", () => {
    const db = freshRoom();
    addFile(db, "q3.pdf", "");
    const eff = effects();
    const { emit, log } = events();
    const out = execOrganizeFiles(
      db,
      { files: [{ name: "q3.pdf", folder: "Invoices", new_name: "b" }], dry_run: true },
      eff,
      emit
    );
    expect(out.ok).toBe(true);
    expect(text(out).startsWith("PREVIEW ONLY")).toBe(true);
    expect(eff.wrote).toBe(false);
    expect(listFolders(db)).toEqual([]);
    expect(listFiles(db)[0]!.name).toBe("q3.pdf");
    expect(log).toEqual([]);
  });

  it("moves and renames in one call, remapping the raw new_name key, and reports the write", () => {
    const db = freshRoom();
    const id = addFile(db, "q3.pdf", "");
    const eff = effects();
    const { emit, log } = events();
    const out = execOrganizeFiles(
      db,
      { files: [{ name: "q3.pdf", folder: "Invoices", new_name: "Q3 invoice" }] },
      eff,
      emit
    );
    expect(out.ok).toBe(true);
    expect(text(out)).toContain("moved");
    expect(text(out)).toContain("renamed");
    expect(eff.wrote).toBe(true);
    const meta = getFileMeta(db, id);
    expect(meta.name).toBe("Q3 invoice.pdf");
    expect(meta.folderId).not.toBeNull();
    expect(log).toEqual([["room-files-changed", undefined]]);
  });

  it("a malformed entry empties the whole plan rather than half-applying it", () => {
    const db = freshRoom();
    addFile(db, "a.txt", "x");
    const out = execOrganizeFiles(db, { files: [{ name: 123 }] }, effects());
    // No usable entry survives translation and nothing else was asked for, so
    // this is the same empty-plan refusal as supplying nothing at all.
    expect(out.ok).toBe(false);
    expect(text(out)).toContain("needs at least one entry");
  });

  it("does not un-set an earlier write in the same turn when the plan matches nothing", () => {
    const db = freshRoom();
    const eff = effects();
    eff.wrote = true;
    const out = execOrganizeFiles(db, { files: [{ name: "does-not-exist" }] }, eff);
    expect(out.ok).toBe(true);
    expect(eff.wrote).toBe(true);
  });
});

// --------------------------------------------------------------- trash_files

describe("execTrashFiles", () => {
  it("requires at least one name", () => {
    const db = freshRoom();
    expect(execTrashFiles(db, {}, effects())).toEqual({
      ok: false,
      error: "trash_files needs at least one file name.",
    });
  });

  it("trashes matched files, reports misses, and always names the way back", () => {
    const db = freshRoom();
    addFile(db, "old draft.md", "x");
    const eff = effects();
    const { emit, log } = events();
    const out = execTrashFiles(db, { names: ["old draft.md", "ghost.md"] }, eff, emit);
    expect(out.ok).toBe(true);
    expect(text(out)).toContain('"old draft.md" moved to the trash.');
    expect(text(out)).toContain('Not found: "ghost.md".');
    expect(text(out)).toContain("recoverable from Library → Trash.");
    expect(eff.wrote).toBe(true);
    expect(listFiles(db)).toHaveLength(0);
    expect(log).toEqual([["room-files-changed", undefined]]);
  });

  it("records the AGENT as the deleter, so the trash can answer 'what did the AI remove'", () => {
    const db = freshRoom();
    addFile(db, "old draft.md", "x");
    execTrashFiles(db, { names: ["old draft.md"] }, effects());
    const trashed = listTrashedFiles(db);
    expect(trashed.map((f) => f.trashedBy)).toEqual(["agent"]);
  });

  it("a batch that matches nothing does not flip effects.wrote", () => {
    const db = freshRoom();
    const eff = effects();
    const out = execTrashFiles(db, { names: ["ghost.md"] }, eff);
    expect(out.ok).toBe(true);
    expect(eff.wrote).toBe(false);
  });
});

// --------------------------------------------------------------- merge_files

describe("execMergeFiles", () => {
  it("refuses (the real merge() error) rather than producing half a document", () => {
    const db = freshRoom();
    addFile(db, "ch1.md", "chapter one");
    const out = execMergeFiles(db, { names: ["ch1.md", "ghost.md"], into: "Book.md" }, effects());
    expect(out.ok).toBe(false);
    expect(text(out)).toContain("needs at least two files");
  });

  it("joins the sources into one new file and reports the write", () => {
    const db = freshRoom();
    addFile(db, "ch1.md", "chapter one");
    addFile(db, "ch2.md", "chapter two");
    const eff = effects();
    const { emit, log } = events();
    const out = execMergeFiles(db, { names: ["ch1.md", "ch2.md"], into: "Book.md" }, eff, emit);
    expect(out.ok).toBe(true);
    expect(text(out)).toContain('Merged 2 files into "Book.md"');
    expect(eff.wrote).toBe(true);
    expect(log).toEqual([["room-files-changed", undefined]]);
    const body = getFileExtractedText(db, fileByExactName(db, "Book.md")!.id) ?? "";
    expect(body).toContain("chapter one");
    expect(body).toContain("chapter two");
  });

  it("leaves the sources alone by default, and trashes them only when asked", () => {
    const db = freshRoom();
    addFile(db, "ch1.md", "chapter one");
    addFile(db, "ch2.md", "chapter two");
    execMergeFiles(db, { names: ["ch1.md", "ch2.md"], into: "Kept.md" }, effects());
    expect(listTrashedFiles(db)).toEqual([]);

    execMergeFiles(
      db,
      { names: ["ch1.md", "ch2.md"], into: "Book.md", trash_sources: true },
      effects()
    );
    expect(
      listTrashedFiles(db)
        .map((f) => f.name)
        .sort()
    ).toEqual(["ch1.md", "ch2.md"]);
  });
});

// ------------------------------------------------- dispatch-level: execTool.ts

describe("execTool.ts dispatch for the eight organize-box arms", () => {
  const ARMS = [
    ["mark_image", { image_name: "x", find: "y" }],
    ["create_file", { name: "x", content: "y" }],
    ["rename_file", { name: "x", new_name: "y" }],
    ["move_file", { name: "x", folder: "y" }],
    ["set_in_library", { name: "x", in_library: true }],
    ["organize_files", { files: [{ name: "x" }] }],
    ["trash_files", { names: ["x"] }],
    ["merge_files", { names: ["x", "y"], into: "z" }],
  ] as const;

  function deps(overrides: Partial<ExecToolDeps> = {}): ExecToolDeps {
    return { db: null, routes: [], ...overrides };
  }

  it("every one of the eight refuses honestly with no room open — not a stub, not a crash", async () => {
    for (const [name, args] of ARMS) {
      const outcome = await execTool(name, args, effects(), deps());
      expect(outcome, name).toEqual({ ok: false, error: "No room is open." });
    }
  });

  it("missingRequiredArg still gates these arms before any real dispatch runs", async () => {
    const outcome = await execTool("rename_file", { name: "x" }, effects(), deps());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("new_name is required");
      expect(outcome.error).not.toContain("No room is open");
    }
  });

  it("create_file reaches the real arm and honours deps.cancel", async () => {
    const db = freshRoom();
    const outcome = await execTool(
      "create_file",
      { name: "Deck.html", content: "<p>x</p>" },
      effects(),
      deps({ db, cancel: { load: () => true } })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("nothing was written to the room");
    }
    expect(fileByExactName(db, "Deck.html")).toBeNull();
  });

  it("create_file threads deps.runId into the written file's provenance", async () => {
    const db = freshRoom();
    await execTool(
      "create_file",
      { name: "notes.md", content: "hi" },
      effects(),
      deps({ db, runId: "run-7" })
    );
    expect(provenanceOf(db, fileByExactName(db, "notes.md")!.id)).toEqual({
      tool: "create_file",
      runId: "run-7",
    });
  });

  it("organize_files reaches the real arm end to end and reports the write via effects", async () => {
    const db = freshRoom();
    addFile(db, "q3.pdf", "");
    const eff = effects();
    const outcome = await execTool(
      "organize_files",
      { files: [{ name: "q3.pdf", folder: "Invoices" }] },
      eff,
      deps({ db })
    );
    expect(outcome.ok).toBe(true);
    expect(eff.wrote).toBe(true);
    expect(listFolders(db).map((f) => f.name)).toEqual(["Invoices"]);
  });

  it("the room's emit callback reaches these arms through deps", async () => {
    const db = freshRoom();
    addFile(db, "draft.md", "x");
    const { emit, log } = events();
    await execTool(
      "rename_file",
      { name: "draft.md", new_name: "Final" },
      effects(),
      deps({ db, emit })
    );
    expect(log.map((e) => e[0])).toEqual(["room-files-changed", "file-updated"]);
  });
});
