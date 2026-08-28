import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createRoom } from "./db-host/open.js";
import { insertFile, setFileExtractedText } from "./db-host/files.js";
import { listJobs } from "./db-host/jobs.js";
import { createRoomManagerState } from "./roomManager.js";
import { createLiveRuntimeTool } from "./liveRuntimeTools.js";
import { createToolEffects } from "./execTool.js";
import { SttModelState, sttModelPath } from "./sttTools.js";
import type { Browser } from "./browser/browser.js";
import type { AgentUiRuntime } from "./agentUiSurfaceIpc.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("live retranscribe_file", () => {
  it("waits for terminal transcript storage and returns a durable completion receipt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-live-stt-"));
    roots.push(root);
    const roomPath = path.join(root, "room.roomai");
    const userDataDir = path.join(root, "user-data");
    const modelPath = sttModelPath(userDataDir);
    await mkdir(path.dirname(modelPath), { recursive: true });
    await writeFile(modelPath, "installed model marker");

    const db = createRoom(roomPath, "correct horse battery staple", "STT test");
    const state = createRoomManagerState();
    state.room = { conn: db, path: roomPath, name: "STT test", password: "correct horse battery staple" };
    const media = insertFile(db, "interview.flac", "audio/flac", Buffer.from("audio"), null, "import");
    try {
      const runtime = createLiveRuntimeTool({
        state,
        roomDeps: { userDataDir, spawnRoomServerIfEnabled: () => undefined },
        userDataDir,
        resourcesPath: null,
        emit: () => undefined,
        browser: {} as Browser,
        agentUi: {} as AgentUiRuntime,
        sttModelState: new SttModelState(),
        retranscribe: async (_state, _data, _resources, _emit, fileId) => {
          expect(fileId).toBe(media.id);
          setFileExtractedText(db, fileId, "Hello from the finished transcript.");
        },
      });

      const result = await runtime("retranscribe_file", { name: "interview.flac" }, createToolEffects());
      expect(result).toMatchObject({ ok: true });
      expect(result?.ok && result.text).toContain("TRANSCRIPTION_RECEIPT");
      expect(result?.ok && result.text).toContain('"status":"completed"');
      expect(result?.ok && result.text).toContain("Hello from the finished transcript.");
      expect(listJobs(db)).toEqual([
        expect.objectContaining({ kind: "retranscribe", status: "done", cursor: 1, total: 1 }),
      ]);
      expect(listJobs(db)[0]?.state).toMatchObject({
        fileId: media.id,
        status: "completed",
        characters: 35,
      });
    } finally {
      state.room = null;
      db.close();
    }
  });
});
