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
import { RestrictedLegacyCliRuntime, RuntimeWithFallback } from "./legacyCli.js";
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
      expect(events).toContainEqual({ type: "text_delta", runId: "run-1", text: "done" });
      expect(events.at(-1)).toEqual({ type: "run_completed", runId: "run-1", status: "completed" });
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
