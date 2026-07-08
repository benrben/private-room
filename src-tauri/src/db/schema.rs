use super::*;

pub(crate) const SCHEMA: &str = r#"
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
-- CHG-14: porter stemming so plural/inflected query words match singular
-- document words ('invoices' → 'invoice', 'renewing' → 'renewal').
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
  USING fts5(text, content='chunks', content_rowid='rowid', tokenize='porter unicode61');
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
  effects TEXT,
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

pub(crate) fn apply_key(conn: &Connection, password: &str) -> Result<(), String> {
    conn.pragma_update(None, "key", password)
        .map_err(|e| e.to_string())
}

/// Verify the key actually decrypts the file. With SQLCipher, a wrong key
/// surfaces as "file is not a database" on the first real read.
pub(crate) fn verify_key(conn: &Connection) -> Result<(), String> {
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
    // A1: pin the SQLCipher-4 parameter set so a room stays portable across
    // builds/platforms. These are already the current defaults, so nothing
    // breaks for existing rooms — this just makes the on-disk format explicit
    // rather than dependent on whatever the linked SQLCipher defaults to. Must
    // run after `key` and before the first real read (verify_key).
    conn.execute_batch("PRAGMA cipher_compatibility = 4;")
        .map_err(|e| e.to_string())?;
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
    // A1: pin the SQLCipher-4 parameter set (same as create_room) so this room
    // decrypts regardless of the linked SQLCipher's own defaults. Already the
    // current default, so existing rooms keep opening; must run after `key` and
    // before the first real read (verify_key).
    conn.execute_batch("PRAGMA cipher_compatibility = 4;")
        .map_err(|e| e.to_string())?;
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

    // CHG-33: short-lived web_search results cache, keyed by normalized query.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS web_searches (
           query_key TEXT PRIMARY KEY,
           results_text TEXT NOT NULL,
           saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         );",
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

    // ADD-23: structured viewer effects (boxes/annotation) ride their own
    // column so assistant `content` stays plain prose. Guarded ALTER for rooms
    // created before the column existed; legacy fenced ```boxes/```annotation
    // blocks inside old messages are still parsed by the UI as a fallback.
    if table_exists(conn, "messages")? && !column_exists(conn, "messages", "effects")? {
        conn.execute("ALTER TABLE messages ADD COLUMN effects TEXT", [])
            .map_err(|e| e.to_string())?;
    }

    // HLT-3: FTS5 index over chunk text. Create the virtual table and its sync
    // triggers if absent, then backfill from existing chunks — but only when the
    // table was just created, so re-opening a migrated room stays cheap. The
    // triggers keep it in sync on every insert/update/delete afterwards. All of
    // this depends on the chunks table existing.
    if table_exists(conn, "chunks")? {
        // CHG-14: a pre-existing chunks_fts built without porter stemming must be
        // dropped and rebuilt — FTS5 tokenizers cannot be altered in place. An
        // index whose stored `sql` lacks "porter" is stale; drop it so the CREATE
        // below rebuilds it with the current tokenizer.
        let existing_fts_sql: Option<String> = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name='chunks_fts'",
                [],
                |r| r.get(0),
            )
            .ok();
        let stale = existing_fts_sql
            .as_deref()
            .map(|sql| !sql.contains("porter"))
            .unwrap_or(false);
        if stale {
            conn.execute("DROP TABLE chunks_fts", [])
                .map_err(|e| e.to_string())?;
        }
        let fts_existed = table_exists(conn, "chunks_fts")?;
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
               USING fts5(text, content='chunks', content_rowid='rowid', tokenize='porter unicode61');
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

        // CHG-12: nomic-embed-text needs task-instruction prefixes
        // (search_query:/search_document:). Older rooms stored vectors WITHOUT
        // them; a prefixed query against unprefixed document vectors is a
        // cross-task mismatch. One-time: null out existing embeddings so the
        // background backfill re-embeds them prefixed. Keyword retrieval covers
        // the gap meanwhile. Guarded by PRAGMA user_version (was unused).
        let user_version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap_or(0);
        if user_version < 1 {
            conn.execute("UPDATE chunks SET embedding = NULL", [])
                .map_err(|e| e.to_string())?;
            conn.execute("PRAGMA user_version = 1", [])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fts5_is_available() {
        // HLT-3 precondition: the bundled SQLCipher must have FTS5 compiled in.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE VIRTUAL TABLE t USING fts5(x);")
            .expect("FTS5 must be available in the bundled SQLCipher build");
    }

    #[test]
    fn room_reopens_after_create() {
        // A1: a room created then reopened still decrypts (cipher_compatibility
        // pinned in both paths), and a wrong password is rejected cleanly.
        let path = temp_room_path();
        {
            let conn = create_room(&path, "correct horse", "My Room").unwrap();
            set_meta(&conn, "probe", "kept").unwrap();
        }
        let conn = open_room(&path, "correct horse").unwrap();
        assert_eq!(get_meta(&conn, "name").as_deref(), Some("My Room"));
        assert_eq!(get_meta(&conn, "probe").as_deref(), Some("kept"));
        drop(conn);
        assert!(open_room(&path, "wrong password").is_err());
        let _ = std::fs::remove_file(&path);
    }
}
