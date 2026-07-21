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
  -- Wave 1b (idea 5): preference | fact | project | instruction; NULL =
  -- uncategorized (every legacy row). Organizational only in v1.
  category TEXT,
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
-- PRIV-1: the room's protected-entity map — one row per real string that must
-- never reach a non-local model. `placeholder` is stable for the room's life so
-- cloud conversations stay coherent across turns ("[Person A]" is always the
-- same person) and answers can be re-personalized locally. `source` is 'user'
-- (the block list — iron-clad, added by hand) or 'scan' (found by the local
-- import-time scanner — reviewable in the reader's blackout view).
CREATE TABLE IF NOT EXISTS privacy_entities (
  id TEXT PRIMARY KEY,
  real_text TEXT NOT NULL UNIQUE,
  placeholder TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'concept',
  source TEXT NOT NULL DEFAULT 'scan',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- PRIV-2: per-file scan bookkeeping — which text + which rules the last scan
-- reflects, so imports/rule-edits re-scan only what actually changed.
CREATE TABLE IF NOT EXISTS privacy_scans (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  text_sha256 TEXT NOT NULL,
  rules_sha256 TEXT NOT NULL,
  scanned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- ADD-2: previous bytes of a file, captured before each overwrite so any
-- change can be undone. Dropped automatically when the file is deleted.
CREATE TABLE IF NOT EXISTS file_versions (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  bytes BLOB NOT NULL,
  -- Compound snapshot: for Recordings the bytes are the unchanged WAV and the
  -- overwrite replaces the TRANSCRIPT — so text + recording meta ride along,
  -- or restore could never bring the old words/speakers/cuts back.
  text TEXT,
  rec_meta TEXT,
  saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  cause TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_versions_file ON file_versions(file_id);
-- ADD-27: live-recording metadata (word timings, speakers, cuts) as one JSON
-- blob per file. Row existence marks the file as a Recording in the viewer.
CREATE TABLE IF NOT EXISTS recordings (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  meta TEXT NOT NULL
);
-- Live-recording audio checkpoints (raw 16-bit PCM since the last full WAV
-- write). Normally empty: pause/stop assemble the WAV and clear them; rows
-- surviving here mean a crashed session, recovered on the next room open.
CREATE TABLE IF NOT EXISTS rec_chunks (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  pcm BLOB NOT NULL,
  PRIMARY KEY (file_id, seq)
);
-- ADD-30/ADD-32: durable background jobs + their per-step artifacts. These
-- MUST live in SCHEMA as well as migrate(): create_room runs only SCHEMA, so
-- a table that exists only in migrate() is missing from a brand-new room
-- until it is closed and reopened (a job started in a fresh room would fail
-- with "no such table: jobs").
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '{}',
  cursor INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  -- Wave 4a: set on a child job a workflow drives INLINE (a file_pass node). The
  -- queue pump, resume_job and quiesce all skip these — the parent workflow job
  -- holds the lane slot and re-drives the child on its own resume, so a child
  -- must never start (or be Resumed) independently.
  parent_job_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS job_artifacts (
  job_id TEXT NOT NULL,
  step_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (job_id, step_id)
);
-- Wave 4a (Idea 2): LLM graph workflows. `definition` is the immutable
-- WorkflowDef JSON (nodes + edges); a RUN snapshots it into the jobs plan, so a
-- later edit never corrupts a paused run. `binding` (shortcuts extension) scopes
-- where a workflow surfaces (general vs file-kind); `pinned` shows it in the top
-- bar. MUST live in SCHEMA and migrate() (the schema.rs:115-119 rule).
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  emoji TEXT NOT NULL DEFAULT '',
  definition TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by TEXT NOT NULL DEFAULT 'user',
  binding TEXT NOT NULL DEFAULT '{"scope":"general"}',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  job_id TEXT,
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT,
  input_file_id TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_wf ON workflow_runs(workflow_id);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  param TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  catch_up INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,
  last_run_at TEXT,
  last_job_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_schedules_wf ON schedules(workflow_id);
-- Agent Skills are a separate library, not room files.  The two-table shape is
-- an encrypted representation of the portable folder contract: one metadata +
-- instruction row (SKILL.md) and any number of relative resource paths below it.
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS skill_resources (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'reference',
  content BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(skill_id, path)
);
CREATE INDEX IF NOT EXISTS idx_skill_resources_skill ON skill_resources(skill_id);
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
        _ => Err("This file is not a Arcelle project.".into()),
    }
}

/// Bring rooms created by older app versions up to the current schema.
pub(crate) fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chats (
           id TEXT PRIMARY KEY,
           title TEXT NOT NULL DEFAULT 'New chat',
           created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         );",
    )
    .map_err(|e| e.to_string())?;

    // ADD-30: durable background jobs (deep summaries, media digests, …). One
    // row per job: `plan` is the immutable step DAG (JSON), `state` is the
    // accumulating result + baton (JSON, rewritten each checkpoint), `cursor`
    // is the number of finished steps, `status` is queued|running|paused|
    // done|error. A job survives app restart and resumes from its cursor.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS jobs (
           id TEXT PRIMARY KEY,
           kind TEXT NOT NULL,
           title TEXT NOT NULL DEFAULT '',
           plan TEXT NOT NULL,
           state TEXT NOT NULL DEFAULT '{}',
           cursor INTEGER NOT NULL DEFAULT 0,
           total INTEGER NOT NULL DEFAULT 0,
           status TEXT NOT NULL DEFAULT 'queued',
           error TEXT,
           created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
           updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         );",
    )
    .map_err(|e| e.to_string())?;

    // ADD-32: per-step artifacts for windowed file-pass jobs. The job `state`
    // blob is rewritten on every checkpoint, so per-window outputs live here
    // instead — one small INSERT per finished step, and a resumed job finds
    // every artifact its cursor says exist. Deleted with the job.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS job_artifacts (
           job_id TEXT NOT NULL,
           step_id INTEGER NOT NULL,
           content TEXT NOT NULL,
           created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
           PRIMARY KEY (job_id, step_id)
         );",
    )
    .map_err(|e| e.to_string())?;

    // Wave 4a: a workflow's inline file_pass child rides the parent's lane slot,
    // so it must be invisible to pump/resume/quiesce. Guarded ALTER for rooms
    // whose jobs table predates the column (mirrors the folder_id/ai_summary
    // migrations above).
    if table_exists(conn, "jobs")? && !column_exists(conn, "jobs", "parent_job_id")? {
        conn.execute("ALTER TABLE jobs ADD COLUMN parent_job_id TEXT", [])
            .map_err(|e| e.to_string())?;
    }

    // Wave 4a (Idea 2): LLM graph workflows, their run history, and their
    // schedules. Old rooms opened via open_room never ran the new SCHEMA, so
    // mirror the three tables (+ indexes) here with IF NOT EXISTS.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS workflows (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           description TEXT NOT NULL DEFAULT '',
           emoji TEXT NOT NULL DEFAULT '',
           definition TEXT NOT NULL,
           status TEXT NOT NULL DEFAULT 'draft',
           created_by TEXT NOT NULL DEFAULT 'user',
           binding TEXT NOT NULL DEFAULT '{\"scope\":\"general\"}',
           pinned INTEGER NOT NULL DEFAULT 0,
           created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
           updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         );
         CREATE TABLE IF NOT EXISTS workflow_runs (
           id TEXT PRIMARY KEY,
           workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
           job_id TEXT,
           trigger TEXT NOT NULL DEFAULT 'manual',
           status TEXT NOT NULL DEFAULT 'running',
           error TEXT,
           input_file_id TEXT,
           started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
           finished_at TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_workflow_runs_wf ON workflow_runs(workflow_id);
         CREATE TABLE IF NOT EXISTS schedules (
           id TEXT PRIMARY KEY,
           workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
           kind TEXT NOT NULL,
           param TEXT NOT NULL DEFAULT '',
           enabled INTEGER NOT NULL DEFAULT 1,
           catch_up INTEGER NOT NULL DEFAULT 1,
           next_run_at TEXT,
           last_run_at TEXT,
           last_job_id TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_schedules_wf ON schedules(workflow_id);",
    )
    .map_err(|e| e.to_string())?;
    // Shortcuts extension: a workflows table created before the binding/pinned
    // columns existed gains them here (guarded ALTER precedent). input_file_id
    // rides workflow_runs the same way.
    if table_exists(conn, "workflows")? && !column_exists(conn, "workflows", "binding")? {
        conn.execute(
            "ALTER TABLE workflows ADD COLUMN binding TEXT NOT NULL DEFAULT '{\"scope\":\"general\"}'",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    if table_exists(conn, "workflows")? && !column_exists(conn, "workflows", "pinned")? {
        conn.execute("ALTER TABLE workflows ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0", [])
            .map_err(|e| e.to_string())?;
    }
    if table_exists(conn, "workflow_runs")? && !column_exists(conn, "workflow_runs", "input_file_id")? {
        conn.execute("ALTER TABLE workflow_runs ADD COLUMN input_file_id TEXT", [])
            .map_err(|e| e.to_string())?;
    }

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
    // Compound snapshots (see the base schema): older rooms lack the columns.
    // SQLite has no ADD COLUMN IF NOT EXISTS, so the duplicate-column error
    // is the idempotence check.
    for stmt in [
        "ALTER TABLE file_versions ADD COLUMN text TEXT",
        "ALTER TABLE file_versions ADD COLUMN rec_meta TEXT",
    ] {
        if let Err(e) = conn.execute(stmt, []) {
            let msg = e.to_string();
            if !msg.contains("duplicate column") {
                return Err(msg);
            }
        }
    }

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

    // ADD-27: live-recording metadata, one JSON row per recording file.
    // Guarded like the tables above — old rooms never ran the new SCHEMA.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS recordings (
           file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
           meta TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS rec_chunks (
           file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
           seq INTEGER NOT NULL,
           pcm BLOB NOT NULL,
           PRIMARY KEY (file_id, seq)
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

    // Wave 1b (idea 5): memory categories. Guarded ALTER like ai_summary above;
    // NULL = uncategorized, so legacy rooms open unchanged and keep every memory.
    if table_exists(conn, "memories")? && !column_exists(conn, "memories", "category")? {
        conn.execute("ALTER TABLE memories ADD COLUMN category TEXT", [])
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
        if user_version < 2 {
            rebuild_marked_hebrew_chunks(conn)?;
            conn.execute("PRAGMA user_version = 2", [])
                .map_err(|e| e.to_string())?;
        }
        if user_version < 3 {
            rebuild_capped_chunks(conn)?;
            conn.execute("PRAGMA user_version = 3", [])
                .map_err(|e| e.to_string())?;
        }
    }

    // PRIV-1/PRIV-2: the privacy gatekeeper's entity map + scan bookkeeping.
    // Guarded CREATEs like every table above — old rooms gain them on open.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS privacy_entities (
           id TEXT PRIMARY KEY,
           real_text TEXT NOT NULL UNIQUE,
           placeholder TEXT NOT NULL UNIQUE,
           category TEXT NOT NULL DEFAULT 'concept',
           source TEXT NOT NULL DEFAULT 'scan',
           created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         );
         CREATE TABLE IF NOT EXISTS privacy_scans (
           file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
           text_sha256 TEXT NOT NULL,
           rules_sha256 TEXT NOT NULL,
           scanned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         );",
    )
    .map_err(|e| e.to_string())?;

    // Skills mirror the portable SKILL.md folder format while remaining inside
    // the encrypted room and outside the ordinary `files` library.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS skills (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL UNIQUE,
           description TEXT NOT NULL,
           instructions TEXT NOT NULL DEFAULT '',
           enabled INTEGER NOT NULL DEFAULT 1,
           created_by TEXT NOT NULL DEFAULT 'user',
           created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
           updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         );
         CREATE TABLE IF NOT EXISTS skill_resources (
           id TEXT PRIMARY KEY,
           skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
           path TEXT NOT NULL,
           kind TEXT NOT NULL DEFAULT 'reference',
           content BLOB NOT NULL,
           created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
           updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
           UNIQUE(skill_id, path)
         );
         CREATE INDEX IF NOT EXISTS idx_skill_resources_skill ON skill_resources(skill_id);",
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// One-time (user_version 3): CHUNK_CAP used to be 2000 (~2M chars), so a
/// very long file's tail — the Hebrew Bible's last books — was silently
/// absent from the search index. Re-chunk every file that hit the old cap
/// under the raised one.
fn rebuild_capped_chunks(conn: &Connection) -> Result<(), String> {
    const OLD_CAP: i64 = 2000;
    let capped: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT file_id FROM chunks GROUP BY file_id HAVING count(*) >= ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([OLD_CAP], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    for file_id in capped {
        let text: Option<String> = conn
            .query_row(
                "SELECT extracted_text FROM files WHERE id = ?1",
                [&file_id],
                |r| r.get(0),
            )
            .ok()
            .flatten();
        let Some(text) = text else { continue };
        conn.execute("DELETE FROM chunks WHERE file_id = ?1", [&file_id])
            .map_err(|e| e.to_string())?;
        insert_chunks(conn, &file_id, Some(&text))?;
    }
    Ok(())
}

/// One-time (user_version 2): chunks indexed BEFORE nikud-stripping hold
/// pointed Hebrew that the FTS tokenizer shredded into single-letter
/// fragments — plain queries (קהלת) can never match them. Rebuild the chunks
/// of every affected file from its stored extracted text; `insert_chunks` now
/// strips the marks. Cheap (string filtering + SQL, no PDF parsing); the
/// embedding backfill re-embeds the new chunks in the background.
fn rebuild_marked_hebrew_chunks(conn: &Connection) -> Result<(), String> {
    // A LIKE probe per common nikud char finds affected files cheaply.
    let marked: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT file_id FROM chunks
                 WHERE text LIKE '%\u{05B0}%' OR text LIKE '%\u{05B7}%'
                    OR text LIKE '%\u{05B8}%' OR text LIKE '%\u{05B4}%'
                    OR text LIKE '%\u{05B6}%' OR text LIKE '%\u{05BC}%'",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    for file_id in marked {
        let text: Option<String> = conn
            .query_row(
                "SELECT extracted_text FROM files WHERE id = ?1",
                [&file_id],
                |r| r.get(0),
            )
            .ok()
            .flatten();
        let Some(text) = text else { continue };
        conn.execute("DELETE FROM chunks WHERE file_id = ?1", [&file_id])
            .map_err(|e| e.to_string())?;
        insert_chunks(conn, &file_id, Some(&text))?;
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
    fn marked_chunks_migration_makes_old_rooms_searchable() {
        // A room indexed BEFORE nikud-stripping: chunks hold pointed text the
        // FTS tokenizer shredded. The v2 migration rebuilds them consonantal.
        let conn = open_in_memory_schema();
        let pointed = "דִּבְרֵי קֹהֶלֶת בֶּן־דָּוִד";
        conn.execute(
            "INSERT INTO files(id, name, mime_type, size_bytes, source, original_bytes, extracted_text)
             VALUES ('f1', 'bible.pdf', 'application/pdf', 1, 'upload', x'00', ?1)",
            [pointed],
        )
        .unwrap();
        // Simulate the OLD indexing: pointed chunk text straight in.
        conn.execute(
            "INSERT INTO chunks(id, file_id, seq, text) VALUES ('c1', 'f1', 0, ?1)",
            [pointed],
        )
        .unwrap();
        let hits_before =
            crate::db::search_chunks_fts_ranked(&conn, "\"קהלת\"", 10).unwrap();
        assert!(hits_before.is_empty(), "pointed index must not match (the bug)");

        rebuild_marked_hebrew_chunks(&conn).unwrap();
        let hits_after =
            crate::db::search_chunks_fts_ranked(&conn, "\"קהלת\"", 10).unwrap();
        assert_eq!(hits_after.len(), 1, "consonantal rebuild must match");
        assert_eq!(hits_after[0].1, "bible.pdf");
    }

    #[test]
    fn memories_category_migration_alters_legacy_rooms() {
        // Wave 1b (idea 5): a room created BEFORE the category column existed
        // gains it on migrate(), and its rows read back as uncategorized. Start
        // from the full schema (migrate touches messages/chats too), then shape
        // the memories table exactly as legacy rooms had it.
        let conn = open_in_memory_schema();
        conn.execute_batch(
            "DROP TABLE memories;
             CREATE TABLE memories (
               id TEXT PRIMARY KEY,
               content TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
             );
             INSERT INTO memories(id, content) VALUES ('m1', 'the dog is named Rex');",
        )
        .unwrap();
        assert!(!column_exists(&conn, "memories", "category").unwrap());
        migrate(&conn).unwrap();
        assert!(column_exists(&conn, "memories", "category").unwrap());
        let got = crate::db::list_memories(&conn).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].content, "the dog is named Rex");
        assert!(got[0].category.is_none(), "legacy rows are uncategorized");
        // Idempotent on a second open.
        migrate(&conn).unwrap();
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
