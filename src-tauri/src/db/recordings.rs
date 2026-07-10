use super::*;

// ADD-27: per-file recording metadata (segments with word timings, speakers,
// cut list) as one JSON blob keyed by file id. The row's EXISTENCE is also
// the marker that turns a plain audio file into a "recording" in the viewer.
// The transcript itself is NOT here — it stays in files.extracted_text where
// search, RAG and every AI action already find it.

pub fn set_rec_meta(conn: &Connection, file_id: &str, meta_json: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO recordings(file_id, meta) VALUES (?1, ?2)
         ON CONFLICT(file_id) DO UPDATE SET meta = excluded.meta",
        params![file_id, meta_json],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub fn get_rec_meta(conn: &Connection, file_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT meta FROM recordings WHERE file_id = ?1",
        [file_id],
        |r| r.get(0),
    )
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rec_meta_roundtrip_upsert_and_cascade() {
        let conn = mem();
        let id = add_file(&conn, "call.wav", "(live recording)");
        assert!(get_rec_meta(&conn, &id).is_none());
        set_rec_meta(&conn, &id, r#"{"version":1}"#).unwrap();
        assert_eq!(get_rec_meta(&conn, &id).as_deref(), Some(r#"{"version":1}"#));
        set_rec_meta(&conn, &id, r#"{"version":2}"#).unwrap();
        assert_eq!(get_rec_meta(&conn, &id).as_deref(), Some(r#"{"version":2}"#));
        // Deleting the file takes the meta row with it (ON DELETE CASCADE).
        delete_file(&conn, &id).unwrap();
        assert!(get_rec_meta(&conn, &id).is_none());
    }
}
