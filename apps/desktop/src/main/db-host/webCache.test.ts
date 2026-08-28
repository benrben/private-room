/**
 * Port of `src-tauri/src/db/web_cache.rs`'s `#[cfg(test)] mod tests`, plus the
 * cases this port's own shape needs (a legacy NULL row, and the ONE key that
 * has to serve both the lookup and the save).
 *
 * REAL FIXTURE ROOMS via `createRoom`, this directory's established convention
 * (`settings.test.ts`, `open.test.ts`): `web_pages`/`web_images`/`web_searches`
 * are already in `schema.sql`, so none of the ad-hoc table creation the Rust
 * test module needed (its `SCHEMA` predates `web_searches`) applies here.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebHit } from "../../shared/apiTypes.js";
import { createRoom } from "./open.js";
import {
  clearWebCache,
  countWebCache,
  getFreshWebImage,
  getFreshWebPage,
  getFreshWebSearch,
  putWebSearch,
  saveWebImage,
  saveWebPage,
} from "./webCache.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-webcache-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

function hit(url: string): WebHit {
  return { title: "T", url, engines: ["brave"], date: null, snippet: null, score: 0.5 };
}

describe("putWebSearch / getFreshWebSearch", () => {
  /** The offline case: every engine drops out, the fusion answers with an
   * empty list, and caching that made the next quarter of an hour of retries
   * return the same nothing. */
  it("never remembers an empty search as an answer", () => {
    const db = freshRoom();
    putWebSearch(db, "best pizza", []);
    expect(getFreshWebSearch(db, "best pizza")).toBeNull();
    // ...and a real result still caches, so a retry after the connection
    // comes back is remembered normally.
    putWebSearch(db, "best pizza", [hit("https://example.com/a")]);
    expect(getFreshWebSearch(db, "best pizza")?.length).toBe(1);
    db.close();
  });

  /** ONE key serves both the lookup and the save (CHG-33): a search typed in
   * the address bar must warm the assistant's own `web_search` cache and vice
   * versa, which only works if both sides normalize identically — which is
   * why this module imports `searchKey` rather than re-spelling it. */
  it("keys case- and whitespace-insensitively, so repeats and variants share one row", () => {
    const db = freshRoom();
    putWebSearch(db, "  Best   Pizza  ", [hit("https://a/")]);
    expect(getFreshWebSearch(db, "best pizza")?.length).toBe(1);
    // A second put under a differently-spelled-but-equal query REPLACES the
    // row rather than adding a second one the other speller can never find.
    putWebSearch(db, "BEST PIZZA", [hit("https://a/"), hit("https://b/")]);
    expect(countWebCache(db).searches).toBe(1);
    expect(getFreshWebSearch(db, "  best   pizza")?.length).toBe(2);
    db.close();
  });

  it("reads a row an older build wrote as rendered text as a miss, not a crash", () => {
    const db = freshRoom();
    db.prepare(
      `INSERT INTO web_searches(query_key, results_text) VALUES ('best pizza', '1. Some Page — https://a/')`,
    ).run();
    expect(getFreshWebSearch(db, "Best Pizza")).toBeNull();
    db.close();
  });
});

describe("pruneWebCache", () => {
  it("sweeps stale rows on the next write, keeping the fresh one", () => {
    const db = freshRoom();
    saveWebPage(db, "https://old.example/", "Old", "old text");
    saveWebImage(db, "https://old.example/i.png", "image/png", Buffer.from("xx"));
    // Age both rows past the 24h window.
    db.exec("UPDATE web_pages SET saved_at = '2000-01-01T00:00:00Z'");
    db.exec("UPDATE web_images SET saved_at = '2000-01-01T00:00:00Z'");
    // Any write runs the sweep.
    saveWebPage(db, "https://new.example/", "New", "new text");
    expect(countWebCache(db)).toEqual({ searches: 0, pages: 1, images: 0 });
    expect(getFreshWebPage(db, "https://new.example/")).not.toBeNull();
    db.close();
  });

  it("sweeps a search past its own shorter 15-minute window", () => {
    const db = freshRoom();
    putWebSearch(db, "q", [hit("https://a/")]);
    db.exec("UPDATE web_searches SET saved_at = '2000-01-01T00:00:00Z'");
    // A page write runs the same sweep across all three tables.
    saveWebPage(db, "https://new.example/", "New", "new text");
    expect(countWebCache(db).searches).toBe(0);
    db.close();
  });
});

describe("clearWebCache / countWebCache", () => {
  it("clears exactly the three tables the count promised", () => {
    const db = freshRoom();
    expect(countWebCache(db)).toEqual({ searches: 0, pages: 0, images: 0 });
    putWebSearch(db, "q", [hit("https://a.example/")]);
    saveWebPage(db, "https://a.example/", "A", "text");
    saveWebImage(db, "https://a.example/i.png", "image/png", Buffer.from("xx"));
    expect(countWebCache(db)).toEqual({ searches: 1, pages: 1, images: 1 });

    clearWebCache(db);

    // The count must keep naming the same tables the Clear empties: a table
    // dropped from one side and not the other is a button that deletes more
    // (or less) than it promised.
    expect(countWebCache(db)).toEqual({ searches: 0, pages: 0, images: 0 });
    expect(getFreshWebSearch(db, "q")).toBeNull();
    expect(getFreshWebPage(db, "https://a.example/")).toBeNull();
    expect(getFreshWebImage(db, "https://a.example/i.png")).toBeNull();
    db.close();
  });
});

describe("getFreshWebPage / getFreshWebImage", () => {
  it("answers a saved page and image by their exact URL", () => {
    const db = freshRoom();
    saveWebPage(db, "https://a/", "A title", "readable text");
    saveWebImage(db, "https://a/i.png", "image/png", Buffer.from("bytes"));
    expect(getFreshWebPage(db, "https://a/")).toEqual({ title: "A title", text: "readable text" });
    const image = getFreshWebImage(db, "https://a/i.png");
    expect(image?.mime).toBe("image/png");
    expect(image?.bytes.toString()).toBe("bytes");
    // A near-miss URL is a miss: the cache is keyed on the exact address.
    expect(getFreshWebPage(db, "https://a")).toBeNull();
    db.close();
  });

  it("a legacy row with a null title/text answers with empty strings, not null", () => {
    const db = freshRoom();
    db.prepare(
      `INSERT INTO web_pages(id, url, title, readable_text) VALUES ('x', 'https://legacy/', NULL, NULL)`,
    ).run();
    expect(getFreshWebPage(db, "https://legacy/")).toEqual({ title: "", text: "" });
    db.close();
  });

  it("a repeat save refreshes the same row rather than growing the table", () => {
    const db = freshRoom();
    saveWebPage(db, "https://a/", "First", "first text");
    saveWebPage(db, "https://a/", "Second", "second text");
    expect(countWebCache(db).pages).toBe(1);
    expect(getFreshWebPage(db, "https://a/")?.text).toBe("second text");
    db.close();
  });
});

describe("a cache lookup that cannot run is a MISS, never a failure", () => {
  /**
   * All three of Rust's `get_fresh_*` end in `.ok()`, which folds EVERY
   * rusqlite error into `None`. That is load-bearing: `runSearch` reads the
   * search cache BEFORE it searches, `browserPeek`/`browserSearchSummary` read
   * the page cache before they fetch, and `previewOne` reads the image cache
   * for eight strangers' pages at once — so a lookup that throws does not cost
   * a cache hit, it costs the whole user-facing action. `queryOpt` answers
   * `null` for "no row" but THROWS for a query that could not run at all: a
   * table an older room never got, a busy write lock, a damaged page.
   */
  it("answers null when the table itself is gone, rather than throwing", () => {
    const db = freshRoom();
    saveWebPage(db, "https://a/", "A", "text");
    saveWebImage(db, "https://a/i.png", "image/png", Buffer.from("xx"));
    putWebSearch(db, "pizza", [hit("https://a/")]);
    // …all three really were cached first, so a null below is the ABSORPTION
    // and not simply an empty room.
    expect(getFreshWebPage(db, "https://a/")).not.toBeNull();
    expect(getFreshWebImage(db, "https://a/i.png")).not.toBeNull();
    expect(getFreshWebSearch(db, "pizza")).not.toBeNull();

    db.prepare("DROP TABLE web_pages").run();
    db.prepare("DROP TABLE web_images").run();
    db.prepare("DROP TABLE web_searches").run();

    expect(getFreshWebPage(db, "https://a/")).toBeNull();
    expect(getFreshWebImage(db, "https://a/i.png")).toBeNull();
    expect(getFreshWebSearch(db, "pizza")).toBeNull();
    db.close();
  });

  it("still reads a row written by an older build as a miss rather than as JSON", () => {
    const db = freshRoom();
    db.prepare(
      `INSERT INTO web_searches(query_key, results_text) VALUES ('pizza', '1. Not JSON — a rendered list')`,
    ).run();
    expect(getFreshWebSearch(db, "pizza")).toBeNull();
    db.close();
  });
});

describe("the two TTLs are two different promises", () => {
  /**
   * Page bodies and thumbnails ride a 24h window; SEARCH RESULTS ride 15
   * minutes, because results churn and a stale ranking presented as today's is
   * a wrong answer rather than a slow one. Folding them into one constant would
   * either re-search every page or serve yesterday's results — and nothing else
   * in this file would notice.
   */
  it("keeps a page fresh at an age that has already expired a search", () => {
    const db = freshRoom();
    saveWebPage(db, "https://a/", "A", "text");
    saveWebImage(db, "https://a/i.png", "image/png", Buffer.from("xx"));
    putWebSearch(db, "pizza", [hit("https://a/")]);
    // One hour old: past the 15-minute search window, well inside the 24h one.
    const anHourAgo = "strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 hour')";
    db.prepare(`UPDATE web_pages SET saved_at = ${anHourAgo}`).run();
    db.prepare(`UPDATE web_images SET saved_at = ${anHourAgo}`).run();
    db.prepare(`UPDATE web_searches SET saved_at = ${anHourAgo}`).run();

    expect(getFreshWebPage(db, "https://a/")?.text).toBe("text");
    expect(getFreshWebImage(db, "https://a/i.png")).not.toBeNull();
    expect(getFreshWebSearch(db, "pizza")).toBeNull();
    db.close();
  });
});
