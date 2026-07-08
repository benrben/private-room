use super::*;

/// ADD-6: search the user's own room across file names + content, chat
/// messages, and memories. File content rides the FTS5 index (HLT-3); messages
/// and memories use LIKE. Every hit carries a short snippet for the overlay.
#[tauri::command]
pub fn search_all(state: State<'_, AppState>, query: String) -> Result<SearchResults, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let conn = &room.conn;
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(SearchResults {
            files: Vec::new(),
            messages: Vec::new(),
            memories: Vec::new(),
        });
    }
    let needle = trimmed.to_lowercase();

    // Files: content hits (FTS) first, then name-only matches not already shown.
    let mut files: Vec<FileHit> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Some(expr) = fts_match_expr(question_terms(trimmed).iter().map(String::as_str))
        .or_else(|| fts_match_expr(std::iter::once(needle.as_str())))
    {
        for (id, name, chunk) in db::files_content_fts(conn, &expr, 15)? {
            if seen.insert(id.clone()) {
                files.push(FileHit {
                    id,
                    name,
                    snippet: make_snippet(&chunk, trimmed, 60),
                });
            }
        }
    }
    for (id, name) in db::files_name_like(conn, &needle)? {
        if seen.insert(id.clone()) {
            files.push(FileHit {
                snippet: name.clone(),
                id,
                name,
            });
        }
    }

    let messages = db::messages_like(conn, &needle)?
        .into_iter()
        .map(|(chat_id, message_id, content)| MessageHit {
            chat_id,
            message_id,
            snippet: make_snippet(&content, trimmed, 60),
        })
        .collect();

    let memories = db::memories_like(conn, &needle)?
        .into_iter()
        .map(|(id, content)| MemoryHit {
            snippet: make_snippet(&content, trimmed, 60),
            id,
        })
        .collect();

    Ok(SearchResults {
        files,
        messages,
        memories,
    })
}

// ---------------------------------------------------------------- settings

