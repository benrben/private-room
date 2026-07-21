use super::*;

/// ADD-6: chat messages whose content contains `needle` (already lowercased) —
/// (chat id, message id, content). Orphan (chat_id NULL) rows are skipped.
pub fn messages_like(conn: &Connection, needle: &str) -> Result<Vec<(String, String, String)>, String> {
    query_rows(
        conn,
        "SELECT chat_id, id, content FROM messages
         WHERE chat_id IS NOT NULL AND lower(content) LIKE '%' || ?1 || '%'
         ORDER BY rowid DESC LIMIT 30",
        [needle],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
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
pub fn room_counts(conn: &Connection) -> Result<(i64, i64), String> {
    let file_count: i64 = query_one(conn, "SELECT count(*) FROM files", [], |r| r.get(0))?;
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
