// BROWSE-1: the agent's journal.
//
// Port of the "Journal" section of src-tauri/src/browser.rs (`journal`,
// `now_iso`) plus the insert half of `db::insert_browse_journal`, against the
// `browse_journal` table already carried in electron/main/db-host/schema.sql.
//
// INVARIANT #2 OF THE MODULE THIS PORTS: the web leaves no trace; the AGENT's
// conduct leaves a complete one, inside the encrypted room. The room DB is the
// ONLY copy — a parallel in-memory ring buffer used to live here and was
// carefully trimmed, but nothing ever read it and it was not emptied on room
// close, so the last 500 lines of browsing outlived the locked room in memory.
//
// A closed room is not an error: the browser can be open on the start screen
// with nothing to write to, which is why `db` is nullable and a DB-less entry
// is still emitted rather than silently dropped.

import type Database from "better-sqlite3-multiple-ciphers";
import type { BrowseJournalRow } from "../../shared/apiTypes.js";
import { nowIso } from "./tabs.js";

/**
 * How many journal lines a room keeps.
 *
 * The trail has no bound of its own: one row per page opened, read, clicked,
 * blocked or downloaded, kept forever, with only the Clear button ever
 * shrinking it. The Journal view reads the newest few hundred, so anything past
 * this is storage nobody will look at — trimmed on write so the cost is one
 * cheap `DELETE` per append rather than a sweep nobody schedules.
 */
export const JOURNAL_CAP = 5_000;

/** Insert one journal row and read it back with its real DB-assigned id — the
 *  shape `BrowseJournalRow` promises the renderer over the `browser-journal`
 *  event and the `browser_journal` query alike. */
export function insertBrowseJournal(
  db: Database.Database,
  session: string,
  kind: string,
  url: string,
  detail: string,
): BrowseJournalRow {
  const info = db
    .prepare(`INSERT INTO browse_journal (kind, url, detail, session) VALUES (?, ?, ?, ?)`)
    .run(kind, url, detail, session);
  const row = db
    .prepare(
      `SELECT id, kind, url, detail, session, created_at AS at FROM browse_journal WHERE id = ?`,
    )
    .get(info.lastInsertRowid) as BrowseJournalRow;
  // `id` is AUTOINCREMENT, so it only ever climbs: everything at or below
  // (newest − cap) is older than the cap's worth of lines we keep. Ignored on
  // failure exactly as Rust ignores it — a trim that will not run must not cost
  // the caller the line it just wrote.
  try {
    db.prepare(
      `DELETE FROM browse_journal
       WHERE id <= (SELECT MAX(id) FROM browse_journal) - ?`,
    ).run(JOURNAL_CAP);
  } catch {
    // best-effort — see above
  }
  return row;
}

/** Where a journal entry is written to and announced. This module knows nothing
 *  about IPC or window wiring. */
export interface JournalSink {
  db: Database.Database | null;
  emit(row: BrowseJournalRow): void;
}

/**
 * Record one agent action. Best-effort against the DB (a write failure is
 * swallowed, matching Rust's `let _ = crate::db::insert_browse_journal(...)`) —
 * the emitted row still carries an honest shape so the live journal view is
 * never silently starved of a line.
 */
export function journal(
  sink: JournalSink,
  session: string,
  kind: string,
  url: string,
  detail: string,
): void {
  let row: BrowseJournalRow | null = null;
  if (sink.db) {
    try {
      row = insertBrowseJournal(sink.db, session, kind, url, detail);
    } catch {
      row = null;
    }
  }
  sink.emit(row ?? { id: -1, at: nowIso(), session, kind, url, detail });
}

export { nowIso };
