/** FTS chunk schema and one-time chunk repair migrations. */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { inTransaction, tableExists } from "./migrateSchemaHelpers.js";

const CHUNK_TARGET_CHARS = 1200;
const CHUNK_CAP = 20_000;

export function migrateChunksFts(db: Database.Database): void {
  if (!tableExists(db, "chunks")) return;
  const ftsExisted = migrateChunksFtsTable(db);
  if (!ftsExisted) db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')");
  migrateChunkRepairs(db);
}

function migrateChunksFtsTable(db: Database.Database): boolean {
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE name='chunks_fts'").get() as { sql: string } | undefined;
  const stale = existing !== undefined && !existing.sql.includes("porter");
  if (stale) db.exec("DROP TABLE chunks_fts");
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
  return ftsExisted;
}

function migrateChunkRepairs(db: Database.Database): void {
  const userVersion = db.pragma("user_version", { simple: true }) as number;
  if (userVersion < 1) {
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

const HEBREW_MARK_PUNCTUATION = new Set([0x05be, 0x05c0, 0x05c3, 0x05c6]);

function isHebrewMarkCode(code: number): boolean {
  return code >= 0x0591 && code <= 0x05c7;
}

/** Hebrew combining marks: cantillation (0591-05AF) + points (05B0-05C7),
 * excluding the punctuation characters inside that block. */
function isHebMark(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return isHebrewMarkCode(code) && !HEBREW_MARK_PUNCTUATION.has(code);
}

/** Drop nikud + cantillation so the FTS tokenizer sees consonantal Hebrew. */
function stripHebrewMarks(text: string): string {
  const chars = Array.from(text);
  if (!chars.some(isHebMark)) return text;
  return chars.filter((ch) => !isHebMark(ch)).join("");
}

function normalizedChunkText(text: string): string {
  return text.includes("\r\n") ? text.replace(/\r\n/g, "\n") : text;
}

function flushChunk(out: string[], current: string): string {
  if (current === "") return current;
  out.push(current);
  return "";
}

function appendParagraph(current: string, paragraph: string): string {
  return current === "" ? paragraph : `${current}\n\n${paragraph}`;
}

function flushBeforeParagraph(chunks: string[], current: string, paragraph: string, targetChars: number): string {
  if (current !== "" && current.length + paragraph.length > targetChars) {
    return flushChunk(chunks, current);
  }
  return current;
}

function addChunkParagraph(chunks: string[], current: string, paragraph: string, targetChars: number): string {
  const ready = flushBeforeParagraph(chunks, current, paragraph, targetChars);
  if (paragraph.length > targetChars * 2) {
    chunks.push(...splitByLen(paragraph, targetChars));
    return ready;
  }
  return appendParagraph(ready, paragraph);
}

/** Split text into ~targetChars chunks along paragraph boundaries. */
function chunkText(text: string, targetChars: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const rawParagraph of normalizedChunkText(text).split("\n\n")) {
    const paragraph = rawParagraph.trim();
    if (paragraph !== "") current = addChunkParagraph(chunks, current, paragraph, targetChars);
  }
  flushChunk(chunks, current);
  return chunks;
}

function appendBoundedLine(out: string[], current: string, line: string, target: number): string {
  const ready = current !== "" && current.length + line.length + 1 > target ? flushChunk(out, current) : current;
  return ready === "" ? line : `${ready}\n${line}`;
}

function addSplitLine(out: string[], current: string, line: string, target: number): string {
  if (line.length > target) {
    const ready = flushChunk(out, current);
    out.push(...splitWords(line, target));
    return ready;
  }
  return appendBoundedLine(out, current, line, target);
}

/** Cut a paragraph bigger than a chunk on its own — lines first, then words. */
function splitByLen(text: string, target: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line !== "") current = addSplitLine(out, current, line, target);
  }
  flushChunk(out, current);
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
