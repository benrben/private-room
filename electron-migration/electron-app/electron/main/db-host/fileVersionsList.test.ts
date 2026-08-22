/**
 * Coverage for `fileVersionsList.ts` — originally just `list_file_versions`,
 * the one reader an earlier batch needed off `versions.rs`'s otherwise-
 * unported read/pin/delete surface; extended (as of the `commands/safety.rs`
 * batch) with `getVersion`/`setVersionPinned`/`deleteFileVersion`/
 * `versionProvenanceJson` — see this file's own module doc. REAL fixture
 * rooms via `createRoom`, matching this directory's convention (see
 * `versions.test.ts`'s own header).
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./open.js";
import { insertFile, trashFile, updateFileContent } from "./files.js";
import { snapshotFileVersion } from "./versions.js";
import {
  deleteFileVersion,
  getVersion,
  listFileVersions,
  setVersionPinned,
  versionProvenanceJson,
  VERSION_NOT_AVAILABLE,
} from "./fileVersionsList.js";

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
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-file-versions-list-"));
  const roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  open = createRoom(roomPath, "correct horse battery staple", "Test Room");
  return open;
}

function addFile(db: Database.Database, name: string, text: string): string {
  return insertFile(db, name, "text/plain", Buffer.from(text, "utf8"), text, "upload").id;
}

describe("listFileVersions", () => {
  it("a file with no snapshots yet has no versions", () => {
    const db = freshRoom();
    const id = addFile(db, "Plan.md", "v1");
    expect(listFileVersions(db, id)).toEqual([]);
  });

  it("newest first, and it records the pre-overwrite size and cause", () => {
    const db = freshRoom();
    const id = addFile(db, "Plan.md", "the first plan");
    snapshotFileVersion(db, id, "manual save");
    updateFileContent(db, id, Buffer.from("the second plan", "utf8"), "the second plan");
    snapshotFileVersion(db, id, "AI regenerated");

    const versions = listFileVersions(db, id);
    expect(versions.map((v) => v.cause)).toEqual(["AI regenerated", "manual save"]);
    expect(versions[0]?.bytes).toBe(Buffer.byteLength("the second plan"));
    expect(versions.every((v) => v.pinned === false)).toBe(true);
  });

  it("carries the provenance recorded on the snapshot, and omits it when absent", () => {
    const db = freshRoom();
    const id = addFile(db, "Brief.md", "draft one");
    // No provenance column set at all for this snapshot.
    snapshotFileVersion(db, id, "manual save");
    db.prepare("UPDATE files SET provenance = ? WHERE id = ?").run(
      JSON.stringify({ agent: "Documents agent", runId: "job-1" }),
      id
    );
    updateFileContent(db, id, Buffer.from("draft two", "utf8"), "draft two");
    snapshotFileVersion(db, id, "AI regenerated");

    const versions = listFileVersions(db, id);
    expect(versions[0]?.cause).toBe("AI regenerated");
    expect(versions[0]?.provenance).toEqual({ agent: "Documents agent", runId: "job-1" });
    expect(versions[1]?.provenance).toBeUndefined();
  });

  it("a trashed file's versions are gone, same as the file itself", () => {
    const db = freshRoom();
    const id = addFile(db, "Note.md", "one");
    snapshotFileVersion(db, id, "manual save");
    expect(listFileVersions(db, id)).toHaveLength(1);
    trashFile(db, id, { kind: "user" });
    expect(listFileVersions(db, id)).toEqual([]);
  });

  it("a corrupt provenance blob is read back as absent, never thrown", () => {
    const db = freshRoom();
    const id = addFile(db, "Note.md", "one");
    db.prepare("UPDATE files SET provenance = ? WHERE id = ?").run("not json", id);
    snapshotFileVersion(db, id, "manual save");
    const versions = listFileVersions(db, id);
    expect(versions[0]?.provenance).toBeUndefined();
  });
});

describe("setVersionPinned / deleteFileVersion / getVersion / versionProvenanceJson", () => {
  it("pinning survives the rolling prune, matching the History strip's 'Keep' toggle", () => {
    const db = freshRoom();
    const id = addFile(db, "Plan.md", "v1");
    snapshotFileVersion(db, id, "first");
    const oldest = listFileVersions(db, id)[0]!.id;
    setVersionPinned(db, oldest, true);

    for (let i = 0; i < 15; i++) {
      updateFileContent(db, id, Buffer.from(`v${i}`, "utf8"), `v${i}`);
      snapshotFileVersion(db, id, `save ${i}`);
    }

    const all = listFileVersions(db, id);
    expect(all.some((v) => v.id === oldest && v.pinned)).toBe(true);
    expect(all.filter((v) => !v.pinned).length).toBe(10); // VERSIONS_KEPT

    deleteFileVersion(db, oldest);
    expect(listFileVersions(db, id).some((v) => v.id === oldest)).toBe(false);
  });

  it("pinning/deleting an unknown id refuses with VERSION_NOT_AVAILABLE", () => {
    const db = freshRoom();
    expect(() => setVersionPinned(db, "no-such-version", true)).toThrow(VERSION_NOT_AVAILABLE);
    expect(() => deleteFileVersion(db, "no-such-version")).toThrow(VERSION_NOT_AVAILABLE);
  });

  it("getVersion returns the compound snapshot, and resolves even for a TRASHED file's version", () => {
    const db = freshRoom();
    const id = addFile(db, "Note.md", "one");
    snapshotFileVersion(db, id, "manual save");
    const vid = listFileVersions(db, id)[0]!.id;

    const v = getVersion(db, vid);
    expect(v.fileId).toBe(id);
    expect(v.text).toBe("one");
    expect(v.recMeta).toBeNull();

    // Unlike listFileVersions (joined against files.trashed_at IS NULL),
    // getVersion has no such join — a version id an open tab is still
    // holding must resolve after its file is trashed.
    trashFile(db, id, { kind: "user" });
    expect(getVersion(db, vid).fileId).toBe(id);
  });

  it("getVersion on an unknown id throws VERSION_NOT_AVAILABLE", () => {
    const db = freshRoom();
    expect(() => getVersion(db, "does-not-exist")).toThrow(VERSION_NOT_AVAILABLE);
  });

  it("versionProvenanceJson carries the version's OWN provenance, independent of the file's current one", () => {
    const db = freshRoom();
    const id = addFile(db, "Brief.md", "draft one");
    snapshotFileVersion(db, id, "manual save"); // no provenance on this version
    const vid = listFileVersions(db, id)[0]!.id;

    expect(versionProvenanceJson(db, vid)).toBeNull();

    db.prepare("UPDATE files SET provenance = ? WHERE id = ?").run(
      JSON.stringify({ agent: "Documents agent" }),
      id
    );
    updateFileContent(db, id, Buffer.from("draft two", "utf8"), "draft two");
    snapshotFileVersion(db, id, "AI regenerated");
    const vid2 = listFileVersions(db, id)[0]!.id;

    expect(versionProvenanceJson(db, vid2)).toBe(JSON.stringify({ agent: "Documents agent" }));
    // The FIRST version still carries none — restoring it must clear the head.
    expect(versionProvenanceJson(db, vid)).toBeNull();
  });

  it("versionProvenanceJson on an unknown id answers null, not a throw", () => {
    const db = freshRoom();
    expect(versionProvenanceJson(db, "does-not-exist")).toBeNull();
  });
});
