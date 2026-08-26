/**
 * Production room-server lifecycle tests.
 *
 * Every test here binds a REAL loopback HTTP server (`mcpBridge.ts`'s
 * `McpBridge`, via `moonshotServer.ts`'s `createRoomBridge`) and talks to it
 * with a real `fetch` — no fake dispatcher, no fake bridge, no spy standing
 * in for "the server is running". `spawnRoomServerIfEnabledCore` is driven
 * directly for the fine-grained cases (disabled / already-running /
 * redaction), and the room-open/close/switch cases are driven through the
 * REAL, unchanged `roomManager.ts` lifecycle via `registry.ts`'s
 * `createLiveRoomManagerDeps`, exactly as production wires it.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoom as dbCreateRoom } from "./db-host/open.js";
import { insertFile } from "./db-host/files.js";
import { setSetting } from "./db-host/settings.js";
import { clearPolicy, setPolicyRulesForTests } from "./privacy.js";
import { discoveryFile } from "./moonshotDiscovery.js";
import { createLiveRoomManagerDeps } from "./ipc/registry.js";
import {
  closeRoom,
  createRoom,
  createRoomManagerState,
  openRoom,
  type Room,
  type RoomManagerState,
} from "./roomManager.js";
import {
  createRoomServerDeps,
  spawnRoomServerIfEnabledCore,
  type SpawnRoomServerResult,
} from "./roomServerLive.js";

const PASSWORD = "correct horse battery staple";

let tmpDirs: string[] = [];
let strayConns: { close(): void }[] = [];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const conn of strayConns) {
    try {
      conn.close();
    } catch {
      // already closed
    }
  }
  strayConns = [];
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
  clearPolicy();
  vi.restoreAllMocks();
});

function freshDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "room-server-live-a-"));
  tmpDirs.push(dir);
  return dir;
}

/** A real fixture room, opened, with a `RoomManagerState` pointed at it —
 * this file's own equivalent of `roomManager.test.ts`'s `roomWithReader`. */
function fixtureRoom(dir: string): { state: RoomManagerState; room: Room } {
  const roomPath = path.join(dir, `room-${randomUUID()}.roomai`);
  const conn = dbCreateRoom(roomPath, PASSWORD, "Leash Room");
  strayConns.push(conn);
  const state = createRoomManagerState();
  const room: Room = { conn, path: roomPath, name: "Leash Room", password: PASSWORD };
  state.room = room;
  return { state, room };
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>
): Promise<{ status: number; json: any }> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  return { status: resp.status, json: text === "" ? null : JSON.parse(text) };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("waitFor: condition never became true within " + timeoutMs + "ms");
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** Poll a URL until it genuinely refuses connections (ECONNREFUSED) — proof
 * the underlying `http.Server` actually released the port, not just that
 * `stop()` was called. */
async function waitUntilRefused(url: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    } catch {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("port never refused connections within " + timeoutMs + "ms");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function started(result: SpawnRoomServerResult): Extract<SpawnRoomServerResult, { kind: "started" }> {
  if (result.kind !== "started") {
    throw new Error(`expected "started", got ${JSON.stringify(result)}`);
  }
  return result;
}

describe("spawnRoomServerIfEnabledCore — disabled / never-double-start", () => {
  it("is a no-op when room_server_enabled is unset", async () => {
    const dir = freshDir();
    const { state, room } = fixtureRoom(dir);
    const deps = createRoomServerDeps(state, vi.fn(), {
      serverVersion: "test",
      discoveryHome: path.join(dir, "home"),
    });
    const result = await spawnRoomServerIfEnabledCore(state, room, deps);
    expect(result).toEqual({ kind: "disabled" });
    expect(state.roomServer).toBeNull();
  });

  it("never double-starts a second bridge for the same room", async () => {
    const dir = freshDir();
    const { state, room } = fixtureRoom(dir);
    setSetting(room.conn, "room_server_enabled", "1");
    const deps = createRoomServerDeps(state, vi.fn(), {
      serverVersion: "test",
      discoveryHome: path.join(dir, "home"),
    });

    const first = started(await spawnRoomServerIfEnabledCore(state, room, deps));
    const second = await spawnRoomServerIfEnabledCore(state, room, deps);

    expect(second).toEqual({ kind: "already-running" });
    expect(state.roomServer).toBe(first.bridge as unknown as typeof state.roomServer);

    first.bridge.stop();
  });
});

describe("spawnRoomServerIfEnabledCore — a real HTTP MCP server, end to end", () => {
  it("serves a real catalog and dispatches a real tool call, over a real bound port", async () => {
    const dir = freshDir();
    const { state, room } = fixtureRoom(dir);
    setSetting(room.conn, "room_server_enabled", "1");
    const deps = createRoomServerDeps(state, vi.fn(), {
      serverVersion: "9.9.9-test",
      discoveryHome: path.join(dir, "home"),
    });

    const result = started(await spawnRoomServerIfEnabledCore(state, room, deps));
    const { bridge } = result;
    const url = `http://127.0.0.1:${bridge.port}/mcp`;

    // A wrong/missing bearer token gets refused, exactly like the real
    // McpBridge does for every other caller.
    expect((await postJson(url, { jsonrpc: "2.0", id: 1, method: "ping" }, {})).status).toBe(401);

    const list = await postJson(url, { jsonrpc: "2.0", id: 1, method: "tools/list" }, bearer(bridge.token));
    expect(list.status).toBe(200);
    const names: string[] = list.json.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("list_room_files");

    const call = await postJson(
      url,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_room_files", arguments: {} } },
      bearer(bridge.token)
    );
    expect(call.status).toBe(200);
    expect(call.json.result).toEqual({
      isError: false,
      content: [{ type: "text", text: "The room has no files." }],
    });

    bridge.stop();
  });

  it("redacts real values out of a real tool result when a privacy policy is active", async () => {
    const dir = freshDir();
    const { state, room } = fixtureRoom(dir);
    setSetting(room.conn, "room_server_enabled", "1");
    insertFile(room.conn, "Secret Squirrel.txt", "text/plain", new TextEncoder().encode("hello"), "hello", "import");
    setPolicyRulesForTests(true, [["Secret Squirrel", "[Person A]"]]);

    const deps = createRoomServerDeps(state, vi.fn(), {
      serverVersion: "test",
      discoveryHome: path.join(dir, "home"),
    });
    const { bridge } = started(await spawnRoomServerIfEnabledCore(state, room, deps));
    const url = `http://127.0.0.1:${bridge.port}/mcp`;

    const call = await postJson(
      url,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_room_files", arguments: {} } },
      bearer(bridge.token)
    );
    const text: string = call.json.result.content[0].text;
    expect(text).toContain("[Person A]");
    expect(text).not.toContain("Secret Squirrel");

    bridge.stop();
  });
});

describe("createLiveRoomManagerDeps — start/stop/restart-on-room-switch, through the real room lifecycle", () => {
  it("starts on room open, actually stops the listener on room close, and cleans up discovery", async () => {
    // Two close+reopen cycles each pay real SQLCipher PBKDF2 key-derivation
    // cost — the default 5s vitest budget is too tight under load.
    const dir = freshDir();
    const home = path.join(dir, "home");
    const roomPath = path.join(dir, `room-${randomUUID()}.roomai`);
    const state = createRoomManagerState();
    const deps = createLiveRoomManagerDeps(state, dir, vi.fn(), { serverVersion: "test", discoveryHome: home });

    createRoom(state, deps, roomPath, PASSWORD, "Full Tier");
    setSetting(state.room!.conn, "room_server_enabled", "1");
    setSetting(state.room!.conn, "room_server_scope", "full");
    // The toggle above was written AFTER the room's own open-time spawn
    // already ran (and found it off) — close and reopen so the real "restart
    // on unlock" path picks up the now-enabled full tier, exactly like a real
    // Settings change followed by a relock/unlock would.
    await closeRoom(state, deps);
    openRoom(state, deps, roomPath, PASSWORD);

    await waitFor(() => state.roomServer !== null);
    const bridge = state.roomServer as unknown as { port: number; token: string };
    const url = `http://127.0.0.1:${bridge.port}/mcp`;
    expect((await postJson(url, { jsonrpc: "2.0", id: 1, method: "ping" }, bearer(bridge.token))).status).toBe(200);
    // Full tier: the discovery file is written for real. `LeashRecord` has no
    // `port` field of its own — the port lives inside `url`.
    await waitFor(() => {
      try {
        const record = JSON.parse(readFileSync(discoveryFile(home), "utf8"));
        return record.url === url && record.token === bridge.token;
      } catch {
        return false;
      }
    });

    await closeRoom(state, deps);

    expect(state.roomServer).toBeNull();
    await waitUntilRefused(url);
    expect(() => readFileSync(discoveryFile(home), "utf8")).toThrow();
  }, 20000);

  it("restarts with a fresh bridge when the open room switches, and the old port stops serving", async () => {
    const dir = freshDir();
    const home = path.join(dir, "home");
    const roomAPath = path.join(dir, `room-a-${randomUUID()}.roomai`);
    const roomBPath = path.join(dir, `room-b-${randomUUID()}.roomai`);
    const state = createRoomManagerState();
    const deps = createLiveRoomManagerDeps(state, dir, vi.fn(), { serverVersion: "test", discoveryHome: home });

    createRoom(state, deps, roomAPath, PASSWORD, "Room A");
    setSetting(state.room!.conn, "room_server_enabled", "1");
    await closeRoom(state, deps);
    openRoom(state, deps, roomAPath, PASSWORD);
    await waitFor(() => state.roomServer !== null);
    const bridgeA = state.roomServer as unknown as { port: number; token: string };
    const urlA = `http://127.0.0.1:${bridgeA.port}/mcp`;
    expect((await postJson(urlA, { jsonrpc: "2.0", id: 1, method: "ping" }, bearer(bridgeA.token))).status).toBe(
      200
    );

    // Switch rooms: createRoom tears A down (stopping its bridge) BEFORE
    // opening B — the same order every other lifecycle write in
    // `roomManager.ts` depends on.
    createRoom(state, deps, roomBPath, PASSWORD, "Room B");
    setSetting(state.room!.conn, "room_server_enabled", "1");
    await closeRoom(state, deps);
    openRoom(state, deps, roomBPath, PASSWORD);
    await waitFor(() => state.roomServer !== null && (state.roomServer as unknown as { port: number }).port !== bridgeA.port);
    const bridgeB = state.roomServer as unknown as { port: number; token: string };

    expect(bridgeB.token).not.toBe(bridgeA.token);
    await waitUntilRefused(urlA);
    const urlB = `http://127.0.0.1:${bridgeB.port}/mcp`;
    expect((await postJson(urlB, { jsonrpc: "2.0", id: 1, method: "ping" }, bearer(bridgeB.token))).status).toBe(
      200
    );

    await closeRoom(state, deps);
  }, 20000);
});
