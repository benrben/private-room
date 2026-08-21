/**
 * Password verification and re-keying — ported from
 * `src-tauri/src/db/versions.rs` lines 155-185 (`verify_password`, `rekey`,
 * `rekey_copy`).
 *
 * `verifyPassword` and `rekeyCopy` each open a FRESH, THROWAWAY connection to
 * `path` — never the app's live one. That is the whole point of the two
 * functions existing separately from `rekey`: a "confirm your current
 * password" dialog (change-password) or a "key the freshly duplicated copy"
 * step (duplicate-room / restore-a-checkpoint) must not be able to act on an
 * already-open room. If either of them took the live `Database` handle
 * instead, a walk-up attacker at an unlocked machine could re-key (or probe
 * the password of) a room that is currently open in the app through what
 * looks like a harmless confirmation prompt. `rekey` is the one function
 * here that DOES operate on an open connection — by design, it is only ever
 * called on a connection the caller already owns and is deliberately
 * re-keying, never on a path string that could resolve to the live room.
 *
 * Every throwaway connection is closed before the function returns OR
 * throws, mirroring rusqlite's `Connection` `Drop` (which closes the SQLite
 * handle when the Rust value goes out of scope, on every exit path,
 * including the early return of `?`). JS has no destructors, so this is a
 * manual try/finally here — the same shape `open.ts` already uses for its
 * own throwaway/failed connections.
 *
 * A PRAGMA has no parameter binding, so `newPassword` is inlined into the
 * `rekey` pragma text with every single quote doubled — the same escaping
 * `applyKey` (`open.ts`) uses for the `key` pragma, and the same escaping
 * rusqlite's own `pragma_update(None, "rekey", new_password)` performs
 * internally in the Rust source.
 */

import Database from "better-sqlite3-multiple-ciphers";
import { applyKey, verifyKey } from "./open.js";

/**
 * Verify `password` against the room at `path` on a fresh, throwaway
 * connection — used by change-password's "is this your current password?"
 * check and to prove a freshly duplicated copy's key.
 *
 * Throws "The current password is not correct." if the password does not
 * decrypt the file. Always closes the throwaway connection, whether the
 * password was right or wrong.
 */
export function verifyPassword(path: string, password: string): void {
  const db = new Database(path);
  try {
    applyKey(db, password);
    try {
      verifyKey(db);
    } catch {
      throw new Error("The current password is not correct.");
    }
  } finally {
    try {
      db.close();
    } catch {
      // already closed / nothing to do
    }
  }
}

/**
 * Change the encryption key of an ALREADY-OPEN connection (SQLCipher rekey).
 *
 * `db` must be a connection the caller already owns and intends to re-key —
 * never open a connection just to hand it to this function, or the
 * walk-up-attacker safety property `verifyPassword`/`rekeyCopy` exist for is
 * lost. A PRAGMA has no parameter binding, so `newPassword` is inlined with
 * every single quote doubled, exactly like `applyKey`'s `key` pragma.
 */
export function rekey(db: Database.Database, newPassword: string): void {
  const escaped = newPassword.replace(/'/g, "''");
  db.pragma(`rekey='${escaped}'`);
}

/**
 * Open a room COPY with its current key on a fresh, throwaway connection,
 * then re-key that same connection to `newPassword` — duplicate-with-new-
 * password, and re-keying a checkpoint/backup during a room-wide password
 * change.
 *
 * Throws "Could not open the copied room to set its password." if
 * `currentPassword` does not decrypt `path`. Always closes the throwaway
 * connection, whether the rekey succeeded, the password was wrong, or the
 * rekey pragma itself failed.
 */
export function rekeyCopy(
  path: string,
  currentPassword: string,
  newPassword: string
): void {
  const db = new Database(path);
  try {
    applyKey(db, currentPassword);
    try {
      verifyKey(db);
    } catch {
      throw new Error("Could not open the copied room to set its password.");
    }
    rekey(db, newPassword);
  } finally {
    try {
      db.close();
    } catch {
      // already closed / nothing to do
    }
  }
}
