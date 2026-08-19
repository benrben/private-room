use super::*;

/// How many FILES the overlay's Files group may list from content hits.
const FILE_CONTENT_HITS: usize = 15;

/// The file-CONTENT expression for a search the user typed, requiring EVERY
/// term — the rule the other three queries already follow.
///
/// [`fts_match_expr`] OR-joins its terms, which is right where it came from:
/// retrieval feeds a question to a model and wants recall. In a result list a
/// person reads it meant one query had two meanings at once — "deposit refund"
/// listed every document mentioning only deposits, next to a Messages group
/// restricted (by `like_all_clause`) to rows containing both words. Quoting
/// stays with `fts_match_expr` so a term with punctuation, or an FTS keyword
/// like "near", is escaped exactly once and in one place.
///
/// What "every term" means here is the FTS row, which for file content is ONE
/// ~1,200-character chunk — not the whole document. So a long file that says
/// "deposit" on page 2 and "refund" on page 30 is not a content hit for
/// "deposit refund", the same way a chat message is only a hit when one message
/// holds both words. Say so rather than let the AND read as document-wide.
fn fts_match_all<'a>(terms: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let quoted: Vec<String> = terms
        .into_iter()
        .filter_map(|t| fts_match_expr(std::iter::once(t)))
        .collect();
    if quoted.is_empty() {
        None
    } else {
        Some(quoted.join(" AND "))
    }
}

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
    if let Some(expr) = fts_match_all(question_terms(trimmed).iter().map(String::as_str))
        .or_else(|| fts_match_all(std::iter::once(needle.as_str())))
    {
        // `files_content_fts` limits CHUNKS, and one long document can own all
        // of the best-ranked ones — a 15-chunk fetch then listed a single file
        // and dropped every other document that matched, unreachably. Over-fetch
        // and stop at the first N distinct files instead (the shape
        // `db::fts_file_matches` already uses for the room map).
        for (id, name, chunk) in db::files_content_fts(conn, &expr, FILE_CONTENT_HITS * 20)? {
            if files.len() >= FILE_CONTENT_HITS {
                break;
            }
            if seen.insert(id.clone()) {
                files.push(FileHit {
                    id,
                    name,
                    snippet: make_snippet(&chunk, trimmed, 60),
                });
            }
        }
    }
    // Name-only matches carry NO snippet. The row already shows the name (which
    // is where the match is), so repeating it as the preview line said the same
    // thing twice — and the overlay hands the snippet to the viewer as the text
    // to jump to, so a file name sent the viewer looking for words the document
    // does not contain and nothing was highlighted.
    for (id, name) in db::files_name_like(conn, &needle)? {
        if seen.insert(id.clone()) {
            files.push(FileHit {
                id,
                name,
                snippet: String::new(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_content_search_requires_every_word_the_user_typed() {
        // The Files group used to OR its terms while names, messages and
        // memories all required ALL of them: one query, two meanings, side by
        // side in one result list.
        assert_eq!(
            fts_match_all(["deposit", "refund"]).as_deref(),
            Some("\"deposit\" AND \"refund\""),
        );
        // A single term is that term — including the whole-phrase fallback the
        // caller uses when every word was a stopword.
        assert_eq!(fts_match_all(["rent"]).as_deref(), Some("\"rent\""));
        assert_eq!(
            fts_match_all(["what about rent"]).as_deref(),
            Some("\"what about rent\""),
        );
        // Terms that quote away to nothing are dropped, not AND-ed in as an
        // empty phrase that no row can contain.
        assert_eq!(fts_match_all(["", "rent"]).as_deref(), Some("\"rent\""));
        // Nothing usable stays None, so the caller skips the content query
        // rather than running a MATCH with no expression in it.
        assert_eq!(fts_match_all(std::iter::empty::<&str>()), None);
        assert_eq!(fts_match_all([""]), None);
    }
}

// ---------------------------------------------------------------- settings

