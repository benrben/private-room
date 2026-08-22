/**
 * Vitest port of `src-tauri/src/db/folders.rs`'s `mod tests`, 1:1:
 *
 *   - deleting_a_folder_keeps_its_files
 *   - folder_writes_refuse_a_folder_that_is_gone
 *   - moving_a_file_that_is_gone_is_not_a_move
 *   - folder_names_are_unique
 *   - folder_names_are_unique_ignoring_case
 *
 * REAL FIXTURE ROOMS: every test opens a real `.roomai` file through
 * `createRoom` (this directory's established convention — see
 * `chats.test.ts`), and the Rust suite's `add_file`/`get_file_meta`/
 * `list_files`/`trash_file` helpers are the REAL `files.ts` functions of the
 * same name, already ported and shipping, rather than stand-ins.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./open.js";
import { getFileMeta, insertFile, listFiles, trashFile } from "./files.js";
import {
  createFolder,
  deleteFolder,
  listFolders,
  moveFileToFolder,
  renameFolder,
} from "./folders.js";

let tmpDir: string | null = null;
let open: Database.Database | null = null;

// Closing in the teardown (rather than at the end of each test body) so a
// failing assertion cannot leak the handle into the next test.
afterEach(() => {
  open?.close();
  open = null;
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-folders-"));
  const roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  open = createRoom(roomPath, "correct horse battery staple", "Test Room");
  return open;
}

function addFile(db: Database.Database, name: string, body: string): string {
  return insertFile(db, name, "text/plain", Buffer.from(body, "utf8"), body, "upload").id;
}

describe("folders", () => {
  it("deleting_a_folder_keeps_its_files", () => {
    const db = freshRoom();
    const folder = createFolder(db, "Contracts");
    const f1 = addFile(db, "a.txt", "alpha");
    const f2 = addFile(db, "b.txt", "beta");
    moveFileToFolder(db, f1, folder.id);
    moveFileToFolder(db, f2, folder.id);
    expect(getFileMeta(db, f1).folderId).toBe(folder.id);

    deleteFolder(db, folder.id);

    // Folder gone, but both files survive and are back at the top level.
    expect(listFolders(db)).toEqual([]);
    expect(listFiles(db)).toHaveLength(2);
    expect(getFileMeta(db, f1).folderId).toBeNull();
    expect(getFileMeta(db, f2).folderId).toBeNull();
  });

  /** Every "it worked" here has to be about a folder that is still there. A
   * folder removed while its Move menu was open used to take the file out of
   * the sidebar altogether — filed under a folder that no longer exists, and so
   * listed nowhere — while the move, the rename and the second delete all
   * answered Ok. */
  it("folder_writes_refuse_a_folder_that_is_gone", () => {
    const db = freshRoom();
    const folder = createFolder(db, "Archive");
    const f = addFile(db, "a.txt", "alpha");
    deleteFolder(db, folder.id);

    expect(() => moveFileToFolder(db, f, folder.id)).toThrow("That folder no longer exists.");
    expect(getFileMeta(db, f).folderId).toBeNull();
    expect(() => renameFolder(db, folder.id, "Old")).toThrow("That folder no longer exists.");
    expect(() => deleteFolder(db, folder.id)).toThrow("That folder no longer exists.");
    // The top level is not a folder id, so it stays available.
    expect(() => moveFileToFolder(db, f, null)).not.toThrow();
  });

  it("moving_a_file_that_is_gone_is_not_a_move", () => {
    const db = freshRoom();
    const folder = createFolder(db, "Contracts");
    const doomed = addFile(db, "lease.txt", "rent");
    trashFile(db, doomed, { kind: "user" });

    expect(() => moveFileToFolder(db, doomed, folder.id)).toThrow(
      "That file is no longer in this room."
    );
    expect(() => moveFileToFolder(db, "never-existed", null)).toThrow(
      "That file is no longer in this room."
    );
  });

  it("folder_names_are_unique", () => {
    const db = freshRoom();
    createFolder(db, "Legal");
    expect(() => createFolder(db, "Legal")).toThrow();
    expect(() => createFolder(db, "  ")).toThrow();
  });

  it("folder_names_are_unique_ignoring_case", () => {
    // "Legal" and "legal" used to be able to sit side by side, looking
    // identical in the sidebar with no way to tell them apart.
    const db = freshRoom();
    const legal = createFolder(db, "Legal");
    expect(() => createFolder(db, "legal")).toThrow();
    expect(() => createFolder(db, "LEGAL")).toThrow();
    // A rename onto another folder's name is refused the same way…
    const hr = createFolder(db, "HR");
    expect(() => renameFolder(db, hr.id, "LEGAL")).toThrow();
    // …but re-capitalizing a folder's OWN name is a legitimate rename.
    renameFolder(db, legal.id, "LEGAL");
    expect(listFolders(db).filter((f) => f.name === "LEGAL")).toHaveLength(1);
  });

  // Not in the Rust suite: the trim is what makes " Legal " and "Legal" the
  // same folder rather than two the sidebar draws identically.
  it("trims the name it stores, on create and on rename", () => {
    const db = freshRoom();
    const made = createFolder(db, "  Legal  ");
    expect(made.name).toBe("Legal");
    expect(listFolders(db)).toEqual([{ id: made.id, name: "Legal" }]);
    expect(() => createFolder(db, " legal ")).toThrow();
    renameFolder(db, made.id, "  Contracts ");
    expect(listFolders(db)).toEqual([{ id: made.id, name: "Contracts" }]);
    expect(() => renameFolder(db, made.id, "   ")).toThrow("Folder name cannot be empty.");
  });
});
