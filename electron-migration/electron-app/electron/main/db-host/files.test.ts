/**
 * Vitest port of `src-tauri/src/db/files.rs`'s `mod tests`, plus the two
 * tests from `src-tauri/src/db.rs`'s own `mod tests` that exercise the
 * files/chunks helpers ported alongside it (`a_failed_chunking_leaves_no_
 * half_indexed_file`, `chunking_nests_inside_a_caller_transaction`) — they
 * live here rather than in a file of their own, matching where the code they
 * test now lives.
 *
 * REAL FIXTURE ROOMS: every test opens a real `.roomai` file through
 * `createRoom` (better-sqlite3-multiple-ciphers), matching this directory's
 * established convention (part A, `open.test.ts`) — no bare mocks, and the
 * REAL `insertFile`/`insertChunks` build every fixture.
 *
 * NOT PORTED:
 *  - `no_by_id_read_of_a_file_may_skip_the_trash_clause` — a Rust-SOURCE-TREE
 *    scanner (walks `src/**‍/*.rs` for a `SELECT … FROM files … WHERE id = ?1`
 *    literal that omits `trashed`). There is no equivalent tree to scan from
 *    a TypeScript port of one module, so the property it guards is instead
 *    exercised positively, reader by reader, in
 *    `a_trashed_file_is_excluded_from_every_place_files_are_found` and
 *    `a_stale_id_gets_nothing_from_a_trashed_files_sidecar_tables` below.
 *
 * ADAPTED (Rust modules this batch does not port):
 *  - `create_folder`/`move_file_to_folder` (`db/folders.rs`) are stood in
 *    with direct SQL against the `folders` table and `files.folder_id`, both
 *    already in schema.sql — the same "TODO stand-in" convention part A's
 *    `embeddings.test.ts` established.
 *  - `files_needing_privacy_scan` (`db/privacy.rs`): the single assertion
 *    using it, in `a_trashed_file_is_excluded_from_every_place_files_are_
 *    found`, is dropped and needs its own test when privacy.ts lands.
 *  - `set_rec_meta`/`get_rec_meta` (`db/recordings.rs`) and
 *    `set_file_provenance`/`file_provenance`/`snapshot_file_version`/
 *    `list_file_versions` (`db/versions.rs`): the assertions using them in
 *    `a_stale_id_gets_nothing_from_a_trashed_files_sidecar_tables` are
 *    dropped for the same reason. In `permanent_delete_really_destroys_and_
 *    only_touches_the_trash`, `snapshot_file_version` is stood in with a
 *    direct INSERT instead of dropped, because the property under test there
 *    (the FK cascade takes `file_versions` with the row) is schema-driven and
 *    can be proved without the writer.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./open.js";
import { migrate } from "./migrate.js";
import { roomCounts } from "./messages.js";
import {
  chunksByRowids,
  chunksMissingEmbedding,
  embeddingToBlob,
  forEachChunkEmbedding,
  ftsFileMatches,
  recentChunks,
  searchChunksFtsRanked,
  setChunkEmbedding,
} from "./embeddings.js";
import {
  anyFileName,
  availableName,
  columnExists,
  currentDate,
  deleteFile,
  derivedLinks,
  emptyTrash,
  fileByExactName,
  fileNamesHint,
  fileOriginUrl,
  fileWithSameBytes,
  filesContentFts,
  filesMissingSummary,
  filesMissingText,
  filesNameLike,
  filesWithBytes,
  findFileLike,
  findFileLikeFull,
  findFileLikeQualified,
  findImageLike,
  findSourceFileLike,
  getFileBytes,
  getFileBytesNamed,
  getFileExtractedText,
  getFileFull,
  getFileMeta,
  getFileName,
  getMediaMeta,
  getWebMeta,
  inTransaction,
  insertChunks,
  insertFile,
  insertFileFromUrl,
  listFileInventory,
  listFiles,
  listFilesBrief,
  listFilesForSummary,
  listTrashedFiles,
  markSectionOnly,
  newSourceFileCount,
  placementNote,
  renameFile,
  restoreFile,
  roomFileCount,
  searchKey,
  setDerivedFrom,
  setFileAiSummary,
  setFileExtractedText,
  setLibraryVisibility,
  setMediaMeta,
  setWebMeta,
  tableExists,
  trashFile,
  trashedFileCount,
  updateFileContent,
  type FileMeta,
  type TrashedFile,
} from "./files.js";

/** Mirrors the private `CHUNK_TARGET_CHARS` inside files.ts (an
 * implementation constant, not part of the module's contract, so it is not
 * exported). Named here rather than spelled `1200` inline so the two
 * atomicity tests read the way the Rust ones do. */
const CHUNK_TARGET_CHARS = 1200;

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-files-"));
  return newRoomIn(tmpDir);
}

/** A second isolated fixture room, for the one test that needs more than
 * one at a time. */
function extraRoom(): Database.Database {
  return newRoomIn(mkdtempSync(path.join(os.tmpdir(), "db-host-files-extra-")));
}

function newRoomIn(dir: string): Database.Database {
  const roomPath = path.join(dir, `pr-test-${randomUUID()}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

/** Matches Rust's `crate::db::add_file` test helper exactly: the mime is
 * ALWAYS "text/plain", whatever the name's own extension says. */
function addFile(db: Database.Database, name: string, text: string): string {
  return insertFile(db, name, "text/plain", Buffer.from(text, "utf8"), text, "upload").id;
}

/** Stand-in for `db/folders.rs`'s `create_folder` (not ported) — raw SQL
 * against the same table shape, returning the same thing the Rust helper's
 * `Folder.id` gives. */
function createFolderRaw(db: Database.Database, name: string): string {
  const id = randomUUID();
  db.prepare("INSERT INTO folders(id, name) VALUES (?, ?)").run(id, name);
  return id;
}

/** Stand-in for `db/folders.rs`'s `move_file_to_folder`. */
function moveFileToFolderRaw(
  db: Database.Database,
  fileId: string,
  folderId: string | null
): void {
  db.prepare("UPDATE files SET folder_id = ? WHERE id = ?").run(folderId, fileId);
}

/** A room full of one of everything: an upload, a browser page and its HTML
 * twin, a download, and two generated artifacts. Returns the id of the
 * "Full pass — …" generated derivative, as the Rust fixture does. */
function roomOfEveryKind(db: Database.Database): string {
  addFile(db, "lease.pdf", "an upload");
  insertFileFromUrl(
    db,
    "Google News.md",
    "text/markdown",
    Buffer.from("page"),
    "page",
    "web",
    "https://news.google.com"
  );
  insertFileFromUrl(
    db,
    "Google News.html",
    "text/html",
    Buffer.from("<p>page</p>"),
    null,
    "web",
    "https://news.google.com"
  );
  insertFileFromUrl(
    db,
    "report.pdf",
    "application/pdf",
    Buffer.from("%PDF"),
    null,
    "download",
    "https://example.test/report.pdf"
  );
  insertFile(db, "Room summary.md", "text/markdown", Buffer.from("s"), "s", "generated");
  return insertFile(db, "Full pass — lease.pdf.html", "text/html", Buffer.from("f"), null, "generated")
    .id;
}

/** Give every chunk in the room the same fake embedding, so the vector half
 * of retrieval has something to lose (and to get back). Returns the blob. */
function embedEveryChunk(db: Database.Database, vector: number[]): Buffer {
  const blob = embeddingToBlob(vector);
  for (const [chunkId] of chunksMissingEmbedding(db, 100)) {
    setChunkEmbedding(db, chunkId, blob);
  }
  return blob;
}

function names(files: FileMeta[]): string[] {
  return files.map((f) => f.name);
}

// ------------------------------------------------------------ filesNameLike

describe("filesNameLike", () => {
  it("a_file_name_search_takes_like_wildcards_literally", () => {
    // `search_all` runs the file, message and memory searches off ONE text.
    // The escaping landed on messages only, so "report_2026" matched
    // literally in the Messages section and wildcarded in Files — two
    // matching rules, side by side, in the same result list.
    const db = freshRoom();
    addFile(db, "report_2026.pdf", "x");
    addFile(db, "reportX2026.pdf", "x");
    addFile(db, "50% off.txt", "x");
    addFile(db, "50 pages.txt", "x");

    let hits = filesNameLike(db, "report_2026");
    expect(hits.length, `_ still wildcarded: ${JSON.stringify(hits)}`).toBe(1);
    expect(hits[0]?.[1]).toBe("report_2026.pdf");

    hits = filesNameLike(db, "50%");
    expect(hits.length, `% still wildcarded: ${JSON.stringify(hits)}`).toBe(1);
    expect(hits[0]?.[1]).toBe("50% off.txt");

    // An ordinary query is unaffected.
    expect(filesNameLike(db, "pages").length).toBe(1);
    db.close();
  });

  it("a_file_name_search_matches_words_in_any_order", () => {
    const db = freshRoom();
    addFile(db, "Q3 revenue report.pdf", "x");
    addFile(db, "report on Q3 revenue.docx", "x");
    addFile(db, "Q4 revenue report.pdf", "x");
    for (const q of ["q3 report", "report q3"]) {
      expect(filesNameLike(db, q).length, `${q} found the wrong count`).toBe(2);
    }
    expect(filesNameLike(db, "q3 rhubarb")).toEqual([]);
    db.close();
  });
});

// -------------------------------------------------------- counts and listing

describe("roomFileCount / listFiles", () => {
  it("the_room_count_counts_every_kind_of_thing_in_the_room", () => {
    // Owner's ruling (2026-08-03): the count means "what is in this room",
    // full stop — a saved browser page, the HTML twin saved beside it, a
    // download and a generated/temporary artifact are all things the room
    // holds. Leaving any of them out would answer a different question.
    const db = freshRoom();
    roomOfEveryKind(db);
    expect(roomFileCount(db)).toBe(6);
    expect(roomFileCount(db), "the count and the list are the same population").toBe(
      listFiles(db).length
    );
    db.close();
  });

  it("a_section_only_file_is_in_the_room_though_the_library_does_not_list_it", () => {
    // The Library badge asks a NARROWER question than this count, and a
    // section-only file is where the two part.
    const db = freshRoom();
    const id = addFile(db, "Sketch.excalidraw.json", "{}");
    markSectionOnly(db, id, "sketch");
    expect(getFileMeta(db, id).libraryVisibility).toBe("sectionOnly");
    expect(roomFileCount(db)).toBe(1);
    expect(listFiles(db).length).toBe(1);
    db.close();
  });

  it("a_trashed_file_stops_counting_as_present", () => {
    const db = freshRoom();
    const temp = roomOfEveryKind(db);
    trashFile(db, temp, { kind: "user" });
    expect(roomFileCount(db)).toBe(5);
    expect(roomFileCount(db)).toBe(listFiles(db).length);
    // Undo puts it back — in the count as well as in the list.
    restoreFile(db, temp);
    expect(roomFileCount(db)).toBe(6);
    db.close();
  });

  it("deleted_files_are_not_new_work_for_a_workflow", () => {
    const db = freshRoom();
    const a = addFile(db, "invoice-1.pdf", "one");
    addFile(db, "invoice-2.pdf", "two");
    // A workflow's OWN output is excluded for a different reason (it would
    // re-trigger itself forever), and that exclusion still stands.
    insertFile(db, "Summary.md", "text/markdown", Buffer.from("s"), "s", "generated");
    expect(newSourceFileCount(db, "")).toBe(2);
    trashFile(db, a, { kind: "user" });
    expect(newSourceFileCount(db, "")).toBe(1);
    // A `since` in the future leaves nothing new, which is the answer, not a
    // failure to look.
    expect(newSourceFileCount(db, "2999-01-01T00:00:00Z")).toBe(0);
    db.close();
  });

  it("every_count_surface_reports_the_same_number", () => {
    // `roomCounts` (RoomInfo) and the front page each used to run their own
    // `count(*) FROM files`. Two spellings of one question drift: trash
    // filtered the listings and left both counts behind.
    const db = freshRoom();
    const temp = roomOfEveryKind(db);
    trashFile(db, temp, { kind: "user" });
    const listed = listFiles(db).length;
    expect(roomCounts(db)[0]).toBe(listed);
    expect(roomFileCount(db)).toBe(listed);
    db.close();
  });
});

describe("the search index stays in sync with content", () => {
  it("fts_index_finds_and_stays_in_sync", () => {
    const db = freshRoom();
    const id = addFile(db, "lease.txt", "The tenant pays rent on the first of each month.");
    const hits = searchChunksFtsRanked(db, '"rent"', 5);
    expect(hits.length, "inserted chunk is searchable via the FTS index").toBe(1);
    expect(hits[0]?.[1]).toBe("lease.txt");

    updateFileContent(
      db,
      id,
      Buffer.from("The landlord provides parking spaces."),
      "The landlord provides parking spaces."
    );
    expect(
      searchChunksFtsRanked(db, '"rent"', 5),
      "update fires the triggers: old terms drop out of the FTS index"
    ).toEqual([]);
    expect(searchChunksFtsRanked(db, '"parking"', 5).length, "new terms appear").toBe(1);

    deleteFile(db, id);
    expect(
      searchChunksFtsRanked(db, '"parking"', 5),
      "delete removes the file's text from the FTS index"
    ).toEqual([]);
    db.close();
  });
});

// -------------------------------------------------------------- naming

describe("availableName", () => {
  it("generated_output_steps_past_the_name_it_already_used", () => {
    // Live QA 2026-08-03 ended with three files called
    // "Flashcards - clean-code.html" — same name, different content, no way
    // to tell which run produced which.
    const db = freshRoom();
    const name = "Flashcards - clean-code.html";
    expect(availableName(db, name), "first one keeps the plain name").toBe(name);
    addFile(db, name, "deck one");
    expect(availableName(db, name)).toBe("Flashcards - clean-code (2).html");
    addFile(db, "Flashcards - clean-code (2).html", "deck two");
    expect(availableName(db, name)).toBe("Flashcards - clean-code (3).html");
    db.close();
  });

  it("available_name_handles_the_awkward_names", () => {
    const db = freshRoom();
    // No extension.
    addFile(db, "notes", "x");
    expect(availableName(db, "notes")).toBe("notes (2)");
    // Case-insensitive: two rows differing only in case read as the same
    // duplicate to whoever is scanning the library.
    addFile(db, "Report.md", "x");
    expect(availableName(db, "report.md")).toBe("report (2).md");
    // LIKE wildcards in the name itself must not widen the search: this file
    // is unrelated to "100% done.md" and must not push its numbering along.
    addFile(db, "100% done.md", "x");
    addFile(db, "100X done (2).md", "x");
    expect(availableName(db, "100% done.md")).toBe("100% done (2).md");
    // A free name is returned untouched even when near-misses exist.
    addFile(db, "solo (2).txt", "x");
    expect(availableName(db, "solo.txt")).toBe("solo.txt");
    db.close();
  });

  it("a BACKSLASH in the name is escaped too — the case the % and _ ones cannot prove", () => {
    // Not in the Rust suite, and the reason it has to exist is worth writing
    // down: the escaping in `availableName` is only OBSERVABLE for `\`.
    //
    // A missing escape on `%` or `_` WIDENS the LIKE. Every extra name it
    // sweeps in then fails the only test that is run on it — membership
    // against a LITERAL "stem (n)ext" candidate — because a name that equals
    // such a candidate was already matched by the escaped pattern. So the
    // "100% done.md" case above stays green with `likeEscape` deleted
    // (verified by mutation), and proves nothing about escaping.
    //
    // `\` is the one that NARROWS. Unescaped, the pattern for "a\b.md" is
    // `a\b (%).md`, where `ESCAPE '\'` reads `\b` as a literal "b" — so the
    // pattern becomes `ab (%).md` and stops seeing the file that IS there, and
    // the next save silently hands back a name already in use.
    const db = freshRoom();
    addFile(db, "a\\b.md", "x");
    addFile(db, "a\\b (2).md", "x");
    expect(availableName(db, "a\\b.md")).toBe("a\\b (3).md");
    db.close();
  });
});

describe("inTransaction", () => {
  it("a_write_and_its_index_land_together_or_not_at_all", () => {
    // What makes `insertFile` all-or-nothing: the row and its search chunks
    // share one transaction, so an import that dies partway through indexing
    // can't leave a file in the library that is listed as failed and only
    // partly searchable.
    const db = freshRoom();
    const count = (): number =>
      (db.prepare("SELECT count(*) as c FROM folders").get() as { c: number }).c;

    expect(() =>
      inTransaction(db, () => {
        db.prepare("INSERT INTO folders(id, name) VALUES ('x', 'X')").run();
        throw new Error("indexing blew up");
      })
    ).toThrow("indexing blew up");
    expect(count(), "the partial write rolled back with the failure").toBe(0);

    // A successful body commits.
    inTransaction(db, () => {
      db.prepare("INSERT INTO folders(id, name) VALUES ('y', 'Y')").run();
    });
    expect(count()).toBe(1);

    // SQLite has no nested BEGIN, so inside a caller's own transaction (the
    // batch-edit path) this must be a pass-through, not a second one.
    db.exec("BEGIN IMMEDIATE");
    inTransaction(db, () => {
      db.prepare("INSERT INTO folders(id, name) VALUES ('z', 'Z')").run();
    });
    db.exec("ROLLBACK");
    expect(count(), "the outer transaction still owns the outcome").toBe(1);
    db.close();
  });
});

describe("fileWithSameBytes", () => {
  it("same_bytes_are_recognized_as_an_existing_file", () => {
    const db = freshRoom();
    const id = addFile(db, "lease.pdf", "the very same text");
    const bytes = getFileBytes(db, id) as Buffer;
    expect(fileWithSameBytes(db, bytes)).toEqual([id, "lease.pdf"]);
    // Different bytes of the same length are NOT a match.
    const other = Buffer.from(bytes);
    other[0] = (other[0] as number) ^ 0xff;
    expect(fileWithSameBytes(db, other)).toBeNull();
    expect(fileWithSameBytes(db, Buffer.from("nothing like it"))).toBeNull();
    db.close();
  });

  it("picks the row whose bytes actually match, not merely one of the same size", () => {
    // Not in the Rust suite. The ported test above holds ONE file, which can
    // show that a same-size/different-bytes probe MISSES — but not that a HIT
    // lands on the right row once several rows share a size. Three same-size
    // files make the blob comparison, not the size prefilter, decide.
    const db = freshRoom();
    const a = insertFile(db, "a.bin", "application/octet-stream", Buffer.from("AAAA"), null, "upload").id;
    const b = insertFile(db, "b.bin", "application/octet-stream", Buffer.from("BBBB"), null, "upload").id;
    const c = insertFile(db, "c.bin", "application/octet-stream", Buffer.from("CCCC"), null, "upload").id;
    expect(fileWithSameBytes(db, Buffer.from("AAAA"))).toEqual([a, "a.bin"]);
    expect(fileWithSameBytes(db, Buffer.from("BBBB"))).toEqual([b, "b.bin"]);
    expect(fileWithSameBytes(db, Buffer.from("CCCC"))).toEqual([c, "c.bin"]);
    expect(fileWithSameBytes(db, Buffer.from("DDDD"))).toBeNull();
    // A zero-length file is stored as a zero-length BLOB and not as NULL — the
    // same thing rusqlite does with an empty `&[u8]` — so it dedupes against
    // itself like any other file instead of silently re-importing every time.
    const empty = insertFile(db, "empty.bin", "application/octet-stream", Buffer.alloc(0), null, "upload").id;
    expect(fileWithSameBytes(db, Buffer.alloc(0))).toEqual([empty, "empty.bin"]);
    db.close();
  });
});

// ------------------------------------------------------------ fuzzy finders

describe("fuzzy finders", () => {
  it("fuzzy_finder_breaks_a_same_second_tie_toward_the_newer_file", () => {
    // `created_at` only records whole seconds, so two files added in the same
    // second used to tie and SQLite could return either.
    const db = freshRoom();
    addFile(db, "report-v1.txt", "older");
    const newer = addFile(db, "report-v2.txt", "newer");
    db.prepare("UPDATE files SET created_at = '2026-01-01T00:00:00Z'").run();
    expect(findFileLike(db, "report")[0]).toBe(newer);
    db.close();
  });

  it("fuzzy_finders_share_a_core_but_keep_their_own_columns_and_filter", () => {
    const db = freshRoom();
    const id = addFile(db, "lease-draft.txt", "rent is due monthly");
    // Same match, three column shapes. findFileLike lowercases for itself.
    expect(findFileLike(db, "LEASE")).toEqual([id, "lease-draft.txt"]);
    const [fullId, name, text] = findFileLikeFull(db, "lease");
    expect([fullId, name]).toEqual([id, "lease-draft.txt"]);
    expect(text).toBe("rent is due monthly");

    // The image-only variant does not see the text file at all…
    expect(() => findImageLike(db, "lease")).toThrow();
    // …but finds an image of the same name, bytes and all. A raw 4-byte array
    // matches the Rust fixture's `b"\x89PNG"` exactly — `Buffer.from("\x89PNG")`
    // (a JS STRING) would UTF-8-encode U+0089 as two bytes.
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    insertFile(db, "lease-photo.png", "image/png", pngMagic, null, "upload");
    const [, imgName, imgBytes] = findImageLike(db, "lease");
    expect(imgName).toBe("lease-photo.png");
    expect(imgBytes).toEqual(pngMagic);

    // A miss still carries each caller's own wording.
    expect(() => findFileLike(db, "nope")).toThrowError(/^No file matching "nope"/);
    expect(() => findImageLike(db, "nope")).toThrowError(/^No image matching "nope"/);
    db.close();
  });

  it("a_pass_resolves_the_source_file_not_its_own_generated_output", () => {
    const db = freshRoom();
    // The source book…
    const src = addFile(db, "clean-code.pdf", "the whole book text");
    // …and the app's own generated full-pass output: its name CONTAINS the
    // source's name and it is newer. `created_at` is second-resolution, so
    // pin it explicitly instead of racing the clock.
    insertFile(
      db,
      "Full pass — clean-code.pdf.html",
      "text/html",
      Buffer.from("<h1>summary</h1>"),
      "<h1>summary</h1>",
      "generated"
    );
    db.prepare(
      "UPDATE files SET created_at = '2999-01-01T00:00:00Z' WHERE name = 'Full pass — clean-code.pdf.html'"
    ).run();

    // The bug: the plain finder returns the NEWER, name-matching output.
    expect(findFileLike(db, "clean-code")[1]).toBe("Full pass — clean-code.pdf.html");
    // The fix: the source resolver skips generated derivatives.
    expect(findSourceFileLike(db, "clean-code")).toEqual([src, "clean-code.pdf"]);

    // A generated "Room summary" is likewise skipped in favour of an upload.
    const db2 = extraRoom();
    const notes = addFile(db2, "summary-notes.txt", "notes");
    insertFile(db2, "Room summary.html", "text/html", Buffer.from("x"), "x", "generated");
    db2
      .prepare("UPDATE files SET created_at = '2999-01-01T00:00:00Z' WHERE source = 'generated'")
      .run();
    expect(findSourceFileLike(db2, "summary")).toEqual([notes, "summary-notes.txt"]);
    db2.close();

    // With ONLY a generated artifact present, the source resolver reports a
    // miss rather than falling back to summarizing the derivative.
    const onlyGen = extraRoom();
    insertFile(onlyGen, "Full pass — report.pdf.html", "text/html", Buffer.from("x"), "x", "generated");
    expect(() => findSourceFileLike(onlyGen, "report")).toThrowError(
      /^No source file matching "report"/
    );
    onlyGen.close();

    db.close();
  });

  it("findFileLikeQualified accepts the folder-qualified name the room hands out", () => {
    // Not a literal Rust test (files.rs exercises this function at the
    // commands layer, out of scope), but it pins exactly what its doc comment
    // promises: full string first, last path segment only as a fallback, and
    // never on an empty tail.
    const db = freshRoom();
    const folderId = createFolderRaw(db, "Invoices");
    const id = addFile(db, "q3.pdf", "the numbers");
    moveFileToFolderRaw(db, id, folderId);
    expect(findFileLikeQualified(db, "Invoices/q3.pdf")).toEqual([id, "q3.pdf"]);
    expect(findFileLikeQualified(db, "q3")).toEqual([id, "q3.pdf"]);
    // "Invoices/" names a FOLDER — retrying on "" would match the newest file
    // in the room, a confident wrong answer where an error is the honest one.
    expect(() => findFileLikeQualified(db, "Invoices/")).toThrow();
    db.close();
  });
});

// ------------------------------------------------------- summaries / folders

describe("filesMissingSummary", () => {
  it("summary_filler_skips_generated_summary_files", () => {
    const db = freshRoom();
    // Both the current HTML name and the legacy Markdown name are excluded
    // when generated by the app itself.
    insertFile(db, "Room summary.html", "text/html", Buffer.from("<h1>s</h1>"), "<h1>s</h1>", "generated");
    insertFile(db, "Room summary.md", "text/markdown", Buffer.from("# s"), "# s", "generated");
    // A user-uploaded file that happens to share the name still gets one.
    const uploaded = addFile(db, "Room summary.html", "my own notes");
    const ids = filesMissingSummary(db, 10).map(([id]) => id);
    expect(ids).toEqual([uploaded]);
    db.close();
  });

  it("empty_liner_sentinel_leaves_the_missing_set", () => {
    // Wave 1b (idea 8): a file whose one-liner persistently fails gets the ''
    // sentinel from an auto job, which must remove it from the missing set
    // (auto-index termination) — while a NULL keeps it in.
    const db = freshRoom();
    const stuck = addFile(db, "stuck.pdf", "text the model chokes on");
    const fresh = addFile(db, "fresh.pdf", "normal text");
    expect(filesMissingSummary(db, 10).length).toBe(2);
    setFileAiSummary(db, stuck, "");
    expect(filesMissingSummary(db, 10).map(([id]) => id)).toEqual([fresh]);
    // A content change clears the sentinel back to NULL → retried.
    updateFileContent(db, stuck, Buffer.from("new bytes"), "new text");
    expect(filesMissingSummary(db, 10).length).toBe(2);
    db.close();
  });
});

describe("listFileInventory", () => {
  it("inventory_shows_folder_prefix", () => {
    const db = freshRoom();
    const folderId = createFolderRaw(db, "Contracts");
    const f = addFile(db, "lease.pdf", "x");
    addFile(db, "loose.txt", "y");
    moveFileToFolderRaw(db, f, folderId);
    const inventoryNames = listFileInventory(db).map(([n]) => n);
    expect(inventoryNames).toContain("Contracts/lease.pdf");
    expect(inventoryNames).toContain("loose.txt");
    db.close();
  });
});

// ------------------------------------------------------ per-kind JSON metadata

describe("per-kind JSON metadata", () => {
  it("media_meta_round_trips_and_the_column_exists_in_a_fresh_room", () => {
    const db = freshRoom();
    const id = addFile(db, "talk.mp4", "");
    // Never probed is NULL, and NULL must not read as "probed, all unknown".
    expect(getMediaMeta(db, id)).toBeNull();
    setMediaMeta(db, id, '{"durationSecs":751.0,"width":1920}');
    expect(getMediaMeta(db, id)).toBe('{"durationSecs":751.0,"width":1920}');
    // A file that no longer exists reads as "nothing stored", not an error
    // the caller has to special-case.
    expect(getMediaMeta(db, "no-such-file")).toBeNull();
    db.close();
  });

  it("web_meta_round_trips_and_the_column_exists_in_a_fresh_room", () => {
    const db = freshRoom();
    const id = addFile(db, "The Heron Returns.md", "body");
    expect(getWebMeta(db, id), "not from the web reads as nothing stored").toBeNull();
    const json = '{"title":"The Heron Returns","byline":"Dana Okafor"}';
    setWebMeta(db, id, json);
    expect(getWebMeta(db, id)).toBe(json);
    expect(getWebMeta(db, "no-such-file")).toBeNull();

    // And the other half of the double-write: a room created BEFORE the
    // column existed gains it on open. (The column is dropped again here to
    // make one.)
    db.exec("ALTER TABLE files DROP COLUMN web_meta");
    expect(
      () => db.prepare("SELECT web_meta FROM files").get(),
      "the column must really be gone before migrate runs"
    ).toThrow();
    migrate(db);
    setWebMeta(db, id, json);
    // Every room open runs migrate; a second pass must not re-ALTER (which
    // would error) nor clear what the first one enabled.
    migrate(db);
    expect(getWebMeta(db, id)).toBe(json);
    db.close();
  });

  it("an_older_room_gains_the_media_meta_column_when_it_is_migrated", () => {
    const db = freshRoom();
    db.exec("ALTER TABLE files DROP COLUMN media_meta");
    const id = addFile(db, "legacy.mp4", "");
    expect(
      () => db.prepare("SELECT media_meta FROM files").get(),
      "the column must really be gone before migrate runs"
    ).toThrow();
    migrate(db);
    setMediaMeta(db, id, '{"hasAudio":false}');
    expect(getMediaMeta(db, id)).toBe('{"hasAudio":false}');
    migrate(db);
    expect(getMediaMeta(db, id)).toBe('{"hasAudio":false}');
    db.close();
  });
});

// ================================================================ trash / undo

describe("trash / undo", () => {
  it("delete_then_restore_round_trips_including_searchability", () => {
    // The whole point of the feature: delete → the file is gone from
    // everything → restore → it is BACK, including being findable again, on
    // BOTH halves of retrieval. A restore that only put the row back would
    // return a file the user can see and the model cannot.
    const db = freshRoom();
    const id = addFile(db, "lease.txt", "The tenant pays rent on the first of each month.");
    const blob = embedEveryChunk(db, [0.25, -0.5, 0.75]);

    // Present: listed, counted, keyword-searchable, vector-searchable.
    expect(listFiles(db).length).toBe(1);
    expect(roomFileCount(db)).toBe(1);
    expect(searchChunksFtsRanked(db, '"rent"', 5).length).toBe(1);
    let embedded = 0;
    forEachChunkEmbedding(db, () => {
      embedded += 1;
    });
    expect(embedded).toBe(1);

    trashFile(db, id, { kind: "user" });

    // Gone from the library AND from both retrieval paths.
    expect(listFiles(db)).toEqual([]);
    expect(roomFileCount(db)).toBe(0);
    expect(searchChunksFtsRanked(db, '"rent"', 5)).toEqual([]);
    let stillEmbedded = 0;
    forEachChunkEmbedding(db, () => {
      stillEmbedded += 1;
    });
    expect(stillEmbedded, "a trashed file's vectors leave the scan entirely").toBe(0);

    // …but nothing was destroyed: the row, the bytes and the text survive.
    const row = db.prepare("SELECT original_bytes as b FROM files WHERE id = ?").get(id) as {
      b: Buffer;
    };
    expect(row.b.toString("utf8")).toBe("The tenant pays rent on the first of each month.");

    restoreFile(db, id);

    expect(listFiles(db).length).toBe(1);
    expect(roomFileCount(db)).toBe(1);
    const hits = searchChunksFtsRanked(db, '"rent"', 5);
    expect(hits.length, "keyword search finds it again").toBe(1);
    expect(hits[0]?.[1]).toBe("lease.txt");
    // The EMBEDDING came back too, byte for byte — not a NULL waiting on a
    // background re-embed that may never run.
    const restored: Buffer[] = [];
    forEachChunkEmbedding(db, (_rowid, b) => {
      restored.push(Buffer.from(b));
    });
    expect(restored).toEqual([blob]);
    expect(
      chunksMissingEmbedding(db, 10),
      "the restored chunk is not queued for re-embedding — it never lost its vector"
    ).toEqual([]);
    // And it is no longer in the trash.
    expect(listTrashedFiles(db)).toEqual([]);
    expect(trashedFileCount(db)).toBe(0);
    db.close();
  });

  it("a_trashed_file_is_excluded_from_every_place_files_are_found", () => {
    // Every place a file can be listed, counted, searched or retrieved —
    // named one by one, because the way this feature fails is one forgotten
    // query, and a test that only checked `listFiles` would have passed.
    const db = freshRoom();
    const folderId = createFolderRaw(db, "Contracts");
    const doomed = addFile(db, "lease.txt", "the tenant pays rent monthly");
    moveFileToFolderRaw(db, doomed, folderId);
    const keeper = addFile(db, "invoice.txt", "an unrelated invoice about parking");
    // Provenance, so the room map's edge query is exercised as well.
    setDerivedFrom(db, keeper, doomed);
    embedEveryChunk(db, [1.0, 0.0]);

    trashFile(db, doomed, { kind: "user" });

    // --- listings ---------------------------------------------------------
    expect(names(listFiles(db))).toEqual(["invoice.txt"]);
    expect(listFilesBrief(db).some(([n]) => n.includes("lease"))).toBe(false);
    expect(listFileInventory(db).some(([n]) => n.includes("lease"))).toBe(false);
    expect(listFilesForSummary(db).some((f) => f.id === doomed)).toBe(false);
    expect(filesWithBytes(db).some(([i]) => i === doomed)).toBe(false);
    expect(filesMissingSummary(db, 50).some(([i]) => i === doomed)).toBe(false);
    expect(fileNamesHint(db)).not.toContain("lease.txt");

    // --- counts -----------------------------------------------------------
    expect(roomFileCount(db)).toBe(1);
    expect(roomCounts(db)[0]).toBe(1);

    // --- name lookups -----------------------------------------------------
    expect(fileByExactName(db, "lease.txt")).toBeNull();
    expect(() => findFileLike(db, "lease")).toThrow();
    expect(() => findFileLikeFull(db, "lease")).toThrow();
    expect(() => findSourceFileLike(db, "lease")).toThrow();
    expect(filesNameLike(db, "lease")).toEqual([]);
    // A name in the trash does not hold that name against a new file.
    expect(availableName(db, "lease.txt")).toBe("lease.txt");
    // Nor does it count as an existing copy of those bytes on re-import.
    expect(fileWithSameBytes(db, Buffer.from("the tenant pays rent monthly"))).toBeNull();

    // --- by-id reads (a stale id must not resurrect it) --------------------
    expect(() => getFileMeta(db, doomed)).toThrow();
    expect(() => getFileName(db, doomed)).toThrow();
    expect(() => getFileFull(db, doomed)).toThrow();
    expect(() => getFileBytes(db, doomed)).toThrow();
    expect(() => getFileBytesNamed(db, doomed)).toThrow();
    expect(getFileExtractedText(db, doomed)).toBeNull();

    // --- search / retrieval -----------------------------------------------
    expect(searchChunksFtsRanked(db, '"rent"', 10)).toEqual([]);
    expect(filesContentFts(db, '"rent"', 10)).toEqual([]);
    expect(ftsFileMatches(db, '"rent"', "", 10)).toEqual([]);
    expect(recentChunks(db, 50).some(([n]) => n === "lease.txt")).toBe(false);
    expect(chunksMissingEmbedding(db, 50).some(([, n]) => n === "lease.txt")).toBe(false);
    const rowids: number[] = [];
    forEachChunkEmbedding(db, (r) => rowids.push(r));
    expect(chunksByRowids(db, rowids).some(([, n]) => n === "lease.txt")).toBe(false);
    // The keeper is untouched by all of it.
    expect(filesContentFts(db, '"parking"', 10).length).toBe(1);

    // --- other whole-room passes ------------------------------------------
    expect(derivedLinks(db), "an edge to a trashed file is not drawn").toEqual([]);
    // (`files_needing_privacy_scan` — db/privacy.rs — is not ported; that
    //  assertion needs its own test when privacy.ts lands.)
    // And the trash view is the ONE place it does show up.
    const trashed = listTrashedFiles(db);
    expect(trashed.length).toBe(1);
    expect(trashed[0]?.name).toBe("lease.txt");
    expect(trashed[0]?.folderId).toBe(folderId);
    db.close();
  });

  it("a_stale_id_gets_nothing_from_a_trashed_files_sidecar_tables", () => {
    // The SIDECAR reads — the ones that answer by id out of a column the
    // listings never touch. Every one of these was written before the trash
    // existed, so a stale id (an open tab, a chat message's `sources`, a
    // paused job's plan) still got a real answer about a deleted file.
    // Reduced to the two sidecar columns this batch owns; `rec_meta`
    // (db/recordings.rs) and `provenance`/`file_versions` (db/versions.rs)
    // need the same test once those modules land.
    const db = freshRoom();
    const doomed = addFile(db, "interview.mp4", "the transcript of the interview");

    setMediaMeta(db, doomed, '{"durationSecs":612.0}');
    setWebMeta(db, doomed, '{"title":"Interview with the tenant"}');

    trashFile(db, doomed, { kind: "user" });

    // The viewer's video strip (`probe_video_meta` calls this by id).
    expect(getMediaMeta(db, doomed)).toBeNull();
    // The saved-page strip.
    expect(getWebMeta(db, doomed)).toBeNull();
    // And a rename says so instead of quietly retitling a trashed row.
    expect(() => renameFile(db, doomed, "renamed.mp4")).toThrow();
    expect(listTrashedFiles(db)[0]?.name).toBe("interview.mp4");

    // Restore is the other half of the invariant: every one of them comes
    // back, unchanged. Trash HIDES; it never edits and never discards.
    restoreFile(db, doomed);
    expect(getMediaMeta(db, doomed)).toBe('{"durationSecs":612.0}');
    expect(getWebMeta(db, doomed)).not.toBeNull();
    expect(() => renameFile(db, doomed, "renamed.mp4")).not.toThrow();
    db.close();
  });

  it("the_actor_that_deleted_a_file_is_recorded", () => {
    // "What did the agent delete" is the question the feature exists to
    // answer, so an agent delete must be distinguishable from a person's — by
    // kind AND by which agent.
    const db = freshRoom();
    const byUser = addFile(db, "a.txt", "one");
    const byAgent = addFile(db, "b.txt", "two");
    const byApp = addFile(db, "c.txt", "three");
    trashFile(db, byUser, { kind: "user" });
    trashFile(db, byAgent, { kind: "agent", who: "files.edit/delete_file" });
    trashFile(db, byApp, { kind: "app", what: "summarize_room" });

    const byId = new Map<string, TrashedFile>(listTrashedFiles(db).map((f) => [f.id, f]));
    expect(byId.get(byUser)?.trashedBy).toBe("user");
    expect(byId.get(byUser)?.trashedById).toBeNull();
    expect(byId.get(byAgent)?.trashedBy).toBe("agent");
    expect(byId.get(byAgent)?.trashedById, "which agent, not just that it was one").toBe(
      "files.edit/delete_file"
    );
    expect(byId.get(byApp)?.trashedBy).toBe("app");
    expect(byId.get(byApp)?.trashedById).toBe("summarize_room");
    // Every row carries WHEN, and the trash counts them all.
    expect([...byId.values()].every((f) => f.trashedAt !== "")).toBe(true);
    expect(trashedFileCount(db)).toBe(3);

    // A second trash of the same file is refused rather than re-stamping it:
    // that would overwrite the record of who actually deleted it, and would
    // move an empty chunk set over the real one.
    expect(() => trashFile(db, byAgent, { kind: "user" })).toThrow();
    expect(listTrashedFiles(db).length).toBe(3);
    const still = listTrashedFiles(db).find((f) => f.id === byAgent);
    expect(still?.trashedBy, "the original actor survived the second attempt").toBe("agent");
    db.close();
  });

  it("permanent_delete_really_destroys_and_only_touches_the_trash", () => {
    const db = freshRoom();
    const doomed = addFile(db, "gone.txt", "text that must not survive");
    const keeper = addFile(db, "stays.txt", "text that must survive");
    // Give the doomed file a version and a chunk stash, so the cascade has
    // something to prove. (`snapshot_file_version` is db/versions.rs, not
    // ported — stood in with a direct INSERT, since what is under test here
    // is the schema's FK cascade, not the writer.)
    updateFileContent(db, doomed, Buffer.from("v2"), "v2 text");
    db.prepare("INSERT INTO file_versions(id, file_id, bytes, cause) VALUES (?, ?, ?, 'test')").run(
      randomUUID(),
      doomed,
      Buffer.from("v1")
    );
    const versions = (sql: string): number => (db.prepare(sql).get(doomed) as { c: number }).c;
    expect(versions("SELECT count(*) as c FROM file_versions WHERE file_id = ?")).toBe(1);

    trashFile(db, doomed, { kind: "user" });
    expect(
      versions("SELECT count(*) as c FROM trashed_chunks WHERE file_id = ?"),
      "trashing stashed the chunks"
    ).toBeGreaterThan(0);

    deleteFile(db, doomed);

    expect(versions("SELECT count(*) as c FROM files WHERE id = ?"), "the row is gone").toBe(0);
    expect(versions("SELECT count(*) as c FROM chunks WHERE file_id = ?")).toBe(0);
    expect(versions("SELECT count(*) as c FROM trashed_chunks WHERE file_id = ?")).toBe(0);
    expect(versions("SELECT count(*) as c FROM file_versions WHERE file_id = ?")).toBe(0);
    // Its text is out of the FTS index too — an orphan term would still
    // surface the deleted file's words in an answer.
    expect(searchChunksFtsRanked(db, '"survive"', 10).every(([, n]) => n === "stays.txt")).toBe(
      true
    );
    // A second permanent delete is a miss, not a cheerful success.
    expect(() => deleteFile(db, doomed)).toThrow();
    // The file that was never deleted is entirely unaffected.
    expect(names(listFiles(db))).toEqual(["stays.txt"]);

    // emptyTrash destroys what is IN the trash and nothing else, and reports
    // the real number both times.
    expect(emptyTrash(db), "an empty trash destroys nothing").toBe(0);
    const second = addFile(db, "also-gone.txt", "more doomed text");
    trashFile(db, second, { kind: "app", what: "test" });
    expect(emptyTrash(db)).toBe(1);
    expect(listTrashedFiles(db)).toEqual([]);
    expect(names(listFiles(db))).toEqual(["stays.txt"]);
    expect(getFileExtractedText(db, keeper)).toBe("text that must survive");
    db.close();
  });

  it("restore_refuses_anything_that_is_not_in_the_trash", () => {
    const db = freshRoom();
    const present = addFile(db, "here.txt", "still here");
    expect(() => restoreFile(db, present)).toThrow();
    expect(() => restoreFile(db, "no-such-id")).toThrow();
    // …and the present file was not disturbed by the refusal.
    expect(listFiles(db).length).toBe(1);
    expect(searchChunksFtsRanked(db, '"here"', 5).length).toBe(1);
    db.close();
  });

  it("an_older_room_gains_the_trash_columns_when_it_is_migrated", () => {
    const db = freshRoom();
    db.exec(
      `ALTER TABLE files DROP COLUMN trashed_at;
       ALTER TABLE files DROP COLUMN trashed_by;
       ALTER TABLE files DROP COLUMN trashed_by_id;
       DROP TABLE trashed_chunks;`
    );
    db.prepare(
      "INSERT INTO files(id, name, mime_type, source) VALUES ('legacy', 'old.txt', 'text/plain', 'upload')"
    ).run();
    expect(columnExists(db, "files", "trashed_at")).toBe(false);

    migrate(db);

    expect(columnExists(db, "files", "trashed_at")).toBe(true);
    expect(tableExists(db, "trashed_chunks")).toBe(true);
    // Nothing that was in the library before the trash existed was ever
    // deleted, so nothing starts out in it.
    expect(listTrashedFiles(db)).toEqual([]);
    expect(names(listFiles(db))).toEqual(["old.txt"]);
    // And the feature works on the migrated room.
    trashFile(db, "legacy", { kind: "user" });
    expect(listTrashedFiles(db).length).toBe(1);
    restoreFile(db, "legacy");
    expect(names(listFiles(db))).toEqual(["old.txt"]);
    // Idempotent on the next open.
    migrate(db);
    expect(names(listFiles(db))).toEqual(["old.txt"]);
    db.close();
  });

  it("a_late_background_write_cannot_reindex_a_trashed_file", () => {
    // Not hypothetical: OCR and transcription run on background workers that
    // finish long after the import that queued them, and they call
    // updateFileContent/setFileExtractedText by id.
    const db = freshRoom();
    const id = addFile(db, "scan.pdf", "");
    trashFile(db, id, { kind: "user" });

    // The OCR worker finishes and writes what it read.
    updateFileContent(db, id, Buffer.from("scanned bytes"), "the invoice total is 4,200");
    expect(
      searchChunksFtsRanked(db, '"invoice"', 5),
      "a trashed file's freshly extracted text stays out of the live index"
    ).toEqual([]);
    expect(filesContentFts(db, '"invoice"', 5)).toEqual([]);
    expect(ftsFileMatches(db, '"invoice"', "", 5)).toEqual([]);

    // The transcription path (text-only write) behaves the same way.
    setFileExtractedText(db, id, "the invoice total is 5,300");
    expect(searchChunksFtsRanked(db, '"invoice"', 5)).toEqual([]);

    // …and restoring brings back the CURRENT text, not the text the file had
    // at the moment it was deleted.
    restoreFile(db, id);
    const hits = searchChunksFtsRanked(db, '"invoice"', 5);
    expect(hits.length, "one chunk, not one per background write").toBe(1);
    expect(hits[0]?.[2]).toContain("5,300");
    expect(hits[0]?.[2]).not.toContain("4,200");
    db.close();
  });
});

// ============================================= db.rs's own insertChunks tests

describe("insertChunks atomicity (ported from db.rs's own mod tests)", () => {
  it("a_failed_chunking_leaves_no_half_indexed_file", () => {
    // Chunking used to be one autocommitted INSERT per chunk, so a failure
    // (or a crash) part-way through left the earlier chunks in the index —
    // the file read as searchable while most of it was missing.
    const db = freshRoom();
    // `text: null` matches the Rust fixture exactly: a non-null text would
    // already have written chunks before `insertChunks` is called below.
    const id = insertFile(db, "a.txt", "text/plain", Buffer.from("x"), null, "upload").id;
    // Fail on the 5th chunk, the way an interrupted import would.
    db.exec(
      `CREATE TEMP TRIGGER fail_late BEFORE INSERT ON chunks WHEN NEW.seq = 4
       BEGIN SELECT RAISE(ABORT, 'interrupted'); END;`
    );
    const long = "word ".repeat(Math.floor((CHUNK_TARGET_CHARS * 6) / 5));
    expect(() => insertChunks(db, id, long)).toThrow();
    const left = (
      db.prepare("SELECT count(*) as c FROM chunks WHERE file_id = ?").get(id) as { c: number }
    ).c;
    expect(left, "a failed chunking must leave the file un-indexed, not half-indexed").toBe(0);
    db.close();
  });

  it("chunking_nests_inside_a_caller_transaction", () => {
    // `updateFileContent`/`setFileExtractedText` (and the commit-plans /
    // restore-version paths) already hold BEGIN IMMEDIATE when they reach
    // here, so the batching must be a SAVEPOINT, not BEGIN.
    const db = freshRoom();
    db.exec("BEGIN IMMEDIATE");
    const id = insertFile(db, "b.txt", "text/plain", Buffer.from("x"), null, "upload").id;
    const long = "word ".repeat(Math.floor((CHUNK_TARGET_CHARS * 6) / 5));
    insertChunks(db, id, long);
    db.exec("COMMIT");
    const n = (
      db.prepare("SELECT count(*) as c FROM chunks WHERE file_id = ?").get(id) as { c: number }
    ).c;
    expect(n, `expected several chunks, got ${n}`).toBeGreaterThanOrEqual(2);
    db.close();
  });

  it("chunk sizes are budgeted in UTF-8 BYTES, as chunking.rs measures them", () => {
    // Not in the Rust suite (its own `chunk_text` tests live in
    // extraction/chunking.rs), but it pins the fidelity call this port's
    // header makes: Rust's `target_chars` comparisons are `str::len()` —
    // BYTES — and a Hebrew character is 2 of them but 1 UTF-16 code unit, so
    // measuring `.length` would let each chunk grow to roughly double the
    // Rust build's. Every chunk here must fit within a small multiple of the
    // 1200-byte target, and the Latin and Hebrew documents must chunk to
    // comparable BYTE sizes rather than comparable character counts.
    const db = freshRoom();
    const hebrewWord = "שלום ";
    const hebrew = hebrewWord.repeat(2_000); // 10,000 chars / 18,000 bytes
    const id = addFile(db, "hebrew.txt", hebrew);
    const chunks = db
      .prepare("SELECT text FROM chunks WHERE file_id = ? ORDER BY seq")
      .pluck()
      .all(id) as string[];
    expect(chunks.length, "a wall of Hebrew text came back as one chunk").toBeGreaterThan(1);
    for (const c of chunks) {
      expect(
        Buffer.byteLength(c, "utf8"),
        `a chunk of ${Buffer.byteLength(c, "utf8")} bytes overran the 1200-byte target`
      ).toBeLessThanOrEqual(CHUNK_TARGET_CHARS);
    }
    // The same number of BYTES of Latin text produces about the same number
    // of chunks — which is only true if both are measured in bytes.
    const latin = addFile(db, "latin.txt", "shalom ".repeat(2_571)); // ~18,000 bytes
    const latinChunks = (
      db.prepare("SELECT count(*) as c FROM chunks WHERE file_id = ?").get(latin) as { c: number }
    ).c;
    expect(Math.abs(latinChunks - chunks.length)).toBeLessThanOrEqual(2);
    db.close();
  });
});

// ===================================================== supplementary coverage
// Functions files.rs's own test module does not exercise directly (covered
// there only implicitly, via commands-layer callers this batch does not
// port). Not in the Rust suite.

describe("supplementary coverage (not in the Rust suite)", () => {
  it("setLibraryVisibility states the value rather than toggling it; placementNote reads it", () => {
    const db = freshRoom();
    const id = addFile(db, "sketch.json", "{}");
    markSectionOnly(db, id, "sketch");
    expect(placementNote("sketch", "sectionOnly")).toBe(
      " [section only — in sketch, not in the Library]"
    );
    expect(placementNote("library", "linked")).toBe("");
    // Idempotent in BOTH directions — stating, not toggling.
    setLibraryVisibility(db, id, false);
    expect(getFileMeta(db, id).libraryVisibility).toBe("sectionOnly");
    setLibraryVisibility(db, id, true);
    expect(getFileMeta(db, id).libraryVisibility).toBe("linked");
    setLibraryVisibility(db, id, true);
    expect(getFileMeta(db, id).libraryVisibility).toBe("linked");
    setLibraryVisibility(db, id, false);
    expect(getFileMeta(db, id).libraryVisibility).toBe("sectionOnly");
    // A row that is gone (or trashed) is a failure, not a silent success.
    expect(() => setLibraryVisibility(db, "no-such-id", true)).toThrow();
    trashFile(db, id, { kind: "user" });
    expect(() => setLibraryVisibility(db, id, true)).toThrow();
    db.close();
  });

  it("fileOriginUrl reads null for absent, blank and missing/trashed rows", () => {
    const db = freshRoom();
    const noUrl = addFile(db, "typed.md", "x");
    expect(fileOriginUrl(db, noUrl)).toBeNull();
    const withUrl = insertFileFromUrl(
      db,
      "page.html",
      "text/html",
      Buffer.from("x"),
      null,
      "web",
      "https://example.test/a"
    ).id;
    expect(fileOriginUrl(db, withUrl)).toBe("https://example.test/a");
    const blank = insertFileFromUrl(db, "blank.html", "text/html", Buffer.from("x"), null, "web", "   ")
      .id;
    expect(fileOriginUrl(db, blank)).toBeNull();
    expect(fileOriginUrl(db, "no-such-id")).toBeNull();
    trashFile(db, withUrl, { kind: "user" });
    expect(fileOriginUrl(db, withUrl)).toBeNull();
    db.close();
  });

  it("getFileFull / getFileBytesNamed / getFileName / anyFileName", () => {
    const db = freshRoom();
    const id = insertFile(db, "doc.txt", "text/plain", Buffer.from("hello"), "hello", "upload").id;
    expect(getFileFull(db, id)).toEqual(["doc.txt", "text/plain", Buffer.from("hello"), "hello"]);
    expect(getFileBytesNamed(db, id)).toEqual(["doc.txt", Buffer.from("hello")]);
    expect(getFileName(db, id)).toBe("doc.txt");
    expect(anyFileName(db, id)).toBe("doc.txt");
    trashFile(db, id, { kind: "user" });
    expect(() => getFileName(db, id)).toThrow();
    expect(anyFileName(db, id), "anyFileName sees trashed rows too — receipts only").toBe(
      "doc.txt"
    );
    expect(anyFileName(db, "nope")).toBeNull();
    db.close();
  });

  it("renameFile rejects a blank name and a stale id", () => {
    const db = freshRoom();
    const id = addFile(db, "old.txt", "x");
    expect(() => renameFile(db, id, "   ")).toThrow("File name cannot be empty.");
    renameFile(db, id, "new.txt");
    expect(getFileName(db, id)).toBe("new.txt");
    expect(() => renameFile(db, "no-such-id", "whatever.txt")).toThrow();
    db.close();
  });

  it("setDerivedFrom / derivedLinks: self-reference is refused, both ends must be in the room", () => {
    const db = freshRoom();
    const src = addFile(db, "source.txt", "x");
    const out = addFile(db, "derived.txt", "y");
    setDerivedFrom(db, src, src); // no-op, self-reference refused
    expect(derivedLinks(db)).toEqual([]);
    setDerivedFrom(db, out, src);
    expect(derivedLinks(db)).toEqual([[src, out]]);
    trashFile(db, src, { kind: "user" });
    expect(derivedLinks(db), "an edge to a trashed SOURCE is not drawn either").toEqual([]);
    db.close();
  });

  it("columnExists / tableExists / currentDate / searchKey", () => {
    const db = freshRoom();
    expect(columnExists(db, "files", "name")).toBe(true);
    expect(columnExists(db, "files", "no-such-column")).toBe(false);
    expect(tableExists(db, "files")).toBe(true);
    // A virtual table counts, which is what the FTS guard depends on.
    expect(tableExists(db, "chunks_fts")).toBe(true);
    expect(tableExists(db, "no-such-table")).toBe(false);
    expect(currentDate(db)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(searchKey("  Hello   World  ")).toBe("hello world");
    expect(searchKey("")).toBe("");
    db.close();
  });

  it("fileNamesHint says so when the room is empty, and lists names when it is not", () => {
    const db = freshRoom();
    expect(fileNamesHint(db)).toBe(" This room has no files yet.");
    addFile(db, "lease.pdf", "x");
    expect(fileNamesHint(db)).toBe(" Files in this room: lease.pdf.");
    db.close();
  });

  it("filesMissingText / filesWithBytes", () => {
    const db = freshRoom();
    const noText = insertFile(db, "scan.pdf", "application/pdf", Buffer.from("%PDF"), null, "upload")
      .id;
    const hasText = addFile(db, "notes.txt", "already extracted");
    const noBytes = insertFileFromUrl(
      db,
      "page.html",
      "text/html",
      Buffer.from(""),
      null,
      "web",
      "https://x.test"
    ).id;
    // Give noBytes a genuinely NULL original_bytes, matching the "downloaded,
    // bytes discarded" shape both queries guard against.
    db.prepare("UPDATE files SET original_bytes = NULL WHERE id = ?").run(noBytes);

    expect(filesMissingText(db).map(([id]) => id)).toEqual([noText]);
    expect(
      filesWithBytes(db)
        .map(([id]) => id)
        .sort()
    ).toEqual([hasText, noText].sort());

    // A TRASHED file is not a re-extraction candidate: the pass would OCR a
    // file the room is no longer showing and index the result. `filesWithBytes`
    // is covered for this by
    // `a_trashed_file_is_excluded_from_every_place_files_are_found` above;
    // `filesMissingText` is named in NEITHER suite's trash test, so dropping
    // its `trashed_at IS NULL` passes everything else (verified by mutation).
    const doomed = insertFile(db, "trashed-scan.pdf", "application/pdf", Buffer.from("%PDF2"), null, "upload").id;
    trashFile(db, doomed, { kind: "user" });
    expect(filesMissingText(db).map(([id]) => id)).toEqual([noText]);
    expect(filesWithBytes(db).some(([id]) => id === doomed)).toBe(false);
    db.close();
  });

  it("filesContentFts's trashed filter is real defence, not decoration", () => {
    // Not in the Rust suite. Trashing MOVES a file's chunks into
    // `trashed_chunks`, so in a healthy room this query's `f.trashed_at IS
    // NULL` can never change the answer — which is exactly why deleting it
    // leaves every other test in this file green. The clause is there so that
    // a room where the move did NOT happen (an older build, a partial
    // migration, a future change to how the trash stores chunks — the case
    // `chunksMissingEmbedding`'s own comment spells out) still cannot leak a
    // deleted file's text into an answer. So the fixture breaks that
    // invariant on purpose; without that, the assertion tests nothing.
    const db = freshRoom();
    const doomed = addFile(db, "lease.txt", "the tenant pays rent");
    trashFile(db, doomed, { kind: "user" });
    db.prepare("INSERT INTO chunks(id, file_id, seq, text) VALUES (?, ?, 0, ?)").run(
      randomUUID(),
      doomed,
      "the tenant pays rent"
    );
    expect(
      (db.prepare("SELECT count(*) as c FROM chunks WHERE file_id = ?").get(doomed) as { c: number })
        .c,
      "the fixture must really have leaked a chunk, or this proves nothing"
    ).toBe(1);
    expect(filesContentFts(db, '"rent"', 10)).toEqual([]);
    db.close();
  });
});
