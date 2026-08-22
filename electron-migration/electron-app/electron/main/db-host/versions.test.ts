/**
 * Vitest coverage for the narrow slice of `src-tauri/src/db/versions.rs` ported
 * to `versions.ts` — `snapshotFileVersion` (+ `VERSIONS_KEPT`) and
 * `setFileProvenance`. See that module's header for exactly what is and is not
 * ported, and why.
 *
 * NOT a 1:1 port of the Rust `mod tests`: that suite is almost entirely about
 * the password/rekey and recovery-key buckets (already ported, with their own
 * tests, to `rekey.ts`/`recovery.ts`) plus the pin/delete READING surface this
 * batch leaves alone. The one Rust test that overlaps —
 * `pinned_versions_survive_the_rolling_prune_and_can_be_deleted` — needs
 * `set_version_pinned`/`delete_file_version`/`list_file_versions`; its
 * pruning half is reproduced below with raw SQL standing in for those readers,
 * the same convention `files.test.ts`'s own header documents.
 *
 * REAL FIXTURE ROOMS via `createRoom`, matching this directory's convention.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./open.js";
import { insertFile } from "./files.js";
import { setFileProvenance, snapshotFileVersion, VERSIONS_KEPT } from "./versions.js";

let tmpDir: string | null = null;
let open: Database.Database | null = null;

afterEach(() => {
  open?.close();
  open = null;
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-versions-"));
  const roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  open = createRoom(roomPath, "correct horse battery staple", "Test Room");
  return open;
}

function addFile(db: Database.Database, name: string, text: string): string {
  return insertFile(db, name, "text/plain", Buffer.from(text, "utf8"), text, "upload").id;
}

interface RawVersion {
  id: string;
  cause: string;
  bytes: Buffer;
  text: string | null;
  recMeta: string | null;
  provenance: string | null;
  pinned: number;
}

/** Raw stand-in for the not-yet-ported `list_file_versions`, newest first.
 * `saved_at` has one-second resolution, so a loop of snapshots ties on it and
 * `rowid DESC` is what actually orders them. */
function rawVersions(db: Database.Database, fileId: string): RawVersion[] {
  return db
    .prepare(
      `SELECT id, cause, bytes, text, rec_meta AS recMeta, provenance, pinned
       FROM file_versions WHERE file_id = ? ORDER BY saved_at DESC, rowid DESC`
    )
    .all(fileId) as RawVersion[];
}

describe("snapshotFileVersion", () => {
  it("snapshots the current bytes/text before an overwrite, unpinned", () => {
    const db = freshRoom();
    const id = addFile(db, "notes.md", "v1 body");

    snapshotFileVersion(db, id, "manual save");

    const versions = rawVersions(db, id);
    expect(versions).toHaveLength(1);
    const v = versions[0]!;
    expect(v.cause).toBe("manual save");
    expect(v.bytes.toString("utf8")).toBe("v1 body");
    expect(v.text).toBe("v1 body");
    expect(v.pinned).toBe(0);
  });

  it("is a no-op for a file with no stored bytes", () => {
    const db = freshRoom();
    // A file row with NULL original_bytes — e.g. a recording still being
    // captured. There is nothing yet to preserve.
    db.prepare(
      "INSERT INTO files(id, name, mime_type, original_bytes) VALUES (?, 'x.wav', 'audio/wav', NULL)"
    ).run("no-bytes");

    expect(() => snapshotFileVersion(db, "no-bytes", "should not snapshot")).not.toThrow();
    expect(rawVersions(db, "no-bytes")).toHaveLength(0);
  });

  it("is a no-op for a file id that does not exist", () => {
    const db = freshRoom();
    expect(() => snapshotFileVersion(db, "never-existed", "cause")).not.toThrow();
    expect(rawVersions(db, "never-existed")).toHaveLength(0);
  });

  it("carries the file's CURRENT provenance onto the snapshot", () => {
    const db = freshRoom();
    const id = addFile(db, "brief.md", "one");
    setFileProvenance(db, id, JSON.stringify({ runId: "run-1" }));

    snapshotFileVersion(db, id, "AI regenerated");

    expect(JSON.parse(rawVersions(db, id)[0]!.provenance as string)).toEqual({ runId: "run-1" });
  });

  it("carries recording meta when the file has a recordings row", () => {
    // The compound snapshot: for a Recording the bytes are the unchanged WAV
    // and what an overwrite replaces IS the transcript, so bytes alone could
    // never bring the old words, speakers or cuts back.
    const db = freshRoom();
    const id = addFile(db, "call.wav", "transcript v1");
    db.prepare("INSERT INTO recordings(file_id, meta) VALUES (?, ?)").run(
      id,
      JSON.stringify({ speakers: ["A"] })
    );

    snapshotFileVersion(db, id, "transcript edited");

    expect(JSON.parse(rawVersions(db, id)[0]!.recMeta as string)).toEqual({ speakers: ["A"] });
  });

  it("leaves rec_meta null for a file that is not a recording", () => {
    const db = freshRoom();
    const id = addFile(db, "notes.md", "body");
    snapshotFileVersion(db, id, "manual save");
    expect(rawVersions(db, id)[0]!.recMeta).toBeNull();
  });

  it("prunes to the newest VERSIONS_KEPT unpinned versions", () => {
    const db = freshRoom();
    const id = addFile(db, "log.md", "start");

    for (let i = 0; i < VERSIONS_KEPT + 5; i += 1) {
      snapshotFileVersion(db, id, `save ${i}`);
    }

    const versions = rawVersions(db, id);
    expect(versions).toHaveLength(VERSIONS_KEPT);
    // Newest-first, so the head is the very last save, and the earliest ones
    // are the ones that went.
    expect(versions[0]!.cause).toBe(`save ${VERSIONS_KEPT + 4}`);
    expect(versions.map((v) => v.cause)).not.toContain("save 0");
  });

  it("never evicts a pinned version, and it does not count against the window", () => {
    const db = freshRoom();
    const id = addFile(db, "log.md", "start");
    snapshotFileVersion(db, id, "first");
    const oldest = rawVersions(db, id)[0]!.id;
    // `set_version_pinned` is not ported in this batch — raw SQL stands in.
    db.prepare("UPDATE file_versions SET pinned = 1 WHERE id = ?").run(oldest);

    for (let i = 0; i < VERSIONS_KEPT + 5; i += 1) {
      snapshotFileVersion(db, id, `save ${i}`);
    }

    const versions = rawVersions(db, id);
    expect(versions.some((v) => v.id === oldest && v.pinned === 1)).toBe(true);
    expect(versions.filter((v) => v.pinned === 0)).toHaveLength(VERSIONS_KEPT);
  });
});

describe("setFileProvenance", () => {
  it("sets and clears a file's current provenance", () => {
    const db = freshRoom();
    const id = addFile(db, "deck.html", "body");

    setFileProvenance(db, id, JSON.stringify({ agent: "Documents agent" }));
    let row = db.prepare("SELECT provenance FROM files WHERE id = ?").get(id) as {
      provenance: string | null;
    };
    expect(JSON.parse(row.provenance as string)).toEqual({ agent: "Documents agent" });

    setFileProvenance(db, id, null);
    row = db.prepare("SELECT provenance FROM files WHERE id = ?").get(id) as {
      provenance: string | null;
    };
    expect(row.provenance).toBeNull();
  });

  it("is a silent no-op for a file id that matches nothing", () => {
    // Deliberately `executeOne`, not `executeExisting` (Rust does the same):
    // this is the tail of a write whose content already landed, so a stale id
    // must not turn a completed save into a reported failure.
    const db = freshRoom();
    expect(() => setFileProvenance(db, "never-existed", '{"runId":"r"}')).not.toThrow();
  });
});
