use super::*;

pub fn list_chats(conn: &Connection) -> Result<Vec<Chat>, String> {
    let mut stmt = conn
        .prepare("SELECT id, title, created_at FROM chats ORDER BY created_at DESC, rowid DESC")
        .map_err(|e| e.to_string())?;
    let chats = stmt
        .query_map([], |r| {
            Ok(Chat {
                id: r.get(0)?,
                title: r.get(1)?,
                created_at: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(chats)
}

pub fn create_chat(conn: &Connection) -> Result<Chat, String> {
    let id = Uuid::new_v4().to_string();
    conn.execute("INSERT INTO chats(id, title) VALUES (?1, 'New chat')", [&id])
        .map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id, title, created_at FROM chats WHERE id = ?1",
        [&id],
        |r| {
            Ok(Chat {
                id: r.get(0)?,
                title: r.get(1)?,
                created_at: r.get(2)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

pub fn delete_chat(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM messages WHERE chat_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM chats WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// ADD-9: rename a chat unconditionally (user gave it an explicit title).
pub fn rename_chat(conn: &Connection, id: &str, title: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE chats SET title = ?2 WHERE id = ?1",
        params![id, title],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// First-question auto-title: only takes effect while the chat still has the
/// default "New chat" title.
pub fn set_chat_title_if_new(conn: &Connection, chat_id: &str, title: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE chats SET title = ?2 WHERE id = ?1 AND title = 'New chat'",
        params![chat_id, title],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
