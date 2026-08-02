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
pub fn insert_browse_journal(
    conn: &Connection,
    kind: &str,
    url: &str,
    detail: &str,
) -> Result<(), String> {
    execute_one(
        conn,
        "INSERT INTO browse_journal(kind, url, detail) VALUES (?1, ?2, ?3)",
        params![kind, url, detail],
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
    pub kind: String,
    pub url: String,
    pub detail: String,
}

/// Newest first, capped. The Journal view pages through this; the model never
/// reads it (it is the user's record OF the model).
pub fn list_browse_journal(conn: &Connection, limit: i64) -> Result<Vec<BrowseJournalRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, created_at, kind, url, detail FROM browse_journal
             ORDER BY id DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit.clamp(1, 2000)], |r| {
            Ok(BrowseJournalRow {
                id: r.get(0)?,
                at: r.get(1)?,
                kind: r.get(2)?,
                url: r.get(3)?,
                detail: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
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
            insert_browse_journal(&conn, "open", "https://example.com/", &format!("line {i}")).unwrap();
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
        insert_browse_journal(&conn, "open", "https://example.com/", "one").unwrap();
        clear_browse_journal(&conn).unwrap();
        assert!(list_browse_journal(&conn, 10).unwrap().is_empty());
    }
}
