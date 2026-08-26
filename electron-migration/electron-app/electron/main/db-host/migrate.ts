/**
 * Bring rooms created by older app versions up to the current schema.
 *
 * Ported from src-tauri/src/db/schema.rs (`migrate`, lines 711-1436, plus the
 * four helpers below it at 1437-1535). Runs on EVERY room open, not just old
 * ones — every step here is a "guarded" CREATE TABLE IF NOT EXISTS / ALTER
 * TABLE ADD COLUMN IF NOT PRESENT check, so a brand-new room and a years-old
 * one both pass through safely. Tables also declared in schema.sql are
 * repeated here on purpose: `createRoom` runs schema.sql exactly once, so a
 * table or column that exists ONLY here would be missing from every room
 * that already exists until this function adds it.
 *
 * Two supporting call chains are reached from `migrate` because it calls them
 * directly and unconditionally, even though they are declared in other Rust
 * modules (db/jobs.rs, db/artifacts.rs, extraction/{pdf,chunking}.rs):
 *   - `dedupeParkedJobs` (db/jobs.rs) is IMPORTED from `./jobs.js`, the one
 *     port of that module, exactly as Rust's `migrate` calls
 *     `crate::db::dedupe_parked_jobs`; `sweepStagedArtifacts`
 *     (db/artifacts.rs) is still a local one-line DELETE.
 *   - `stripHebrewMarks` / `chunkText` (extraction/{pdf,chunking}.rs), needed
 *     by `insertChunks` or the two content-rebuild repairs. These belong to
 *     the future `dbHostExtraction` port; the copies here are complete and
 *     tested for the properties `migrate()` depends on, but the byte-length
 *     size threshold in the Rust `chunk_text` (Rust `.len()` is UTF-8 BYTES)
 *     is ported as the string's UTF-16 `.length` here — a deliberate,
 *     documented deviation. Exact chunk-size-in-bytes parity is not part of
 *     `migrate`'s own contract (search-index population only cares that every
 *     chunk is non-empty, ordered, and covers the whole document), and JS has
 *     no built-in cheap byte-length-of-a-slice primitive that would justify
 *     the complexity for an incidental dependency.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { dedupeParkedJobs } from "./jobs.js";

/**
 * The schema revision a room created TODAY is already at, so `migrate` runs
 * none of its one-time repairs against it.
 *
 * A new room used to be stamped 0, which is what a room written years ago
 * looks like: the very next unlock ran every repair, and repair #1 nulls
 * every embedding in the room. Raise this in lockstep with the last
 * `userVersion < N` block below.
 */
export const CURRENT_USER_VERSION = 3;

/** Target chunk size (chars) for the room's keyword search index. */
const CHUNK_TARGET_CHARS = 1200;
/** HLT-4: hard cap on chunks indexed per file (see db.rs). */
const CHUNK_CAP = 20_000;

export function migrate(db: Database.Database): void {
  // ADD-30: durable background jobs. MUST also live in schema.sql — a table
  // that exists only here is missing from a brand-new room until it is
  // closed and reopened.
  db.exec(
    `CREATE TABLE IF NOT EXISTS chats (
       id TEXT PRIMARY KEY,
       title TEXT NOT NULL DEFAULT 'New chat',
       created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     );`,
  );

  db.exec(
    `CREATE TABLE IF NOT EXISTS jobs (
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
     );`,
  );

  // ADD-32: per-step artifacts for windowed file-pass jobs.
  db.exec(
    `CREATE TABLE IF NOT EXISTS job_artifacts (
       job_id TEXT NOT NULL,
       step_id INTEGER NOT NULL,
       content TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
       PRIMARY KEY (job_id, step_id)
     );`,
  );

  // Wave 4a: a workflow's inline file_pass child rides the parent's lane slot.
  if (tableExists(db, "jobs") && !columnExists(db, "jobs", "parent_job_id")) {
    db.exec("ALTER TABLE jobs ADD COLUMN parent_job_id TEXT");
  }
  // Why a job stopped when nobody pressed Stop (room locked / app closed).
  if (tableExists(db, "jobs") && !columnExists(db, "jobs", "parked_reason")) {
    db.exec("ALTER TABLE jobs ADD COLUMN parked_reason TEXT");
  }

  // Wave 4a (Idea 2): LLM graph workflows, their run history, and schedules.
  db.exec(
    `CREATE TABLE IF NOT EXISTS workflows (
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
     CREATE INDEX IF NOT EXISTS idx_schedules_wf ON schedules(workflow_id);`,
  );
  // Shortcuts extension: binding/pinned/input_file_id on rooms that predate them.
  if (tableExists(db, "workflows") && !columnExists(db, "workflows", "binding")) {
    db.exec(`ALTER TABLE workflows ADD COLUMN binding TEXT NOT NULL DEFAULT '{"scope":"general"}'`);
  }
  if (tableExists(db, "workflows") && !columnExists(db, "workflows", "pinned")) {
    db.exec("ALTER TABLE workflows ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  }
  if (tableExists(db, "workflow_runs") && !columnExists(db, "workflow_runs", "input_file_id")) {
    db.exec("ALTER TABLE workflow_runs ADD COLUMN input_file_id TEXT");
  }

  // `messages.chat_id`: NOT guarded by tableExists(messages), matching the
  // Rust source exactly — this predates the tableExists-guard convention the
  // later ALTERs in this function use. Every room that has ever shipped has
  // had a `messages` table since the very first schema, so in practice this
  // never throws; a room missing `messages` entirely would hit "no such
  // table: messages" here, same as the Rust original.
  const messageCols = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  const hasChatId = messageCols.some((c) => c.name === "chat_id");
  if (!hasChatId) {
    db.exec("ALTER TABLE messages ADD COLUMN chat_id TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id)");
  }

  // Adopt any pre-session messages into a legacy chat.
  const orphans = (db.prepare("SELECT count(*) as c FROM messages WHERE chat_id IS NULL").get() as {
    c: number;
  }).c;
  if (orphans > 0) {
    const legacyId = randomUUID();
    db.prepare("INSERT INTO chats(id, title) VALUES (?, 'Earlier conversation')").run(legacyId);
    db.prepare("UPDATE messages SET chat_id = ? WHERE chat_id IS NULL").run(legacyId);
  }

  // ADD-2: file version history.
  db.exec(
    `CREATE TABLE IF NOT EXISTS file_versions (
       id TEXT PRIMARY KEY,
       file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
       bytes BLOB NOT NULL,
       saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
       cause TEXT NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_file_versions_file ON file_versions(file_id);`,
  );
  // Compound snapshots + ART-1 columns: older rooms lack them.
  for (const stmt of [
    "ALTER TABLE file_versions ADD COLUMN text TEXT",
    "ALTER TABLE file_versions ADD COLUMN rec_meta TEXT",
    "ALTER TABLE file_versions ADD COLUMN provenance TEXT",
    "ALTER TABLE file_versions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE files ADD COLUMN provenance TEXT",
    "ALTER TABLE files ADD COLUMN artifact_key TEXT",
  ]) {
    addColumnIfMissing(db, stmt);
  }

  // ART-1: the artifact staging area.
  db.exec(
    `CREATE TABLE IF NOT EXISTS staged_artifacts (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       mime TEXT NOT NULL,
       bytes BLOB NOT NULL,
       text TEXT,
       provenance TEXT,
       staged_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     );`,
  );

  // RM-2: web_pages cache keyed by URL — collapse dupes before enforcing uniqueness.
  db.exec(
    `CREATE TABLE IF NOT EXISTS web_pages (
       id TEXT PRIMARY KEY,
       url TEXT NOT NULL,
       title TEXT,
       raw_html BLOB,
       readable_text TEXT,
       saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     );
     DELETE FROM web_pages
       WHERE rowid NOT IN (SELECT MAX(rowid) FROM web_pages GROUP BY url);
     CREATE UNIQUE INDEX IF NOT EXISTS idx_web_pages_url ON web_pages(url);`,
  );

  // CHG-33: short-lived web_search results cache.
  db.exec(
    `CREATE TABLE IF NOT EXISTS web_searches (
       query_key TEXT PRIMARY KEY,
       results_text TEXT NOT NULL,
       saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     );`,
  );

  // BROWSE-3b: preview-image cache for search results.
  db.exec(
    `CREATE TABLE IF NOT EXISTS web_images (
       url TEXT PRIMARY KEY,
       mime TEXT NOT NULL,
       bytes BLOB NOT NULL,
       saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     );`,
  );

  // ADD-27: live-recording metadata + crash-recovery checkpoints.
  db.exec(
    `CREATE TABLE IF NOT EXISTS recordings (
       file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
       meta TEXT NOT NULL
     );
     CREATE TABLE IF NOT EXISTS rec_chunks (
       file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
       seq INTEGER NOT NULL,
       pcm BLOB NOT NULL,
       PRIMARY KEY (file_id, seq)
     );`,
  );

  // Podcast scripts as data.
  db.exec(
    `CREATE TABLE IF NOT EXISTS podcasts (
       file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
       title TEXT NOT NULL,
       turns TEXT NOT NULL,
       cast_json TEXT NOT NULL,
       audio_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
       created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     );`,
  );

  // ADD-16: folders table + nullable files.folder_id.
  db.exec(
    `CREATE TABLE IF NOT EXISTS folders (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL UNIQUE
     );`,
  );
  if (tableExists(db, "files") && !columnExists(db, "files", "folder_id")) {
    db.exec("ALTER TABLE files ADD COLUMN folder_id TEXT");
  }

  // ADD-17: cached per-file one-liner for "Summarize room".
  if (tableExists(db, "files") && !columnExists(db, "files", "ai_summary")) {
    db.exec("ALTER TABLE files ADD COLUMN ai_summary TEXT");
  }

  // BROWSE-2 (D19): download provenance.
  if (tableExists(db, "files") && !columnExists(db, "files", "origin_url")) {
    db.exec("ALTER TABLE files ADD COLUMN origin_url TEXT");
  }

  // Workspace rooms: legacy rows stay blob-backed. These columns describe a
  // normal file relative to the room root and its indexing state. Keeping the
  // migration additive is important: old room files remain directly usable.
  if (tableExists(db, "files")) {
    for (const stmt of [
      "ALTER TABLE files ADD COLUMN storage_kind TEXT NOT NULL DEFAULT 'blob'",
      "ALTER TABLE files ADD COLUMN relative_path TEXT",
      "ALTER TABLE files ADD COLUMN path_key TEXT",
      "ALTER TABLE files ADD COLUMN content_sha256 TEXT",
      "ALTER TABLE files ADD COLUMN mtime_ns INTEGER",
      "ALTER TABLE files ADD COLUMN fs_identity TEXT",
      "ALTER TABLE files ADD COLUMN index_state TEXT NOT NULL DEFAULT 'ready'",
      "ALTER TABLE files ADD COLUMN index_error TEXT",
      "ALTER TABLE files ADD COLUMN last_seen_at TEXT",
    ]) {
      addColumnIfMissing(db, stmt);
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_files_content_sha256 ON files(content_sha256)");
  }

  // Private workspace object storage, crash journal and normalized harness
  // run history. Declared here as well as schema.sql so every old room gains
  // the compatibility tables on its next open.
  db.exec(
    `CREATE TABLE IF NOT EXISTS content_objects (
       id TEXT PRIMARY KEY,
       sha256 TEXT NOT NULL,
       size_bytes INTEGER NOT NULL,
       encryption_version INTEGER NOT NULL DEFAULT 1,
       nonce BLOB NOT NULL,
       relative_object_path TEXT NOT NULL UNIQUE,
       created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
       UNIQUE(sha256, size_bytes)
     );
     CREATE TABLE IF NOT EXISTS content_object_refs (
       owner_type TEXT NOT NULL,
       owner_id TEXT NOT NULL,
       object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE CASCADE,
       role TEXT NOT NULL,
       PRIMARY KEY (owner_type, owner_id, object_id, role)
     );
     CREATE INDEX IF NOT EXISTS idx_content_object_refs_object
       ON content_object_refs(object_id);
     CREATE TABLE IF NOT EXISTS fs_operations (
       operation_id TEXT PRIMARY KEY,
       operation_type TEXT NOT NULL,
       phase TEXT NOT NULL,
       file_id TEXT,
       old_path TEXT,
       new_path TEXT,
       old_hash TEXT,
       new_hash TEXT,
       agent_run_id TEXT,
       error TEXT,
       created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
       updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     );
     CREATE INDEX IF NOT EXISTS idx_fs_operations_phase ON fs_operations(phase);
     CREATE TABLE IF NOT EXISTS agent_runs (
       run_id TEXT PRIMARY KEY,
       room_id TEXT NOT NULL,
       provider TEXT NOT NULL,
       harness TEXT NOT NULL,
       model TEXT NOT NULL,
       privacy_mode TEXT NOT NULL,
       status TEXT NOT NULL,
       write_enabled INTEGER NOT NULL DEFAULT 0,
       baseline_completed INTEGER NOT NULL DEFAULT 0,
       rollback_status TEXT NOT NULL DEFAULT 'none',
       started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
       completed_at TEXT
     );
     CREATE TABLE IF NOT EXISTS agent_run_files (
       run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
       file_id TEXT NOT NULL,
       baseline_path TEXT,
       baseline_hash TEXT,
       baseline_object_id TEXT REFERENCES content_objects(id) ON DELETE SET NULL,
       final_path TEXT,
       final_hash TEXT,
       change_type TEXT,
       rollback_state TEXT,
       PRIMARY KEY (run_id, file_id)
     );
     CREATE INDEX IF NOT EXISTS idx_agent_run_files_object
       ON agent_run_files(baseline_object_id);`,
  );
  if (!columnExists(db, "agent_runs", "write_enabled")) {
    db.exec("ALTER TABLE agent_runs ADD COLUMN write_enabled INTEGER NOT NULL DEFAULT 0");
    // Older write runs already have baseline rows. This preserves their
    // rollback affordance; an old empty-room run cannot be distinguished and
    // stays read-only-safe rather than being guessed writable.
    db.exec(
      `UPDATE agent_runs SET write_enabled = 1
       WHERE EXISTS (SELECT 1 FROM agent_run_files f WHERE f.run_id = agent_runs.run_id)`,
    );
  }
  if (!columnExists(db, "agent_run_files", "rollback_state")) {
    db.exec("ALTER TABLE agent_run_files ADD COLUMN rollback_state TEXT");
  }

  // Room map: file→file provenance, plus one-off recovery from finished
  // file_pass jobs (their plan names the source, their publish artifact names
  // the output). Best-effort: json_valid guards both blobs so an unparseable
  // job_artifacts.content row cannot abort the whole migration.
  if (tableExists(db, "files") && !columnExists(db, "files", "derived_from")) {
    db.exec("ALTER TABLE files ADD COLUMN derived_from TEXT");
    const RECOVERED = `(SELECT json_extract(j.plan, '$.fileId')
          FROM jobs j JOIN job_artifacts a ON a.job_id = j.id
          WHERE j.kind = 'file_pass'
            AND json_valid(j.plan) AND json_valid(a.content)
            AND json_extract(a.content, '$.file_id') = files.id
          LIMIT 1)`;
    if (tableExists(db, "jobs") && tableExists(db, "job_artifacts")) {
      db.exec(
        `UPDATE files SET derived_from = ${RECOVERED}
         WHERE derived_from IS NULL AND ${RECOVERED} IS NOT NULL`,
      );
    }
  }

  // Video technical metadata (media_probe::MediaMeta as JSON).
  if (tableExists(db, "files") && !columnExists(db, "files", "media_meta")) {
    db.exec("ALTER TABLE files ADD COLUMN media_meta TEXT");
  }

  // What a saved web page declares about itself (extraction::PageMeta as JSON).
  if (tableExists(db, "files") && !columnExists(db, "files", "web_meta")) {
    db.exec("ALTER TABLE files ADD COLUMN web_meta TEXT");
  }

  // Trash / undo. Existing rows come out with trashed_at NULL — exactly right.
  if (tableExists(db, "files")) {
    for (const [column, decl] of [
      ["trashed_at", "ALTER TABLE files ADD COLUMN trashed_at TEXT"],
      ["trashed_by", "ALTER TABLE files ADD COLUMN trashed_by TEXT"],
      ["trashed_by_id", "ALTER TABLE files ADD COLUMN trashed_by_id TEXT"],
    ] as const) {
      if (!columnExists(db, "files", column)) {
        db.exec(decl);
      }
    }
    // This partial index is intentionally created only after trashed_at has
    // been added above. The oldest room schemas do not have that column yet.
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_files_workspace_path
         ON files(path_key)
         WHERE storage_kind = 'workspace' AND trashed_at IS NULL AND path_key IS NOT NULL`,
    );
  }
  // Section-only visibility. THE DEFAULTS ARE THE MIGRATION: every existing row
  // takes 'library' / 'linked', i.e. stays exactly where it already was.
  if (tableExists(db, "files")) {
    for (const [column, decl] of [
      ["origin_destination", "ALTER TABLE files ADD COLUMN origin_destination TEXT NOT NULL DEFAULT 'library'"],
      ["library_visibility", "ALTER TABLE files ADD COLUMN library_visibility TEXT NOT NULL DEFAULT 'linked'"],
    ] as const) {
      if (!columnExists(db, "files", column)) {
        db.exec(decl);
      }
    }
  }
  db.exec(
    `CREATE TABLE IF NOT EXISTS trashed_chunks (
       id TEXT PRIMARY KEY,
       file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
       seq INTEGER NOT NULL,
       text TEXT NOT NULL,
       embedding BLOB
     );
     CREATE INDEX IF NOT EXISTS idx_trashed_chunks_file ON trashed_chunks(file_id);`,
  );

  // Wave 1b (idea 5): memory categories. NULL = uncategorized.
  if (tableExists(db, "memories") && !columnExists(db, "memories", "category")) {
    db.exec("ALTER TABLE memories ADD COLUMN category TEXT");
  }
  // S9 (2026-08-04): memory soft-delete.
  if (tableExists(db, "memories")) {
    for (const [column, decl] of [
      ["trashed_at", "ALTER TABLE memories ADD COLUMN trashed_at TEXT"],
      ["trashed_by", "ALTER TABLE memories ADD COLUMN trashed_by TEXT"],
      ["trashed_by_id", "ALTER TABLE memories ADD COLUMN trashed_by_id TEXT"],
    ] as const) {
      if (!columnExists(db, "memories", column)) {
        db.exec(decl);
      }
    }
  }

  // ADD-23: structured viewer effects ride their own column.
  if (tableExists(db, "messages") && !columnExists(db, "messages", "effects")) {
    db.exec("ALTER TABLE messages ADD COLUMN effects TEXT");
  }
  // Token-budget bar / context handoff.
  if (tableExists(db, "messages") && !columnExists(db, "messages", "kind")) {
    db.exec("ALTER TABLE messages ADD COLUMN kind TEXT");
  }

  // HLT-3: FTS5 index over chunk text, backfilled only when just created.
  if (tableExists(db, "chunks")) {
    // CHG-14: a pre-existing chunks_fts built without porter stemming must be
    // dropped and rebuilt — FTS5 tokenizers cannot be altered in place.
    const existingFtsSql = db
      .prepare("SELECT sql FROM sqlite_master WHERE name='chunks_fts'")
      .get() as { sql: string } | undefined;
    const stale = existingFtsSql !== undefined && !existingFtsSql.sql.includes("porter");
    if (stale) {
      db.exec("DROP TABLE chunks_fts");
    }
    const ftsExisted = tableExists(db, "chunks_fts");
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
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
       END;`,
    );
    if (!ftsExisted) {
      // Populate the index from whatever chunks the old room already has.
      db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')");
    }

    // CHG-12/HLT-3/HLT-4: the three one-time repairs, gated on a `user_version`
    // captured ONCE — matching the Rust source exactly, each `if` below tests
    // the SAME captured value rather than a freshly re-read pragma, so a room
    // at version 0 runs all three in sequence and a room at version 2 runs
    // only the last.
    const userVersion = db.pragma("user_version", { simple: true }) as number;
    if (userVersion < 1) {
      // nomic-embed-text needs task-instruction prefixes; older rooms stored
      // vectors without them, so null them out for the background backfill.
      db.exec("UPDATE chunks SET embedding = NULL");
      db.pragma("user_version = 1");
    }
    if (userVersion < 2) {
      rebuildMarkedHebrewChunks(db);
      db.pragma("user_version = 2");
    }
    if (userVersion < 3) {
      rebuildCappedChunks(db);
      db.pragma("user_version = 3");
    }
  }

  // PRIV-1/PRIV-2: the privacy gatekeeper's entity map + scan bookkeeping.
  db.exec(
    `CREATE TABLE IF NOT EXISTS privacy_entities (
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
     );`,
  );

  // Agent Skills: portable SKILL.md folder format, inside the encrypted room.
  db.exec(
    `CREATE TABLE IF NOT EXISTS skills (
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
     CREATE INDEX IF NOT EXISTS idx_skill_resources_skill ON skill_resources(skill_id);`,
  );
  // Placed AFTER the CREATE above: a room written before the skills table
  // existed has nothing to ALTER until the CREATE has run.
  addColumnIfMissing(db, "ALTER TABLE skills ADD COLUMN agent TEXT NOT NULL DEFAULT ''");

  // BROWSE-1: the private browser's audit trail — only what the AGENT did.
  db.exec(
    `CREATE TABLE IF NOT EXISTS browse_journal (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       kind TEXT NOT NULL,
       url TEXT NOT NULL DEFAULT '',
       detail TEXT NOT NULL DEFAULT '',
       session TEXT NOT NULL DEFAULT '',
       created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     );`,
  );
  addColumnIfMissing(db, "ALTER TABLE browse_journal ADD COLUMN session TEXT NOT NULL DEFAULT ''");

  // The room's saved voices (db/voices.rs). Also in schema.sql — see the
  // `jobs` note at the top of this function for why.
  db.exec(
    `CREATE TABLE IF NOT EXISTS voice_ids (
       name TEXT PRIMARY KEY,
       emb BLOB NOT NULL,
       frames INTEGER NOT NULL DEFAULT 0,
       takes INTEGER NOT NULL DEFAULT 1,
       updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     );
     CREATE TABLE IF NOT EXISTS voice_rejects (
       name TEXT NOT NULL,
       emb BLOB NOT NULL,
       PRIMARY KEY (name, emb)
     );`,
  );

  // The Create page's cast and shot lists.
  db.exec(
    `CREATE TABLE IF NOT EXISTS story_cast (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       description TEXT NOT NULL DEFAULT '',
       story TEXT NOT NULL DEFAULT '',
       face_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
       ord INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
       updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     );
     CREATE TABLE IF NOT EXISTS story_lists (
       id TEXT PRIMARY KEY,
       title TEXT NOT NULL,
       logline TEXT NOT NULL DEFAULT '',
       aspect_ratio TEXT NOT NULL DEFAULT '',
       still_resolution TEXT NOT NULL DEFAULT '',
       clip_resolution TEXT NOT NULL DEFAULT '',
       created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
       updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     );
     CREATE TABLE IF NOT EXISTS story_shots (
       id TEXT PRIMARY KEY,
       list_id TEXT NOT NULL REFERENCES story_lists(id) ON DELETE CASCADE,
       ord INTEGER NOT NULL DEFAULT 0,
       action TEXT NOT NULL DEFAULT '',
       cast_ids TEXT NOT NULL DEFAULT '[]',
       seconds INTEGER,
       image_model TEXT NOT NULL DEFAULT '',
       video_model TEXT NOT NULL DEFAULT '',
       still_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
       clip_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
       created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
       updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     );
     CREATE INDEX IF NOT EXISTS idx_story_shots_list ON story_shots(list_id, ord);`,
  );
  // The frame shape and the two output sizes, added after the table shipped.
  for (const stmt of [
    "ALTER TABLE story_lists ADD COLUMN aspect_ratio TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE story_lists ADD COLUMN still_resolution TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE story_lists ADD COLUMN clip_resolution TEXT NOT NULL DEFAULT ''",
  ]) {
    addColumnIfMissing(db, stmt);
  }

  // Rooms opened before the jobs write path enforced one parked entry per
  // unit of work carry the pile-up it allowed — repaired here rather than
  // behind a user_version stamp: cheap, and a no-op on an already-clean room.
  dedupeParkedJobs(db);
  // ART-1: a staged artifact that outlived its session belongs to a
  // generation that never committed, so it is not in the library either way.
  sweepStagedArtifacts(db);
}

// ============================================================== helpers

/** True when `table` has a column named `column`. */
function columnExists(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

/** True when a table (or virtual table/view) named `name` exists. */
function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT count(*) as c FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
    .get(name) as { c: number };
  return row.c > 0;
}

/**
 * `ALTER TABLE … ADD COLUMN`, idempotent. better-sqlite3 (like SQLite itself)
 * has no `ADD COLUMN IF NOT EXISTS`, so the two "already fine" outcomes are
 * recognised by their error text and swallowed:
 *  - "duplicate column" — the room already has it (the ordinary re-open path);
 *  - "no such table" — the room predates the table entirely, so a later
 *    `CREATE TABLE IF NOT EXISTS` in this same `migrate` will mint it WITH
 *    the column.
 * Anything else is a real schema failure and still aborts the migration.
 */
function addColumnIfMissing(db: Database.Database, stmt: string): void {
  try {
    db.exec(stmt);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!(msg.includes("duplicate column") || msg.includes("no such table"))) {
      throw e;
    }
  }
}

/** Run `body` inside a transaction unless the caller already opened one. */
function inTransaction<T>(db: Database.Database, body: () => T): T {
  if (db.inTransaction) {
    return body();
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = body();
    db.exec("COMMIT");
    return value;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // best-effort, mirrors the Rust `let _ = conn.execute_batch("ROLLBACK")`
    }
    throw e;
  }
}

/** Hebrew combining marks: cantillation (0591-05AF) + points (05B0-05C7),
 * excluding the punctuation characters inside that block. */
function isHebMark(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  if (code < 0x0591 || code > 0x05c7) return false;
  return !(code === 0x05be || code === 0x05c0 || code === 0x05c3 || code === 0x05c6);
}

/** Drop nikud + cantillation so the FTS tokenizer sees consonantal Hebrew. */
function stripHebrewMarks(text: string): string {
  const chars = Array.from(text);
  if (!chars.some(isHebMark)) return text;
  return chars.filter((ch) => !isHebMark(ch)).join("");
}

/** Split text into ~targetChars chunks along paragraph boundaries. */
function chunkText(text: string, targetChars: number): string[] {
  const normalized = text.includes("\r\n") ? text.replace(/\r\n/g, "\n") : text;
  const chunks: string[] = [];
  let current = "";
  for (const rawPara of normalized.split("\n\n")) {
    const para = rawPara.trim();
    if (para === "") continue;
    if (current !== "" && current.length + para.length > targetChars) {
      chunks.push(current);
      current = "";
    }
    if (para.length > targetChars * 2) {
      for (const piece of splitByLen(para, targetChars)) {
        chunks.push(piece);
      }
    } else {
      if (current !== "") current += "\n\n";
      current += para;
    }
  }
  if (current.trim() !== "") chunks.push(current);
  return chunks;
}

/** Cut a paragraph bigger than a chunk on its own — lines first, then words. */
function splitByLen(s: string, target: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const rawLine of s.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.length > target) {
      if (current !== "") {
        out.push(current);
        current = "";
      }
      out.push(...splitWords(line, target));
      continue;
    }
    if (current !== "" && current.length + line.length + 1 > target) {
      out.push(current);
      current = "";
    }
    if (current !== "") current += "\n";
    current += line;
  }
  if (current !== "") out.push(current);
  return out;
}

function splitWords(s: string, target: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of s.split(/\s+/).filter((w) => w !== "")) {
    if (current !== "" && current.length + word.length + 1 > target) {
      out.push(current);
      current = "";
    }
    if (current !== "") current += " ";
    current += word;
  }
  if (current !== "") out.push(current);
  return out;
}

/**
 * Chunk `text` into the search index for `fileId`, exactly like db.rs's
 * `insert_chunks`: a trashed file's chunks go to `trashed_chunks` instead of
 * the live index, and Hebrew nikud/cantillation are stripped first.
 */
function insertChunks(db: Database.Database, fileId: string, text: string): void {
  const row = db.prepare("SELECT trashed_at IS NOT NULL as trashed FROM files WHERE id = ?").get(fileId) as
    | { trashed: number }
    | undefined;
  const trashed = row !== undefined && row.trashed === 1;
  const sql = trashed
    ? "INSERT INTO trashed_chunks(id, file_id, seq, text) VALUES (?, ?, ?, ?)"
    : "INSERT INTO chunks(id, file_id, seq, text) VALUES (?, ?, ?, ?)";
  const stripped = stripHebrewMarks(text);
  const sp = `chunk_${randomUUID().replace(/-/g, "")}`;
  db.exec(`SAVEPOINT "${sp}"`);
  try {
    const stmt = db.prepare(sql);
    const pieces = chunkText(stripped, CHUNK_TARGET_CHARS).slice(0, CHUNK_CAP);
    pieces.forEach((chunk, seq) => {
      stmt.run(randomUUID(), fileId, seq, chunk);
    });
    db.exec(`RELEASE "${sp}"`);
  } catch (e) {
    // Roll the partial index back so "indexed" never half-means it.
    try {
      db.exec(`ROLLBACK TO "${sp}"; RELEASE "${sp}"`);
    } catch {
      // best-effort
    }
    throw e;
  }
}

/**
 * Replace one file's chunks, all-or-nothing. Both one-time repairs below
 * re-index a file by erasing its chunks and rebuilding them from the stored
 * text — wrapped in a transaction so a failure partway through leaves the OLD
 * chunks in place rather than none at all.
 */
function reindexOneFile(db: Database.Database, fileId: string, text: string): void {
  inTransaction(db, () => {
    db.prepare("DELETE FROM chunks WHERE file_id = ?").run(fileId);
    insertChunks(db, fileId, text);
  });
}

/**
 * One-time (user_version 3): CHUNK_CAP used to be 2000, so a very long file's
 * tail was silently absent from the search index. Re-chunk every file that
 * hit the old cap under the raised one.
 */
function rebuildCappedChunks(db: Database.Database): void {
  const OLD_CAP = 2000;
  const capped = db
    .prepare("SELECT file_id FROM chunks GROUP BY file_id HAVING count(*) >= ?")
    .all(OLD_CAP) as Array<{ file_id: string }>;
  for (const { file_id } of capped) {
    const row = db.prepare("SELECT extracted_text FROM files WHERE id = ?").get(file_id) as
      | { extracted_text: string | null }
      | undefined;
    const text = row?.extracted_text;
    if (text === null || text === undefined) continue;
    reindexOneFile(db, file_id, text);
  }
}

/**
 * One-time (user_version 2): chunks indexed BEFORE nikud-stripping hold
 * pointed Hebrew the FTS tokenizer shredded into single-letter fragments.
 * Rebuild the chunks of every affected file from its stored extracted text.
 */
function rebuildMarkedHebrewChunks(db: Database.Database): void {
  const marks = ["ְ", "ַ", "ָ", "ִ", "ֶ", "ּ"];
  const clause = marks.map(() => "text LIKE ?").join(" OR ");
  const rows = db
    .prepare(`SELECT DISTINCT file_id FROM chunks WHERE ${clause}`)
    .all(...marks.map((m) => `%${m}%`)) as Array<{ file_id: string }>;
  for (const { file_id } of rows) {
    const row = db.prepare("SELECT extracted_text FROM files WHERE id = ?").get(file_id) as
      | { extracted_text: string | null }
      | undefined;
    const text = row?.extracted_text;
    if (text === null || text === undefined) continue;
    reindexOneFile(db, file_id, text);
  }
}

// ------------------------------------------------- duplicate Activity rows
// `dedupeParkedJobs` is IMPORTED from `./jobs.js`, not re-implemented here.
// Rust's `migrate` calls `crate::db::dedupe_parked_jobs` — the same function
// `db/jobs.rs` exposes to the runner — so the rule for "these two parked rows
// are the same unit of work" exists exactly once. This file carried a private
// copy while `db-host/jobs.ts` did not exist yet, and the two immediately
// disagreed once it did: the copy embedded the plan as `JSON.stringify` (which
// keeps INSERTION order), where `jobs.ts` canonicalizes the keys to match
// `serde_json::Value`'s BTreeMap `Display`. Two call sites building the same
// plan in a different field order therefore read as two units of work here and
// one there — a divergence a room open could show, and the kind of "one fact
// written down twice" that this whole port keeps paying for. One
// implementation, one answer.

/** Drop every staged artifact left over from a previous session. */
function sweepStagedArtifacts(db: Database.Database): number {
  return db.prepare("DELETE FROM staged_artifacts").run().changes;
}
