import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { Artifact } from "../artifactBuilder.js";
import { createRecBridgeCtx, recDeleteRangeHybrid, recExportCleanHybrid } from "../recBridge.js";
import {
  appendRecChunk,
  finalizeRecAudioHybrid,
  recoverRecChunksHybrid,
  setRecMeta,
} from "../db-host/recordings.js";
import { setFileExtractedText } from "../db-host/files.js";
import { decodeWav, defaultRecMeta, encodeWav } from "../recFormat.js";
import { storePodcastAudioOutput } from "../studiosPodcastAudio.js";
import { saveFileNodeHybrid } from "../workflowEngine.js";
import { createWorkspaceRoom } from "./roomLayout.js";
import { WorkspaceService } from "./workspaceService.js";

let temporary: string | null = null;

afterEach(async () => {
  if (temporary !== null) await rm(temporary, { recursive: true, force: true });
  temporary = null;
});

async function fixture() {
  temporary = await mkdtemp(path.join(os.tmpdir(), "arcelle-generated-cutover-"));
  const root = path.join(temporary, "Room");
  const { db } = createWorkspaceRoom(root, "correct horse battery staple", "Room");
  const workspace = new WorkspaceService(db, root);
  return {
    root,
    db,
    workspace,
    rooms: { current: () => ({ db, path: root, workspace }) },
  };
}

describe("generated output workspace cutover", () => {
  it("saves and versions workflow output as a normal file", async () => {
    const { root, db, rooms } = await fixture();
    const published = { value: null };
    try {
      const first = await saveFileNodeHybrid(
        rooms, root, "Daily notes", "md", "create", "first", null,
        published, "Workflow saved — Daily",
      );
      expect(await readFile(path.join(root, "Daily notes.md"), "utf8")).toBe("first");
      expect(db.prepare(
        "SELECT storage_kind, original_bytes, extracted_text FROM files WHERE id = ?",
      ).get(first.fileId)).toEqual({
        storage_kind: "workspace",
        original_bytes: null,
        extracted_text: "first",
      });

      await saveFileNodeHybrid(
        rooms, root, "Daily notes", "md", "create", "second",
        { result: "", skipped: false, branch: null, file_id: first.fileId, node_label: "", node_kind: "" },
        published, "Workflow saved — Daily",
      );
      expect(await readFile(path.join(root, "Daily notes.md"), "utf8")).toBe("second");
      expect((db.prepare("SELECT count(*) AS n FROM file_versions WHERE file_id = ?")
        .get(first.fileId) as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("commits Studio artifacts to normal files and keeps encrypted versions", async () => {
    const { root, db, workspace } = await fixture();
    try {
      const first = await Artifact.new("Study deck.html", "text/html", "<p>one</p>")
        .by("Flashcards")
        .commitToWorkspace(workspace);
      expect(first.versioned).toBe(false);
      expect(await readFile(path.join(root, "Study deck.html"), "utf8")).toBe("<p>one</p>");

      const second = await Artifact.new("Study deck.html", "text/html", "<p>two</p>")
        .by("Flashcards")
        .commitToWorkspace(workspace);
      expect(second).toMatchObject({ versioned: true, meta: { id: first.meta.id } });
      expect(await readFile(path.join(root, "Study deck.html"), "utf8")).toBe("<p>two</p>");
      expect((db.prepare(
        `SELECT count(*) AS n FROM content_object_refs
         WHERE owner_type = 'file_version' AND role = 'content'`,
      ).get() as { n: number }).n).toBe(1);
      expect((db.prepare("SELECT original_bytes FROM files WHERE id = ?")
        .get(first.meta.id) as { original_bytes: Buffer | null }).original_bytes).toBeNull();
    } finally {
      db.close();
    }
  });

  it("stores finished podcast audio as a normal file with DB-only transcript", async () => {
    const { root, db, workspace } = await fixture();
    try {
      const meta = await storePodcastAudioOutput(
        { db, path: root, workspace },
        "Episode.m4a",
        "audio/mp4",
        Buffer.from("audio"),
        "Host: hello",
      );
      expect(await readFile(path.join(root, "Episode.m4a"), "utf8")).toBe("audio");
      expect(db.prepare(
        "SELECT original_bytes, extracted_text, storage_kind FROM files WHERE id = ?",
      ).get(meta.id)).toEqual({
        original_bytes: null,
        extracted_text: "Host: hello",
        storage_kind: "workspace",
      });
    } finally {
      db.close();
    }
  });

  it("finalizes and recovers recording audio without live blob bytes", async () => {
    const { root, db, workspace } = await fixture();
    const base = new Float32Array([0.1, 0.2]);
    const created = await workspace.createFile(
      "Recordings/call.wav",
      Readable.from([encodeWav(base)]),
      "recording",
    );
    setFileExtractedText(db, created.fileId, "before");
    setRecMeta(db, created.fileId, "{}");
    try {
      await finalizeRecAudioHybrid(
        db,
        workspace,
        created.fileId,
        encodeWav(new Float32Array([0.3, 0.4, 0.5])),
        "after",
      );
      expect(decodeWav(await readFile(path.join(root, "Recordings/call.wav")))).toHaveLength(3);
      appendRecChunk(db, created.fileId, new Float32Array([0.6, 0.7]));
      expect(await recoverRecChunksHybrid(db, workspace)).toBe(1);
      expect(decodeWav(await readFile(path.join(root, "Recordings/call.wav")))).toHaveLength(5);
      setRecMeta(db, created.fileId, JSON.stringify({
        ...defaultRecMeta(),
        durationCs: 5,
        segments: [{
          id: "segment-1",
          source: "mic",
          speaker: "You",
          t0: 0,
          t1: 5,
          text: "hello",
          words: [{ w: "hello", t0: 0, t1: 5, del: false }],
          lang: null,
          voice: null,
        }],
      }));
      const ctx = createRecBridgeCtx({ currentRoom: () => ({ db, path: root, workspace }) });
      await recDeleteRangeHybrid(db, ctx, created.fileId, 0, 5);
      expect((db.prepare("SELECT original_bytes FROM files WHERE id = ?")
        .get(created.fileId) as { original_bytes: Buffer | null }).original_bytes).toBeNull();
      const edited = await recExportCleanHybrid(db, ctx, created.fileId);
      expect(await readFile(path.join(root, "Recordings/call (edited).wav"))).not.toHaveLength(0);
      expect((db.prepare("SELECT original_bytes FROM files WHERE id = ?")
        .get(edited.id) as { original_bytes: Buffer | null }).original_bytes).toBeNull();
      expect((db.prepare("SELECT original_bytes FROM files WHERE id = ?")
        .get(created.fileId) as { original_bytes: Buffer | null }).original_bytes).toBeNull();
      expect((db.prepare("SELECT count(*) AS n FROM rec_chunks WHERE file_id = ?")
        .get(created.fileId) as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });
});
