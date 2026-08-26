import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createRoomManagerState } from "../roomManager.js";
import { createWorkspaceRoom } from "../workspace/roomLayout.js";
import { WorkspaceService } from "../workspace/workspaceService.js";
import type { NativeWorkspaceSandbox } from "./seatbelt.js";
import { AsyncWriteGate, RestrictedLegacyCliRuntime, RuntimeWithFallback, WorkspaceDispatcher } from "./legacyCli.js";
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
                  params: { name: "arcelle_delegate", arguments: { agent_id: "chat.web", task: "research this" } },
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
      const run = await runtime.startTurn({
        runId: "parent", roomId: f.created.descriptor.roomId, provider: "codex", model: "gpt-test",
        workspacePath: f.roomPath, runtimePath: path.join(f.root, "runtime-delegate"), privacyMode: "cloud-direct",
        writeEnabled: true, exposureVerified: true,
      }, { text: "delegate" });
      const events = [];
      for await (const event of run.events) events.push(event);
      expect(spawned).toBe(2);
      expect(events).toContainEqual({ type: "agent_started", runId: "parent", agentId: "chat.web", label: "Web agent" });
      expect(events).toContainEqual({ type: "text_delta", runId: "parent", text: "specialist answer", agentId: "chat.web" });
      expect(events).toContainEqual({ type: "agent_completed", runId: "parent", agentId: "chat.web" });
      expect(events.at(-1)).toEqual({ type: "run_completed", runId: "parent", status: "completed" });
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
});

function createdRoomId(value: string): string { return value; }
