import { EventEmitter } from "node:events";
import { access, chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexAppServerRuntime,
  codexRoomMcpConfiguration,
  mcpApprovalResult,
  permissionApprovalResult,
  prepareCodexRuntimeHome,
} from "./codexAppServer.js";
import { inspectCodexSchemaDirectory } from "./codexSchema.js";
import { nativeWorkspaceSandboxSupported } from "./seatbelt.js";

const roots: string[] = [];
const installedCodex = spawnSync(process.env.ARCELLE_CODEX_PATH ?? "codex", ["--version"], { stdio: "ignore" }).status === 0;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Codex permission-profile approvals", () => {
  it("returns the app-server response shape without widening a denied request", () => {
    const requested = { fileSystem: { write: ["/workspace"] } };
    expect(permissionApprovalResult(requested, "allow-run")).toEqual({
      permissions: requested,
      scope: "session",
      strictAutoReview: false,
    });
    expect(permissionApprovalResult(requested, "deny")).toEqual({
      permissions: {},
      scope: "turn",
      strictAutoReview: false,
    });
  });
});

describe("Codex Room MCP configuration", () => {
  it("pre-approves the protected per-run Room server so headless calls are dispatched", () => {
    expect(codexRoomMcpConfiguration({
      url: "http://127.0.0.1:4321/mcp",
      token: "secret",
      instructions: "Use Room tools.",
      stop: async () => undefined,
    })).toEqual({
      mcp_servers: {
        room: {
          url: "http://127.0.0.1:4321/mcp",
          bearer_token_env_var: "ARCELLE_ROOM_MCP_TOKEN",
          default_tools_approval_mode: "approve",
        },
      },
    });
  });

  it("maps Room MCP approval decisions to the installed app-server contract", () => {
    expect(mcpApprovalResult("allow-once", true)).toEqual({ action: "accept", content: null });
    expect(mcpApprovalResult("allow-run", true)).toEqual({
      action: "accept",
      content: null,
      _meta: { persist: "session" },
    });
    expect(mcpApprovalResult("allow-run", false)).toEqual({ action: "accept", content: null });
    expect(mcpApprovalResult("deny", true)).toEqual({ action: "decline", content: null });
    expect(mcpApprovalResult("cancel", true)).toEqual({ action: "cancel", content: null });
  });
});

async function fakeCodex(body: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-fake-codex-"));
  roots.push(root);
  const executable = path.join(root, "codex");
  await writeFile(executable, `#!/bin/sh\nset -eu\n${body}\n`, "utf8");
  await chmod(executable, 0o700);
  return executable;
}

async function codexHomeFixture(): Promise<{
  root: string;
  sourceHome: string;
  runtimePath: string;
  workspacePath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-codex-home-test-"));
  roots.push(root);
  const sourceHome = path.join(root, "source-home");
  const runtimePath = path.join(root, "runtime");
  const workspacePath = path.join(root, "workspace");
  await mkdir(sourceHome, { recursive: true });
  await mkdir(runtimePath, { recursive: true });
  await mkdir(path.join(workspacePath, ".arcelle"), { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "test-auth", { mode: 0o644 });
  await writeFile(path.join(sourceHome, "config.toml"), "model = 'test'", { mode: 0o644 });
  await writeFile(path.join(sourceHome, "history.jsonl"), "private history", { mode: 0o600 });
  return { root, sourceHome, runtimePath, workspacePath };
}

function probeChild(
  behavior: "initialize" | "exit" | "hang",
  writes: string[],
  kills: NodeJS.Signals[],
): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 987_654,
    kill: (signal: NodeJS.Signals = "SIGTERM") => {
      kills.push(signal);
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    },
  });
  stdin.on("data", (chunk) => {
    writes.push(chunk.toString());
    if (behavior === "initialize") {
      stdout.write(`${JSON.stringify({ id: "arcelle-capability", result: { userAgent: "fake" } })}\n`);
    }
  });
  // Raw diagnostics may contain private paths/content. The probe must drain
  // them without returning or retaining them.
  stderr.write("SECRET /Users/person/private-room\n");
  if (behavior === "exit") queueMicrotask(() => child.emit("exit", 1, null));
  return child as unknown as ChildProcessWithoutNullStreams;
}

function completingTurnChild(
  requests: Array<Record<string, unknown>>,
): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 987_655,
    kill: (signal: NodeJS.Signals = "SIGTERM") => {
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    },
  });
  stdin.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      const message = JSON.parse(line) as Record<string, unknown>;
      requests.push(message);
      const id = message.id;
      if (id === undefined) continue;
      if (message.method === "initialize") {
        queueMicrotask(() => stdout.write(`${JSON.stringify({ id, result: { userAgent: "fake" } })}\n`));
      } else if (message.method === "thread/start" || message.method === "thread/resume") {
        queueMicrotask(() => stdout.write(`${JSON.stringify({ id, result: { thread: { id: "thread-1" } } })}\n`));
      } else if (message.method === "turn/start") {
        queueMicrotask(() => {
          stdout.write(`${JSON.stringify({ id, result: { turn: { id: "turn-1" } } })}\n`);
          setImmediate(() => stdout.write(`${JSON.stringify({
            method: "turn/completed",
            params: { turn: { id: "turn-1", status: "completed" } },
          })}\n`));
        });
      }
    }
  });
  stdin.on("finish", () => queueMicrotask(() => child.emit("exit", 0, null)));
  return child as unknown as ChildProcessWithoutNullStreams;
}

interface InteractiveTurnServer {
  child: ChildProcessWithoutNullStreams;
  requests: Array<Record<string, unknown>>;
  send(message: Record<string, unknown>): void;
  sendRaw(line: string): void;
}

function interactiveTurnServer(): InteractiveTurnServer {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const requests: Array<Record<string, unknown>> = [];
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 987_656,
    kill: () => {
      queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
      return true;
    },
  });
  const send = (message: Record<string, unknown>): void => {
    stdout.write(`${JSON.stringify(message)}\n`);
  };
  const sendRaw = (line: string): void => {
    stdout.write(`${line}\n`);
  };
  stdin.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      const message = JSON.parse(line) as Record<string, unknown>;
      requests.push(message);
      if (typeof message.method !== "string" || message.id === undefined) continue;
      if (message.method === "initialize") queueMicrotask(() => send({ id: message.id, result: { userAgent: "fake" } }));
      if (message.method === "thread/start") queueMicrotask(() => send({ id: message.id, result: { thread: { id: "thread-1" } } }));
      if (message.method === "turn/start") queueMicrotask(() => send({ id: message.id, result: { turn: { id: "turn-1" } } }));
    }
  });
  stdin.on("finish", () => queueMicrotask(() => child.emit("exit", 0, null)));
  return { child: child as unknown as ChildProcessWithoutNullStreams, requests, send, sendRaw };
}

async function waitForRequest(server: InteractiveTurnServer, method: string): Promise<Record<string, unknown>> {
  for (let attempts = 0; attempts < 50; attempts += 1) {
    const request = server.requests.find((candidate) => candidate.method === method);
    if (request !== undefined) return request;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${method}.`);
}

async function startInteractiveTurn(runId: string): Promise<{ server: InteractiveTurnServer; run: Awaited<ReturnType<CodexAppServerRuntime["startTurn"]>> }> {
  const fixture = await codexHomeFixture();
  const server = interactiveTurnServer();
  const runtime = new CodexAppServerRuntime("codex", (() => server.child) as never, 100, fixture.sourceHome);
  const run = await runtime.startTurn({
    runId,
    roomId: "room-1",
    provider: "codex",
    model: "test-model",
    workspacePath: fixture.workspacePath,
    runtimePath: fixture.runtimePath,
    privacyMode: "cloud-direct",
    writeEnabled: false,
    exposureVerified: true,
  }, { text: "Exercise the app-server protocol." });
  await waitForRequest(server, "turn/start");
  return { server, run };
}

async function collectEvents(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const collected: unknown[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("Codex app-server compatibility probe", () => {
  it("creates a private runtime home with only auth and config", async () => {
    const fixture = await codexHomeFixture();
    const runtimeHome = await prepareCodexRuntimeHome(fixture.runtimePath, fixture.sourceHome);

    expect(path.dirname(runtimeHome)).toBe(await realpath(fixture.runtimePath));
    expect((await stat(runtimeHome)).mode & 0o777).toBe(0o700);
    expect(await readFile(path.join(runtimeHome, "auth.json"), "utf8")).toBe("test-auth");
    expect(await readFile(path.join(runtimeHome, "config.toml"), "utf8")).toBe("model = 'test'");
    expect((await stat(path.join(runtimeHome, "auth.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(runtimeHome, "config.toml"))).mode & 0o777).toBe(0o600);
    await expect(access(path.join(runtimeHome, "history.jsonl"))).rejects.toThrow();
  });

  it("requires the installed Codex version to generate its stable schema", async () => {
    const executable = await fakeCodex(`
if [ "$1" = "app-server" ] && [ "$2" = "--help" ]; then exit 0; fi
if [ "$1" = "app-server" ] && [ "$2" = "generate-json-schema" ]; then
  mkdir -p "$4"
  printf '%s' '{"methods":["thread/start","turn/start","turn/interrupt","item/started","item/completed","turn/completed"]}' > "$4/protocol.json"
  exit 0
fi
exit 2`);
    await expect(new CodexAppServerRuntime(executable).available()).resolves.toBe(true);
  });

  it("fails closed when app-server exists but its matching schema cannot be generated", async () => {
    const executable = await fakeCodex(`
if [ "$1" = "app-server" ] && [ "$2" = "--help" ]; then exit 0; fi
exit 2`);
    await expect(new CodexAppServerRuntime(executable).available()).resolves.toBe(false);
  });

  it.runIf(installedCodex)("loads and validates the schema from the installed Codex release", async () => {
    const runtime = new CodexAppServerRuntime();
    await expect(runtime.available()).resolves.toBe(true);
    expect(runtime.installedSchemaCompatibility()).toMatchObject({ compatible: true });
    expect(runtime.installedSchemaCompatibility()?.files).toBeGreaterThan(0);
  });

  it("requires a real initialized app-server, not a successful help command", async () => {
    const fixture = await codexHomeFixture();
    const expectedRuntimeHome = path.join(await realpath(fixture.runtimePath), "codex-home");
    const writes: string[] = [];
    const kills: NodeJS.Signals[] = [];
    const child = probeChild("initialize", writes, kills);
    child.stdout.write("fabricated non-protocol diagnostic\n");
    const spawn = ((_options: unknown, args: string[], spawnOptions: { env?: NodeJS.ProcessEnv }) => {
      expect(args).toEqual(["app-server", "--listen", "stdio://"]);
      expect(spawnOptions.env?.CODEX_HOME).toBe(expectedRuntimeHome);
      return child;
    }) as never;
    const runtime = new CodexAppServerRuntime("codex", spawn, 100, fixture.sourceHome);
    await expect(runtime.verifyExposure(fixture.workspacePath, fixture.runtimePath, false)).resolves.toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('"method":"initialize"');
    expect(writes[0]).not.toContain("/workspace/SECRET-room");
    expect(writes[0]).not.toContain("SECRET /Users/person/private-room");
    expect(kills).toContain("SIGTERM");
  });

  it("fails closed when the initialize request cannot be written", async () => {
    const fixture = await codexHomeFixture();
    const child = probeChild("hang", [], []);
    child.stdin.write = (() => { throw new Error("fabricated stdin refusal"); }) as typeof child.stdin.write;
    const runtime = new CodexAppServerRuntime(
      "codex",
      (() => child) as never,
      10,
      fixture.sourceHome,
    );
    await expect(runtime.verifyExposure(fixture.workspacePath, fixture.runtimePath, false)).resolves.toBe(false);
  });

  it("fails closed when the sandboxed exposure process cannot spawn", async () => {
    const fixture = await codexHomeFixture();
    const runtime = new CodexAppServerRuntime(
      "codex",
      (() => { throw new Error("fabricated spawn refusal"); }) as never,
      10,
      fixture.sourceHome,
    );
    await expect(runtime.verifyExposure(fixture.workspacePath, fixture.runtimePath, false)).resolves.toBe(false);
  });

  it("refuses an unverified turn before allocating its protocol process", async () => {
    const spawn = (() => { throw new Error("must not spawn"); }) as never;
    const runtime = new CodexAppServerRuntime("codex", spawn);
    await expect(runtime.startTurn({
      runId: "unverified",
      roomId: "room-1",
      provider: "codex",
      model: "test-model",
      workspacePath: "/workspace",
      runtimePath: "/runtime",
      privacyMode: "cloud-direct",
      writeEnabled: false,
      exposureVerified: false,
    }, { text: "must not run" })).rejects.toThrow("refused an unverified workspace exposure");
  });

  it("stops the Room MCP bridge when turn process setup fails", async () => {
    const fixture = await codexHomeFixture();
    let stopped = 0;
    const runtime = new CodexAppServerRuntime(
      "codex",
      (() => { throw new Error("fabricated turn spawn refusal"); }) as never,
      10,
      fixture.sourceHome,
      async () => ({
        url: "http://127.0.0.1:1/mcp",
        token: "fabricated",
        instructions: "Fabricated Room MCP",
        stop: async () => { stopped += 1; },
      }),
    );
    await expect(runtime.startTurn({
      runId: "spawn-failure",
      roomId: "room-1",
      provider: "codex",
      model: "test-model",
      workspacePath: fixture.workspacePath,
      runtimePath: fixture.runtimePath,
      privacyMode: "cloud-direct",
      writeEnabled: false,
      exposureVerified: true,
    }, { text: "must fail" })).rejects.toThrow("fabricated turn spawn refusal");
    expect(stopped).toBe(1);
  });

  it.each(["exit", "hang"] as const)("fails closed when app-server %s before initialization", async (behavior) => {
    const fixture = await codexHomeFixture();
    const writes: string[] = [];
    const kills: NodeJS.Signals[] = [];
    const runtime = new CodexAppServerRuntime(
      "codex",
      (() => probeChild(behavior, writes, kills)) as never,
      10,
      fixture.sourceHome,
    );
    await expect(runtime.verifyExposure(fixture.workspacePath, fixture.runtimePath, false)).resolves.toBe(false);
    if (behavior === "hang") expect(kills).toContain("SIGTERM");
  });

  it("uses the isolated runtime home for the real turn process", async () => {
    const fixture = await codexHomeFixture();
    const expectedRuntimeHome = path.join(await realpath(fixture.runtimePath), "codex-home");
    const writes: string[] = [];
    const kills: NodeJS.Signals[] = [];
    let spawnedHome: string | undefined;
    const runtime = new CodexAppServerRuntime(
      "codex",
      ((_options: unknown, _args: string[], spawnOptions: { env?: NodeJS.ProcessEnv }) => {
        spawnedHome = spawnOptions.env?.CODEX_HOME;
        return probeChild("hang", writes, kills);
      }) as never,
      100,
      fixture.sourceHome,
    );

    const run = await runtime.startTurn({
      runId: "run-1",
      roomId: "room-1",
      provider: "codex",
      model: "test-model",
      workspacePath: fixture.workspacePath,
      runtimePath: fixture.runtimePath,
      privacyMode: "cloud-direct",
      writeEnabled: false,
      exposureVerified: true,
    }, { text: "Read the workspace." });

    expect(spawnedHome).toBe(expectedRuntimeHome);
    expect(writes[0]).toContain('"method":"initialize"');
    await run.cancel();
    for await (const _event of run.events) { /* drain terminal cleanup */ }
    expect(kills).toContain("SIGTERM");
  });

  it.each([
    { writeEnabled: false, threadSandbox: "read-only", turnSandbox: { type: "readOnly" } },
    {
      writeEnabled: true,
      threadSandbox: "workspace-write",
      turnSandbox: { type: "workspaceWrite", networkAccess: false },
    },
  ])("uses current Codex request enums when writeEnabled=$writeEnabled", async ({
    writeEnabled,
    threadSandbox,
    turnSandbox,
  }) => {
    const fixture = await codexHomeFixture();
    const requests: Array<Record<string, unknown>> = [];
    const runtime = new CodexAppServerRuntime(
      "codex",
      (() => completingTurnChild(requests)) as never,
      100,
      fixture.sourceHome,
    );
    const run = await runtime.startTurn({
      runId: `run-${writeEnabled ? "write" : "read"}`,
      roomId: "room-1",
      provider: "codex",
      model: "test-model",
      workspacePath: fixture.workspacePath,
      runtimePath: fixture.runtimePath,
      privacyMode: "cloud-direct",
      writeEnabled,
      exposureVerified: true,
      systemPrompt: "Follow the room policy.",
    }, { text: "Review notes.md." });
    for await (const _event of run.events) { /* wait for the complete protocol */ }

    const threadStart = requests.find((message) => message.method === "thread/start");
    expect(threadStart?.params).toMatchObject({
      model: "test-model",
      approvalPolicy: "on-request",
      sandbox: threadSandbox,
      developerInstructions: expect.stringContaining("Follow the room policy."),
    });
    expect((threadStart?.params as Record<string, unknown>).developerInstructions)
      .toEqual(expect.stringContaining("Arcelle specialist catalog"));
    const turnStart = requests.find((message) => message.method === "turn/start");
    expect(turnStart?.params).toMatchObject({
      approvalPolicy: "on-request",
      sandboxPolicy: turnSandbox,
      input: [{ type: "text", text: "Review notes.md." }],
    });
    expect(JSON.stringify((turnStart?.params as Record<string, unknown>).input)).not.toContain("Follow the room policy.");
  });

  it("omits Arcelle's default model alias so Codex uses its configured model", async () => {
    const fixture = await codexHomeFixture();
    const requests: Array<Record<string, unknown>> = [];
    const runtime = new CodexAppServerRuntime(
      "codex",
      (() => completingTurnChild(requests)) as never,
      100,
      fixture.sourceHome,
    );
    const run = await runtime.startTurn({
      runId: "run-default-model",
      roomId: "room-1",
      provider: "codex",
      model: "default",
      workspacePath: fixture.workspacePath,
      runtimePath: fixture.runtimePath,
      privacyMode: "cloud-direct",
      writeEnabled: false,
      exposureVerified: true,
    }, { text: "Review notes.md." });
    for await (const _event of run.events) { /* wait for the complete protocol */ }

    const threadStart = requests.find((message) => message.method === "thread/start");
    expect(threadStart?.params).not.toHaveProperty("model");
  });

  it("updates developer instructions when resuming a thread", async () => {
    const fixture = await codexHomeFixture();
    const requests: Array<Record<string, unknown>> = [];
    const runtime = new CodexAppServerRuntime(
      "codex",
      (() => completingTurnChild(requests)) as never,
      100,
      fixture.sourceHome,
    );
    const run = await runtime.startTurn({
      runId: "run-resume",
      roomId: "room-1",
      provider: "codex",
      model: "test-model",
      workspacePath: fixture.workspacePath,
      runtimePath: fixture.runtimePath,
      privacyMode: "cloud-direct",
      writeEnabled: false,
      exposureVerified: true,
      systemPrompt: "Current room policy.",
    }, { text: "Continue the review.", threadId: "thread-existing" });
    for await (const _event of run.events) { /* wait for the complete protocol */ }

    const threadResume = requests.find((message) => message.method === "thread/resume");
    expect(threadResume?.params).toMatchObject({
      threadId: "thread-existing",
      developerInstructions: expect.stringContaining("Current room policy."),
    });
    const turnStart = requests.find((message) => message.method === "turn/start");
    expect(turnStart?.params).toMatchObject({
      input: [{ type: "text", text: "Continue the review." }],
    });
  });

  it("routes approvals, collaboration, notifications, and generic requests through the app-server protocol", async () => {
    const { server, run } = await startInteractiveTurn("run-protocol");
    server.send({ id: "command", method: "item/commandExecution/requestApproval", params: { reason: "Run review" } });
    server.send({ id: "file", method: "item/fileChange/requestApproval", params: { command: "Write notes" } });
    server.send({ id: "permissions", method: "item/permissions/requestApproval", params: { permissions: { fileSystem: "write" } } });
    server.send({
      id: "room-mcp",
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "room",
        mode: "form",
        message: "Approve the Room tool.",
        _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session"] },
      },
    });
    server.send({ id: "generic", method: "mcpServer/elicitation/request", params: { serverName: "other", mode: "form" } });
    server.send({ method: "item/agentMessage/delta", params: { delta: "hello" } });
    server.send({
      method: "item/started",
      params: { item: { type: "collab_agent_tool_call", id: "tool-1", tool: "delegate", receiver_thread_ids: ["agent-1"] } },
    });
    server.send({
      method: "item/completed",
      params: {
        item: {
          type: "collab_agent_tool_call",
          id: "tool-1",
          status: "failed",
          error: { message: "not found" },
          agents_states: { "agent-state": { status: "pending" } },
        },
      },
    });
    server.send({
      method: "item/completed",
      params: { item: { type: "collab_agent_tool_call", status: "failed", new_thread_id: "agent-fallback" } },
    });
    server.send({ method: "turn/diff/updated", params: { diff: "updated plan" } });
    server.send({ method: "thread/tokenUsage/updated", params: { usage: { inputTokens: 12, outputTokens: "unknown" } } });
    server.send({ method: "error" });
    server.send({ method: "unknown/notification" });
    server.send({ id: "unknown-response", result: "ignored" });
    server.sendRaw("not a protocol message");

    await run.approve("command", "allow-once");
    await run.approve("file", "deny");
    await run.approve("permissions", "allow-run");
    await run.approve("room-mcp", "allow-run");
    await expect(run.approve("expired", "deny")).rejects.toThrow("no longer active");

    server.send({ method: "turn/completed", params: { turn: { status: "completed" } } });
    const events = await collectEvents(run.events);
    expect(events).toEqual(expect.arrayContaining([
      { type: "approval_requested", runId: "run-protocol", requestId: "command", tool: "shell", detail: "Run review" },
      { type: "approval_requested", runId: "run-protocol", requestId: "file", tool: "file_change", detail: "Write notes" },
      { type: "approval_requested", runId: "run-protocol", requestId: "permissions", tool: "permissions", detail: "Codex requests permission for this protected operation." },
      { type: "approval_requested", runId: "run-protocol", requestId: "room-mcp", tool: "room_mcp", detail: "Approve the Room tool." },
      { type: "text_delta", runId: "run-protocol", text: "hello" },
      { type: "agent_started", runId: "run-protocol", agentId: "agent-1", label: "delegate" },
      { type: "tool_started", runId: "run-protocol", tool: "collabAgentToolCall", toolId: "tool-1" },
      { type: "agent_completed", runId: "run-protocol", agentId: "agent-state" },
      { type: "agent_completed", runId: "run-protocol", agentId: "agent-fallback" },
      { type: "plan_updated", runId: "run-protocol", text: "updated plan" },
      { type: "usage_updated", runId: "run-protocol", inputTokens: 12, outputTokens: undefined },
      { type: "run_completed", runId: "run-protocol", status: "completed" },
    ]));
    const replies = server.requests.filter((request) => request.method === undefined && request.id !== undefined);
    expect(replies).toEqual(expect.arrayContaining([
      { id: "generic", result: { action: "decline", content: null } },
      { id: "command", result: { decision: "accept" } },
      { id: "file", result: { decision: "decline" } },
      { id: "permissions", result: { permissions: { fileSystem: "write" }, scope: "session", strictAutoReview: false } },
      { id: "room-mcp", result: { action: "accept", content: null, _meta: { persist: "session" } } },
    ]));
  });

  it.each([
    ["interrupted", { type: "run_completed", runId: "run-interrupted", status: "cancelled" }],
    ["failed", { type: "run_failed", runId: "run-failed" }],
  ] as const)("maps a %s turn completion to the matching terminal event", async (status, expected) => {
    const { server, run } = await startInteractiveTurn(`run-${status}`);
    server.send({ method: "turn/completed", params: { turn: { status } } });
    await expect(collectEvents(run.events)).resolves.toEqual(expect.arrayContaining([expect.objectContaining(expected)]));
  });

  it("falls back to process termination when an interrupt RPC returns an error", async () => {
    const { server, run } = await startInteractiveTurn("run-interrupt-error");
    const cancellation = run.cancel();
    const interrupt = await waitForRequest(server, "turn/interrupt");
    server.send({ id: interrupt.id, error: { message: "cannot interrupt" } });
    await cancellation;
    await expect(collectEvents(run.events)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "run_failed", runId: "run-interrupt-error" }),
    ]));
  });

  it.runIf(installedCodex && nativeWorkspaceSandboxSupported())(
    "initializes the installed app-server with isolated mutable state",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-codex-live-probe-"));
      roots.push(root);
      const workspacePath = path.join(root, "workspace");
      const runtimePath = path.join(root, "runtime");
      await mkdir(path.join(workspacePath, ".arcelle"), { recursive: true });
      await mkdir(runtimePath, { recursive: true });
      const runtime = new CodexAppServerRuntime();
      await expect(runtime.verifyExposure(workspacePath, runtimePath, false)).resolves.toBe(true);
    },
    15_000,
  );

  it("accepts legacy core and current collaboration schema fixtures", async () => {
    const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
    for (const fixture of ["codex-schema-v1-core.json", "codex-schema-v2-collab.json"]) {
      const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-codex-schema-fixture-"));
      roots.push(root);
      await cp(path.join(fixtureRoot, fixture), path.join(root, "protocol.json"));
      const compatibility = await inspectCodexSchemaDirectory(root);
      expect(compatibility.compatible, fixture).toBe(true);
      expect(compatibility.collaborationEvents, fixture).toBe(fixture.includes("v2"));
    }
  });

  it("fails closed when an installed schema omits a required lifecycle method", async () => {
    const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-codex-schema-fixture-"));
    roots.push(root);
    await cp(path.join(fixtureRoot, "codex-schema-incompatible.json"), path.join(root, "protocol.json"));
    const compatibility = await inspectCodexSchemaDirectory(root);
    expect(compatibility.compatible).toBe(false);
    expect(compatibility.missingMethods).toContain("turn/interrupt");
    expect(compatibility.missingMethods).toContain("item/completed");
  });

  it("fails closed when one generated schema file is incomplete JSON", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-codex-schema-fixture-"));
    roots.push(root);
    await writeFile(path.join(root, "protocol.json"), '{"method":"thread/start"', "utf8");
    const compatibility = await inspectCodexSchemaDirectory(root);
    expect(compatibility).toMatchObject({ compatible: false, files: 0 });
    expect(compatibility.missingMethods).toContain("thread/start");
  });
});
