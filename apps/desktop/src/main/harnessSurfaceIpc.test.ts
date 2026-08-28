import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRoomManagerState, type RoomManagerDeps } from "./roomManager.js";
import { createWorkspaceRoom } from "./workspace/roomLayout.js";
import { WorkspaceService } from "./workspace/workspaceService.js";
import { registerHarnessSurfaceIpc } from "./harnessSurfaceIpc.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("harness surface IPC", () => {
  it("lists encrypted provider-neutral run history through a registered IPC channel", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-harness-ipc-"));
    roots.push(root);
    const roomPath = path.join(root, "Room");
    const created = createWorkspaceRoom(roomPath, "correct horse battery staple", "Room");
    const state = createRoomManagerState();
    state.room = {
      conn: created.db,
      path: roomPath,
      name: "Room",
      password: "correct horse battery staple",
      descriptor: created.descriptor,
      workspace: new WorkspaceService(created.db, roomPath),
    };
    created.db.prepare(
      `INSERT INTO agent_runs(
         run_id, room_id, provider, harness, model, privacy_mode, status,
         write_enabled, baseline_completed, started_at, completed_at
       ) VALUES ('history-1', ?, 'openrouter', 'arcelle-deep', 'model-x',
         'cloud-redacted', 'completed', 0, 1,
         '2026-08-26T10:00:00Z', '2026-08-26T10:01:00Z')`,
    ).run(created.descriptor.roomId);

    const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>();
    const ipcMain = {
      handle(channel: string, handler: (_event: unknown, args: unknown) => unknown) {
        handlers.set(channel, handler);
      },
    };
    const deps = {
      userDataDir: root,
      spawnRoomServerIfEnabled: () => undefined,
    } as RoomManagerDeps;
    try {
      registerHarnessSurfaceIpc(
        ipcMain as never,
        state,
        deps,
        root,
        () => undefined,
      );
      expect(handlers.has("harness_list_runs")).toBe(true);
      const listRuns = handlers.get("harness_list_runs");
      expect(listRuns).toBeDefined();
      await expect(listRuns!({}, {})).resolves.toEqual([
        expect.objectContaining({
          runId: "history-1",
          provider: "openrouter",
          harness: "arcelle-deep",
          model: "model-x",
          privacyMode: "cloud-redacted",
          status: "completed",
          changes: [],
        }),
      ]);
    } finally {
      created.db.close();
    }
  });
});
