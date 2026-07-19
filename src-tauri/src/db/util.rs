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
