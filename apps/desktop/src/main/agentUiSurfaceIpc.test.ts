import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomManagerDeps } from "./roomManager.js";

const crypto = vi.hoisted(() => ({ randomUUID: vi.fn() }));

vi.mock("node:crypto", () => crypto);

import {
  createAgentUiRuntime,
  NO_LONGER_WAITING,
  registerAgentUiSurfaceIpc,
  requestAgentUi,
} from "./agentUiSurfaceIpc.js";

type Handler = (event: IpcMainInvokeEvent, raw: unknown) => void;

function register(deps: RoomManagerDeps, runtime = createAgentUiRuntime()): {
  handlers: Map<string, Handler>;
  runtime: ReturnType<typeof createAgentUiRuntime>;
} {
  const handlers = new Map<string, Handler>();
  const registered = registerAgentUiSurfaceIpc({
    handle(channel, handler): void {
      handlers.set(channel, handler as Handler);
    },
  } as Pick<IpcMain, "handle">, deps, runtime);
  return { handlers, runtime: registered };
}

describe("agent UI surface IPC with fake IPC and room state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    crypto.randomUUID.mockReturnValue("fake-request-id");
  });

  it("emits a fake request and resolves it through the registered IPC handler", async () => {
    const { handlers, runtime } = register({ userDataDir: "/fake/user-data" } as RoomManagerDeps);
    const emitted = vi.fn();
    const pending = requestAgentUi(runtime, emitted, "ui_snapshot", { width: 320 });

    expect(emitted).toHaveBeenCalledWith("agent-ui-request", {
      id: "fake-request-id",
      kind: "ui_snapshot",
      args: { width: 320 },
    });
    handlers.get("resolve_agent_ui")!({} as IpcMainInvokeEvent, {
      id: "fake-request-id",
      payload: { imageB64: "fake-image" },
    });

    await expect(pending).resolves.toEqual({ imageB64: "fake-image" });
    expect(runtime.pending).toEqual(new Map());
  });

  it("keeps an explicit renderer error and all late/malformed replies meaningful", async () => {
    const { handlers, runtime } = register({ userDataDir: "/fake/user-data" } as RoomManagerDeps);
    const pending = requestAgentUi(runtime, vi.fn(), "ui_snapshot", {});
    const resolve = handlers.get("resolve_agent_ui")!;

    resolve({} as IpcMainInvokeEvent, { id: "fake-request-id", payload: { error: "fake UI refusal" } });
    await expect(pending).rejects.toThrow("fake UI refusal");
    expect(() => resolve({} as IpcMainInvokeEvent, { id: "fake-request-id" })).toThrow(NO_LONGER_WAITING);
    expect(() => resolve({} as IpcMainInvokeEvent, null)).toThrow(NO_LONGER_WAITING);
  });

  it("settles outstanding fake UI requests when room caches are cleared", () => {
    const previousClear = vi.fn();
    const resolved = vi.fn();
    const runtime = createAgentUiRuntime();
    runtime.pending.set("pending-one", resolved);
    const deps = { userDataDir: "/fake/user-data", clearEphemeralCaches: previousClear } as RoomManagerDeps;

    register(deps, runtime);
    deps.clearEphemeralCaches!();

    expect(previousClear).toHaveBeenCalledOnce();
    expect(resolved).toHaveBeenCalledWith({ error: "The room was closed." });
    expect(runtime.pending).toEqual(new Map());
  });

  it.each([
    ["ui_snapshot" as const, "interface didn't answer"],
    ["browse_consent" as const, "user did not answer"],
  ])("times out an unanswered %s request with its honest refusal", async (kind, message) => {
    vi.useFakeTimers();
    try {
      const runtime = createAgentUiRuntime();
      const pending = requestAgentUi(runtime, vi.fn(), kind, {});
      const rejection = expect(pending).rejects.toThrow(message);
      await vi.runAllTimersAsync();
      await rejection;
      expect(runtime.pending).toEqual(new Map());
    } finally {
      vi.useRealTimers();
    }
  });
});
