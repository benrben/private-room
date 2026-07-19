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
    })
}

/// All messages for a chat, oldest first.
pub fn list_messages(conn: &Connection, chat_id: &str) -> Result<Vec<Message>, String> {
    query_rows(
        conn,
        "SELECT id, role, content, sources, created_at, effects FROM messages
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
pub fn recent_messages(
    conn: &Connection,
    chat_id: &str,
    limit: i64,
) -> Result<Vec<(String, String)>, String> {
    query_rows(
        conn,
        "SELECT role, content FROM messages WHERE chat_id = ?1
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
