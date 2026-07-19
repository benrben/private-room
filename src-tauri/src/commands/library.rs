use super::*;

/// UX-5: an existing memory whose normalized text equals `content`'s, if any.
/// Shared by the UI command and the AI tool so neither path can create an exact
/// duplicate (ignoring case and whitespace).
pub(crate) fn duplicate_memory(conn: &Connection, content: &str) -> Result<Option<Memory>, String> {
    let norm = normalize_for_match(content);
    Ok(db::list_memories(conn)?
        .into_iter()
        .find(|m| normalize_for_match(&m.content) == norm))
}

/// Wave 1b (idea 5): fold a raw category string onto the fixed vocabulary.
/// Anything else (misspellings, free-form tags, empty) → None, never an error —
/// a 4B model cannot be trusted to reproduce an enum exactly.
pub(crate) fn normalize_category(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "preference" => Some("preference"),
        "fact" => Some("fact"),
        "project" => Some("project"),
        "instruction" => Some("instruction"),
        _ => None,
    }
}

#[tauri::command]
pub fn add_memory(
    state: State<'_, AppState>,
    content: String,
    category: Option<String>,
) -> Result<Memory, String> {
    state.with_room(|room| {
        // CHG-7: cap length so injected memories stay within the prompt budget.
        let content = clamp_bytes(content, MAX_MEMORY_CONTENT_CHARS);
        // UX-5: never store an exact duplicate; hand back the existing entry
        // instead (callers can tell by its old created_at).
        if let Some(existing) = duplicate_memory(&room.conn, &content)? {
            return Ok(existing);
        }
        let category = category.as_deref().and_then(normalize_category);
        db::add_memory(&room.conn, &content, category)
    })
}

#[tauri::command]
pub fn list_memories(state: State<'_, AppState>) -> Result<Vec<Memory>, String> {
    state.with_room(|room| db::list_memories(&room.conn))
}

/// UX-5: edit a memory's text (and, Wave 1b, its category) in place.
#[tauri::command]
pub fn update_memory(
    state: State<'_, AppState>,
    id: String,
    content: String,
    category: Option<String>,
) -> Result<(), String> {
    state.with_room(|room| {
        let content = clamp_bytes(content, MAX_MEMORY_CONTENT_CHARS);
        let category = category.as_deref().and_then(normalize_category);
        db::update_memory(&room.conn, &id, &content, category)
    })
}

#[tauri::command]
pub fn delete_memory(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.with_room(|room| db::delete_memory(&room.conn, &id))
}

// ---------------------------------------------------------------- folders (ADD-16)

#[tauri::command]
pub fn list_folders(state: State<'_, AppState>) -> Result<Vec<Folder>, String> {
    state.with_room(|room| db::list_folders(&room.conn))
}

#[tauri::command]
pub fn create_folder(state: State<'_, AppState>, name: String) -> Result<Folder, String> {
    state.with_room(|room| db::create_folder(&room.conn, &name))
}

#[tauri::command]
pub fn rename_folder(state: State<'_, AppState>, id: String, name: String) -> Result<(), String> {
    state.with_room(|room| db::rename_folder(&room.conn, &id, &name))
}

#[tauri::command]
pub fn delete_folder(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.with_room(|room| db::delete_folder(&room.conn, &id))
}

#[tauri::command]
pub fn move_file_to_folder(
    state: State<'_, AppState>,
    file_id: String,
    folder_id: Option<String>,
) -> Result<(), String> {
    state.with_room(|room| db::move_file_to_folder(&room.conn, &file_id, folder_id.as_deref()))
}

// ---------------------------------------------------------------- search (ADD-6)

#[tauri::command]
pub fn get_setting(state: State<'_, AppState>, key: String) -> Result<Option<String>, String> {
    state.with_room(|room| Ok(db::get_setting(&room.conn, &key)))
}

#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    state.with_room(|room| db::set_setting(&room.conn, &key, &value))
}

// ---------------------------------------------------------------- mcp


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_dedup_normalization() {
        // UX-5: dedup keys on normalize_for_match, so case and spacing
        // differences collapse to the same key (an exact duplicate).
        assert_eq!(
            normalize_for_match("The dog is named Rex"),
            normalize_for_match("the   dog  is named rex")
        );
        // A genuinely different fact keeps a distinct key.
        assert_ne!(
            normalize_for_match("The dog is named Rex"),
            normalize_for_match("The cat is named Rex")
        );
    }

    #[test]
    fn normalize_category_accepts_vocab_rejects_junk() {
        // The fixed vocabulary, case/whitespace-tolerant…
        assert_eq!(normalize_category("preference"), Some("preference"));
        assert_eq!(normalize_category(" Fact "), Some("fact"));
        assert_eq!(normalize_category("PROJECT"), Some("project"));
        assert_eq!(normalize_category("instruction"), Some("instruction"));
        // …and everything else degrades to uncategorized, never an error.
        assert_eq!(normalize_category("preferences"), None);
        assert_eq!(normalize_category("misc"), None);
        assert_eq!(normalize_category(""), None);
    }
}
