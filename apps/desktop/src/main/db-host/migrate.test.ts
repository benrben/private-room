import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3-multiple-ciphers";
import { describe, expect, it, vi } from "vitest";
import { migrate, CURRENT_USER_VERSION } from "./migrate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The live base schema (a straight copy of the Rust `SCHEMA` const), same as
 * what `db/versions.rs`'s test-only `open_in_memory_schema()` applies in the
 * Rust suite. `src/main/db-host/open.ts` (createRoom / openRoom) does
 * not exist yet in this repo — this is the fixture it will eventually apply,
 * loaded directly since there is no createRoom() to call yet.
 */
const SCHEMA_SQL = readFileSync(path.join(__dirname, "schema.sql"), "utf8");

function openWithFullSchema(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  return db;
}

/** Every table/index/trigger's name+sql, so two schemas can be compared. */
function schemaFingerprint(db: Database.Database): Array<{ type: string; name: string; sql: string | null }> {
  return db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','index','trigger') ORDER BY type, name",
    )
    .all() as Array<{ type: string; name: string; sql: string | null }>;
}

describe("migrate", () => {
  it("running migrate twice in a row is idempotent", () => {
    const db = openWithFullSchema();
    expect(() => migrate(db)).not.toThrow();
    const after1 = schemaFingerprint(db);
    expect(() => migrate(db)).not.toThrow();
    const after2 = schemaFingerprint(db);
    expect(after2).toEqual(after1);
    expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_USER_VERSION);
  });

  it("brings a minimal ancient room (meta/chunks/messages only) to user_version 3 without throwing", () => {
    // As literal a stand-in for "a room written years ago" as the migrate()
    // source allows: only `meta` and `chunks` are truly load-bearing for the
    // scenario the task describes, but `messages` must also be present.
    // schema.rs's own `messages.chat_id` ALTER (lines 837-856) is NOT guarded
    // by a `table_exists(messages)` check the way every later ALTER in the
    // same function is — it predates that convention — so a room that somehow
    // has no `messages` table at all throws "no such table: messages" there,
    // in the Rust original just as much as in this port. That path is never
    // hit by any real room because `messages` has shipped in SCHEMA since the
    // very first schema revision, so every genuinely ancient room has one;
    // this fixture keeps that one realistic assumption rather than
    // constructing a room shape that has never actually existed.
    const db = new Database(":memory:");
    db.exec(
      `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
       CREATE TABLE chunks (
         id TEXT PRIMARY KEY,
         file_id TEXT NOT NULL,
         seq INTEGER NOT NULL,
         text TEXT NOT NULL,
         embedding BLOB
       );
       CREATE TABLE messages (
         id TEXT PRIMARY KEY,
         role TEXT NOT NULL,
         content TEXT NOT NULL,
         created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
       );`,
    );
    expect(db.pragma("user_version", { simple: true })).toBe(0);

    expect(() => migrate(db)).not.toThrow();

    expect(db.pragma("user_version", { simple: true })).toBe(3);
    // Guarded tables that only ever existed in SCHEMA/migrate() must now exist.
    for (const table of ["jobs", "workflows", "privacy_entities", "skills", "story_lists", "chunks_fts"]) {
      const row = db
        .prepare("SELECT count(*) as c FROM sqlite_master WHERE name = ?")
        .get(table) as { c: number };
      expect(row.c, `${table} must exist after migrate`).toBe(1);
    }
    // A second open stays green.
    expect(() => migrate(db)).not.toThrow();
  });

  it("migrates a fresh room (schema.sql, born at CURRENT_USER_VERSION) without error or repair side-effects", () => {
    // Stand-in for createRoom(): apply schema.sql, then stamp it exactly the
    // way create_room does — "born current" (schema.rs:614) — since
    // db-host/open.ts does not exist yet in this repo.
    const db = openWithFullSchema();
    db.pragma(`user_version = ${CURRENT_USER_VERSION}`);
    db.prepare(
      "INSERT INTO meta(key, value) VALUES ('format','roomai'), ('format_version','1'), ('name', ?)",
    ).run("Test Room");

    db.prepare(
      `INSERT INTO files(id, name, mime_type, source, original_bytes, extracted_text)
       VALUES ('f1', 'notes.md', 'text/markdown', 'upload', x'00', 'hello')`,
    ).run();
    db.prepare(
      `INSERT INTO chunks(id, file_id, seq, text, embedding)
       VALUES ('c1', 'f1', 0, 'hello', x'0102030405060708')`,
    ).run();

    expect(() => migrate(db)).not.toThrow();

    // A new room is stamped CURRENT_USER_VERSION precisely so the very next
    // unlock does not run repair #1 (null every embedding) against it.
    const embedded = (
      db.prepare("SELECT count(*) as c FROM chunks WHERE embedding IS NOT NULL").get() as { c: number }
    ).c;
    expect(embedded, "reopening a brand-new room erased its embeddings").toBe(1);
    expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_USER_VERSION);
  });

  it("adopts pre-chat messages into one legacy conversation when adding messages.chat_id", () => {
    const db = openWithFullSchema();
    db.exec(
      `DROP TABLE messages;
       CREATE TABLE messages (
         id TEXT PRIMARY KEY,
         role TEXT NOT NULL,
         content TEXT NOT NULL,
         created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
       );
       INSERT INTO messages(id, role, content) VALUES ('m1', 'user', 'before chats'), ('m2', 'assistant', 'still here');`,
    );

    migrate(db);

    const chats = db.prepare("SELECT title FROM chats WHERE title = 'Earlier conversation'").all() as Array<{ title: string }>;
    const linked = db.prepare("SELECT DISTINCT chat_id FROM messages").all() as Array<{ chat_id: string | null }>;
    expect(chats).toHaveLength(1);
    expect(linked).toHaveLength(1);
    expect(linked[0]?.chat_id).not.toBeNull();
  });

  it("rebuilds a stale chunks FTS table with porter stemming before installing current triggers", () => {
    const db = openWithFullSchema();
    db.exec(
      `DROP TRIGGER IF EXISTS chunks_fts_ai;
       DROP TRIGGER IF EXISTS chunks_fts_ad;
       DROP TRIGGER IF EXISTS chunks_fts_au;
       DROP TABLE chunks_fts;
       CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='rowid');`,
    );

    migrate(db);

    const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chunks_fts'").get() as { sql: string };
    expect(row.sql).toContain("porter unicode61");
    expect(db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'trigger' AND name = 'chunks_fts_ai'").get())
      .toEqual({ c: 1 });
  });

  it("marks legacy agent runs with baseline rows writable while adding their missing columns", () => {
    const db = openWithFullSchema();
    db.exec(
      `DROP TABLE agent_run_files;
       DROP TABLE agent_runs;
       CREATE TABLE agent_runs (run_id TEXT PRIMARY KEY);
       CREATE TABLE agent_run_files (
         run_id TEXT NOT NULL,
         file_id TEXT NOT NULL,
         baseline_object_id TEXT,
         PRIMARY KEY (run_id, file_id)
       );
       INSERT INTO agent_runs(run_id) VALUES ('run-1'), ('run-2');
       INSERT INTO agent_run_files(run_id, file_id) VALUES ('run-1', 'file-1');`,
    );

    migrate(db);

    const runs = db.prepare("SELECT run_id, write_enabled FROM agent_runs ORDER BY run_id").all() as Array<{
      run_id: string;
      write_enabled: number;
    }>;
    expect(runs).toEqual([
      { run_id: "run-1", write_enabled: 1 },
      { run_id: "run-2", write_enabled: 0 },
    ]);
    expect(columnExists(db, "agent_run_files", "rollback_state")).toBe(true);
  });

  it("splits a large CRLF Hebrew extraction without losing its ordered text", () => {
    const db = openWithFullSchema();
    const text = `opening line\r\n${"דִּבְרֵי ".repeat(650)}\r\nclosing line`;
    db.prepare(
      `INSERT INTO files(id, name, mime_type, size_bytes, source, original_bytes, extracted_text)
       VALUES ('f1', 'large-hebrew.txt', 'text/plain', 1, 'upload', x'00', ?)`,
    ).run(text);
    db.prepare("INSERT INTO chunks(id, file_id, seq, text) VALUES ('c1', 'f1', 0, ?)").run("דִּבְרֵי");

    migrate(db);

    const rows = db.prepare("SELECT text FROM chunks WHERE file_id = 'f1' ORDER BY seq").all() as Array<{ text: string }>;
    expect(rows.length).toBeGreaterThan(2);
    const rebuilt = rows.map((row) => row.text).join(" ");
    expect(rebuilt).toContain("opening line");
    expect(rebuilt).toContain("closing line");
    expect(rebuilt).not.toContain("ִ");
  });

  it("moves reindexed chunks to trashed_chunks when the source was trashed before repair", () => {
    const db = openWithFullSchema();
    db.prepare(
      `INSERT INTO files(id, name, mime_type, size_bytes, source, original_bytes, extracted_text, trashed_at)
       VALUES ('f1', 'old-hebrew.txt', 'text/plain', 1, 'upload', x'00', 'דִּבְרֵי', '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare("INSERT INTO chunks(id, file_id, seq, text) VALUES ('c1', 'f1', 0, 'דִּבְרֵי')").run();
    db.pragma("user_version = 1");

    migrate(db);

    const live = db.prepare("SELECT count(*) AS c FROM chunks WHERE file_id = 'f1'").get() as { c: number };
    const trashed = db.prepare("SELECT text FROM trashed_chunks WHERE file_id = 'f1'").all() as Array<{ text: string }>;
    expect(live.c).toBe(0);
    expect(trashed.map((row) => row.text)).toEqual(["דברי"]);
  });

  it("uses a caller transaction for reindexing instead of opening a nested transaction", () => {
    const db = openWithFullSchema();
    db.prepare(
      `INSERT INTO files(id, name, mime_type, size_bytes, source, original_bytes, extracted_text)
       VALUES ('f1', 'inside-transaction.txt', 'text/plain', 1, 'upload', x'00', 'דִּבְרֵי')`,
    ).run();
    db.prepare("INSERT INTO chunks(id, file_id, seq, text) VALUES ('c1', 'f1', 0, 'דִּבְרֵי')").run();

    db.transaction(() => migrate(db))();

    const row = db.prepare("SELECT text FROM chunks WHERE file_id = 'f1'").get() as { text: string };
    expect(row.text).toBe("דברי");
  });

  it("preserves a schema failure instead of treating every ADD COLUMN error as idempotence", () => {
    const db = openWithFullSchema();
    const exec = db.exec.bind(db);
    const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "ALTER TABLE file_versions ADD COLUMN text TEXT") throw new Error("disk full");
      return exec(sql);
    });

    expect(() => migrate(db)).toThrow("disk full");
    spy.mockRestore();
  });

  it("preserves the reindex failure when both best-effort rollback paths also fail", () => {
    const db = openWithFullSchema();
    db.prepare(
      `INSERT INTO files(id, name, mime_type, size_bytes, source, original_bytes, extracted_text)
       VALUES ('f1', 'bible.pdf', 'application/pdf', 1, 'upload', x'00', 'קֹהֶלֶת')`,
    ).run();
    db.prepare("INSERT INTO chunks(id, file_id, seq, text) VALUES ('c1', 'f1', 0, 'קֹהֶלֶת')").run();
    db.exec("CREATE TRIGGER boom BEFORE INSERT ON chunks BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    const exec = db.exec.bind(db);
    const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "ROLLBACK" || sql.startsWith("ROLLBACK TO")) throw new Error("rollback failed");
      return exec(sql);
    });

    expect(() => migrate(db)).toThrow("boom");
    spy.mockRestore();
  });

  it("fts5 is available (HLT-3 precondition)", () => {
    const db = new Database(":memory:");
    expect(() => db.exec("CREATE VIRTUAL TABLE t USING fts5(x);")).not.toThrow();
  });

  it("an older story_lists table gains its shape columns without losing data", () => {
    const db = openWithFullSchema();
    // Put the table back the way it shipped, without the three new columns.
    db.exec(
      `DROP TABLE story_lists;
       CREATE TABLE story_lists (
         id TEXT PRIMARY KEY,
         title TEXT NOT NULL,
         logline TEXT NOT NULL DEFAULT '',
         created_at TEXT NOT NULL DEFAULT '',
         updated_at TEXT NOT NULL DEFAULT ''
       );
       INSERT INTO story_lists (id, title) VALUES ('l1', 'Episode 1');`,
    );
    expect(columnExists(db, "story_lists", "aspect_ratio")).toBe(false);

    migrate(db);

    for (const column of ["aspect_ratio", "still_resolution", "clip_resolution"]) {
      expect(columnExists(db, "story_lists", column), `${column} must be added`).toBe(true);
    }
    const shape = db.prepare("SELECT aspect_ratio FROM story_lists WHERE id = 'l1'").get() as {
      aspect_ratio: string;
    };
    expect(shape.aspect_ratio).toBe("");
  });

  it("an older room's files all stay in the library (origin_destination/library_visibility defaults)", () => {
    const db = openWithFullSchema();
    db.exec(
      `DROP TABLE files;
       CREATE TABLE files (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         mime_type TEXT,
         size_bytes INTEGER NOT NULL DEFAULT 0,
         source TEXT NOT NULL DEFAULT 'upload',
         original_bytes BLOB,
         extracted_text TEXT,
         trashed_at TEXT,
         created_at TEXT NOT NULL DEFAULT ''
       );
       INSERT INTO files (id, name) VALUES ('f1', 'lease.pdf');
       INSERT INTO files (id, name) VALUES ('f2', 'Portfolio map.sketch');
       INSERT INTO files (id, name) VALUES ('f3', 'render.png');`,
    );
    expect(columnExists(db, "files", "library_visibility")).toBe(false);

    migrate(db);

    for (const id of ["f1", "f2", "f3"]) {
      const row = db
        .prepare(
          "SELECT origin_destination, library_visibility FROM files WHERE id = ? AND trashed_at IS NULL",
        )
        .get(id) as { origin_destination: string; library_visibility: string };
      expect(row.origin_destination, `${id} was re-filed by the migration`).toBe("library");
      expect(row.library_visibility, `${id} vanished from Home's Library`).toBe("linked");
    }
  });

  it("memories gains a category column and existing rows read as uncategorized", () => {
    const db = openWithFullSchema();
    db.exec(
      `DROP TABLE memories;
       CREATE TABLE memories (
         id TEXT PRIMARY KEY,
         content TEXT NOT NULL,
         created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
       );
       INSERT INTO memories(id, content) VALUES ('m1', 'the dog is named Rex');`,
    );
    expect(columnExists(db, "memories", "category")).toBe(false);

    migrate(db);

    expect(columnExists(db, "memories", "category")).toBe(true);
    const row = db.prepare("SELECT content, category FROM memories WHERE id = 'm1'").get() as {
      content: string;
      category: string | null;
    };
    expect(row.content).toBe("the dog is named Rex");
    expect(row.category).toBeNull();
    // Idempotent on a second open.
    expect(() => migrate(db)).not.toThrow();
  });

  it("S9 trash columns reach a memories table written before them, and old rows start untrashed", () => {
    const db = openWithFullSchema();
    db.exec(
      `DROP TABLE memories;
       CREATE TABLE memories (
         id TEXT PRIMARY KEY,
         content TEXT NOT NULL,
         category TEXT,
         created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
       );
       INSERT INTO memories(id, content) VALUES ('m1', 'call every Friday');`,
    );
    expect(columnExists(db, "memories", "trashed_at")).toBe(false);

    migrate(db);

    for (const col of ["trashed_at", "trashed_by", "trashed_by_id"]) {
      expect(columnExists(db, "memories", col), `missing ${col}`).toBe(true);
    }
    const row = db
      .prepare("SELECT content, trashed_at FROM memories WHERE id = 'm1' AND trashed_at IS NULL")
      .get() as { content: string; trashed_at: string | null } | undefined;
    expect(row?.content, "the legacy memory must not start out trashed").toBe("call every Friday");
    expect(() => migrate(db)).not.toThrow();
  });

  it("artifact staging and provenance columns reach a room written before them", () => {
    // ART-1: a room written before staged_artifacts/provenance existed gains
    // the table and both provenance columns on open, and its EXISTING file
    // version reads back with no provenance rather than an invented one.
    // Only the migrate()-scoped assertions from the Rust test are ported here
    // (not the stage_artifact/commit_staged funnel round-trip, which exercises
    // db/artifacts.rs — a module this port does not yet include, per the
    // header comment).
    const db = openWithFullSchema();
    db.exec(
      `DROP TABLE staged_artifacts;
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
         VALUES ('v1', 'f1', x'6f6c646572', 'You saved');`,
    );
    expect(columnExists(db, "files", "provenance")).toBe(false);
    expect(tableExists(db, "staged_artifacts")).toBe(false);

    migrate(db);

    expect(columnExists(db, "files", "provenance")).toBe(true);
    expect(columnExists(db, "files", "artifact_key")).toBe(true);
    expect(columnExists(db, "file_versions", "provenance")).toBe(true);
    expect(tableExists(db, "staged_artifacts")).toBe(true);
    // The pre-existing version is still there, and claims no author.
    const version = db.prepare("SELECT cause, provenance FROM file_versions WHERE id = 'v1'").get() as {
      cause: string;
      provenance: string | null;
    };
    expect(version.cause).toBe("You saved");
    expect(version.provenance, "an old version credits nobody").toBeNull();
    // Idempotent on a second open.
    expect(() => migrate(db)).not.toThrow();
  });

  it("CURRENT_USER_VERSION covers every one-time repair migrate() runs (born-current invariant)", () => {
    // CURRENT_USER_VERSION is what stops a brand-new room running the
    // one-time repairs (repair #1 nulls every embedding in the room). Its
    // correctness is a promise about a number in the migration implementation —
    // "raise this in lockstep with the last `userVersion < N` block" — and a
    // promise in a doc comment is not a guard. Read the source and check, the
    // way schema.rs's own `the_born_current_stamp_covers_every_one_time_repair`
    // does via `include_str!`.
    const src = ["migrate.ts", "migrateChunkIndex.ts"]
      .map((name) => readFileSync(path.join(__dirname, name), "utf8"))
      .join("\n");
    const matches = [...src.matchAll(/userVersion < (\d+)/g)].map((m) => Number(m[1]));
    expect(matches.length, "migrate() has no one-time repairs at all — did they move?").toBeGreaterThan(0);
    const highest = Math.max(...matches);
    expect(
      CURRENT_USER_VERSION,
      `a migration was added without raising CURRENT_USER_VERSION: a room created today is stamped ` +
        `${CURRENT_USER_VERSION}, so migrate() will run repair ${highest} against it — and repair 1 erases ` +
        `every embedding the room built in its first session`,
    ).toBe(highest);
  });

  it("rebuilds chunks indexed before nikud-stripping so plain Hebrew queries match (user_version 2 repair)", () => {
    const db = openWithFullSchema();
    const pointed = "דִּבְרֵי קֹהֶלֶת בֶּן־דָּוִד";
    db.prepare(
      `INSERT INTO files(id, name, mime_type, size_bytes, source, original_bytes, extracted_text)
       VALUES ('f1', 'bible.pdf', 'application/pdf', 1, 'upload', x'00', ?)`,
    ).run(pointed);
    // Simulate the OLD indexing: pointed chunk text straight in, no embedding
    // (also exercises the user_version < 1 embedding-nulling repair as a no-op).
    db.prepare("INSERT INTO chunks(id, file_id, seq, text) VALUES ('c1', 'f1', 0, ?)").run(pointed);

    const hitsBefore = db
      .prepare(
        `SELECT chunks.file_id FROM chunks_fts
         JOIN chunks ON chunks.rowid = chunks_fts.rowid
         WHERE chunks_fts MATCH ?`,
      )
      .all('"קהלת"');
    expect(hitsBefore, "pointed index must not match (the bug)").toHaveLength(0);

    migrate(db);

    const hitsAfter = db
      .prepare(
        `SELECT files.name FROM chunks_fts
         JOIN chunks ON chunks.rowid = chunks_fts.rowid
         JOIN files ON files.id = chunks.file_id
         WHERE chunks_fts MATCH ?`,
      )
      .all('"קהלת"') as Array<{ name: string }>;
    expect(hitsAfter, "consonantal rebuild must match").toHaveLength(1);
    expect(hitsAfter[0]?.name).toBe("bible.pdf");
  });

  it("re-chunks a file that hit the old 2000-chunk cap under the raised one (user_version 3 repair)", () => {
    const db = openWithFullSchema();
    const text = "alpha bravo charlie delta echo foxtrot golf hotel.\n\n".repeat(50);
    db.prepare(
      `INSERT INTO files(id, name, mime_type, size_bytes, source, original_bytes, extracted_text)
       VALUES ('f1', 'huge.txt', 'text/plain', 1, 'upload', x'00', ?)`,
    ).run(text);
    // Simulate a room capped at the OLD 2000-chunk limit: 2000 tiny chunks
    // for one file is exactly the trigger condition `rebuildCappedChunks`
    // looks for, whatever their content.
    const insert = db.prepare("INSERT INTO chunks(id, file_id, seq, text) VALUES (?, 'f1', ?, 'x')");
    const insertMany = db.transaction((n: number) => {
      for (let i = 0; i < n; i++) insert.run(`old-${i}`, i);
    });
    insertMany(2000);

    migrate(db);

    const rows = db.prepare("SELECT text FROM chunks WHERE file_id = 'f1' ORDER BY seq").all() as Array<{
      text: string;
    }>;
    // The capped placeholder rows are gone, replaced by a real re-chunk of
    // `extracted_text` — far fewer than 2000 rows for ~2.6KB of text.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(2000);
    expect(rows.every((r) => r.text !== "x")).toBe(true);
    const rejoined = rows.map((r) => r.text).join(" ");
    expect(rejoined).toContain("alpha bravo charlie delta echo foxtrot golf hotel.");
  });

  it("recovers derived_from for files a finished file_pass job produced, tolerating a non-JSON artifact row", () => {
    const db = openWithFullSchema();
    db.exec(
      `DROP TABLE files;
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
       INSERT INTO jobs(id, kind, plan) VALUES ('j1', 'file_pass', '{"fileId":"src","fileName":"lease.pdf"}');
       INSERT INTO job_artifacts(job_id, step_id, content) VALUES ('j1', 9, '{"file_id":"out"}');
       INSERT INTO job_artifacts(job_id, step_id, content) VALUES ('j1', 10, 'not json at all');`,
    );
    expect(columnExists(db, "files", "derived_from")).toBe(false);

    migrate(db);

    expect(columnExists(db, "files", "derived_from")).toBe(true);
    const out = db.prepare("SELECT derived_from FROM files WHERE id = 'out'").get() as {
      derived_from: string | null;
    };
    expect(out.derived_from).toBe("src");
    const plain = db.prepare("SELECT derived_from FROM files WHERE id = 'plain'").get() as {
      derived_from: string | null;
    };
    expect(plain.derived_from, "a file no pass produced keeps no invented provenance").toBeNull();

    // Idempotent on a second open.
    expect(() => migrate(db)).not.toThrow();
  });

  it("dedupeParkedJobs does not collide two different (kind,title) pairs that concatenate to the same string", () => {
    // workIdentity's fields must be joined with a separator, not plain
    // concatenation: kind="ab"/title="cd" and kind="a"/title="bcd" concatenate
    // to the identical string "abcd" for the same plan, so a join without a
    // delimiter would make dedupeParkedJobs treat two UNRELATED parked jobs as
    // duplicate attempts at the same unit of work and silently delete one.
    const db = openWithFullSchema();
    db.prepare(
      `INSERT INTO jobs(id, kind, title, plan, status, created_at)
       VALUES ('j1', 'ab', 'cd', '{}', 'paused', '2020-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO jobs(id, kind, title, plan, status, created_at)
       VALUES ('j2', 'a', 'bcd', '{}', 'paused', '2020-01-02T00:00:00Z')`,
    ).run();

    migrate(db);

    const remaining = (db.prepare("SELECT id FROM jobs WHERE id IN ('j1','j2')").all() as Array<{ id: string }>)
      .map((r) => r.id)
      .sort();
    expect(remaining, "two distinct jobs must not collapse into one identity").toEqual(["j1", "j2"]);
  });

  it("a reindex repair that fails halfway keeps the room's old search index", () => {
    // Same property as schema.rs's `a_reindex_that_fails_halfway_keeps_the_old_index`,
    // exercised through the public migrate() entry point (reindexOneFile is
    // module-private) via the user_version-2 Hebrew rebuild it drives.
    const db = openWithFullSchema();
    const pointed = "קֹהֶלֶת";
    db.prepare(
      `INSERT INTO files(id, name, mime_type, size_bytes, source, original_bytes, extracted_text)
       VALUES ('f1', 'bible.pdf', 'application/pdf', 1, 'upload', x'00', ?)`,
    ).run(pointed);
    db.prepare("INSERT INTO chunks(id, file_id, seq, text) VALUES ('c1', 'f1', 0, ?)").run(pointed);
    // Force the rebuild's re-insert to fail, deterministically, the way a
    // disk error or a crash would.
    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON chunks BEGIN SELECT RAISE(ABORT, 'boom'); END;`);

    expect(() => migrate(db)).toThrow();

    const left = (
      db.prepare("SELECT count(*) as c FROM chunks WHERE file_id = 'f1'").get() as { c: number }
    ).c;
    expect(left, "the file lost its search index with nothing to rebuild it").toBe(1);
  });
});

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT count(*) as c FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
    .get(name) as { c: number };
  return row.c > 0;
}
