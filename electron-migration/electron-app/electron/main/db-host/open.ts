/**
 * Room lifecycle: create, open, and open-readonly — ported from
 * `src-tauri/src/db/schema.rs` (`apply_key`, `verify_key`, `classify_first_read`,
 * `create_room`, `create_room_file`, `open_room`, `open_room_readonly`).
 *
 * The on-disk format is SQLCipher 4, but this binding
 * (`better-sqlite3-multiple-ciphers`, which links SQLite3MultipleCiphers
 * rather than rusqlite's bundled SQLCipher) needs a DIFFERENT pragma sequence
 * to land on the exact same bytes: `cipher='sqlcipher'` and `legacy=4` before
 * the key, with no parameter binding available on a PRAGMA (the key is
 * inlined with single quotes doubled, same as the Rust side does for
 * `rekey`/`verify_password`). This sequence is proven against real
 * Rust-created `.roomai` fixtures by
 * `electron-migration/spikes/s1-db-compat/s1_spike.mjs` — see that file for
 * why the order matters and for the fixture provenance
 * (`gen_fixture_room.rs`, not a hand-rolled approximation).
 *
 * `migrate()` (schema.rs:711+) is ported separately, in `./migrate.ts`
 * (`migrate(db): void`). The real Rust `open_room` always calls `migrate`
 * before returning; `openRoom` here deliberately does NOT wire it in yet —
 * this module and `migrate.ts` were ported independently, and gluing them
 * together (plus proving that combination against real fixtures) is a
 * follow-up integration step once both halves are settled on their own.
 * A caller of this module's `openRoom` today gets a room that decrypts and
 * has been proven to be an Arcelle project, but has NOT been brought up to
 * the current schema.
 */

import Database from "better-sqlite3-multiple-ciphers";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The room DDL, copied character-for-character out of the `r#"..."#` literal
 * in `schema.rs` (`SCHEMA` constant) — see that file for table-by-table
 * rationale. Read lazily (not at import time) so tests can construct rooms
 * without the file needing to exist relative to some other cwd. Shared with
 * `migrate.ts`, which is why the filename is exactly `schema.sql`. */
function schemaSql(): string {
  return readFileSync(path.join(here, "schema.sql"), "utf8");
}

/**
 * Room-file password policy, enforced at the seam that actually encrypts one.
 *
 * The 8-character rule was written into the new-room FORM and into
 * `change_password`/`duplicate_room`, but never here — so the one place that
 * creates and keys a room accepted a single character, and any new caller (a
 * script, a future command, an agent tool) would have inherited that.
 */
export const MIN_ROOM_PASSWORD_CHARS = 8;

/**
 * The schema revision a room created TODAY is already at, so `migrate` runs
 * none of its one-time repairs against it.
 *
 * A new room used to be stamped 0, which is what a room written years ago
 * looks like: the very next unlock ran every repair, and repair #1 nulls
 * every embedding in the room. Raise this in lockstep with the last
 * `if user_version < N` block in `migrate`.
 */
export const CURRENT_USER_VERSION = 3;

/**
 * Key a connection AND pin the on-disk cipher parameters (A1).
 *
 * Must run before the first real read (`verifyKey`), which is what every
 * caller does next. A PRAGMA has no parameter binding, so the password is
 * inlined with every `'` doubled — mirrored exactly from the spike rather
 * than trusting some other escaping scheme to agree with it.
 */
export function applyKey(db: Database.Database, password: string): void {
  db.pragma("cipher='sqlcipher'");
  db.pragma("legacy=4");
  const escaped = password.replace(/'/g, "''");
  db.pragma(`key='${escaped}'`);
}

/**
 * Why the first read after keying failed.
 *
 * It used to be "WRONG_PASSWORD", unconditionally — so a truncated file, a
 * failing disk, a room on a network volume that dropped, or a file another
 * process holds locked all told the user their password was wrong. They
 * retype it forever while the real fix is somewhere else entirely.
 *
 * A wrong SQLCipher key decrypts the header into noise, which SQLite rejects
 * as `SQLITE_NOTADB` — that (and an unclassifiable error, which stays the
 * common case) is the only thing allowed to say "wrong password". Every
 * other SQLite code names itself instead. Only the CODE travels: an error
 * string can carry the file's path, and a file name is room content.
 *
 * Exported (beyond the Rust function's private visibility) so the test file
 * can port `only_an_undecryptable_file_reads_as_a_wrong_password` directly,
 * the same way Rust's own `mod tests` calls the private `classify_first_read`
 * with synthetic `rusqlite::Error` values it constructs by hand.
 */
export function classifyFirstRead(err: unknown): Error {
  const code =
    err && typeof err === "object" && "code" in err
      ? (err as { code?: unknown }).code
      : undefined;
  if (code === undefined || code === "SQLITE_NOTADB") {
    return new Error("WRONG_PASSWORD");
  }
  return new Error(
    `This room file could not be read (${String(code)}) — the password may be fine. ` +
      "Check that the file is on a connected drive, not open in another copy of " +
      "Arcelle, and not damaged."
  );
}

/**
 * Verify the key actually decrypts the file. With SQLCipher, a wrong key
 * surfaces as "file is not a database" on the first real read.
 */
export function verifyKey(db: Database.Database): void {
  try {
    db.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch (err) {
    throw classifyFirstRead(err);
  }
}

/**
 * Read `meta.format`, or `undefined` if that fails for ANY reason — no such
 * table (a SQLCipher file that isn't one of ours at all), no such row, a
 * corrupt page, whatever.
 *
 * Mirrors the Rust `open_room`/`open_room_readonly` match: `Ok(f) if f ==
 * "roomai"` is the only accepting arm, and EVERY other outcome — including
 * `Err(_)` from the query itself — falls through to the same "This file is
 * not an Arcelle project." `query_row` in rusqlite returns `Err` uniformly
 * whether the table is missing or the row is missing, so this must too: a
 * naive `db.prepare(...).get()` with no try/catch throws a raw
 * "no such table: meta" out of `better-sqlite3` the moment the file has no
 * `meta` table at all (any foreign SQLCipher database), which would leak an
 * internal SQLite error message instead of the room's own "not an Arcelle
 * project" wording.
 */
function readMetaFormat(db: Database.Database): string | undefined {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'format'").get() as
      | { value: string }
      | undefined;
    return row?.value;
  } catch {
    return undefined;
  }
}

/**
 * Open a NEW room file and hand it to `init`; if `init` fails, take the
 * half-written file away again.
 *
 * SQLite creates the file the moment it is opened, before any of the keying
 * or schema work can fail. Whatever went wrong then left a 0-byte (or partly
 * keyed) file sitting at the chosen path, and the retry — with the same
 * name, which is what anyone does next — hit "A file already exists at this
 * location." for good, with nothing in the app able to remove it.
 *
 * Exported (beyond the module's contract) so the test file can port
 * `a_failed_creation_leaves_no_file_blocking_the_retry` directly, the same
 * way the Rust test exercises `create_room_file` rather than only its
 * `create_room` caller.
 */
export function createRoomFile(
  filePath: string,
  init: (db: Database.Database) => void
): Database.Database {
  const db = new Database(filePath);
  try {
    init(db);
    return db;
  } catch (err) {
    // Close the handle first: an open connection can leave -wal/-shm
    // siblings that would outlive the file we are about to remove.
    try {
      db.close();
    } catch {
      // already closed / nothing to do
    }
    for (const p of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
      try {
        unlinkSync(p);
      } catch {
        // matches Rust's `let _ = std::fs::remove_file(..)` — best effort
      }
    }
    throw err;
  }
}

export function createRoom(
  filePath: string,
  password: string,
  name: string
): Database.Database {
  if (existsSync(filePath)) {
    throw new Error("A file already exists at this location.");
  }
  // Rust's `password.chars().count()` counts Unicode SCALAR VALUES, which is
  // what spreading a JS string does too (unlike `.length`, which counts
  // UTF-16 code units and would over-count astral characters as 2).
  if ([...password].length < MIN_ROOM_PASSWORD_CHARS) {
    throw new Error(
      `A room password needs at least ${MIN_ROOM_PASSWORD_CHARS} characters.`
    );
  }
  return createRoomFile(filePath, (db) => {
    // A1: `applyKey` also pins the SQLCipher-4 parameter set, so a room
    // stays portable across builds/platforms.
    applyKey(db, password);
    verifyKey(db);
    db.pragma("foreign_keys = ON");
    db.exec(schemaSql());
    // This room is BORN current — see `CURRENT_USER_VERSION`.
    db.pragma(`user_version = ${CURRENT_USER_VERSION}`);
    db.prepare(
      "INSERT INTO meta(key, value) VALUES ('format','roomai'), ('format_version','1'), ('name', ?)"
    ).run(name);
  });
}

export function openRoom(filePath: string, password: string): Database.Database {
  if (!existsSync(filePath)) {
    throw new Error("File not found.");
  }
  const db = new Database(filePath);
  try {
    // A1: `applyKey` pins the SQLCipher-4 parameter set too, so this room
    // decrypts regardless of the linked SQLCipher's own defaults.
    applyKey(db, password);
    verifyKey(db);
    db.pragma("foreign_keys = ON");
    // Sanity check that this is one of our project files.
    if (readMetaFormat(db) !== "roomai") {
      throw new Error("This file is not an Arcelle project.");
    }
    // migrate() lives in ./migrate.ts and is wired in by a later integration
    // step — see the module doc comment above.
    return db;
  } catch (err) {
    try {
      db.close();
    } catch {
      // already closed / nothing to do
    }
    throw err;
  }
}

/**
 * Open a room WITHOUT changing it — decrypt, prove the key, confirm the file
 * really is one of ours, and stop there.
 *
 * `openRoom` always runs `migrate`, which creates tables and at least one
 * write. That is right for the app and wrong for a check: `roomai verify` /
 * `roomai info` promise to read, and on a copy sitting on a read-only volume
 * or a backup they failed with a database error instead of a verdict — and on
 * a room that had not been opened since the last schema change, "verifying"
 * it quietly rebuilt its search index.
 *
 * SQLite is asked for a read-only handle as well, so the promise is enforced
 * by the engine rather than by this function remembering not to write.
 */
export function openRoomReadonly(
  filePath: string,
  password: string
): Database.Database {
  if (!existsSync(filePath)) {
    throw new Error("File not found.");
  }
  const db = new Database(filePath, { readonly: true });
  try {
    applyKey(db, password);
    verifyKey(db);
    if (readMetaFormat(db) !== "roomai") {
      throw new Error("This file is not an Arcelle project.");
    }
    return db;
  } catch (err) {
    try {
      db.close();
    } catch {
      // already closed / nothing to do
    }
    throw err;
  }
}
