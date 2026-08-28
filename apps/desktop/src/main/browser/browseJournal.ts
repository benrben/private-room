/**
 * The browser journal's READ / SCOPE / CLEAR half — everything in
 * `src-tauri/src/db/browse.rs` except `insert_browse_journal`, which
 * `journal.ts` already carries as part of the browser-core batch.
 *
 * Colocated with `journal.ts` rather than filed under `db-host/`, for the same
 * reason that file gives: this is the DB layer directly behind the browser's
 * own audit trail, not a general room table.
 *
 * `browseClearScope`'s counts fold in the web cache's own ({@link
 * countWebCache}) — the Clear button says "Erase this record" and then also
 * empties the cache behind it, so what it PROMISES and what it COUNTS have to
 * name the same tables.
 *
 * The bound on the table itself lives with the INSERT, in `journal.ts`
 * (`JOURNAL_CAP`), exactly as Rust puts it inside `insert_browse_journal`: one
 * cheap `DELETE` per append rather than a sweep nobody schedules. This half
 * only ever reads, scopes and clears.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import type { BrowseClearScope, BrowseJournalRow } from "../../shared/apiTypes.js";
import { queryOne, queryRows } from "../db-host/util.js";
import { countWebCache } from "../db-host/webCache.js";

/**
 * Newest first, capped. The Journal view pages through this; the model never
 * reads it (it is the user's record OF the model).
 *
 * The limit is clamped to `[1, 2000]` exactly as Rust's `limit.clamp(1, 2000)`
 * does — and TRUNCATED first, because a caller that hands this a fractional
 * number would otherwise reach `better-sqlite3` with a non-integer bind, which
 * it refuses outright rather than rounding.
 */
export function listBrowseJournal(db: Database.Database, limit: number): BrowseJournalRow[] {
  const clamped = Math.min(2000, Math.max(1, Math.trunc(limit)));
  return queryRows(
    db,
    `SELECT id, created_at, session, kind, url, detail FROM browse_journal
     ORDER BY id DESC LIMIT ?`,
    [clamped],
    (r) => ({
      id: r[0] as number,
      at: r[1] as string,
      session: r[2] as string,
      kind: r[3] as string,
      url: r[4] as string,
      detail: r[5] as string,
    }),
  );
}

/**
 * Everything a Clear would take with it, counted before it happens.
 *
 * The Clear button says "Erase this record" and then also empties the web
 * cache behind it — the search terms, the full text of the result pages, the
 * thumbnails. That is the right thing to delete (see `clearWebCache`) and the
 * wrong thing to keep quiet about, so the counts are askable.
 */
export function browseClearScope(db: Database.Database): BrowseClearScope {
  const web = countWebCache(db);
  return {
    journal: queryOne(db, "SELECT COUNT(*) FROM browse_journal", [], (r) => r[0] as number),
    searches: web.searches,
    pages: web.pages,
    images: web.images,
  };
}

/**
 * Wipe the record. Offered in the Journal view because a user who browsed
 * something they would rather not keep must be able to remove it from their
 * own room — the audit trail is for them, not over them.
 */
export function clearBrowseJournal(db: Database.Database): void {
  db.prepare("DELETE FROM browse_journal").run();
}
