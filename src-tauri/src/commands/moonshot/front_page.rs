use super::*;

// ---- D4: front page ---------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FrontPage {
    pub recent_files: Vec<FileMeta>,
    pub recent_chats: Vec<Chat>,
    pub memories: Vec<Memory>,
    pub suggestions: Vec<String>,
    pub file_count: i64,
    pub chat_count: i64,
}

pub(crate) const FRONT_PAGE_SUGGESTIONS_KEY: &str = "front_page_suggestions";

/// D4: the instant, model-free landing view shown on unlock. It only reads stored
/// rows and returns any cached suggestions, so it never blocks the unlock. Fresh
/// suggestions come from the lazy `front_page_suggestions` the frontend calls
/// after painting.
#[tauri::command]
pub fn front_page(state: State<'_, AppState>) -> Result<FrontPage, String> {
    let guard = state.room.lock().unwrap();
    let Some(room) = guard.as_ref() else {
        return Ok(FrontPage {
            recent_files: Vec::new(),
            recent_chats: Vec::new(),
            memories: Vec::new(),
            suggestions: Vec::new(),
            file_count: 0,
            chat_count: 0,
        });
    };
    front_page_of(&room.conn)
}

/// The front page as a pure function of the room's DB. Split out of the command
/// so the counts it publishes can be checked against the other count surfaces
/// (`db::room_counts`, `db::list_files`) in a test, without a live app.
fn front_page_of(conn: &rusqlite::Connection) -> Result<FrontPage, String> {
    let recent_files: Vec<FileMeta> = db::list_files(conn)?
        .into_iter()
        .filter(|f| !is_summary_file(&f.name, &f.source))
        .take(5)
        .collect();
    let recent_chats: Vec<Chat> = db::list_chats(conn)?.into_iter().take(5).collect();
    let memories = db::list_memories(conn)?;
    // Trash: `room_file_count` carries the same predicate `list_files` (just
    // above) uses, so the count and the list on this page cannot disagree about
    // what is in the room.
    let file_count: i64 = db::room_file_count(conn)?;
    // Both counts propagate rather than falling back to 0. A "0 files, 0 chats"
    // front page is what `ViewerPane` reads as "this room is empty", and saying
    // that because a query failed is a claim about the room the app never
    // checked. The listing above already `?`s on this same connection, so an
    // error here is the same failure, reported the same way.
    let chat_count: i64 = conn
        .query_row("SELECT count(*) FROM chats", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let suggestions = db::get_meta(conn, FRONT_PAGE_SUGGESTIONS_KEY)
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default();
    Ok(FrontPage {
        recent_files,
        recent_chats,
        memories,
        suggestions,
        file_count,
        chat_count,
    })
}

/// D4: generate up to three short starter questions grounded in the room's name
/// and file list, cache them in `meta`, and return them. Degrades to the cached
/// list (or empty) when the model is unreachable or the room is empty.
#[tauri::command]
pub async fn front_page_suggestions(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let (room_path, room_name, file_names, cached) = {
        let guard = state.room.lock().unwrap();
        let Some(room) = guard.as_ref() else {
            return Ok(Vec::new());
        };
        let names: Vec<String> = db::list_files(&room.conn)?
            .into_iter()
            .filter(|f| !is_summary_file(&f.name, &f.source))
            .take(30)
            .map(|f| f.name)
            .collect();
        let cached = db::get_meta(&room.conn, FRONT_PAGE_SUGGESTIONS_KEY)
            .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
            .unwrap_or_default();
        (room.path.clone(), room.name.clone(), names, cached)
    };
    if file_names.is_empty() {
        return Ok(Vec::new());
    }
    let model = match resolve_structured_model(&state).await {
        Some(m) => m,
        None => return Ok(cached), // offline: reuse whatever we cached before
    };
    // The prompt/schema/parse (keep every non-blank question, take 3) now live in
    // the sidecar's /label. It is resilient by design — any engine failure or
    // unparseable reply comes back as 200 {questions: []}, mirroring the old
    // `chat_structured(...).unwrap_or_default()`. So a mapped-error here is only a
    // dead sidecar; we degrade to the cached list exactly as offline does.
    let body = serde_json::json!({
        "model": model,
        "base_url": ollama::resolved_base_url(),
        "room_name": room_name,
        "files": file_names,
    });
    let questions: Vec<String> = match crate::sidecar::sidecar_json("/label", &body).await {
        Ok(v) => v["questions"]
            .as_array()
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    if questions.is_empty() {
        return Ok(cached);
    }
    // These questions name THIS room's files. The model call above can take
    // minutes, so cache them only if the same room is still open — unlocking
    // another one mid-generation used to file one room's questions in another.
    if let Some(room) = state.room.lock().unwrap().as_ref() {
        if room.path == room_path {
            if let Ok(json) = serde_json::to_string(&questions) {
                let _ = db::set_meta(&room.conn, FRONT_PAGE_SUGGESTIONS_KEY, &json);
            }
        }
    }
    Ok(questions)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The front page publishes a count and a list. Owner's ruling (2026-08-03):
    /// a count means "what is in this room" — every kind of thing, nothing left
    /// out for being generated by the app or fetched by the browser — so the
    /// number here has to be the same number `room_counts` and the Library badge
    /// show, and it has to move when a file is deleted.
    ///
    /// This is the site the trash work missed: `file_count` was a bare
    /// `count(*) FROM files` while `recent_files` filtered trashed rows out, so
    /// a room whose only file had been deleted reported `file_count: 1` with an
    /// empty list, and `ViewerPane`'s "this room has things in it" gate held.
    #[test]
    fn the_front_page_count_is_the_same_count_everyone_else_shows() {
        let conn = crate::db::mem();
        crate::db::insert_file(&conn, "lease.pdf", "application/pdf", b"%PDF", Some("rent"), "upload").unwrap();
        crate::db::insert_file_from_url(
            &conn, "Google News.md", "text/markdown", b"page", Some("page"), "web",
            Some("https://news.google.com"),
        ).unwrap();
        // The fidelity twin a saved page also writes: no extracted text of its
        // own, still a file the room holds.
        crate::db::insert_file_from_url(
            &conn, "Google News.html", "text/html", b"<p>page</p>", None, "web",
            Some("https://news.google.com"),
        ).unwrap();
        crate::db::insert_file_from_url(
            &conn, "report.pdf", "application/pdf", b"%PDF", None, "download",
            Some("https://example.test/report.pdf"),
        ).unwrap();
        let temp = crate::db::insert_file(
            &conn, "Full pass — lease.pdf.html", "text/html", b"<p>x</p>", None, "generated",
        ).unwrap();
        crate::db::insert_file(&conn, "Room summary.md", "text/markdown", b"s", Some("s"), "generated").unwrap();

        let fp = front_page_of(&conn).unwrap();
        assert_eq!(fp.file_count, 6, "browser pages, downloads and generated artifacts are all in the room");
        assert_eq!(fp.file_count, crate::db::room_counts(&conn).unwrap().0, "RoomInfo agrees");
        // `list_files` is what this page's own strip is drawn from — NOT the
        // Library badge, which is the narrower question and is answered in
        // `isLibraryVisible` (fileVisibility.ts). The label used to say badge.
        assert_eq!(
            fp.file_count,
            crate::db::list_files(&conn).unwrap().len() as i64,
            "the strip this page draws agrees"
        );
        // The summary file is kept off the recent-files STRIP (it is the app's
        // own output, not something to reopen) — that is a display choice and
        // must not shrink the count.
        assert!(fp.recent_files.iter().all(|f| f.name != "Room summary.md"));

        crate::db::trash_file(&conn, &temp.id, crate::db::TrashActor::User).unwrap();
        let fp = front_page_of(&conn).unwrap();
        assert_eq!(fp.file_count, 5, "a deleted file is not in the room any more");
        assert_eq!(fp.file_count, crate::db::room_counts(&conn).unwrap().0);
        assert_eq!(fp.file_count, crate::db::list_files(&conn).unwrap().len() as i64);
    }

    /// Home shows two numbers and they are two questions: this page counts the
    /// ROOM, the sidebar badge counts the LIBRARY. A section-only sketch is in
    /// the first and not the second — the owner's 2026-08-03 ruling, spelled out
    /// in `db::room_file_count`'s contract. Pinned here because this is the page
    /// where the two sit side by side and reading one as the other is the easy
    /// mistake.
    #[test]
    fn a_section_only_sketch_is_counted_by_the_room_not_by_the_library() {
        let conn = crate::db::mem();
        crate::db::insert_file(&conn, "lease.pdf", "application/pdf", b"%PDF", Some("rent"), "upload")
            .unwrap();
        let sketch = crate::db::insert_file(
            &conn, "Untitled.sketch", "application/json", b"{}", None, "generated",
        )
        .unwrap();
        crate::db::mark_section_only(&conn, &sketch.id, "sketch");

        let fp = front_page_of(&conn).unwrap();
        assert_eq!(fp.file_count, 2, "a sketch is a file the room holds");
        // Which rows Home leaves out is asked of production code, not restated
        // here: `db::placement_note` is the Rust side's own "not in the
        // Library", so if that rule moves this moves with it.
        let kept_out = crate::db::list_files(&conn)
            .unwrap()
            .into_iter()
            .filter(|f| {
                !crate::db::placement_note(&f.origin_destination, &f.library_visibility).is_empty()
            })
            .count();
        assert_eq!(kept_out, 1, "one of the two rows is kept out of the Library");
    }
}
