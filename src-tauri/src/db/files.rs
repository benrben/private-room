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
    insert_file_from_url(conn, name, mime, bytes, text, source, None)
}

/// Run `body` inside a transaction — unless the caller already opened one
/// (the batch-edit path in `commands::edit_match` wraps several writes of its
/// own, and SQLite has no nested `BEGIN`).
///
/// Two things ride on this. A file row and its search chunks must land
/// TOGETHER: written separately, a failure partway through indexing reported
/// the import as failed while leaving the file in the library, only partly
/// searchable and with nothing marking it. And a book-length file produces
/// thousands of chunk INSERTs, each its own commit and its own disk write —
/// one transaction turns that back into one.
pub(crate) fn in_transaction<T>(
    conn: &Connection,
    body: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if !conn.is_autocommit() {
        return body();
    }
    conn.execute_batch("BEGIN IMMEDIATE").map_err(|e| e.to_string())?;
    match body() {
        Ok(v) => {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            Ok(v)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// BROWSE-2 (D19): like [`insert_file`], recording where the bytes came from.
/// Every file that arrived over the network keeps its source URL.
pub fn insert_file_from_url(
    conn: &Connection,
    name: &str,
    mime: &str,
    bytes: &[u8],
    text: Option<&str>,
    source: &str,
    origin_url: Option<&str>,
) -> Result<FileMeta, String> {
    let id = Uuid::new_v4().to_string();
    in_transaction(conn, || {
        execute_one(
            conn,
            "INSERT INTO files(id, name, mime_type, size_bytes, source, original_bytes, extracted_text, origin_url)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, name, mime, bytes.len() as i64, source, bytes, text, origin_url],
        )?;
        insert_chunks(conn, &id, text)
    })?;
    get_file_meta(conn, &id)
}

/// The id and name of a file already holding EXACTLY these bytes, if any.
/// `size_bytes` is checked first so the blob comparison only ever runs against
/// same-sized rows.
pub fn file_with_same_bytes(conn: &Connection, bytes: &[u8]) -> Option<(String, String)> {
    conn.query_row(
        "SELECT id, name FROM files
         WHERE trashed_at IS NULL AND size_bytes = ?1 AND original_bytes = ?2 LIMIT 1",
        params![bytes.len() as i64, bytes],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .ok()
}

/// List every file's metadata, newest first.
pub fn list_files(conn: &Connection) -> Result<Vec<FileMeta>, String> {
    query_rows(
        conn,
        &format!(
            "SELECT {FILE_META_COLS} FROM files f WHERE {NOT_TRASHED} \
             ORDER BY f.created_at DESC, f.rowid DESC"
        ),
        [],
        file_meta_row,
    )
}

/// How many files are in this room — the ONE definition every count surface
/// uses (the status bar, the Library badge, `room_counts`, the front page).
///
/// "In this room" means exactly what [`list_files`] lists, which is why this
/// carries the same `NOT_TRASHED` clause and nothing else. A count is a claim
/// about the same population the list shows, so the two must be derived from
/// one predicate or they drift: before this existed, the counts were a bare
/// `count(*) FROM files` and trash landed with the listings filtered but the
/// counts not, so a room whose files had all been deleted still reported them
/// as present.
///
/// Nothing is excluded by KIND. A saved browser page, a download, a recording
/// and a generated artifact are all things the user put in (or made in) this
/// room, and a count that quietly skipped them would be answering a different
/// question than the one the badge is asking (owner's ruling, 2026-08-03).
pub fn room_file_count(conn: &Connection) -> Result<i64, String> {
    query_one(
        conn,
        &format!("SELECT count(*) FROM files f WHERE {NOT_TRASHED}"),
        [],
        |r| r.get(0),
    )
}

/// How many files ARRIVED since `since` — the workflow condition
/// `new_files_since_last_run`.
///
/// Deliberately NOT [`room_file_count`] with a date on it: `source = 'generated'`
/// is excluded because a workflow that writes a file into the room would
/// otherwise see its own output as new work and run again forever. That
/// exclusion is about causation, not about what the room contains, which is why
/// this is a second named question rather than an argument to the first.
///
/// It does share the trash clause. "Three new files" for three files the user
/// imported and then deleted is a claim about work that is not there — the run
/// it starts would find nothing to act on.
pub fn new_source_file_count(conn: &Connection, since: &str) -> Result<i64, String> {
    query_one(
        conn,
        &format!(
            "SELECT count(*) FROM files f
             WHERE f.source != 'generated' AND f.created_at > ?1 AND {NOT_TRASHED}"
        ),
        [since],
        |r| r.get(0),
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
         WHERE f.trashed_at IS NULL
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
         WHERE f.trashed_at IS NULL
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
         WHERE f.trashed_at IS NULL
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

/// Room map: record that `id` was MADE from `source_file_id`. Written by the
/// generators that actually know their input (a full pass, a translated
/// transcript) — a post-insert setter rather than another `insert_file`
/// parameter, so the 58 existing insert call sites stay untouched.
///
/// Self-reference is refused: a file cannot be made from itself, and a
/// self-loop would draw as a link the map can't explain.
pub fn set_derived_from(conn: &Connection, id: &str, source_file_id: &str) -> Result<(), String> {
    if id == source_file_id {
        return Ok(());
    }
    execute_one(
        conn,
        "UPDATE files SET derived_from = ?2 WHERE id = ?1",
        params![id, source_file_id],
    )
}

/// Room map: every recorded (source file, derived file) pair. Both ends are
/// checked to still exist, so a link never points at a deleted file — the
/// column carries no foreign key (it was added by ALTER, which cannot).
/// Trash counts as gone at BOTH ends: the map draws only what is in the room,
/// and an edge to a node the map isn't drawing is a line into nowhere.
pub fn derived_links(conn: &Connection) -> Result<Vec<(String, String)>, String> {
    query_rows(
        conn,
        "SELECT src.id, f.id FROM files f JOIN files src ON src.id = f.derived_from
         WHERE f.derived_from IS NOT NULL
           AND f.trashed_at IS NULL AND src.trashed_at IS NULL",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
}

/// Store what a probe read from a video's container (`media_probe::MediaMeta`
/// as JSON). Only ever called with a probe that found SOMETHING: a probe that
/// read nothing leaves the column NULL, so "not probed yet" and "probed, all
/// unknown" stay distinguishable.
pub fn set_media_meta(conn: &Connection, id: &str, json: &str) -> Result<(), String> {
    execute_one(
        conn,
        "UPDATE files SET media_meta = ?2 WHERE id = ?1",
        params![id, json],
    )
}

/// A file's stored technical metadata, or None when it has never been probed.
/// A missing row reads as None too — the caller's next step is to probe.
///
/// Trashed reads as None for the reason `get_file_meta` spells out: the viewer
/// asks `probe_video_meta` for exactly this by id, and without the clause a
/// deleted video still answered with its real duration, size and codec.
pub fn get_media_meta(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row(
        "SELECT media_meta FROM files WHERE id = ?1 AND trashed_at IS NULL",
        [id],
        |r| r.get(0),
    )
    .ok()
    .flatten()
}

/// Store what a saved web page declared about itself (`extraction::PageMeta` as
/// JSON). A post-insert setter for the same reason `set_derived_from` is one.
///
/// Only ever called with metadata that came off the page (plus the room's own
/// source URL and capture time). A page that declared nothing leaves the column
/// NULL, so "not from the web" and "from the web, said nothing about itself"
/// never collapse into one value.
pub fn set_web_meta(conn: &Connection, id: &str, json: &str) -> Result<(), String> {
    execute_one(conn, "UPDATE files SET web_meta = ?2 WHERE id = ?1", params![id, json])
}

/// What a saved page said about itself, or None when this file did not come
/// from one. A missing row reads as None too, and so does a trashed one — the
/// title, author, site and capture date of a page are the page, and handing
/// them back by id would repopulate the viewer's strip for a file the room is
/// no longer showing.
pub fn get_web_meta(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row(
        "SELECT web_meta FROM files WHERE id = ?1 AND trashed_at IS NULL",
        [id],
        |r| r.get(0),
    )
    .ok()
    .flatten()
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
         WHERE trashed_at IS NULL
           AND ai_summary IS NULL
           AND extracted_text IS NOT NULL AND trim(extracted_text) <> ''
           AND NOT (name IN ('Room summary.md', 'Room summary.html') AND source = 'generated')
         ORDER BY created_at DESC
         LIMIT ?1",
        [limit as i64],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
}

/// Wave 1b (idea 10): the NEWEST file whose name equals `name` exactly — any
/// source, so a user-made "Scratch pad.md" is adopted by the get-or-create
/// convention instead of being shadowed by a generated duplicate.
pub fn file_by_exact_name(conn: &Connection, name: &str) -> Result<Option<FileMeta>, String> {
    query_rows(
        conn,
        &format!(
            "SELECT {FILE_META_COLS} FROM files f WHERE f.name = ?1 AND {NOT_TRASHED} \
             ORDER BY f.created_at DESC, f.rowid DESC LIMIT 1"
        ),
        [name],
        file_meta_row,
    )
    .map(|rows| rows.into_iter().next())
}

/// Split a file name into its stem and its extension (with the dot), the same
/// way `roomai::unique_name` does — "a.txt" -> ("a", ".txt"), "noext" ->
/// ("noext", ""), ".hidden" -> (".hidden", "") since a leading dot is not an
/// extension.
fn split_ext(name: &str) -> (String, String) {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), format!(".{ext}")),
        _ => (name.to_string(), String::new()),
    }
}

/// `name`, or the first "stem (n).ext" no file in this room is using.
///
/// Generated output used to reuse one fixed name per source, so re-running a
/// studio simply added a SECOND "Flashcards - clean-code.html", then a third —
/// same name, same icon, different content, and no way to tell which was the run
/// you wanted. Live QA 2026-08-03 ended with three of those and several
/// identically named "Google News.md" saves, and called the result impossible to
/// identify. Disambiguating at the moment of writing is the fix a user already
/// understands, because it is what Finder does.
///
/// Compared case-insensitively: the library lists names, and two entries that
/// differ only in case read as the same duplicate to the person scanning it.
///
/// A TRASHED file does not hold its name: the library isn't showing it, so
/// stepping the next save to "notes (2).md" because of something the user
/// deleted last week would be numbering around a file they cannot see. Restore
/// can therefore bring back a name that is in use again — a duplicate name is
/// legal here (nothing is unique but `id`) and is the mild outcome; a restore
/// that renamed the user's file would be the surprising one.
pub fn available_name(conn: &Connection, name: &str) -> Result<String, String> {
    let taken: Vec<String> = query_rows(
        conn,
        "SELECT lower(name) FROM files \
         WHERE trashed_at IS NULL \
           AND (lower(name) = lower(?1) OR lower(name) LIKE lower(?2) ESCAPE '\\')",
        rusqlite::params![
            name,
            {
                let (stem, ext) = split_ext(name);
                // "stem (%)ext", with LIKE's own wildcards escaped so a name
                // containing % or _ still matches only itself.
                let esc = |s: &str| {
                    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
                };
                format!("{} (%){}", esc(&stem), esc(&ext))
            }
        ],
        |row| row.get::<_, String>(0),
    )?;
    if taken.is_empty() {
        return Ok(name.to_string());
    }
    let used: std::collections::HashSet<String> = taken.into_iter().collect();
    if !used.contains(&name.to_lowercase()) {
        return Ok(name.to_string());
    }
    let (stem, ext) = split_ext(name);
    let mut n = 2;
    loop {
        let candidate = format!("{stem} ({n}){ext}");
        if !used.contains(&candidate.to_lowercase()) {
            return Ok(candidate);
        }
        n += 1;
    }
}

/// Full metadata row for one file by id.
///
/// Trashed files are NOT found here, and that is deliberate even though the
/// caller already holds an id. Ids outlive the library: they sit in open tabs,
/// in a chat message's `sources`, in a paused job's plan, in an agent's own
/// notes. If a by-id read kept working after a delete, every one of those would
/// quietly resurrect the file — the viewer would render it, a job would summarize
/// it, a cloud turn would carry its text — with nothing on screen saying the
/// file was in the trash. A miss here reads as "no longer in this room", which
/// is what actually happened. The trash view has its own query
/// (`list_trashed_files`); restore takes the id and nothing else.
pub fn get_file_meta(conn: &Connection, id: &str) -> Result<FileMeta, String> {
    query_one(
        conn,
        &format!("SELECT {FILE_META_COLS} FROM files f WHERE f.id = ?1 AND {NOT_TRASHED}"),
        [id],
        file_meta_row,
    )
}

/// Just a file's name.
pub fn get_file_name(conn: &Connection, id: &str) -> Result<String, String> {
    query_one(
        conn,
        "SELECT name FROM files WHERE id = ?1 AND trashed_at IS NULL",
        [id],
        |r| r.get(0),
    )
}

/// Where this file came from, when it came over the network — `None` for
/// anything typed, imported from disk or generated in the room.
///
/// Read on export so a downloaded file keeps the `com.apple.quarantine` mark
/// macOS shows its Gatekeeper warning off (`safety::mark_as_downloaded`).
pub fn file_origin_url(conn: &Connection, id: &str) -> Option<String> {
    query_one::<Option<String>, _, _>(
        conn,
        "SELECT origin_url FROM files WHERE id = ?1 AND trashed_at IS NULL",
        [id],
        |r| r.get(0),
    )
    .ok()
    .flatten()
    .filter(|u| !u.trim().is_empty())
}

/// (name, mime type, bytes, extracted text) — the full payload needed to
/// serve or attach a file's content.
pub fn get_file_full(
    conn: &Connection,
    id: &str,
) -> Result<(String, Option<String>, Option<Vec<u8>>, Option<String>), String> {
    query_one(
        conn,
        "SELECT name, mime_type, original_bytes, extracted_text FROM files
         WHERE id = ?1 AND trashed_at IS NULL",
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
        "SELECT name, original_bytes FROM files WHERE id = ?1 AND trashed_at IS NULL",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
}

/// A file's stored bytes.
pub fn get_file_bytes(conn: &Connection, id: &str) -> Result<Option<Vec<u8>>, String> {
    query_one(
        conn,
        "SELECT original_bytes FROM files WHERE id = ?1 AND trashed_at IS NULL",
        [id],
        |r| r.get::<_, Option<Vec<u8>>>(0),
    )
}

/// A file's extracted search text, if any. Missing row or missing text both
/// read as `None` — mirrors the original call site's error-swallowing.
pub fn get_file_extracted_text(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row(
        "SELECT extracted_text FROM files WHERE id = ?1 AND trashed_at IS NULL",
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
    in_transaction(conn, || {
        // ADD-17: content changed, so the cached one-liner is stale — clear it
        // so the next "Summarize room" run re-summarizes this file.
        execute_one(
            conn,
            "UPDATE files SET original_bytes = ?2, extracted_text = ?3, size_bytes = ?4,
                 ai_summary = NULL
             WHERE id = ?1",
            params![id, bytes, text, bytes.len() as i64],
        )?;
        clear_chunks(conn, id)?;
        insert_chunks(conn, id, text)
    })
}

/// Update ONLY a file's extracted text (and its search index), leaving the
/// stored bytes alone — a live recording's periodic saves refresh the
/// transcript while the audio goes through the cheap checkpoint path.
pub fn set_file_extracted_text(conn: &Connection, id: &str, text: &str) -> Result<(), String> {
    in_transaction(conn, || {
        execute_one(
            conn,
            "UPDATE files SET extracted_text = ?2, ai_summary = NULL WHERE id = ?1",
            params![id, text],
        )?;
        clear_chunks(conn, id)?;
        insert_chunks(conn, id, Some(text))
    })
}

// ---------------------------------------------------------------- trash / undo

/// Who deleted a file. Recorded at the moment of deletion, because "what did
/// the agent delete" cannot be reconstructed afterwards — and with "ask before
/// AI edits files" off by owner decision, it is the question the trash exists
/// to answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrashActor<'a> {
    /// A person clicked delete.
    User,
    /// The AI deleted it on its own. Carries the agent/tool that did it, so the
    /// answer is "the Files agent's delete_file", not just "the AI".
    Agent(&'a str),
    /// The app's own housekeeping (e.g. dropping a superseded generated file).
    /// Carries the command responsible.
    App(&'a str),
}

impl TrashActor<'_> {
    /// (kind, id) as stored. The kind is a closed vocabulary the UI switches
    /// on; the id is free-form and may be absent. `pub(crate)`: `db::memories`
    /// (S9) reuses the same actor type for its own soft-delete.
    pub(crate) fn parts(&self) -> (&'static str, Option<&str>) {
        match self {
            TrashActor::User => ("user", None),
            TrashActor::Agent(who) => ("agent", Some(who)),
            TrashActor::App(what) => ("app", Some(what)),
        }
    }
}

/// Move a file to the room's trash: it leaves every listing, count, search and
/// retrieval path, but its row, its bytes, its version history and its
/// transcript all stay exactly where they are — inside the room's encryption
/// boundary. Nothing is written outside the room and nothing goes to the system
/// trash; "deleted" here means "flagged and unindexed", never "moved".
///
/// The search chunks are MOVED to `trashed_chunks` rather than filtered in
/// place (see the table's comment in schema.rs) so retrieval cannot see the
/// file even through a query that forgot to ask, and so restore can put the
/// embeddings back verbatim.
///
/// Trashing an already-trashed file is refused rather than silently re-stamped:
/// a second trash would overwrite the original actor and time — losing the
/// record of who actually deleted it — and would move an empty chunk set over
/// the real one, destroying the file's search index for good.
pub fn trash_file(conn: &Connection, id: &str, actor: TrashActor<'_>) -> Result<(), String> {
    let (kind, actor_id) = actor.parts();
    in_transaction(conn, || {
        // The affected-row count IS the answer: zero means the id names no
        // file, or names one that is already in the trash.
        let n = conn
            .execute(
                "UPDATE files
                 SET trashed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
                     trashed_by = ?2, trashed_by_id = ?3
                 WHERE id = ?1 AND trashed_at IS NULL",
                params![id, kind, actor_id],
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("That file is not in this room.".into());
        }
        execute_one(
            conn,
            "INSERT INTO trashed_chunks(id, file_id, seq, text, embedding)
             SELECT id, file_id, seq, text, embedding FROM chunks WHERE file_id = ?1",
            [id],
        )?;
        execute_one(conn, "DELETE FROM chunks WHERE file_id = ?1", [id])
    })
}

/// Put a trashed file back, whole: the row returns to every listing, and its
/// chunks (text AND embedding blob) go back into the search index, so the file
/// is findable by keyword and by vector the moment restore returns rather than
/// after some later background pass.
///
/// Restoring something that is not in the trash is an error, not a no-op — a UI
/// that offers Restore on a file already in the library is showing a stale
/// list, and reporting success would confirm a state it never checked.
pub fn restore_file(conn: &Connection, id: &str) -> Result<(), String> {
    in_transaction(conn, || {
        let n = conn
            .execute(
                "UPDATE files SET trashed_at = NULL, trashed_by = NULL, trashed_by_id = NULL
                 WHERE id = ?1 AND trashed_at IS NOT NULL",
                [id],
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("That file is not in the trash.".into());
        }
        execute_one(
            conn,
            "INSERT INTO chunks(id, file_id, seq, text, embedding)
             SELECT id, file_id, seq, text, embedding FROM trashed_chunks WHERE file_id = ?1",
            [id],
        )?;
        execute_one(conn, "DELETE FROM trashed_chunks WHERE file_id = ?1", [id])
    })
}

/// One trashed file, for the trash view. `list_files`' counterpart — and the
/// only query in the app that deliberately returns trashed rows.
pub fn list_trashed_files(conn: &Connection) -> Result<Vec<TrashedFile>, String> {
    query_rows(
        conn,
        "SELECT id, name, coalesce(mime_type,''), size_bytes,
                trashed_at, coalesce(trashed_by,'unknown'), trashed_by_id, folder_id
         FROM files WHERE trashed_at IS NOT NULL
         ORDER BY trashed_at DESC, rowid DESC",
        [],
        |r| {
            Ok(TrashedFile {
                id: r.get(0)?,
                name: r.get(1)?,
                mime_type: r.get(2)?,
                size_bytes: r.get(3)?,
                trashed_at: r.get(4)?,
                // A row trashed by a build that predates the actor column would
                // read NULL. 'unknown' says so; attributing it to the user
                // would be a claim the database cannot support.
                trashed_by: r.get(5)?,
                trashed_by_id: r.get(6)?,
                folder_id: r.get(7)?,
            })
        },
    )
}

/// How many files are in the trash. Its own query so the badge never has to
/// materialize the list.
pub fn trashed_file_count(conn: &Connection) -> Result<i64, String> {
    query_one(
        conn,
        "SELECT count(*) FROM files WHERE trashed_at IS NOT NULL",
        [],
        |r| r.get(0),
    )
}

/// Destroy a file for good: the row, its bytes, its chunks, its stashed trashed
/// chunks, its version history and its transcript. There is no undo past this
/// point, which is why it is a separate function from `trash_file` with a name
/// that says so — no caller can reach it by accident.
///
/// The FK cascades (`chunks`, `trashed_chunks`, `file_versions`, `recordings`,
/// `rec_chunks`, `privacy_scans`) do the dependent rows; `foreign_keys` is ON
/// in every path that opens a room. Zero affected rows is reported as a miss
/// rather than as a successful delete.
pub fn delete_file(conn: &Connection, id: &str) -> Result<(), String> {
    let n = conn
        .execute("DELETE FROM files WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("That file is not in this room.".into());
    }
    Ok(())
}

/// Permanently destroy everything in the trash. Returns how many files were
/// destroyed — the caller reports THAT number, so an empty trash reads as
/// "nothing to empty" instead of a cheerful "trash emptied".
pub fn empty_trash(conn: &Connection) -> Result<usize, String> {
    conn.execute("DELETE FROM files WHERE trashed_at IS NOT NULL", [])
        .map_err(|e| e.to_string())
}

pub fn rename_file(conn: &Connection, id: &str, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("File name cannot be empty.".into());
    }
    // Not `execute_one`: the affected-row count IS the answer here — zero rows
    // means the file was deleted out from under the rename. TRASHED counts as
    // deleted, or this message would be a lie the one time it matters: the
    // agent's `rename_file` tool takes an id it may have been holding since
    // before the delete, and a rename that "worked" would silently retitle a
    // row only the trash view can see.
    //
    // ART-1: renaming a generated artifact releases its `artifact_key`. Giving a
    // file your own name is how you adopt it, and the next run of the generator
    // must mint a fresh file rather than version over the copy you kept.
    let n = conn
        .execute(
            "UPDATE files SET name = ?2, artifact_key = NULL
             WHERE id = ?1 AND trashed_at IS NULL",
            params![id, name],
        )
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
         WHERE trashed_at IS NULL
           AND (extracted_text IS NULL OR trim(extracted_text) = '')
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

/// Every file with stored bytes, as (id, name, mime, original_bytes).
///
/// Used by the re-extraction pass that runs after an extractor is CORRECTED
/// rather than merely extended. `files_missing_text` cannot find those files:
/// they already have text. The legacy `.doc`/`.ppt` readers used to return the
/// font table and binary noise, which is text by every measure the database
/// has, so those files sat in the search index with garbage in them and nothing
/// marking them as wrong.
///
/// The caller filters by extension in Rust, with the same `extension_of` the
/// extractors use — expressing "the part after the last dot" in SQL is a trick
/// rather than a statement, and the two must not be able to disagree.
pub fn files_with_bytes(
    conn: &Connection,
) -> Result<Vec<(String, String, String, Vec<u8>)>, String> {
    query_rows(
        conn,
        "SELECT id, name, coalesce(mime_type,''), original_bytes FROM files
         WHERE trashed_at IS NULL AND original_bytes IS NOT NULL",
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
            // `created_at` is second-resolution, so two files added in the same
            // second tie and SQLite is free to return either. `rowid DESC`
            // breaks the tie toward the one added last — the same tiebreaker
            // `file_by_exact_name` and `list_files` already use, so all three
            // agree on which file is "the newest match".
            "SELECT {cols} FROM files
             WHERE lower(name) LIKE '%' || ?1 || '%'
               AND trashed_at IS NULL
               {image_filter}
               {derived_filter}
             ORDER BY created_at DESC, rowid DESC LIMIT 1"
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

/// ADD-6: file rows whose name contains EVERY word of `needle` (already
/// lowercased), in any order — see `search_terms`.
///
/// The words are taken LITERALLY: `like_escape` + `ESCAPE '\'`, the same pairing
/// `messages_like` uses. `search_all` runs all three searches off one text, so
/// while only the message query escaped, searching "report_2026" matched
/// literally under Messages and wildcarded under Files in the SAME result list.
pub fn files_name_like(conn: &Connection, needle: &str) -> Result<Vec<(String, String)>, String> {
    let terms = crate::db::search_terms(needle);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT id, name FROM files WHERE trashed_at IS NULL{}
         ORDER BY created_at DESC LIMIT 20",
        crate::db::like_all_clause("name", &terms, 1),
    );
    query_rows(conn, &sql, rusqlite::params_from_iter(terms), |r| {
        Ok((r.get(0)?, r.get(1)?))
    })
}

/// ADD-6: file content hits via FTS — (file id, name, matching chunk text) for
/// the best-ranked chunk. The caller trims a snippet out of the chunk text.
///
/// The only reason this is not `search_chunks_fts_ranked` (db/embeddings.rs)
/// with columns dropped: the search overlay opens the file it lists, so it needs
/// `f.id`, and the ranked variant returns the CHUNK rowid instead (the key its
/// keyword/vector blend scores on). Same MATCH/ORDER BY/LIMIT shape otherwise —
/// tune one and tune the other. A third copy that returned `(name, text, bm25)`
/// was only ever reached from tests and is gone.
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
         WHERE chunks_fts MATCH ?1 AND f.trashed_at IS NULL
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
    fn a_file_name_search_takes_like_wildcards_literally() {
        // `search_all` runs the file, message and memory searches off ONE text.
        // The escaping landed on messages only, so "report_2026" matched
        // literally in the Messages section and wildcarded in Files — two
        // matching rules, side by side, in the same result list.
        let conn = crate::db::mem();
        crate::db::add_file(&conn, "report_2026.pdf", "x");
        crate::db::add_file(&conn, "reportX2026.pdf", "x");
        crate::db::add_file(&conn, "50% off.txt", "x");
        crate::db::add_file(&conn, "50 pages.txt", "x");

        let hits = files_name_like(&conn, "report_2026").unwrap();
        assert_eq!(hits.len(), 1, "`_` still wildcarded: {hits:?}");
        assert_eq!(hits[0].1, "report_2026.pdf");

        let hits = files_name_like(&conn, "50%").unwrap();
        assert_eq!(hits.len(), 1, "`%` still wildcarded: {hits:?}");
        assert_eq!(hits[0].1, "50% off.txt");

        // An ordinary query is unaffected.
        assert_eq!(files_name_like(&conn, "pages").unwrap().len(), 1);
    }

    #[test]
    fn a_file_name_search_matches_words_in_any_order() {
        let conn = crate::db::mem();
        crate::db::add_file(&conn, "Q3 revenue report.pdf", "x");
        crate::db::add_file(&conn, "report on Q3 revenue.docx", "x");
        crate::db::add_file(&conn, "Q4 revenue report.pdf", "x");
        for q in ["q3 report", "report q3"] {
            let hits = files_name_like(&conn, q).unwrap();
            assert_eq!(hits.len(), 2, "{q:?} found {hits:?}");
        }
        assert!(files_name_like(&conn, "q3 rhubarb").unwrap().is_empty());
    }

    /// A room full of one of everything: an upload, a browser page and its
    /// HTML twin, a download, and two generated artifacts.
    fn room_of_every_kind(conn: &Connection) -> String {
        add_file(conn, "lease.pdf", "an upload");
        insert_file_from_url(
            conn, "Google News.md", "text/markdown", b"page", Some("page"), "web",
            Some("https://news.google.com"),
        ).unwrap();
        insert_file_from_url(
            conn, "Google News.html", "text/html", b"<p>page</p>", None, "web",
            Some("https://news.google.com"),
        ).unwrap();
        insert_file_from_url(
            conn, "report.pdf", "application/pdf", b"%PDF", None, "download",
            Some("https://example.test/report.pdf"),
        ).unwrap();
        insert_file(conn, "Room summary.md", "text/markdown", b"s", Some("s"), "generated").unwrap();
        insert_file(conn, "Full pass — lease.pdf.html", "text/html", b"f", None, "generated")
            .unwrap()
            .id
    }

    #[test]
    fn the_room_count_counts_every_kind_of_thing_in_the_room() {
        // Owner's ruling (2026-08-03): the count means "what is in this room",
        // full stop. A saved browser page, the HTML twin saved beside it, a
        // download and a generated/temporary artifact are all things the room
        // holds — leaving any of them out would answer a different question
        // than the badge asks.
        let conn = crate::db::mem();
        room_of_every_kind(&conn);
        assert_eq!(room_file_count(&conn).unwrap(), 6);
        assert_eq!(
            room_file_count(&conn).unwrap(),
            list_files(&conn).unwrap().len() as i64,
            "the count and the list are the same population"
        );
    }

    #[test]
    fn a_trashed_file_stops_counting_as_present() {
        // The one exclusion that is correct: a deleted file is recoverable, but
        // it is not IN the room, and `list_files` already refuses to list it.
        let conn = crate::db::mem();
        let temp = room_of_every_kind(&conn);
        trash_file(&conn, &temp, TrashActor::User).unwrap();
        assert_eq!(room_file_count(&conn).unwrap(), 5);
        assert_eq!(
            room_file_count(&conn).unwrap(),
            list_files(&conn).unwrap().len() as i64
        );
        // Undo puts it back — in the count as well as in the list.
        restore_file(&conn, &temp).unwrap();
        assert_eq!(room_file_count(&conn).unwrap(), 6);
    }

    #[test]
    fn deleted_files_are_not_new_work_for_a_workflow() {
        // `new_files_since_last_run` fires a workflow. Counting a file the user
        // imported and then deleted starts a run over files that are not there.
        let conn = crate::db::mem();
        let a = add_file(&conn, "invoice-1.pdf", "one");
        add_file(&conn, "invoice-2.pdf", "two");
        // A workflow's OWN output is excluded for a different reason (it would
        // re-trigger itself forever), and that exclusion still stands.
        insert_file(&conn, "Summary.md", "text/markdown", b"s", Some("s"), "generated").unwrap();
        assert_eq!(new_source_file_count(&conn, "").unwrap(), 2);
        trash_file(&conn, &a, TrashActor::User).unwrap();
        assert_eq!(new_source_file_count(&conn, "").unwrap(), 1);
        // A `since` in the future leaves nothing new, which is the answer, not
        // a failure to look.
        assert_eq!(new_source_file_count(&conn, "2999-01-01T00:00:00Z").unwrap(), 0);
    }

    #[test]
    fn every_count_surface_reports_the_same_number() {
        // `room_counts` (RoomInfo) and the front page each used to run their own
        // `count(*) FROM files`. Two spellings of one question drift: trash
        // filtered the listings and left both counts behind. They now share
        // `room_file_count`, and this pins that.
        let conn = crate::db::mem();
        let temp = room_of_every_kind(&conn);
        trash_file(&conn, &temp, TrashActor::User).unwrap();
        let listed = list_files(&conn).unwrap().len() as i64;
        assert_eq!(crate::db::room_counts(&conn).unwrap().0, listed);
        assert_eq!(room_file_count(&conn).unwrap(), listed);
    }

    #[test]
    fn fts_index_finds_and_stays_in_sync() {
        let conn = mem();
        let id = add_file(&conn, "lease.txt", "The tenant pays rent on the first of each month.");
        let hits = search_chunks_fts_ranked(&conn, "\"rent\"", 5).unwrap();
        assert_eq!(hits.len(), 1, "inserted chunk is searchable via the FTS index");
        assert_eq!(hits[0].1, "lease.txt");
        update_file_content(&conn, &id, b"The landlord provides parking spaces.", Some("The landlord provides parking spaces.")).unwrap();
        assert!(
            search_chunks_fts_ranked(&conn, "\"rent\"", 5).unwrap().is_empty(),
            "update fires the triggers: old terms drop out of the FTS index"
        );
        assert_eq!(search_chunks_fts_ranked(&conn, "\"parking\"", 5).unwrap().len(), 1, "new terms appear");
        delete_file(&conn, &id).unwrap();
        assert!(
            search_chunks_fts_ranked(&conn, "\"parking\"", 5).unwrap().is_empty(),
            "delete removes the file's text from the FTS index"
        );
    }

    #[test]
    fn generated_output_steps_past_the_name_it_already_used() {
        // Live QA 2026-08-03 ended with three files called
        // "Flashcards - clean-code.html" and several "Google News.md" — same
        // name, different content, no way to tell which run produced which.
        let conn = mem();
        let name = "Flashcards - clean-code.html";
        assert_eq!(available_name(&conn, name).unwrap(), name, "first one keeps the plain name");
        add_file(&conn, name, "deck one");
        assert_eq!(available_name(&conn, name).unwrap(), "Flashcards - clean-code (2).html");
        add_file(&conn, "Flashcards - clean-code (2).html", "deck two");
        assert_eq!(available_name(&conn, name).unwrap(), "Flashcards - clean-code (3).html");
    }

    #[test]
    fn available_name_handles_the_awkward_names() {
        let conn = mem();
        // No extension.
        add_file(&conn, "notes", "x");
        assert_eq!(available_name(&conn, "notes").unwrap(), "notes (2)");
        // Case-insensitive: the library lists names, and two rows differing only
        // in case read as the same duplicate to whoever is scanning it.
        add_file(&conn, "Report.md", "x");
        assert_eq!(available_name(&conn, "report.md").unwrap(), "report (2).md");
        // LIKE wildcards in the name itself must not widen the search: this file
        // is unrelated to "100% done.md" and must not push its numbering along.
        add_file(&conn, "100% done.md", "x");
        add_file(&conn, "100X done (2).md", "x");
        assert_eq!(available_name(&conn, "100% done.md").unwrap(), "100% done (2).md");
        // A free name is returned untouched even when near-misses exist.
        add_file(&conn, "solo (2).txt", "x");
        assert_eq!(available_name(&conn, "solo.txt").unwrap(), "solo.txt");
    }

    #[test]
    fn a_write_and_its_index_land_together_or_not_at_all() {
        // What makes `insert_file` all-or-nothing: the row and its search
        // chunks share one transaction, so an import that dies partway through
        // indexing can't leave a file in the library that is listed as failed
        // and only partly searchable.
        let conn = mem();
        let count = |c: &Connection| -> i64 {
            c.query_row("SELECT count(*) FROM folders", [], |r| r.get(0)).unwrap()
        };
        let outcome = in_transaction(&conn, || {
            execute_one(&conn, "INSERT INTO folders(id, name) VALUES ('x', 'X')", [])?;
            Err::<(), String>("indexing blew up".into())
        });
        assert_eq!(outcome.unwrap_err(), "indexing blew up");
        assert_eq!(count(&conn), 0, "the partial write rolled back with the failure");

        // A successful body commits.
        in_transaction(&conn, || {
            execute_one(&conn, "INSERT INTO folders(id, name) VALUES ('y', 'Y')", [])
        })
        .unwrap();
        assert_eq!(count(&conn), 1);

        // SQLite has no nested BEGIN, so inside a caller's own transaction
        // (the batch-edit path) this must be a pass-through, not a second one.
        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        in_transaction(&conn, || {
            execute_one(&conn, "INSERT INTO folders(id, name) VALUES ('z', 'Z')", [])
        })
        .unwrap();
        conn.execute_batch("ROLLBACK").unwrap();
        assert_eq!(count(&conn), 1, "the outer transaction still owns the outcome");
    }

    #[test]
    fn same_bytes_are_recognized_as_an_existing_file() {
        let conn = mem();
        let id = add_file(&conn, "lease.pdf", "the very same text");
        let bytes = get_file_bytes(&conn, &id).unwrap().unwrap();
        assert_eq!(
            file_with_same_bytes(&conn, &bytes),
            Some((id, "lease.pdf".to_string()))
        );
        // Different bytes of the same length are NOT a match.
        let mut other = bytes.clone();
        other[0] ^= 0xFF;
        assert_eq!(file_with_same_bytes(&conn, &other), None);
        assert_eq!(file_with_same_bytes(&conn, b"nothing like it"), None);
    }

    #[test]
    fn fuzzy_finder_breaks_a_same_second_tie_toward_the_newer_file() {
        // `created_at` only records whole seconds, so two files added in the
        // same second used to tie and SQLite could return either.
        let conn = mem();
        add_file(&conn, "report-v1.txt", "older");
        let newer = add_file(&conn, "report-v2.txt", "newer");
        conn.execute("UPDATE files SET created_at = '2026-01-01T00:00:00Z'", []).unwrap();
        assert_eq!(find_file_like(&conn, "report").unwrap().0, newer);
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
    fn empty_liner_sentinel_leaves_the_missing_set() {
        // Wave 1b (idea 8): a file whose one-liner persistently fails gets the
        // '' sentinel from an auto job, which must remove it from the missing
        // set (auto-index termination) — while a NULL keeps it in.
        let conn = mem();
        let stuck = add_file(&conn, "stuck.pdf", "text the model chokes on");
        let fresh = add_file(&conn, "fresh.pdf", "normal text");
        assert_eq!(files_missing_summary(&conn, 10).unwrap().len(), 2);
        set_file_ai_summary(&conn, &stuck, "").unwrap();
        let ids: Vec<String> = files_missing_summary(&conn, 10)
            .unwrap()
            .into_iter()
            .map(|(id, ..)| id)
            .collect();
        assert_eq!(ids, vec![fresh]);
        // A content change clears the sentinel back to NULL → retried.
        update_file_content(&conn, &stuck, b"new bytes", Some("new text")).unwrap();
        assert_eq!(files_missing_summary(&conn, 10).unwrap().len(), 2);
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
    /// A video's technical metadata round-trips, and — the part that actually
    /// breaks — the column exists in a room built from `SCHEMA` alone.
    ///
    /// `create_room` runs only `SCHEMA`, never `migrate()`, so a column added
    /// to just one of the two is missing from every brand-new room until it is
    /// closed and reopened. `mem()` here IS the `SCHEMA`-only path.
    #[test]
    fn media_meta_round_trips_and_the_column_exists_in_a_fresh_room() {
        let conn = mem();
        let id = add_file(&conn, "talk.mp4", "");
        // Never probed is NULL, and NULL must not read as "probed, all unknown".
        assert_eq!(get_media_meta(&conn, &id), None);
        set_media_meta(&conn, &id, r#"{"durationSecs":751.0,"width":1920}"#).unwrap();
        assert_eq!(
            get_media_meta(&conn, &id).as_deref(),
            Some(r#"{"durationSecs":751.0,"width":1920}"#)
        );
        // A file that no longer exists reads as "nothing stored", not as an
        // error the caller has to special-case.
        assert_eq!(get_media_meta(&conn, "no-such-file"), None);
    }

    /// The saved-page column, same double-write and same NULL rule: a file that
    /// did not come from a web page has nothing stored, and that must not read
    /// as "came from a page that declared nothing".
    #[test]
    fn web_meta_round_trips_and_the_column_exists_in_a_fresh_room() {
        let conn = mem();
        let id = add_file(&conn, "The Heron Returns.md", "body");
        assert_eq!(get_web_meta(&conn, &id), None, "not from the web reads as nothing stored");
        let json = r#"{"title":"The Heron Returns","byline":"Dana Okafor"}"#;
        set_web_meta(&conn, &id, json).unwrap();
        assert_eq!(get_web_meta(&conn, &id).as_deref(), Some(json));
        assert_eq!(get_web_meta(&conn, "no-such-file"), None);

        // And the other half of the double-write: a room created BEFORE the
        // column existed gains it on open. (`mem()` is the SCHEMA-only path, so
        // the column is dropped again here to make one.)
        conn.execute_batch("ALTER TABLE files DROP COLUMN web_meta")
            .expect("drop the column to simulate a pre-column room");
        assert!(
            conn.query_row("SELECT web_meta FROM files", [], |r| r.get::<_, Option<String>>(0))
                .is_err(),
            "the column must really be gone before migrate runs"
        );
        crate::db::schema::migrate(&conn).unwrap();
        set_web_meta(&conn, &id, json).unwrap();
        // Every room open runs migrate; a second pass must not re-ALTER (which
        // would error) nor clear what the first one enabled.
        crate::db::schema::migrate(&conn).unwrap();
        assert_eq!(get_web_meta(&conn, &id).as_deref(), Some(json));
    }

    /// The other half of the double-write: an OLD room, created before the
    /// column existed, gains it on `migrate()` — and running migrate twice is
    /// not an error (every room open runs it).
    ///
    /// The "old" room is a CURRENT room with the column dropped again, rather
    /// than a hand-written legacy schema: `migrate()` touches a dozen tables,
    /// and a stub that omitted any of them would fail for reasons that have
    /// nothing to do with this column.
    #[test]
    fn an_older_room_gains_the_media_meta_column_when_it_is_migrated() {
        let conn = mem();
        conn.execute_batch("ALTER TABLE files DROP COLUMN media_meta")
            .expect("drop the column to simulate a pre-column room");
        let id = add_file(&conn, "legacy.mp4", "");
        assert!(
            conn.query_row("SELECT media_meta FROM files", [], |r| r.get::<_, Option<String>>(0))
                .is_err(),
            "the column must really be gone before migrate runs"
        );
        crate::db::schema::migrate(&conn).unwrap();
        set_media_meta(&conn, &id, r#"{"hasAudio":false}"#).unwrap();
        assert_eq!(get_media_meta(&conn, &id).as_deref(), Some(r#"{"hasAudio":false}"#));
        // Every room open runs migrate; a second pass must not re-ALTER (which
        // would error) nor clear what the first one enabled.
        crate::db::schema::migrate(&conn).unwrap();
        assert_eq!(get_media_meta(&conn, &id).as_deref(), Some(r#"{"hasAudio":false}"#));
    }

    // ================================================================ trash / undo

    /// Give `id` a fake embedding so the vector half of retrieval has something
    /// to lose (and to get back). Returns the blob that was stored.
    fn embed_every_chunk(conn: &Connection, vector: &[f32]) -> Vec<u8> {
        let blob = embedding_to_blob(vector);
        for (chunk_id, ..) in chunks_missing_embedding(conn, 100).unwrap() {
            set_chunk_embedding(conn, &chunk_id, &blob).unwrap();
        }
        blob
    }

    /// The whole point of the feature: delete → the file is gone from
    /// everything → restore → it is BACK, including being findable again.
    ///
    /// "Findable" is checked on both halves of retrieval. A restore that only
    /// put the row back would return a file the user can see and the model
    /// cannot, which is not a restore.
    #[test]
    fn delete_then_restore_round_trips_including_searchability() {
        let conn = mem();
        let id = add_file(&conn, "lease.txt", "The tenant pays rent on the first of each month.");
        let blob = embed_every_chunk(&conn, &[0.25, -0.5, 0.75]);

        // Present: listed, counted, keyword-searchable, vector-searchable.
        assert_eq!(list_files(&conn).unwrap().len(), 1);
        assert_eq!(room_file_count(&conn).unwrap(), 1);
        assert_eq!(search_chunks_fts_ranked(&conn, "\"rent\"", 5).unwrap().len(), 1);
        let mut embedded = 0;
        for_each_chunk_embedding(&conn, |_, _| embedded += 1).unwrap();
        assert_eq!(embedded, 1);

        trash_file(&conn, &id, TrashActor::User).unwrap();

        // Gone from the library AND from both retrieval paths.
        assert!(list_files(&conn).unwrap().is_empty());
        assert_eq!(room_file_count(&conn).unwrap(), 0);
        assert!(search_chunks_fts_ranked(&conn, "\"rent\"", 5).unwrap().is_empty());
        let mut still_embedded = 0;
        for_each_chunk_embedding(&conn, |_, _| still_embedded += 1).unwrap();
        assert_eq!(still_embedded, 0, "a trashed file's vectors leave the scan entirely");

        // …but nothing was destroyed: the row, the bytes and the text survive.
        let bytes: Option<Vec<u8>> = conn
            .query_row("SELECT original_bytes FROM files WHERE id = ?1", [&id], |r| r.get(0))
            .unwrap();
        assert_eq!(bytes.unwrap(), b"The tenant pays rent on the first of each month.");

        restore_file(&conn, &id).unwrap();

        assert_eq!(list_files(&conn).unwrap().len(), 1);
        assert_eq!(room_file_count(&conn).unwrap(), 1);
        let hits = search_chunks_fts_ranked(&conn, "\"rent\"", 5).unwrap();
        assert_eq!(hits.len(), 1, "keyword search finds it again");
        assert_eq!(hits[0].1, "lease.txt");
        // The EMBEDDING came back too, byte for byte — not a NULL waiting on a
        // background re-embed that may never run.
        let mut restored: Vec<Vec<u8>> = Vec::new();
        for_each_chunk_embedding(&conn, |_, b| restored.push(b.to_vec())).unwrap();
        assert_eq!(restored, vec![blob]);
        assert!(
            chunks_missing_embedding(&conn, 10).unwrap().is_empty(),
            "the restored chunk is not queued for re-embedding — it never lost its vector"
        );
        // And it is no longer in the trash.
        assert!(list_trashed_files(&conn).unwrap().is_empty());
        assert_eq!(trashed_file_count(&conn).unwrap(), 0);
    }

    /// Every place a file can be listed, counted, searched or retrieved — named
    /// one by one, because the way this feature fails is one forgotten query,
    /// and a test that only checked `list_files` would have passed anyway.
    #[test]
    fn a_trashed_file_is_excluded_from_every_place_files_are_found() {
        let conn = mem();
        let folder = create_folder(&conn, "Contracts").unwrap();
        let doomed = add_file(&conn, "lease.txt", "the tenant pays rent monthly");
        move_file_to_folder(&conn, &doomed, Some(&folder.id)).unwrap();
        let keeper = add_file(&conn, "invoice.txt", "an unrelated invoice about parking");
        // Provenance, so the room map's edge query is exercised as well.
        set_derived_from(&conn, &keeper, &doomed).unwrap();
        embed_every_chunk(&conn, &[1.0, 0.0]);

        trash_file(&conn, &doomed, TrashActor::User).unwrap();

        let names = |v: Vec<FileMeta>| v.into_iter().map(|f| f.name).collect::<Vec<_>>();

        // --- listings -------------------------------------------------------
        assert_eq!(names(list_files(&conn).unwrap()), vec!["invoice.txt"]);
        assert!(!list_files_brief(&conn).unwrap().iter().any(|(n, ..)| n.contains("lease")));
        assert!(!list_file_inventory(&conn).unwrap().iter().any(|(n, ..)| n.contains("lease")));
        assert!(!list_files_for_summary(&conn).unwrap().iter().any(|f| f.id == doomed));
        assert!(!files_with_bytes(&conn).unwrap().iter().any(|(i, ..)| *i == doomed));
        assert!(!files_missing_summary(&conn, 50).unwrap().iter().any(|(i, ..)| *i == doomed));
        assert!(!file_names_hint(&conn).contains("lease.txt"));

        // --- counts ---------------------------------------------------------
        assert_eq!(room_file_count(&conn).unwrap(), 1);
        assert_eq!(room_counts(&conn).unwrap().0, 1);

        // --- name lookups ---------------------------------------------------
        assert!(file_by_exact_name(&conn, "lease.txt").unwrap().is_none());
        assert!(find_file_like(&conn, "lease").is_err());
        assert!(find_file_like_full(&conn, "lease").is_err());
        assert!(find_source_file_like(&conn, "lease").is_err());
        assert!(files_name_like(&conn, "lease").unwrap().is_empty());
        // A name in the trash does not hold that name against a new file.
        assert_eq!(available_name(&conn, "lease.txt").unwrap(), "lease.txt");
        // Nor does it count as an existing copy of those bytes on re-import.
        assert_eq!(
            file_with_same_bytes(&conn, b"the tenant pays rent monthly"),
            None
        );

        // --- by-id reads (a stale id must not resurrect it) ------------------
        assert!(get_file_meta(&conn, &doomed).is_err());
        assert!(get_file_name(&conn, &doomed).is_err());
        assert!(get_file_full(&conn, &doomed).is_err());
        assert!(get_file_bytes(&conn, &doomed).is_err());
        assert!(get_file_bytes_named(&conn, &doomed).is_err());
        assert_eq!(get_file_extracted_text(&conn, &doomed), None);

        // --- search / retrieval ---------------------------------------------
        assert!(search_chunks_fts_ranked(&conn, "\"rent\"", 10).unwrap().is_empty());
        assert!(files_content_fts(&conn, "\"rent\"", 10).unwrap().is_empty());
        assert!(fts_file_matches(&conn, "\"rent\"", "", 10).unwrap().is_empty());
        assert!(!recent_chunks(&conn, 50).unwrap().iter().any(|(n, _)| n == "lease.txt"));
        assert!(!chunks_missing_embedding(&conn, 50).unwrap().iter().any(|(_, n, _)| n == "lease.txt"));
        let mut rowids = Vec::new();
        for_each_chunk_embedding(&conn, |r, _| rowids.push(r)).unwrap();
        assert!(!chunks_by_rowids(&conn, &rowids).unwrap().iter().any(|(_, n, _)| n == "lease.txt"));
        // The keeper is untouched by all of it.
        assert_eq!(files_content_fts(&conn, "\"parking\"", 10).unwrap().len(), 1);

        // --- other whole-room passes ----------------------------------------
        assert!(derived_links(&conn).unwrap().is_empty(), "an edge to a trashed file is not drawn");
        assert!(files_needing_privacy_scan(&conn, "rules-v1")
            .unwrap()
            .iter()
            .all(|(i, ..)| *i != doomed));
        // And the trash view is the ONE place it does show up.
        let trashed = list_trashed_files(&conn).unwrap();
        assert_eq!(trashed.len(), 1);
        assert_eq!(trashed[0].name, "lease.txt");
        assert_eq!(trashed[0].folder_id.as_deref(), Some(folder.id.as_str()));
    }

    /// The SIDECAR reads — the ones that answer by id out of a table other than
    /// `files`, or out of a column the listings never touch. Every one of these
    /// was written before the trash existed and none of them was updated when
    /// it landed, so a stale id — an open tab, a chat message's `sources`, a
    /// paused job's plan — still got a real answer about a deleted file.
    ///
    /// The list is the point. `get_file_meta`'s doc comment states the
    /// invariant for the whole app, and it is only true if it is true of every
    /// reader; a suite that checked the four obvious ones would have passed
    /// while `probe_video_meta` happily reported a trashed video's duration.
    #[test]
    fn a_stale_id_gets_nothing_from_a_trashed_files_sidecar_tables() {
        let conn = mem();
        let doomed = add_file(&conn, "interview.mp4", "the transcript of the interview");

        set_media_meta(&conn, &doomed, r#"{"durationSecs":612.0}"#).unwrap();
        set_web_meta(&conn, &doomed, r#"{"title":"Interview with the tenant"}"#).unwrap();
        set_rec_meta(&conn, &doomed, r#"{"segments":[{"text":"the rent is 4200"}]}"#).unwrap();
        set_file_provenance(&conn, &doomed, Some(r#"{"agent":"Documents agent"}"#)).unwrap();
        snapshot_file_version(&conn, &doomed, "You saved").unwrap();
        assert_eq!(list_file_versions(&conn, &doomed).unwrap().len(), 1);

        trash_file(&conn, &doomed, TrashActor::User).unwrap();

        // The viewer's video strip (`probe_video_meta` calls this by id).
        assert_eq!(get_media_meta(&conn, &doomed), None);
        // The saved-page strip.
        assert_eq!(get_web_meta(&conn, &doomed), None);
        // The recording editor — this one IS the transcript, words and all.
        assert_eq!(get_rec_meta(&conn, &doomed), None);
        // The History strip: who wrote it, and what it was before.
        assert_eq!(file_provenance(&conn, &doomed).unwrap(), None);
        assert!(list_file_versions(&conn, &doomed).unwrap().is_empty());
        // And a rename says so instead of quietly retitling a trashed row.
        assert!(rename_file(&conn, &doomed, "renamed.mp4").is_err());
        assert_eq!(list_trashed_files(&conn).unwrap()[0].name, "interview.mp4");

        // Restore is the other half of the invariant: every one of them comes
        // back, unchanged. Trash HIDES; it never edits and never discards.
        restore_file(&conn, &doomed).unwrap();
        assert_eq!(get_media_meta(&conn, &doomed).as_deref(), Some(r#"{"durationSecs":612.0}"#));
        assert!(get_web_meta(&conn, &doomed).is_some());
        assert!(get_rec_meta(&conn, &doomed).unwrap().contains("4200"));
        assert_eq!(
            file_provenance(&conn, &doomed).unwrap().and_then(|p| p.agent).as_deref(),
            Some("Documents agent")
        );
        assert_eq!(list_file_versions(&conn, &doomed).unwrap().len(), 1);
        assert!(rename_file(&conn, &doomed, "renamed.mp4").is_ok());
    }

    /// The actor is recorded at the moment of deletion, in the shape the trash
    /// view reads. "What did the agent delete" is the question the feature
    /// exists to answer, so an agent delete must be distinguishable from a
    /// person's — by kind AND by which agent.
    #[test]
    fn the_actor_that_deleted_a_file_is_recorded() {
        let conn = mem();
        let by_user = add_file(&conn, "a.txt", "one");
        let by_agent = add_file(&conn, "b.txt", "two");
        let by_app = add_file(&conn, "c.txt", "three");
        trash_file(&conn, &by_user, TrashActor::User).unwrap();
        trash_file(&conn, &by_agent, TrashActor::Agent("files.edit/delete_file")).unwrap();
        trash_file(&conn, &by_app, TrashActor::App("summarize_room")).unwrap();

        let by_id: std::collections::HashMap<String, TrashedFile> = list_trashed_files(&conn)
            .unwrap()
            .into_iter()
            .map(|f| (f.id.clone(), f))
            .collect();
        assert_eq!(by_id[&by_user].trashed_by, "user");
        assert_eq!(by_id[&by_user].trashed_by_id, None);
        assert_eq!(by_id[&by_agent].trashed_by, "agent");
        assert_eq!(
            by_id[&by_agent].trashed_by_id.as_deref(),
            Some("files.edit/delete_file"),
            "which agent, not just that it was one"
        );
        assert_eq!(by_id[&by_app].trashed_by, "app");
        assert_eq!(by_id[&by_app].trashed_by_id.as_deref(), Some("summarize_room"));
        // Every row carries WHEN, and the trash counts them all.
        assert!(by_id.values().all(|f| !f.trashed_at.is_empty()));
        assert_eq!(trashed_file_count(&conn).unwrap(), 3);

        // A second trash of the same file is refused rather than re-stamping
        // it: that would overwrite the record of who actually deleted it, and
        // would move an empty chunk set over the real one.
        assert!(trash_file(&conn, &by_agent, TrashActor::User).is_err());
        assert_eq!(list_trashed_files(&conn).unwrap().len(), 3);
        let still: Vec<TrashedFile> = list_trashed_files(&conn)
            .unwrap()
            .into_iter()
            .filter(|f| f.id == by_agent)
            .collect();
        assert_eq!(still[0].trashed_by, "agent", "the original actor survived the second attempt");
    }

    /// Permanent delete destroys everything, and `empty_trash` reports the
    /// number it really destroyed — while a file that is merely present is
    /// never touched by either.
    #[test]
    fn permanent_delete_really_destroys_and_only_touches_the_trash() {
        let conn = mem();
        let doomed = add_file(&conn, "gone.txt", "text that must not survive");
        let keeper = add_file(&conn, "stays.txt", "text that must survive");
        // Give the doomed file a version and a chunk stash, so the cascade has
        // something to prove.
        update_file_content(&conn, &doomed, b"v2", Some("v2 text")).unwrap();
        snapshot_file_version(&conn, &doomed, "You saved").unwrap();
        assert_eq!(list_file_versions(&conn, &doomed).unwrap().len(), 1);
        trash_file(&conn, &doomed, TrashActor::User).unwrap();
        let stashed: i64 = conn
            .query_row("SELECT count(*) FROM trashed_chunks WHERE file_id = ?1", [&doomed], |r| r.get(0))
            .unwrap();
        assert!(stashed > 0, "trashing stashed the chunks");

        delete_file(&conn, &doomed).unwrap();

        let count = |sql: &str| -> i64 { conn.query_row(sql, [&doomed], |r| r.get(0)).unwrap() };
        assert_eq!(count("SELECT count(*) FROM files WHERE id = ?1"), 0, "the row is gone");
        assert_eq!(count("SELECT count(*) FROM chunks WHERE file_id = ?1"), 0);
        assert_eq!(count("SELECT count(*) FROM trashed_chunks WHERE file_id = ?1"), 0);
        assert_eq!(count("SELECT count(*) FROM file_versions WHERE file_id = ?1"), 0);
        // Its text is out of the FTS index too — an orphan term would still
        // surface the deleted file's words in an answer.
        assert!(search_chunks_fts_ranked(&conn, "\"survive\"", 10)
            .unwrap()
            .iter()
            .all(|(_, name, ..)| name == "stays.txt"));
        // A second permanent delete is a miss, not a cheerful success.
        assert!(delete_file(&conn, &doomed).is_err());
        // The file that was never deleted is entirely unaffected.
        assert_eq!(names_of(list_files(&conn).unwrap()), vec!["stays.txt"]);

        // empty_trash destroys what is IN the trash and nothing else, and
        // reports the real number both times.
        assert_eq!(empty_trash(&conn).unwrap(), 0, "an empty trash destroys nothing");
        let second = add_file(&conn, "also-gone.txt", "more doomed text");
        trash_file(&conn, &second, TrashActor::App("test")).unwrap();
        assert_eq!(empty_trash(&conn).unwrap(), 1);
        assert!(list_trashed_files(&conn).unwrap().is_empty());
        assert_eq!(names_of(list_files(&conn).unwrap()), vec!["stays.txt"]);
        assert_eq!(
            get_file_extracted_text(&conn, &keeper).as_deref(),
            Some("text that must survive")
        );
    }

    /// Restore refuses what is not in the trash, rather than reporting a
    /// success it never performed.
    #[test]
    fn restore_refuses_anything_that_is_not_in_the_trash() {
        let conn = mem();
        let present = add_file(&conn, "here.txt", "still here");
        assert!(restore_file(&conn, &present).is_err());
        assert!(restore_file(&conn, "no-such-id").is_err());
        // …and the present file was not disturbed by the refusal.
        assert_eq!(list_files(&conn).unwrap().len(), 1);
        assert_eq!(search_chunks_fts_ranked(&conn, "\"here\"", 5).unwrap().len(), 1);
    }

    fn names_of(files: Vec<FileMeta>) -> Vec<String> {
        files.into_iter().map(|f| f.name).collect()
    }

    /// A room created before the trash existed gains the columns and the stash
    /// table on `migrate()`, its files all read as present, and a second open
    /// (every room open runs migrate) changes nothing.
    #[test]
    fn an_older_room_gains_the_trash_columns_when_it_is_migrated() {
        let conn = mem();
        conn.execute_batch(
            "ALTER TABLE files DROP COLUMN trashed_at;
             ALTER TABLE files DROP COLUMN trashed_by;
             ALTER TABLE files DROP COLUMN trashed_by_id;
             DROP TABLE trashed_chunks;",
        )
        .expect("reshape the table as a pre-trash room had it");
        conn.execute(
            "INSERT INTO files(id, name, mime_type, source) VALUES ('legacy', 'old.txt', 'text/plain', 'upload')",
            [],
        )
        .unwrap();
        assert!(!column_exists(&conn, "files", "trashed_at").unwrap());

        crate::db::schema::migrate(&conn).unwrap();

        assert!(column_exists(&conn, "files", "trashed_at").unwrap());
        assert!(table_exists(&conn, "trashed_chunks").unwrap());
        // Nothing that was in the library before the trash existed was ever
        // deleted, so nothing starts out in it.
        assert!(list_trashed_files(&conn).unwrap().is_empty());
        assert_eq!(names_of(list_files(&conn).unwrap()), vec!["old.txt"]);
        // And the feature works on the migrated room.
        trash_file(&conn, "legacy", TrashActor::User).unwrap();
        assert_eq!(list_trashed_files(&conn).unwrap().len(), 1);
        restore_file(&conn, "legacy").unwrap();
        assert_eq!(names_of(list_files(&conn).unwrap()), vec!["old.txt"]);
        // Idempotent on the next open.
        crate::db::schema::migrate(&conn).unwrap();
        assert_eq!(names_of(list_files(&conn).unwrap()), vec!["old.txt"]);
    }

    /// A write that lands on an ALREADY-TRASHED file must not put its text back
    /// into the live search index.
    ///
    /// This is not hypothetical: OCR and transcription run on background
    /// workers that finish long after the import that queued them, and they
    /// call `update_file_content` / `set_file_extracted_text` by id. Delete a
    /// scanned PDF while its OCR pass is still running and, before this, the
    /// pass would happily index the text of a file the room was no longer
    /// showing — searchable content with nothing on screen owning it.
    #[test]
    fn a_late_background_write_cannot_reindex_a_trashed_file() {
        let conn = mem();
        let id = add_file(&conn, "scan.pdf", "");
        trash_file(&conn, &id, TrashActor::User).unwrap();

        // The OCR worker finishes and writes what it read.
        update_file_content(&conn, &id, b"scanned bytes", Some("the invoice total is 4,200")).unwrap();
        assert!(
            search_chunks_fts_ranked(&conn, "\"invoice\"", 5).unwrap().is_empty(),
            "a trashed file's freshly extracted text stays out of the live index"
        );
        assert!(files_content_fts(&conn, "\"invoice\"", 5).unwrap().is_empty());
        assert!(fts_file_matches(&conn, "\"invoice\"", "", 5).unwrap().is_empty());

        // The transcription path (text-only write) behaves the same way.
        set_file_extracted_text(&conn, &id, "the invoice total is 5,300").unwrap();
        assert!(search_chunks_fts_ranked(&conn, "\"invoice\"", 5).unwrap().is_empty());

        // …and restoring brings back the CURRENT text, not the text the file
        // had at the moment it was deleted.
        restore_file(&conn, &id).unwrap();
        let hits = search_chunks_fts_ranked(&conn, "\"invoice\"", 5).unwrap();
        assert_eq!(hits.len(), 1, "one chunk, not one per background write");
        assert!(hits[0].2.contains("5,300"), "got: {}", hits[0].2);
        assert!(!hits[0].2.contains("4,200"));
    }

    /// A file `id` outlives the file, and the trash is the only feature where
    /// that matters: this is what makes a stale id resurrect one. Two readers
    /// (`get_media_meta`, `get_web_meta`) shipped without the clause because
    /// they were written years apart from the listings and nobody re-read them
    /// when trash landed — and three more (`get_rec_meta`, `file_provenance`,
    /// `list_file_versions`) turned up the same way in the audit that found
    /// those two. A test naming the readers it knows about would have passed on
    /// the day the SIXTH was written.
    ///
    /// So this scans the source instead: every SQL literal in the crate that
    /// SELECTs from `files` for ONE row by id must say `trashed`. The
    /// exceptions are listed by file and by statement, each with the reason it
    /// is one — an unlisted new reader fails here rather than shipping.
    ///
    /// Modelled on `browser.rs`'s banned-lookup scanner, which exists for the
    /// same reason: an invariant no single call site can enforce.
    #[test]
    fn no_by_id_read_of_a_file_may_skip_the_trash_clause() {
        // (source file, projection, why). Allowed one STATEMENT at a time, not
        // one file at a time: exempting a whole file would let the next query
        // added to it through unexamined.
        //
        // Matched on the projection alone — spelling the whole statement out
        // here would be a literal this very scanner then reports itself for.
        const ALLOWED: &[(&str, &str, &str)] = &[
            (
                "db/schema.rs",
                "select extracted_text",
                "one-time re-chunk migrations. The ids come from `chunks`, which a \
                 trashed file has already left, and `insert_chunks` routes to the \
                 stash anyway — re-indexing here cannot reach the live index.",
            ),
            (
                "db/versions.rs",
                "select original_bytes, extracted_text, provenance",
                "`snapshot_file_version` runs INSIDE a write, capturing the content \
                 about to be overwritten. It must still snapshot a trashed file, or \
                 a restore would come back with a hole in its history.",
            ),
        ];

        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders: Vec<String> = Vec::new();
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("src is readable") {
                let path = entry.expect("dir entry").path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                    continue;
                }
                let rel = path.strip_prefix(&root).unwrap_or(&path).display().to_string();
                let text = std::fs::read_to_string(&path).expect("source is utf-8");
                // Rust string literals are the unit: a query written across
                // several lines is one literal, and collapsing whitespace makes
                // the line breaks and indentation invisible to the match. An
                // escaped quote is dropped first so it can't flip the parity
                // that tells literal from code.
                let flat = text
                    .replace("\\\"", "")
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");
                for (i, literal) in flat.split('"').enumerate() {
                    if i % 2 == 0 {
                        continue; // outside a string literal
                    }
                    let sql = literal.to_lowercase();
                    let reads_files = sql.contains("select") && sql.contains("from files");
                    // Single-row by id — the shape that outlives the file. A
                    // listing is covered by the other trash tests.
                    let by_id = sql.contains("where id = ?1") || sql.contains("where f.id = ?1");
                    if !reads_files || !by_id || sql.contains("trashed") {
                        continue;
                    }
                    if ALLOWED.iter().any(|(f, stmt, _)| *f == rel && sql.contains(stmt)) {
                        continue;
                    }
                    offenders.push(format!("{rel}: {literal}"));
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "a by-id read with no trash filter hands a deleted file's content back to \
             whatever still holds its id — see `get_file_meta`'s doc comment. Add \
             `AND trashed_at IS NULL`, or list it in ALLOWED above with the reason. \
             Offenders: {offenders:#?}",
        );
    }
}
