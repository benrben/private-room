import { createHash } from "node:crypto";
import fs, { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setRecMeta } from "../db-host/recordings.js";
import { registerFileRuntimeSurfaceIpc } from "../fileRuntimeSurfaceIpc.js";
import {
  createMediaStreams,
  mediaStreamingResponse,
  stageMediaStream,
} from "../mediaTools.js";
import { createWorkspaceRoom } from "./roomLayout.js";
import { WorkspaceContentStore } from "./contentStore.js";
import { WorkspaceService } from "./workspaceService.js";
import { createRoomManagerState } from "../roomManager.js";

const roots: string[] = [];
const password = "correct horse battery staple";
const MIB = 1024 * 1024;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "arcelle-performance-"));
  roots.push(parent);
  const root = path.join(parent, "Room");
  const created = createWorkspaceRoom(root, password, "Room");
  return { parent, root, created, db: created.db, workspace: new WorkspaceService(created.db, root) };
}

function chunkStream(chunks: number, chunkBytes: number, progress?: (written: number) => void): Readable {
  return Readable.from((async function* () {
    let written = 0;
    for (let index = 0; index < chunks; index += 1) {
      const chunk = Buffer.alloc(chunkBytes, index & 0xff);
      written += chunk.length;
      progress?.(written);
      yield chunk;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  })());
}

async function bodyBuffer(body: Buffer | ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(body).arrayBuffer());
}

describe("workspace media and performance acceptance", () => {
  it("streams large video, recording, and generated outputs with seekable media ranges", async () => {
    const { db, workspace } = await fixture();
    const progress: number[] = [];
    try {
      const video = await workspace.createFile(
        "Media/large-video.mp4",
        chunkStream(12, MIB, (written) => progress.push(written)),
        "upload",
      );
      const recording = await workspace.createFile(
        "Recordings/long-meeting.m4a",
        chunkStream(8, MIB),
        "recording",
      );
      setRecMeta(db, recording.fileId, JSON.stringify({ durationCs: 60_000, segments: [] }));
      const generated = await workspace.createFile(
        "Generated/large-artifact.bin",
        chunkStream(8, MIB),
        "generated",
      );

      expect(progress).toHaveLength(12);
      expect(progress.at(-1)).toBe(12 * MIB);
      expect(progress.every((value, index) => index === 0 || value > progress[index - 1]!)).toBe(true);

      for (const media of [video, recording]) {
        const streams = createMediaStreams();
        const requested: Array<[number, number]> = [];
        const token = stageMediaStream(
          streams,
          media.sizeBytes,
          media === video ? "video/mp4" : "audio/mp4",
          async () => workspace.readStream(media.fileId),
          async (start, end) => {
            requested.push([start, end]);
            return workspace.readStream(media.fileId, { start, end });
          },
        );
        const start = media.sizeBytes - 1024;
        const end = media.sizeBytes - 1;
        const response = await mediaStreamingResponse(streams, `/${token}`, `bytes=${start}-${end}`);
        expect(response.status).toBe(206);
        expect(requested).toEqual([[start, end]]);
        expect(await bodyBuffer(response.body)).toEqual(Buffer.alloc(1024, (media.sizeBytes / MIB - 1) & 0xff));
        expect(streams.map.get(token)?.bytes).toHaveLength(0);
      }

      const digest = createHash("sha256");
      let total = 0;
      let largestChunk = 0;
      for await (const raw of workspace.readStream(generated.fileId)) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
        total += chunk.length;
        largestChunk = Math.max(largestChunk, chunk.length);
        digest.update(chunk);
      }
      expect(total).toBe(8 * MIB);
      expect(largestChunk).toBeLessThan(total);
      expect(digest.digest("hex")).toBe(generated.sha256);
      expect(db.prepare(
        "SELECT count(*) AS n FROM files WHERE storage_kind = 'workspace' AND original_bytes IS NOT NULL",
      ).get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it("leaves a normal media file and its metadata untouched after an unavailable-file read", async () => {
    const { root, db, workspace } = await fixture();
    try {
      const file = await workspace.createFile(
        "Media/offline-video.mp4",
        chunkStream(2, MIB),
        "upload",
      );
      const filePath = path.join(root, "Media/offline-video.mp4");
      const placeholderPath = path.join(root, "Media/offline-video.placeholder");
      const before = db.prepare(
        "SELECT content_sha256, size_bytes, index_state FROM files WHERE id = ?",
      ).get(file.fileId);
      const streams = createMediaStreams();
      const token = stageMediaStream(
        streams,
        file.sizeBytes,
        "video/mp4",
        async () => workspace.readStream(file.fileId),
        async (start, end) => workspace.readStream(file.fileId, { start, end }),
      );

      await rename(filePath, placeholderPath);
      try {
        const response = await mediaStreamingResponse(streams, `/${token}`, "bytes=0-1023");
        await expect(bodyBuffer(response.body)).rejects.toThrow();
        expect(db.prepare(
          "SELECT content_sha256, size_bytes, index_state FROM files WHERE id = ?",
        ).get(file.fileId)).toEqual(before);
      } finally {
        await rename(placeholderPath, filePath);
      }
      expect((await readFile(filePath)).subarray(0, 1024)).toEqual(Buffer.alloc(1024, 0));
      expect(db.prepare(
        "SELECT content_sha256, size_bytes, index_state FROM files WHERE id = ?",
      ).get(file.fileId)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("imports a large video without calling the full-buffer file reader", async () => {
    const { parent, root, created, db, workspace } = await fixture();
    const source = path.join(parent, "large-import.mp4");
    await pipeline(chunkStream(12, MIB), createWriteStream(source, { flags: "wx" }));
    const state = createRoomManagerState();
    state.room = {
      conn: db,
      path: root,
      name: "Room",
      password,
      descriptor: created.descriptor,
      workspace,
      contentStore: new WorkspaceContentStore(workspace),
    };
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipc = {
      handle(channel: string, handler: (...args: unknown[]) => unknown): void {
        handlers.set(channel, handler);
      },
    } as Pick<IpcMain, "handle">;
    registerFileRuntimeSurfaceIpc(
      ipc,
      state,
      { userDataDir: parent, spawnRoomServerIfEnabled: () => {} },
      parent,
      () => {},
      { openPath: async () => {} },
    );
    const fullRead = vi.spyOn(fs.promises, "readFile").mockRejectedValue(
      new Error("full-buffer reads are forbidden for workspace media"),
    );
    try {
      const report = await handlers.get("import_files")!(
        {} as IpcMainInvokeEvent,
        { paths: [source] },
      ) as { imported: Array<{ id: string }>; errors: string[] };
      expect(report.errors).toEqual([]);
      expect(report.imported).toHaveLength(1);
      expect(fullRead).not.toHaveBeenCalled();
      expect(db.prepare(
        "SELECT storage_kind, original_bytes, size_bytes FROM files WHERE id = ?",
      ).get(report.imported[0]!.id)).toEqual({
        storage_kind: "workspace",
        original_bytes: null,
        size_bytes: 12 * MIB,
      });
    } finally {
      fullRead.mockRestore();
      db.close();
    }
  });

  it("deduplicates repeated streamed run baselines", async () => {
    const { db, workspace } = await fixture();
    try {
      const file = await workspace.createFile(
        "Media/baseline.mov",
        chunkStream(8, MIB),
        "upload",
      );
      const first = await workspace.snapshot(file.fileId, "agent_run", "run-one", "baseline");
      const second = await workspace.snapshot(file.fileId, "agent_run", "run-two", "baseline");
      expect(second).toEqual(first);
      expect(db.prepare("SELECT count(*) AS n FROM content_objects").get()).toEqual({ n: 1 });
      expect(db.prepare(
        "SELECT count(*) AS n FROM content_object_refs WHERE owner_type = 'agent_run' AND role = 'baseline'",
      ).get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });
});
