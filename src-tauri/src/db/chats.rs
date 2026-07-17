use super::*;

fn chat_row(r: &rusqlite::Row) -> rusqlite::Result<Chat> {
    Ok(Chat {
        id: r.get(0)?,
        title: r.get(1)?,
        created_at: r.get(2)?,
    })
}

pub fn list_chats(conn: &Connection) -> Result<Vec<Chat>, String> {
    query_rows(
        conn,
        "SELECT id, title, created_at FROM chats ORDER BY created_at DESC, rowid DESC",
        [],
        chat_row,
    )
}

pub fn create_chat(conn: &Connection) -> Result<Chat, String> {
    let id = Uuid::new_v4().to_string();
    execute_one(
        conn,
        "INSERT INTO chats(id, title) VALUES (?1, 'New chat')",
        [&id],
    )?;
    query_one(
        conn,
        "SELECT id, title, created_at FROM chats WHERE id = ?1",
        [&id],
        chat_row,
    )
}

pub fn delete_chat(conn: &Connection, id: &str) -> Result<(), String> {
    execute_one(conn, "DELETE FROM messages WHERE chat_id = ?1", [id])?;
    execute_one(conn, "DELETE FROM chats WHERE id = ?1", [id])
}

/// ADD-9: rename a chat unconditionally (user gave it an explicit title).
pub fn rename_chat(conn: &Connection, id: &str, title: &str) -> Result<(), String> {
    execute_one(
        conn,
        "UPDATE chats SET title = ?2 WHERE id = ?1",
        params![id, title],
    )
}

/// First-question auto-title: only takes effect while the chat still has the
/// default "New chat" title.
pub fn set_chat_title_if_new(conn: &Connection, chat_id: &str, title: &str) -> Result<(), String> {
    execute_one(
        conn,
        "UPDATE chats SET title = ?2 WHERE id = ?1 AND title = 'New chat'",
        params![chat_id, title],
    )
}
