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

import type Database from "better-sqlite3-multiple-ciphers";
import { dedupeParkedJobs } from "./jobs.js";
import { migrateChunksFts } from "./migrateChunkIndex.js";
import {
  addColumnIfMissing,
  addColumnsIfMissing,
  addFileColumnIfMissing,
  addMemoryColumnIfMissing,
  addMessageColumnIfMissing,
  migrateAgentRunColumns,
  migrateDerivedFiles,
  migrateFileTrashColumns,
  migrateFileVisibilityColumns,
  migrateJobColumns,
  migrateMemoryTrashColumns,
  migrateMessageChats,
  migrateWorkflowColumns,
  migrateWorkspaceFileColumns,
  sweepStagedArtifacts,
} from "./migrateSchemaHelpers.js";

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

  migrateJobColumns(db);

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
  migrateWorkflowColumns(db);

  // `messages.chat_id`: NOT guarded by tableExists(messages), matching the
  // Rust source exactly — this predates the tableExists-guard convention the
  // later ALTERs in this function use. Every room that has ever shipped has
  // had a `messages` table since the very first schema, so in practice this
  // never throws; a room missing `messages` entirely would hit "no such
  // table: messages" here, same as the Rust original.
  migrateMessageChats(db);

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
  addColumnsIfMissing(db, [
    "ALTER TABLE file_versions ADD COLUMN text TEXT",
    "ALTER TABLE file_versions ADD COLUMN rec_meta TEXT",
    "ALTER TABLE file_versions ADD COLUMN provenance TEXT",
    "ALTER TABLE file_versions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE files ADD COLUMN provenance TEXT",
    "ALTER TABLE files ADD COLUMN artifact_key TEXT",
  ]);

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
  addFileColumnIfMissing(db, "folder_id", "ALTER TABLE files ADD COLUMN folder_id TEXT");

  // ADD-17: cached per-file one-liner for "Summarize room".
  addFileColumnIfMissing(db, "ai_summary", "ALTER TABLE files ADD COLUMN ai_summary TEXT");

  // BROWSE-2 (D19): download provenance.
  addFileColumnIfMissing(db, "origin_url", "ALTER TABLE files ADD COLUMN origin_url TEXT");

  // Workspace rooms: legacy rows stay blob-backed. These columns describe a
  // normal file relative to the room root and its indexing state. Keeping the
  // migration additive is important: old room files remain directly usable.
  migrateWorkspaceFileColumns(db);

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
  migrateAgentRunColumns(db);

  // Room map: file→file provenance, plus one-off recovery from finished
  // file_pass jobs (their plan names the source, their publish artifact names
  // the output). Best-effort: json_valid guards both blobs so an unparseable
  // job_artifacts.content row cannot abort the whole migration.
  migrateDerivedFiles(db);

  // Video technical metadata (media_probe::MediaMeta as JSON).
  addFileColumnIfMissing(db, "media_meta", "ALTER TABLE files ADD COLUMN media_meta TEXT");

  // What a saved web page declares about itself (extraction::PageMeta as JSON).
  addFileColumnIfMissing(db, "web_meta", "ALTER TABLE files ADD COLUMN web_meta TEXT");

  // Trash / undo. Existing rows come out with trashed_at NULL — exactly right.
  migrateFileTrashColumns(db);
  // Section-only visibility. THE DEFAULTS ARE THE MIGRATION: every existing row
  // takes 'library' / 'linked', i.e. stays exactly where it already was.
  migrateFileVisibilityColumns(db);
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
  addMemoryColumnIfMissing(db, "category", "ALTER TABLE memories ADD COLUMN category TEXT");
  // S9 (2026-08-04): memory soft-delete.
  migrateMemoryTrashColumns(db);

  // ADD-23: structured viewer effects ride their own column.
  addMessageColumnIfMissing(db, "effects", "ALTER TABLE messages ADD COLUMN effects TEXT");
  // Token-budget bar / context handoff.
  addMessageColumnIfMissing(db, "kind", "ALTER TABLE messages ADD COLUMN kind TEXT");

  // HLT-3: FTS5 index over chunk text, backfilled only when just created.
  migrateChunksFts(db);

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
  addColumnsIfMissing(db, [
    "ALTER TABLE story_lists ADD COLUMN aspect_ratio TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE story_lists ADD COLUMN still_resolution TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE story_lists ADD COLUMN clip_resolution TEXT NOT NULL DEFAULT ''",
  ]);

  // Rooms opened before the jobs write path enforced one parked entry per
  // unit of work carry the pile-up it allowed — repaired here rather than
  // behind a user_version stamp: cheap, and a no-op on an already-clean room.
  dedupeParkedJobs(db);
  // ART-1: a staged artifact that outlived its session belongs to a
  // generation that never committed, so it is not in the library either way.
  sweepStagedArtifacts(db);
}
