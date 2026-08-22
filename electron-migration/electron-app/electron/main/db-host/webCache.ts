/**
 * The private browser's web cache — a 15-minute search-results cache, a 24h
 * fetched-page-text cache and a 24h preview-image cache, plus the counts and
 * the wipe the Clear button drives. Ported from
 * `src-tauri/src/db/web_cache.rs` (261 lines).
 *
 * Follows this directory's established conventions (see `util.ts`'s module
 * comment): `Database.Database` first, every read/write through
 * `queryOne`/`queryOpt`/`executeOne`, a numbered Rust `?1` becomes a
 * positional `?` with the value repeated.
 *
 * `searchKey` is IMPORTED from `files.ts`, never re-spelled here. CHG-33's
 * whole point is that ONE row serves both readers — a search typed in the
 * address bar makes the assistant's next `web_search` a free cache hit — and a
 * second copy of the normalization is a second chance for the two halves to
 * key the same query differently and silently stop meeting.
 *
 * DEVIATION — named results, not tuples. Rust hands back `Option<(String,
 * String)>`/`Option<(String, Vec<u8>)>` because that is what a Rust reader
 * wants; every call site here would otherwise read `cached[1]`, where a
 * transposed index is a silent wrong answer rather than a type error. The
 * lookups below answer `{ title, text }` / `{ mime, bytes }` instead.
 *
 * THE THREE `getFresh*` READERS CANNOT FAIL, and that is not this file's taste
 * — it is what their Rust originals do. All three end in `.ok()`, which folds
 * EVERY rusqlite error into `None`, so a cache lookup that cannot run reads as
 * a MISS and the caller fetches. The one thing they must never do is fail the
 * action they are trying to make free: `runSearch` reads the search cache
 * before it searches, `browserPeek` and `browserSearchSummary` read the page
 * cache before they fetch, and `previewOne` reads the image cache for eight
 * strangers' pages at once. `queryOpt` answers `null` for "no row" but THROWS
 * for a query that could not run at all — a table an older room never got, a
 * busy write lock, a damaged page — so each reader absorbs that here, exactly
 * where Rust absorbs it. The WRITES stay throwing: a caller that wants Rust's
 * `let _ = save_web_page(...)` wraps them, and every one of them does.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { randomUUID } from "node:crypto";
import type { WebHit } from "../../shared/apiTypes.js";
import { executeOne, queryOne, queryOpt } from "./util.js";
import { searchKey } from "./files.js";

/** How long a cached page counts as fresh before we re-fetch (RM-2). SQLite
 *  `strftime` modifier syntax, passed straight through. */
const WEB_CACHE_TTL = "-24 hours";
/** CHG-33: web_search results cache shorter than page bodies — results
 *  churn. */
const WEB_SEARCH_TTL = "-15 minutes";

/**
 * CHG-33: cache one search's fused hits.
 *
 * An empty result is not an answer worth remembering. The fused search never
 * fails as a whole — a blocked or unreachable engine drops out silently — so
 * "no hits" is exactly what an OFFLINE Mac produces, and caching it made the
 * next fifteen minutes of retries return the same emptiness after the
 * connection came back. The assistant then reads "nothing exists" and answers
 * from its own memory.
 */
export function putWebSearch(db: Database.Database, query: string, hits: readonly WebHit[]): void {
  if (hits.length === 0) {
    return;
  }
  executeOne(
    db,
    `INSERT INTO web_searches(query_key, results_text, saved_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(query_key) DO UPDATE SET
       results_text = excluded.results_text,
       saved_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
    [searchKey(query), JSON.stringify(hits)],
  );
  pruneWebCache(db);
}

/**
 * CHG-33: a cached search's hits if searched within the TTL, else `null`.
 *
 * A row written by an older build holds the rendered text, not JSON. That
 * fails to parse and reads as a miss, which costs one re-search and nothing
 * else — the whole table is 15 minutes from empty anyway, so there is no
 * migration to write.
 */
export function getFreshWebSearch(db: Database.Database, query: string): WebHit[] | null {
  try {
    const json = queryOpt(
      db,
      `SELECT results_text FROM web_searches
       WHERE query_key = ?
         AND saved_at > strftime('%Y-%m-%dT%H:%M:%SZ','now',?)`,
      [searchKey(query), WEB_SEARCH_TTL],
      (r) => r[0] as string,
    );
    return json === null ? null : (JSON.parse(json) as WebHit[]);
  } catch {
    // Rust's `.ok()?` / `.ok()`: an unreadable row and an unrunnable query are
    // both a cache MISS, which costs one re-search. See the module comment.
    return null;
  }
}

/**
 * Cache a fetched page's readable text, keyed by URL (RM-2). Upserts so
 * repeat fetches refresh the same row instead of growing the table forever.
 * `raw_html` is intentionally left NULL — reserved for a future reader that
 * will populate and consume it.
 *
 * Callers treat a failure here as nothing (the fetch already succeeded;
 * caching is best-effort) — `better-sqlite3` throws synchronously, so a caller
 * that wants Rust's `let _ = …` wraps this in a `try`.
 */
export function saveWebPage(db: Database.Database, url: string, title: string, text: string): void {
  executeOne(
    db,
    `INSERT INTO web_pages(id, url, title, readable_text) VALUES (?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       title = excluded.title,
       readable_text = excluded.readable_text,
       saved_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
    [randomUUID(), url, title, text],
  );
  pruneWebCache(db);
}

/**
 * BROWSE-3b: cache one preview image's bytes, keyed by its own URL. Images
 * are small and immutable in practice, so they ride the same 24h TTL as page
 * text; re-searching the same query re-renders every thumbnail with no network
 * at all. Best-effort like the page cache — a failure costs a re-fetch,
 * nothing more.
 */
export function saveWebImage(
  db: Database.Database,
  url: string,
  mime: string,
  bytes: Uint8Array,
): void {
  executeOne(
    db,
    `INSERT INTO web_images(url, mime, bytes, saved_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(url) DO UPDATE SET
       mime = excluded.mime,
       bytes = excluded.bytes,
       saved_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
    [url, mime, Buffer.from(bytes)],
  );
  pruneWebCache(db);
}

/**
 * Drop every cache row past its freshness window.
 *
 * The TTLs above only ever decided when to RE-fetch — nothing deleted the
 * stale rows, so a room accumulated the text of every page ever previewed and
 * the bytes of every thumbnail and site icon, forever, inside a browser whose
 * promise is that it keeps nothing. Run on every write: the tables are small
 * and indexed by their keys, so this is a cheap sweep at the one moment we are
 * already holding the connection.
 */
export function pruneWebCache(db: Database.Database): void {
  const sweeps: ReadonlyArray<readonly [string, string]> = [
    ["DELETE FROM web_pages WHERE saved_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now',?)", WEB_CACHE_TTL],
    ["DELETE FROM web_images WHERE saved_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now',?)", WEB_CACHE_TTL],
    ["DELETE FROM web_searches WHERE saved_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now',?)", WEB_SEARCH_TTL],
  ];
  for (const [sql, ttl] of sweeps) {
    // Best-effort, matching Rust's `let _ = conn.execute(...)`: a sweep that
    // fails must not fail the write it rides in on.
    try {
      executeOne(db, sql, [ttl]);
    } catch {
      // ignored — see above
    }
  }
}

/** How much of the room a {@link clearWebCache} would take with it. */
export interface WebCacheCounts {
  searches: number;
  pages: number;
  images: number;
}

/**
 * Count what {@link clearWebCache} would delete, so the Clear button can say
 * it before it does it.
 *
 * The two must always name the same three tables — a table dropped from one
 * side and not the other is a button that deletes more (or less) than it
 * promised. Held together by behaviour, in `webCache.test.ts`, rather than by
 * this comment.
 */
export function countWebCache(db: Database.Database): WebCacheCounts {
  const count = (table: string): number =>
    queryOne(db, `SELECT COUNT(*) FROM ${table}`, [], (r) => r[0] as number);
  return {
    searches: count("web_searches"),
    pages: count("web_pages"),
    images: count("web_images"),
  };
}

/**
 * Wipe every cached search, page and image.
 *
 * Wired to the browser's Clear button alongside the journal: a user who clears
 * their browsing record must not be left with the search terms and the full
 * text of eight result pages still sitting in the room.
 */
export function clearWebCache(db: Database.Database): void {
  for (const sql of ["DELETE FROM web_searches", "DELETE FROM web_pages", "DELETE FROM web_images"]) {
    executeOne(db, sql, []);
  }
}

/** A cached image for this exact URL if fetched within 24h (BROWSE-3b), else
 *  `null`. */
export function getFreshWebImage(
  db: Database.Database,
  url: string,
): { mime: string; bytes: Buffer } | null {
  try {
    return queryOpt(
      db,
      `SELECT mime, bytes FROM web_images
       WHERE url = ?
         AND saved_at > strftime('%Y-%m-%dT%H:%M:%SZ','now',?)`,
      [url, WEB_CACHE_TTL],
      (r) => ({ mime: r[0] as string, bytes: r[1] as Buffer }),
    );
  } catch {
    // Rust's `.ok()`: a miss, so the caller re-fetches one thumbnail. See the
    // module comment.
    return null;
  }
}

/**
 * A cached page for this exact URL if it was fetched within the last 24h, else
 * `null` (RM-2). Lets a page fetch skip the network on a fresh hit. `saved_at`
 * is a sortable ISO-8601 string, so a lexical compare against the TTL cutoff
 * is correct.
 *
 * A row whose `title`/`readable_text` is NULL answers with empty strings, not
 * `null` — matching Rust's `r.get::<_, Option<String>>(0)?.unwrap_or_default()`,
 * so a legacy row reads as "cached, nothing in it" rather than as a crash.
 */
export function getFreshWebPage(
  db: Database.Database,
  url: string,
): { title: string; text: string } | null {
  try {
    return queryOpt(
      db,
      `SELECT title, readable_text FROM web_pages
       WHERE url = ?
         AND saved_at > strftime('%Y-%m-%dT%H:%M:%SZ','now',?)`,
      [url, WEB_CACHE_TTL],
      (r) => ({ title: (r[0] as string | null) ?? "", text: (r[1] as string | null) ?? "" }),
    );
  } catch {
    // Rust's `.ok()`: a miss, so the caller fetches the page. See the module
    // comment.
    return null;
  }
}
