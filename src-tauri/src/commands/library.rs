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

/// CHG-7: memories are injected into the prompt, so their length is capped —
/// but the cap REFUSES rather than truncates, the way the agent's own
/// `add_memory` tool already does (agent.rs).
///
/// Cutting the text at the cap was silent and unrecoverable: a 1,200-character
/// note came back 500 characters long with no warning, no marker and no toast,
/// and memories have no version history to restore the rest from. Both commands
/// below surface this through `tryToast`, so the user is told before anything is
/// destroyed and their text is still on screen to shorten.
///
/// Counted in CHARACTERS, like the cap itself: counting bytes ate a note typed
/// in Hebrew at half its length while the same note in English went through.
fn memory_within_cap(content: String) -> Result<String, String> {
    let len = content.chars().count();
    if len > MAX_MEMORY_CONTENT_CHARS {
        return Err(format!(
            "That memory is {len} characters — {MAX_MEMORY_CONTENT_CHARS} at most, \
             so it stays short enough to travel with every question."
        ));
    }
    Ok(content)
}

#[tauri::command]
pub fn add_memory(
    state: State<'_, AppState>,
    content: String,
    category: Option<String>,
) -> Result<Memory, String> {
    state.with_room(|room| {
        let content = memory_within_cap(content)?;
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
        let content = memory_within_cap(content)?;
        let category = category.as_deref().and_then(normalize_category);
        db::update_memory(&room.conn, &id, &content, category)
    })
}

#[tauri::command]
pub fn delete_memory(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.with_room(|room| db::delete_memory(&room.conn, &id, db::TrashActor::User))
}

/// S9 (2026-08-04): put a soft-deleted memory back. Not reachable from the
/// agent — recovery is a human action, same posture as file restore.
#[tauri::command]
pub fn restore_memory(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.with_room(|room| db::restore_memory(&room.conn, &id))
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
pub fn set_setting(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    state.with_room(|room| db::set_setting(&room.conn, &key, &value))?;
    // PRIV-1: privacy keys written through the generic path (or a model change,
    // which alters the guard model) keep the cached policy current.
    if key.starts_with("cloud_privacy") || key == "model" {
        refresh_policy(&app, &state);
    }
    Ok(())
}

// ---------------------------------------------------------------- mcp


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_over_long_memory_is_refused_rather_than_quietly_cut_in_half() {
        // Exactly the cap is a memory, not an error.
        let at_cap = "a".repeat(MAX_MEMORY_CONTENT_CHARS);
        assert_eq!(
            memory_within_cap(at_cap.clone()).unwrap().chars().count(),
            MAX_MEMORY_CONTENT_CHARS,
        );
        assert_eq!(memory_within_cap(String::new()).unwrap(), "");
        // One past it is refused — the paragraph used to come back 500
        // characters long, with the rest gone and nothing to restore it from.
        let over = "a".repeat(MAX_MEMORY_CONTENT_CHARS + 1);
        let err = memory_within_cap(over).expect_err("truncation is not an answer");
        assert!(err.contains(&(MAX_MEMORY_CONTENT_CHARS + 1).to_string()), "{err}");
        // Counted in CHARACTERS: a full-length note typed in Hebrew is twice
        // the cap in bytes, and counting those ate half of it.
        let hebrew = "א".repeat(MAX_MEMORY_CONTENT_CHARS);
        assert!(hebrew.len() > MAX_MEMORY_CONTENT_CHARS, "the fixture must be multi-byte");
        assert_eq!(memory_within_cap(hebrew.clone()).unwrap(), hebrew);
    }

    /// The rule above is only worth having if BOTH commands still ask it. They
    /// take a `State` and cannot be called from a unit test, so the call sites
    /// are pinned textually — this repo's own answer for a seam a test cannot
    /// reach (see `ollama_lifecycle`'s `include_str!` guard).
    #[test]
    fn both_memory_commands_check_the_cap_before_storing() {
        let source = include_str!("library.rs");
        // Split so this test's own text is not one of the matches it counts —
        // `concat!` rebuilds the needle at compile time while the source line
        // stays broken in two.
        let checked = concat!("memory_within", "_cap(content)?");
        let truncating = concat!("clamp_", "chars(content, MAX_MEMORY_CONTENT_CHARS)");
        assert_eq!(
            source.matches(checked).count(),
            2,
            "add_memory and update_memory must both refuse an over-long memory"
        );
        assert_eq!(
            source.matches(truncating).count(),
            0,
            "silently cutting the text at the cap destroys the rest of a note that \
             has no version history to restore it from"
        );
    }

    #[test]
    fn a_trashed_memory_does_not_block_re_adding_the_same_text() {
        // S9: duplicate_memory rides on db::list_memories, which now excludes
        // trashed rows — trashing "buy milk" must not permanently block ever
        // adding "buy milk" again.
        let conn = db::open_in_memory_schema();
        let m1 = db::add_memory(&conn, "buy milk", None).unwrap();
        assert!(
            duplicate_memory(&conn, "buy milk").unwrap().is_some(),
            "an active memory is still a duplicate"
        );
        db::delete_memory(&conn, &m1.id, db::TrashActor::User).unwrap();
        assert!(
            duplicate_memory(&conn, "buy milk").unwrap().is_none(),
            "a trashed memory must not count as an existing duplicate"
        );
    }

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
