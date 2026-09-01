import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolScope } from "./mcpBridge.js";
import type { RunningBridge, SetRoomServerDeps } from "./moonshotServer.js";
import type { Room, RoomManagerState } from "./roomManager.js";

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  webAccessEnabled: vi.fn(),
  leashIdentity: vi.fn(),
  leashScope: vi.fn(),
  liveExecToolDeps: vi.fn(() => ({})),
  liveMcpRoutes: vi.fn(() => []),
  scopeName: vi.fn(),
  storeBridgeIfCurrent: vi.fn(),
  webLanesFromSettings: vi.fn(),
}));

vi.mock("./liveAppServices.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./liveAppServices.js")>(),
  liveMcpRoutes: mocks.liveMcpRoutes,
}));
vi.mock("./liveContext.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./liveContext.js")>(),
  liveExecToolDeps: mocks.liveExecToolDeps,
}));

vi.mock("./db-host/settings.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./db-host/settings.js")>(),
  getSetting: mocks.getSetting,
}));
vi.mock("./gatherContext.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./gatherContext.js")>(),
  webAccessEnabled: mocks.webAccessEnabled,
}));
vi.mock("./moonshotServer.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./moonshotServer.js")>(),
  leashIdentity: mocks.leashIdentity,
  leashScope: mocks.leashScope,
  scopeName: mocks.scopeName,
  storeBridgeIfCurrent: mocks.storeBridgeIfCurrent,
  webLanesFromSettings: mocks.webLanesFromSettings,
}));

import {
  roomServerDispatcherFactory,
  roomServerRoomSource,
  spawnRoomServerIfEnabledCore,
} from "./roomServerLive.js";

const EXTERNAL_SCOPE: ToolScope = { kind: "ExternalAgent" };
const IDENTITY = { port: 18_000, token: "stable-token" };

let settings: Map<string, string>;

beforeEach(() => {
  settings = new Map();
  vi.clearAllMocks();
  mocks.getSetting.mockImplementation((_conn: unknown, key: string) => settings.get(key) ?? null);
  mocks.webAccessEnabled.mockReturnValue(true);
  mocks.leashIdentity.mockReturnValue(IDENTITY);
  mocks.leashScope.mockImplementation((setting: string | null | undefined) =>
    setting === "full" ? EXTERNAL_SCOPE : { kind: "CloudAdvisor", includeMcp: false }
  );
  mocks.scopeName.mockReturnValue("full");
  mocks.webLanesFromSettings.mockReturnValue({ search: true, browse: false });
  mocks.storeBridgeIfCurrent.mockImplementation((
    _source: unknown,
    slot: { bridge: RunningBridge | null },
    _roomPath: string,
    bridge: RunningBridge,
  ) => {
    slot.bridge = bridge;
    return true;
  });
});

function fakeRoom(): Room {
  return {
    conn: {} as Room["conn"],
    path: "/fake/room.roomai",
    name: "Fake room",
    password: "not-used",
  };
}

function fakeState(room: Room): RoomManagerState {
  return { room, roomServer: null } as RoomManagerState;
}

function fakeBridge(scope: ToolScope = EXTERNAL_SCOPE): RunningBridge {
  return {
    port: IDENTITY.port,
    token: IDENTITY.token,
    scope,
    stable: true,
    mcpConfigJson: () => "{}",
    stop: vi.fn(),
    stopAndWait: vi.fn(async () => {}),
  };
}

function fakeDeps(bridge: RunningBridge) {
  const startBridge = vi.fn(async () => bridge);
  const writeDiscovery = vi.fn();
  return {
    deps: { startBridge, writeDiscovery } as Pick<SetRoomServerDeps, "startBridge" | "writeDiscovery">,
    startBridge,
    writeDiscovery,
  };
}

describe("spawnRoomServerIfEnabledCore with injected lifecycle fakes", () => {
  it("returns no current room through the live room-source adapter", () => {
    expect(roomServerRoomSource({ room: null } as RoomManagerState).currentRoom()).toBeNull();
  });

  it("threads live connector routes into a dispatcher without invoking a provider", () => {
    const room = fakeRoom();
    const state = fakeState(room);
    const manager = { marker: "mcp manager" };
    const services = { mcp: { manager } };

    const dispatcher = roomServerDispatcherFactory(state, vi.fn(), services as never)(
      false,
      { kind: "CloudAdvisor", includeMcp: false },
      { search: false, browse: false },
    );

    expect(dispatcher).toBeDefined();
    expect(mocks.liveMcpRoutes).toHaveBeenCalledWith(state, manager);
  });

  it("resolves the external identity before returning disabled, without starting a bridge", async () => {
    const room = fakeRoom();
    const state = fakeState(room);
    const { deps, startBridge } = fakeDeps(fakeBridge());
    settings.set("room_server_enabled", "0");
    settings.set("room_server_scope", "full");

    await expect(spawnRoomServerIfEnabledCore(state, room, deps)).resolves.toEqual({ kind: "disabled" });

    expect(mocks.leashIdentity).toHaveBeenCalledWith(room.conn);
    expect(mocks.webLanesFromSettings).toHaveBeenCalledWith(room.conn);
    expect(mocks.webAccessEnabled).toHaveBeenCalledWith(room.conn);
    expect(startBridge).not.toHaveBeenCalled();
  });

  it("passes the persisted identity to the injected starter and advertises only its stored external bridge", async () => {
    const room = fakeRoom();
    const state = fakeState(room);
    const bridge = fakeBridge();
    const { deps, startBridge, writeDiscovery } = fakeDeps(bridge);
    settings.set("room_server_enabled", "1");
    settings.set("room_server_scope", "full");

    await expect(spawnRoomServerIfEnabledCore(state, room, deps)).resolves.toEqual({ kind: "started", bridge });

    expect(startBridge).toHaveBeenCalledWith(true, EXTERNAL_SCOPE, {
      port: IDENTITY.port,
      token: IDENTITY.token,
      lanes: { search: true, browse: false },
    });
    expect(state.roomServer).toBe(bridge as unknown as typeof state.roomServer);
    expect(writeDiscovery).toHaveBeenCalledWith(IDENTITY.port, IDENTITY.token, "full", "Fake room");
  });

  it("does not advertise a bridge when the injected current-room check declines it", async () => {
    const room = fakeRoom();
    const state = fakeState(room);
    const { deps, writeDiscovery } = fakeDeps(fakeBridge());
    settings.set("room_server_enabled", "1");
    settings.set("room_server_scope", "full");
    mocks.storeBridgeIfCurrent.mockReturnValue(false);

    await expect(spawnRoomServerIfEnabledCore(state, room, deps)).resolves.toEqual({ kind: "stale-room" });

    expect(writeDiscovery).not.toHaveBeenCalled();
    expect(state.roomServer).toBeNull();
  });

  it("turns an injected starter rejection into an honest start failure", async () => {
    const room = fakeRoom();
    const state = fakeState(room);
    const { deps, startBridge, writeDiscovery } = fakeDeps(fakeBridge());
    settings.set("room_server_enabled", "1");
    settings.set("room_server_scope", "full");
    startBridge.mockRejectedValueOnce(new Error("fake bind failure"));

    await expect(spawnRoomServerIfEnabledCore(state, room, deps)).resolves.toEqual({ kind: "start-failed" });

    expect(writeDiscovery).not.toHaveBeenCalled();
    expect(state.roomServer).toBeNull();
  });

  it("treats an unavailable external identity as a disabled bridge without starting", async () => {
    const room = fakeRoom();
    const state = fakeState(room);
    const { deps, startBridge } = fakeDeps(fakeBridge());
    settings.set("room_server_enabled", "1");
    settings.set("room_server_scope", "full");
    mocks.leashIdentity.mockImplementationOnce(() => {
      throw new Error("fabricated identity failure");
    });

    await expect(spawnRoomServerIfEnabledCore(state, room, deps)).resolves.toEqual({ kind: "disabled" });
    expect(startBridge).not.toHaveBeenCalled();
  });

  it("keeps a successfully started bridge when discovery writing fails", async () => {
    const room = fakeRoom();
    const state = fakeState(room);
    const bridge = fakeBridge();
    const { deps, writeDiscovery } = fakeDeps(bridge);
    settings.set("room_server_enabled", "1");
    settings.set("room_server_scope", "full");
    writeDiscovery.mockImplementation(() => {
      throw new Error("fabricated discovery failure");
    });

    await expect(spawnRoomServerIfEnabledCore(state, room, deps)).resolves.toEqual({
      kind: "started",
      bridge,
    });
    expect(state.roomServer).toBe(bridge as unknown as typeof state.roomServer);
  });
});
