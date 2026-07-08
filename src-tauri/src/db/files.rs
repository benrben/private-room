use super::*;

/// Insert a new file row (plus its search-index chunks) and return its metadata.
pub fn insert_file(
    conn: &Connection,
    name: &str,
    mime: &str,
    bytes: &[u8],
    text: Option<&str>,
    source: &str,
) -> Result<FileMeta, String> {
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO files(id, name, mime_type, size_bytes, source, original_bytes, extracted_text)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, name, mime, bytes.len() as i64, source, bytes, text],
    )
    .map_err(|e| e.to_string())?;
    insert_chunks(conn, &id, text)?;
    get_file_meta(conn, &id)
}

/// List every file's metadata, newest first.
pub fn list_files(conn: &Connection) -> Result<Vec<FileMeta>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {FILE_META_COLS} FROM files f ORDER BY f.created_at DESC, f.rowid DESC"
        ))
        .map_err(|e| e.to_string())?;
    let files = stmt
        .query_map([], file_meta_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(files)
}

/// (display name, mime type, size, one-liner) for every file — feeds the
/// agent's list_room_files tool. ADD-16: files inside a folder read as
/// "Folder/name". CHG-23: the cached ai_summary rides along so the tool can show
/// what each file is without a search round-trip.
/// (display name, mime, size bytes, cached one-liner) for one file row.
pub type FileBriefRow = (String, String, i64, Option<String>);

pub fn list_files_brief(conn: &Connection) -> Result<Vec<FileBriefRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT CASE WHEN fo.name IS NOT NULL THEN fo.name || '/' || f.name ELSE f.name END,
                    coalesce(f.mime_type,''), f.size_bytes, f.ai_summary
             FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
             ORDER BY f.created_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// (display name, mime type, one-liner) for the 100 NEWEST files — feeds the
/// model's file inventory in the system prompt. CHG-9: newest-first (was oldest-
/// first, which hid exactly the files the user just added), and one extra row
/// (LIMIT 101) acts as an overflow sentinel so the caller can flag a partial
/// list without a second COUNT. CHG-23: cached ai_summary rides along.
/// ADD-16: folder-prefixed like list_files_brief.
pub fn list_file_inventory(
    conn: &Connection,
) -> Result<Vec<(String, String, Option<String>)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT CASE WHEN fo.name IS NOT NULL THEN fo.name || '/' || f.name ELSE f.name END,
                    coalesce(f.mime_type, ''), f.ai_summary
             FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
             ORDER BY f.created_at DESC, f.rowid DESC LIMIT 101",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// ADD-17: one file's fields needed to build the room summary. `text` is only
/// the first ~1500 chars (clipped in SQL). `ai_summary` is the cached one-liner
/// (None → still needs summarizing). `folder` is the owning folder's name.
pub struct SummaryFile {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub source: String,
    pub folder: Option<String>,
    pub text: Option<String>,
    pub ai_summary: Option<String>,
}

/// ADD-17: every file with the fields the summarizer needs, grouped by folder
/// (top-level files last) then creation order, so the file list reads sensibly.
pub fn list_files_for_summary(conn: &Connection) -> Result<Vec<SummaryFile>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT f.id, f.name, coalesce(f.mime_type,''), f.source, fo.name,
                    substr(f.extracted_text, 1, 1500), f.ai_summary
             FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
             ORDER BY (fo.name IS NULL), fo.name COLLATE NOCASE, f.created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(SummaryFile {
                id: r.get(0)?,
                name: r.get(1)?,
                mime: r.get(2)?,
                source: r.get(3)?,
                folder: r.get(4)?,
                text: r.get(5)?,
                ai_summary: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// ADD-17: cache a file's generated one-liner so re-runs skip it.
pub fn set_file_ai_summary(conn: &Connection, id: &str, summary: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE files SET ai_summary = ?2 WHERE id = ?1",
        params![id, summary],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// CHG-22: files that still need a cached one-liner — (id, name, mime, first
/// ~1500 chars of text). Skips images with no OCR (empty text) and the app's own
/// generated summary file. Feeds the background one-liner filler so the work is
/// done at ingest, not on the interactive Summarize-room path.
pub fn files_missing_summary(
    conn: &Connection,
    limit: usize,
) -> Result<Vec<(String, String, String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, coalesce(mime_type,''), substr(extracted_text, 1, 1500)
             FROM files
             WHERE ai_summary IS NULL
               AND extracted_text IS NOT NULL AND trim(extracted_text) <> ''
               AND NOT (name = 'Room summary.md' AND source = 'generated')
             ORDER BY created_at DESC
             LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit as i64], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Full metadata row for one file by id.
pub fn get_file_meta(conn: &Connection, id: &str) -> Result<FileMeta, String> {
    conn.query_row(
        &format!("SELECT {FILE_META_COLS} FROM files f WHERE f.id = ?1"),
        [id],
        file_meta_row,
    )
    .map_err(|e| e.to_string())
}

/// Just a file's name.
pub fn get_file_name(conn: &Connection, id: &str) -> Result<String, String> {
    conn.query_row("SELECT name FROM files WHERE id = ?1", [id], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// (name, mime type, bytes, extracted text) — the full payload needed to
/// serve or attach a file's content.
pub fn get_file_full(
    conn: &Connection,
    id: &str,
) -> Result<(String, Option<String>, Option<Vec<u8>>, Option<String>), String> {
    conn.query_row(
        "SELECT name, mime_type, original_bytes, extracted_text FROM files WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
    .map_err(|e| e.to_string())
}

/// (name, bytes) for one file.
pub fn get_file_bytes_named(
    conn: &Connection,
    id: &str,
) -> Result<(String, Option<Vec<u8>>), String> {
    conn.query_row(
        "SELECT name, original_bytes FROM files WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map_err(|e| e.to_string())
}

/// A file's stored bytes.
pub fn get_file_bytes(conn: &Connection, id: &str) -> Result<Option<Vec<u8>>, String> {
    conn.query_row(
        "SELECT original_bytes FROM files WHERE id = ?1",
        [id],
        |r| r.get::<_, Option<Vec<u8>>>(0),
    )
    .map_err(|e| e.to_string())
}

/// A file's extracted search text, if any. Missing row or missing text both
/// read as `None` — mirrors the original call site's error-swallowing.
pub fn get_file_extracted_text(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row(
        "SELECT extracted_text FROM files WHERE id = ?1",
        [id],
        |r| r.get(0),
    )
    .ok()
    .flatten()
}

/// Overwrite a file's bytes and rebuild its search index.
pub fn update_file_content(
    conn: &Connection,
    id: &str,
    bytes: &[u8],
    text: Option<&str>,
) -> Result<(), String> {
    // ADD-17: content changed, so the cached one-liner is stale — clear it so
    // the next "Summarize room" run re-summarizes this file.
    conn.execute(
        "UPDATE files SET original_bytes = ?2, extracted_text = ?3, size_bytes = ?4,
             ai_summary = NULL
         WHERE id = ?1",
        params![id, bytes, text, bytes.len() as i64],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM chunks WHERE file_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    insert_chunks(conn, id, text)
}

pub fn delete_file(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM files WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn rename_file(conn: &Connection, id: &str, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("File name cannot be empty.".into());
    }
    let n = conn
        .execute("UPDATE files SET name = ?2 WHERE id = ?1", params![id, name])
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("That file is no longer in this room.".into());
    }
    Ok(())
}

/// Files that carry no extracted text yet — candidates for a re-extraction
/// pass after an extractor is improved (e.g. the xlsx numeric-cell fix). Only
/// files with stored bytes are returned; OCR/STT candidates are left to their
/// own background workers. Returns (id, name, mime, original_bytes).
pub fn files_missing_text(
    conn: &Connection,
) -> Result<Vec<(String, String, String, Vec<u8>)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, coalesce(mime_type,''), original_bytes FROM files
             WHERE (extracted_text IS NULL OR trim(extracted_text) = '')
               AND original_bytes IS NOT NULL",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get::<_, Option<Vec<u8>>>(3)?.unwrap_or_default(),
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn find_file_like(conn: &Connection, fragment: &str) -> Result<(String, String), String> {
    let needle = fragment.to_lowercase();
    conn.query_row(
        "SELECT id, name FROM files WHERE lower(name) LIKE '%' || ?1 || '%'
         ORDER BY created_at DESC LIMIT 1",
        [&needle],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map_err(|_| format!("No file matching \"{fragment}\" in this room.{}", file_names_hint(conn)))
}

/// Same fuzzy match as `find_file_like`, also returning extracted text —
/// used by the agent's open_file tool. Unlike `find_file_like`, the caller
/// is expected to have already lowercased `needle` (and reuses it verbatim
/// in its own error message), so this does no lowercasing of its own.
pub fn find_file_like_full(
    conn: &Connection,
    needle: &str,
) -> Result<(String, String, Option<String>), String> {
    conn.query_row(
        "SELECT id, name, extracted_text FROM files
         WHERE lower(name) LIKE '%' || ?1 || '%'
         ORDER BY created_at DESC LIMIT 1",
        [needle],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .map_err(|_| format!("No file matching \"{needle}\" in this room.{}", file_names_hint(conn)))
}

/// Fuzzy match restricted to images — used by the agent's mark_image tool.
/// Like `find_file_like_full`, expects an already-lowercased `needle`.
pub fn find_image_like(
    conn: &Connection,
    needle: &str,
) -> Result<(String, String, Vec<u8>), String> {
    conn.query_row(
        "SELECT id, name, original_bytes FROM files
         WHERE lower(name) LIKE '%' || ?1 || '%'
           AND mime_type LIKE 'image/%'
         ORDER BY created_at DESC LIMIT 1",
        [needle],
        |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get::<_, Option<Vec<u8>>>(2)?.unwrap_or_default(),
            ))
        },
    )
    .map_err(|_| format!("No image matching \"{needle}\" in this room."))
}

/// HLT-3: rank chunks by an FTS5 MATCH query, best (lowest bm25) first.
/// Returns (file name, chunk text, bm25 score) — smaller score = better match.
/// `match_expr` is a ready-built FTS5 query (e.g. `"foo" OR "bar"`).
pub fn search_chunks_fts(
    conn: &Connection,
    match_expr: &str,
    limit: usize,
) -> Result<Vec<(String, String, f64)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT f.name, c.text, bm25(chunks_fts)
             FROM chunks_fts
             JOIN chunks c ON c.rowid = chunks_fts.rowid
             JOIN files f ON f.id = c.file_id
             WHERE chunks_fts MATCH ?1
             ORDER BY bm25(chunks_fts)
             LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![match_expr, limit as i64], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// ADD-6: file rows whose name contains `needle` (already lowercased).
pub fn files_name_like(conn: &Connection, needle: &str) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name FROM files WHERE lower(name) LIKE '%' || ?1 || '%'
             ORDER BY created_at DESC LIMIT 20",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([needle], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// ADD-6: file content hits via FTS — (file id, name, matching chunk text) for
/// the best-ranked chunk. The caller trims a snippet out of the chunk text.
pub fn files_content_fts(
    conn: &Connection,
    match_expr: &str,
    limit: usize,
) -> Result<Vec<(String, String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT f.id, f.name, c.text
             FROM chunks_fts
             JOIN chunks c ON c.rowid = chunks_fts.rowid
             JOIN files f ON f.id = c.file_id
             WHERE chunks_fts MATCH ?1
             ORDER BY bm25(chunks_fts)
             LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![match_expr, limit as i64], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fts_index_finds_and_stays_in_sync() {
        let conn = mem();
        let id = add_file(&conn, "lease.txt", "The tenant pays rent on the first of each month.");
        // Inserted chunks are searchable via the FTS index.
        let hits = search_chunks_fts(&conn, "\"rent\"", 5).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, "lease.txt");
        // Update path: old terms drop out, new terms appear (triggers fired).
        update_file_content(&conn, &id, b"The landlord provides parking spaces.", Some("The landlord provides parking spaces.")).unwrap();
        assert!(search_chunks_fts(&conn, "\"rent\"", 5).unwrap().is_empty());
        assert_eq!(search_chunks_fts(&conn, "\"parking\"", 5).unwrap().len(), 1);
        // Delete path: the file's text no longer surfaces.
        delete_file(&conn, &id).unwrap();
        assert!(search_chunks_fts(&conn, "\"parking\"", 5).unwrap().is_empty());
    }

    #[test]
    fn inventory_shows_folder_prefix() {
        let conn = mem();
        let folder = create_folder(&conn, "Contracts").unwrap();
        let f = add_file(&conn, "lease.pdf", "x");
        add_file(&conn, "loose.txt", "y");
        move_file_to_folder(&conn, &f, Some(&folder.id)).unwrap();
        let names: Vec<String> = list_file_inventory(&conn).unwrap().into_iter().map(|(n, _, _)| n).collect();
        assert!(names.contains(&"Contracts/lease.pdf".to_string()));
        assert!(names.contains(&"loose.txt".to_string()));
    }
}
