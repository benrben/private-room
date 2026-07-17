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
    let conn = &room.conn;
    let recent_files: Vec<FileMeta> = db::list_files(conn)?
        .into_iter()
        .filter(|f| !is_summary_file(&f.name, &f.source))
        .take(5)
        .collect();
    let recent_chats: Vec<Chat> = db::list_chats(conn)?.into_iter().take(5).collect();
    let memories = db::list_memories(conn)?;
    let file_count: i64 = conn.query_row("SELECT count(*) FROM files", [], |r| r.get(0)).unwrap_or(0);
    let chat_count: i64 = conn.query_row("SELECT count(*) FROM chats", [], |r| r.get(0)).unwrap_or(0);
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
    let (room_name, file_names, cached) = {
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
        (room.name.clone(), names, cached)
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
    if let Some(room) = state.room.lock().unwrap().as_ref() {
        if let Ok(json) = serde_json::to_string(&questions) {
            let _ = db::set_meta(&room.conn, FRONT_PAGE_SUGGESTIONS_KEY, &json);
        }
    }
    Ok(questions)
}
