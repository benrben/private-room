/**
 * Vitest port of the `schema.rs` tests that cover `apply_key`/`verify_key`/
 * `classify_first_read`/`create_room`/`create_room_file`/`open_room`/
 * `open_room_readonly` (the `mod tests` block in `src-tauri/src/db/schema.rs`,
 * filtered to the tests that exercise THIS module rather than `migrate`):
 *
 *   - room_reopens_after_create
 *   - a_failed_creation_leaves_no_file_blocking_the_retry
 *   - a_room_password_must_clear_the_length_rule
 *   - only_an_undecryptable_file_reads_as_a_wrong_password
 *   - a_read_only_open_verifies_without_writing (minus the `migrate(&conn)
 *     .is_err()` assertion — `migrate` is ported separately, see open.ts)
 *
 * Plus: create+reopen+read, a REAL Rust-produced fixture (`plain.roomai` and
 * `quote-password.roomai`, mirroring `s1_spike.mjs`), short/exact-length
 * passwords, path-already-exists, a schema-completeness guard (`create_room`
 * must run SCHEMA in full, never leaving a brand-new room short a table that
 * used to live only in `migrate`), and a room whose `meta` table is missing
 * ENTIRELY (not just holding the wrong format value) — the case that must
 * still read as "This file is not an Arcelle project." rather than leaking
 * a raw "no such table: meta" driver error.
 */

import Database from "better-sqlite3-multiple-ciphers";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyKey,
  classifyFirstRead,
  createRoom,
  createRoomFile,
  CURRENT_USER_VERSION,
  MIN_ROOM_PASSWORD_CHARS,
  openRoom,
  openRoomReadonly,
  verifyKey,
} from "./open.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../../../../spikes/s1-db-compat/fixtures");
const FIXTURE_PLAIN = path.join(fixturesDir, "plain.roomai");
const FIXTURE_QUOTE_PASSWORD = path.join(fixturesDir, "quote-password.roomai");

// A unique throwaway room path in a fresh temp dir per test.
let tmpDir: string;
function tempRoomPath(): string {
  return path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function withFreshTmpDir<T>(fn: () => T): T {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-open-"));
  return fn();
}

describe("MIN_ROOM_PASSWORD_CHARS / CURRENT_USER_VERSION", () => {
  it("constants_match_schema_rs", () => {
    expect(MIN_ROOM_PASSWORD_CHARS).toBe(8);
    expect(CURRENT_USER_VERSION).toBe(3);
  });
});

describe("createRoom + openRoom", () => {
  it("create_a_room_reopen_it_read_back_a_row_you_inserted", () => {
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      const db = createRoom(p, "correct horse battery staple", "My Room");
      db.prepare("INSERT INTO meta(key, value) VALUES ('probe', 'kept')").run();
      db.close();

      const reopened = openRoom(p, "correct horse battery staple");
      const name = reopened
        .prepare("SELECT value FROM meta WHERE key = 'name'")
        .get() as { value: string } | undefined;
      const probe = reopened
        .prepare("SELECT value FROM meta WHERE key = 'probe'")
        .get() as { value: string } | undefined;
      const format = reopened
        .prepare("SELECT value FROM meta WHERE key = 'format'")
        .get() as { value: string } | undefined;
      expect(name?.value).toBe("My Room");
      expect(probe?.value).toBe("kept");
      expect(format?.value).toBe("roomai");
      expect(reopened.pragma("user_version", { simple: true })).toBe(CURRENT_USER_VERSION);
      reopened.close();
    });
  });

  // Ported from schema.rs `room_reopens_after_create`: a room created then
  // reopened still decrypts, and a wrong password is rejected cleanly (not
  // silently, not a crash).
  it("room_reopens_after_create", () => {
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      {
        const db = createRoom(p, "correct horse", "My Room");
        db.prepare("INSERT INTO meta(key, value) VALUES ('probe', 'kept')").run();
        db.close();
      }
      const conn = openRoom(p, "correct horse");
      const name = conn.prepare("SELECT value FROM meta WHERE key = 'name'").get() as
        | { value: string }
        | undefined;
      const probe = conn
        .prepare("SELECT value FROM meta WHERE key = 'probe'")
        .get() as { value: string } | undefined;
      expect(name?.value).toBe("My Room");
      expect(probe?.value).toBe("kept");
      conn.close();

      expect(() => openRoom(p, "wrong password")).toThrow();
    });
  });

  it("wrong_password_on_your_own_created_room_fails_cleanly", () => {
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      const db = createRoom(p, "correct horse battery staple", "My Room");
      db.close();

      expect(() => openRoom(p, "definitely the wrong password")).toThrow("WRONG_PASSWORD");
    });
  });

  it("opens_a_real_rust_created_fixture_and_reads_its_meta_format", () => {
    expect(existsSync(FIXTURE_PLAIN)).toBe(true);
    const db = openRoom(FIXTURE_PLAIN, "correct horse battery staple");
    const format = db.prepare("SELECT value FROM meta WHERE key = 'format'").get() as
      | { value: string }
      | undefined;
    expect(format?.value).toBe("roomai");
    const uv = db.pragma("user_version", { simple: true });
    expect(uv).toBe(CURRENT_USER_VERSION);
    const memories = db.prepare("SELECT content FROM memories ORDER BY created_at").all() as {
      content: string;
    }[];
    expect(memories.length).toBe(2);
    expect(memories.some((m) => m.content.includes("שלום עולם"))).toBe(true);
    db.close();
  });

  // A second real Rust fixture, this one keyed with a single-quote-containing
  // password — proves the doubled-quote pragma escaping against a file this
  // module did not create itself (mirrors s1_spike.mjs check #3).
  it("opens_a_real_fixture_created_with_a_quote_containing_password", () => {
    expect(existsSync(FIXTURE_QUOTE_PASSWORD)).toBe(true);
    const db = openRoom(FIXTURE_QUOTE_PASSWORD, "it's a trap' -- ");
    const memories = db.prepare("SELECT content FROM memories").all() as { content: string }[];
    expect(memories.length).toBe(1);
    expect(memories[0]?.content).toContain("quote-containing password");
    db.close();
  });

  it("openRoomReadonly_opens_the_same_fixture_without_writing", () => {
    const db = openRoomReadonly(FIXTURE_PLAIN, "correct horse battery staple");
    const format = db.prepare("SELECT value FROM meta WHERE key = 'format'").get() as
      | { value: string }
      | undefined;
    expect(format?.value).toBe("roomai");
    expect(db.readonly).toBe(true);
    expect(() => db.exec("INSERT INTO memories(id, content) VALUES ('x','y')")).toThrow();
    db.close();
  });

  it("openRoomReadonly_rejects_a_wrong_password_too", () => {
    expect(() => openRoomReadonly(FIXTURE_PLAIN, "nope")).toThrow("WRONG_PASSWORD");
  });

  it("open_room_missing_file_says_File_not_found", () => {
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      expect(() => openRoom(p, "correct horse battery staple")).toThrow("File not found.");
      expect(() => openRoomReadonly(p, "correct horse battery staple")).toThrow(
        "File not found."
      );
    });
  });

  it("opening_a_non_roomai_sqlite_file_is_refused_when_the_row_says_so", () => {
    withFreshTmpDir(() => {
      // A room-shaped file whose meta.format is NOT 'roomai' — e.g. a room
      // that was rekeyed/renamed from some other tool, or corrupted meta.
      const p = tempRoomPath();
      const db = createRoom(p, "correct horse battery staple", "My Room");
      db.prepare("UPDATE meta SET value = 'not-a-room' WHERE key = 'format'").run();
      db.close();

      expect(() => openRoom(p, "correct horse battery staple")).toThrow(
        "This file is not an Arcelle project."
      );
      expect(() => openRoomReadonly(p, "correct horse battery staple")).toThrow(
        "This file is not an Arcelle project."
      );
    });
  });

  // Regression test: a valid SQLCipher database that isn't one of ours at
  // all has NO `meta` table whatsoever (not merely a wrong value in it).
  // Rust's `query_row` returns `Err` uniformly whether the table or the row
  // is missing, and the `match` collapses every `Err` to "This file is not
  // an Arcelle project." — a naive unguarded `SELECT ... FROM meta` in the
  // port throws a raw "no such table: meta" instead, leaking a driver
  // error where the room's own wording belongs.
  it("opening_a_valid_but_foreign_sqlcipher_file_with_no_meta_table_reads_as_not_our_project", () => {
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      const password = "correct horse battery staple";
      const db = new Database(p);
      applyKey(db, password);
      verifyKey(db);
      db.exec("CREATE TABLE some_other_table (id INTEGER PRIMARY KEY);");
      db.close();

      expect(() => openRoom(p, password)).toThrow("This file is not an Arcelle project.");
      expect(() => openRoomReadonly(p, password)).toThrow(
        "This file is not an Arcelle project."
      );
    });
  });
});

describe("password length rule (MIN_ROOM_PASSWORD_CHARS)", () => {
  it("a_password_shorter_than_8_chars_is_rejected_with_the_right_message", () => {
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      expect(() => createRoom(p, "1234567", "Short")).toThrow(
        "A room password needs at least 8 characters."
      );
      expect(existsSync(p)).toBe(false);
    });
  });

  // Ported from schema.rs `a_room_password_must_clear_the_length_rule`.
  it("a_room_password_must_clear_the_length_rule", () => {
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      expect(() => createRoom(p, "1234567", "Short")).toThrow(/8 characters/);
      expect(existsSync(p)).toBe(false);

      // Exactly eight characters is enough.
      const db = createRoom(p, "12345678", "Exactly eight");
      db.close();
    });
  });
});

describe("creating a room at an already-occupied path", () => {
  it("fails_with_the_right_message_and_does_not_clobber_the_existing_file", () => {
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      writeFileSync(p, "not a room, do not touch me");
      const before = readFileSync(p);

      expect(() => createRoom(p, "correct horse battery staple", "My Room")).toThrow(
        "A file already exists at this location."
      );

      const after = readFileSync(p);
      expect(after.equals(before)).toBe(true);
    });
  });
});

describe("create_room_file cleanup on failure", () => {
  // Ported from schema.rs `a_failed_creation_leaves_no_file_blocking_the_retry`:
  // SQLite creates the file the moment it is opened, before anything that
  // could fail has run. A failed init must not leave that file behind, or
  // the obvious retry (same name) hits "A file already exists" forever.
  it("a_failed_creation_leaves_no_file_blocking_the_retry", () => {
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      expect(() =>
        createRoomFile(p, () => {
          throw new Error("the disk went away");
        })
      ).toThrow("the disk went away");
      expect(existsSync(p)).toBe(false);
      expect(existsSync(`${p}-wal`)).toBe(false);
      expect(existsSync(`${p}-shm`)).toBe(false);
    });
  });

  // A REAL failure (not an injected one) reaching createRoomFile's `init`
  // after the file already exists on disk: an embedded NUL passes the
  // length check (`.chars().count()` / `[...password].length` both count it
  // as one character) but truncates the PRAGMA text mid-statement once it
  // reaches SQLite, so `applyKey` throws for real.
  it("a_real_driver_failure_after_the_file_exists_is_also_cleaned_up", () => {
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      const password = "abcdefg\0";
      expect([...password].length).toBe(MIN_ROOM_PASSWORD_CHARS);

      expect(() => createRoom(p, password, "x")).toThrow();

      expect(existsSync(p)).toBe(false);
      expect(existsSync(`${p}-wal`)).toBe(false);
      expect(existsSync(`${p}-shm`)).toBe(false);
    });
  });
});

describe("classifyFirstRead (wrong-password classification)", () => {
  // Ported from schema.rs `only_an_undecryptable_file_reads_as_a_wrong_password`.
  // rusqlite's SqliteFailure(NotADatabase) becomes better-sqlite3's
  // SqliteError with code SQLITE_NOTADB; every other code names itself.
  it("only_an_undecryptable_file_reads_as_a_wrong_password", () => {
    const notADb = Object.assign(new Error("file is not a database"), {
      code: "SQLITE_NOTADB",
    });
    expect(classifyFirstRead(notADb).message).toBe("WRONG_PASSWORD");

    const ioErr = Object.assign(new Error("disk I/O error"), {
      code: "SQLITE_IOERR",
    });
    const msg = classifyFirstRead(ioErr).message;
    expect(msg).not.toContain("WRONG_PASSWORD");
    expect(msg).toContain("could not be read");
  });

  it("an_unclassifiable_error_with_no_code_also_reads_as_wrong_password", () => {
    // Mirrors Rust's `None` arm (an error that isn't even a SqliteFailure) —
    // the common case, and the one that must stay WRONG_PASSWORD rather than
    // surfacing an internal error shape to the user.
    expect(classifyFirstRead(new Error("something odd")).message).toBe("WRONG_PASSWORD");
  });
});

describe("applyKey / verifyKey", () => {
  it("applyKey_plus_verifyKey_open_a_real_fixture_directly", () => {
    const db = new Database(FIXTURE_PLAIN, { readonly: true });
    applyKey(db, "correct horse battery staple");
    verifyKey(db); // must not throw
    const format = db.prepare("SELECT value FROM meta WHERE key = 'format'").get() as
      | { value: string }
      | undefined;
    expect(format?.value).toBe("roomai");
    db.close();
  });

  it("verifyKey_throws_WRONG_PASSWORD_when_applyKey_used_the_wrong_password", () => {
    const db = new Database(FIXTURE_PLAIN, { readonly: true });
    applyKey(db, "not the right password");
    expect(() => verifyKey(db)).toThrow("WRONG_PASSWORD");
    db.close();
  });

  it("a_quote_containing_password_round_trips_via_doubled_quotes", () => {
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      const password = "it's a trap' -- ";
      const db = createRoom(p, password, "Quotes");
      db.close();

      const reopened = openRoom(p, password);
      reopened.close();

      expect(() => openRoom(p, "it is NOT a trap")).toThrow("WRONG_PASSWORD");
    });
  });
});

describe("openRoomReadonly (schema.rs a_read_only_open_verifies_without_writing)", () => {
  // Ported from schema.rs `a_read_only_open_verifies_without_writing`, minus
  // the `migrate(&conn).is_err()` assertion: `migrate` lives in `./migrate.ts`
  // and is not wired into this module yet (see the doc comment in open.ts).
  it("a_read_only_open_verifies_without_writing", () => {
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      createRoom(p, "correct horse battery", "Check").close();

      const conn = openRoomReadonly(p, "correct horse battery");
      // It really is the room…
      const name = conn.prepare("SELECT value FROM meta WHERE key = 'name'").get() as
        | { value: string }
        | undefined;
      expect(name?.value).toBe("Check");
      // …and nothing can write through this handle.
      expect(() => conn.exec("CREATE TABLE scribble(x)")).toThrow();
      conn.close();

      // A wrong password is still a wrong password, and a non-room is still
      // not a room — the check must not become laxer for being read-only.
      expect(() => openRoomReadonly(p, "wrong password here")).toThrow();
    });
  });
});

describe("schema completeness (create_room runs SCHEMA only, never migrate)", () => {
  // Guards the exact regression schema.rs documents on `web_searches`: that
  // table lived only in `migrate` for a while, so a brand-new room (which
  // runs SCHEMA and never migrate) had no table at all — every attempt to
  // remember a search failed silently until the room was closed and reopened.
  it("a_brand_new_room_already_has_every_table_schema_mints", () => {
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      const db = createRoom(p, "correct horse battery staple", "Fresh");
      for (const table of [
        "meta",
        "folders",
        "files",
        "chunks",
        "trashed_chunks",
        "chunks_fts",
        "chats",
        "messages",
        "memories",
        "web_pages",
        "web_images",
        "web_searches",
        "settings",
        "privacy_entities",
        "privacy_scans",
        "file_versions",
        "staged_artifacts",
        "recordings",
        "podcasts",
        "rec_chunks",
        "jobs",
        "job_artifacts",
        "workflows",
        "workflow_runs",
        "schedules",
        "skills",
        "skill_resources",
        "browse_journal",
        "voice_ids",
        "voice_rejects",
        "story_cast",
        "story_lists",
        "story_shots",
      ]) {
        const row = db
          .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
          .get(table);
        expect(row, `missing table ${table}`).toBeDefined();
      }
      db.close();
    });
  });
});
