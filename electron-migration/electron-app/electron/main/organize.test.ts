/**
 * Vitest port of `src-tauri/src/commands/organize.rs`'s `mod tests`, 1:1:
 *
 *   - a_folder_qualified_name_resolves
 *   - organize_moves_renames_and_reports_the_misses
 *   - an_entry_is_not_lost_when_an_earlier_rename_takes_its_name
 *   - naming_one_file_twice_is_reported_rather_than_dropped
 *   - folder_maintenance_is_capped_like_everything_else
 *   - a_dry_run_changes_nothing_and_says_so
 *   - deleting_a_folder_never_deletes_its_files
 *   - the_agents_deletions_are_attributed_to_the_agent
 *   - merge_joins_text_and_leaves_the_sources_alone_by_default
 *   - merge_refuses_rather_than_producing_half_a_document
 *   - a_second_merge_does_not_reuse_the_first_ones_name
 *   - merge_can_trash_its_sources_when_asked
 *
 * ADAPTED: organize.rs's suite reaches the file's own private `existing_folder`
 * directly (`use super::*` gives `mod tests` visibility into it). This file is
 * a separate module and sees only `organize.ts`'s exported surface, so
 * `an_entry_is_not_lost_when_an_earlier_rename_takes_its_name` reads the same
 * fact — "Archive exists and holds the file" — through the public
 * `listFolders`/`getFileMeta`. Widening the module's exports to suit a test
 * would have made the wiring batch's API one function larger than organize.rs's
 * own.
 *
 * PLUS TWO tests the Rust suite does not have, each guarding a line this port
 * gets to write differently from Rust rather than a behaviour Rust already
 * checks — see their own comments.
 *
 * REAL FIXTURE ROOMS via `db-host/open.ts`'s `createRoom`, this directory's
 * established convention (`db-host/folders.test.ts`, `db-host/artifacts.test.ts`,
 * `fileTools.test.ts`): every fixture file is written through the real
 * `insertFile`, so the names, folders and extracted text these verbs act on are
 * exactly what the app really stores.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import {
  findFileLike,
  findFileLikeQualified,
  getFileExtractedText,
  getFileMeta,
  insertFile,
  listTrashedFiles,
} from "./db-host/files.js";
import { createFolder, listFolders, moveFileToFolder } from "./db-host/folders.js";
import {
  MAX_BULK_FILES,
  merge,
  organize,
  organizeSentence,
  trashNamed,
  type OrganizeEntry,
} from "./organize.js";

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

function room(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "organize-"));
  const roomPath = path.join(tmpDir, `t-${randomUUID()}.roomai`);
  open = createRoom(roomPath, "correct horse battery staple", "Test Room");
  return open;
}

function add(db: Database.Database, name: string, text: string): string {
  return insertFile(db, name, "text/plain", Buffer.from(text, "utf8"), text, "test").id;
}

describe("organize", () => {
  it("a_folder_qualified_name_resolves", () => {
    // THE ROUND TRIP. `list_room_files` prints "Invoices/q3.pdf"; the tools
    // must accept exactly what was printed.
    const db = room();
    const folder = createFolder(db, "Invoices");
    const id = add(db, "q3.pdf", "body");
    moveFileToFolder(db, id, folder.id);
    const [hit, name] = findFileLikeQualified(db, "Invoices/q3.pdf");
    expect(hit).toBe(id);
    expect(name).toBe("q3.pdf");
    // The bare name still works, and a folder path with no file does not
    // silently match the newest file in the room.
    expect(() => findFileLikeQualified(db, "q3")).not.toThrow();
    expect(() => findFileLikeQualified(db, "Invoices/")).toThrow();
  });

  it("organize_moves_renames_and_reports_the_misses", () => {
    const db = room();
    add(db, "a.txt", "alpha");
    add(db, "b.txt", "beta");
    const entries: OrganizeEntry[] = [
      { name: "a.txt", folder: "Archive", newName: "Alpha report" },
      { name: "nope.txt", folder: "Archive" },
    ];
    const r = organize(db, entries, [], [], false);
    expect(r.moved).toHaveLength(1);
    expect(r.renamed).toHaveLength(1);
    expect(r.failed, "the hallucinated file is reported").toHaveLength(1);
    // The extension survived a rename that dropped it.
    const [, name] = findFileLike(db, "Alpha report");
    expect(name).toBe("Alpha report.txt");
    // …and the folder was created on the way.
    expect(listFolders(db).some((f) => f.name === "Archive")).toBe(true);
  });

  it("an_entry_is_not_lost_when_an_earlier_rename_takes_its_name", () => {
    // The plan renames draft.md to final.md and then files the ORIGINAL
    // final.md away. Re-resolving "final.md" after the rename finds the wrong
    // row (or two candidates), so the second entry used to be done nowhere and
    // reported nowhere.
    const db = room();
    const finalId = add(db, "final.md", "the real one");
    add(db, "draft.md", "a draft");
    const entries: OrganizeEntry[] = [
      { name: "draft.md", newName: "final.md" },
      { name: "final.md", folder: "Archive" },
    ];
    const r = organize(db, entries, [], [], false);
    expect(r.renamed).toHaveLength(1);
    expect(r.moved, `the second entry was attempted: ${organizeSentence(r, false)}`).toHaveLength(1);
    expect(r.failed, organizeSentence(r, false)).toEqual([]);
    // …and it moved the file the plan named, not the renamed draft.
    const archive = listFolders(db).find((f) => f.name === "Archive");
    expect(archive, "Archive exists").toBeDefined();
    expect(getFileMeta(db, finalId).folderId).toBe(archive!.id);
  });

  it("naming_one_file_twice_is_reported_rather_than_dropped", () => {
    const db = room();
    const id = add(db, "q3.pdf", "body");
    const entries: OrganizeEntry[] = [
      { name: "q3.pdf", folder: "Invoices" },
      { name: "q3", newName: "Q3 report" },
    ];
    const r = organize(db, entries, [], [], false);
    expect(r.moved).toHaveLength(1);
    expect(r.renamed, "the second entry names the same file").toEqual([]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.error).toContain("earlier entry");
    // The rename it asked for did not happen, and the receipt says so.
    expect(getFileMeta(db, id).name).toBe("q3.pdf");
    expect(organizeSentence(r, false)).toContain("could not be done");
  });

  it("folder_maintenance_is_capped_like_everything_else", () => {
    // One call used to be able to create — or delete — an unbounded number of
    // folders, with the receipt reporting nothing held back.
    const db = room();
    const many = Array.from({ length: MAX_BULK_FILES + 3 }, (_, i) => `F${i}`);
    let r = organize(db, [], many, [], false);
    expect(r.foldersMade).toHaveLength(MAX_BULK_FILES);
    expect(r.capped).toBe(3);
    expect(organizeSentence(r, false)).toContain("were not attempted");
    expect(listFolders(db)).toHaveLength(MAX_BULK_FILES);
    // Removal is bounded by the same ceiling.
    r = organize(db, [], [], many, false);
    expect(r.foldersRemoved).toHaveLength(MAX_BULK_FILES);
    expect(r.capped).toBe(3);
  });

  it("a_dry_run_changes_nothing_and_says_so", () => {
    // A PREVIEW THAT MUTATES IS WORSE THAN NO PREVIEW, because it is the one
    // the user trusted. This caught a real defect in the Rust source: resolving
    // a destination used to mean get-or-CREATE, so previewing "file these under
    // Archive" left a real Archive folder behind — from the branch whose entire
    // promise is that nothing happened.
    const db = room();
    add(db, "a.txt", "alpha");
    const entries: OrganizeEntry[] = [{ name: "a.txt", folder: "Archive", newName: "Alpha" }];
    const r = organize(db, entries, ["Extra"], [], true);
    expect(r.moved).toHaveLength(1);
    expect(r.renamed).toHaveLength(1);
    expect(r.foldersMade).toHaveLength(1);
    const s = organizeSentence(r, true);
    expect(s).toContain("PREVIEW ONLY");
    expect(s).toContain("would move");
    expect(s).toContain("would rename");
    // NOTHING landed: no destination folder, no explicitly-requested folder, no
    // move, no rename.
    expect(
      listFolders(db),
      "a preview must not create folders — neither the destination nor the requested one"
    ).toEqual([]);
    const [id, name] = findFileLike(db, "a.txt");
    expect(name, "the rename was only previewed").toBe("a.txt");
    expect(getFileMeta(db, id).folderId).toBeNull();
  });

  it("deleting_a_folder_never_deletes_its_files", () => {
    // The invariant that makes folder removal safe to hand a model at all.
    const db = room();
    const folder = createFolder(db, "Old");
    const id = add(db, "keep.txt", "body");
    moveFileToFolder(db, id, folder.id);
    const r = organize(db, [], [], ["Old"], false);
    expect(r.foldersRemoved).toHaveLength(1);
    expect(getFileMeta(db, id).folderId, "the file survived, at the top level").toBeNull();
  });

  it("the_agents_deletions_are_attributed_to_the_agent", () => {
    const db = room();
    add(db, "junk.txt", "x");
    const [report, misses] = trashNamed(db, ["junk.txt", "ghost.txt"]);
    expect(report.ok).toEqual(["junk.txt"]);
    expect(misses, "an unmatched name is reported, not ignored").toHaveLength(1);
    const trashed = listTrashedFiles(db);
    expect(trashed[0]!.trashedBy).toBe("agent");
    expect(trashed[0]!.trashedById).toBe("trash_files");
  });

  it("merge_joins_text_and_leaves_the_sources_alone_by_default", () => {
    const db = room();
    add(db, "one.md", "First half.");
    add(db, "two.md", "Second half.");
    const [name, receipt] = merge(db, ["one.md", "two.md"], "Combined", true, false);
    expect(name, "an extension is supplied when omitted").toBe("Combined.md");
    const [id] = findFileLike(db, "Combined");
    const text = getFileExtractedText(db, id);
    expect(text).toContain("First half.");
    expect(text).toContain("Second half.");
    expect(text, "headings name their source file").toContain("## one.md");
    expect(receipt).toContain("originals are untouched");
    // Both sources are still in the library.
    expect(() => findFileLike(db, "one.md")).not.toThrow();
  });

  it("merge_refuses_rather_than_producing_half_a_document", () => {
    const db = room();
    add(db, "only.md", "text");
    // One resolvable file is not a merge.
    expect(() => merge(db, ["only.md", "ghost.md"], "x", true, false)).toThrow(
      /at least two files it can find/
    );
    // Two files, one with no readable text, is also not a merge — and the error
    // says so rather than silently writing a copy of the first.
    insertFile(db, "scan.pdf", "application/pdf", Buffer.from("%PDF"), null, "test");
    expect(() => merge(db, ["only.md", "scan.pdf"], "x", true, false)).toThrow(/readable text/);
  });

  it("a_second_merge_does_not_reuse_the_first_ones_name", () => {
    // Two files called "Merged notes.md" with different content is a room where
    // the first merge can never be opened by name again.
    const db = room();
    add(db, "a.md", "First.");
    add(db, "b.md", "Second.");
    add(db, "c.md", "Third.");
    add(db, "d.md", "Fourth.");
    const [first] = merge(db, ["a.md", "b.md"], "", false, false);
    const [second, receipt] = merge(db, ["c.md", "d.md"], "", false, false);
    expect(first).toBe("Merged notes.md");
    expect(second, "the second merge took a free name").not.toBe(first);
    // The receipt names the file that was actually written.
    expect(receipt).toContain(second);
    // …and the first merge is still reachable by its own name.
    const [id] = findFileLike(db, first);
    expect(getFileExtractedText(db, id)).toContain("First.");
  });

  it("merge_can_trash_its_sources_when_asked", () => {
    const db = room();
    add(db, "one.md", "First.");
    add(db, "two.md", "Second.");
    const [, receipt] = merge(db, ["one.md", "two.md"], "Both.md", false, true);
    expect(receipt).toContain("moved the originals to the trash");
    expect(() => findFileLike(db, "one.md")).toThrow();
    // Recoverable, and attributed — never destroyed.
    const trashed = listTrashedFiles(db);
    expect(trashed).toHaveLength(2);
    expect(trashed[0]!.trashedBy).toBe("agent");
  });

  // ---- beyond organize.rs's own suite ------------------------------------

  it("an_entry_with_no_name_is_skipped_rather_than_crashing_the_call", () => {
    // Rust's `OrganizeEntry` carries `#[serde(default)]` on `name`, so a model
    // that wrote `{"folder": "Archive"}` yields `""` and is skipped. The
    // equivalent JSON reaches THIS port as `undefined`, where a bare
    // `entry.name.trim()` throws and takes the whole tool call with it — which
    // is the failure this test pins down. The entry is a no-op, and the other
    // entries in the plan still run.
    const db = room();
    add(db, "a.txt", "alpha");
    const entries = [{ folder: "Archive" }, { name: "a.txt", folder: "Archive" }] as OrganizeEntry[];
    const r = organize(db, entries, [], [], false);
    expect(r.moved).toHaveLength(1);
    expect(r.failed, "an empty name resolves to nothing, silently").toEqual([]);
  });

  it("merge_does_not_trash_a_source_it_could_not_read", () => {
    // The `merged.includes(name)` filter on the trash list. A file skipped for
    // having no readable text contributed nothing to the merged document, so
    // deleting it would destroy the only copy of something the new file does
    // not contain — the one way this verb could actually lose data.
    const db = room();
    add(db, "one.md", "First.");
    add(db, "two.md", "Second.");
    insertFile(db, "scan.pdf", "application/pdf", Buffer.from("%PDF"), null, "test");
    const [, receipt, failures] = merge(
      db,
      ["one.md", "two.md", "scan.pdf"],
      "Both.md",
      false,
      true
    );
    expect(failures.map((f) => f.name)).toContain("scan.pdf");
    expect(receipt).toContain("no readable text");
    // The two readable sources went to the trash; the unreadable one did not.
    expect(listTrashedFiles(db).map((t) => t.name).sort()).toEqual(["one.md", "two.md"]);
    expect(() => findFileLike(db, "scan.pdf")).not.toThrow();
  });
});
