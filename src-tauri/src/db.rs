use crate::commands::{Chat, FileMeta, FileVersion, Folder, Memory, Message};
use crate::extraction;
use rusqlite::{params, Connection};
use uuid::Uuid;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- ADD-16: one flat level of folders. A file's folder_id is NULL at top level.
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'upload',
  original_bytes BLOB,
  extracted_text TEXT,
  folder_id TEXT,
  -- ADD-17: cached one-line "what is this file" summary, cleared whenever the
  -- file's content changes so re-summarizing only touches new/changed files.
  ai_summary TEXT,
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
-- HLT-3: full-text index over chunk text, kept in sync by the triggers below.
-- External-content table: rows live in `chunks`, the index only stores terms.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
  USING fts5(text, content='chunks', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_fts_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
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
-- RM-2: one cache row per URL so repeat fetches upsert instead of piling up.
CREATE UNIQUE INDEX IF NOT EXISTS idx_web_pages_url ON web_pages(url);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- ADD-2: previous bytes of a file, captured before each overwrite so any
-- change can be undone. Dropped automatically when the file is deleted.
CREATE TABLE IF NOT EXISTS file_versions (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  bytes BLOB NOT NULL,
  saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  cause TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_versions_file ON file_versions(file_id);
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

    // ADD-2: file version history. Old rooms opened via open_room never ran
    // SCHEMA, so mirror the table (and its index) here with IF NOT EXISTS.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS file_versions (
           id TEXT PRIMARY KEY,
           file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
           bytes BLOB NOT NULL,
           saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
           cause TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_file_versions_file ON file_versions(file_id);",
    )
    .map_err(|e| e.to_string())?;

    // RM-2: the web_pages cache must be keyed by URL so save_web_page can upsert.
    // Old rooms opened via open_room never ran SCHEMA, so the table may not exist
    // yet — create it first. Older rooms may also hold duplicate-URL rows, which
    // would make the unique index fail — collapse them (keep the newest row per
    // URL), then enforce uniqueness. Every step is idempotent on migrated rooms.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS web_pages (
           id TEXT PRIMARY KEY,
           url TEXT NOT NULL,
           title TEXT,
           raw_html BLOB,
           readable_text TEXT,
           saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         );
         DELETE FROM web_pages
           WHERE rowid NOT IN (SELECT MAX(rowid) FROM web_pages GROUP BY url);
         CREATE UNIQUE INDEX IF NOT EXISTS idx_web_pages_url ON web_pages(url);",
    )
    .map_err(|e| e.to_string())?;

    // ADD-16: folders table + a nullable files.folder_id (NULL = top level).
    // Old rooms never ran SCHEMA, so create the table and add the column when
    // it is missing — mirroring the chat_id migration above. The column only
    // makes sense once a files table exists.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS folders (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL UNIQUE
         );",
    )
    .map_err(|e| e.to_string())?;
    if table_exists(conn, "files")? && !column_exists(conn, "files", "folder_id")? {
        conn.execute("ALTER TABLE files ADD COLUMN folder_id TEXT", [])
            .map_err(|e| e.to_string())?;
    }

    // ADD-17: cached per-file one-liner for "Summarize room". Nullable; a fresh
    // NULL means the file still needs summarizing (also how content changes
    // invalidate a stale summary). Guarded ALTER, like folder_id above.
    if table_exists(conn, "files")? && !column_exists(conn, "files", "ai_summary")? {
        conn.execute("ALTER TABLE files ADD COLUMN ai_summary TEXT", [])
            .map_err(|e| e.to_string())?;
    }

    // HLT-3: FTS5 index over chunk text. Create the virtual table and its sync
    // triggers if absent, then backfill from existing chunks — but only when the
    // table was just created, so re-opening a migrated room stays cheap. The
    // triggers keep it in sync on every insert/update/delete afterwards. All of
    // this depends on the chunks table existing.
    if table_exists(conn, "chunks")? {
        let fts_existed = table_exists(conn, "chunks_fts")?;
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
               USING fts5(text, content='chunks', content_rowid='rowid');
             CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON chunks BEGIN
               INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
             END;
             CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks BEGIN
               INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
             END;
             CREATE TRIGGER IF NOT EXISTS chunks_fts_au AFTER UPDATE ON chunks BEGIN
               INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
               INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
             END;",
        )
        .map_err(|e| e.to_string())?;
        if !fts_existed {
            // Populate the index from whatever chunks the old room already has.
            conn.execute("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')", [])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// True when `table` has a column named `column` (used to guard ALTER TABLE
/// migrations so they run exactly once).
fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| e.to_string())?;
    let cols = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(cols.iter().any(|c| c == column))
}

/// True when a table (or virtual table) named `name` exists.
fn table_exists(conn: &Connection, name: &str) -> Result<bool, String> {
    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type IN ('table','view') AND name = ?1",
            [name],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(count > 0)
}

// ==================================================================
// Room-persistence CRUD. Everything below is the only place raw SQL
// against these tables should live — commands.rs calls these functions
// instead of issuing SQL of its own.
// ==================================================================

/// Target chunk size (chars) for the room's keyword search index.
const CHUNK_TARGET_CHARS: usize = 1200;
/// HLT-4: hard cap on chunks indexed per file. A file that hits it is only
/// partially searchable; `FileMeta.partially_indexed` surfaces that live via a
/// chunk-count check, so this cap and that flag must agree.
pub const CHUNK_CAP: usize = 2000;

// ---------------------------------------------------------------- meta

/// Read one value from the `meta` table (format/version/room name).
pub fn get_meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .ok()
}

// ---------------------------------------------------------------- files

/// Column list shared by every FileMeta query: the base row plus folder_id and
/// a live chunk count for `partially_indexed` (HLT-4). Kept as one constant so
/// the row mapper's indices always line up with the SELECT.
const FILE_META_COLS: &str = "f.id, f.name, f.mime_type, f.size_bytes, f.source, \
     f.extracted_text, f.created_at, f.folder_id, \
     (SELECT count(*) FROM chunks WHERE file_id = f.id)";

fn file_meta_row(row: &rusqlite::Row) -> rusqlite::Result<FileMeta> {
    let chunk_count: i64 = row.get(8)?;
    Ok(FileMeta {
        id: row.get(0)?,
        name: row.get(1)?,
        mime_type: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        size_bytes: row.get(3)?,
        source: row.get(4)?,
        has_text: row.get::<_, Option<String>>(5)?.is_some(),
        created_at: row.get(6)?,
        folder_id: row.get(7)?,
        // HLT-4: hitting the cap means only the first part is searchable.
        partially_indexed: chunk_count >= CHUNK_CAP as i64,
    })
}

/// Chunk `text` (if any) into the search index for `file_id`.
fn insert_chunks(conn: &Connection, file_id: &str, text: Option<&str>) -> Result<(), String> {
    if let Some(text) = text {
        for (seq, chunk) in extraction::chunk_text(text, CHUNK_TARGET_CHARS)
            .into_iter()
            .take(CHUNK_CAP)
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
        .prepare(&format!(
            "SELECT {FILE_META_COLS} FROM files f ORDER BY f.created_at DESC, f.rowid DESC"
        ))
        .map_err(|e| e.to_string())?;
    let files = stmt
        .query_map([], file_meta_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(files)
}

/// (display name, mime type, size) for every file — feeds the agent's
/// list_room_files tool. ADD-16: files inside a folder read as "Folder/name"
/// so the model sees the room's organization.
pub fn list_files_brief(conn: &Connection) -> Result<Vec<(String, String, i64)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT CASE WHEN fo.name IS NOT NULL THEN fo.name || '/' || f.name ELSE f.name END,
                    coalesce(f.mime_type,''), f.size_bytes
             FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
             ORDER BY f.created_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// (display name, mime type) for the oldest 100 files — feeds the model's file
/// inventory in the system prompt. ADD-16: folder-prefixed like list_files_brief.
pub fn list_file_inventory(conn: &Connection) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT CASE WHEN fo.name IS NOT NULL THEN fo.name || '/' || f.name ELSE f.name END,
                    coalesce(f.mime_type, '')
             FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
             ORDER BY f.created_at ASC LIMIT 100",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// ADD-17: one file's fields needed to build the room summary. `text` is only
/// the first ~1500 chars (clipped in SQL). `ai_summary` is the cached one-liner
/// (None → still needs summarizing). `folder` is the owning folder's name.
pub struct SummaryFile {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub source: String,
    pub folder: Option<String>,
    pub text: Option<String>,
    pub ai_summary: Option<String>,
}

/// ADD-17: every file with the fields the summarizer needs, grouped by folder
/// (top-level files last) then creation order, so the file list reads sensibly.
pub fn list_files_for_summary(conn: &Connection) -> Result<Vec<SummaryFile>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT f.id, f.name, coalesce(f.mime_type,''), f.source, fo.name,
                    substr(f.extracted_text, 1, 1500), f.ai_summary
             FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
             ORDER BY (fo.name IS NULL), fo.name COLLATE NOCASE, f.created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(SummaryFile {
                id: r.get(0)?,
                name: r.get(1)?,
                mime: r.get(2)?,
                source: r.get(3)?,
                folder: r.get(4)?,
                text: r.get(5)?,
                ai_summary: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// ADD-17: cache a file's generated one-liner so re-runs skip it.
pub fn set_file_ai_summary(conn: &Connection, id: &str, summary: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE files SET ai_summary = ?2 WHERE id = ?1",
        params![id, summary],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Today's date as YYYY-MM-DD, from SQLite so it matches stored timestamps.
pub fn current_date(conn: &Connection) -> String {
    conn.query_row("SELECT strftime('%Y-%m-%d','now')", [], |r| r.get(0))
        .unwrap_or_default()
}

/// Full metadata row for one file by id.
pub fn get_file_meta(conn: &Connection, id: &str) -> Result<FileMeta, String> {
    conn.query_row(
        &format!("SELECT {FILE_META_COLS} FROM files f WHERE f.id = ?1"),
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
    // ADD-17: content changed, so the cached one-liner is stale — clear it so
    // the next "Summarize room" run re-summarizes this file.
    conn.execute(
        "UPDATE files SET original_bytes = ?2, extracted_text = ?3, size_bytes = ?4,
             ai_summary = NULL
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

/// HLT-3: rank chunks by an FTS5 MATCH query, best (lowest bm25) first.
/// Returns (file name, chunk text, bm25 score) — smaller score = better match.
/// `match_expr` is a ready-built FTS5 query (e.g. `"foo" OR "bar"`).
pub fn search_chunks_fts(
    conn: &Connection,
    match_expr: &str,
    limit: usize,
) -> Result<Vec<(String, String, f64)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT f.name, c.text, bm25(chunks_fts)
             FROM chunks_fts
             JOIN chunks c ON c.rowid = chunks_fts.rowid
             JOIN files f ON f.id = c.file_id
             WHERE chunks_fts MATCH ?1
             ORDER BY bm25(chunks_fts)
             LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![match_expr, limit as i64], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

// ---------------------------------------------------------------- embeddings (ADD-13)

/// ADD-13: encode an embedding as a compact little-endian f32 BLOB for storage
/// in `chunks.embedding`. Round-trips with `blob_to_embedding`.
pub fn embedding_to_blob(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

/// ADD-13: decode a little-endian f32 BLOB back into a vector. A blob whose
/// length is not a whole number of f32s (corrupt / foreign) reads as None so the
/// caller silently skips it rather than mis-scoring it.
pub fn blob_to_embedding(b: &[u8]) -> Option<Vec<f32>> {
    if b.is_empty() || b.len() % 4 != 0 {
        return None;
    }
    Some(
        b.chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
    )
}

/// ADD-13: cosine similarity of two vectors. Returns 0.0 when the lengths
/// differ, either is empty, or either has zero magnitude — a safe "no signal"
/// value for the blend.
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0f32;
    let mut na = 0f32;
    let mut nb = 0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// ADD-13: a batch of chunks that still lack an embedding — (chunk id, text).
/// The background pass drains these in batches until none remain.
pub fn chunks_missing_embedding(conn: &Connection, limit: usize) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare("SELECT id, text FROM chunks WHERE embedding IS NULL LIMIT ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// ADD-13: store an embedding BLOB on one chunk (by chunk id).
pub fn set_chunk_embedding(conn: &Connection, id: &str, blob: &[u8]) -> Result<(), String> {
    conn.execute(
        "UPDATE chunks SET embedding = ?2 WHERE id = ?1",
        params![id, blob],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// ADD-13: every chunk that has a stored embedding — (chunk rowid, file name,
/// chunk text, embedding blob). The rowid keys the keyword/vector blend so both
/// scores line up on the same chunk. Brute-force scan; fine to a few thousand
/// chunks (see ADD-13 latency budget).
pub fn chunk_embeddings(conn: &Connection) -> Result<Vec<(i64, String, String, Vec<u8>)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT c.rowid, f.name, c.text, c.embedding
             FROM chunks c JOIN files f ON f.id = c.file_id
             WHERE c.embedding IS NOT NULL",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// ADD-13: like `search_chunks_fts` but also returns each hit's chunk rowid so
/// keyword and vector scores can be blended per chunk. (rowid, file name, chunk
/// text, bm25 — smaller is a better match).
pub fn search_chunks_fts_ranked(
    conn: &Connection,
    match_expr: &str,
    limit: usize,
) -> Result<Vec<(i64, String, String, f64)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT chunks_fts.rowid, f.name, c.text, bm25(chunks_fts)
             FROM chunks_fts
             JOIN chunks c ON c.rowid = chunks_fts.rowid
             JOIN files f ON f.id = c.file_id
             WHERE chunks_fts MATCH ?1
             ORDER BY bm25(chunks_fts)
             LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![match_expr, limit as i64], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// (file name, chunk text) for the most recently added chunks — the fallback
/// context when a question matches nothing in the FTS index (CHG-10).
pub fn recent_chunks(conn: &Connection, limit: usize) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT f.name, c.text FROM chunks c JOIN files f ON f.id = c.file_id
             ORDER BY f.created_at DESC, c.seq ASC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// ADD-6: file rows whose name contains `needle` (already lowercased).
pub fn files_name_like(conn: &Connection, needle: &str) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name FROM files WHERE lower(name) LIKE '%' || ?1 || '%'
             ORDER BY created_at DESC LIMIT 20",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([needle], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// ADD-6: file content hits via FTS — (file id, name, matching chunk text) for
/// the best-ranked chunk. The caller trims a snippet out of the chunk text.
pub fn files_content_fts(
    conn: &Connection,
    match_expr: &str,
    limit: usize,
) -> Result<Vec<(String, String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT f.id, f.name, c.text
             FROM chunks_fts
             JOIN chunks c ON c.rowid = chunks_fts.rowid
             JOIN files f ON f.id = c.file_id
             WHERE chunks_fts MATCH ?1
             ORDER BY bm25(chunks_fts)
             LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![match_expr, limit as i64], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

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

/// ADD-6: memories whose content contains `needle` (already lowercased) —
/// (memory id, content).
pub fn memories_like(conn: &Connection, needle: &str) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, content FROM memories WHERE lower(content) LIKE '%' || ?1 || '%'
             ORDER BY created_at DESC LIMIT 30",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([needle], |r| Ok((r.get(0)?, r.get(1)?)))
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

/// UX-5: overwrite a memory's text in place.
pub fn update_memory(conn: &Connection, id: &str, content: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE memories SET content = ?2 WHERE id = ?1",
        params![id, content],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------- folders (ADD-16)

pub fn list_folders(conn: &Connection) -> Result<Vec<Folder>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name FROM folders ORDER BY name COLLATE NOCASE ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Folder {
                id: r.get(0)?,
                name: r.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Create a folder. Names are UNIQUE, so a clash is reported in plain language.
pub fn create_folder(conn: &Connection, name: &str) -> Result<Folder, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Folder name cannot be empty.".into());
    }
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO folders(id, name) VALUES (?1, ?2)",
        params![id, name],
    )
    .map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            format!("A folder named \"{name}\" already exists.")
        } else {
            e.to_string()
        }
    })?;
    Ok(Folder {
        id,
        name: name.to_string(),
    })
}

pub fn rename_folder(conn: &Connection, id: &str, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Folder name cannot be empty.".into());
    }
    conn.execute(
        "UPDATE folders SET name = ?2 WHERE id = ?1",
        params![id, name],
    )
    .map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            format!("A folder named \"{name}\" already exists.")
        } else {
            e.to_string()
        }
    })?;
    Ok(())
}

/// Delete a folder. Its files are moved back to the top level (folder_id → NULL)
/// FIRST — deleting a folder must never delete or hide files (ADD-16).
pub fn delete_folder(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("UPDATE files SET folder_id = NULL WHERE folder_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM folders WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Move a file into a folder, or to the top level when `folder_id` is None.
pub fn move_file_to_folder(
    conn: &Connection,
    file_id: &str,
    folder_id: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE files SET folder_id = ?2 WHERE id = ?1",
        params![file_id, folder_id],
    )
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

// ---------------------------------------------------------------- web pages

/// How long a cached page counts as fresh before we re-fetch (RM-2).
const WEB_CACHE_TTL: &str = "-24 hours";

/// Cache a fetched page's readable text, keyed by URL (RM-2). Upserts so
/// repeat fetches refresh the same row instead of growing the table forever.
/// `raw_html` is intentionally left NULL — it is reserved for ADD-12 (link
/// import), the future reader that will populate and consume it.
/// Callers ignore failures here (the fetch already succeeded; caching is
/// best-effort).
pub fn save_web_page(conn: &Connection, url: &str, title: &str, text: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO web_pages(id, url, title, readable_text) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(url) DO UPDATE SET
           title = excluded.title,
           readable_text = excluded.readable_text,
           saved_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')",
        params![Uuid::new_v4().to_string(), url, title, text],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Return a cached (title, readable_text) for this exact URL if it was fetched
/// within the last 24h, else None (RM-2). Lets `fetch_page` skip the network on
/// a fresh hit. `saved_at` is a sortable ISO-8601 string, so a lexical compare
/// against the TTL cutoff is correct.
pub fn get_fresh_web_page(conn: &Connection, url: &str) -> Option<(String, String)> {
    conn.query_row(
        "SELECT title, readable_text FROM web_pages
         WHERE url = ?1
           AND saved_at > strftime('%Y-%m-%dT%H:%M:%SZ','now',?2)",
        params![url, WEB_CACHE_TTL],
        |r| {
            Ok((
                r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            ))
        },
    )
    .ok()
}

// ---------------------------------------------------------------- file versions (ADD-2)

/// Copy a file's CURRENT bytes into history before it is overwritten, labelled
/// with `cause`, then keep only the newest 10 versions for that file. A file
/// with no stored bytes yet (nothing to preserve) is a no-op.
pub fn snapshot_file_version(conn: &Connection, file_id: &str, cause: &str) -> Result<(), String> {
    let current: Option<Vec<u8>> = conn
        .query_row(
            "SELECT original_bytes FROM files WHERE id = ?1",
            [file_id],
            |r| r.get::<_, Option<Vec<u8>>>(0),
        )
        .map_err(|e| e.to_string())?;
    let Some(bytes) = current else { return Ok(()) };
    conn.execute(
        "INSERT INTO file_versions(id, file_id, bytes, cause) VALUES (?1, ?2, ?3, ?4)",
        params![Uuid::new_v4().to_string(), file_id, bytes, cause],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM file_versions WHERE file_id = ?1 AND id NOT IN (
           SELECT id FROM file_versions WHERE file_id = ?1
           ORDER BY saved_at DESC, rowid DESC LIMIT 10)",
        [file_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// A file's saved versions, newest first.
pub fn list_file_versions(conn: &Connection, file_id: &str) -> Result<Vec<FileVersion>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, saved_at, cause FROM file_versions WHERE file_id = ?1
             ORDER BY saved_at DESC, rowid DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([file_id], |r| {
            Ok(FileVersion {
                id: r.get(0)?,
                saved_at: r.get(1)?,
                cause: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// (owning file id, stored bytes) for one saved version.
pub fn get_version(conn: &Connection, version_id: &str) -> Result<(String, Vec<u8>), String> {
    conn.query_row(
        "SELECT file_id, bytes FROM file_versions WHERE id = ?1",
        [version_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map_err(|_| "That version is no longer available.".to_string())
}

// ---------------------------------------------------------------- password / maintenance

/// Verify a password against a room file on a fresh, throwaway connection —
/// used by SEC-4 change-password so an open room can't be re-keyed by a
/// walk-up attacker, and to open a freshly duplicated copy (ADD-4).
pub fn verify_password(path: &str, password: &str) -> Result<(), String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    apply_key(&conn, password)?;
    verify_key(&conn).map_err(|_| "The current password is not correct.".to_string())
}

/// Change the encryption key of an OPEN connection (SQLCipher rekey).
pub fn rekey(conn: &Connection, new_password: &str) -> Result<(), String> {
    conn.pragma_update(None, "rekey", new_password)
        .map_err(|e| e.to_string())
}

/// Open a room copy with its current key, then re-key it to `new_password`
/// (ADD-4 duplicate-with-new-password).
pub fn rekey_copy(path: &str, current_password: &str, new_password: &str) -> Result<(), String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    apply_key(&conn, current_password)?;
    verify_key(&conn).map_err(|_| "Could not open the copied room to set its password.".to_string())?;
    conn.pragma_update(None, "rekey", new_password)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Bytes sitting in the database's free pages — space a VACUUM would reclaim.
pub fn reclaimable_bytes(conn: &Connection) -> Result<i64, String> {
    let freelist: i64 = conn
        .pragma_query_value(None, "freelist_count", |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let page_size: i64 = conn
        .pragma_query_value(None, "page_size", |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(freelist * page_size)
}

/// Compact the database in place (SEC-7).
pub fn vacuum(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("VACUUM").map_err(|e| e.to_string())
}

/// Test-only: a fresh in-memory database with the live SCHEMA applied — same
/// tables a new room gets. Shared by unit tests in this crate (incl. the
/// retrieval blend test in `commands`).
#[cfg(test)]
pub fn open_in_memory_schema() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn
}

/// A consistent copy of the live, encrypted database to `dest` — keeps the
/// current key (ADD-4). `dest` is single-quote-escaped into the statement
/// since VACUUM INTO does not accept bound parameters.
pub fn vacuum_into(conn: &Connection, dest: &str) -> Result<(), String> {
    let escaped = dest.replace('\'', "''");
    conn.execute_batch(&format!("VACUUM INTO '{escaped}'"))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fresh in-memory DB with the current SCHEMA — same statements a new room
    /// runs, so it exercises the folders table, folder_id column, and the FTS5
    /// virtual table + triggers.
    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn
    }

    fn add_file(conn: &Connection, name: &str, text: &str) -> String {
        insert_file(conn, name, "text/plain", text.as_bytes(), Some(text), "upload")
            .unwrap()
            .id
    }

    #[test]
    fn fts5_is_available() {
        // HLT-3 precondition: the bundled SQLCipher must have FTS5 compiled in.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE VIRTUAL TABLE t USING fts5(x);")
            .expect("FTS5 must be available in the bundled SQLCipher build");
    }

    #[test]
    fn fts_index_finds_and_stays_in_sync() {
        let conn = mem();
        let id = add_file(&conn, "lease.txt", "The tenant pays rent on the first of each month.");
        // Inserted chunks are searchable via the FTS index.
        let hits = search_chunks_fts(&conn, "\"rent\"", 5).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, "lease.txt");
        // Update path: old terms drop out, new terms appear (triggers fired).
        update_file_content(&conn, &id, b"The landlord provides parking spaces.", Some("The landlord provides parking spaces.")).unwrap();
        assert!(search_chunks_fts(&conn, "\"rent\"", 5).unwrap().is_empty());
        assert_eq!(search_chunks_fts(&conn, "\"parking\"", 5).unwrap().len(), 1);
        // Delete path: the file's text no longer surfaces.
        delete_file(&conn, &id).unwrap();
        assert!(search_chunks_fts(&conn, "\"parking\"", 5).unwrap().is_empty());
    }

    #[test]
    fn deleting_a_folder_keeps_its_files() {
        let conn = mem();
        let folder = create_folder(&conn, "Contracts").unwrap();
        let f1 = add_file(&conn, "a.txt", "alpha");
        let f2 = add_file(&conn, "b.txt", "beta");
        move_file_to_folder(&conn, &f1, Some(&folder.id)).unwrap();
        move_file_to_folder(&conn, &f2, Some(&folder.id)).unwrap();
        assert_eq!(get_file_meta(&conn, &f1).unwrap().folder_id.as_deref(), Some(folder.id.as_str()));

        delete_folder(&conn, &folder.id).unwrap();

        // Folder gone, but both files survive and are back at the top level.
        assert!(list_folders(&conn).unwrap().is_empty());
        assert_eq!(list_files(&conn).unwrap().len(), 2);
        assert_eq!(get_file_meta(&conn, &f1).unwrap().folder_id, None);
        assert_eq!(get_file_meta(&conn, &f2).unwrap().folder_id, None);
    }

    #[test]
    fn folder_names_are_unique() {
        let conn = mem();
        create_folder(&conn, "Legal").unwrap();
        assert!(create_folder(&conn, "Legal").is_err());
        assert!(create_folder(&conn, "  ").is_err());
    }

    #[test]
    fn inventory_shows_folder_prefix() {
        let conn = mem();
        let folder = create_folder(&conn, "Contracts").unwrap();
        let f = add_file(&conn, "lease.pdf", "x");
        add_file(&conn, "loose.txt", "y");
        move_file_to_folder(&conn, &f, Some(&folder.id)).unwrap();
        let names: Vec<String> = list_file_inventory(&conn).unwrap().into_iter().map(|(n, _)| n).collect();
        assert!(names.contains(&"Contracts/lease.pdf".to_string()));
        assert!(names.contains(&"loose.txt".to_string()));
    }

    #[test]
    fn embedding_blob_round_trips() {
        // ADD-13: f32 vector <-> little-endian BLOB is lossless.
        let v = vec![0.0f32, 1.5, -2.25, 3.125, 1e-6];
        let blob = embedding_to_blob(&v);
        assert_eq!(blob.len(), v.len() * 4);
        assert_eq!(blob_to_embedding(&blob), Some(v));
        // Empty and misaligned blobs decode to None (skipped, not mis-scored).
        assert_eq!(blob_to_embedding(&[]), None);
        assert_eq!(blob_to_embedding(&[1, 2, 3]), None);
    }

    #[test]
    fn cosine_similarity_basics() {
        // Identical direction → 1.0; orthogonal → 0.0; opposite → -1.0.
        assert!((cosine_similarity(&[1.0, 0.0], &[2.0, 0.0]) - 1.0).abs() < 1e-6);
        assert!(cosine_similarity(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
        assert!((cosine_similarity(&[1.0, 0.0], &[-1.0, 0.0]) + 1.0).abs() < 1e-6);
        // Mismatched length or zero vector → safe 0.0.
        assert_eq!(cosine_similarity(&[1.0, 0.0], &[1.0]), 0.0);
        assert_eq!(cosine_similarity(&[0.0, 0.0], &[1.0, 1.0]), 0.0);
    }

    #[test]
    fn embedding_backfill_columns_work() {
        // ADD-13: chunks start with NULL embedding; storing a blob makes them
        // visible to chunk_embeddings and clears them from the missing list.
        let conn = mem();
        add_file(&conn, "a.txt", "The office holiday party is on Friday.");
        let missing = chunks_missing_embedding(&conn, 10).unwrap();
        assert_eq!(missing.len(), 1);
        assert!(chunk_embeddings(&conn).unwrap().is_empty());
        let blob = embedding_to_blob(&[0.1, 0.2, 0.3]);
        set_chunk_embedding(&conn, &missing[0].0, &blob).unwrap();
        assert!(chunks_missing_embedding(&conn, 10).unwrap().is_empty());
        assert_eq!(chunk_embeddings(&conn).unwrap().len(), 1);
    }

    #[test]
    fn memory_update_persists() {
        let conn = mem();
        let m = add_memory(&conn, "old text").unwrap();
        update_memory(&conn, &m.id, "new text").unwrap();
        let got = list_memories(&conn).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].content, "new text");
    }
}
