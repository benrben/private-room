/** Additive schema-column and staged-artifact migration helpers. */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";

export function migrateJobColumns(db: Database.Database): void {
  addTableColumnIfMissing(db, "jobs", "parent_job_id", "ALTER TABLE jobs ADD COLUMN parent_job_id TEXT");
  addTableColumnIfMissing(db, "jobs", "parked_reason", "ALTER TABLE jobs ADD COLUMN parked_reason TEXT");
}

export function migrateWorkflowColumns(db: Database.Database): void {
  addTableColumnIfMissing(
    db,
    "workflows",
    "binding",
    `ALTER TABLE workflows ADD COLUMN binding TEXT NOT NULL DEFAULT '{"scope":"general"}'`,
  );
  addTableColumnIfMissing(db, "workflows", "pinned", "ALTER TABLE workflows ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  addTableColumnIfMissing(db, "workflow_runs", "input_file_id", "ALTER TABLE workflow_runs ADD COLUMN input_file_id TEXT");
}

export function migrateMessageChats(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "chat_id")) {
    db.exec("ALTER TABLE messages ADD COLUMN chat_id TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id)");
  }
  const orphans = (db.prepare("SELECT count(*) as c FROM messages WHERE chat_id IS NULL").get() as { c: number }).c;
  if (orphans > 0) adoptOrphanMessages(db);
}

export function adoptOrphanMessages(db: Database.Database): void {
  const legacyId = randomUUID();
  db.prepare("INSERT INTO chats(id, title) VALUES (?, 'Earlier conversation')").run(legacyId);
  db.prepare("UPDATE messages SET chat_id = ? WHERE chat_id IS NULL").run(legacyId);
}

export function addColumnsIfMissing(db: Database.Database, statements: readonly string[]): void {
  for (const statement of statements) {
    addColumnIfMissing(db, statement);
  }
}

export function addTableColumnIfMissing(db: Database.Database, table: string, column: string, statement: string): void {
  if (tableExists(db, table) && !columnExists(db, table, column)) {
    db.exec(statement);
  }
}

export function addFileColumnIfMissing(db: Database.Database, column: string, statement: string): void {
  addTableColumnIfMissing(db, "files", column, statement);
}

export function migrateWorkspaceFileColumns(db: Database.Database): void {
  if (!tableExists(db, "files")) return;
  addColumnsIfMissing(db, [
    "ALTER TABLE files ADD COLUMN storage_kind TEXT NOT NULL DEFAULT 'blob'",
    "ALTER TABLE files ADD COLUMN relative_path TEXT",
    "ALTER TABLE files ADD COLUMN path_key TEXT",
    "ALTER TABLE files ADD COLUMN content_sha256 TEXT",
    "ALTER TABLE files ADD COLUMN mtime_ns INTEGER",
    "ALTER TABLE files ADD COLUMN fs_identity TEXT",
    "ALTER TABLE files ADD COLUMN index_state TEXT NOT NULL DEFAULT 'ready'",
    "ALTER TABLE files ADD COLUMN index_error TEXT",
    "ALTER TABLE files ADD COLUMN last_seen_at TEXT",
  ]);
  db.exec("CREATE INDEX IF NOT EXISTS idx_files_content_sha256 ON files(content_sha256)");
}

export function migrateAgentRunColumns(db: Database.Database): void {
  if (!columnExists(db, "agent_runs", "write_enabled")) {
    db.exec("ALTER TABLE agent_runs ADD COLUMN write_enabled INTEGER NOT NULL DEFAULT 0");
    db.exec(
      `UPDATE agent_runs SET write_enabled = 1
       WHERE EXISTS (SELECT 1 FROM agent_run_files f WHERE f.run_id = agent_runs.run_id)`,
    );
  }
  if (!columnExists(db, "agent_run_files", "rollback_state")) {
    db.exec("ALTER TABLE agent_run_files ADD COLUMN rollback_state TEXT");
  }
}

export function migrateDerivedFiles(db: Database.Database): void {
  if (!tableExists(db, "files") || columnExists(db, "files", "derived_from")) return;
  db.exec("ALTER TABLE files ADD COLUMN derived_from TEXT");
  recoverDerivedFiles(db);
}

export function recoverDerivedFiles(db: Database.Database): void {
  if (!tableExists(db, "jobs") || !tableExists(db, "job_artifacts")) return;
  const recovered = `(SELECT json_extract(j.plan, '$.fileId')
        FROM jobs j JOIN job_artifacts a ON a.job_id = j.id
        WHERE j.kind = 'file_pass'
          AND json_valid(j.plan) AND json_valid(a.content)
          AND json_extract(a.content, '$.file_id') = files.id
        LIMIT 1)`;
  db.exec(
    `UPDATE files SET derived_from = ${recovered}
     WHERE derived_from IS NULL AND ${recovered} IS NOT NULL`,
  );
}

export function addTableColumnsIfPresent(
  db: Database.Database,
  table: string,
  columns: ReadonlyArray<readonly [string, string]>,
): void {
  if (!tableExists(db, table)) return;
  for (const [column, statement] of columns) {
    if (!columnExists(db, table, column)) db.exec(statement);
  }
}

export function migrateFileTrashColumns(db: Database.Database): void {
  addTableColumnsIfPresent(db, "files", [
    ["trashed_at", "ALTER TABLE files ADD COLUMN trashed_at TEXT"],
    ["trashed_by", "ALTER TABLE files ADD COLUMN trashed_by TEXT"],
    ["trashed_by_id", "ALTER TABLE files ADD COLUMN trashed_by_id TEXT"],
  ]);
  if (tableExists(db, "files")) {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_files_workspace_path
         ON files(path_key)
         WHERE storage_kind = 'workspace' AND trashed_at IS NULL AND path_key IS NOT NULL`,
    );
  }
}

export function migrateFileVisibilityColumns(db: Database.Database): void {
  addTableColumnsIfPresent(db, "files", [
    ["origin_destination", "ALTER TABLE files ADD COLUMN origin_destination TEXT NOT NULL DEFAULT 'library'"],
    ["library_visibility", "ALTER TABLE files ADD COLUMN library_visibility TEXT NOT NULL DEFAULT 'linked'"],
  ]);
}

export function addMemoryColumnIfMissing(db: Database.Database, column: string, statement: string): void {
  addTableColumnIfMissing(db, "memories", column, statement);
}

export function migrateMemoryTrashColumns(db: Database.Database): void {
  addTableColumnsIfPresent(db, "memories", [
    ["trashed_at", "ALTER TABLE memories ADD COLUMN trashed_at TEXT"],
    ["trashed_by", "ALTER TABLE memories ADD COLUMN trashed_by TEXT"],
    ["trashed_by_id", "ALTER TABLE memories ADD COLUMN trashed_by_id TEXT"],
  ]);
}

export function addMessageColumnIfMissing(db: Database.Database, column: string, statement: string): void {
  addTableColumnIfMissing(db, "messages", column, statement);
}


/** True when `table` has a column named `column`. */
export function columnExists(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

/** True when a table (or virtual table/view) named `name` exists. */
export function tableExists(db: Database.Database, name: string): boolean {
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
export function addColumnIfMissing(db: Database.Database, stmt: string): void {
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
export function inTransaction<T>(db: Database.Database, body: () => T): T {
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

export function sweepStagedArtifacts(db: Database.Database): number {
  return db.prepare("DELETE FROM staged_artifacts").run().changes;
}
