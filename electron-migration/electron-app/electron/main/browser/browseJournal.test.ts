/**
 * Port of the tests in `src-tauri/src/db/browse.rs`'s `mod tests` that belong
 * to this half of the module:
 *
 *  - clearing_removes_every_line
 *  - every_line_carries_the_sitting_it_was_written_in
 *  - the_clear_scope_counts_everything_a_clear_would_erase
 *  - the_journal_keeps_only_the_newest_lines
 *
 * plus the limit clamp `list_browse_journal` applies.
 *
 * Rows are written through the REAL, already-ported `insertBrowseJournal`
 * (`journal.ts`) against a REAL fixture room, never a duplicated INSERT — so
 * these tests would notice an insert that stopped writing what this reader
 * reads.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebHit } from "../../shared/apiTypes.js";
import { createRoom } from "../db-host/open.js";
import { clearWebCache, putWebSearch, saveWebImage, saveWebPage } from "../db-host/webCache.js";
import { JOURNAL_CAP, insertBrowseJournal } from "./journal.js";
import { browseClearScope, clearBrowseJournal, listBrowseJournal } from "./browseJournal.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function freshRoom() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "browse-journal-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

function hit(url: string): WebHit {
  return { title: "T", url, engines: ["brave"], date: null, snippet: null, score: 0.5 };
}

describe("listBrowseJournal", () => {
  it("is newest first and clamps the limit to [1, 2000]", () => {
    const db = freshRoom();
    insertBrowseJournal(db, "s1", "open", "https://a/", "one");
    insertBrowseJournal(db, "s1", "open", "https://b/", "two");
    expect(listBrowseJournal(db, 10).map((r) => r.detail)).toEqual(["two", "one"]);
    // A limit below 1 still returns the newest line, not zero.
    expect(listBrowseJournal(db, 0)).toHaveLength(1);
    expect(listBrowseJournal(db, -5)).toHaveLength(1);
    // A huge limit is clamped rather than handed to SQLite.
    expect(listBrowseJournal(db, 999_999)).toHaveLength(2);
    // A fractional limit is truncated, not rejected by the driver's integer
    // bind — a `LIMIT 1.5` would otherwise throw out of a read-only query.
    expect(listBrowseJournal(db, 1.9)).toHaveLength(1);
    db.close();
  });

  /** The sitting boundary is only useful if it comes back out with the line —
   * the Journal separates "now" from "before" by comparing this against the
   * live session id. */
  it("carries the sitting each line was written in, empty when there was none", () => {
    const db = freshRoom();
    insertBrowseJournal(db, "20260815120000-0", "open", "https://a/", "first");
    // A line written outside a sitting is honest about it rather than
    // inheriting the last one.
    insertBrowseJournal(db, "", "blocker", "", "no sitting");
    const rows = listBrowseJournal(db, 10);
    expect(rows[0]?.session).toBe("");
    expect(rows[1]?.session).toBe("20260815120000-0");
    // …and every other column survives the round trip the panel reads.
    expect(rows[1]).toMatchObject({ kind: "open", url: "https://a/", detail: "first" });
    expect(typeof rows[1]?.at).toBe("string");
    db.close();
  });
});

describe("clearBrowseJournal", () => {
  it("removes every line", () => {
    const db = freshRoom();
    insertBrowseJournal(db, "s1", "open", "https://example.com/", "one");
    clearBrowseJournal(db);
    expect(listBrowseJournal(db, 10)).toEqual([]);
    db.close();
  });
});

describe("browseClearScope", () => {
  it("counts everything a clear would erase, across the journal AND the web cache", () => {
    const db = freshRoom();
    insertBrowseJournal(db, "s1", "open", "https://a/", "one");
    insertBrowseJournal(db, "s1", "open", "https://b/", "two");
    saveWebPage(db, "https://a/", "A", "text");
    saveWebImage(db, "https://a/i.png", "image/png", Buffer.from("xx"));
    putWebSearch(db, "pizza", [hit("https://a/")]);

    expect(browseClearScope(db)).toEqual({ journal: 2, searches: 1, pages: 1, images: 1 });

    // …and the count must keep naming the same tables the Clear empties: a
    // table dropped from one side and not the other is a button that deletes
    // more (or less) than it promised.
    clearBrowseJournal(db);
    clearWebCache(db);
    expect(browseClearScope(db)).toEqual({ journal: 0, searches: 0, pages: 0, images: 0 });
    db.close();
  });
});

describe("JOURNAL_CAP", () => {
  /**
   * Port of `the_journal_keeps_only_the_newest_lines`. The trail had no bound
   * at all — one row per page opened, read, clicked, blocked or downloaded,
   * kept forever, with only the Clear button ever shrinking it — inside a room
   * whose whole promise is that the record stays readable.
   */
  it("keeps only the newest lines, and it is the NEWEST that survive", () => {
    const db = freshRoom();
    for (let i = 0; i < JOURNAL_CAP + 25; i += 1) {
      insertBrowseJournal(db, "s1", "open", "https://example.com/", `line ${i}`);
    }
    const kept = db.prepare("SELECT COUNT(*) AS n FROM browse_journal").get() as { n: number };
    expect(kept.n, "the trail must not grow without bound").toBe(JOURNAL_CAP);
    // …and it is the NEWEST lines that survive, not the first ones written.
    expect(listBrowseJournal(db, 1)[0]?.detail).toBe(`line ${JOURNAL_CAP + 24}`);
    // The oldest line written is genuinely gone, not merely un-listed.
    const first = db
      .prepare("SELECT COUNT(*) AS n FROM browse_journal WHERE detail = 'line 0'")
      .get() as { n: number };
    expect(first.n).toBe(0);
    db.close();
  });

  /** A room well under the cap loses nothing — the trim must not be a sweep
   *  that fires early on the id arithmetic. */
  it("touches nothing in a room under the cap", () => {
    const db = freshRoom();
    for (let i = 0; i < 12; i += 1) {
      insertBrowseJournal(db, "s1", "open", "https://example.com/", `line ${i}`);
    }
    expect(listBrowseJournal(db, 2000)).toHaveLength(12);
    db.close();
  });
});
