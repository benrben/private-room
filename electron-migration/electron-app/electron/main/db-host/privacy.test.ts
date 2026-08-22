/**
 * Vitest port of `src-tauri/src/db/privacy.rs`'s `#[cfg(test)] mod tests`:
 *
 *   - minting_walks_the_series_per_category
 *   - duplicate_real_text_returns_existing_and_user_upgrades_scan
 *   - letters_series_goes_past_z
 *   - scan_state_tracks_staleness
 *   - editing_a_scanned_file_restales_it
 *   - a_half_written_scan_row_is_never_trusted
 *   - short_entities_rejected
 *   - the_length_floor_counts_characters_not_bytes
 *   - duplicates_are_folded_past_ascii
 *
 * PLUS the assertion `files.test.ts`'s own module doc flags as dropped pending
 * this file (a trashed file is excluded from the scan work list), and the
 * upsert/read-back paths the Rust tests only reach indirectly.
 *
 * REAL FIXTURE ROOMS via `createRoom`, matching this directory's convention —
 * `privacy_entities`/`privacy_scans` are real schema tables, not plumbing to
 * exercise against a bare in-memory connection. `db::mem()`/`db::add_file`
 * (Rust's lighter unencrypted fixtures) have no port; `files.ts`'s
 * `insertFile`/`setFileExtractedText`/`trashFile` are this directory's real
 * writers of the table `filesNeedingPrivacyScan` reads.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./open.js";
import { insertFile, setFileExtractedText, trashFile } from "./files.js";
import {
  addPrivacyEntity,
  deletePrivacyEntity,
  dismissPrivacyEntity,
  entitySource,
  filesNeedingPrivacyScan,
  getPrivacyScan,
  listPrivacyEntities,
  privacyTextSha,
  setPrivacyScan,
} from "./privacy.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-privacy-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

/** `db::add_file` — the Rust test module's own minimal file-insert helper. */
function addFile(db: Database.Database, name: string, text: string): string {
  return insertFile(db, name, "text/plain", Buffer.from(text, "utf8"), text, "upload").id;
}

describe("addPrivacyEntity", () => {
  it("minting_walks_the_series_per_category", () => {
    const db = freshRoom();
    const a = addPrivacyEntity(db, "Ben Reich", "person", "scan");
    const b = addPrivacyEntity(db, "Dana Levi", "person", "scan");
    const c = addPrivacyEntity(db, "12 Herzl St", "address", "scan");
    expect(a.placeholder).toBe("[Person A]");
    expect(b.placeholder).toBe("[Person B]");
    expect(c.placeholder).toBe("[Address A]");
    db.close();
  });

  it("an unknown category lands in the neutral Private series", () => {
    const db = freshRoom();
    expect(addPrivacyEntity(db, "my health", "concept", "scan").placeholder).toBe("[Private A]");
    expect(addPrivacyEntity(db, "054-1234567", "phone", "scan").placeholder).toBe("[Phone A]");
    db.close();
  });

  it("duplicate_real_text_returns_existing_and_user_upgrades_scan", () => {
    const db = freshRoom();
    const a = addPrivacyEntity(db, "Ben Reich", "person", "scan");
    const b = addPrivacyEntity(db, "ben reich", "person", "user");
    expect(b.id).toBe(a.id);
    expect(b.placeholder).toBe("[Person A]");
    const all = listPrivacyEntities(db);
    expect(all.length).toBe(1);
    // Read through the LIST, not off `b`: this port is bug-compatible with
    // Rust's `add_privacy_entity`, which hands back the row as it was read
    // BEFORE the scan->user upgrade. The stored truth is what matters.
    expect(all[0]?.source).toBe("user");
    db.close();
  });

  it("short_entities_rejected", () => {
    const db = freshRoom();
    expect(() => addPrivacyEntity(db, " a ", "person", "user")).toThrow();
    db.close();
  });

  it("the_length_floor_counts_characters_not_bytes", () => {
    // One Hebrew letter is two BYTES, so a byte-length floor would accept it
    // while the error text promises a two-CHARACTER floor — and the redactor
    // then discards the item the panel called protected.
    const db = freshRoom();
    expect(() => addPrivacyEntity(db, "א", "person", "user")).toThrow(/at least 2 characters/);
    expect(() => addPrivacyEntity(db, "אב", "person", "user")).not.toThrow();
    db.close();
  });

  it("duplicates_are_folded_past_ascii", () => {
    // SQLite's lower() is ASCII-only, so this pair used to become two rows with
    // two placeholders for one person.
    const db = freshRoom();
    const a = addPrivacyEntity(db, "José Muñoz", "person", "user");
    const b = addPrivacyEntity(db, "JOSÉ MUÑOZ", "person", "scan");
    expect(b.id).toBe(a.id);
    expect(b.placeholder).toBe("[Person A]");
    expect(listPrivacyEntities(db).length).toBe(1);
    db.close();
  });

  it("letters_series_goes_past_z", () => {
    const db = freshRoom();
    const placeholders: string[] = [];
    for (let i = 0; i < 28; i++) {
      placeholders.push(addPrivacyEntity(db, `Person Number ${i}`, "person", "scan").placeholder);
    }
    expect(placeholders[0]).toBe("[Person A]");
    expect(placeholders[25]).toBe("[Person Z]");
    expect(placeholders[26]).toBe("[Person AA]");
    expect(placeholders[27]).toBe("[Person AB]");
    db.close();
  });

  it("a placeholder freed by a delete is not minted twice for two live rows", () => {
    // The mint counts the series and then walks forward past anything taken, so
    // a hole left by a deleted row is reused — but never handed to two rows at
    // once, which is what would make one placeholder restore to two names.
    const db = freshRoom();
    const a = addPrivacyEntity(db, "Ben Reich", "person", "scan");
    const b = addPrivacyEntity(db, "Dana Levi", "person", "scan");
    deletePrivacyEntity(db, a.id);
    const c = addPrivacyEntity(db, "Yael Cohen", "person", "scan");
    expect(c.placeholder).not.toBe(b.placeholder);
    const live = listPrivacyEntities(db).map((e) => e.placeholder);
    expect(new Set(live).size).toBe(live.length);
    db.close();
  });
});

describe("listPrivacyEntities / delete / dismiss / entitySource", () => {
  it("user rows sort before scan rows", () => {
    const db = freshRoom();
    addPrivacyEntity(db, "Scan One", "person", "scan");
    addPrivacyEntity(db, "User One", "person", "user");
    addPrivacyEntity(db, "Scan Two", "person", "scan");
    expect(listPrivacyEntities(db)[0]?.source).toBe("user");
    db.close();
  });

  it("delete removes the row outright; dismiss tombstones it", () => {
    const db = freshRoom();
    const scanFound = addPrivacyEntity(db, "Ben Reich", "person", "scan");
    const userAdded = addPrivacyEntity(db, "Dana Levi", "person", "user");

    dismissPrivacyEntity(db, scanFound.id);
    expect(listPrivacyEntities(db).find((e) => e.id === scanFound.id)?.source).toBe("dismissed");

    deletePrivacyEntity(db, userAdded.id);
    expect(listPrivacyEntities(db).find((e) => e.id === userAdded.id)).toBeUndefined();
    // The dismissed row STAYS — a tombstone, so a re-scan cannot resurrect it.
    expect(listPrivacyEntities(db).some((e) => e.id === scanFound.id)).toBe(true);
    db.close();
  });

  it("entitySource reads a row's source, and throws for an id that names no row", () => {
    const db = freshRoom();
    const e = addPrivacyEntity(db, "Ben Reich", "person", "user");
    expect(entitySource(db, e.id)).toBe("user");
    expect(() => entitySource(db, "no-such-id")).toThrow();
    db.close();
  });
});

describe("scan bookkeeping", () => {
  it("scan_state_tracks_staleness", () => {
    const db = freshRoom();
    const fid = addFile(db, "a.txt", "Ben Reich's lease");
    expect(filesNeedingPrivacyScan(db, "r1").length).toBe(1);
    setPrivacyScan(db, fid, privacyTextSha("Ben Reich's lease"), "r1");
    expect(filesNeedingPrivacyScan(db, "r1")).toEqual([]);
    // New rules hash -> stale again.
    expect(filesNeedingPrivacyScan(db, "r2").length).toBe(1);
    db.close();
  });

  it("editing_a_scanned_file_restales_it", () => {
    // The leak this pins: a file scanned once stayed "protected" forever, so
    // names added to it afterwards reached a cloud model unhidden.
    const db = freshRoom();
    const fid = addFile(db, "a.txt", "nothing private here");
    setPrivacyScan(db, fid, privacyTextSha("nothing private here"), "r1");
    expect(filesNeedingPrivacyScan(db, "r1")).toEqual([]);

    setFileExtractedText(db, fid, "now it names Dana Levi, 054-1234567");
    const pending = filesNeedingPrivacyScan(db, "r1");
    expect(pending.length, "an edited file must come back for a re-scan").toBe(1);
    expect(pending[0]?.[0]).toBe(fid);
    expect(pending[0]?.[2]).toBe("now it names Dana Levi, 054-1234567");

    // Re-scanning the NEW text settles it again (no permanent re-scan loop).
    setPrivacyScan(db, fid, privacyTextSha("now it names Dana Levi, 054-1234567"), "r1");
    expect(filesNeedingPrivacyScan(db, "r1")).toEqual([]);
    db.close();
  });

  it("a_half_written_scan_row_is_never_trusted", () => {
    // Belt and braces: an empty digest (older row, interrupted write) must read
    // as "not scanned", never as "scanned and unchanged".
    const db = freshRoom();
    const fid = addFile(db, "a.txt", "text");
    setPrivacyScan(db, fid, "", "r1");
    expect(filesNeedingPrivacyScan(db, "r1").length).toBe(1);
    db.close();
  });

  it("getPrivacyScan reads back what setPrivacyScan wrote, or null before any scan, and upserts", () => {
    const db = freshRoom();
    const fid = addFile(db, "a.txt", "hello");
    expect(getPrivacyScan(db, fid)).toBeNull();
    setPrivacyScan(db, fid, privacyTextSha("hello"), "r1");
    expect(getPrivacyScan(db, fid)).toEqual([privacyTextSha("hello"), "r1"]);
    // A second scan of the same file replaces the row rather than erroring on
    // the PRIMARY KEY.
    setPrivacyScan(db, fid, privacyTextSha("hello v2"), "r2");
    expect(getPrivacyScan(db, fid)).toEqual([privacyTextSha("hello v2"), "r2"]);
    db.close();
  });

  // The assertion `files.test.ts`'s own doc flags as dropped pending this file:
  // a trashed file must not come back as needing a scan.
  it("excludes trashed files and files with no extracted text from the work list", () => {
    const db = freshRoom();
    addFile(db, "empty.txt", ""); // no text: never a scan candidate
    const trashed = addFile(db, "gone.txt", "Ben Reich's medical history");
    expect(filesNeedingPrivacyScan(db, "r1").some(([id]) => id === trashed)).toBe(true);
    trashFile(db, trashed, { kind: "user" });
    expect(filesNeedingPrivacyScan(db, "r1").some(([id]) => id === trashed)).toBe(false);

    const withText = addFile(db, "b.txt", "Ben Reich lives here");
    expect(filesNeedingPrivacyScan(db, "r1").map(([id]) => id)).toEqual([withText]);
    db.close();
  });
});

describe("privacyTextSha", () => {
  it("is a stable sha256 hex digest, sensitive to the exact text", () => {
    expect(privacyTextSha("hello")).toBe(privacyTextSha("hello"));
    expect(privacyTextSha("hello")).not.toBe(privacyTextSha("hello!"));
    expect(privacyTextSha("hello")).toMatch(/^[0-9a-f]{64}$/);
    // Hashed as UTF-8 BYTES, the way Rust hashes `text.as_bytes()`. The digest
    // is PERSISTED in `privacy_scans` and this app opens rooms the Rust build
    // wrote, so these two literals are the contract, not a restatement of the
    // implementation: sha256 of the two UTF-8 bytes of "é", and of "Ben Reich".
    expect(privacyTextSha("é")).toBe("4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c");
    expect(privacyTextSha("Ben Reich")).toBe(
      "0845cff96c635dd79d938f59aa89ea53a2372c709e254d5eea7c295cbd538d95"
    );
  });
});
