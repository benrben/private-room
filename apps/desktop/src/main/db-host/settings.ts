/**
 * The `settings` key/value table — app-level preferences, as distinct from
 * `meta` (room identity/format, stamped by the app; see `meta.ts`). Ported
 * from `src-tauri/src/db/settings.rs` (17 lines,
 * `get_setting`/`set_setting`).
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { executeOne, queryOpt } from "./util.js";

/**
 * Read one value from the `settings` table, or `null` if the key is not set.
 *
 * DEVIATION: Rust's `get_setting` returns a bare `Option<String>` built with
 * `query_row(...).ok()`, which collapses EVERY failure to `None` — a missing
 * row and a missing table read the same. It has no error channel to do
 * anything else with. This has one, so a genuinely broken query throws rather
 * than being reported as "not set": an unset key is an answer, an unreadable
 * `settings` table is not.
 */
export function getSetting(db: Database.Database, key: string): string | null {
  return queryOpt(db, "SELECT value FROM settings WHERE key = ?", [key], (r) => r[0] as string);
}

/** UPSERT one value into the `settings` table — a second call on the same key
 * replaces the value in place rather than erroring on the UNIQUE conflict or
 * duplicating the row. */
export function setSetting(db: Database.Database, key: string, value: string): void {
  executeOne(
    db,
    `INSERT INTO settings(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}
