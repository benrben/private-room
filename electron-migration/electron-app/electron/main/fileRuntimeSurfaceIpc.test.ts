import path from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { registerFileRuntimeSurfaceIpc } from "./fileRuntimeSurfaceIpc.js";
import { logDir, logPath, previousLogPath } from "./obs.js";
import { createRoomManagerState } from "./roomManager.js";
import { previousStderrLogPath, stderrLogPath } from "./sidecar.js";

describe("file runtime utility IPC", () => {
  it("reveals the real directory shared by current and previous host and sidecar logs", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle(channel, handler): void {
        handlers.set(channel, handler as (...args: unknown[]) => unknown);
      },
    } satisfies Pick<IpcMain, "handle">;
    const openPath = vi.fn(async (_target: string) => {});

    registerFileRuntimeSurfaceIpc(
      ipcMain,
      createRoomManagerState(),
      { userDataDir: "/not-the-log-directory", spawnRoomServerIfEnabled: () => {} },
      "/not-the-log-directory",
      () => {},
      { openPath },
    );

    const revealed = await handlers.get("reveal_logs")!({} as IpcMainInvokeEvent);
    expect(revealed).toBe(logDir());
    expect(openPath).toHaveBeenCalledOnce();
    expect(openPath).toHaveBeenCalledWith(logDir());
    for (const file of [logPath(), previousLogPath(), stderrLogPath(), previousStderrLogPath()]) {
      expect(path.dirname(file)).toBe(logDir());
    }
  });
});
