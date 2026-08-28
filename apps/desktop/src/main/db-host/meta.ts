/**
 * The `meta` key/value table — format/format_version/name plus anything else
 * COMMANDS stamps on later (e.g. the embedding model/dim after a backfill).
 * Ported from `src-tauri/src/db/meta.rs` (~20 lines, `get_meta`/`set_meta`).
 */

import Database from "better-sqlite3-multiple-ciphers";

/**
 * Read one value from the `meta` table, or `null` if the key is not set —
 * mirrors Rust's `query_row(...).ok()`, which collapses "no such row" (and
 * any other query failure) to `None`.
 */
export function getMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/**
 * A2: UPSERT one value into the `meta` table — `get_meta` above already
 * existed with the exact A2 signature, so only `set_meta` was new on the
 * Rust side. A second call on the same key replaces the value in place
 * rather than erroring on the UNIQUE conflict or duplicating the row.
 */
export function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}
