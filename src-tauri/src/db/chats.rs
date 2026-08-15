use super::*;

fn chat_row(r: &rusqlite::Row) -> rusqlite::Result<Chat> {
    let created_at: String = r.get(2)?;
    Ok(Chat {
        id: r.get(0)?,
        title: r.get(1)?,
        // Both queries below select it, so a read error here is a real shape
        // mismatch and belongs on the error path rather than silently reverting
        // the ordering. The NULL arm is the honest fallback `COALESCE` already
        // makes unreachable: a chat with no messages reports its own stamp.
        last_at: r.get::<_, Option<String>>(3)?.unwrap_or_else(|| created_at.clone()),
        created_at,
    })
}

/// Newest CONVERSATION first, not newest chat row first.
///
/// `idx_messages_chat` already covers this join, and no column is added: the
/// last message's stamp is computed on read. Ordering by `created_at` meant the
/// list headed "Continue where you left off" put a chat abandoned yesterday
/// above the one used all morning — and unlock restores the first row, so it
/// also landed the user in the wrong thread.
pub fn list_chats(conn: &Connection) -> Result<Vec<Chat>, String> {
    query_rows(
        conn,
        "SELECT c.id, c.title, c.created_at, \
                COALESCE(MAX(m.created_at), c.created_at) AS last_at \
         FROM chats c LEFT JOIN messages m ON m.chat_id = c.id \
         GROUP BY c.id \
         ORDER BY last_at DESC, c.rowid DESC",
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
        // Four columns, like `list_chats` — a brand-new chat has no messages,
        // so its own stamp IS its last activity. Stated in the query rather
        // than left to `chat_row`'s missing-column fallback: both readers of
        // that function should hand it the same shape, and a row that happens
        // to be one column short is not a contract.
        "SELECT id, title, created_at, created_at AS last_at FROM chats WHERE id = ?1",
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Just the two tables `list_chats` joins, with the same columns the real
    /// schema declares for them.
    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE chats (
               id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New chat',
               created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
             );
             CREATE TABLE messages (
               id TEXT PRIMARY KEY, chat_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL,
               sources TEXT, effects TEXT, kind TEXT,
               created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
             );",
        )
        .unwrap();
        conn
    }

    fn chat_at(conn: &Connection, id: &str, created: &str) {
        conn.execute(
            "INSERT INTO chats(id, title, created_at) VALUES (?1, ?2, ?3)",
            params![id, format!("chat {id}"), created],
        )
        .unwrap();
    }

    fn message_at(conn: &Connection, chat: &str, created: &str) {
        conn.execute(
            "INSERT INTO messages(id, chat_id, role, content, created_at) \
             VALUES (?1, ?2, 'user', 'hello', ?3)",
            params![Uuid::new_v4().to_string(), chat, created],
        )
        .unwrap();
    }

    /// The list is headed "Continue where you left off" and unlock restores its
    /// FIRST row, so "recent" has to mean the conversation, not the row. An old
    /// chat used this morning belongs above a newer one nobody came back to.
    #[test]
    fn the_chat_you_were_last_in_comes_first() {
        let conn = mem();
        chat_at(&conn, "old", "2026-01-01T09:00:00Z");
        chat_at(&conn, "new", "2026-06-01T09:00:00Z");
        // The OLDER chat is the one still in use.
        message_at(&conn, "old", "2026-08-14T10:00:00Z");
        message_at(&conn, "new", "2026-06-01T09:05:00Z");

        let ids: Vec<String> = list_chats(&conn).unwrap().into_iter().map(|c| c.id).collect();
        assert_eq!(
            ids,
            vec!["old".to_string(), "new".to_string()],
            "ordering by the chat's own created_at put the abandoned conversation on top"
        );
    }

    /// A chat nobody has written in yet still has to appear, and to sort by the
    /// only stamp it has. An INNER join would have dropped it entirely.
    #[test]
    fn a_chat_with_no_messages_still_lists_and_reports_its_own_stamp() {
        let conn = mem();
        chat_at(&conn, "empty", "2026-08-14T12:00:00Z");
        chat_at(&conn, "spoken", "2026-01-01T09:00:00Z");
        message_at(&conn, "spoken", "2026-02-01T09:00:00Z");

        let chats = list_chats(&conn).unwrap();
        assert_eq!(chats.len(), 2, "a chat with no messages must not vanish from the list");
        assert_eq!(chats[0].id, "empty", "the newly created chat is the most recent");
        assert_eq!(
            chats[0].last_at, "2026-08-14T12:00:00Z",
            "with no messages, the chat's own stamp is its last activity"
        );
        assert_eq!(chats[1].last_at, "2026-02-01T09:00:00Z");
    }

    /// `create_chat` and `list_chats` both feed `chat_row`, so they have to
    /// hand it the same shape — a fresh chat reports itself as its own last
    /// activity rather than falling through a missing column.
    #[test]
    fn a_freshly_created_chat_reports_a_last_activity() {
        let conn = mem();
        let chat = create_chat(&conn).unwrap();
        assert_eq!(chat.last_at, chat.created_at);
        assert!(!chat.last_at.is_empty());
    }
}
