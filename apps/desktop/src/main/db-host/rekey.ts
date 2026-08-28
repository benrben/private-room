/**
 * Password verification and re-keying — ported from
 * `src-tauri/src/db/versions.rs` lines 155-185 (`verify_password`, `rekey`,
 * `rekey_copy`), PLUS (as of the `commands/safety.rs` batch) that same file's
 * neighbouring "password / maintenance" trio lines 399-433: `reclaimable_bytes`,
 * `vacuum`, `vacuum_into` — SEC-7 compaction and ADD-4 room duplication. Added
 * here rather than a new file: `versions.ts`'s own module doc already claimed
 * these three were "ALREADY PORTED as `rekey.ts`" (they were not — that line
 * was written ahead of the port actually landing), so this fulfills that
 * claim rather than leaving it stale, and keeps every "password / maintenance"
 * function named in that doc in the one file it points at.
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

/**
 * Bytes sitting in the database's free pages — space a VACUUM would reclaim.
 * Ported verbatim from `db::reclaimable_bytes` (`freelist_count * page_size`).
 * SEC-7's "Compact room" reads this to decide whether a VACUUM is even worth
 * running (see `compactRoomCore` in `safetyTools.ts`).
 */
export function reclaimableBytes(db: Database.Database): number {
  const freelist = db.pragma("freelist_count", { simple: true }) as number;
  const pageSize = db.pragma("page_size", { simple: true }) as number;
  return freelist * pageSize;
}

/** Compact the database in place (SEC-7). Ported verbatim from `db::vacuum`. */
export function vacuum(db: Database.Database): void {
  db.exec("VACUUM");
}

/**
 * A consistent copy of the live, encrypted database at `dest` — keeps the
 * current key (ADD-4). `dest` is single-quote-escaped into the statement
 * since `VACUUM INTO` does not accept bound parameters — the same escaping
 * `rekey`'s own PRAGMA text uses. Ported verbatim from `db::vacuum_into`.
 *
 * NOT the same helper `checkpoints.ts`'s `writeCheckpoint` uses internally:
 * that one stages into a `.tmp` path and renames over it (crash safety for an
 * unattended auto-checkpoint). `duplicateRoomCore` writes directly to a
 * caller-chosen destination the user picked and confirmed doesn't exist yet
 * (see its own guard), matching the Rust command's own one-shot `VACUUM INTO`
 * with no rename dance.
 */
export function vacuumInto(db: Database.Database, dest: string): void {
  const escaped = dest.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
}
