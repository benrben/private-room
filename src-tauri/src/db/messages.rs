use super::*;

/// Escape the LIKE wildcards in a user's search text so `%` and `_` match
/// themselves. `%` and `_` are the only two characters SQLite's LIKE treats
/// specially, so searching "50%" silently matched every row containing "50" and
/// "a_b" matched "axb". Every `LIKE '%' || ?1 || '%'` query must pair this with
/// `ESCAPE '\'` — see `messages_like` below for the shape.
pub fn like_escape(needle: &str) -> String {
    let mut out = String::with_capacity(needle.len());
    for c in needle.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// How many words of a query are actually matched on. A query is a handful of
/// words; the cap only stops a pasted paragraph from building a statement with
/// a hundred `LIKE` clauses in it. Words past the cap are IGNORED, which widens
/// the result set — never narrows it — so nothing a user typed can silently
/// remove a row that the words we did use match.
const MAX_SEARCH_TERMS: usize = 8;

/// The words a hit must contain, escaped and ready to bind.
///
/// Search used to be ONE literal substring, so "diarisation speaker" found
/// nothing in a room full of "speaker diarisation" — the words were right and
/// the order was not. Splitting on whitespace and requiring ALL of them, in any
/// order, is what people already expect of a search box. A query with no
/// whitespace behaves exactly as it always did.
pub fn search_terms(needle: &str) -> Vec<String> {
    needle
        .split_whitespace()
        .take(MAX_SEARCH_TERMS)
        .map(like_escape)
        .collect()
}

/// `AND lower(<col>) LIKE …` once per term, numbered from `first_param`.
///
/// Returned as SQL text rather than as a fixed clause because the term count is
/// the user's, not ours. Every clause carries `ESCAPE '\'` — `search_terms`
/// escapes the wildcards, and an escape without the clause does nothing.
pub fn like_all_clause(col: &str, terms: &[String], first_param: usize) -> String {
    terms
        .iter()
        .enumerate()
        .map(|(i, _)| {
            format!(" AND lower({col}) LIKE '%' || ?{} || '%' ESCAPE '\\'", first_param + i)
        })
        .collect()
}

/// ADD-6: chat messages containing every word of `needle` (already lowercased),
/// in any order — (chat id, message id, content). Orphan (chat_id NULL) rows are
/// skipped. The words are taken literally: their LIKE wildcards are escaped
/// here, so callers pass the user's raw text.
pub fn messages_like(conn: &Connection, needle: &str) -> Result<Vec<(String, String, String)>, String> {
    let terms = search_terms(needle);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT chat_id, id, content FROM messages WHERE chat_id IS NOT NULL{}
         ORDER BY rowid DESC LIMIT 30",
        like_all_clause("content", &terms, 1),
    );
    query_rows(conn, &sql, rusqlite::params_from_iter(terms), |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
    })
}

/// Insert a new message and return it (with the row's assigned timestamp).
/// `effects` is the structured viewer payload (boxes/annotation) for the
/// turn, stored as JSON in its own column — never folded into `content`, so
/// the transcript stays plain prose (ADD-23).
pub fn insert_message(
    conn: &Connection,
    chat_id: &str,
    role: &str,
    content: &str,
    sources: &[String],
    effects: Option<&serde_json::Value>,
) -> Result<Message, String> {
    let id = Uuid::new_v4().to_string();
    let sources_json = serde_json::to_string(sources).map_err(|e| e.to_string())?;
    let effects_json = effects.map(|v| v.to_string());
    execute_one(
        conn,
        "INSERT INTO messages(id, chat_id, role, content, sources, effects)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, chat_id, role, content, sources_json, effects_json],
    )?;
    let created_at: String = query_one(
        conn,
        "SELECT created_at FROM messages WHERE id = ?1",
        [&id],
        |r| r.get(0),
    )?;
    Ok(Message {
        id,
        role: role.into(),
        content: content.into(),
        sources: sources.to_vec(),
        created_at,
        effects: effects.cloned(),
        kind: None,
    })
}

/// Room map: the `sources` list of the newest `limit` answers that cited
/// anything, newest first — one Vec of file NAMES per message.
///
/// Names, not ids, is what the column holds (see `insert_message`), so the
/// caller has to resolve them and must expect misses: a renamed file, or a
/// second run that `available_name` bumped to "X (2)", no longer matches the
/// name the answer was written with. An unresolved name is dropped, never
/// guessed at.
pub fn recent_message_sources(conn: &Connection, limit: usize) -> Result<Vec<Vec<String>>, String> {
    let raw: Vec<String> = query_rows(
        conn,
        "SELECT sources FROM messages
         WHERE sources IS NOT NULL AND sources <> '' AND sources <> '[]'
         ORDER BY rowid DESC LIMIT ?1",
        [limit as i64],
        |r| r.get(0),
    )?;
    Ok(raw
        .iter()
        .filter_map(|s| serde_json::from_str::<Vec<String>>(s).ok())
        .collect())
}

/// A context-handoff summary marker: `role='assistant'` (so it renders and
/// counts like a normal reply everywhere that isn't handoff-aware) but
/// `kind='handoff'` marks it as the compaction point — `recent_messages`
/// starts a turn's history from the latest one, and the frontend renders it
/// as a distinct divider rather than an ordinary chat bubble. `effects` — same
/// shape as `insert_message`'s — carries the post-handoff token-usage
/// snapshot (no LLM "ask" turn happens as part of a handoff, so no
/// `ask-token-usage` event would otherwise fire).
pub fn insert_handoff_message(
    conn: &Connection,
    chat_id: &str,
    summary: &str,
    effects: Option<&serde_json::Value>,
) -> Result<Message, String> {
    let id = Uuid::new_v4().to_string();
    let effects_json = effects.map(|v| v.to_string());
    execute_one(
        conn,
        "INSERT INTO messages(id, chat_id, role, content, sources, kind, effects)
         VALUES (?1, ?2, 'assistant', ?3, '[]', 'handoff', ?4)",
        params![id, chat_id, summary, effects_json],
    )?;
    let created_at: String = query_one(
        conn,
        "SELECT created_at FROM messages WHERE id = ?1",
        [&id],
        |r| r.get(0),
    )?;
    Ok(Message {
        id,
        role: "assistant".into(),
        content: summary.into(),
        sources: Vec::new(),
        created_at,
        effects: effects.cloned(),
        kind: Some("handoff".into()),
    })
}

/// All messages for a chat, oldest first.
pub fn list_messages(conn: &Connection, chat_id: &str) -> Result<Vec<Message>, String> {
    query_rows(
        conn,
        "SELECT id, role, content, sources, created_at, effects, kind FROM messages
         WHERE chat_id = ?1 ORDER BY rowid ASC",
        [chat_id],
        |r| {
            let sources_json: Option<String> = r.get(3)?;
            let effects_json: Option<String> = r.get(5)?;
            Ok(Message {
                id: r.get(0)?,
                role: r.get(1)?,
                content: r.get(2)?,
                sources: sources_json
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default(),
                created_at: r.get(4)?,
                effects: effects_json.and_then(|s| serde_json::from_str(&s).ok()),
                kind: r.get(6)?,
            })
        },
    )
}

/// ADD-9: delete one message by id (used by regenerate to drop the last
/// assistant reply before re-asking).
pub fn delete_message(conn: &Connection, id: &str) -> Result<(), String> {
    execute_one(conn, "DELETE FROM messages WHERE id = ?1", [id])
}

/// The most recent `limit` (role, content) pairs for a chat, newest first —
/// callers reverse this to get chronological order for a prompt.
///
/// Context handoff: if this chat has a `kind='handoff'` marker, history starts
/// there (that row's own content — the summary — included), not from the
/// chat's actual first message. So the model sees only the summary plus
/// whatever came after it, which is the entire point of "hand off" freeing up
/// context. A chat with no handoff marker is unaffected (falls back to 0,
/// i.e. every row qualifies).
pub fn recent_messages(
    conn: &Connection,
    chat_id: &str,
    limit: i64,
) -> Result<Vec<(String, String)>, String> {
    query_rows(
        conn,
        "SELECT role, content FROM messages
         WHERE chat_id = ?1
           AND rowid >= COALESCE(
                 (SELECT MAX(rowid) FROM messages WHERE chat_id = ?1 AND kind = 'handoff'),
                 0)
         ORDER BY rowid DESC LIMIT ?2",
        params![chat_id, limit],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
}

/// (file count, message count) for the room summary shown in RoomInfo.
///
/// The file half is [`room_file_count`], not a `count(*)` spelled out again
/// here: RoomInfo, the front page and the Library badge are all answering the
/// same question, so they ask it in one place.
pub fn room_counts(conn: &Connection) -> Result<(i64, i64), String> {
    let file_count = room_file_count(conn)?;
    let message_count: i64 = query_one(conn, "SELECT count(*) FROM messages", [], |r| r.get(0))?;
    Ok((file_count, message_count))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE messages (
               id TEXT PRIMARY KEY, chat_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL,
               sources TEXT, effects TEXT, kind TEXT,
               created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
             );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn like_wildcards_in_the_query_are_taken_literally() {
        let conn = mem();
        insert_message(&conn, "c1", "user", "the deposit is 50% of rent", &[], None).unwrap();
        insert_message(&conn, "c1", "user", "we owe 50 pounds", &[], None).unwrap();
        insert_message(&conn, "c1", "user", "table a_b", &[], None).unwrap();
        insert_message(&conn, "c1", "user", "table axb", &[], None).unwrap();
        // "50%" used to match "50 pounds" too — % is a LIKE wildcard.
        let hits = messages_like(&conn, "50%").unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].2.contains("50% of rent"));
        // "_" is the other one: it matched any single character.
        let hits = messages_like(&conn, "a_b").unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].2.ends_with("a_b"));
        // An ordinary query is unaffected.
        assert_eq!(messages_like(&conn, "deposit").unwrap().len(), 1);
        assert_eq!(like_escape("100% _sure_"), r"100\% \_sure\_");
    }

    #[test]
    fn every_word_has_to_appear_but_the_order_does_not() {
        // Search matched ONE literal substring, so a reader who typed the right
        // words in the wrong order got "nothing found" from a room that plainly
        // contained them.
        let conn = mem();
        insert_message(&conn, "c1", "user", "speaker diarisation notes", &[], None).unwrap();
        insert_message(&conn, "c1", "user", "diarisation of one speaker", &[], None).unwrap();
        insert_message(&conn, "c1", "user", "speakers at the conference", &[], None).unwrap();

        // Both orders find both rows that hold both words — and only those.
        for q in ["speaker diarisation", "diarisation speaker"] {
            let hits = messages_like(&conn, q).unwrap();
            assert_eq!(hits.len(), 2, "{q:?} found {hits:?}");
        }
        // A word that is missing still excludes the row: this is AND, not OR.
        assert!(messages_like(&conn, "speaker rhubarb").unwrap().is_empty());
        // Extra whitespace is not a term, and a whitespace-only query is not a
        // match-everything query.
        assert_eq!(messages_like(&conn, "  speaker   notes  ").unwrap().len(), 1);
        assert!(messages_like(&conn, "   ").unwrap().is_empty());
        // Wildcards stay literal per-word, exactly as for a one-word query.
        assert_eq!(search_terms("50% a_b"), vec![r"50\%", r"a\_b"]);
    }

    #[test]
    fn insert_message_leaves_kind_null() {
        let conn = mem();
        let m = insert_message(&conn, "c1", "user", "hi", &[], None).unwrap();
        assert_eq!(m.kind, None);
    }

    #[test]
    fn insert_handoff_message_sets_kind_and_effects() {
        let conn = mem();
        let usage = serde_json::json!({"total_tokens": 42});
        let m = insert_handoff_message(&conn, "c1", "the recap", Some(&usage)).unwrap();
        assert_eq!(m.role, "assistant");
        assert_eq!(m.content, "the recap");
        assert_eq!(m.kind.as_deref(), Some("handoff"));
        assert_eq!(m.effects.unwrap()["total_tokens"], 42);
    }

    #[test]
    fn recent_messages_limit_minus_one_means_no_limit() {
        // `#`-commands read the WHOLE conversation with limit -1 (SQLite's "no
        // limit") instead of the last 12 turns — if that ever stopped meaning
        // unlimited, every command would silently reason over an empty history.
        let conn = mem();
        for i in 0..40 {
            insert_message(&conn, "c1", "user", &format!("m{i}"), &[], None).unwrap();
        }
        assert_eq!(recent_messages(&conn, "c1", -1).unwrap().len(), 40);
        assert_eq!(recent_messages(&conn, "c1", 12).unwrap().len(), 12);
    }

    #[test]
    fn recent_messages_returns_everything_with_no_handoff_marker() {
        let conn = mem();
        insert_message(&conn, "c1", "user", "one", &[], None).unwrap();
        insert_message(&conn, "c1", "assistant", "two", &[], None).unwrap();
        let rows = recent_messages(&conn, "c1", 10).unwrap();
        // newest-first
        assert_eq!(rows, vec![("assistant".into(), "two".into()), ("user".into(), "one".into())]);
    }

    #[test]
    fn recent_messages_truncates_at_the_latest_handoff_marker() {
        let conn = mem();
        insert_message(&conn, "c1", "user", "old question", &[], None).unwrap();
        insert_message(&conn, "c1", "assistant", "old answer", &[], None).unwrap();
        insert_handoff_message(&conn, "c1", "recap of the above", None).unwrap();
        insert_message(&conn, "c1", "user", "new question", &[], None).unwrap();

        let rows = recent_messages(&conn, "c1", 10).unwrap();
        // The pre-handoff turns are gone; the marker's own content (the recap)
        // IS included — it's the model's first "turn" going forward.
        assert_eq!(
            rows,
            vec![
                ("user".into(), "new question".into()),
                ("assistant".into(), "recap of the above".into()),
            ]
        );
        assert!(!rows.iter().any(|(_, c)| c == "old question" || c == "old answer"));
    }

    #[test]
    fn recent_messages_uses_the_latest_of_several_handoff_markers() {
        let conn = mem();
        insert_message(&conn, "c1", "user", "turn 1", &[], None).unwrap();
        insert_handoff_message(&conn, "c1", "first recap", None).unwrap();
        insert_message(&conn, "c1", "user", "turn 2", &[], None).unwrap();
        insert_handoff_message(&conn, "c1", "second recap", None).unwrap();
        insert_message(&conn, "c1", "user", "turn 3", &[], None).unwrap();

        let rows = recent_messages(&conn, "c1", 10).unwrap();
        let contents: Vec<&str> = rows.iter().map(|(_, c)| c.as_str()).collect();
        assert_eq!(contents, vec!["turn 3", "second recap"]);
    }

    #[test]
    fn list_messages_shows_the_handoff_marker_in_place() {
        let conn = mem();
        insert_message(&conn, "c1", "user", "q", &[], None).unwrap();
        insert_handoff_message(&conn, "c1", "recap", None).unwrap();
        insert_message(&conn, "c1", "user", "q2", &[], None).unwrap();

        let all = list_messages(&conn, "c1").unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[1].kind.as_deref(), Some("handoff"));
        assert_eq!(all[0].kind, None);
        assert_eq!(all[2].kind, None);
    }
}
