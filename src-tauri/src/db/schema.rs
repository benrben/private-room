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
  -- BROWSE-2 (D19): where a downloaded file came from. NULL for everything
  -- that did not arrive over the network (uploads, generated files).
  origin_url TEXT,
  -- What a video ACTUALLY is (media_probe::MediaMeta as JSON): duration,
  -- display size, codec, frame rate, audio track. NULL means "not probed
  -- yet" — a probe that read nothing stores nothing, so NULL never has to
  -- stand in for "we looked and there was no answer".
  media_meta TEXT,
  -- What a SAVED WEB PAGE declares about itself (extraction::PageMeta as
  -- JSON): title, site, author, publication date, language, plus the room's
  -- own source URL and capture time. A field the page never declared is absent
  -- from the JSON — the room stores what the page said, and an author or a
  -- date it did not say has no value that could stand in for one. NULL means
  -- "this file did not come from a web page".
  web_meta TEXT,
  -- Room map: the file this one was MADE from, when a generator knows it (a
  -- full pass's source, a translated transcript's recording). NULL means "no
  -- provenance recorded" — never "made from nothing" — so the map draws a
  -- `derived` link only where the app actually witnessed the derivation
  -- instead of guessing from the output's name.
  derived_from TEXT,
  -- ART-1: what produced this file's CURRENT content (`Provenance` as JSON) —
  -- run id, agent/tool name, source file ids. Ids only, never content. This is
  -- the head of the same chain `file_versions.provenance` records for older
  -- states, so every version of a generated artifact can say what made it.
  -- Distinct from `derived_from`, which is a single file→file link for the room
  -- map and survives independently. NULL means nobody recorded it.
  provenance TEXT,
  -- ART-1: the name the generator ASKED for, which is what identifies an
  -- artifact across re-runs. Usually the same as `name`, but not always: when a
  -- file a PERSON put in the room already holds the requested name, the artifact
  -- lands under `available_name`'s next free one ("Plan (2).md") while its key
  -- stays "Plan.md". Matching the next generation on the KEY rather than on the
  -- final name is what stops a re-run minting "Plan (3).md", "Plan (4).md" …
  -- forever instead of versioning its own previous output. NULL for everything
  -- that did not come through the funnel, and CLEARED on rename — a file the
  -- user renamed is one they have adopted, and the next run must leave it alone
  -- and mint its own.
  artifact_key TEXT,
  -- Trash: when this file was deleted. NULL is the ONLY value that means
  -- "present in the room" — every listing, count, search and retrieval query
  -- filters on `trashed_at IS NULL`, so a trashed file is absent everywhere the
  -- user or the model can see, while its row and its bytes survive.
  trashed_at TEXT,
  -- Who deleted it: 'user' (a person clicked delete), 'agent' (the AI deleted
  -- it on its own), or 'app' (the app's own housekeeping). "What did the agent
  -- delete" is the question the trash exists to answer, so the actor is
  -- recorded at the moment of deletion rather than inferred later.
  trashed_by TEXT,
  -- WHICH actor, as an id: the agent/tool name for an 'agent' delete, the
  -- command for an 'app' one. NULL when the kind alone is the whole answer.
  trashed_by_id TEXT,
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
-- Trash: where a trashed file's search chunks WAIT. Trashing moves the rows out
-- of `chunks` and into here; restoring moves them back verbatim, embedding blob
-- and all.
--
-- Why move them instead of adding `AND f.trashed_at IS NULL` to the retrieval
-- joins: two of the hot retrieval queries (`for_each_chunk_embedding`,
-- `fts_file_matches`) never touch the `files` table at all, so there is no `f`
-- to filter on, and any future query over `chunks` would silently inherit the
-- bug. Emptying the table is the invariant — a trashed file cannot be retrieved
-- because its text is not in the index, not because every reader remembered to
-- ask. It also makes restore exact: re-chunking from `extracted_text` would
-- come back with NULL embeddings and stay invisible to vector search until a
-- background pass happened to re-embed it.
CREATE TABLE IF NOT EXISTS trashed_chunks (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_trashed_chunks_file ON trashed_chunks(file_id);
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
  kind TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  -- Wave 1b (idea 5): preference | fact | project | instruction; NULL =
  -- uncategorized (every legacy row). Organizational only in v1.
  category TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  -- S9 (2026-08-04): soft delete, same shape as files' trash — NULL means
  -- never trashed. `delete_memory` was the app's one truly irreversible AI
  -- action; every other write has snapshot/Undo or the files Trash tab.
  trashed_at TEXT,
  trashed_by TEXT,
  trashed_by_id TEXT
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
-- BROWSE-3b: preview-image bytes for search results, keyed by the image's own
-- URL. Every byte arrived through the Rust guard, so the results page can render
-- from data URLs and never make a request of its own.
CREATE TABLE IF NOT EXISTS web_images (
  url TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- CHG-33: short-lived web_search results cache, keyed by normalized query. This
-- lived ONLY in `migrate` for a while, which meant a brand-new room (which runs
-- SCHEMA and never migrate) had no table at all: every attempt to remember a
-- search failed silently until the room was closed and reopened. Both places
-- must mint every table — `migrate` for rooms written before it existed, here
-- for the ones created from now on.
CREATE TABLE IF NOT EXISTS web_searches (
  query_key TEXT PRIMARY KEY,
  results_text TEXT NOT NULL,
  saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
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
  cause TEXT NOT NULL,
  -- ART-1: what produced the content this row snapshots (`Provenance` as
  -- JSON) — run id, agent/tool name, source file ids. Ids only, never
  -- content. NULL means "nobody recorded it", never "a person typed it".
  provenance TEXT,
  -- A version the user asked to KEEP. The prune in `snapshot_file_version`
  -- counts and deletes only unpinned rows, so a pinned version survives any
  -- number of later saves — the one way to stop the rolling window from
  -- silently eating the state you actually wanted back.
  pinned INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_file_versions_file ON file_versions(file_id);
-- ART-1: the staging area for AI-generated artifacts. A generator writes its
-- bytes HERE, they are validated here, and only then does one transaction move
-- them into `files`. A crash, a Stop, or a failed validation therefore leaves
-- the room's real files exactly as they were — there is no window in which a
-- half-written artifact is what the library shows. Staging lives INSIDE the
-- encrypted room like everything else: a scratch file in /tmp would put room
-- content outside the room, which is the one thing this app does not do.
--
-- Rows are transient. A commit deletes its own row; anything an interrupted run
-- left behind is swept on the next room open (`sweep_staged_artifacts`), which
-- is why nothing else in the app ever reads this table.
CREATE TABLE IF NOT EXISTS staged_artifacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  text TEXT,
  provenance TEXT,
  staged_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
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
  -- Why this job stopped when NOBODY chose to stop it: the room was locked, or
  -- the app closed, while it was still running. 'paused' alone cannot say that
  -- — it is also what pressing Stop writes — so a job the app dropped read as a
  -- job the user parked. NULL means the pause was the user's own.
  parked_reason TEXT,
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
  agent TEXT NOT NULL DEFAULT '',
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
CREATE TABLE IF NOT EXISTS browse_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
"#;

/// Key a connection AND pin the on-disk cipher parameters (A1).
///
/// The pin used to be spelled out at each call site, and only two of the four
/// call sites had it: `create_room` and `open_room` pinned SQLCipher 4,
/// `verify_password` (change-password's "is this your current password?") and
/// `rekey_copy` (duplicate-a-room, restore-a-checkpoint) did not. It matches the
/// linked SQLCipher's default today, so nothing misbehaves — but the whole point
/// of pinning is to survive a build where it does NOT, and in that build a room
/// would open fine and then refuse its own password on the two paths that re-key
/// it. Keying and pinning belong together, so they live in one function: a
/// fifth caller cannot forget half of it. Must run before the first real read
/// (`verify_key`), which is what every caller does next.
pub(crate) fn apply_key(conn: &Connection, password: &str) -> Result<(), String> {
    conn.pragma_update(None, "key", password)
        .map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA cipher_compatibility = 4;")
        .map_err(|e| e.to_string())
}

/// Verify the key actually decrypts the file. With SQLCipher, a wrong key
/// surfaces as "file is not a database" on the first real read.
pub(crate) fn verify_key(conn: &Connection) -> Result<(), String> {
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| {
        r.get::<_, i64>(0)
    })
    .map(|_| ())
    .map_err(classify_first_read)
}

/// Why the first read after keying failed.
///
/// It used to be "WRONG_PASSWORD", unconditionally — so a truncated file, a
/// failing disk, a room on a network volume that dropped, or a file another
/// process holds locked all told the user their password was wrong. They retype
/// it forever while the real fix is somewhere else entirely.
///
/// A wrong SQLCipher key decrypts the header into noise, which SQLite rejects as
/// `SQLITE_NOTADB` — that (and an unclassifiable error, which stays the common
/// case) is the only thing allowed to say "wrong password". Every other SQLite
/// code names itself instead. Only the CODE travels: an error string can carry
/// the file's path, and a file name is room content.
fn classify_first_read(e: rusqlite::Error) -> String {
    let code = match &e {
        rusqlite::Error::SqliteFailure(err, _) => Some(err.code),
        _ => None,
    };
    match code {
        None | Some(rusqlite::ffi::ErrorCode::NotADatabase) => "WRONG_PASSWORD".to_string(),
        Some(other) => format!(
            "This room file could not be read ({other:?}) — the password may be fine. \
             Check that the file is on a connected drive, not open in another copy of \
             Arcelle, and not damaged."
        ),
    }
}

/// The schema revision a room created TODAY is already at, so `migrate` runs
/// none of its one-time repairs against it.
///
/// A new room used to be stamped 0, which is what a room written years ago looks
/// like: the very next unlock ran every repair, and repair #1 nulls every
/// embedding in the room. A first session's whole semantic index was erased the
/// first time the room was reopened, silently dropping meaning-based search back
/// to keyword matching until the background backfill caught up. Raise this in
/// lockstep with the last `if user_version < N` block in [`migrate`].
pub(crate) const CURRENT_USER_VERSION: i64 = 3;

/// Room-file password policy, enforced at the seam that actually encrypts one.
///
/// The 8-character rule was written into the new-room FORM and into
/// `change_password`/`duplicate_room`, but never here — so the one place that
/// creates and keys a room accepted a single character, and any new caller
/// (a script, a future command, an agent tool) would have inherited that.
pub const MIN_ROOM_PASSWORD_CHARS: usize = 8;

pub fn create_room(path: &str, password: &str, name: &str) -> Result<Connection, String> {
    if std::path::Path::new(path).exists() {
        return Err("A file already exists at this location.".into());
    }
    if password.chars().count() < MIN_ROOM_PASSWORD_CHARS {
        return Err(format!(
            "A room password needs at least {MIN_ROOM_PASSWORD_CHARS} characters."
        ));
    }
    create_room_file(path, |conn| {
        // A1: `apply_key` also pins the SQLCipher-4 parameter set, so a room
        // stays portable across builds/platforms.
        apply_key(conn, password)?;
        verify_key(conn)?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        // This room is BORN current — see `CURRENT_USER_VERSION`.
        conn.execute(&format!("PRAGMA user_version = {CURRENT_USER_VERSION}"), [])
            .map_err(|e| e.to_string())?;

        conn.execute(
            "INSERT INTO meta(key, value) VALUES ('format','roomai'), ('format_version','1'), ('name', ?1)",
            [name],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

/// Open a NEW room file and hand it to `init`; if `init` fails, take the
/// half-written file away again.
///
/// SQLite creates the file the moment it is opened, before any of the keying or
/// schema work can fail. Whatever went wrong then left a 0-byte (or partly
/// keyed) file sitting at the chosen path, and the retry — with the same name,
/// which is what anyone does next — hit "A file already exists at this
/// location." for good, with nothing in the app able to remove it.
fn create_room_file(
    path: &str,
    init: impl FnOnce(&Connection) -> Result<(), String>,
) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    match init(&conn) {
        Ok(()) => Ok(conn),
        Err(e) => {
            // Close the handle first: an open connection can leave -wal/-shm
            // siblings that would outlive the file we are about to remove.
            drop(conn);
            let _ = std::fs::remove_file(path);
            let _ = std::fs::remove_file(format!("{path}-wal"));
            let _ = std::fs::remove_file(format!("{path}-shm"));
            Err(e)
        }
    }
}

pub fn open_room(path: &str, password: &str) -> Result<Connection, String> {
    if !std::path::Path::new(path).exists() {
        return Err("File not found.".into());
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    // A1: `apply_key` pins the SQLCipher-4 parameter set too, so this room
    // decrypts regardless of the linked SQLCipher's own defaults.
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
        _ => Err("This file is not an Arcelle project.".into()),
    }
}

/// Open a room WITHOUT changing it — decrypt, prove the key, confirm the file
/// really is one of ours, and stop there.
///
/// [`open_room`] always runs [`migrate`], which creates tables and at least one
/// write. That is right for the app and wrong for a check: `roomai verify` /
/// `roomai info` promise to read, and on a copy sitting on a read-only volume
/// or a backup they failed with a database error instead of a verdict — and on
/// a room that had not been opened since the last schema change, "verifying" it
/// quietly rebuilt its search index.
///
/// SQLite is asked for a read-only handle as well, so the promise is enforced
/// by the engine rather than by this function remembering not to write.
pub fn open_room_readonly(path: &str, password: &str) -> Result<Connection, String> {
    if !std::path::Path::new(path).exists() {
        return Err("File not found.".into());
    }
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| e.to_string())?;
    apply_key(&conn, password)?;
    verify_key(&conn)?;
    let format: Result<String, _> =
        conn.query_row("SELECT value FROM meta WHERE key = 'format'", [], |r| r.get(0));
    match format {
        Ok(f) if f == "roomai" => Ok(conn),
        _ => Err("This file is not an Arcelle project.".into()),
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

    // Why a job stopped when nobody pressed Stop (room locked / app closed).
    // Same guarded-ALTER shape as `parent_job_id` above; an old room's rows come
    // back NULL, which reads exactly as today's "the user paused this".
    if table_exists(conn, "jobs")? && !column_exists(conn, "jobs", "parked_reason")? {
        conn.execute("ALTER TABLE jobs ADD COLUMN parked_reason TEXT", [])
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
    for stmt in [
        "ALTER TABLE file_versions ADD COLUMN text TEXT",
        "ALTER TABLE file_versions ADD COLUMN rec_meta TEXT",
        // ART-1: per-version provenance. Existing versions keep NULL, which
        // reads as "not recorded" — the History strip says nothing about them
        // rather than attributing them to a run that may not have made them.
        "ALTER TABLE file_versions ADD COLUMN provenance TEXT",
        // "Keep this one": excluded from the rolling prune. Existing versions
        // default to 0, i.e. exactly today's behaviour for every old room.
        "ALTER TABLE file_versions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE files ADD COLUMN provenance TEXT",
        // ART-1: the requested name a regeneration is matched on. Existing
        // generated files keep NULL and are matched on their `name` instead
        // (see `commit_staged`), so a room written before this column still
        // versions its artifacts rather than duplicating them.
        "ALTER TABLE files ADD COLUMN artifact_key TEXT",
    ] {
        add_column_if_missing(conn, stmt)?;
    }

    // ART-1: the artifact staging area. Old rooms opened via open_room never ran
    // SCHEMA, so mirror the table here — see the base schema for why staging
    // lives inside the encrypted room.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS staged_artifacts (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           mime TEXT NOT NULL,
           bytes BLOB NOT NULL,
           text TEXT,
           provenance TEXT,
           staged_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         );",
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

    // BROWSE-3b: preview-image cache for search results. Guarded like the tables
    // above — old rooms never ran the new SCHEMA.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS web_images (
           url TEXT PRIMARY KEY,
           mime TEXT NOT NULL,
           bytes BLOB NOT NULL,
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

    // BROWSE-2 (D19): download provenance. Guarded ALTER like ai_summary above.
    if table_exists(conn, "files")? && !column_exists(conn, "files", "origin_url")? {
        conn.execute("ALTER TABLE files ADD COLUMN origin_url TEXT", [])
            .map_err(|e| e.to_string())?;
    }

    // Room map: file→file provenance, written at the moment a generator makes a
    // file from another one. Guarded ALTER like origin_url above.
    if table_exists(conn, "files")? && !column_exists(conn, "files", "derived_from")? {
        conn.execute("ALTER TABLE files ADD COLUMN derived_from TEXT", [])
            .map_err(|e| e.to_string())?;
        // One-off recovery for rooms whose full passes ran before the column
        // existed: a `file_pass` job's plan names the SOURCE file and its
        // publish artifact names the OUTPUT, so the pair can be recovered
        // exactly. Best-effort by design — `delete_job` cascades its artifacts,
        // so a dismissed job leaves nothing to recover and the file simply keeps
        // no provenance rather than being given a guessed one.
        //
        // `json_valid` guards both blobs: `job_artifacts.content` is
        // unconstrained TEXT, and `json_extract` on a non-JSON row would abort
        // the whole migration (i.e. refuse to open the room).
        const RECOVERED: &str = "(SELECT json_extract(j.plan, '$.fileId')
              FROM jobs j JOIN job_artifacts a ON a.job_id = j.id
              WHERE j.kind = 'file_pass'
                AND json_valid(j.plan) AND json_valid(a.content)
                AND json_extract(a.content, '$.file_id') = files.id
              LIMIT 1)";
        if table_exists(conn, "jobs")? && table_exists(conn, "job_artifacts")? {
            conn.execute(
                &format!(
                    "UPDATE files SET derived_from = {RECOVERED}
                     WHERE derived_from IS NULL AND {RECOVERED} IS NOT NULL"
                ),
                [],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    // Video technical metadata (media_probe::MediaMeta as JSON). Guarded ALTER
    // like origin_url above — and it has to be BOTH here and in `SCHEMA`,
    // because `create_room` runs only `SCHEMA` (see the note at the top of
    // this file); a migrate-only column is missing from every brand-new room.
    if table_exists(conn, "files")? && !column_exists(conn, "files", "media_meta")? {
        conn.execute("ALTER TABLE files ADD COLUMN media_meta TEXT", [])
            .map_err(|e| e.to_string())?;
    }

    // What a saved web page declares about itself (extraction::PageMeta as
    // JSON). Guarded ALTER, and in BOTH places for the same reason media_meta
    // is: a migrate-only column is missing from every brand-new room.
    if table_exists(conn, "files")? && !column_exists(conn, "files", "web_meta")? {
        conn.execute("ALTER TABLE files ADD COLUMN web_meta TEXT", [])
            .map_err(|e| e.to_string())?;
    }

    // Trash / undo. Guarded ALTERs like media_meta above, and — the schema.rs
    // rule — every one of them also lives in `SCHEMA`, because `create_room`
    // never runs `migrate`.
    //
    // Existing rooms come out with `trashed_at` NULL on every row, which is
    // exactly right: nothing that was in the library before the trash existed
    // was ever deleted, so nothing starts out in it.
    if table_exists(conn, "files")? {
        for (column, decl) in [
            ("trashed_at", "ALTER TABLE files ADD COLUMN trashed_at TEXT"),
            ("trashed_by", "ALTER TABLE files ADD COLUMN trashed_by TEXT"),
            ("trashed_by_id", "ALTER TABLE files ADD COLUMN trashed_by_id TEXT"),
        ] {
            if !column_exists(conn, "files", column)? {
                conn.execute(decl, []).map_err(|e| e.to_string())?;
            }
        }
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS trashed_chunks (
           id TEXT PRIMARY KEY,
           file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
           seq INTEGER NOT NULL,
           text TEXT NOT NULL,
           embedding BLOB
         );
         CREATE INDEX IF NOT EXISTS idx_trashed_chunks_file ON trashed_chunks(file_id);",
    )
    .map_err(|e| e.to_string())?;

    // Wave 1b (idea 5): memory categories. Guarded ALTER like ai_summary above;
    // NULL = uncategorized, so legacy rooms open unchanged and keep every memory.
    if table_exists(conn, "memories")? && !column_exists(conn, "memories", "category")? {
        conn.execute("ALTER TABLE memories ADD COLUMN category TEXT", [])
            .map_err(|e| e.to_string())?;
    }

    // S9 (2026-08-04): memory soft-delete, same guarded-ALTER shape as the
    // files trash above. Existing rooms come out with `trashed_at` NULL on
    // every row — nothing trashed before the column existed.
    if table_exists(conn, "memories")? {
        for (column, decl) in [
            ("trashed_at", "ALTER TABLE memories ADD COLUMN trashed_at TEXT"),
            ("trashed_by", "ALTER TABLE memories ADD COLUMN trashed_by TEXT"),
            ("trashed_by_id", "ALTER TABLE memories ADD COLUMN trashed_by_id TEXT"),
        ] {
            if !column_exists(conn, "memories", column)? {
                conn.execute(decl, []).map_err(|e| e.to_string())?;
            }
        }
    }

    // ADD-23: structured viewer effects (boxes/annotation) ride their own
    // column so assistant `content` stays plain prose. Guarded ALTER for rooms
    // created before the column existed; legacy fenced ```boxes/```annotation
    // blocks inside old messages are still parsed by the UI as a fallback.
    if table_exists(conn, "messages")? && !column_exists(conn, "messages", "effects")? {
        conn.execute("ALTER TABLE messages ADD COLUMN effects TEXT", [])
            .map_err(|e| e.to_string())?;
    }

    // Token-budget bar / context handoff: a flag on the existing row, not a new
    // `role` — `role` is pattern-matched throughout the LLM-facing plumbing
    // (chat.py's `_to_langchain`, `ollama::ChatMessage` construction), where an
    // unrecognized value would need auditing everywhere. `kind` is purely
    // additive metadata, same shape as `effects` above. NULL for every
    // ordinary row; `'handoff'` marks a context-compaction summary message —
    // `db::recent_messages` starts a turn's history from the latest one.
    if table_exists(conn, "messages")? && !column_exists(conn, "messages", "kind")? {
        conn.execute("ALTER TABLE messages ADD COLUMN kind TEXT", [])
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
           agent TEXT NOT NULL DEFAULT '',
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
    // 2026-07-24: which sub-agent owns this skill (an `agent:` key in SKILL.md
    // frontmatter). Empty = GENERAL, offered to every agent — which is what
    // every pre-existing skill stays. Placed AFTER the CREATE above, not with
    // the file_versions ALTERs near the top: a room written before the skills
    // table existed has nothing to alter until this block has run, and the
    // ALTER's "no such table" error is fatal to `migrate`, so an old room could
    // not be opened at all (regression caught by
    // `roomfile::migrates_old_rooms_into_sessions`).
    add_column_if_missing(conn, "ALTER TABLE skills ADD COLUMN agent TEXT NOT NULL DEFAULT ''")?;
    // BROWSE-1: the private browser's audit trail. Nothing about the WEB is
    // persisted (the webview runs non-persistent); everything the AGENT did is,
    // here, in the encrypted room.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS browse_journal (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           kind TEXT NOT NULL,
           url TEXT NOT NULL DEFAULT '',
           detail TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         );",
    )
    .map_err(|e| e.to_string())?;

    // Rooms opened before the jobs write path enforced one parked entry per unit
    // of work carry the pile-up it allowed: several indistinguishable paused
    // copies of the same workflow in Activity. Repair them here rather than
    // behind a `user_version` stamp — the sweep is a cheap invariant check over a
    // handful of rows, it is a no-op on a room that is already clean, and it
    // keeps holding if a future write path ever misses the rule.
    crate::db::dedupe_parked_jobs(conn)?;
    // ART-1: a staged artifact that outlived its session belongs to a generation
    // that never committed — by construction it is not in the library, so
    // clearing it here reclaims the space without changing what the room shows.
    crate::db::sweep_staged_artifacts(conn)?;
    Ok(())
}

/// `ALTER TABLE … ADD COLUMN`, idempotent. SQLite has no `ADD COLUMN IF NOT
/// EXISTS`, so the two "already fine" outcomes are recognised by their error
/// text and swallowed:
///
/// * `duplicate column` — the room already has it (the ordinary re-open path);
/// * `no such table` — the room predates the table entirely, so a later
///   `CREATE TABLE IF NOT EXISTS` in this same `migrate` will mint it WITH the
///   column. Treating this as fatal is what broke opening old rooms.
///
/// Anything else is a real schema failure and still aborts the migration.
fn add_column_if_missing(conn: &Connection, stmt: &str) -> Result<(), String> {
    if let Err(e) = conn.execute(stmt, []) {
        let msg = e.to_string();
        if !(msg.contains("duplicate column") || msg.contains("no such table")) {
            return Err(msg);
        }
    }
    Ok(())
}

/// Replace one file's chunks, all-or-nothing.
///
/// Both one-time repairs below re-index a file by erasing its chunks and
/// rebuilding them from the stored text. Those were two loose statements: a
/// failure (or a crash) in between left the file with NO chunks at all, and
/// because the `user_version` stamp is written once for the whole sweep, the
/// next unlock considers the repair done. The document still opens fine and is
/// simply never found in search again, with nothing said. Either the new chunks
/// land or the old ones stay.
fn reindex_one_file(conn: &Connection, file_id: &str, text: &str) -> Result<(), String> {
    crate::db::in_transaction(conn, || {
        conn.execute("DELETE FROM chunks WHERE file_id = ?1", [file_id])
            .map_err(|e| e.to_string())?;
        insert_chunks(conn, file_id, Some(text))
    })
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
        reindex_one_file(conn, &file_id, &text)?;
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
        reindex_one_file(conn, &file_id, &text)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `roomai verify` promises to look, not touch. It used to go through
    /// `open_room`, which always runs `migrate` — at least one write — so the
    /// check failed outright on a copy on a read-only volume, and on a room not
    /// opened since the last schema change it rebuilt the search index. The
    /// read-only handle makes the promise SQLite's to keep.
    #[test]
    fn a_read_only_open_verifies_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("check.roomai");
        let path = path.to_str().unwrap();
        drop(create_room(path, "correct horse battery", "Check").unwrap());

        let conn = open_room_readonly(path, "correct horse battery").unwrap();
        // It really is the room…
        let name: String = conn
            .query_row("SELECT value FROM meta WHERE key = 'name'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "Check");
        // …and nothing can write through this handle, migration included.
        assert!(
            conn.execute_batch("CREATE TABLE scribble(x)").is_err(),
            "a verify handle must not be able to write to the room"
        );
        assert!(migrate(&conn).is_err(), "migrate must not run on a verify handle");

        // A wrong password is still a wrong password, and a non-room is still
        // not a room — the check must not become laxer for being read-only.
        assert!(open_room_readonly(path, "wrong password here").is_err());
    }

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
    fn s9_trash_columns_reach_a_memories_table_written_before_them() {
        // A room created before S9 (2026-08-04) gains trashed_at/by/by_id on
        // migrate(), and its existing memory reads back active (untrashed) —
        // nothing that predates the trash column starts out inside it.
        let conn = open_in_memory_schema();
        conn.execute_batch(
            "DROP TABLE memories;
             CREATE TABLE memories (
               id TEXT PRIMARY KEY,
               content TEXT NOT NULL,
               category TEXT,
               created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
             );
             INSERT INTO memories(id, content) VALUES ('m1', 'call every Friday');",
        )
        .unwrap();
        assert!(!column_exists(&conn, "memories", "trashed_at").unwrap());
        migrate(&conn).unwrap();
        for col in ["trashed_at", "trashed_by", "trashed_by_id"] {
            assert!(column_exists(&conn, "memories", col).unwrap(), "missing {col}");
        }
        let got = crate::db::list_memories(&conn).unwrap();
        assert_eq!(got.len(), 1, "the legacy memory must not start out trashed");
        assert_eq!(got[0].content, "call every Friday");
        // Idempotent on a second open.
        migrate(&conn).unwrap();
    }

    #[test]
    fn artifact_staging_and_provenance_reach_a_room_written_before_them() {
        // ART-1: the net under an unattended AI write is only a net if it also
        // covers rooms that already exist. An old room must gain the staging
        // table and both provenance columns on open, and its EXISTING versions
        // must read back with no provenance rather than an invented one.
        // Same shape as the two migration tests below: full schema, then the
        // affected tables re-created exactly as older rooms had them. (Recreated
        // rather than `ALTER … DROP COLUMN`, which rewrites the stored DDL and
        // trips over the column comments the base schema carries.)
        let conn = open_in_memory_schema();
        conn.execute_batch(
            "DROP TABLE staged_artifacts;
             DROP TABLE file_versions;
             DROP TABLE files;
             CREATE TABLE files (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               mime_type TEXT,
               size_bytes INTEGER NOT NULL DEFAULT 0,
               source TEXT NOT NULL DEFAULT 'upload',
               original_bytes BLOB,
               extracted_text TEXT,
               folder_id TEXT,
               ai_summary TEXT,
               origin_url TEXT,
               created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
             );
             CREATE TABLE file_versions (
               id TEXT PRIMARY KEY,
               file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
               bytes BLOB NOT NULL,
               text TEXT,
               rec_meta TEXT,
               saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
               cause TEXT NOT NULL
             );
             INSERT INTO files(id, name, mime_type, source, original_bytes, extracted_text)
               VALUES ('f1', 'Deck.html', 'text/html', 'generated', x'6f6c64', 'old');
             INSERT INTO file_versions(id, file_id, bytes, cause)
               VALUES ('v1', 'f1', x'6f6c646572', 'You saved');",
        )
        .unwrap();
        assert!(!column_exists(&conn, "files", "provenance").unwrap());
        assert!(!table_exists(&conn, "staged_artifacts").unwrap());

        migrate(&conn).unwrap();

        assert!(column_exists(&conn, "files", "provenance").unwrap());
        assert!(column_exists(&conn, "files", "artifact_key").unwrap());
        assert!(column_exists(&conn, "file_versions", "provenance").unwrap());
        assert!(table_exists(&conn, "staged_artifacts").unwrap());
        // The pre-existing version is listed, and claims no author.
        let versions = crate::db::list_file_versions(&conn, "f1").unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].cause, "You saved");
        assert!(versions[0].provenance.is_none(), "an old version credits nobody");
        assert!(crate::db::file_provenance(&conn, "f1").unwrap().is_none());

        // And the funnel works on the migrated room: a regeneration versions it.
        let staged = crate::db::stage_artifact(
            &conn,
            "Deck.html",
            "text/html",
            b"new",
            Some("new"),
            &crate::db::Provenance { agent: Some("Flashcards".into()), ..Default::default() },
        )
        .unwrap();
        let (meta, versioned) = crate::db::commit_staged(&conn, &staged.id).unwrap();
        assert!(versioned);
        assert_eq!(meta.id, "f1");
        assert_eq!(crate::db::list_file_versions(&conn, "f1").unwrap().len(), 2);
        // Idempotent on a second open.
        migrate(&conn).unwrap();
    }

    #[test]
    fn derived_from_migration_recovers_provenance_from_finished_passes() {
        // Room map: a room whose full passes ran BEFORE the column existed still
        // has the pair on the jobs row (plan names the source, the publish
        // artifact names the output), so the one-off ALTER recovers it. Same
        // shape as the memories-category test: full schema, then the files table
        // reshaped as legacy rooms had it.
        let conn = open_in_memory_schema();
        conn.execute_batch(
            "DROP TABLE files;
             CREATE TABLE files (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               mime_type TEXT,
               size_bytes INTEGER NOT NULL DEFAULT 0,
               source TEXT NOT NULL DEFAULT 'upload',
               original_bytes BLOB,
               extracted_text TEXT,
               folder_id TEXT,
               ai_summary TEXT,
               origin_url TEXT,
               created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
             );
             INSERT INTO files(id, name) VALUES ('src', 'lease.pdf'), ('out', 'Full pass — lease.pdf.html'), ('plain', 'photo.png');
             INSERT INTO jobs(id, kind, plan) VALUES ('j1', 'file_pass', '{\"fileId\":\"src\",\"fileName\":\"lease.pdf\"}');
             INSERT INTO job_artifacts(job_id, step_id, content) VALUES ('j1', 9, '{\"file_id\":\"out\"}');
             -- job_artifacts.content is unconstrained TEXT. A row that is not
             -- JSON used to be enough to abort json_extract — i.e. to refuse to
             -- open the room — so the migration must survive one.
             INSERT INTO job_artifacts(job_id, step_id, content) VALUES ('j1', 10, 'not json at all');",
        )
        .unwrap();
        assert!(!column_exists(&conn, "files", "derived_from").unwrap());
        migrate(&conn).unwrap();
        assert!(column_exists(&conn, "files", "derived_from").unwrap());

        let recovered = crate::db::derived_links(&conn).unwrap();
        assert_eq!(recovered, vec![("src".to_string(), "out".to_string())]);
        // A file no pass produced keeps no provenance — the migration recovers
        // what the room recorded, it does not invent a parent for everything.
        let plain: Option<String> = conn
            .query_row("SELECT derived_from FROM files WHERE id = 'plain'", [], |r| r.get(0))
            .unwrap();
        assert!(plain.is_none());
        // Idempotent on a second open.
        migrate(&conn).unwrap();
        assert_eq!(crate::db::derived_links(&conn).unwrap().len(), 1);
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

    /// A new room is stamped at the CURRENT schema revision. Stamped 0 — which
    /// is what a room written years ago looks like — the very next unlock ran
    /// every one-time repair against it, and the first of those nulls every
    /// embedding in the room. A first session's whole semantic index was thrown
    /// away the first time the room was reopened.
    #[test]
    fn a_new_room_keeps_the_search_index_it_built_in_its_first_session() {
        let path = temp_room_path();
        {
            let conn = create_room(&path, "correct horse", "My Room").unwrap();
            conn.execute(
                "INSERT INTO files(id, name, mime_type, source, original_bytes, extracted_text)
                 VALUES ('f1', 'notes.md', 'text/markdown', 'upload', x'00', 'hello')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO chunks(id, file_id, seq, text, embedding)
                 VALUES ('c1', 'f1', 0, 'hello', x'0102030405060708')",
                [],
            )
            .unwrap();
        }
        let conn = open_room(&path, "correct horse").unwrap();
        let embedded: i64 = conn
            .query_row("SELECT count(*) FROM chunks WHERE embedding IS NOT NULL", [], |r| r.get(0))
            .unwrap();
        assert_eq!(embedded, 1, "reopening a NEW room erased its embeddings");
        assert_eq!(
            conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(),
            CURRENT_USER_VERSION,
        );
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    /// `CURRENT_USER_VERSION` is what stops a brand-new room running the
    /// one-time repairs (repair #1 nulls every embedding in the room). Its
    /// correctness is a promise about a number in ANOTHER function — "raise this
    /// in lockstep with the last `if user_version < N` block in `migrate`" — and
    /// a promise in a doc comment is not a guard. The next migration added
    /// without touching the constant silently re-opens the exact bug: the new
    /// room is stamped 3, `migrate` sees `3 < 4`, and the sweep runs on a room
    /// that was born current. Read the source and check.
    #[test]
    fn the_born_current_stamp_covers_every_one_time_repair() {
        let src = include_str!("schema.rs");
        let highest = src
            .match_indices("user_version < ")
            .filter_map(|(i, _)| {
                src[i + "user_version < ".len()..]
                    .split(|c: char| !c.is_ascii_digit())
                    .next()
                    .filter(|d| !d.is_empty())
                    .and_then(|d| d.parse::<i64>().ok())
            })
            .max()
            .expect("migrate has no one-time repairs at all — did they move?");
        assert_eq!(
            CURRENT_USER_VERSION, highest,
            "a migration was added without raising CURRENT_USER_VERSION: a room \
             created today is stamped {CURRENT_USER_VERSION}, so `migrate` will run \
             repair {highest} against it — and repair 1 erases every embedding the \
             room built in its first session",
        );
    }

    /// The search cache's table was minted only by `migrate`, so a brand-new
    /// room had nowhere to put a result until it had been closed and reopened
    /// once — every write failed, silently, for the whole first session.
    #[test]
    fn a_new_room_can_remember_a_web_search_straight_away() {
        let path = temp_room_path();
        let conn = create_room(&path, "correct horse", "My Room").unwrap();
        let hits = vec![crate::web::WebHit {
            title: "Rust".into(),
            url: "https://example.test/rust".into(),
            engines: vec!["test".into()],
            date: None,
            snippet: Some("systems language".into()),
            score: 1.0,
        }];
        crate::db::put_web_search(&conn, "rust", &hits).expect("a new room could not cache a search");
        assert_eq!(
            crate::db::get_fresh_web_search(&conn, "rust").map(|h| h.len()),
            Some(1),
        );
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    /// SQLite creates the file the moment it is opened — before anything that
    /// could fail has run. A failure used to leave that file behind, and the
    /// obvious retry (same name) then hit "A file already exists at this
    /// location." for good, with nothing in the app able to remove it.
    #[test]
    fn a_failed_creation_leaves_no_file_blocking_the_retry() {
        let path = temp_room_path();
        let err = create_room_file(&path, |_| Err("the disk went away".into())).unwrap_err();
        assert_eq!(err, "the disk went away");
        assert!(
            !std::path::Path::new(&path).exists(),
            "the half-written room file blocks every retry with the same name",
        );
    }

    /// The one place a room is actually created and encrypted enforces the
    /// password rule the new-room FORM has always shown. Nothing may slip past
    /// it — and a refusal must not leave a file behind either.
    #[test]
    fn a_room_password_must_clear_the_length_rule() {
        let path = temp_room_path();
        let err = create_room(&path, "1234567", "Short").unwrap_err();
        assert!(err.contains("8 characters"), "{err}");
        assert!(!std::path::Path::new(&path).exists());
        create_room(&path, "12345678", "Exactly eight").expect("eight characters is enough");
        let _ = std::fs::remove_file(&path);
    }

    /// A damaged file, a disk that is failing, a room on a network volume that
    /// dropped: every one of these used to be reported as a wrong password, so
    /// the user retypes it forever while the real fix is elsewhere.
    #[test]
    fn only_an_undecryptable_file_reads_as_a_wrong_password() {
        let notadb = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_NOTADB),
            Some("file is not a database".into()),
        );
        assert_eq!(classify_first_read(notadb), "WRONG_PASSWORD");

        let io = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_IOERR),
            Some("disk I/O error".into()),
        );
        let msg = classify_first_read(io);
        assert!(!msg.contains("WRONG_PASSWORD"), "{msg}");
        assert!(msg.contains("could not be read"), "{msg}");
    }

    /// A one-time repair erases a file's chunks and rebuilds them. If the
    /// rebuild fails in between, the old chunks must still be there: the
    /// `user_version` stamp is written once for the whole sweep, so a file left
    /// with no chunks is never re-indexed and simply stops being findable.
    #[test]
    fn a_reindex_that_fails_halfway_keeps_the_old_index() {
        let conn = open_in_memory_schema();
        conn.execute(
            "INSERT INTO files(id, name, mime_type, source, original_bytes, extracted_text)
             VALUES ('f1', 'lease.pdf', 'application/pdf', 'upload', x'00', 'the rent is due')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chunks(id, file_id, seq, text) VALUES ('c1', 'f1', 0, 'the rent is due')",
            [],
        )
        .unwrap();
        // Make the rebuild half fail, deterministically, the way a disk error
        // or a crash would.
        conn.execute_batch(
            "CREATE TRIGGER boom BEFORE INSERT ON chunks BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        )
        .unwrap();

        assert!(reindex_one_file(&conn, "f1", "the rent is due").is_err());

        let left: i64 = conn
            .query_row("SELECT count(*) FROM chunks WHERE file_id = 'f1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 1, "the file lost its search index with nothing to rebuild it");
    }
}
