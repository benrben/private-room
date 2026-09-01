import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";

const fakes = vi.hoisted(() => ({
  getSetting: vi.fn(),
  randomUUID: vi.fn(),
  setSetting: vi.fn(),
  webAccessEnabled: vi.fn(),
  writeDiscovery: vi.fn(),
}));

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: fakes.randomUUID,
}));
vi.mock("./db-host/settings.js", () => ({
  getSetting: fakes.getSetting,
  setSetting: fakes.setSetting,
}));
vi.mock("./gatherContext.js", () => ({ webAccessEnabled: fakes.webAccessEnabled }));
vi.mock("./moonshotDiscovery.js", () => ({
  removeDiscovery: vi.fn(),
  writeDiscovery: fakes.writeDiscovery,
}));
vi.mock("./mcpBridge.js", () => ({ McpBridge: class {} }));

import {
  LEASH_DEFAULT_PORT,
  regenerateLeashToken,
  type RoomServerRoomSource,
  type RoomServerSlot,
  type RunningBridge,
  type SetRoomServerDeps,
} from "./moonshotServer.js";

const db = {} as Database.Database;
const roomPath = "/fabricated/room.roomai";
const roomName = "Fabricated Room";
let settings: Map<string, string>;

function bridge(scope: RunningBridge["scope"], token = "old-token"): RunningBridge {
  return {
    port: 19_001,
    token,
    scope,
    stable: true,
    mcpConfigJson: vi.fn(() => "fabricated-config"),
    stop: vi.fn(),
    stopAndWait: vi.fn(async () => undefined),
  };
}

function roomSource(path = roomPath): RoomServerRoomSource {
  return { currentRoom: () => ({ path, name: roomName, db }) };
}

function deps(startBridge = vi.fn()): SetRoomServerDeps {
  return {
    startBridge,
    writeDiscovery: fakes.writeDiscovery,
    removeDiscovery: vi.fn(),
  } as SetRoomServerDeps;
}

beforeEach(() => {
  vi.clearAllMocks();
  settings = new Map();
  fakes.randomUUID.mockReturnValue("renewed-token-1234");
  fakes.getSetting.mockImplementation((_db: Database.Database, key: string) => settings.get(key) ?? null);
  fakes.setSetting.mockImplementation((_db: Database.Database, key: string, value: string) => {
    settings.set(key, value);
  });
  fakes.webAccessEnabled.mockReturnValue(false);
});

describe("regenerateLeashToken", () => {
  it("mints a fabricated token without starting a bridge when the slot is empty", async () => {
    const slot: RoomServerSlot = { bridge: null };
    const startBridge = vi.fn();

    await expect(regenerateLeashToken(db, roomPath, roomName, slot, roomSource(), deps(startBridge))).resolves.toMatchObject({
      running: false,
    });

    expect(settings.get("leash_token")).toBe("renewedtoken1234");
    expect(settings.get("leash_port")).toBe(String(LEASH_DEFAULT_PORT));
    expect(startBridge).not.toHaveBeenCalled();
  });

  it("leaves a fabricated files-tier bridge running while still renewing its token", async () => {
    const filesBridge = bridge({ kind: "CloudAdvisor", includeMcp: true });
    const slot: RoomServerSlot = { bridge: filesBridge };
    const startBridge = vi.fn();

    await regenerateLeashToken(db, roomPath, roomName, slot, roomSource(), deps(startBridge));

    expect(slot.bridge).toBe(filesBridge);
    expect(filesBridge.stopAndWait).not.toHaveBeenCalled();
    expect(startBridge).not.toHaveBeenCalled();
  });

  it("restarts a fabricated full-tier bridge with the renewed token and tolerates discovery failure", async () => {
    settings.set("room_server_enabled", "1");
    settings.set("leash_port", "19002");
    settings.set("web_agent_search", "off");
    fakes.webAccessEnabled.mockReturnValue(true);
    const oldBridge = bridge({ kind: "ExternalAgent" });
    const freshBridge = bridge({ kind: "ExternalAgent" }, "fresh-token");
    const startBridge = vi.fn(async () => freshBridge);
    fakes.writeDiscovery.mockImplementation(() => { throw new Error("fabricated discovery failure"); });
    const slot: RoomServerSlot = { bridge: oldBridge };

    await expect(regenerateLeashToken(db, roomPath, roomName, slot, roomSource(), deps(startBridge))).resolves.toMatchObject({
      running: true,
      url: "http://127.0.0.1:19001/mcp",
      scope: "full",
    });

    expect(oldBridge.stopAndWait).toHaveBeenCalledOnce();
    expect(startBridge).toHaveBeenCalledWith(true, { kind: "ExternalAgent" }, {
      port: 19_002,
      token: "renewedtoken1234",
      lanes: { search: false, browse: true },
    });
    expect(slot.bridge).toBe(freshBridge);
    expect(fakes.writeDiscovery).toHaveBeenCalledWith(19_001, "fresh-token", "full", roomName);
  });

  it("stops a restarted fabricated bridge if the room changed before it could be stored", async () => {
    settings.set("room_server_enabled", "1");
    const oldBridge = bridge({ kind: "ExternalAgent" });
    const freshBridge = bridge({ kind: "ExternalAgent" }, "fresh-token");
    const startBridge = vi.fn(async () => freshBridge);
    const slot: RoomServerSlot = { bridge: oldBridge };

    await expect(
      regenerateLeashToken(db, roomPath, roomName, slot, roomSource("/fabricated/other.roomai"), deps(startBridge)),
    ).resolves.toMatchObject({ running: false });

    expect(freshBridge.stop).toHaveBeenCalledOnce();
    expect(slot.bridge).toBeNull();
    expect(fakes.writeDiscovery).not.toHaveBeenCalled();
  });
});
