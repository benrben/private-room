import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createRoomManagerState } from "../roomManager.js";
import { createWorkspaceRoom } from "../workspace/roomLayout.js";
import { WorkspaceService } from "../workspace/workspaceService.js";
import { RunProtection } from "./runProtection.js";
import type { NativeWorkspaceSandbox } from "./seatbelt.js";
import {
  AsyncWriteGate,
  createCloudPrivacyWorkspaceBackend,
  createMirrorWorkspaceBackend,
  RestrictedLegacyCliRuntime,
  RuntimeWithFallback,
  WorkspaceDispatcher,
} from "./legacyCli.js";
import type { ToolDispatcher } from "../mcpBridge.js";
import type { HarnessContext, HarnessRun, HarnessRuntime } from "./types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function fakeChild(stdoutText: string): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 12345, kill: () => true });
  queueMicrotask(() => {
    stdout.end(stdoutText);
    stderr.end();
    child.emit("exit", 0, null);
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}

function failedChild(stderrText: string, code = 1): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 12346, kill: () => true });
  queueMicrotask(() => {
    stdout.end();
    stderr.end(stderrText);
    child.emit("exit", code, null);
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}

function controllableChild(onKill?: () => void): { child: ChildProcessWithoutNullStreams; stdout: PassThrough; stderr: PassThrough } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 2_000_001,
    kill: (signal: NodeJS.Signals = "SIGTERM") => {
      onKill?.();
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    },
  });
  return { child: child as unknown as ChildProcessWithoutNullStreams, stdout, stderr };
}

function codexAnswer(text: string): string {
  return `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2, output_tokens: 1 } })}\n`;
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-legacy-harness-"));
  roots.push(root);
  const roomPath = path.join(root, "Room");
  const created = createWorkspaceRoom(roomPath, "password", "Room");
  const workspace = new WorkspaceService(created.db, roomPath);
  const state = createRoomManagerState();
  state.room = {
    conn: created.db,
    path: roomPath,
    name: "Room",
    password: "password",
    descriptor: created.descriptor,
    workspace,
  };
  return { root, roomPath, created, state };
}

describe("RestrictedLegacyCliRuntime", () => {
  it("runs Codex in an isolated empty directory with read-only/MCP-only flags", async () => {
    const f = await fixture();
    let sandbox: NativeWorkspaceSandbox | null = null;
    let args: string[] = [];
    try {
      const runtime = new RestrictedLegacyCliRuntime("codex", f.state, {
        executable: "/fake/codex",
        available: () => true,
        spawn: (options, captured) => {
          sandbox = options;
          args = captured;
          return fakeChild('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":1}}\n');
        },
      });
      const context: HarnessContext = {
        runId: "run-1", roomId: createdRoomId(f.created.descriptor.roomId), provider: "codex", model: "gpt-test",
        workspacePath: f.roomPath, runtimePath: path.join(f.root, "runtime"), privacyMode: "cloud-direct",
        writeEnabled: true, exposureVerified: true,
      };
      const run = await runtime.startTurn(context, { text: "work" });
      const events = [];
      for await (const event of run.events) events.push(event);
      expect(sandbox).not.toBeNull();
      expect(path.resolve(sandbox!.workspacePath)).not.toBe(path.resolve(f.roomPath));
      expect(sandbox!.writeEnabled).toBe(false);
      expect(args).toContain("read-only");
      expect(args).toContain("shell_tool");
      expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "gpt-test"]);
      expect(args.join(" ")).toContain("mcp_servers.room.url");
      const bearerToken = sandbox!.env?.ARCELLE_ROOM_MCP_TOKEN;
      expect(bearerToken).toMatch(/^[0-9a-f-]{36}$/i);
      expect(args.join("\0")).not.toContain(bearerToken!);
      expect(events).toContainEqual({ type: "text_delta", runId: "run-1", text: "done" });
      expect(events.at(-1)).toEqual({ type: "run_completed", runId: "run-1", status: "completed" });
    } finally {
      f.created.db.close();
    }
  });

  it.each(["codex", "claude"] as const)(
    "omits the default model alias for the restricted %s fallback",
    async (provider) => {
      const f = await fixture();
      let args: string[] = [];
      try {
        const runtime = new RestrictedLegacyCliRuntime(provider, f.state, {
          executable: `/fake/${provider}`,
          available: () => true,
          spawn: (_options, captured) => {
            args = captured;
            return fakeChild(provider === "codex"
              ? codexAnswer("done")
              : `${JSON.stringify({ type: "result", subtype: "success", result: "done" })}\n`);
          },
        });
        const run = await runtime.startTurn({
          runId: `run-default-${provider}`,
          roomId: createdRoomId(f.created.descriptor.roomId),
          provider,
          model: " Default ",
          workspacePath: f.roomPath,
          runtimePath: path.join(f.root, `runtime-default-${provider}`),
          privacyMode: "cloud-direct",
          writeEnabled: false,
          exposureVerified: true,
        }, { text: "work" });
        for await (const _event of run.events) { /* drain */ }
        expect(args).not.toContain("--model");
      } finally {
        f.created.db.close();
      }
    },
  );

  it("never forwards raw CLI stderr into normalized failure events", async () => {
    const f = await fixture();
    const secret = "Ben Reich token=secret-token /Users/benreich/private-room";
    try {
      const runtime = new RestrictedLegacyCliRuntime("codex", f.state, {
        executable: "/fake/codex",
        available: () => true,
        spawn: () => failedChild(secret, 7),
      });
      const run = await runtime.startTurn({
        runId: "run-safe-error", roomId: f.created.descriptor.roomId, provider: "codex", model: "gpt-test",
        workspacePath: f.roomPath, runtimePath: path.join(f.root, "runtime-error"), privacyMode: "cloud-direct",
        writeEnabled: false, exposureVerified: true,
      }, { text: "work" });
      const events = [];
      for await (const event of run.events) events.push(event);
      const failure = events.find((event) => event.type === "run_failed");
      expect(failure).toMatchObject({ type: "run_failed", runId: "run-safe-error" });
      expect(JSON.stringify(failure)).not.toContain(secret);
      expect(JSON.stringify(failure)).not.toContain("secret-token");
      expect(JSON.stringify(failure)).not.toContain("/Users/benreich");
      expect(JSON.stringify(failure)).toContain("exit 7");
    } finally {
      f.created.db.close();
    }
  });

  it("exposes arcelle_delegate as a normalized child run with inherited context", async () => {
    const f = await fixture();
    let spawned = 0;
    try {
      const mirror = path.join(f.root, "redacted-mirror");
      await mkdir(mirror);
      const parentContext: HarnessContext = {
        runId: "parent", roomId: f.created.descriptor.roomId, provider: "codex", model: "gpt-test",
        workspacePath: mirror, runtimePath: path.join(f.root, "runtime-delegate"), privacyMode: "cloud-redacted",
        writeEnabled: true, exposureVerified: true,
      };
      await new RunProtection(f.state.room!.workspace!, f.created.descriptor.roomId)
        .createBaseline(parentContext);
      const runtime = new RestrictedLegacyCliRuntime("codex", f.state, {
        executable: "/fake/codex",
        available: () => true,
        spawn: (options, args) => {
          spawned += 1;
          if (spawned === 2) return fakeChild(codexAnswer("specialist answer"));
          const process = controllableChild();
          queueMicrotask(() => {
            void (async () => {
              const urlFlag = args.find((arg) => arg.startsWith("mcp_servers.room.url="));
              const url = urlFlag?.match(/"(http[^"]+)"/)?.[1];
              if (url === undefined) throw new Error("missing test MCP URL");
              const response = await fetch(url, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${options.env?.ARCELLE_ROOM_MCP_TOKEN ?? ""}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "tools/call",
                  params: { name: "arcelle_delegate", arguments: { agent_id: "files.read", task: "organize this" } },
                }),
              });
              const body = await response.json() as { result?: { content?: Array<{ text?: string }> } };
              const delegated = body.result?.content?.[0]?.text ?? "missing";
              process.stdout.end(codexAnswer(`main received ${delegated}`));
              process.stderr.end();
              (process.child as unknown as EventEmitter).emit("exit", 0, null);
            })();
          });
          return process.child;
        },
      });
      const run = await runtime.startTurn(parentContext, { text: "delegate" });
      const events = [];
      for await (const event of run.events) events.push(event);
      expect(spawned).toBe(2);
      expect(events).toContainEqual({ type: "agent_started", runId: "parent", agentId: "files.read", label: "File agent" });
      expect(events).toContainEqual({ type: "text_delta", runId: "parent", text: "specialist answer", agentId: "files.read" });
      expect(events).toContainEqual({ type: "agent_completed", runId: "parent", agentId: "files.read" });
      expect(events.at(-1)).toEqual({ type: "run_completed", runId: "parent", status: "completed" });
      expect(f.created.db.prepare("SELECT run_id FROM agent_runs ORDER BY run_id").all())
        .toEqual([{ run_id: "parent" }]);
    } finally {
      f.created.db.close();
    }
  });

  it("serializes write leases while allowing work outside the gate to proceed", async () => {
    const gate = new AsyncWriteGate();
    const sequence: string[] = [];
    let releaseFirst!: () => void;
    const first = gate.run(async () => {
      sequence.push("first-start");
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      sequence.push("first-end");
    });
    const second = gate.run(async () => { sequence.push("second"); });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sequence).toEqual(["first-start"]);
    sequence.push("parallel-read");
    releaseFirst();
    await Promise.all([first, second]);
    expect(sequence).toEqual(["first-start", "parallel-read", "first-end", "second"]);
  });

  it("exposes exact move and rename contracts and serializes both mutations", async () => {
    const sequence: string[] = [];
    let releaseMove!: () => void;
    const dispatcher = new WorkspaceDispatcher({
      call: async (operation) => {
        sequence.push(`${operation}-start`);
        if (operation === "move") {
          await new Promise<void>((resolve) => { releaseMove = resolve; });
        }
        sequence.push(`${operation}-end`);
        return { operation };
      },
    }, new AsyncWriteGate());
    const scope = { kind: "CloudEngine" as const };
    const specs = dispatcher.listTools(scope);
    const move = specs.find((tool) => tool.name === "workspace_move")!;
    const rename = specs.find((tool) => tool.name === "workspace_rename")!;
    expect(move.inputSchema).toMatchObject({
      required: ["source_path", "destination_path"],
      additionalProperties: false,
    });
    expect(Object.keys(move.inputSchema.properties as Record<string, unknown>))
      .toEqual(["source_path", "destination_path"]);
    expect(rename.inputSchema).toMatchObject({
      required: ["source_path", "new_name"],
      additionalProperties: false,
    });
    expect(Object.keys(rename.inputSchema.properties as Record<string, unknown>))
      .toEqual(["source_path", "new_name"]);

    const moving = dispatcher.callTool(scope, "workspace_move", {
      source_path: "one.txt", destination_path: "Archive/one.txt",
    });
    const renaming = dispatcher.callTool(scope, "workspace_rename", {
      source_path: "two.txt", new_name: "renamed.txt",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sequence).toEqual(["move-start"]);
    releaseMove();
    await Promise.all([moving, renaming]);
    expect(sequence).toEqual(["move-start", "move-end", "rename-start", "rename-end"]);
  });

  it("serializes every standard base-dispatcher file mutation", async () => {
    const sequence: string[] = [];
    let releaseFirst!: () => void;
    const mutationNames = [
      "create_file", "write_file", "edit_file", "rename_file", "move_file", "trash_files",
    ];
    const base: ToolDispatcher = {
      listTools: () => mutationNames.map((name) => ({ name, inputSchema: { type: "object" } })),
      callTool: async (_scope, name) => {
        sequence.push(`${name}-start`);
        if (name === "create_file") {
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
        sequence.push(`${name}-end`);
        return { isError: false, content: [{ type: "text", text: name }] };
      },
    };
    const dispatcher = new WorkspaceDispatcher(
      { call: async () => ({ error: "unused" }) },
      new AsyncWriteGate(),
      undefined,
      base,
    );
    const scope = { kind: "CloudEngine" as const };
    const first = dispatcher.callTool(scope, "create_file", { name: "one.txt" });
    const rest = mutationNames.slice(1).map((name) => dispatcher.callTool(scope, name, {}));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sequence).toEqual(["create_file-start"]);
    releaseFirst();
    await Promise.all([first, ...rest]);
    expect(sequence).toEqual(mutationNames.flatMap((name) => [`${name}-start`, `${name}-end`]));
  });

  it("moves and renames cloud-mirror files without replacing an existing destination", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-mirror-backend-"));
    roots.push(root);
    await writeFile(path.join(root, "notes.txt"), "private redacted notes", "utf8");
    await writeFile(path.join(root, "occupied.txt"), "keep me", "utf8");
    const backend = createMirrorWorkspaceBackend(root, true);

    expect(await backend.call("move", {
      source_path: "notes.txt", destination_path: "Archive/notes.txt",
    })).toEqual({ old_path: "/notes.txt", path: "/Archive/notes.txt" });
    expect(await backend.call("rename", {
      source_path: "/Archive/notes.txt", new_name: "final.md",
    })).toEqual({ old_path: "/Archive/notes.txt", path: "/Archive/final.md" });
    expect(await readFile(path.join(root, "Archive", "final.md"), "utf8"))
      .toBe("private redacted notes");
    await expect(lstat(path.join(root, "notes.txt"))).rejects.toThrow();

    const collision = await backend.call("move", {
      source_path: "Archive/final.md", destination_path: "occupied.txt",
    });
    expect(collision.error).toEqual(expect.any(String));
    expect(await readFile(path.join(root, "Archive", "final.md"), "utf8"))
      .toBe("private redacted notes");
    expect(await readFile(path.join(root, "occupied.txt"), "utf8")).toBe("keep me");
  });

  it("blocks read-only, private, traversal, directory, and symlink mirror moves", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-mirror-safety-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "arcelle-mirror-outside-"));
    roots.push(root, outside);
    await writeFile(path.join(root, "safe.txt"), "safe", "utf8");
    await mkdir(path.join(root, "folder"));
    await mkdir(path.join(root, ".arcelle"));
    await symlink(outside, path.join(root, "escape"));
    const writable = createMirrorWorkspaceBackend(root, true);
    const readOnly = createMirrorWorkspaceBackend(root, false);

    for (const response of [
      await readOnly.call("move", { source_path: "safe.txt", destination_path: "moved.txt" }),
      await writable.call("move", { source_path: "safe.txt", destination_path: "../outside.txt" }),
      await writable.call("move", { source_path: "safe.txt", destination_path: ".arcelle/private.txt" }),
      await writable.call("move", { source_path: "safe.txt", destination_path: "escape/outside.txt" }),
      await writable.call("move", { source_path: "folder", destination_path: "moved-folder" }),
      await writable.call("rename", { source_path: "safe.txt", new_name: "../outside.txt" }),
      await writable.call("rename", { source_path: "safe.txt", new_name: ".arcelle" }),
    ]) {
      expect(response.error).toEqual(expect.any(String));
    }
    expect(await readFile(path.join(root, "safe.txt"), "utf8")).toBe("safe");
    await expect(lstat(path.join(outside, "outside.txt"))).rejects.toThrow();
  });

  it("routes only standard metadata organization to the protected real workspace", async () => {
    const mirrorCalls: Array<[string, Record<string, unknown>]> = [];
    const realCalls: Array<[string, Record<string, unknown>]> = [];
    const mirror = {
      call: async (operation: string, args: Record<string, unknown>) => {
        mirrorCalls.push([operation, args]);
        return { backend: "mirror", content: "redacted only" };
      },
    };
    const real = {
      call: async (operation: string, args: Record<string, unknown>) => {
        realCalls.push([operation, args]);
        if (operation === "standard_trash") {
          return { trashed: ["/private.pdf"], original_bytes: "must not escape" };
        }
        return {
          old_path: "/private.pdf",
          path: "/Archive/private.pdf",
          original_bytes: "must not escape",
          content: "must not escape",
        };
      },
    };
    const hybrid = createCloudPrivacyWorkspaceBackend(mirror, real);

    expect(await hybrid.call("standard_rename", { name: "[File A]", new_name: "Final.pdf" }))
      .toEqual({ old_path: "/private.pdf", path: "/Archive/private.pdf" });
    expect(await hybrid.call("standard_move", { name: "[File A]", folder: "Archive" }))
      .toEqual({ old_path: "/private.pdf", path: "/Archive/private.pdf" });
    expect(await hybrid.call("standard_trash", { names: ["[File A]"] }))
      .toEqual({ trashed: ["/private.pdf"] });

    for (const operation of [
      "list", "read", "write", "edit", "delete", "move", "rename",
      "standard_create", "standard_read", "standard_write", "standard_edit",
    ]) {
      expect(await hybrid.call(operation, { path: "redacted.txt" }))
        .toMatchObject({ backend: "mirror" });
    }
    expect(realCalls.map(([operation]) => operation)).toEqual([
      "standard_rename", "standard_move", "standard_trash",
    ]);
    expect(realCalls[0]?.[1]).toEqual({ name: "[File A]", new_name: "Final.pdf" });
    expect(mirrorCalls.map(([operation]) => operation)).toContain("move");
    expect(JSON.stringify(await hybrid.call("standard_move", { name: "private.pdf", folder: "Archive" })))
      .not.toContain("must not escape");
  });

  it("contains errors returned by the protected real organization backend", async () => {
    const secret = "binary bytes Ben Reich /Users/benreich/private.pdf";
    const hybrid = createCloudPrivacyWorkspaceBackend(
      { call: async () => ({}) },
      { call: async () => ({ error: secret, content: secret }) },
    );
    const response = await hybrid.call("standard_move", { name: "x", folder: "Archive" });
    expect(response.error).toEqual(expect.any(String));
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(JSON.stringify(response)).not.toContain("/Users/benreich");
  });

  it("keeps redacted filenames on mirror tools while Deep binary move and rename use restored real paths", async () => {
    const mirrorCalls: Array<[string, Record<string, unknown>]> = [];
    const realCalls: Array<[string, Record<string, unknown>]> = [];
    const hybrid = createCloudPrivacyWorkspaceBackend(
      {
        call: async (operation, args) => {
          mirrorCalls.push([operation, args]);
          return { path: args.path };
        },
      },
      {
        call: async (operation, args) => {
          realCalls.push([operation, args]);
          return { old_path: args.source_path, path: args.destination_path ?? args.new_name };
        },
      },
      { routeExactMoveRenameToReal: true },
    );
    const restoredMove = {
      source_path: "Contracts/Ben Reich.pdf",
      destination_path: "Archive/Ben Reich.pdf",
    };
    const redactedMove = {
      source_path: "Contracts/[Person A].pdf",
      destination_path: "Archive/[Person A].pdf",
    };
    await hybrid.call("read", { path: "Contracts/Ben Reich.txt" }, { path: "Contracts/[Person A].txt" });
    await hybrid.call("write", { path: "Contracts/Ben Reich.txt", content: "real" }, {
      path: "Contracts/[Person A].txt", content: "[Person A]",
    });
    await hybrid.call("edit", { path: "Contracts/Ben Reich.txt" }, { path: "Contracts/[Person A].txt" });
    await hybrid.call("move", restoredMove, redactedMove);
    await hybrid.call("rename", {
      source_path: "Archive/Ben Reich.pdf", new_name: "Ben Reich signed.pdf",
    }, {
      source_path: "Archive/[Person A].pdf", new_name: "[Person A] signed.pdf",
    });

    expect(mirrorCalls).toEqual([
      ["read", { path: "Contracts/[Person A].txt" }],
      ["write", { path: "Contracts/[Person A].txt", content: "[Person A]" }],
      ["edit", { path: "Contracts/[Person A].txt" }],
    ]);
    expect(realCalls).toEqual([
      ["move", restoredMove],
      ["rename", { source_path: "Archive/Ben Reich.pdf", new_name: "Ben Reich signed.pdf" }],
    ]);
  });

  it("merges the full Arcelle MCP catalog into the restricted fallback", async () => {
    const base: ToolDispatcher = {
      listTools: () => [{ name: "special_arcelle_tool", inputSchema: { type: "object" } }],
      callTool: async (_scope, name) => ({
        isError: false,
        content: [{ type: "text", text: `called ${name}` }],
      }),
    };
    const dispatcher = new WorkspaceDispatcher(
      { call: async () => ({ error: "generic backend should not be used" }) },
      new AsyncWriteGate(),
      undefined,
      base,
    );
    const scope = { kind: "CloudEngine" as const };
    expect(dispatcher.listTools(scope).map((tool) => tool.name)).toEqual(["special_arcelle_tool"]);
    expect(await dispatcher.callTool(scope, "special_arcelle_tool", {})).toEqual({
      isError: false,
      content: [{ type: "text", text: "called special_arcelle_tool" }],
    });
  });

  it("contains raw errors from delegated and base MCP tools", async () => {
    const secret = "Ben Reich Bearer secret-token /Users/benreich/private-room";
    const base: ToolDispatcher = {
      listTools: () => [{ name: "unsafe_tool", inputSchema: { type: "object" } }],
      callTool: async () => { throw new Error(secret); },
    };
    const dispatcher = new WorkspaceDispatcher(
      { call: async () => ({}) },
      new AsyncWriteGate(),
      async () => { throw new Error(secret); },
      base,
    );
    const scope = { kind: "CloudEngine" as const };
    const baseFailure = await dispatcher.callTool(scope, "unsafe_tool", {});
    const delegateFailure = await dispatcher.callTool(scope, "arcelle_delegate", { agent_id: "chat.web", task: "work" });
    for (const failure of [baseFailure, delegateFailure]) {
      expect(failure.isError).toBe(true);
      expect(JSON.stringify(failure)).not.toContain("Ben Reich");
      expect(JSON.stringify(failure)).not.toContain("secret-token");
      expect(JSON.stringify(failure)).not.toContain("/Users/benreich");
    }
  });

  it("inherits cancellation into an active delegated CLI child", async () => {
    const f = await fixture();
    let spawned = 0;
    let parentKilled = false;
    let childKilled = false;
    let childReady!: () => void;
    const childStarted = new Promise<void>((resolve) => { childReady = resolve; });
    try {
      const runtime = new RestrictedLegacyCliRuntime("codex", f.state, {
        executable: "/fake/codex",
        available: () => true,
        spawn: (options, args) => {
          spawned += 1;
          if (spawned === 2) {
            const delegated = controllableChild(() => { childKilled = true; });
            childReady();
            return delegated.child;
          }
          const parent = controllableChild(() => { parentKilled = true; });
          queueMicrotask(() => {
            const urlFlag = args.find((arg) => arg.startsWith("mcp_servers.room.url="));
            const url = urlFlag?.match(/"(http[^"]+)"/)?.[1];
            if (url === undefined) return;
            void fetch(url, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${options.env?.ARCELLE_ROOM_MCP_TOKEN ?? ""}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                jsonrpc: "2.0", id: 1, method: "tools/call",
                params: { name: "arcelle_delegate", arguments: { agent_id: "chat.web", task: "wait" } },
              }),
            }).catch(() => undefined);
          });
          return parent.child;
        },
      });
      const run = await runtime.startTurn({
        runId: "cancel-parent", roomId: f.created.descriptor.roomId, provider: "codex", model: "gpt-test",
        workspacePath: f.roomPath, runtimePath: path.join(f.root, "runtime-cancel"), privacyMode: "cloud-direct",
        writeEnabled: true, exposureVerified: true,
      }, { text: "delegate and wait" });
      const events: Array<{ type: string; [key: string]: unknown }> = [];
      const draining = (async () => { for await (const event of run.events) events.push(event); })();
      await childStarted;
      await new Promise<void>((resolve) => setImmediate(resolve));
      await run.cancel();
      await draining;
      expect(childKilled).toBe(true);
      expect(parentKilled).toBe(true);
      expect(events.at(-1)).toEqual({ type: "run_completed", runId: "cancel-parent", status: "cancelled" });
    } finally {
      f.created.db.close();
    }
  });

  it("selects the restricted fallback only when rich mode is unavailable", async () => {
    const calls: string[] = [];
    const runtime = (name: string, available: boolean): HarnessRuntime => ({
      name: "legacy-cli",
      available: async () => available,
      startTurn: async (): Promise<HarnessRun> => {
        calls.push(name);
        async function* events() { /* no events */ }
        return { events: events(), cancel: async () => undefined, approve: async () => undefined };
      },
    });
    const fallback = new RuntimeWithFallback(runtime("rich", false), runtime("fallback", true));
    await fallback.startTurn({} as HarnessContext, { text: "x" });
    expect(calls).toEqual(["fallback"]);
  });

  it("keeps the exposure-verified fallback when rich startup probing fails", async () => {
    const calls: string[] = [];
    const runtime = (
      name: "rich" | "fallback",
      harness: "codex-app-server" | "legacy-cli",
      exposure: boolean,
    ): HarnessRuntime => ({
      name: harness,
      available: async () => true,
      verifyExposure: async () => exposure,
      startTurn: async (): Promise<HarnessRun> => {
        calls.push(name);
        async function* events() { /* no events */ }
        return { events: events(), cancel: async () => undefined, approve: async () => undefined };
      },
    });
    const selected = new RuntimeWithFallback(
      runtime("rich", "codex-app-server", false),
      runtime("fallback", "legacy-cli", true),
    );
    const context = { runtimePath: "/runtime/run-1" } as HarnessContext;
    await expect(selected.verifyExposure("/workspace", context.runtimePath, false)).resolves.toBe(true);
    await selected.startTurn(context, { text: "x" });
    expect(calls).toEqual(["fallback"]);
  });
});

function createdRoomId(value: string): string { return value; }
