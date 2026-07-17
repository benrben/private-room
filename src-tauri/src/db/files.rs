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
    execute_one(
        conn,
        "INSERT INTO files(id, name, mime_type, size_bytes, source, original_bytes, extracted_text)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, name, mime, bytes.len() as i64, source, bytes, text],
    )?;
    insert_chunks(conn, &id, text)?;
    get_file_meta(conn, &id)
}

/// List every file's metadata, newest first.
pub fn list_files(conn: &Connection) -> Result<Vec<FileMeta>, String> {
    query_rows(
        conn,
        &format!("SELECT {FILE_META_COLS} FROM files f ORDER BY f.created_at DESC, f.rowid DESC"),
        [],
        file_meta_row,
    )
}

/// (display name, mime type, size, one-liner) for every file — feeds the
/// agent's list_room_files tool. ADD-16: files inside a folder read as
/// "Folder/name". CHG-23: the cached ai_summary rides along so the tool can show
/// what each file is without a search round-trip.
/// (display name, mime, size bytes, cached one-liner) for one file row.
pub type FileBriefRow = (String, String, i64, Option<String>);

pub fn list_files_brief(conn: &Connection) -> Result<Vec<FileBriefRow>, String> {
    query_rows(
        conn,
        "SELECT CASE WHEN fo.name IS NOT NULL THEN fo.name || '/' || f.name ELSE f.name END,
                coalesce(f.mime_type,''), f.size_bytes, f.ai_summary
         FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
         ORDER BY f.created_at",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
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
    query_rows(
        conn,
        "SELECT CASE WHEN fo.name IS NOT NULL THEN fo.name || '/' || f.name ELSE f.name END,
                coalesce(f.mime_type, ''), f.ai_summary
         FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
         ORDER BY f.created_at DESC, f.rowid DESC LIMIT 101",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
}

/// ADD-17: one file's fields needed to build the room summary. `text` is a
/// ~1500-char probe (clipped in SQL) used to detect empty extractions — the
/// summarizer loads the full text separately per file (ADD-27), so the listing
/// stays cheap. `ai_summary` is the cached one-liner (None → still needs
/// summarizing). `folder` is the owning folder's name.
#[derive(Clone)]
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
    query_rows(
        conn,
        "SELECT f.id, f.name, coalesce(f.mime_type,''), f.source, fo.name,
                substr(f.extracted_text, 1, 1500), f.ai_summary
         FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
         ORDER BY (fo.name IS NULL), fo.name COLLATE NOCASE, f.created_at ASC",
        [],
        |r| {
            Ok(SummaryFile {
                id: r.get(0)?,
                name: r.get(1)?,
                mime: r.get(2)?,
                source: r.get(3)?,
                folder: r.get(4)?,
                text: r.get(5)?,
                ai_summary: r.get(6)?,
            })
        },
    )
}

/// ADD-17: cache a file's generated one-liner so re-runs skip it.
pub fn set_file_ai_summary(conn: &Connection, id: &str, summary: &str) -> Result<(), String> {
    execute_one(
        conn,
        "UPDATE files SET ai_summary = ?2 WHERE id = ?1",
        params![id, summary],
    )
}

/// CHG-22: files that still need a cached one-liner — (id, name, mime, ~1500-
/// char text probe; the filler loads each file's full text one at a time,
/// ADD-27). Skips images with no OCR (empty text) and the app's own generated
/// summary file. Feeds the background one-liner filler so the work is done at
/// ingest, not on the interactive Summarize-room path.
pub fn files_missing_summary(
    conn: &Connection,
    limit: usize,
) -> Result<Vec<(String, String, String, String)>, String> {
    query_rows(
        conn,
        "SELECT id, name, coalesce(mime_type,''), substr(extracted_text, 1, 1500)
         FROM files
         WHERE ai_summary IS NULL
           AND extracted_text IS NOT NULL AND trim(extracted_text) <> ''
           AND NOT (name IN ('Room summary.md', 'Room summary.html') AND source = 'generated')
         ORDER BY created_at DESC
         LIMIT ?1",
        [limit as i64],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
}

/// Full metadata row for one file by id.
pub fn get_file_meta(conn: &Connection, id: &str) -> Result<FileMeta, String> {
    query_one(
        conn,
        &format!("SELECT {FILE_META_COLS} FROM files f WHERE f.id = ?1"),
        [id],
        file_meta_row,
    )
}

/// Just a file's name.
pub fn get_file_name(conn: &Connection, id: &str) -> Result<String, String> {
    query_one(conn, "SELECT name FROM files WHERE id = ?1", [id], |r| {
        r.get(0)
    })
}

/// (name, mime type, bytes, extracted text) — the full payload needed to
/// serve or attach a file's content.
pub fn get_file_full(
    conn: &Connection,
    id: &str,
) -> Result<(String, Option<String>, Option<Vec<u8>>, Option<String>), String> {
    query_one(
        conn,
        "SELECT name, mime_type, original_bytes, extracted_text FROM files WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
}

/// (name, bytes) for one file.
pub fn get_file_bytes_named(
    conn: &Connection,
    id: &str,
) -> Result<(String, Option<Vec<u8>>), String> {
    query_one(
        conn,
        "SELECT name, original_bytes FROM files WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
}

/// A file's stored bytes.
pub fn get_file_bytes(conn: &Connection, id: &str) -> Result<Option<Vec<u8>>, String> {
    query_one(
        conn,
        "SELECT original_bytes FROM files WHERE id = ?1",
        [id],
        |r| r.get::<_, Option<Vec<u8>>>(0),
    )
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
    execute_one(
        conn,
        "UPDATE files SET original_bytes = ?2, extracted_text = ?3, size_bytes = ?4,
             ai_summary = NULL
         WHERE id = ?1",
        params![id, bytes, text, bytes.len() as i64],
    )?;
    execute_one(conn, "DELETE FROM chunks WHERE file_id = ?1", [id])?;
    insert_chunks(conn, id, text)
}

/// Update ONLY a file's extracted text (and its search index), leaving the
/// stored bytes alone — a live recording's periodic saves refresh the
/// transcript while the audio goes through the cheap checkpoint path.
pub fn set_file_extracted_text(conn: &Connection, id: &str, text: &str) -> Result<(), String> {
    execute_one(
        conn,
        "UPDATE files SET extracted_text = ?2, ai_summary = NULL WHERE id = ?1",
        params![id, text],
    )?;
    execute_one(conn, "DELETE FROM chunks WHERE file_id = ?1", [id])?;
    insert_chunks(conn, id, Some(text))
}

pub fn delete_file(conn: &Connection, id: &str) -> Result<(), String> {
    execute_one(conn, "DELETE FROM files WHERE id = ?1", [id])
}

pub fn rename_file(conn: &Connection, id: &str, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("File name cannot be empty.".into());
    }
    // Not `execute_one`: the affected-row count IS the answer here — zero rows
    // means the file was deleted out from under the rename.
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
    query_rows(
        conn,
        "SELECT id, name, coalesce(mime_type,''), original_bytes FROM files
         WHERE (extracted_text IS NULL OR trim(extracted_text) = '')
           AND original_bytes IS NOT NULL",
        [],
        |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get::<_, Option<Vec<u8>>>(3)?.unwrap_or_default(),
            ))
        },
    )
}

/// The one query behind all the fuzzy name finders: the NEWEST file whose
/// name contains `needle` (expected already lowercased). They differ only in
/// the columns they pull, whether the search is restricted to images, and
/// whether the app's OWN generated derivative outputs are excluded, so the
/// LIKE/ORDER BY/LIMIT shape lives here once. `cols`, `images_only` and
/// `exclude_derived` are caller-supplied constants — `needle` stays a bound
/// parameter.
///
/// `exclude_derived` hides the app's generated "Full pass — …" and "Room
/// summary" artifacts. Without it, a re-run resolves to the PREVIOUS output:
/// a "Full pass — clean-code.pdf.html" both contains the source's name AND is
/// newer than it, so `ORDER BY created_at DESC` returns the summary instead of
/// the book, and the pass re-summarizes its own tiny output.
fn find_newest_named<T, F>(
    conn: &Connection,
    cols: &str,
    needle: &str,
    images_only: bool,
    exclude_derived: bool,
    map: F,
) -> Result<T, String>
where
    F: FnOnce(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
{
    let image_filter = if images_only {
        "AND mime_type LIKE 'image/%'"
    } else {
        ""
    };
    // Same guard shape as `list_files_for_summary` — a generated artifact is
    // excluded; a user upload that happens to share the name is not.
    let derived_filter = if exclude_derived {
        "AND NOT (source = 'generated' \
           AND (name LIKE 'Full pass — %' OR name LIKE 'Room summary%'))"
    } else {
        ""
    };
    query_one(
        conn,
        &format!(
            "SELECT {cols} FROM files
             WHERE lower(name) LIKE '%' || ?1 || '%'
               {image_filter}
               {derived_filter}
             ORDER BY created_at DESC LIMIT 1"
        ),
        [needle],
        map,
    )
}

pub fn find_file_like(conn: &Connection, fragment: &str) -> Result<(String, String), String> {
    let needle = fragment.to_lowercase();
    find_newest_named(conn, "id, name", &needle, false, false, |r| {
        Ok((r.get(0)?, r.get(1)?))
    })
    .map_err(|_| format!("No file matching \"{fragment}\" in this room.{}", file_names_hint(conn)))
}

/// Like `find_file_like`, but excludes the app's own generated "Full pass — …"
/// and "Room summary" outputs — used to resolve the SOURCE file for a whole-file
/// pass so a re-run never picks the previous run's (newer, name-matching) result.
pub fn find_source_file_like(
    conn: &Connection,
    fragment: &str,
) -> Result<(String, String), String> {
    let needle = fragment.to_lowercase();
    find_newest_named(conn, "id, name", &needle, false, true, |r| {
        Ok((r.get(0)?, r.get(1)?))
    })
    .map_err(|_| format!("No source file matching \"{fragment}\" in this room.{}", file_names_hint(conn)))
}

/// Same fuzzy match as `find_file_like`, also returning extracted text —
/// used by the agent's open_file tool. Unlike `find_file_like`, the caller
/// is expected to have already lowercased `needle` (and reuses it verbatim
/// in its own error message), so this does no lowercasing of its own.
pub fn find_file_like_full(
    conn: &Connection,
    needle: &str,
) -> Result<(String, String, Option<String>), String> {
    find_newest_named(conn, "id, name, extracted_text", needle, false, false, |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
    })
    .map_err(|_| format!("No file matching \"{needle}\" in this room.{}", file_names_hint(conn)))
}

/// Fuzzy match restricted to images — used by the agent's mark_image tool.
/// Like `find_file_like_full`, expects an already-lowercased `needle`.
pub fn find_image_like(
    conn: &Connection,
    needle: &str,
) -> Result<(String, String, Vec<u8>), String> {
    find_newest_named(conn, "id, name, original_bytes", needle, true, false, |r| {
        Ok((
            r.get(0)?,
            r.get(1)?,
            r.get::<_, Option<Vec<u8>>>(2)?.unwrap_or_default(),
        ))
    })
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
    query_rows(
        conn,
        "SELECT f.name, c.text, bm25(chunks_fts)
         FROM chunks_fts
         JOIN chunks c ON c.rowid = chunks_fts.rowid
         JOIN files f ON f.id = c.file_id
         WHERE chunks_fts MATCH ?1
         ORDER BY bm25(chunks_fts)
         LIMIT ?2",
        params![match_expr, limit as i64],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
}

/// ADD-6: file rows whose name contains `needle` (already lowercased).
pub fn files_name_like(conn: &Connection, needle: &str) -> Result<Vec<(String, String)>, String> {
    query_rows(
        conn,
        "SELECT id, name FROM files WHERE lower(name) LIKE '%' || ?1 || '%'
         ORDER BY created_at DESC LIMIT 20",
        [needle],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
}

/// ADD-6: file content hits via FTS — (file id, name, matching chunk text) for
/// the best-ranked chunk. The caller trims a snippet out of the chunk text.
pub fn files_content_fts(
    conn: &Connection,
    match_expr: &str,
    limit: usize,
) -> Result<Vec<(String, String, String)>, String> {
    query_rows(
        conn,
        "SELECT f.id, f.name, c.text
         FROM chunks_fts
         JOIN chunks c ON c.rowid = chunks_fts.rowid
         JOIN files f ON f.id = c.file_id
         WHERE chunks_fts MATCH ?1
         ORDER BY bm25(chunks_fts)
         LIMIT ?2",
        params![match_expr, limit as i64],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fts_index_finds_and_stays_in_sync() {
        let conn = mem();
        let id = add_file(&conn, "lease.txt", "The tenant pays rent on the first of each month.");
        let hits = search_chunks_fts(&conn, "\"rent\"", 5).unwrap();
        assert_eq!(hits.len(), 1, "inserted chunk is searchable via the FTS index");
        assert_eq!(hits[0].0, "lease.txt");
        update_file_content(&conn, &id, b"The landlord provides parking spaces.", Some("The landlord provides parking spaces.")).unwrap();
        assert!(
            search_chunks_fts(&conn, "\"rent\"", 5).unwrap().is_empty(),
            "update fires the triggers: old terms drop out of the FTS index"
        );
        assert_eq!(search_chunks_fts(&conn, "\"parking\"", 5).unwrap().len(), 1, "new terms appear");
        delete_file(&conn, &id).unwrap();
        assert!(
            search_chunks_fts(&conn, "\"parking\"", 5).unwrap().is_empty(),
            "delete removes the file's text from the FTS index"
        );
    }

    #[test]
    fn summary_filler_skips_generated_summary_files() {
        let conn = mem();
        // Both the current HTML name and the legacy Markdown name are excluded
        // when generated by the app itself.
        insert_file(&conn, "Room summary.html", "text/html", b"<h1>s</h1>", Some("<h1>s</h1>"), "generated").unwrap();
        insert_file(&conn, "Room summary.md", "text/markdown", b"# s", Some("# s"), "generated").unwrap();
        // A user-uploaded file that happens to share the name still gets a one-liner.
        let uploaded = add_file(&conn, "Room summary.html", "my own notes");
        let ids: Vec<String> = files_missing_summary(&conn, 10)
            .unwrap()
            .into_iter()
            .map(|(id, ..)| id)
            .collect();
        assert_eq!(ids, vec![uploaded]);
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

    #[test]
    fn fuzzy_finders_share_a_core_but_keep_their_own_columns_and_filter() {
        let conn = mem();
        let id = add_file(&conn, "lease-draft.txt", "rent is due monthly");
        // Same match, three column shapes. find_file_like lowercases for itself.
        assert_eq!(find_file_like(&conn, "LEASE").unwrap(), (id.clone(), "lease-draft.txt".into()));
        let (full_id, name, text) = find_file_like_full(&conn, "lease").unwrap();
        assert_eq!((full_id, name), (id, "lease-draft.txt".to_string()));
        assert_eq!(text.as_deref(), Some("rent is due monthly"));
        // The image-only variant does not see the text file at all...
        assert!(find_image_like(&conn, "lease").is_err());
        // ...but finds an image of the same name, bytes and all.
        insert_file(&conn, "lease-photo.png", "image/png", b"\x89PNG", None, "upload").unwrap();
        let (_, img_name, bytes) = find_image_like(&conn, "lease").unwrap();
        assert_eq!(img_name, "lease-photo.png");
        assert_eq!(bytes, b"\x89PNG");
        // A miss still carries each caller's own wording.
        assert!(find_file_like(&conn, "nope").unwrap_err().starts_with("No file matching \"nope\""));
        assert!(find_image_like(&conn, "nope").unwrap_err().starts_with("No image matching \"nope\""));
    }

    #[test]
    fn a_pass_resolves_the_source_file_not_its_own_generated_output() {
        let conn = mem();
        // The source book…
        let src = add_file(&conn, "clean-code.pdf", "the whole book text");
        // …and the app's own generated full-pass output: its name CONTAINS the
        // source's name, and it is newer (a later created_at). This is exactly the
        // pair a re-run sees. created_at is second-resolution, so pin it explicitly
        // instead of racing the clock.
        insert_file(&conn, "Full pass — clean-code.pdf.html", "text/html",
                    b"<h1>summary</h1>", Some("<h1>summary</h1>"), "generated").unwrap();
        conn.execute(
            "UPDATE files SET created_at = '2999-01-01T00:00:00Z' \
             WHERE name = 'Full pass — clean-code.pdf.html'",
            [],
        ).unwrap();

        // The bug: the plain finder returns the NEWER, name-matching generated output.
        assert_eq!(
            find_file_like(&conn, "clean-code").unwrap().1,
            "Full pass — clean-code.pdf.html"
        );
        // The fix: the source resolver skips generated derivatives, returns the book.
        assert_eq!(
            find_source_file_like(&conn, "clean-code").unwrap(),
            (src, "clean-code.pdf".into())
        );

        // A generated "Room summary" is likewise skipped in favour of an upload.
        let conn2 = mem();
        let notes = add_file(&conn2, "summary-notes.txt", "notes");
        insert_file(&conn2, "Room summary.html", "text/html", b"x", Some("x"), "generated").unwrap();
        conn2.execute(
            "UPDATE files SET created_at = '2999-01-01T00:00:00Z' WHERE source = 'generated'",
            [],
        ).unwrap();
        assert_eq!(
            find_source_file_like(&conn2, "summary").unwrap(),
            (notes, "summary-notes.txt".into())
        );

        // With ONLY a generated artifact present, the source resolver reports a
        // miss rather than falling back to summarizing the derivative.
        let only_gen = mem();
        insert_file(&only_gen, "Full pass — report.pdf.html", "text/html", b"x", Some("x"), "generated").unwrap();
        let err = find_source_file_like(&only_gen, "report").unwrap_err();
        assert!(err.starts_with("No source file matching \"report\""), "got: {err}");
    }
}
