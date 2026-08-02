use super::*;

/// How long a cached page counts as fresh before we re-fetch (RM-2).
const WEB_CACHE_TTL: &str = "-24 hours";
/// CHG-33: web_search results cache shorter than page bodies — results churn.
const WEB_SEARCH_TTL: &str = "-15 minutes";

/// CHG-33: cache one search's fused hits.
///
/// BROWSE-3: the column holds JSON now, not the pre-rendered numbered list. One
/// cache serves both readers — the model's text list is rendered from these hits
/// at read time, and the browser's results page gets the structured shape it
/// needs. That shared row is also why a search typed in the address bar makes
/// the assistant's next `web_search` a free cache hit.
pub fn put_web_search(conn: &Connection, query: &str, hits: &[crate::web::WebHit]) -> Result<(), String> {
    // An empty result is not an answer worth remembering. The fused search
    // never fails as a whole — a blocked or unreachable engine drops out
    // silently — so "no hits" is exactly what an OFFLINE Mac produces, and
    // caching it made the next fifteen minutes of retries return the same
    // emptiness after the connection came back. The assistant then reads
    // "nothing exists" and answers from its own memory.
    if hits.is_empty() {
        return Ok(());
    }
    let key = search_key(query);
    let json = serde_json::to_string(hits).map_err(|e| e.to_string())?;
    execute_one(
        conn,
        "INSERT INTO web_searches(query_key, results_text, saved_at)
         VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         ON CONFLICT(query_key) DO UPDATE SET
           results_text = excluded.results_text,
           saved_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')",
        params![key, json],
    )?;
    prune_web_cache(conn);
    Ok(())
}

/// CHG-33: a cached search's hits if searched within the TTL, else None.
///
/// A row written by an older build holds the rendered text, not JSON. That
/// fails to parse and reads as a miss, which costs one re-search and nothing
/// else — the whole table is 15 minutes from empty anyway, so there is no
/// migration to write.
pub fn get_fresh_web_search(conn: &Connection, query: &str) -> Option<Vec<crate::web::WebHit>> {
    let key = search_key(query);
    let json: String = conn
        .query_row(
            "SELECT results_text FROM web_searches
             WHERE query_key = ?1
               AND saved_at > strftime('%Y-%m-%dT%H:%M:%SZ','now',?2)",
            params![key, WEB_SEARCH_TTL],
            |r| r.get(0),
        )
        .ok()?;
    serde_json::from_str(&json).ok()
}

/// Cache a fetched page's readable text, keyed by URL (RM-2). Upserts so
/// repeat fetches refresh the same row instead of growing the table forever.
/// `raw_html` is intentionally left NULL — it is reserved for ADD-12 (link
/// import), the future reader that will populate and consume it.
/// Callers ignore failures here (the fetch already succeeded; caching is
/// best-effort).
pub fn save_web_page(conn: &Connection, url: &str, title: &str, text: &str) -> Result<(), String> {
    execute_one(
        conn,
        "INSERT INTO web_pages(id, url, title, readable_text) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(url) DO UPDATE SET
           title = excluded.title,
           readable_text = excluded.readable_text,
           saved_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')",
        params![Uuid::new_v4().to_string(), url, title, text],
    )?;
    prune_web_cache(conn);
    Ok(())
}

/// BROWSE-3b: cache one preview image's bytes, keyed by its own URL. Images are
/// small and immutable in practice, so they ride the same 24h TTL as page text;
/// re-searching the same query re-renders every thumbnail with no network at all.
/// Best-effort like the page cache — a failure here costs a re-fetch, nothing more.
pub fn save_web_image(conn: &Connection, url: &str, mime: &str, bytes: &[u8]) -> Result<(), String> {
    execute_one(
        conn,
        "INSERT INTO web_images(url, mime, bytes, saved_at)
         VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         ON CONFLICT(url) DO UPDATE SET
           mime = excluded.mime,
           bytes = excluded.bytes,
           saved_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')",
        params![url, mime, bytes],
    )?;
    prune_web_cache(conn);
    Ok(())
}

/// Drop every cache row past its freshness window.
///
/// The TTLs above only ever decided when to RE-fetch — nothing deleted the
/// stale rows, so a room accumulated the text of every page ever previewed and
/// the bytes of every thumbnail and site icon, forever, inside a browser whose
/// promise is that it keeps nothing. Run on every write: the tables are small
/// and indexed by their keys, so this is a cheap sweep at the one moment we are
/// already holding the connection.
pub fn prune_web_cache(conn: &Connection) {
    for (sql, ttl) in [
        ("DELETE FROM web_pages WHERE saved_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now',?1)", WEB_CACHE_TTL),
        ("DELETE FROM web_images WHERE saved_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now',?1)", WEB_CACHE_TTL),
        ("DELETE FROM web_searches WHERE saved_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now',?1)", WEB_SEARCH_TTL),
    ] {
        let _ = conn.execute(sql, params![ttl]);
    }
}

/// Wipe every cached search, page and image.
///
/// Wired to the browser's Clear button alongside the journal: a user who
/// clears their browsing record must not be left with the search terms and the
/// full text of eight result pages still sitting in the room.
pub fn clear_web_cache(conn: &Connection) -> Result<(), String> {
    for sql in [
        "DELETE FROM web_searches",
        "DELETE FROM web_pages",
        "DELETE FROM web_images",
    ] {
        conn.execute(sql, []).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// A cached (mime, bytes) for this exact image URL if fetched within 24h (BROWSE-3b).
pub fn get_fresh_web_image(conn: &Connection, url: &str) -> Option<(String, Vec<u8>)> {
    conn.query_row(
        "SELECT mime, bytes FROM web_images
         WHERE url = ?1
           AND saved_at > strftime('%Y-%m-%dT%H:%M:%SZ','now',?2)",
        params![url, WEB_CACHE_TTL],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?)),
    )
    .ok()
}

/// Return a cached (title, readable_text) for this exact URL if it was fetched
/// within the last 24h, else None (RM-2). Lets `fetch_page` skip the network on
/// a fresh hit. `saved_at` is a sortable ISO-8601 string, so a lexical compare
/// against the TTL cutoff is correct.
pub fn get_fresh_web_page(conn: &Connection, url: &str) -> Option<(String, String)> {
    conn.query_row(
        "SELECT title, readable_text FROM web_pages
         WHERE url = ?1
           AND saved_at > strftime('%Y-%m-%dT%H:%M:%SZ','now',?2)",
        params![url, WEB_CACHE_TTL],
        |r| {
            Ok((
                r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            ))
        },
    )
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `SCHEMA` predates `web_searches`, which arrives in the migration pass —
    /// so `db::mem()` alone has the pages and images tables but not this one.
    fn mem() -> Connection {
        let conn = crate::db::mem();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS web_searches (
               query_key TEXT PRIMARY KEY,
               results_text TEXT NOT NULL,
               saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
             );",
        )
        .unwrap();
        conn
    }

    fn hit(url: &str) -> crate::web::WebHit {
        crate::web::WebHit {
            title: "T".into(),
            url: url.into(),
            engines: vec!["brave".into()],
            date: None,
            snippet: None,
            score: 0.5,
        }
    }

    /// The offline case: every engine drops out, the fusion answers with an
    /// empty list, and caching that made the next quarter of an hour of
    /// retries return the same nothing.
    #[test]
    fn an_empty_search_is_never_remembered_as_an_answer() {
        let conn = mem();
        put_web_search(&conn, "best pizza", &[]).unwrap();
        assert!(get_fresh_web_search(&conn, "best pizza").is_none());
        // …and a real result still caches, so a retry after the connection
        // comes back is remembered normally.
        put_web_search(&conn, "best pizza", &[hit("https://example.com/a")]).unwrap();
        assert_eq!(get_fresh_web_search(&conn, "best pizza").unwrap().len(), 1);
    }

    #[test]
    fn stale_rows_are_swept_on_the_next_write() {
        let conn = mem();
        save_web_page(&conn, "https://old.example/", "Old", "old text").unwrap();
        save_web_image(&conn, "https://old.example/i.png", "image/png", b"xx").unwrap();
        // Age both rows past the 24h window.
        conn.execute("UPDATE web_pages SET saved_at = '2000-01-01T00:00:00Z'", []).unwrap();
        conn.execute("UPDATE web_images SET saved_at = '2000-01-01T00:00:00Z'", []).unwrap();
        // Any write runs the sweep.
        save_web_page(&conn, "https://new.example/", "New", "new text").unwrap();
        let pages: i64 = conn.query_row("SELECT COUNT(*) FROM web_pages", [], |r| r.get(0)).unwrap();
        let images: i64 = conn.query_row("SELECT COUNT(*) FROM web_images", [], |r| r.get(0)).unwrap();
        assert_eq!(pages, 1, "the stale page should be gone, the fresh one kept");
        assert_eq!(images, 0, "the stale thumbnail should be gone");
        assert!(get_fresh_web_page(&conn, "https://new.example/").is_some());
    }

    #[test]
    fn clearing_removes_every_cached_search_page_and_image() {
        let conn = mem();
        put_web_search(&conn, "q", &[hit("https://a.example/")]).unwrap();
        save_web_page(&conn, "https://a.example/", "A", "text").unwrap();
        save_web_image(&conn, "https://a.example/i.png", "image/png", b"xx").unwrap();
        clear_web_cache(&conn).unwrap();
        assert!(get_fresh_web_search(&conn, "q").is_none());
        assert!(get_fresh_web_page(&conn, "https://a.example/").is_none());
        assert!(get_fresh_web_image(&conn, "https://a.example/i.png").is_none());
    }
}
