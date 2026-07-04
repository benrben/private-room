use crate::commands::{Chat, FileMeta, Memory, Message};
use crate::extraction;
use rusqlite::{params, Connection};
use uuid::Uuid;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'upload',
  original_bytes BLOB,
  extracted_text TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'New chat',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  sources TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS web_pages (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT,
  raw_html BLOB,
  readable_text TEXT,
  saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

fn apply_key(conn: &Connection, password: &str) -> Result<(), String> {
    conn.pragma_update(None, "key", password)
        .map_err(|e| e.to_string())
}

/// Verify the key actually decrypts the file. With SQLCipher, a wrong key
/// surfaces as "file is not a database" on the first real read.
fn verify_key(conn: &Connection) -> Result<(), String> {
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| {
        r.get::<_, i64>(0)
    })
    .map(|_| ())
    .map_err(|_| "WRONG_PASSWORD".to_string())
}

pub fn create_room(path: &str, password: &str, name: &str) -> Result<Connection, String> {
    if std::path::Path::new(path).exists() {
        return Err("A file already exists at this location.".into());
    }
    if password.is_empty() {
        return Err("Password cannot be empty.".into());
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    apply_key(&conn, password)?;
    verify_key(&conn)?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| e.to_string())?;
    conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO meta(key, value) VALUES ('format','roomai'), ('format_version','1'), ('name', ?1)",
        [name],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

pub fn open_room(path: &str, password: &str) -> Result<Connection, String> {
    if !std::path::Path::new(path).exists() {
        return Err("File not found.".into());
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    apply_key(&conn, password)?;
    verify_key(&conn)?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| e.to_string())?;
    // Sanity check that this is one of our project files.
    let format: Result<String, _> = conn.query_row(
        "SELECT value FROM meta WHERE key = 'format'",
        [],
        |r| r.get(0),
    );
    match format {
        Ok(f) if f == "roomai" => {
            migrate(&conn)?;
            Ok(conn)
        }
        _ => Err("This file is not a Private Room project.".into()),
    }
}

/// Bring rooms created by older app versions up to the current schema.
fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chats (
           id TEXT PRIMARY KEY,
           title TEXT NOT NULL DEFAULT 'New chat',
           created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         );",
    )
    .map_err(|e| e.to_string())?;

    let has_chat_id = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(messages)")
            .map_err(|e| e.to_string())?;
        let cols = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        cols.iter().any(|c| c == "chat_id")
    };
    if !has_chat_id {
        conn.execute("ALTER TABLE messages ADD COLUMN chat_id TEXT", [])
            .map_err(|e| e.to_string())?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id)",
            [],
        )
        .map_err(|e| e.to_string())?;
    }

    // Adopt any pre-session messages into a legacy chat.
    let orphans: i64 = conn
        .query_row(
            "SELECT count(*) FROM messages WHERE chat_id IS NULL",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if orphans > 0 {
        let legacy_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO chats(id, title) VALUES (?1, 'Earlier conversation')",
            [&legacy_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE messages SET chat_id = ?1 WHERE chat_id IS NULL",
            [&legacy_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ==================================================================
// Room-persistence CRUD. Everything below is the only place raw SQL
// against these tables should live — commands.rs calls these functions
// instead of issuing SQL of its own.
// ==================================================================

/// Target chunk size (chars) for the room's keyword search index.
const CHUNK_TARGET_CHARS: usize = 1200;

// ---------------------------------------------------------------- meta

/// Read one value from the `meta` table (format/version/room name).
pub fn get_meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .ok()
}

// ---------------------------------------------------------------- files

fn file_meta_row(row: &rusqlite::Row) -> rusqlite::Result<FileMeta> {
    Ok(FileMeta {
        id: row.get(0)?,
        name: row.get(1)?,
        mime_type: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        size_bytes: row.get(3)?,
        source: row.get(4)?,
        has_text: row.get::<_, Option<String>>(5)?.is_some(),
        created_at: row.get(6)?,
    })
}

/// Chunk `text` (if any) into the search index for `file_id`.
fn insert_chunks(conn: &Connection, file_id: &str, text: Option<&str>) -> Result<(), String> {
    if let Some(text) = text {
        for (seq, chunk) in extraction::chunk_text(text, CHUNK_TARGET_CHARS)
            .into_iter()
            .take(2000)
            .enumerate()
        {
            conn.execute(
                "INSERT INTO chunks(id, file_id, seq, text) VALUES (?1, ?2, ?3, ?4)",
                params![Uuid::new_v4().to_string(), file_id, seq as i64, chunk],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Insert a new file row (plus its search-index chunks) and return its metadata.
pub fn insert_file(
    conn: &Connection,
    name: &str,
    mime: &str,
    bytes: &[u8],
    text: Option<&str>,
    source: &str,
) -> Result<FileMeta, String> {
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO files(id, name, mime_type, size_bytes, source, original_bytes, extracted_text)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, name, mime, bytes.len() as i64, source, bytes, text],
    )
    .map_err(|e| e.to_string())?;
    insert_chunks(conn, &id, text)?;
    get_file_meta(conn, &id)
}

/// List every file's metadata, newest first.
pub fn list_files(conn: &Connection) -> Result<Vec<FileMeta>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, mime_type, size_bytes, source, extracted_text, created_at
             FROM files ORDER BY created_at DESC, rowid DESC",
        )
        .map_err(|e| e.to_string())?;
    let files = stmt
        .query_map([], file_meta_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(files)
}

/// (name, mime type, size) for every file — feeds the agent's list_room_files tool.
pub fn list_files_brief(conn: &Connection) -> Result<Vec<(String, String, i64)>, String> {
    let mut stmt = conn
        .prepare("SELECT name, coalesce(mime_type,''), size_bytes FROM files ORDER BY created_at")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// (name, mime type) for the oldest 100 files — feeds the model's file inventory.
pub fn list_file_inventory(conn: &Connection) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT name, coalesce(mime_type, '') FROM files
             ORDER BY created_at ASC LIMIT 100",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Full metadata row for one file by id.
pub fn get_file_meta(conn: &Connection, id: &str) -> Result<FileMeta, String> {
    conn.query_row(
        "SELECT id, name, mime_type, size_bytes, source, extracted_text, created_at
         FROM files WHERE id = ?1",
        [id],
        file_meta_row,
    )
    .map_err(|e| e.to_string())
}

/// Just a file's name.
pub fn get_file_name(conn: &Connection, id: &str) -> Result<String, String> {
    conn.query_row("SELECT name FROM files WHERE id = ?1", [id], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// (name, mime type, bytes, extracted text) — the full payload needed to
/// serve or attach a file's content.
pub fn get_file_full(
    conn: &Connection,
    id: &str,
) -> Result<(String, Option<String>, Option<Vec<u8>>, Option<String>), String> {
    conn.query_row(
        "SELECT name, mime_type, original_bytes, extracted_text FROM files WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
    .map_err(|e| e.to_string())
}

/// (name, bytes) for one file.
pub fn get_file_bytes_named(
    conn: &Connection,
    id: &str,
) -> Result<(String, Option<Vec<u8>>), String> {
    conn.query_row(
        "SELECT name, original_bytes FROM files WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map_err(|e| e.to_string())
}

/// A file's stored bytes.
pub fn get_file_bytes(conn: &Connection, id: &str) -> Result<Option<Vec<u8>>, String> {
    conn.query_row(
        "SELECT original_bytes FROM files WHERE id = ?1",
        [id],
        |r| r.get::<_, Option<Vec<u8>>>(0),
    )
    .map_err(|e| e.to_string())
}

/// A file's extracted search text, if any. Missing row or missing text both
/// read as `None` — mirrors the original call site's error-swallowing.
pub fn get_file_extracted_text(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row(
        "SELECT extracted_text FROM files WHERE id = ?1",
        [id],
        |r| r.get(0),
    )
    .ok()
    .flatten()
}

/// Overwrite a file's bytes and rebuild its search index.
pub fn update_file_content(
    conn: &Connection,
    id: &str,
    bytes: &[u8],
    text: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE files SET original_bytes = ?2, extracted_text = ?3, size_bytes = ?4
         WHERE id = ?1",
        params![id, bytes, text, bytes.len() as i64],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM chunks WHERE file_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    insert_chunks(conn, id, text)
}

pub fn delete_file(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM files WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Resolve a model-supplied file name (or fragment) to the newest match.
/// Lowercases `fragment` itself; the error message keeps the original case.
pub fn find_file_like(conn: &Connection, fragment: &str) -> Result<(String, String), String> {
    let needle = fragment.to_lowercase();
    conn.query_row(
        "SELECT id, name FROM files WHERE lower(name) LIKE '%' || ?1 || '%'
         ORDER BY created_at DESC LIMIT 1",
        [&needle],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map_err(|_| format!("No file matching \"{fragment}\" in this room."))
}

/// Same fuzzy match as `find_file_like`, also returning extracted text —
/// used by the agent's open_file tool. Unlike `find_file_like`, the caller
/// is expected to have already lowercased `needle` (and reuses it verbatim
/// in its own error message), so this does no lowercasing of its own.
pub fn find_file_like_full(
    conn: &Connection,
    needle: &str,
) -> Result<(String, String, Option<String>), String> {
    conn.query_row(
        "SELECT id, name, extracted_text FROM files
         WHERE lower(name) LIKE '%' || ?1 || '%'
         ORDER BY created_at DESC LIMIT 1",
        [needle],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .map_err(|_| format!("No file matching \"{needle}\" in this room."))
}

/// Fuzzy match restricted to images — used by the agent's mark_image tool.
/// Like `find_file_like_full`, expects an already-lowercased `needle`.
pub fn find_image_like(
    conn: &Connection,
    needle: &str,
) -> Result<(String, String, Vec<u8>), String> {
    conn.query_row(
        "SELECT id, name, original_bytes FROM files
         WHERE lower(name) LIKE '%' || ?1 || '%'
           AND mime_type LIKE 'image/%'
         ORDER BY created_at DESC LIMIT 1",
        [needle],
        |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get::<_, Option<Vec<u8>>>(2)?.unwrap_or_default(),
            ))
        },
    )
    .map_err(|_| format!("No image matching \"{needle}\" in this room."))
}

/// (file name, chunk text) for every chunk in the room, newest file first —
/// input to the keyword search ranking in `retrieve_context`.
pub fn list_chunks_with_file_names(conn: &Connection) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT f.name, c.text FROM chunks c JOIN files f ON f.id = c.file_id
             ORDER BY f.created_at DESC, c.seq ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

// ---------------------------------------------------------------- messages

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

// ---------------------------------------------------------------- memories

pub fn add_memory(conn: &Connection, content: &str) -> Result<Memory, String> {
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO memories(id, content) VALUES (?1, ?2)",
        params![id, content],
    )
    .map_err(|e| e.to_string())?;
    let created_at: String = conn
        .query_row("SELECT created_at FROM memories WHERE id = ?1", [&id], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    Ok(Memory {
        id,
        content: content.to_string(),
        created_at,
    })
}

pub fn list_memories(conn: &Connection) -> Result<Vec<Memory>, String> {
    let mut stmt = conn
        .prepare("SELECT id, content, created_at FROM memories ORDER BY created_at ASC")
        .map_err(|e| e.to_string())?;
    let memories = stmt
        .query_map([], |r| {
            Ok(Memory {
                id: r.get(0)?,
                content: r.get(1)?,
                created_at: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(memories)
}

pub fn delete_memory(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM memories WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------- settings

pub fn get_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
        r.get(0)
    })
    .ok()
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------- chats

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

// ---------------------------------------------------------------- web pages

/// Cache a fetched page's readable text. Callers ignore failures here (the
/// fetch itself already succeeded; caching it is best-effort).
pub fn save_web_page(conn: &Connection, url: &str, title: &str, text: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO web_pages(id, url, title, readable_text) VALUES (?1, ?2, ?3, ?4)",
        params![Uuid::new_v4().to_string(), url, title, text],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
