use super::*;

/// How long a cached page counts as fresh before we re-fetch (RM-2).
const WEB_CACHE_TTL: &str = "-24 hours";
/// CHG-33: web_search results cache shorter than page bodies — results churn.
const WEB_SEARCH_TTL: &str = "-15 minutes";

/// CHG-33: cache a web_search result list (the formatted, pre-clamp text).
pub fn put_web_search(
    conn: &Connection,
    provider: &str,
    endpoint: &str,
    query: &str,
    results: &str,
) -> Result<(), String> {
    let key = search_key(provider, endpoint, query);
    execute_one(
        conn,
        "INSERT INTO web_searches(query_key, results_text, saved_at)
         VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         ON CONFLICT(query_key) DO UPDATE SET
           results_text = excluded.results_text,
           saved_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')",
        params![key, results],
    )
}

/// CHG-33: a cached web_search result list if searched within the TTL, else None.
pub fn get_fresh_web_search(
    conn: &Connection,
    provider: &str,
    endpoint: &str,
    query: &str,
) -> Option<String> {
    let key = search_key(provider, endpoint, query);
    conn.query_row(
        "SELECT results_text FROM web_searches
         WHERE query_key = ?1
           AND saved_at > strftime('%Y-%m-%dT%H:%M:%SZ','now',?2)",
        params![key, WEB_SEARCH_TTL],
        |r| r.get::<_, String>(0),
    )
    .ok()
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
