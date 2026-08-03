//! Query/execute plumbing shared by every table module.
//!
//! Each `list_*` here used to spell out the same three fallible steps —
//! `prepare` → `query_map` → `collect`, each with its own `.map_err(to_string)` —
//! and each mutator the same `execute(...).map_err(...)`. The SQL and the row
//! shape were the only things that ever differed. These helpers keep the error
//! mapping identical to what the hand-written versions produced, so callers see
//! byte-for-byte the same messages.

use rusqlite::{Connection, OptionalExtension, Params, Row};

/// Run a query and map every row.
pub(crate) fn query_rows<T, P, F>(
    conn: &Connection,
    sql: &str,
    params: P,
    map: F,
) -> Result<Vec<T>, String>
where
    P: Params,
    F: FnMut(&Row<'_>) -> rusqlite::Result<T>,
{
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params, map).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Run a query for a single row. A missing row is a rusqlite
/// `QueryReturnedNoRows` error, exactly as `conn.query_row` reports it.
pub(crate) fn query_one<T, P, F>(
    conn: &Connection,
    sql: &str,
    params: P,
    map: F,
) -> Result<T, String>
where
    P: Params,
    F: FnOnce(&Row<'_>) -> rusqlite::Result<T>,
{
    conn.query_row(sql, params, map).map_err(|e| e.to_string())
}

/// Run a query for a row that may legitimately not exist.
pub(crate) fn query_opt<T, P, F>(
    conn: &Connection,
    sql: &str,
    params: P,
    map: F,
) -> Result<Option<T>, String>
where
    P: Params,
    F: FnOnce(&Row<'_>) -> rusqlite::Result<T>,
{
    conn.query_row(sql, params, map)
        .optional()
        .map_err(|e| e.to_string())
}

/// Execute a statement whose row count the caller does not care about.
pub(crate) fn execute_one<P: Params>(
    conn: &Connection,
    sql: &str,
    params: P,
) -> Result<(), String> {
    conn.execute(sql, params).map_err(|e| e.to_string())?;
    Ok(())
}

/// Execute a statement that MUST have found its row, and say so when it did not.
///
/// [`execute_one`] discards the affected-row count, which is right for a DELETE
/// that may legitimately match nothing. It is exactly wrong for an UPDATE of a
/// row the caller believes exists: `UPDATE … WHERE id=?` against a row that has
/// been deleted since the screen was drawn changes nothing, returns `Ok(())`,
/// and the caller reports success. A skill deleted in another window while you
/// had it open answered "Saved" and kept nothing you typed. Anything whose
/// success claim depends on a row still being there uses THIS.
pub(crate) fn execute_existing<P: Params>(
    conn: &Connection,
    sql: &str,
    params: P,
    missing: &str,
) -> Result<(), String> {
    let changed = conn.execute(sql, params).map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(missing.to_string());
    }
    Ok(())
}

/// Execute a statement on a table with a UNIQUE constraint, reporting a clash in
/// the caller's own words rather than leaking SQLite's.
pub(crate) fn execute_unique<P, F>(
    conn: &Connection,
    sql: &str,
    params: P,
    on_conflict: F,
) -> Result<(), String>
where
    P: Params,
    F: FnOnce() -> String,
{
    conn.execute(sql, params).map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            on_conflict()
        } else {
            e.to_string()
        }
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE t (id TEXT PRIMARY KEY, name TEXT UNIQUE, n INTEGER NOT NULL);
             INSERT INTO t VALUES ('a', 'Alpha', 1), ('b', 'Beta', 2);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn the_row_readers_tell_missing_apart_from_broken() {
        let c = conn();
        let all: Vec<String> =
            query_rows(&c, "SELECT name FROM t ORDER BY id", [], |r| r.get(0)).unwrap();
        assert_eq!(all, ["Alpha", "Beta"]);

        // A row that may legitimately not be there is None, not an error…
        let gone: Option<String> =
            query_opt(&c, "SELECT name FROM t WHERE id = ?1", ["zzz"], |r| r.get(0)).unwrap();
        assert_eq!(gone, None);
        // …while the reader that PROMISES a row says so when there isn't one.
        assert!(query_one::<String, _, _>(&c, "SELECT name FROM t WHERE id = ?1", ["zzz"], |r| r
            .get(0))
        .is_err());
        // Broken SQL must never be mistaken for an empty table.
        assert!(query_rows::<String, _, _>(&c, "SELECT nope FROM t", [], |r| r.get(0)).is_err());
    }

    /// The whole reason `execute_existing` exists. `UPDATE … WHERE id=?` against
    /// a row deleted since the screen was drawn changes nothing and returns
    /// `Ok(())` — a skill deleted in another window while you had it open
    /// answered "Saved" and kept nothing you typed.
    #[test]
    fn an_update_that_found_no_row_is_a_failure_not_a_save() {
        let c = conn();
        execute_existing(
            &c,
            "UPDATE t SET n = 9 WHERE id = ?1",
            ["a"],
            "That item no longer exists.",
        )
        .expect("the row was there");
        assert_eq!(
            query_one::<i64, _, _>(&c, "SELECT n FROM t WHERE id='a'", [], |r| r.get(0)).unwrap(),
            9
        );

        assert_eq!(
            execute_existing(
                &c,
                "UPDATE t SET n = 9 WHERE id = ?1",
                ["deleted-elsewhere"],
                "That item no longer exists.",
            )
            .unwrap_err(),
            "That item no longer exists.",
        );
        // …and the looser helper stays loose on purpose: a DELETE that matches
        // nothing is not a failure.
        execute_one(&c, "DELETE FROM t WHERE id = ?1", ["never-existed"]).unwrap();
    }

    /// A clash must reach the user in the caller's words. SQLite's own text
    /// names the table and column, which is room structure, and reads as a
    /// crash rather than "you already have one of those".
    #[test]
    fn a_name_clash_is_reported_in_the_callers_words_and_nothing_else_is() {
        let c = conn();
        assert_eq!(
            execute_unique(
                &c,
                "INSERT INTO t VALUES (?1, ?2, ?3)",
                params!["c", "Alpha", 3],
                || "A folder named \"Alpha\" already exists.".to_string(),
            )
            .unwrap_err(),
            "A folder named \"Alpha\" already exists.",
        );
        // A failure that is NOT a uniqueness clash must not be relabelled as
        // one — that would send the user renaming something to fix a broken
        // write. (The match is on the word UNIQUE, so a table with a SECOND
        // unique constraint would answer in the wrong words; the only caller,
        // `db::folders`, has one besides its uuid primary key. Anything that
        // adopts this helper on a table with two must not rely on the label.)
        let err = execute_unique(
            &c,
            "INSERT INTO t(id, name, n) VALUES (?1, ?2, ?3)",
            params!["c", "Gamma", rusqlite::types::Null],
            || "A folder named \"Gamma\" already exists.".to_string(),
        )
        .unwrap_err();
        assert!(!err.contains("already exists"), "{err}");
    }
}
