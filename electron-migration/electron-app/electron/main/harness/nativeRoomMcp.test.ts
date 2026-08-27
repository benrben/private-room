import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolDispatcher, ToolScope, ToolSpec } from "../mcpBridge.js";
import type { RoomManagerState } from "../roomManager.js";
import { createWorkspaceRoom } from "../workspace/roomLayout.js";
import { WorkspaceService } from "../workspace/workspaceService.js";
import { claudeRoomMcpConfiguration } from "./claudeAgentSdk.js";
import { codexRoomMcpConfiguration } from "./codexAppServer.js";
import { RunProtection } from "./runProtection.js";
import {
  createNativeRoomMcpFactory,
  NATIVE_ROOM_MCP_TOKEN_ENV,
  type NativeRoomMcpExposure,
} from "./nativeRoomMcp.js";
import type { HarnessContext } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function context(root: string, overrides: Partial<HarnessContext> = {}): HarnessContext {
  return {
    runId: "run-1",
    roomId: "room-1",
    provider: "claude",
    model: "test",
    privacyMode: "cloud-direct",
    workspacePath: root,
    runtimePath: path.join(root, "runtime"),
    writeEnabled: true,
    exposureVerified: true,
    ...overrides,
  };
}

function stateWith(
  rootPath: string,
  row: { baseline_completed: number; status: string; write_enabled: number } | undefined,
): RoomManagerState {
  return {
    room: {
      descriptor: { kind: "workspace-folder", roomId: "room-1", rootPath },
      workspace: {},
      conn: { prepare: vi.fn(() => ({ get: vi.fn(() => row) })) },
    },
  } as unknown as RoomManagerState;
}

const REGISTERED_TOOL: ToolSpec = {
  name: "organize_files",
  description: "Organize registered room files.",
  inputSchema: { type: "object", properties: {} },
};

function dispatcher(): ToolDispatcher {
  return {
    listTools: (_scope: ToolScope) => [REGISTERED_TOOL],
    callTool: async () => ({ isError: false, content: [{ type: "text", text: "ok" }] }),
  };
}

describe("native Room MCP exposure", () => {
  it("refuses write tools before the exact run baseline is complete", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-native-mcp-baseline-"));
    roots.push(root);
    const factory = createNativeRoomMcpFactory(
      stateWith(root, { baseline_completed: 0, status: "preparing", write_enabled: 1 }),
      () => dispatcher(),
    );
    await expect(factory(context(root))).rejects.toThrow(/baseline is complete/i);
  });

  it("binds Cloud Privacy file operations to the redacted mirror backend", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-native-mcp-mirror-"));
    roots.push(root);
    const real = path.join(root, "real");
    const mirror = path.join(root, "mirror");
    await mkdir(real);
    await mkdir(mirror);
    let backend: Parameters<Parameters<typeof createNativeRoomMcpFactory>[1]>[1] | undefined;
    const factory = createNativeRoomMcpFactory(
      stateWith(real, { baseline_completed: 1, status: "running", write_enabled: 1 }),
      (_context, workspace) => {
        backend = workspace;
        return dispatcher();
      },
    );
    const exposure = await factory(context(mirror, { privacyMode: "cloud-redacted" }));
    try {
      await backend!.call("write", { path: "Organized/notes.txt", content: "mirror only" });
      expect(await readFile(path.join(mirror, "Organized", "notes.txt"), "utf8")).toBe("mirror only");
      await expect(readFile(path.join(real, "Organized", "notes.txt"), "utf8")).rejects.toThrow();
    } finally {
      await exposure.stop();
    }
  });

  it("lets Cloud Privacy organize real binaries through metadata-only standard tools", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-native-mcp-binary-"));
    roots.push(root);
    const real = path.join(root, "real");
    const mirror = path.join(root, "mirror");
    const created = createWorkspaceRoom(real, "password", "Room");
    await mkdir(mirror);
    const workspace = new WorkspaceService(created.db, real);
    await workspace.createFile("private.pdf", Readable.from([Buffer.from("secret pdf bytes")]), "import");
    await workspace.createFile("photo.png", Readable.from([Buffer.from("secret pixels")]), "import");
    const sketch = await workspace.createFile("design.sketch", Readable.from([Buffer.from("secret sketch")]), "import");
    const state = {
      room: {
        conn: created.db,
        path: real,
        name: "Room",
        password: "password",
        descriptor: created.descriptor,
        workspace,
      },
    } as unknown as RoomManagerState;
    const runContext = context(mirror, {
      roomId: created.descriptor.roomId,
      privacyMode: "cloud-redacted",
    });
    const protection = new RunProtection(workspace, created.descriptor.roomId);
    await protection.createBaseline(runContext);
    let backend: Parameters<Parameters<typeof createNativeRoomMcpFactory>[1]>[1] | undefined;
    const factory = createNativeRoomMcpFactory(state, (_context, selected) => {
      backend = selected;
      return dispatcher();
    });
    const exposure = await factory(runContext);
    try {
      await backend!.call("write", { path: "redacted.txt", content: "mirror bytes" });
      expect(await readFile(path.join(mirror, "redacted.txt"), "utf8")).toBe("mirror bytes");
      await expect(readFile(path.join(real, "redacted.txt"), "utf8")).rejects.toThrow();

      const renamed = await backend!.call("standard_rename", {
        name: "private.pdf", new_name: "final.pdf",
      });
      const moved = await backend!.call("standard_move", {
        name: "photo.png", folder: "Media",
      });
      const trashed = await backend!.call("standard_trash", { names: ["design.sketch"] });
      expect(renamed).toEqual({ old_path: "/private.pdf", path: "/final.pdf" });
      expect(moved).toEqual({ old_path: "/photo.png", path: "/Media/photo.png" });
      expect(trashed).toEqual({ trashed: ["/design.sketch"] });
      expect(await readFile(path.join(real, "final.pdf"), "utf8")).toBe("secret pdf bytes");
      expect(await readFile(path.join(real, "Media", "photo.png"), "utf8")).toBe("secret pixels");
      await expect(lstat(path.join(real, "design.sketch"))).rejects.toThrow();
      expect(created.db.prepare("SELECT trashed_at FROM files WHERE id = ?").get(sketch.fileId))
        .toMatchObject({ trashed_at: expect.any(String) });
      expect(JSON.stringify([renamed, moved, trashed])).not.toContain("secret");

      await protection.finish("run-1", "completed");
      const rollback = await protection.rollback("run-1");
      expect(rollback.conflicts).toEqual([]);
      expect(await readFile(path.join(real, "private.pdf"), "utf8")).toBe("secret pdf bytes");
      expect(await readFile(path.join(real, "photo.png"), "utf8")).toBe("secret pixels");
      expect(await readFile(path.join(real, "design.sketch"), "utf8")).toBe("secret sketch");
    } finally {
      await exposure.stop();
      created.db.close();
    }
  });

  it("serves only the registered catalog over authenticated loopback and revokes it on stop", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-native-mcp-wire-"));
    roots.push(root);
    const factory = createNativeRoomMcpFactory(
      stateWith(root, { baseline_completed: 1, status: "running", write_enabled: 0 }),
      () => dispatcher(),
    );
    const exposure = await factory(context(root, { writeEnabled: false }));
    const denied = await fetch(exposure.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(denied.status).toBe(401);
    const listed = await fetch(exposure.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${exposure.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    const payload = await listed.json() as { result: { tools: ToolSpec[] } };
    expect(payload.result.tools.map((tool) => tool.name)).toEqual(["organize_files"]);
    await exposure.stop();
    await expect(fetch(exposure.url)).rejects.toThrow();
  });
});

describe("native provider Room MCP configuration", () => {
  const exposure = {
    url: "http://127.0.0.1:4321/mcp",
    token: "private-run-token",
    instructions: "Use the registered room catalog.",
    stop: async () => undefined,
  } satisfies NativeRoomMcpExposure;

  it("gives Claude one strict HTTP server with its per-run bearer", () => {
    expect(claudeRoomMcpConfiguration(exposure)).toEqual({
      type: "http",
      url: exposure.url,
      headers: { Authorization: "Bearer private-run-token" },
      alwaysLoad: true,
    });
  });

  it("gives Codex a token environment reference without putting the token in thread config", () => {
    const config = codexRoomMcpConfiguration(exposure);
    expect(config).toEqual({
      mcp_servers: {
        room: {
          url: exposure.url,
          bearer_token_env_var: NATIVE_ROOM_MCP_TOKEN_ENV,
          default_tools_approval_mode: "approve",
        },
      },
    });
    expect(JSON.stringify(config)).not.toContain(exposure.token);
  });
});
