use super::*;

/// How many journal lines a room keeps.
///
/// The trail had no bound at all: one row per page opened, read, clicked,
/// blocked or downloaded, kept forever, with only the Clear button ever
/// shrinking it. The Journal view reads the newest few hundred, so anything
/// past this is storage nobody will look at — trimmed on write so the cost is
/// one cheap `DELETE` per append rather than a sweep nobody schedules.
const JOURNAL_CAP: i64 = 5_000;

/// BROWSE-1: the browser's audit trail.
///
/// The inversion that makes the private browser trustworthy: the WEB persists
/// nothing (the webview runs on a non-persistent data store — no history, no
/// cookies, no cache), while everything the AGENT did persists here, inside
/// the encrypted room, for the user to read back. "Private" means the sites
/// learn nothing and leave nothing behind, not that the agent's conduct is
/// unaccountable.
///
/// Bounded at [`JOURNAL_CAP`] newest lines — an audit trail the user can
/// actually read, not an unbounded log.
///
/// `session` is the browsing sitting the line belongs to (empty when none is
/// live) — the boundary the Journal draws between what is happening now and
/// everything that came before.
pub fn insert_browse_journal(
    conn: &Connection,
    session: &str,
    kind: &str,
    url: &str,
    detail: &str,
) -> Result<(), String> {
    execute_one(
        conn,
        "INSERT INTO browse_journal(session, kind, url, detail) VALUES (?1, ?2, ?3, ?4)",
        params![session, kind, url, detail],
    )?;
    // `id` is AUTOINCREMENT, so it only ever climbs: everything at or below
    // (newest − cap) is older than the cap's worth of lines we keep.
    let _ = conn.execute(
        "DELETE FROM browse_journal
         WHERE id <= (SELECT MAX(id) FROM browse_journal) - ?1",
        params![JOURNAL_CAP],
    );
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseJournalRow {
    pub id: i64,
    pub at: String,
    pub session: String,
    pub kind: String,
    pub url: String,
    pub detail: String,
}

/// Newest first, capped. The Journal view pages through this; the model never
/// reads it (it is the user's record OF the model).
pub fn list_browse_journal(conn: &Connection, limit: i64) -> Result<Vec<BrowseJournalRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, created_at, session, kind, url, detail FROM browse_journal
             ORDER BY id DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit.clamp(1, 2000)], |r| {
            Ok(BrowseJournalRow {
                id: r.get(0)?,
                at: r.get(1)?,
                session: r.get(2)?,
                kind: r.get(3)?,
                url: r.get(4)?,
                detail: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Everything a Clear would take with it, counted before it happens.
///
/// The Clear button says "Erase this record" and then also empties the web
/// cache behind it — the search terms, the full text of the result pages, the
/// thumbnails. That is the right thing to delete (see [`clear_web_cache`]) and
/// the wrong thing to keep quiet about, so the counts are askable.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearScope {
    pub journal: i64,
    pub searches: i64,
    pub pages: i64,
    pub images: i64,
}

pub fn browse_clear_scope(conn: &Connection) -> Result<ClearScope, String> {
    let web = count_web_cache(conn)?;
    Ok(ClearScope {
        journal: query_one(conn, "SELECT COUNT(*) FROM browse_journal", [], |r| r.get(0))?,
        searches: web.searches,
        pages: web.pages,
        images: web.images,
    })
}

/// Wipe the record. Offered in the Journal view because a user who browsed
/// something they would rather not keep must be able to remove it from their
/// own room — the audit trail is for them, not over them.
pub fn clear_browse_journal(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM browse_journal", [])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_journal_keeps_only_the_newest_lines() {
        let conn = crate::db::mem();
        for i in 0..(JOURNAL_CAP + 25) {
            insert_browse_journal(&conn, "s1", "open", "https://example.com/", &format!("line {i}"))
                .unwrap();
        }
        let kept: i64 = conn
            .query_row("SELECT COUNT(*) FROM browse_journal", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, JOURNAL_CAP, "the trail must not grow without bound");
        // …and it is the NEWEST lines that survive, not the first ones written.
        let newest = list_browse_journal(&conn, 1).unwrap();
        assert_eq!(newest[0].detail, format!("line {}", JOURNAL_CAP + 24));
    }

    #[test]
    fn clearing_removes_every_line() {
        let conn = crate::db::mem();
        insert_browse_journal(&conn, "s1", "open", "https://example.com/", "one").unwrap();
        clear_browse_journal(&conn).unwrap();
        assert!(list_browse_journal(&conn, 10).unwrap().is_empty());
    }

    /// The sitting boundary is only useful if it comes back out with the line —
    /// the Journal separates "now" from "before" by comparing this against the
    /// live session id.
    #[test]
    fn every_line_carries_the_sitting_it_was_written_in() {
        let conn = crate::db::mem();
        insert_browse_journal(&conn, "20260815120000-0", "open", "https://a/", "first").unwrap();
        // A line written outside a sitting is honest about it rather than
        // inheriting the last one.
        insert_browse_journal(&conn, "", "blocker", "", "no sitting").unwrap();
        let rows = list_browse_journal(&conn, 10).unwrap();
        assert_eq!(rows[0].session, "");
        assert_eq!(rows[1].session, "20260815120000-0");
    }

    /// The Clear button says "Erase this record" and also empties the web cache
    /// behind it. What it deletes is right; saying nothing about it was not.
    #[test]
    fn the_clear_scope_counts_everything_a_clear_would_erase() {
        let conn = crate::db::mem();
        insert_browse_journal(&conn, "s1", "open", "https://a/", "one").unwrap();
        insert_browse_journal(&conn, "s1", "open", "https://b/", "two").unwrap();
        save_web_page(&conn, "https://a/", "A", "text").unwrap();
        save_web_image(&conn, "https://a/i.png", "image/png", b"xx").unwrap();
        put_web_search(&conn, "pizza", &[crate::web::WebHit {
            title: "T".into(),
            url: "https://a/".into(),
            engines: vec!["brave".into()],
            date: None,
            snippet: None,
            score: 0.5,
        }])
        .unwrap();

        let scope = browse_clear_scope(&conn).unwrap();
        assert_eq!(scope, ClearScope { journal: 2, searches: 1, pages: 1, images: 1 });

        // …and the count must keep naming the same tables the Clear empties: a
        // table dropped from one side and not the other is a button that
        // deletes more (or less) than it promised.
        clear_browse_journal(&conn).unwrap();
        clear_web_cache(&conn).unwrap();
        assert_eq!(browse_clear_scope(&conn).unwrap(), ClearScope::default());
    }
}
