/**
 * Tests for `moonshotServer.ts`.
 *
 * Pure logic is driven directly against a real fixture room (`createRoom`,
 * the established convention — see `skillsCmds.test.ts`). Network calls
 * (`testOllamaUrl`'s `/models` POST) are driven against a REAL local
 * `node:http` server with `ensureUp` (from `sidecar.js`) mocked to point at
 * it — the same convention `ollamaModels.test.ts` establishes. No real
 * sidecar process and no real Ollama daemon is ever touched.
 */

import * as http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync, statSync, chmodSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";

vi.mock("./sidecar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sidecar.js")>();
  return { ...actual, ensureUp: vi.fn(actual.ensureUp) };
});

import { ensureUp } from "./sidecar.js";
import { resetBaseUrlOverrideForTests, resolvedBaseUrl, setBaseUrlOverride } from "./engineRouting.js";
import { createRoom } from "./db-host/open.js";
import { getSetting, setSetting } from "./db-host/settings.js";
import type { RunningBridge } from "./moonshotServer.js";
import {
  createRoomBridge,
  discoveryFilePath,
  getOllamaUrl,
  LEASH_DEFAULT_PORT,
  leashIdentity,
  leashScope,
  normalizeOllamaUrl,
  regenerateLeashToken,
  registerMoonshotServerIpc,
  removeDiscovery,
  roomServerStatus,
  roomServerStatusSnapshot,
  scopeName,
  setOllamaUrl,
  setRoomServer,
  START_ROOM_BRIDGE_NOT_IMPLEMENTED,
  startRoomBridgeNotImplemented,
  storeBridgeIfCurrent,
  testOllamaUrl,
  webLanesFromSettings,
  writeDiscovery,
  type RoomServerRoomSource,
  type RoomServerSlot,
  type SetRoomServerDeps,
} from "./moonshotServer.js";
import { McpBridge, type ToolDispatcher, type ToolScope } from "./mcpBridge.js";

// --------------------------------------------------------------- fixtures

const tmpDirs: string[] = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function freshRoom(): { db: Database.Database; path: string; name: string } {
  const dir = freshDir("moonshot-server-");
  const filePath = path.join(dir, `t-${randomUUID()}.roomai`);
  const db = createRoom(filePath, "correct horse battery staple", "Test Room");
  return { db, path: filePath, name: "Test Room" };
}

let server: http.Server | undefined;

async function listenOn(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function sidecarAt(handler: http.RequestListener): Promise<string> {
  const base = await listenOn(handler);
  vi.mocked(ensureUp).mockResolvedValue(base);
  return base;
}

afterEach(async () => {
  vi.mocked(ensureUp).mockReset();
  resetBaseUrlOverrideForTests();
  if (server !== undefined) {
    const s = server;
    server = undefined;
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeBridge(scope: ToolScope, overrides: Partial<RunningBridge> = {}): RunningBridge {
  return {
    port: 12345,
    token: "tok",
    scope,
    stable: true,
    mcpConfigJson: () => JSON.stringify({ fake: true }),
    stop: vi.fn(),
    stopAndWait: vi.fn(async () => {}),
    ...overrides,
  };
}

function settingsOnlyDb(initial: Record<string, string> = {}): {
  db: Database.Database;
  settings: Map<string, string>;
} {
  const settings = new Map(Object.entries(initial));
  const db = {
    prepare(sql: string) {
      const statement = {
        raw: () => statement,
        get: (key: string) => {
          const value = settings.get(key);
          return value === undefined ? undefined : [value];
        },
        run: (key: string, value: string) => {
          if (sql.includes("INSERT INTO settings")) settings.set(key, value);
          return { changes: 1 };
        },
      };
      return statement;
    },
  } as unknown as Database.Database;
  return { db, settings };
}

// ============================================================================
// D9: pure scope mapping
// ============================================================================

describe("leashScope / scopeName", () => {
  it("maps the persisted setting to a tier, and back", () => {
    expect(leashScope("full", false)).toEqual({ kind: "ExternalAgent" });
    expect(leashScope("full", true)).toEqual({ kind: "ExternalAgent" });
    expect(leashScope("files", false)).toEqual({ kind: "CloudAdvisor", includeMcp: false });
    expect(leashScope("files", true)).toEqual({ kind: "CloudAdvisor", includeMcp: true });
    expect(leashScope(null, false)).toEqual({ kind: "CloudAdvisor", includeMcp: false });
    expect(leashScope("banana", false)).toEqual({ kind: "CloudAdvisor", includeMcp: false });

    expect(scopeName({ kind: "ExternalAgent" })).toBe("full");
    expect(scopeName({ kind: "LocalEngine" })).toBe("files");
    expect(scopeName({ kind: "CloudAdvisor", includeMcp: true })).toBe("files");
  });
});

// ============================================================================
// D9: leash_identity / web_lanes — real fixture room
// ============================================================================

describe("leashIdentity", () => {
  it("creates the identity once and returns the SAME values forever, until rotated", () => {
    const { db } = freshRoom();
    setSetting(db, "room_server_scope", "full");
    expect(getSetting(db, "room_server_scope")).toBe("full");

    const { port, token } = leashIdentity(db);
    expect(port).toBe(LEASH_DEFAULT_PORT);
    expect(token).not.toBe("");
    expect(getSetting(db, "leash_port")).toBe("17872");
    expect(getSetting(db, "leash_token")).toBe(token);

    const again = leashIdentity(db);
    expect(again).toEqual({ port, token });

    setSetting(db, "leash_token", "rotated");
    expect(leashIdentity(db).token).toBe("rotated");
  });

  it("re-seeds an unparseable stored port rather than trusting it", () => {
    const { db } = freshRoom();
    setSetting(db, "leash_port", "not-a-port");
    expect(leashIdentity(db).port).toBe(LEASH_DEFAULT_PORT);
    expect(getSetting(db, "leash_port")).toBe(String(LEASH_DEFAULT_PORT));
  });
});

describe("webLanesFromSettings", () => {
  it("defaults both lanes ON — absent means on", () => {
    const { db } = freshRoom();
    expect(webLanesFromSettings(db)).toEqual({ search: true, browse: true });
  });

  it("only an explicit 'off' turns a lane off", () => {
    const { db } = freshRoom();
    setSetting(db, "web_agent_search", "off");
    setSetting(db, "web_agent_browse", "on");
    expect(webLanesFromSettings(db)).toEqual({ search: false, browse: true });
  });
});

// ============================================================================
// D9: discovery file
// ============================================================================

describe("discovery file", () => {
  it("writes 0600 with every field, resets loosened perms, and removes idempotently", () => {
    const homeDir = freshDir("moonshot-home-");
    const filePath = discoveryFilePath(homeDir);

    writeDiscovery(17872, "tok123", "full", "My Room", homeDir);
    const read = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(read.version).toBe(1);
    expect(read.url).toBe("http://127.0.0.1:17872/mcp");
    expect(read.token).toBe("tok123");
    expect(read.scope).toBe("full");
    expect(read.room).toBe("My Room");
    expect(read.pid).toBe(process.pid);
    expect(read.startedAt as number).toBeGreaterThan(0);

    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);

    // A pre-existing leftover with looser permissions has them reset on the
    // next write.
    chmodSync(filePath, 0o644);
    writeDiscovery(17872, "tok123", "full", "My Room", homeDir);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);

    removeDiscovery(homeDir);
    expect(() => statSync(filePath)).toThrow();
    // Idempotent — a second removal on an already-missing file is fine.
    expect(() => removeDiscovery(homeDir)).not.toThrow();
  });
});

// ============================================================================
// D9: roomServerStatusSnapshot / storeBridgeIfCurrent
// ============================================================================

describe("roomServerStatusSnapshot", () => {
  it("answers the not-running default when the slot is empty", () => {
    const slot: RoomServerSlot = { bridge: null };
    expect(roomServerStatus(slot)).toEqual({
      running: false,
      url: "",
      config: "",
      scope: "files",
      stable: false,
      allowCloud: false,
    });
  });

  it("reports allowCloud only for a CloudAdvisor{includeMcp:true} bridge", () => {
    const full: RoomServerSlot = { bridge: fakeBridge({ kind: "ExternalAgent" }, { port: 17872 }) };
    expect(roomServerStatusSnapshot(full)).toMatchObject({
      running: true,
      url: "http://127.0.0.1:17872/mcp",
      scope: "full",
      allowCloud: false,
    });

    const filesNoCloud: RoomServerSlot = {
      bridge: fakeBridge({ kind: "CloudAdvisor", includeMcp: false }),
    };
    expect(roomServerStatusSnapshot(filesNoCloud).allowCloud).toBe(false);

    const filesCloud: RoomServerSlot = {
      bridge: fakeBridge({ kind: "CloudAdvisor", includeMcp: true }),
    };
    expect(roomServerStatusSnapshot(filesCloud)).toMatchObject({ scope: "files", allowCloud: true });
  });
});

describe("storeBridgeIfCurrent", () => {
  function sourceFor(room: { path: string; name: string; db: Database.Database } | null): RoomServerRoomSource {
    return { currentRoom: () => room };
  }

  it("stores only while the SAME room path is open and the toggle is on", () => {
    const { db, path: roomPath, name } = freshRoom();
    setSetting(db, "room_server_enabled", "1");
    const slot: RoomServerSlot = { bridge: null };
    const bridge = fakeBridge({ kind: "ExternalAgent" });

    const stored = storeBridgeIfCurrent(sourceFor({ path: roomPath, name, db }), slot, roomPath, bridge);
    expect(stored).toBe(true);
    expect(slot.bridge).toBe(bridge);
    expect(bridge.stop).not.toHaveBeenCalled();
  });

  it("refuses and stops when the open room's path differs", () => {
    const { db, name } = freshRoom();
    setSetting(db, "room_server_enabled", "1");
    const slot: RoomServerSlot = { bridge: null };
    const bridge = fakeBridge({ kind: "ExternalAgent" });

    const stored = storeBridgeIfCurrent(
      sourceFor({ path: "/some/other/room.roomai", name, db }),
      slot,
      "/the/room/it/was/started/for.roomai",
      bridge
    );
    expect(stored).toBe(false);
    expect(slot.bridge).toBeNull();
    expect(bridge.stop).toHaveBeenCalledOnce();
  });

  it("refuses and stops when the toggle was turned off in the meantime", () => {
    const { db, path: roomPath, name } = freshRoom();
    setSetting(db, "room_server_enabled", "0");
    const slot: RoomServerSlot = { bridge: null };
    const bridge = fakeBridge({ kind: "ExternalAgent" });

    expect(storeBridgeIfCurrent(sourceFor({ path: roomPath, name, db }), slot, roomPath, bridge)).toBe(false);
    expect(bridge.stop).toHaveBeenCalledOnce();
  });

  it("refuses and stops when no room is open at all", () => {
    const bridge = fakeBridge({ kind: "ExternalAgent" });
    const slot: RoomServerSlot = { bridge: null };
    expect(storeBridgeIfCurrent(sourceFor(null), slot, "/whatever.roomai", bridge)).toBe(false);
    expect(bridge.stop).toHaveBeenCalledOnce();
  });

  it("refuses and stops when the slot is already occupied", () => {
    const { db, path: roomPath, name } = freshRoom();
    setSetting(db, "room_server_enabled", "1");
    const already = fakeBridge({ kind: "ExternalAgent" });
    const slot: RoomServerSlot = { bridge: already };
    const bridge = fakeBridge({ kind: "ExternalAgent" });

    expect(storeBridgeIfCurrent(sourceFor({ path: roomPath, name, db }), slot, roomPath, bridge)).toBe(false);
    expect(slot.bridge).toBe(already);
    expect(bridge.stop).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// createRoomBridge — real McpBridge, real binding
// ============================================================================

describe("createRoomBridge", () => {
  const dispatcher: ToolDispatcher = {
    listTools: () => [],
    callTool: async () => ({ isError: false, content: [{ type: "text", text: "" }] }),
  };

  it("binds an ephemeral port when none is requested", async () => {
    const bridge = await createRoomBridge({ scope: { kind: "LocalEngine" }, dispatcher });
    try {
      expect(bridge.port).toBeGreaterThan(0);
      expect(bridge.stable).toBe(false);
      expect(JSON.parse(bridge.mcpConfigJson())).toEqual({
        mcpServers: {
          room: {
            type: "http",
            url: `http://127.0.0.1:${bridge.port}/mcp`,
            headers: { Authorization: `Bearer ${bridge.token}` },
          },
        },
      });
    } finally {
      await bridge.stopAndWait();
    }
  });

  it("binds the fixed port when it is free, and reports stable:true", async () => {
    // Bind an ephemeral listener first just to learn a genuinely free port,
    // then release it immediately.
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const freePort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const bridge = await createRoomBridge({ scope: { kind: "LocalEngine" }, dispatcher, port: freePort });
    try {
      expect(bridge.port).toBe(freePort);
      expect(bridge.stable).toBe(true);
    } finally {
      await bridge.stopAndWait();
    }
  });

  it("uses a supplied token in the advertised config instead of minting another", async () => {
    const bridge = await createRoomBridge({
      scope: { kind: "LocalEngine" },
      dispatcher,
      token: "caller-selected-token",
    });
    try {
      expect(bridge.token).toBe("caller-selected-token");
      expect(bridge.mcpConfigJson()).toContain("Bearer caller-selected-token");
    } finally {
      bridge.stop();
      await bridge.stopAndWait();
    }
  });

  it("refuses a bridge whose listen step reports no bound address", async () => {
    const listen = vi.spyOn(McpBridge.prototype, "listen").mockResolvedValue(undefined);
    try {
      await expect(createRoomBridge({ scope: { kind: "LocalEngine" }, dispatcher })).rejects.toThrow(
        "mcp bridge bind failed: no address"
      );
    } finally {
      listen.mockRestore();
    }
  });

  it("retries a taken fixed port then falls back to an ephemeral one, stable:false", async () => {
    const occupied = http.createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const takenPort = (occupied.address() as AddressInfo).port;
    try {
      const bridge = await createRoomBridge({ scope: { kind: "LocalEngine" }, dispatcher, port: takenPort });
      try {
        expect(bridge.port).not.toBe(takenPort);
        expect(bridge.stable).toBe(false);
      } finally {
        await bridge.stopAndWait();
      }
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  }, 10_000);
});

// ============================================================================
// setRoomServer / regenerateLeashToken — real settings, fake bridge starter
// ============================================================================

function roomSourceFrom(room: { path: string; name: string; db: Database.Database }): RoomServerRoomSource {
  return { currentRoom: () => room };
}

describe("setRoomServer", () => {
  it("keeps an already-running full bridge without restarting it", async () => {
    const { db } = settingsOnlyDb();
    const room = { path: "/memory-full.roomai", name: "Memory Full", db };
    const already = fakeBridge({ kind: "ExternalAgent" });
    const slot: RoomServerSlot = { bridge: already };
    const deps: SetRoomServerDeps = {
      startBridge: vi.fn(async () => fakeBridge({ kind: "ExternalAgent" })),
      writeDiscovery: vi.fn(),
      removeDiscovery: vi.fn(),
    };

    await setRoomServer(
      db,
      room.path,
      room.name,
      { enabled: true, allowCloud: false, scope: "full" },
      slot,
      roomSourceFrom(room),
      deps,
    );

    expect(deps.startBridge).not.toHaveBeenCalled();
    expect(already.stopAndWait).not.toHaveBeenCalled();
    expect(slot.bridge).toBe(already);
  });

  it("starts a files bridge once and reuses that exact bridge for the same request", async () => {
    const { db } = settingsOnlyDb();
    const room = { path: "/memory-files.roomai", name: "Memory Files", db };
    const started = fakeBridge({ kind: "CloudAdvisor", includeMcp: false });
    const slot: RoomServerSlot = { bridge: null };
    const deps: SetRoomServerDeps = {
      startBridge: vi.fn(async () => started),
      writeDiscovery: vi.fn(),
      removeDiscovery: vi.fn(),
    };

    await setRoomServer(
      db,
      room.path,
      room.name,
      { enabled: true, allowCloud: false, scope: "files" },
      slot,
      roomSourceFrom(room),
      deps
    );
    await setRoomServer(
      db,
      room.path,
      room.name,
      { enabled: true, allowCloud: false, scope: "files" },
      slot,
      roomSourceFrom(room),
      deps
    );

    expect(deps.startBridge).toHaveBeenCalledOnce();
    expect(slot.bridge).toBe(started);
    expect(deps.removeDiscovery).toHaveBeenCalledOnce();
  });

  it("restarts a mismatched bridge and keeps serving if writing discovery fails", async () => {
    const { db } = settingsOnlyDb();
    const room = { path: "/memory-full.roomai", name: "Memory Full", db };
    const old = fakeBridge({ kind: "CloudAdvisor", includeMcp: false });
    const fresh = fakeBridge({ kind: "ExternalAgent" }, { port: 21212, token: "fresh-token" });
    const slot: RoomServerSlot = { bridge: old };
    const deps: SetRoomServerDeps = {
      startBridge: vi.fn(async () => fresh),
      writeDiscovery: vi.fn(() => {
        throw new Error("discovery directory is unavailable");
      }),
      removeDiscovery: vi.fn(),
    };

    const status = await setRoomServer(
      db,
      room.path,
      room.name,
      { enabled: true, allowCloud: false, scope: "full" },
      slot,
      roomSourceFrom(room),
      deps
    );

    expect(old.stopAndWait).toHaveBeenCalledOnce();
    expect(deps.writeDiscovery).toHaveBeenCalledWith(21212, "fresh-token", "full", "Memory Full");
    expect(slot.bridge).toBe(fresh);
    expect(status.running).toBe(true);
  });

  it("stops a freshly started bridge without discovery when its room closes during the await", async () => {
    const { db } = settingsOnlyDb();
    const room = { path: "/closed-during-start.roomai", name: "Closing Room", db };
    const started = fakeBridge({ kind: "ExternalAgent" });
    const slot: RoomServerSlot = { bridge: null };
    const deps: SetRoomServerDeps = {
      startBridge: vi.fn(async () => started),
      writeDiscovery: vi.fn(),
      removeDiscovery: vi.fn(),
    };

    const status = await setRoomServer(
      db,
      room.path,
      room.name,
      { enabled: true, allowCloud: false, scope: "full" },
      slot,
      { currentRoom: () => null },
      deps
    );

    expect(started.stop).toHaveBeenCalledOnce();
    expect(slot.bridge).toBeNull();
    expect(deps.writeDiscovery).not.toHaveBeenCalled();
    expect(deps.removeDiscovery).not.toHaveBeenCalled();
    expect(status.running).toBe(false);
  });

  it("turns a memory-backed bridge off without invoking a starter", async () => {
    const { db } = settingsOnlyDb();
    const room = { path: "/memory-off.roomai", name: "Memory Off", db };
    const running = fakeBridge({ kind: "ExternalAgent" });
    const slot: RoomServerSlot = { bridge: running };
    const deps: SetRoomServerDeps = {
      startBridge: vi.fn(),
      writeDiscovery: vi.fn(),
      removeDiscovery: vi.fn(),
    };

    await setRoomServer(
      db,
      room.path,
      room.name,
      { enabled: false, allowCloud: false, scope: "full" },
      slot,
      roomSourceFrom(room),
      deps
    );

    expect(running.stop).toHaveBeenCalledOnce();
    expect(deps.startBridge).not.toHaveBeenCalled();
    expect(deps.removeDiscovery).toHaveBeenCalledOnce();
    expect(slot.bridge).toBeNull();
  });

  it("persists the requested tier before a replacement bridge fails to start", async () => {
    const { db, settings } = settingsOnlyDb();
    const old = fakeBridge({ kind: "CloudAdvisor", includeMcp: false });
    const slot: RoomServerSlot = { bridge: old };
    const room = { path: "/memory.roomai", name: "Memory Room", db };
    const deps: SetRoomServerDeps = {
      startBridge: vi.fn(async () => Promise.reject(new Error("starter failed"))),
      writeDiscovery: vi.fn(),
      removeDiscovery: vi.fn(),
    };

    await expect(
      setRoomServer(
        db,
        room.path,
        room.name,
        { enabled: true, allowCloud: false, scope: "full" },
        slot,
        roomSourceFrom(room),
        deps
      )
    ).rejects.toThrow("starter failed");

    expect(settings.get("room_server_enabled")).toBe("1");
    expect(settings.get("room_server_scope")).toBe("full");
    expect(settings.get("leash_port")).toBe(String(LEASH_DEFAULT_PORT));
    expect(old.stopAndWait).toHaveBeenCalledOnce();
    expect(slot.bridge).toBeNull();
    expect(deps.writeDiscovery).not.toHaveBeenCalled();
    expect(deps.removeDiscovery).not.toHaveBeenCalled();
  });

  it("enabled:true, scope:files — starts a bridge, persists settings, removes discovery", async () => {
    const room = freshRoom();
    const slot: RoomServerSlot = { bridge: null };
    const started = fakeBridge({ kind: "CloudAdvisor", includeMcp: true });
    const deps: SetRoomServerDeps = {
      startBridge: vi.fn(async () => started),
      writeDiscovery: vi.fn(),
      removeDiscovery: vi.fn(),
    };

    const status = await setRoomServer(
      room.db,
      room.path,
      room.name,
      { enabled: true, allowCloud: true, scope: "files" },
      slot,
      roomSourceFrom(room),
      deps
    );

    expect(getSetting(room.db, "room_server_enabled")).toBe("1");
    expect(getSetting(room.db, "room_server_scope")).toBe("files");
    expect(deps.startBridge).toHaveBeenCalledWith(
      false, // web_provider unset -> webAccessEnabled false
      { kind: "CloudAdvisor", includeMcp: true },
      { port: undefined, token: undefined, lanes: { search: true, browse: true } }
    );
    expect(slot.bridge).toBe(started);
    expect(deps.removeDiscovery).toHaveBeenCalledOnce();
    expect(deps.writeDiscovery).not.toHaveBeenCalled();
    expect(status.running).toBe(true);
    expect(status.scope).toBe("files");
  });

  it("enabled:true, scope:full — passes the persisted identity and writes discovery", async () => {
    const room = freshRoom();
    const slot: RoomServerSlot = { bridge: null };
    const started = fakeBridge({ kind: "ExternalAgent" }, { port: LEASH_DEFAULT_PORT, token: "the-token" });
    const deps: SetRoomServerDeps = {
      startBridge: vi.fn(async () => started),
      writeDiscovery: vi.fn(),
      removeDiscovery: vi.fn(),
    };

    await setRoomServer(
      room.db,
      room.path,
      room.name,
      { enabled: true, allowCloud: false, scope: "full" },
      slot,
      roomSourceFrom(room),
      deps
    );

    const { port, token } = leashIdentity(room.db);
    expect(deps.startBridge).toHaveBeenCalledWith(false, { kind: "ExternalAgent" }, {
      port,
      token,
      lanes: { search: true, browse: true },
    });
    expect(deps.writeDiscovery).toHaveBeenCalledWith(LEASH_DEFAULT_PORT, "the-token", "full", "Test Room");
    expect(deps.removeDiscovery).not.toHaveBeenCalled();
  });

  it("keeps a running bridge whose scope already matches, without restarting", async () => {
    const room = freshRoom();
    const already = fakeBridge({ kind: "CloudAdvisor", includeMcp: false });
    const slot: RoomServerSlot = { bridge: already };
    const deps: SetRoomServerDeps = {
      startBridge: vi.fn(async () => fakeBridge({ kind: "CloudAdvisor", includeMcp: false })),
      writeDiscovery: vi.fn(),
      removeDiscovery: vi.fn(),
    };

    await setRoomServer(
      room.db,
      room.path,
      room.name,
      { enabled: true, allowCloud: false, scope: "files" },
      slot,
      roomSourceFrom(room),
      deps
    );

    expect(deps.startBridge).not.toHaveBeenCalled();
    expect(already.stopAndWait).not.toHaveBeenCalled();
    expect(slot.bridge).toBe(already);
  });

  it("restarts a running bridge whose scope no longer matches", async () => {
    const room = freshRoom();
    const old = fakeBridge({ kind: "CloudAdvisor", includeMcp: false });
    const slot: RoomServerSlot = { bridge: old };
    const fresh = fakeBridge({ kind: "ExternalAgent" });
    const deps: SetRoomServerDeps = {
      startBridge: vi.fn(async () => fresh),
      writeDiscovery: vi.fn(),
      removeDiscovery: vi.fn(),
    };

    await setRoomServer(
      room.db,
      room.path,
      room.name,
      { enabled: true, allowCloud: false, scope: "full" },
      slot,
      roomSourceFrom(room),
      deps
    );

    expect(old.stopAndWait).toHaveBeenCalledOnce();
    expect(deps.startBridge).toHaveBeenCalledOnce();
    expect(slot.bridge).toBe(fresh);
  });

  it("enabled:false — stops the running bridge (fire-and-forget) and removes discovery", async () => {
    const room = freshRoom();
    const running = fakeBridge({ kind: "ExternalAgent" });
    const slot: RoomServerSlot = { bridge: running };
    const deps: SetRoomServerDeps = {
      startBridge: vi.fn(),
      writeDiscovery: vi.fn(),
      removeDiscovery: vi.fn(),
    };

    const status = await setRoomServer(
      room.db,
      room.path,
      room.name,
      { enabled: false, allowCloud: false, scope: "full" },
      slot,
      roomSourceFrom(room),
      deps
    );

    expect(getSetting(room.db, "room_server_enabled")).toBe("0");
    expect(running.stop).toHaveBeenCalledOnce();
    expect(running.stopAndWait).not.toHaveBeenCalled();
    expect(slot.bridge).toBeNull();
    expect(deps.removeDiscovery).toHaveBeenCalledOnce();
    expect(deps.startBridge).not.toHaveBeenCalled();
    expect(status.running).toBe(false);
  });

  it("a bridge started for a room that closed mid-await is stopped, not stored", async () => {
    const room = freshRoom();
    const slot: RoomServerSlot = { bridge: null };
    const started = fakeBridge({ kind: "ExternalAgent" });
    // The room source reports NO open room by the time storeBridgeIfCurrent
    // runs — simulating a close that happened during deps.startBridge's await.
    const deps: SetRoomServerDeps = {
      startBridge: vi.fn(async () => started),
      writeDiscovery: vi.fn(),
      removeDiscovery: vi.fn(),
    };
    const vanishingSource: RoomServerRoomSource = { currentRoom: () => null };

    await setRoomServer(
      room.db,
      room.path,
      room.name,
      { enabled: true, allowCloud: false, scope: "full" },
      slot,
      vanishingSource,
      deps
    );

    expect(started.stop).toHaveBeenCalledOnce();
    expect(slot.bridge).toBeNull();
    expect(deps.writeDiscovery).not.toHaveBeenCalled();
  });

  it("persists settings even when the default startBridge honestly rejects", async () => {
    const room = freshRoom();
    const slot: RoomServerSlot = { bridge: null };

    await expect(
      setRoomServer(
        room.db,
        room.path,
        room.name,
        { enabled: true, allowCloud: false, scope: "full" },
        slot,
        roomSourceFrom(room)
        // deps omitted -> defaultSetRoomServerDeps, whose startBridge rejects.
      )
    ).rejects.toThrow(START_ROOM_BRIDGE_NOT_IMPLEMENTED);

    // The settings write happened BEFORE the failing start, matching Rust's
    // `state.with_room(...)?` running to completion before `room_mcp::start
    // (...).await?`.
    expect(getSetting(room.db, "room_server_enabled")).toBe("1");
    expect(getSetting(room.db, "room_server_scope")).toBe("full");
    expect(slot.bridge).toBeNull();
  });

  it("startRoomBridgeNotImplemented rejects on its own, with the same message", async () => {
    await expect(startRoomBridgeNotImplemented(false, { kind: "LocalEngine" }, { lanes: { search: true, browse: true } })).rejects.toThrow(
      START_ROOM_BRIDGE_NOT_IMPLEMENTED
    );
  });
});

describe("regenerateLeashToken", () => {
  it("no bridge running — mints a new token and returns the not-running snapshot", async () => {
    const room = freshRoom();
    const slot: RoomServerSlot = { bridge: null };
    setSetting(room.db, "leash_token", "the-old-token");

    const status = await regenerateLeashToken(room.db, room.path, room.name, slot, roomSourceFrom(room));

    expect(getSetting(room.db, "leash_token")).not.toBe("the-old-token");
    expect(status.running).toBe(false);
  });

  it("a files-tier bridge is left untouched", async () => {
    const room = freshRoom();
    const files = fakeBridge({ kind: "CloudAdvisor", includeMcp: true });
    const slot: RoomServerSlot = { bridge: files };

    await regenerateLeashToken(room.db, room.path, room.name, slot, roomSourceFrom(room));

    expect(files.stopAndWait).not.toHaveBeenCalled();
    expect(slot.bridge).toBe(files);
  });

  it("a running full-tier bridge is restarted with the new token and re-discovered", async () => {
    const room = freshRoom();
    setSetting(room.db, "room_server_enabled", "1");
    const old = fakeBridge({ kind: "ExternalAgent" }, { token: "old-token" });
    const slot: RoomServerSlot = { bridge: old };
    const fresh = fakeBridge({ kind: "ExternalAgent" }, { token: "new-token", port: LEASH_DEFAULT_PORT });
    const deps: SetRoomServerDeps = {
      startBridge: vi.fn(async (_webEnabled, _scope, opts) => {
        expect(opts.token).not.toBe("old-token");
        return fresh;
      }),
      writeDiscovery: vi.fn(),
      removeDiscovery: vi.fn(),
    };

    await regenerateLeashToken(room.db, room.path, room.name, slot, roomSourceFrom(room), deps);

    expect(old.stopAndWait).toHaveBeenCalledOnce();
    expect(slot.bridge).toBe(fresh);
    expect(deps.writeDiscovery).toHaveBeenCalledWith(LEASH_DEFAULT_PORT, "new-token", "full", "Test Room");
  });
});

// ============================================================================
// D10: the Closet
// ============================================================================

describe("normalizeOllamaUrl", () => {
  it("keeps the address as typed (bar a trailing slash)", () => {
    expect(normalizeOllamaUrl(" http://192.168.1.20:11434/ ")).toBe("http://192.168.1.20:11434");
    expect(normalizeOllamaUrl("https://box.local/ollama")).toBe("https://box.local/ollama");
    expect(normalizeOllamaUrl("http://[::1]:11434")).toBe("http://[::1]:11434");
  });

  it("repairs the common miss — no scheme", () => {
    expect(normalizeOllamaUrl("192.168.1.20:11434")).toBe("http://192.168.1.20:11434");
  });

  it("blank clears the override", () => {
    expect(normalizeOllamaUrl("   ")).toBe("");
  });

  it("refuses everything that cannot be reached, at the moment it can be fixed", () => {
    for (const bad of [
      "ftp://box:11434",
      "htp://box",
      "http://",
      "http://:11434",
      "http://box:notaport",
      "http://box:0",
      "http://box:99999",
      "my closet box",
    ]) {
      expect(() => normalizeOllamaUrl(bad), bad).toThrow();
    }
  });
});

describe("setOllamaUrl / getOllamaUrl", () => {
  it("applies the runtime override and persists it for the room", () => {
    const { db } = freshRoom();
    setOllamaUrl(db, "http://box:11434/");
    expect(resolvedBaseUrl()).toBe("http://box:11434");
    expect(getOllamaUrl(db)).toBe("http://box:11434");
  });

  it("applies the override even with no room open, but persists nothing", () => {
    setOllamaUrl(null, "http://box:11434");
    expect(resolvedBaseUrl()).toBe("http://box:11434");
  });

  it("an invalid address is refused before touching the override or settings", () => {
    const { db } = freshRoom();
    setBaseUrlOverride("http://untouched:1");
    setSetting(db, "remote_ollama_url", "http://untouched:1");

    expect(() => setOllamaUrl(db, "not a url")).toThrow();
    expect(resolvedBaseUrl()).toBe("http://untouched:1");
    expect(getOllamaUrl(db)).toBe("http://untouched:1");
  });

  it("getOllamaUrl is empty with no room and no setting", () => {
    expect(getOllamaUrl(null)).toBe("");
    const { db } = freshRoom();
    expect(getOllamaUrl(db)).toBe("");
  });
});

describe("testOllamaUrl", () => {
  it("reports success with a model count", async () => {
    await sidecarAt((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: ["qwen3.5:4b", "nomic-embed-text"] }));
    });
    const message = await testOllamaUrl(null, "http://example.test:11434");
    expect(message).toBe("✓ Reached http://example.test:11434 — 2 models available.");
  });

  it("uses singular 'model' for exactly one", async () => {
    await sidecarAt((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: ["qwen3.5:4b"] }));
    });
    const message = await testOllamaUrl(null, "http://example.test:11434");
    expect(message).toBe("✓ Reached http://example.test:11434 — 1 model available.");
  });

  it("reports reachable-but-empty distinctly from unreachable", async () => {
    await sidecarAt((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [] }));
    });
    const message = await testOllamaUrl(null, "http://example.test:11434");
    expect(message).toBe(
      "Reached http://example.test:11434, but it has no models installed — nothing there can answer yet."
    );
  });

  it("reports an unreachable target as an error, not as empty", async () => {
    vi.mocked(ensureUp).mockRejectedValue(new Error("sidecar down"));
    await expect(testOllamaUrl(null, "http://example.test:11434")).rejects.toThrow(
      "Could not reach http://example.test:11434: sidecar down"
    );
  });

  it("saves the address BEFORE testing it — what is tested is what is active", async () => {
    const { db } = freshRoom();
    await sidecarAt((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [] }));
    });
    await testOllamaUrl(db, "http://saved-first.test:11434");
    expect(getOllamaUrl(db)).toBe("http://saved-first.test:11434");
  });
});

// ============================================================================
// IPC registration
// ============================================================================

describe("registerMoonshotServerIpc", () => {
  function fakeIpcMain(): { handle: ReturnType<typeof vi.fn>; handlers: Map<string, (...a: unknown[]) => unknown> } {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    // Wrapped in an async function, matching real Electron's own internal
    // `try { await handler(...) } catch (error) { ... }` — a handler that
    // throws SYNCHRONOUSLY (as `requireRoom` does) still surfaces as a
    // rejected `invoke()`, never an uncaught throw.
    const handle = vi.fn((channel: string, fn: (...a: unknown[]) => unknown) =>
      handlers.set(channel, async (...a: unknown[]) => fn(...a))
    );
    return { handle, handlers };
  }

  it("registers every server.rs channel by its Rust command name", () => {
    const ipc = fakeIpcMain();
    const slot: RoomServerSlot = { bridge: null };
    registerMoonshotServerIpc(ipc as never, { currentRoom: () => null }, slot);

    expect([...ipc.handlers.keys()].sort()).toEqual(
      [
        "get_ollama_url",
        "regenerate_leash_token",
        "room_server_status",
        "set_ollama_url",
        "set_room_server",
        "test_ollama_url",
      ].sort()
    );
  });

  it("set_room_server rejects with NO_ROOM_OPEN when nothing is open", async () => {
    const ipc = fakeIpcMain();
    const slot: RoomServerSlot = { bridge: null };
    registerMoonshotServerIpc(ipc as never, { currentRoom: () => null }, slot);
    const handler = ipc.handlers.get("set_room_server")!;
    await expect(
      handler({} as never, { enabled: true, allowCloud: false, scope: "files" })
    ).rejects.toThrow("No room is open.");
  });

  it("room_server_status needs no open room", async () => {
    const ipc = fakeIpcMain();
    const slot: RoomServerSlot = { bridge: null };
    registerMoonshotServerIpc(ipc as never, { currentRoom: () => null }, slot);
    const handler = ipc.handlers.get("room_server_status")!;
    await expect(handler({} as never)).resolves.toEqual({
      running: false,
      url: "",
      config: "",
      scope: "files",
      stable: false,
      allowCloud: false,
    });
  });

  it("regenerates a token for the current room through injected bridge dependencies", async () => {
    const ipc = fakeIpcMain();
    const room = freshRoom();
    const old = fakeBridge({ kind: "ExternalAgent" }, { token: "old-token" });
    const fresh = fakeBridge({ kind: "ExternalAgent" }, { token: "fresh-token" });
    const slot: RoomServerSlot = { bridge: old };
    const deps: SetRoomServerDeps = {
      startBridge: vi.fn(async () => fresh),
      writeDiscovery: vi.fn(),
      removeDiscovery: vi.fn(),
    };
    setSetting(room.db, "room_server_enabled", "1");
    setSetting(room.db, "room_server_scope", "full");
    registerMoonshotServerIpc(ipc as never, roomSourceFrom(room), slot, deps);

    await expect(ipc.handlers.get("regenerate_leash_token")!({} as never)).resolves.toEqual(
      expect.objectContaining({ running: true }),
    );
    expect(old.stopAndWait).toHaveBeenCalledOnce();
    expect(deps.startBridge).toHaveBeenCalledOnce();
    expect(slot.bridge).toBe(fresh);
  });
});

// ============================================================================
// ADVERSARIAL — the files tier must never leave a bearer token on disk, and
// the discovery seam it drives must be the SHARED one.
// ============================================================================

describe("setRoomServer — adversarial, against the REAL discovery seam", () => {
  it("switching a full-tier Leash down to the files tier deletes the leftover leash.json", async () => {
    // Rust: `if matches!(bscope, ToolScope::ExternalAgent) { write_discovery(...) }
    // else { remove_discovery(...) }`. The files-tier UI promises the token
    // reaches an agent by PASTE only, so a full-tier record left behind by an
    // earlier session is a live 0600 bearer token for a server that is now
    // running at a different tier with a different token.
    //
    // Driven through the real `writeDiscovery`/`removeDiscovery` (the shared
    // `moonshotDiscovery.ts` implementation, pointed at a temp home) rather
    // than `vi.fn()` doubles, precisely because the defect this pins was that
    // this file used to own a SECOND copy of them: the mocked tests all still
    // passed while write and remove could resolve two different paths.
    const homeDir = freshDir("moonshot-home-real-");
    const filePath = discoveryFilePath(homeDir);
    const room = freshRoom();
    const slot: RoomServerSlot = { bridge: null };

    // A previous full-tier session's record.
    writeDiscovery(LEASH_DEFAULT_PORT, "old-full-token", "full", "Test Room", homeDir);
    expect(readFileSync(filePath, "utf8")).toContain("old-full-token");

    const started = fakeBridge({ kind: "CloudAdvisor", includeMcp: false }, { token: "fresh-files-token" });
    await setRoomServer(
      room.db,
      room.path,
      room.name,
      { enabled: true, allowCloud: false, scope: "files" },
      slot,
      { currentRoom: () => room },
      {
        startBridge: async () => started,
        writeDiscovery: (p, t, s, r) => writeDiscovery(p, t, s, r, homeDir),
        removeDiscovery: () => removeDiscovery(homeDir),
      }
    );

    expect(() => statSync(filePath)).toThrow();
    expect(getSetting(room.db, "room_server_scope")).toBe("files");
  });

  it("turning the Leash OFF removes the record and needs no bridge starter at all", async () => {
    // The one path that is fully real today even with the honest
    // `startRoomBridgeNotImplemented` default: stopping never needed a
    // dispatcher.
    const homeDir = freshDir("moonshot-home-off-");
    const filePath = discoveryFilePath(homeDir);
    const room = freshRoom();
    const running = fakeBridge({ kind: "ExternalAgent" });
    const slot: RoomServerSlot = { bridge: running };
    writeDiscovery(LEASH_DEFAULT_PORT, "old-full-token", "full", "Test Room", homeDir);

    const status = await setRoomServer(
      room.db,
      room.path,
      room.name,
      { enabled: false, allowCloud: false, scope: "full" },
      slot,
      { currentRoom: () => room },
      {
        startBridge: startRoomBridgeNotImplemented,
        writeDiscovery: (p, t, s, r) => writeDiscovery(p, t, s, r, homeDir),
        removeDiscovery: () => removeDiscovery(homeDir),
      }
    );

    expect(running.stop).toHaveBeenCalledOnce();
    expect(slot.bridge).toBeNull();
    expect(() => statSync(filePath)).toThrow();
    expect(getSetting(room.db, "room_server_enabled")).toBe("0");
    expect(status.running).toBe(false);
  });
});
