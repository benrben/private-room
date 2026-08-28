/**
 * Query/execute plumbing shared by every table module in this directory.
 * Ported from `src-tauri/src/db/util.rs` (`query_rows`, `query_one`,
 * `query_opt`, `execute_one`, `execute_existing`, `execute_unique`).
 *
 * Rust needs these because rusqlite's `prepare` → `query_map` → `collect` is
 * three separately-fallible steps that got hand-written, each with its own
 * `.map_err(to_string)`, in every table module. `better-sqlite3` is already a
 * single synchronous call that throws, so there is far less boilerplate to
 * absorb — but the SEMANTIC distinctions the Rust helpers encode are exactly
 * what a bare `db.prepare(sql).get()` call site gets wrong, one at a time:
 *
 *   - a missing row is an ERROR ({@link queryOne}) vs. legitimately absent
 *     ({@link queryOpt});
 *   - zero rows changed is a FAILURE ({@link executeExisting}) vs. fine
 *     ({@link executeOne});
 *   - a UNIQUE clash is reported in the CALLER's words ({@link executeUnique}),
 *     never SQLite's.
 *
 * So every module in this port routes through these rather than reaching for
 * `db.prepare` itself.
 *
 * DEVIATION — errors, not `Result`: the Rust source returns
 * `Result<T, String>`. Every file already ported into this directory
 * (`open.ts`, `meta.ts`, `checkpoints.ts`) throws a plain `Error` instead, so
 * these do too. A `Result` wrapper here would be the only one in the
 * directory, and every caller would unwrap it straight back into a throw to
 * match its neighbours.
 *
 * DEVIATION — placeholders: the Rust source binds with SQLite's NUMBERED
 * placeholders (`?1`, `?2`, …) and sometimes reuses one number twice in a
 * statement so a value is bound once and matched in two places (see
 * `messages.ts`'s `recentMessages`). `better-sqlite3` will not take a plain
 * array of values against `?N`-style placeholders — verified against
 * better-sqlite3-multiple-ciphers 12.x: `stmt.all("a")` on `WHERE id=?1 OR
 * id=?1` throws "Too many parameter values were provided"; it wants an object
 * keyed by number. Every port in this directory already uses anonymous `?`
 * with positional binding, so these helpers and all their callers do the
 * same: a reused Rust `?1` becomes two `?`s with the same value repeated in
 * the params array. The helpers themselves are placeholder-agnostic (they
 * just spread `params`), so this is a call-site convention, not plumbing.
 *
 * ROW SHAPE — positional, via `.raw()`: rusqlite's row mappers read columns
 * by POSITION (`r.get(0)`, `r.get(1)`, …), and `better-sqlite3`'s `.raw()`
 * statement mode hands each row back as a plain array in SELECT-list order,
 * which is the direct equivalent. Every mapper in this port therefore indexes
 * `row[i]` exactly where the Rust source reads `r.get(i)`, and — the reason
 * this matters beyond taste — the SQL stays a character-for-character copy of
 * the Rust SQL. `better-sqlite3`'s default object-per-row mode keys rows by
 * column NAME, which would force an alias onto every computed column: verified
 * that `SELECT (SELECT count(*) …)` comes back keyed by the whole subquery
 * TEXT, so `skills.ts`'s `SUMMARY_COLS` (lifted verbatim from Rust, count
 * subquery and all) would have to be edited to be readable at all.
 */

import type Database from "better-sqlite3-multiple-ciphers";

/** One row as `better-sqlite3`'s `.raw()` mode hands it back: a plain array,
 * one element per SELECT-list column, in that exact order — the stand-in for
 * rusqlite's positional `Row`. */
export type Row = readonly unknown[];

/** A row → the caller's value. rusqlite's `FnMut`/`FnOnce` distinction
 * collapses to one function type here; JS has no borrow checker forcing it. */
export type RowMapper<T> = (row: Row) => T;

/** Run a query and map every row. */
export function queryRows<T>(
  db: Database.Database,
  sql: string,
  params: readonly unknown[],
  map: RowMapper<T>
): T[] {
  const rows = db.prepare(sql).raw().all(...params) as unknown[][];
  return rows.map(map);
}

/**
 * Run a query for a single row. A missing row THROWS — exactly as rusqlite's
 * `conn.query_row` reports `QueryReturnedNoRows` — because this helper
 * PROMISES the caller a row exists. A caller that is genuinely asking an
 * either/or question uses {@link queryOpt} instead.
 */
export function queryOne<T>(
  db: Database.Database,
  sql: string,
  params: readonly unknown[],
  map: RowMapper<T>
): T {
  const row = db.prepare(sql).raw().get(...params) as unknown[] | undefined;
  if (row === undefined) {
    throw new Error("Query returned no rows");
  }
  return map(row);
}

/**
 * Run a query for a row that may legitimately not exist. `null` (not
 * `undefined`) for "no row", matching every other `Option<T>` this port has
 * already settled on — `getMeta` in `meta.ts`, `readMetaFormat` in `open.ts`.
 */
export function queryOpt<T>(
  db: Database.Database,
  sql: string,
  params: readonly unknown[],
  map: RowMapper<T>
): T | null {
  const row = db.prepare(sql).raw().get(...params) as unknown[] | undefined;
  return row === undefined ? null : map(row);
}

/** Execute a statement whose affected-row count the caller does not care
 * about — e.g. a DELETE that may legitimately match nothing. */
export function executeOne(
  db: Database.Database,
  sql: string,
  params: readonly unknown[]
): void {
  db.prepare(sql).run(...params);
}

/**
 * Execute a statement that MUST have found its row, and say so when it did
 * not.
 *
 * {@link executeOne} discards the affected-row count, which is right for a
 * DELETE that may legitimately match nothing. It is exactly wrong for an
 * UPDATE of a row the caller believes exists: `UPDATE … WHERE id=?` against a
 * row deleted since the screen was drawn changes nothing, returns without
 * error, and the caller reports success. A skill deleted in another window
 * while you had it open answered "Saved" and kept nothing you typed. Anything
 * whose success claim depends on a row still being there uses THIS.
 */
export function executeExisting(
  db: Database.Database,
  sql: string,
  params: readonly unknown[],
  missing: string
): void {
  const info = db.prepare(sql).run(...params);
  if (info.changes === 0) {
    throw new Error(missing);
  }
}

/**
 * Execute a statement on a table with a UNIQUE constraint, reporting a clash
 * in the caller's own words rather than leaking the driver's. SQLite's own
 * text names the table and column — room structure — and reads as a crash
 * rather than "you already have one of those".
 *
 * The match is on the substring "UNIQUE", which is what both drivers produce
 * ("UNIQUE constraint failed: table.column") and what the Rust source matches
 * on. Two consequences carried over deliberately: a failure that is NOT a
 * uniqueness clash is rethrown UNCHANGED — relabelling a NOT NULL violation
 * as a name clash would send the user renaming something to fix a broken
 * write — and a table with a SECOND unique constraint would answer in the
 * wrong words, so nothing on such a table should rely on the label.
 */
export function executeUnique(
  db: Database.Database,
  sql: string,
  params: readonly unknown[],
  onConflict: () => string
): void {
  try {
    db.prepare(sql).run(...params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE")) {
      throw new Error(onConflict());
    }
    throw err;
  }
}
