import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoomManagerState, type RoomManagerDeps } from "./roomManager.js";
import { createWorkspaceRoom } from "./workspace/roomLayout.js";
import { WorkspaceService } from "./workspace/workspaceService.js";
import { registerHarnessSurfaceIpc } from "./harnessSurfaceIpc.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("harness surface IPC", () => {
  it("validates start requests before the controller can contact a harness", async () => {
    const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>();
    const ipcMain = {
      handle(channel: string, handler: (_event: unknown, args: unknown) => unknown) {
        handlers.set(channel, handler);
      },
    };
    const state = createRoomManagerState();
    const deps = {
      userDataDir: "/tmp/harness-ipc-fake",
      spawnRoomServerIfEnabled: () => undefined,
    } as RoomManagerDeps;
    const controller = registerHarnessSurfaceIpc(
      ipcMain as never,
      state,
      deps,
      "/tmp/harness-ipc-fake",
      () => undefined,
    );
    const start = vi.spyOn(controller, "start").mockResolvedValue("run-123");
    const handler = handlers.get("harness_start");
    if (!handler) throw new Error("harness_start was not registered");
    const valid = {
      provider: "codex",
      model: "gpt-5",
      privacyMode: "cloud-redacted",
      writeEnabled: false,
      text: "Review this change",
      threadId: "thread-1",
      systemPrompt: "",
    };
    await expect(handler({}, valid)).resolves.toEqual({ runId: "run-123" });
    expect(start).toHaveBeenCalledWith(valid);

    for (const [args, error] of [
      [{ ...valid, provider: "unknown" }, "provider must be codex"],
      [{ ...valid, privacyMode: "everywhere" }, "privacyMode is invalid"],
      [{ ...valid, writeEnabled: "yes" }, "writeEnabled must be a boolean"],
      [{ ...valid, model: " " }, "model must be a non-empty string"],
      [{ ...valid, text: "" }, "text must be a non-empty string"],
      [{ ...valid, threadId: "" }, "threadId must be a non-empty string"],
      [{ ...valid, systemPrompt: 1 }, "systemPrompt must be a string"],
      [null, "provider must be codex"],
    ] as const) {
      expect(() => handler({}, args)).toThrow(error);
    }
    expect(start).toHaveBeenCalledTimes(1);
  });

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
