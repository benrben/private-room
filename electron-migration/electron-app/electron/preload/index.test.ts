/**
 * Tests for `preload/index.ts`'s testable half — `createArcelleApi`,
 * `installArcelleBridge`, and the two channel guards — driven against fakes,
 * exactly like `recIpc.test.ts` fakes `ipcMain` rather than importing real
 * Electron. The module's real-`electron` tail (guarded by
 * `process.versions.electron`) is deliberately NOT exercised here: plain
 * vitest/Node never sets that property, so importing this file under vitest
 * never touches the real `electron` module at all. The real preload path is
 * proven instead by `electron/main/index.electron.test.ts`, which launches an
 * actual Electron process with this file as its real preload script.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createArcelleApi,
  installArcelleBridge,
  UnknownChannelError,
  type ContextBridgeLike,
  type IpcRendererLike,
} from "./index.js";
import { ALL_COMMAND_NAMES, ALL_EVENT_NAMES } from "../shared/channelAllowlist.js";

function fakeIpcRenderer(): IpcRendererLike & { calls: { invoke: unknown[][] } } {
  const calls = { invoke: [] as unknown[][] };
  return {
    calls,
    invoke: vi.fn((channel: string, args?: unknown) => {
      calls.invoke.push([channel, args]);
      return Promise.resolve({ echoed: channel });
    }) as unknown as IpcRendererLike["invoke"],
    on: vi.fn() as unknown as IpcRendererLike["on"],
    removeListener: vi.fn() as unknown as IpcRendererLike["removeListener"],
  };
}

describe("createArcelleApi.invoke", () => {
  it("forwards a known command channel to the real ipcRenderer.invoke", async () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    expect(await api.invoke("room_info", {})).toEqual({ echoed: "room_info" });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("room_info", {});
  });

  it("forwards every real command channel without refusing any of them", async () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    for (const name of ALL_COMMAND_NAMES) {
      await expect(api.invoke(name, {})).resolves.toBeDefined();
    }
    expect(ipcRenderer.calls.invoke.length).toBe(ALL_COMMAND_NAMES.length);
  });

  it("REJECTS an unknown channel rather than throwing synchronously", () => {
    // The distinction matters: a call site written as
    // `arcelle.invoke(ch, a).catch(handle)` — no await, no enclosing async —
    // catches a rejection and does NOT catch a synchronous throw. `invoke`
    // must fail exactly one way. This test would pass on a sync-throwing
    // implementation if it used `await`, so it deliberately does not.
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    let returned: Promise<unknown> | undefined;
    expect(() => {
      returned = api.invoke("drop_table_files", {});
    }).not.toThrow();
    expect(returned).toBeInstanceOf(Promise);
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    return expect(returned).rejects.toBeInstanceOf(UnknownChannelError);
  });

  it("refuses an unknown channel BEFORE calling ipcRenderer.invoke at all", async () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    await expect(api.invoke("drop_table_files", {})).rejects.toThrow(UnknownChannelError);
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  it("refuses prototype-pollution-shaped channel strings", async () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    for (const junk of ["__proto__", "constructor", "hasOwnProperty", "toString"]) {
      await expect(api.invoke(junk, {})).rejects.toThrow(UnknownChannelError);
    }
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  it("refuses an EVENT channel on the invoke side", async () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    await expect(api.invoke("ask-delta", {})).rejects.toThrow(UnknownChannelError);
  });

  it("the refusal error carries the channel name for debugging", async () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    await expect(api.invoke("not_a_real_command", {})).rejects.toThrow('"not_a_real_command"');
  });
});

describe("createArcelleApi.on", () => {
  it("subscribes a known event channel and unwraps the payload", () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    const received: unknown[] = [];
    api.on("room-files-changed", (payload) => received.push(payload));
    expect(ipcRenderer.on).toHaveBeenCalledTimes(1);
    const [, registeredListener] = (ipcRenderer.on as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      (event: unknown, payload: unknown) => void,
    ];
    registeredListener({ fakeElectronEvent: true }, { some: "payload" });
    expect(received).toEqual([{ some: "payload" }]);
  });

  it("accepts every real event channel", () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    for (const name of ALL_EVENT_NAMES) {
      expect(() => api.on(name, () => undefined)).not.toThrow();
    }
    expect(ipcRenderer.on).toHaveBeenCalledTimes(ALL_EVENT_NAMES.length);
  });

  it("returns an unsubscribe function that calls removeListener with the SAME listener", () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    const unsubscribe = api.on("file-updated", () => undefined);
    const [, registeredListener] = (ipcRenderer.on as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      unknown,
    ];
    unsubscribe();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith("file-updated", registeredListener);
  });

  it("THROWS on an unknown event channel — there is no promise to reject", () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    expect(() => api.on("totally-made-up-event", () => undefined)).toThrow(UnknownChannelError);
    expect(ipcRenderer.on).not.toHaveBeenCalled();
  });

  it("refuses a COMMAND channel on the on() side", () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    expect(() => api.on("create_room", () => undefined)).toThrow(UnknownChannelError);
  });

  it("refuses prototype-pollution-shaped event channels", () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    for (const junk of ["__proto__", "constructor", "hasOwnProperty"]) {
      expect(() => api.on(junk, () => undefined)).toThrow(UnknownChannelError);
    }
    expect(ipcRenderer.on).not.toHaveBeenCalled();
  });
});

describe("installArcelleBridge", () => {
  it("exposes exactly one 'arcelle' key on the context bridge", () => {
    const ipcRenderer = fakeIpcRenderer();
    const exposed = new Map<string, unknown>();
    const contextBridge: ContextBridgeLike = {
      exposeInMainWorld: (key, api) => exposed.set(key, api),
    };
    installArcelleBridge(contextBridge, ipcRenderer);
    expect(exposed.size).toBe(1);
    expect(exposed.has("arcelle")).toBe(true);
    const api = exposed.get("arcelle") as { invoke: unknown; on: unknown };
    expect(typeof api.invoke).toBe("function");
    expect(typeof api.on).toBe("function");
  });

  it("the exposed api round-trips a real invoke through the fake ipcRenderer", async () => {
    const ipcRenderer = fakeIpcRenderer();
    let exposedApi: { invoke: (channel: string, args?: unknown) => Promise<unknown> } | undefined;
    const contextBridge: ContextBridgeLike = {
      exposeInMainWorld: (_key, api) => {
        exposedApi = api as typeof exposedApi;
      },
    };
    installArcelleBridge(contextBridge, ipcRenderer);
    expect(await exposedApi!.invoke("list_roles", {})).toEqual({ echoed: "list_roles" });
  });
});
