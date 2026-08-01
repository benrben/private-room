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
    )
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
    )
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
    )
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
