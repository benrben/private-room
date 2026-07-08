use super::*;

/// ADD-6: chat messages whose content contains `needle` (already lowercased) —
/// (chat id, message id, content). Orphan (chat_id NULL) rows are skipped.
pub fn messages_like(conn: &Connection, needle: &str) -> Result<Vec<(String, String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT chat_id, id, content FROM messages
             WHERE chat_id IS NOT NULL AND lower(content) LIKE '%' || ?1 || '%'
             ORDER BY rowid DESC LIMIT 30",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([needle], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Insert a new message and return it (with the row's assigned timestamp).
pub fn insert_message(
    conn: &Connection,
    chat_id: &str,
    role: &str,
    content: &str,
    sources: &[String],
) -> Result<Message, String> {
    let id = Uuid::new_v4().to_string();
    let sources_json = serde_json::to_string(sources).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO messages(id, chat_id, role, content, sources) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, chat_id, role, content, sources_json],
    )
    .map_err(|e| e.to_string())?;
    let created_at: String = conn
        .query_row("SELECT created_at FROM messages WHERE id = ?1", [&id], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    Ok(Message {
        id,
        role: role.into(),
        content: content.into(),
        sources: sources.to_vec(),
        created_at,
    })
}

/// All messages for a chat, oldest first.
pub fn list_messages(conn: &Connection, chat_id: &str) -> Result<Vec<Message>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, role, content, sources, created_at FROM messages
             WHERE chat_id = ?1 ORDER BY rowid ASC",
        )
        .map_err(|e| e.to_string())?;
    let messages = stmt
        .query_map([chat_id], |r| {
            let sources_json: Option<String> = r.get(3)?;
            Ok(Message {
                id: r.get(0)?,
                role: r.get(1)?,
                content: r.get(2)?,
                sources: sources_json
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default(),
                created_at: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(messages)
}

/// ADD-9: delete one message by id (used by regenerate to drop the last
/// assistant reply before re-asking).
pub fn delete_message(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM messages WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The most recent `limit` (role, content) pairs for a chat, newest first —
/// callers reverse this to get chronological order for a prompt.
pub fn recent_messages(
    conn: &Connection,
    chat_id: &str,
    limit: i64,
) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT role, content FROM messages WHERE chat_id = ?1
             ORDER BY rowid DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![chat_id, limit], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// (file count, message count) for the room summary shown in RoomInfo.
pub fn room_counts(conn: &Connection) -> Result<(i64, i64), String> {
    let file_count: i64 = conn
        .query_row("SELECT count(*) FROM files", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let message_count: i64 = conn
        .query_row("SELECT count(*) FROM messages", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok((file_count, message_count))
}
