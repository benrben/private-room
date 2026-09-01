import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomServerStatus } from "./types";

const bridge = vi.hoisted(() => ({
  api: { getSetting: vi.fn() },
  regenerateLeashToken: vi.fn(),
  roomServerStatus: vi.fn(),
  setRoomServer: vi.fn(),
}));

vi.mock("../api", () => bridge);

import { useRoomServer } from "./useRoomServer";

const globalKeys = ["window", "document", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

type RoomServer = ReturnType<typeof useRoomServer>;
let roomServer: RoomServer | null = null;

function RoomServerProbe() {
  roomServer = useRoomServer();
  return null;
}

function current(): RoomServer {
  if (!roomServer) throw new Error("Room-server hook has not rendered.");
  return roomServer;
}

function leash(overrides: Partial<RoomServerStatus> = {}): RoomServerStatus {
  return {
    running: false,
    url: "http://127.0.0.1:17872/mcp",
    config: '{"mcpServers":{"room":{}}}',
    scope: "files",
    stable: false,
    allowCloud: false,
    ...overrides,
  };
}

async function flush(rounds = 6) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

async function renderHook() {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Event: window.Event, React, IS_REACT_ACT_ENVIRONMENT: true })) Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(RoomServerProbe)));
  await flush();
  return { close: async () => act(async () => root.unmount()) };
}

function configureBridge(initial = leash()) {
  roomServer = null;
  bridge.api.getSetting.mockReset().mockResolvedValue("files");
  bridge.regenerateLeashToken.mockReset().mockResolvedValue(leash());
  bridge.roomServerStatus.mockReset().mockResolvedValue(initial);
  bridge.setRoomServer.mockReset().mockResolvedValue(leash());
}

beforeEach(() => configureBridge());

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("useRoomServer", () => {
  it("seeds a running room server's scope and cloud policy from its fabricated status", async () => {
    const running = leash({ running: true, scope: "full", stable: true, allowCloud: true });
    configureBridge(running);
    const view = await renderHook();

    expect(current().leash).toEqual(running);
    expect(current().scope).toBe("full");
    expect(current().allowCloud).toBe(true);
    expect(bridge.api.getSetting).not.toHaveBeenCalled();
    await view.close();
  });

  it("restores the saved full scope when a fabricated stopped status has no active tier", async () => {
    configureBridge(leash({ running: false, scope: "files" }));
    bridge.api.getSetting.mockResolvedValue("full");
    const view = await renderHook();

    expect(bridge.api.getSetting).toHaveBeenCalledWith("room_server_scope");
    expect(current().leash.running).toBe(false);
    expect(current().scope).toBe("full");
    await view.close();
  });

  it("ignores a fabricated initial status that arrives after its settings view closes", async () => {
    let resolveStatus: ((value: RoomServerStatus) => void) | null = null;
    bridge.roomServerStatus.mockImplementationOnce(() => new Promise<RoomServerStatus>((resolve) => { resolveStatus = resolve; }));
    const view = await renderHook();
    await view.close();

    await act(async () => {
      resolveStatus?.(leash({ running: true, scope: "full", allowCloud: true }));
      await Promise.resolve();
    });
    expect(current().leash.running).toBe(false);
    expect(bridge.api.getSetting).not.toHaveBeenCalled();
  });

  it("starts the fabricated room server at the restored policy and exposes its returned status", async () => {
    configureBridge(leash({ running: false }));
    bridge.api.getSetting.mockResolvedValue("full");
    const started = leash({ running: true, scope: "full", stable: true, allowCloud: false });
    let resolveStart: ((value: RoomServerStatus) => void) | null = null;
    bridge.setRoomServer.mockImplementationOnce(() => new Promise<RoomServerStatus>((resolve) => { resolveStart = resolve; }));
    const view = await renderHook();

    await act(async () => {
      current().toggleLeash();
      await Promise.resolve();
    });
    expect(bridge.setRoomServer).toHaveBeenCalledWith(true, false, "full");
    expect(current().leashBusy).toBe(true);
    await act(async () => {
      resolveStart?.(started);
      await Promise.resolve();
    });
    expect(current().leashBusy).toBe(false);
    expect(current().leash).toEqual(started);
    expect(current().scope).toBe("full");
    await view.close();
  });

  it("keeps the current room-server status and surfaces a fabricated apply failure", async () => {
    const stopped = leash({ running: false });
    configureBridge(stopped);
    bridge.setRoomServer.mockRejectedValueOnce(new Error("port already in use"));
    const view = await renderHook();

    await act(async () => {
      current().toggleLeash();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(bridge.setRoomServer).toHaveBeenCalledWith(true, false, "files");
    expect(current().leash).toEqual(stopped);
    expect(current().leashBusy).toBe(false);
    expect(current().leashErr).toBe("Error: port already in use");
    await view.close();
  });

  it("updates stopped policy locally and restarts a running fabricated server for policy changes", async () => {
    const view = await renderHook();
    await act(async () => current().toggleAllowCloud(true));
    await act(async () => current().changeScope("full"));
    expect(current().allowCloud).toBe(true);
    expect(current().scope).toBe("full");
    expect(bridge.setRoomServer).not.toHaveBeenCalled();
    await view.close();

    const running = leash({ running: true, allowCloud: false, scope: "files" });
    configureBridge(running);
    bridge.setRoomServer
      .mockResolvedValueOnce(leash({ running: true, allowCloud: true, scope: "files" }))
      .mockResolvedValueOnce(leash({ running: true, allowCloud: true, scope: "full" }));
    const activeView = await renderHook();
    await act(async () => current().toggleAllowCloud(true));
    await act(async () => current().changeScope("full"));
    expect(bridge.setRoomServer.mock.calls).toEqual([
      [true, true, "files"],
      [true, true, "full"],
    ]);
    expect(current().leash).toEqual(leash({ running: true, allowCloud: true, scope: "full" }));
    await activeView.close();
  });

  it("regenerates a fabricated token and exposes a regeneration failure", async () => {
    const renewed = leash({ running: true, stable: true, config: "fresh config" });
    bridge.regenerateLeashToken.mockResolvedValueOnce(renewed);
    const view = await renderHook();

    await act(async () => current().regenerateToken());
    expect(current().leash).toEqual(renewed);
    expect(current().leashBusy).toBe(false);

    bridge.regenerateLeashToken.mockRejectedValueOnce(new Error("fake token failure"));
    await act(async () => current().regenerateToken());
    expect(current().leashErr).toBe("Error: fake token failure");
    expect(current().leashBusy).toBe(false);
    await view.close();
  });

  it("copies the fabricated leash config and silently leaves manual copy available when blocked", async () => {
    configureBridge(leash({ config: "fabricated config" }));
    const view = await renderHook();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    await act(async () => current().copyLeashConfig());
    expect(writeText).toHaveBeenCalledWith("fabricated config");
    expect(current().leashCopied).toBe(true);

    writeText.mockRejectedValueOnce(new Error("fake clipboard block"));
    await act(async () => current().copyLeashConfig());
    expect(current().leashCopied).toBe(true);
    await view.close();
  });
});
