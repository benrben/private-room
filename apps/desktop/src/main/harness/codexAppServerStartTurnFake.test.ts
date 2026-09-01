import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServerRuntime } from "./codexAppServer.js";
import type { HarnessContext } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface FakeAppServer {
  child: ReturnType<typeof fakeAppServer>["child"];
  requests: Array<Record<string, unknown>>;
  kills: number;
}

function fakeAppServer(threadReply: unknown = { thread: { id: "thread-1" } }) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const requests: Array<Record<string, unknown>> = [];
  let kills = 0;
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 91_001,
    kill: () => {
      kills += 1;
      queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
      return true;
    },
  });
  const reply = (message: Record<string, unknown>): void => stdout.write(`${JSON.stringify(message)}\n`);
  stdin.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      const message = JSON.parse(line) as Record<string, unknown>;
      requests.push(message);
      if (message.id === undefined || typeof message.method !== "string") continue;
      if (message.method === "initialize") queueMicrotask(() => reply({ id: message.id, result: {} }));
      if (message.method === "thread/start" || message.method === "thread/resume") {
        queueMicrotask(() => reply({ id: message.id, result: threadReply }));
      }
      if (message.method === "turn/start") {
        queueMicrotask(() => {
          reply({ id: message.id, result: { turn: { id: "turn-1" } } });
          setImmediate(() => reply({ method: "turn/completed", params: { turn: { status: "completed" } } }));
        });
      }
    }
  });
  stdin.on("finish", () => queueMicrotask(() => child.emit("exit", 0, null)));
  return { child: child as never, requests, get kills() { return kills; } };
}

async function fixture(): Promise<{ sourceHome: string; runtimePath: string; workspacePath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-app-server-fake-"));
  roots.push(root);
  const sourceHome = path.join(root, "source-home");
  const runtimePath = path.join(root, "runtime");
  const workspacePath = path.join(root, "workspace");
  await Promise.all([mkdir(sourceHome), mkdir(runtimePath), mkdir(workspacePath)]);
  return { sourceHome, runtimePath, workspacePath };
}

function context(paths: Awaited<ReturnType<typeof fixture>>, writeEnabled: boolean): HarnessContext {
  return {
    runId: "fake-run",
    roomId: "room-1",
    provider: "codex",
    model: "default",
    workspacePath: paths.workspacePath,
    runtimePath: paths.runtimePath,
    privacyMode: "cloud-direct",
    writeEnabled,
    exposureVerified: true,
  };
}

async function collectEvents(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const collected: unknown[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("Codex app-server startup with a fake child", () => {
  it("starts a read-only thread and completes the turn without invoking Codex", async () => {
    const paths = await fixture();
    const server = fakeAppServer();
    const runtime = new CodexAppServerRuntime("not-run", (() => server.child) as never, 20, paths.sourceHome);
    const run = await runtime.startTurn(context(paths, false), { text: "Inspect notes." });

    await expect(collectEvents(run.events)).resolves.toEqual(expect.arrayContaining([
      { type: "run_started", runId: "fake-run", harness: "codex-app-server" },
      { type: "agent_started", runId: "fake-run", agentId: "coordinator", label: "Codex" },
      { type: "run_completed", runId: "fake-run", status: "completed" },
    ]));

    const threadStart = server.requests.find((request) => request.method === "thread/start");
    expect(threadStart?.params).toMatchObject({
      cwd: paths.workspacePath,
      approvalPolicy: "on-request",
      sandbox: "read-only",
      ephemeral: true,
    });
    expect(threadStart?.params).not.toHaveProperty("model");
    const turnStart = server.requests.find((request) => request.method === "turn/start");
    expect(turnStart?.params).toMatchObject({
      threadId: "thread-1",
      input: [{ type: "text", text: "Inspect notes." }],
      sandboxPolicy: { type: "readOnly" },
    });
  });

  it("resumes a write-enabled thread with its fake Room MCP configuration", async () => {
    const paths = await fixture();
    const server = fakeAppServer();
    let stops = 0;
    const roomMcp = {
      url: "http://127.0.0.1:12345/mcp",
      token: "fake-token",
      instructions: "Use the fake Room tools.",
      stop: async () => { stops += 1; },
    };
    const runtime = new CodexAppServerRuntime(
      "not-run",
      (() => server.child) as never,
      20,
      paths.sourceHome,
      async () => roomMcp,
    );
    const run = await runtime.startTurn(
      { ...context(paths, true), systemPrompt: "Follow the fake room policy." },
      { text: "Continue notes.", threadId: "existing-thread" },
    );

    await collectEvents(run.events);

    const threadResume = server.requests.find((request) => request.method === "thread/resume");
    expect(threadResume?.params).toMatchObject({
      threadId: "existing-thread",
      config: { mcp_servers: { room: { url: roomMcp.url } } },
      developerInstructions: expect.stringContaining("Follow the fake room policy."),
    });
    expect((threadResume?.params as { developerInstructions: string }).developerInstructions)
      .toContain("Use the fake Room tools.");
    const turnStart = server.requests.find((request) => request.method === "turn/start");
    expect(turnStart?.params).toMatchObject({
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [paths.workspacePath],
        networkAccess: false,
      },
    });
    expect(stops).toBe(1);
  });

  it("fails closed when the fake server omits the thread identifier", async () => {
    const paths = await fixture();
    const server = fakeAppServer({ thread: {} });
    const runtime = new CodexAppServerRuntime("not-run", (() => server.child) as never, 20, paths.sourceHome);
    const run = await runtime.startTurn(context(paths, false), { text: "Inspect notes." });

    await expect(collectEvents(run.events)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "run_failed", runId: "fake-run" }),
    ]));
    expect(server.kills).toBeGreaterThan(0);
    expect(server.requests.some((request) => request.method === "turn/start")).toBe(false);
  });
});
