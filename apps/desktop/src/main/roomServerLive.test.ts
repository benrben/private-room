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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  chatTurnBridgeRunOptions,
  chatTurnWorkspaceWriteEnabled,
  noToolsDispatcher,
} from "./chatTurnSurfaceIpc.js";
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
  roomServerDispatcherFactory,
  spawnRoomServerIfEnabledCore,
  type SpawnRoomServerResult,
} from "./roomServerLive.js";
import { createWorkspaceRoom } from "./workspace/roomLayout.js";
import { WorkspaceService } from "./workspace/workspaceService.js";
import { WEB_LANES_ALL } from "./toolSpecs.js";
import { createToolEffects } from "./execTool.js";

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

function fixtureWorkspaceRoom(
  dir: string,
  readOnly = false,
): { state: RoomManagerState; room: Room; root: string } {
  const root = path.join(dir, `workspace-${randomUUID()}`);
  const created = createWorkspaceRoom(root, PASSWORD, "Workspace Room");
  strayConns.push(created.db);
  const state = createRoomManagerState();
  const room: Room = {
    conn: created.db,
    path: root,
    name: "Workspace Room",
    password: PASSWORD,
    descriptor: created.descriptor,
    workspace: new WorkspaceService(created.db, root),
    ...(readOnly ? { readOnly: true } : {}),
  };
  state.room = room;
  return { state, room, root };
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

describe("main Assistant workspace write grant", () => {
  const localScope = { kind: "LocalEngine" as const };

  it("gives only the short-lived writable chat bridge controlled normal-file writes", async () => {
    const dir = freshDir();
    const { state, room, root } = fixtureWorkspaceRoom(dir);
    const factory = roomServerDispatcherFactory(state, vi.fn());

    expect(chatTurnWorkspaceWriteEnabled(room)).toBe(true);

    // The long-lived/default Room server remains read-only: it has no owning
    // chat turn, provider approval, or harness rollback boundary.
    const persistent = factory(false, localScope, WEB_LANES_ALL);
    const refused = await persistent.callTool(localScope, "workspace_write", {
      path: "persistent.txt",
      content: "must not be written\n",
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]).toEqual({ type: "text", text: '{"error":"This workspace bridge is read-only."}' });
    expect(existsSync(path.join(root, "persistent.txt"))).toBe(false);

    // registerChatTurnSurfaceIpc opts into this exact grant for one ask. The
    // bridge still delegates path validation, atomic writes and indexing
    // metadata to WorkspaceService.
    const chat = factory(false, localScope, WEB_LANES_ALL, { workspaceWriteEnabled: true });
    const written = await chat.callTool(localScope, "workspace_write", {
      path: "Organized/assistant.txt",
      content: "assistant write\n",
    });
    expect(written.isError).not.toBe(true);
    expect(readFileSync(path.join(root, "Organized", "assistant.txt"), "utf8")).toBe("assistant write\n");
  });

  it("shares the owning turn's pixel sink with drawing tools", async () => {
    const dir = freshDir();
    const { state } = fixtureRoom(dir);
    const effects = createToolEffects();
    effects.visionChat = true;
    const dispatcher = roomServerDispatcherFactory(state, vi.fn())(
      false,
      localScope,
      WEB_LANES_ALL,
      { sharedEffects: effects, workspaceWriteEnabled: true },
    );

    const drawn = await dispatcher.callTool(localScope, "draw", {
      name: "Pixel proof",
      script: 'rect 0 0 1600 1000 blue "Blue page"',
    });
    expect(drawn.isError, JSON.stringify(drawn)).not.toBe(true);
    const looked = await dispatcher.callTool(localScope, "read_drawing", { name: "Pixel proof" });
    expect(looked.isError).not.toBe(true);
    expect(looked.content.some((item) => item.type === "image")).toBe(true);
    expect(effects.pendingImages).toEqual([]);
  });

  it("cannot grant writes to a read-only room and exposes no workspace backend for sealed or locked rooms", async () => {
    const dir = freshDir();
    const readOnly = fixtureWorkspaceRoom(dir, true);
    expect(chatTurnWorkspaceWriteEnabled(readOnly.room)).toBe(false);
    const readOnlyDispatcher = roomServerDispatcherFactory(readOnly.state, vi.fn())(
      false,
      localScope,
      WEB_LANES_ALL,
      { workspaceWriteEnabled: true },
    );
    const refused = await readOnlyDispatcher.callTool(localScope, "workspace_write", {
      path: "forbidden.txt",
      content: "no\n",
    });
    expect(refused.isError).toBe(true);
    expect(existsSync(path.join(readOnly.root, "forbidden.txt"))).toBe(false);

    const sealed = fixtureRoom(dir);
    expect(chatTurnWorkspaceWriteEnabled(sealed.room)).toBe(false);
    const sealedDispatcher = roomServerDispatcherFactory(sealed.state, vi.fn())(
      false,
      localScope,
      WEB_LANES_ALL,
      { workspaceWriteEnabled: true },
    );
    expect(sealedDispatcher.listTools(localScope).some((tool) => tool.name.startsWith("workspace_"))).toBe(false);

    sealed.state.room = null;
    const lockedDispatcher = roomServerDispatcherFactory(sealed.state, vi.fn())(
      false,
      localScope,
      WEB_LANES_ALL,
      { workspaceWriteEnabled: true },
    );
    expect(lockedDispatcher.listTools(localScope).some((tool) => tool.name.startsWith("workspace_"))).toBe(false);
  });

  it("carries an approved one-turn privacy bypass into the same chat file-tool bridge", async () => {
    const dir = freshDir();
    const { state, room } = fixtureWorkspaceRoom(dir);
    const factory = roomServerDispatcherFactory(state, vi.fn());
    const cloudScope = { kind: "CloudEngine" as const };

    const writer = factory(false, localScope, WEB_LANES_ALL, { workspaceWriteEnabled: true });
    await writer.callTool(localScope, "workspace_write", {
      path: "notes.txt",
      content: "Secret Squirrel owns this note.\n",
    });
    setPolicyRulesForTests(true, [["Secret Squirrel", "[Person A]"]]);

    expect(chatTurnBridgeRunOptions(room, false)).toEqual({
      workspaceWriteEnabled: true,
      privacyBypass: false,
    });
    expect(chatTurnBridgeRunOptions(room, true)).toEqual({
      workspaceWriteEnabled: true,
      privacyBypass: true,
    });

    const protectedTurn = factory(
      false,
      cloudScope,
      WEB_LANES_ALL,
      chatTurnBridgeRunOptions(room, false),
    );
    const protectedRead = await protectedTurn.callTool(cloudScope, "workspace_read", { path: "notes.txt" });
    const protectedText = (protectedRead.content[0] as { text: string }).text;
    expect(protectedText).toContain("[Person A]");
    expect(protectedText).not.toContain("Secret Squirrel");

    const approvedTurn = factory(
      false,
      cloudScope,
      WEB_LANES_ALL,
      chatTurnBridgeRunOptions(room, true),
    );
    const approvedRead = await approvedTurn.callTool(cloudScope, "workspace_read", { path: "notes.txt" });
    const approvedText = (approvedRead.content[0] as { text: string }).text;
    expect(approvedText).toContain("Secret Squirrel");
    expect(approvedText).not.toContain("[Person A]");
  });

  it("the hard turn dispatcher exposes zero tools and rejects guessed calls", async () => {
    const dispatcher = noToolsDispatcher();
    expect(dispatcher.listTools(localScope)).toEqual([]);
    await expect(dispatcher.callTool(localScope, "workspace_read", { path: "secret.txt" }))
      .resolves.toEqual({
        isError: true,
        content: [{ type: "text", text: "Tools are disabled for this turn." }],
      });
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
