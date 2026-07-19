use super::*;

/// Read one value from the `meta` table (format/version/room name).
pub fn get_meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .ok()
}

/// A2: UPSERT one value into the `meta` table — COMMANDS uses this to stamp
/// things like the embedding model/dim after a backfill.
/// CONTRACT-NOTE: `get_meta` above already existed with the exact A2 signature,
/// so only `set_meta` is new here.
pub fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    execute_one(
        conn,
        "INSERT INTO meta(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_meta_upserts_and_reads_back() {
        // A2: set_meta writes, get_meta reads, a second write replaces in place.
        let conn = mem();
        assert_eq!(get_meta(&conn, "embed_model"), None);
        set_meta(&conn, "embed_model", "nomic-embed-text").unwrap();
        assert_eq!(get_meta(&conn, "embed_model").as_deref(), Some("nomic-embed-text"));
        set_meta(&conn, "embed_model", "other").unwrap();
        assert_eq!(get_meta(&conn, "embed_model").as_deref(), Some("other"));
        // UPSERT never duplicates the key.
        let n: i64 = conn
            .query_row("SELECT count(*) FROM meta WHERE key = 'embed_model'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }
}
