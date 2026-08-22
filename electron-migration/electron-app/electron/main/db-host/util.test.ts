/**
 * Vitest port of the `util.rs` tests (`src-tauri/src/db/util.rs`, `mod
 * tests`):
 *
 *   - the_row_readers_tell_missing_apart_from_broken
 *   - an_update_that_found_no_row_is_a_failure_not_a_save
 *   - a_name_clash_is_reported_in_the_callers_words_and_nothing_else_is
 *
 * These exercise the query/execute PLUMBING, not the room schema — so, like
 * the Rust source's own `mod tests` (a bare `Connection::open_in_memory()`
 * plus a hand-rolled scratch table `t`, NOT the shared `db::mem()` helper
 * that applies the real `SCHEMA`), this file uses a bare
 * `new Database(":memory:")` rather than a real fixture room via
 * `createRoom`. Nothing here touches a room table, so encrypting a file on
 * disk to test `queryOpt` would only add I/O.
 *
 * The schema-dependent modules in this port — chats, messages, memories,
 * embeddings, skills — DO use real fixture rooms, since what they test is
 * behaviour against the REAL table definitions.
 */

import Database from "better-sqlite3-multiple-ciphers";
import { describe, expect, it } from "vitest";
import {
  executeExisting,
  executeOne,
  executeUnique,
  queryOne,
  queryOpt,
  queryRows,
} from "./util.js";

/** The same ad hoc table the Rust test module creates for itself. */
function conn(): Database.Database {
  const db = new Database(":memory:");
  db.exec(
    `CREATE TABLE t (id TEXT PRIMARY KEY, name TEXT UNIQUE, n INTEGER NOT NULL);
     INSERT INTO t VALUES ('a', 'Alpha', 1), ('b', 'Beta', 2);`
  );
  return db;
}

describe("queryRows / queryOne / queryOpt", () => {
  it("the_row_readers_tell_missing_apart_from_broken", () => {
    const c = conn();

    const all = queryRows(c, "SELECT name FROM t ORDER BY id", [], (r) => r[0] as string);
    expect(all).toEqual(["Alpha", "Beta"]);

    // A row that may legitimately not be there is null, not an error…
    const gone = queryOpt(c, "SELECT name FROM t WHERE id = ?", ["zzz"], (r) => r[0] as string);
    expect(gone).toBeNull();

    // …while the reader that PROMISES a row says so when there isn't one.
    expect(() =>
      queryOne(c, "SELECT name FROM t WHERE id = ?", ["zzz"], (r) => r[0] as string)
    ).toThrow("Query returned no rows");

    // Broken SQL must never be mistaken for an empty table.
    expect(() => queryRows(c, "SELECT nope FROM t", [], (r) => r[0] as string)).toThrow();

    c.close();
  });
});

describe("executeExisting", () => {
  // The whole reason `executeExisting` exists. `UPDATE … WHERE id=?` against
  // a row deleted since the screen was drawn changes nothing and would
  // otherwise report success — a skill deleted in another window while you
  // had it open answered "Saved" and kept nothing you typed.
  it("an_update_that_found_no_row_is_a_failure_not_a_save", () => {
    const c = conn();

    executeExisting(c, "UPDATE t SET n = 9 WHERE id = ?", ["a"], "That item no longer exists.");
    expect(queryOne(c, "SELECT n FROM t WHERE id='a'", [], (r) => r[0] as number)).toBe(9);

    expect(() =>
      executeExisting(
        c,
        "UPDATE t SET n = 9 WHERE id = ?",
        ["deleted-elsewhere"],
        "That item no longer exists."
      )
    ).toThrow("That item no longer exists.");

    // …and the looser helper stays loose on purpose: a DELETE that matches
    // nothing is not a failure.
    expect(() => executeOne(c, "DELETE FROM t WHERE id = ?", ["never-existed"])).not.toThrow();

    c.close();
  });
});

describe("executeUnique", () => {
  // A clash must reach the user in the caller's words. SQLite's own text
  // names the table and column, which is room structure, and reads as a
  // crash rather than "you already have one of those".
  it("a_name_clash_is_reported_in_the_callers_words_and_nothing_else_is", () => {
    const c = conn();

    expect(() =>
      executeUnique(
        c,
        "INSERT INTO t VALUES (?, ?, ?)",
        ["c", "Alpha", 3],
        () => 'A folder named "Alpha" already exists.'
      )
    ).toThrow('A folder named "Alpha" already exists.');

    // A failure that is NOT a uniqueness clash must not be relabelled as one
    // — that would send the user renaming something to fix a broken write.
    // (Here: NOT NULL on `n`. The match is on the word UNIQUE, so a table
    // with a SECOND unique constraint would answer in the wrong words — the
    // same caveat the Rust source's own test calls out.)
    let err: unknown;
    try {
      executeUnique(
        c,
        "INSERT INTO t(id, name, n) VALUES (?, ?, ?)",
        ["c", "Gamma", null],
        () => 'A folder named "Gamma" already exists.'
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("already exists");

    c.close();
  });
});
