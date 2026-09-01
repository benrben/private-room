import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NativeRoomMcpExposure } from "./nativeRoomMcp.js";

const queryMock = vi.hoisted(() => vi.fn());
const nativeMocks = vi.hoisted(() => ({
  spawnClaude: vi.fn(),
  spawnSync: vi.fn(),
  terminate: vi.fn(),
  verifyExposure: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...original, query: queryMock };
});
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: nativeMocks.spawnSync,
}));
vi.mock("./seatbelt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./seatbelt.js")>()),
  spawnWithNativeWorkspaceSandbox: nativeMocks.spawnClaude,
  terminateNativeProcessTree: nativeMocks.terminate,
  verifyNativeHarnessExecutable: nativeMocks.verifyExposure,
}));

import { ClaudeAgentSdkRuntime } from "./claudeAgentSdk.js";

afterEach(() => queryMock.mockReset());

beforeEach(() => {
  nativeMocks.spawnSync.mockReset().mockReturnValue({ status: 0 });
  nativeMocks.spawnClaude.mockReset();
  nativeMocks.terminate.mockReset();
  nativeMocks.verifyExposure.mockReset().mockResolvedValue(true);
});

function context(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-stream",
    roomId: "room-1",
    provider: "claude",
    model: "sonnet",
    privacyMode: "cloud-direct",
    workspacePath: "/tmp/Arcelle Room",
    runtimePath: "/tmp/Arcelle Runtime/run-stream",
    writeEnabled: true,
    exposureVerified: true,
    ...overrides,
  };
}

function sdkQuery(messages: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
    },
    close: vi.fn(),
  };
}

async function collectedEvents(
  run: Awaited<ReturnType<ClaudeAgentSdkRuntime["startTurn"]>>,
) {
  const events = [];
  for await (const event of run.events) events.push(event);
  return events;
}

function hooksForLastQuery() {
  const request = queryMock.mock.calls.at(-1)?.[0] as {
    options: {
      hooks: Record<
        string,
        Array<{ hooks: Array<(...args: unknown[]) => Promise<unknown>> }>
      >;
    };
  };
  return request.options.hooks;
}

describe("Claude native Room MCP wiring", () => {
  it("probes the native executable, verifies exposure, and refuses an unverified turn", async () => {
    const runtime = new ClaudeAgentSdkRuntime("claude");
    expect(await runtime.available()).toBe(true);
    nativeMocks.spawnSync.mockReturnValueOnce({ status: 1 });
    expect(await runtime.available()).toBe(false);
    expect(
      await runtime.verifyExposure("/tmp/room", "/tmp/runtime", false),
    ).toBe(true);
    expect(nativeMocks.verifyExposure).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspacePath: "/tmp/room",
        runtimePath: "/tmp/runtime",
        executable: "claude",
        writeEnabled: false,
      }),
      ["--version"],
    );
    await expect(
      runtime.startTurn(context({ exposureVerified: false }), {
        text: "Do not start.",
      }),
    ).rejects.toThrow("unverified workspace exposure");
  });

  it("normalizes iterator failures and cleans up the per-run MCP bridge", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    queryMock.mockReturnValueOnce({
      async *[Symbol.asyncIterator]() {
        throw new Error("provider echoed private data");
      },
      close: vi.fn(),
    });
    const runtime = new ClaudeAgentSdkRuntime("claude", async () => ({
      url: "http://127.0.0.1:1/mcp",
      token: "secret",
      instructions: "room only",
      stop,
    }));
    const run = await runtime.startTurn(context(), { text: "Try this." });
    const events = await collectedEvents(run);
    expect(events).toContainEqual({
      type: "run_failed",
      runId: "run-stream",
      error:
        "Claude run failed. Provider diagnostics were omitted to protect room data.",
    });
    expect(JSON.stringify(events)).not.toContain("private data");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("keeps approval, post-tool completion, sandbox cancellation, and unknown approval errors explicit", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const query = {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "agent-1",
                name: "Agent",
                input: { agent: "writer" },
              },
            ],
          },
        };
        await gate;
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0,
        };
      },
      close: vi.fn(),
    };
    const child = { once: vi.fn() };
    nativeMocks.spawnClaude.mockReturnValue(child);
    queryMock.mockReturnValueOnce(query);
    const run = await new ClaudeAgentSdkRuntime("claude").startTurn(context(), {
      text: "Write safely.",
    });
    await Promise.resolve();
    await Promise.resolve();
    const request = queryMock.mock.calls.at(-1)?.[0] as {
      options: {
        canUseTool: (...args: unknown[]) => Promise<unknown>;
        hooks: Record<
          string,
          Array<{ hooks: Array<(...args: unknown[]) => Promise<unknown>> }>
        >;
        spawnClaudeCodeProcess: (options: Record<string, unknown>) => unknown;
      };
    };
    const controller = new AbortController();
    const decision = request.options.canUseTool(
      "Write",
      { file_path: "/tmp/Arcelle Room/note.md" },
      {
        requestId: "approval-1",
        toolUseID: "tool-1",
        title: "Write the note",
        signal: controller.signal,
      },
    );
    await run.approve("approval-1", "allow-once");
    await expect(decision).resolves.toMatchObject({
      behavior: "allow",
      toolUseID: "tool-1",
    });
    await expect(run.approve("approval-1", "allow-once")).rejects.toThrow(
      "no longer active",
    );
    const cancelledApproval = request.options.canUseTool(
      "Read",
      {},
      {
        requestId: "approval-cancel",
        toolUseID: "tool-cancel",
        signal: new AbortController().signal,
      },
    );
    const cancellationSignal = new AbortController();
    const abortedApproval = request.options.canUseTool(
      "Read",
      {},
      {
        requestId: "approval-abort",
        toolUseID: "tool-abort",
        signal: cancellationSignal.signal,
      },
    );
    cancellationSignal.abort();
    await expect(abortedApproval).resolves.toEqual({
      behavior: "deny",
      message: "Arcelle did not approve this operation.",
      interrupt: true,
    });
    await run.approve("approval-cancel", "deny");
    await expect(cancelledApproval).resolves.toMatchObject({
      behavior: "deny",
      interrupt: false,
    });

    const postTool = request.options.hooks["PostToolUse"]![0]!.hooks[0]!;
    await postTool({ tool_name: "Agent", tool_use_id: "agent-1" }, "agent-1");
    const spawned = request.options.spawnClaudeCodeProcess({
      command: "claude-child",
      args: ["--child"],
      env: { SAFE: "1" },
      cwd: "/tmp/Arcelle Room",
      signal: controller.signal,
    });
    expect(spawned).toBe(child);
    await run.cancel();
    expect(query.close).toHaveBeenCalledOnce();
    expect(nativeMocks.terminate).toHaveBeenLastCalledWith(child);
    release();
    const events = await collectedEvents(run);
    expect(events).toContainEqual({
      type: "agent_completed",
      runId: "run-stream",
      agentId: "writer",
    });
  });

  it("stops the MCP bridge when query construction itself rejects", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    queryMock.mockImplementationOnce(() => {
      throw new Error("SDK start failed");
    });
    const runtime = new ClaudeAgentSdkRuntime("claude", async () => ({
      url: "http://127.0.0.1:1/mcp",
      token: "secret",
      instructions: "room only",
      stop,
    }));
    await expect(
      runtime.startTurn(context(), { text: "Start." }),
    ).rejects.toThrow("SDK start failed");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("maps SDK stream, subagent, tool, denial, usage, and terminal events in provider order", async () => {
    queryMock.mockReturnValueOnce(
      sdkQuery([
        { type: "system", subtype: "init" },
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "agent-1",
                name: "Agent",
                input: { subagent_type: "research" },
              },
              {
                type: "tool_use",
                id: "task-1",
                name: "Task",
                input: { agent: "writer" },
              },
              { type: "tool_use", id: "agent-2", name: "Agent", input: {} },
            ],
          },
        },
        {
          type: "stream_event",
          parent_tool_use_id: "agent-1",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "researching" },
          },
        },
        {
          type: "stream_event",
          parent_tool_use_id: "task-1",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "writing" },
          },
        },
        {
          type: "stream_event",
          parent_tool_use_id: "agent-2",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "checking" },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "input_json_delta" },
          },
        },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          usage: { input_tokens: 2, output_tokens: 3 },
          total_cost_usd: 0.04,
        },
      ]),
    );
    const run = await new ClaudeAgentSdkRuntime("claude").startTurn(context(), {
      text: "Research and write.",
    });
    const events = await collectedEvents(run);

    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: "agent_started",
          runId: "run-stream",
          agentId: "coordinator",
          label: "Claude",
        },
        {
          type: "agent_started",
          runId: "run-stream",
          agentId: "research",
          label: "research",
        },
        {
          type: "agent_started",
          runId: "run-stream",
          agentId: "writer",
          label: "writer",
        },
        {
          type: "agent_started",
          runId: "run-stream",
          agentId: "agent-2",
          label: "agent-2",
        },
        {
          type: "text_delta",
          runId: "run-stream",
          text: "researching",
          agentId: "research",
        },
        {
          type: "text_delta",
          runId: "run-stream",
          text: "writing",
          agentId: "writer",
        },
        {
          type: "text_delta",
          runId: "run-stream",
          text: "checking",
          agentId: "agent-2",
        },
        {
          type: "usage_updated",
          runId: "run-stream",
          inputTokens: 2,
          outputTokens: 3,
          costUsd: 0.04,
        },
        { type: "run_completed", runId: "run-stream", status: "completed" },
      ]),
    );
    expect(
      events.filter(
        (event) =>
          event.type === "tool_completed" &&
          event.error?.includes("without a completion"),
      ),
    ).toHaveLength(3);
  });

  it("maps result denials and preserves failed terminal status", async () => {
    queryMock.mockReturnValueOnce(
      sdkQuery([
        {
          type: "result",
          subtype: "error",
          is_error: true,
          permission_denials: [{ tool_use_id: "edit-1", tool_name: "Edit" }],
          total_cost_usd: 0,
        },
      ]),
    );
    const run = await new ClaudeAgentSdkRuntime("claude").startTurn(context(), {
      text: "Edit the note.",
    });
    const events = await collectedEvents(run);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: "tool_started",
          runId: "run-stream",
          tool: "Edit",
          toolId: "edit-1",
        },
        {
          type: "tool_completed",
          runId: "run-stream",
          tool: "Edit",
          toolId: "edit-1",
          error: "Claude tool was denied by the Arcelle permission policy.",
        },
        {
          type: "run_failed",
          runId: "run-stream",
          error: "Claude Agent SDK run failed.",
        },
      ]),
    );
    expect(events.some((event) => event.type === "run_completed")).toBe(false);
  });

  it("keeps all pre-tool policy refusals and normal file allowances distinct", async () => {
    queryMock.mockReturnValueOnce(
      sdkQuery([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0,
        },
      ]),
    );
    const run = await new ClaudeAgentSdkRuntime("claude").startTurn(
      context({ writeEnabled: false }),
      { text: "Inspect files." },
    );
    const preTool = hooksForLastQuery()["PreToolUse"]![0]!.hooks[0]!;
    const check = async (
      tool_name: string,
      tool_input: Record<string, unknown>,
    ) =>
      (await preTool({ tool_name, tool_input } as never)) as {
        hookSpecificOutput?: {
          permissionDecision?: string;
          permissionDecisionReason?: string;
        };
      };

    await expect(
      check("Read", { file_path: "/tmp/outside.txt" }),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("inside this room"),
      },
    });
    await expect(
      check("Write", { file_path: "/tmp/Arcelle Room/note.txt" }),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: "This run is read-only.",
      },
    });
    await expect(
      check("Bash", { command: "curl https://example.test" }),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("network"),
      },
    });
    await expect(
      check("Bash", { command: "chmod +x script.sh" }),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("executable"),
      },
    });
    await expect(check("Bash", { command: "ls" })).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "ask" },
    });
    await expect(
      check("Read", { file_path: "/tmp/Arcelle Room/note.txt" }),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    await expect(check("Unknown", {})).resolves.toEqual({});
    await collectedEvents(run);
  });

  it("uses one strict per-run server while preserving native file tools and cleanup", async () => {
    const stop = vi.fn(async () => undefined);
    const exposure = {
      url: "http://127.0.0.1:4321/mcp",
      token: "private-run-token",
      instructions: "Use only registered Arcelle room tools.",
      stop,
    } satisfies NativeRoomMcpExposure;
    const sdkQuery = {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0,
        };
      },
      close: vi.fn(),
    };
    queryMock.mockReturnValueOnce(sdkQuery);
    const runtime = new ClaudeAgentSdkRuntime("claude", async () => exposure);
    const run = await runtime.startTurn(
      {
        runId: "run-1",
        roomId: "room-1",
        provider: "claude",
        model: "sonnet",
        privacyMode: "cloud-direct",
        workspacePath: "/tmp/Arcelle Room",
        runtimePath: "/tmp/Arcelle Runtime/run-1",
        writeEnabled: true,
        exposureVerified: true,
        systemPrompt: "Follow room policy.",
      },
      { text: "Organize the files." },
    );
    for await (const _event of run.events) {
      /* drain */
    }

    const request = queryMock.mock.calls[0]?.[0] as {
      options: Record<string, unknown> & {
        mcpServers: Record<string, unknown>;
        sandbox: { network: { allowedDomains: string[] } };
        systemPrompt: { append?: string };
        disallowedTools: string[];
        tools: unknown;
      };
    };
    expect(request.options.strictMcpConfig).toBe(true);
    expect(request.options.model).toBe("sonnet");
    expect(request.options.pathToClaudeCodeExecutable).toBe("claude");
    expect(request.options.mcpServers).toEqual({
      room: {
        type: "http",
        url: exposure.url,
        headers: { Authorization: `Bearer ${exposure.token}` },
        alwaysLoad: true,
      },
    });
    expect(request.options.tools).toEqual({
      type: "preset",
      preset: "claude_code",
    });
    expect(request.options.disallowedTools).toContain("Bash");
    expect(request.options.sandbox.network.allowedDomains).toEqual([
      "127.0.0.1",
    ]);
    expect(request.options.systemPrompt.append).toContain(
      "Follow room policy.",
    );
    expect(request.options.systemPrompt.append).toContain(
      exposure.instructions,
    );
    expect(request.options.systemPrompt.append).toContain(
      "Use native Read, Write, Edit, Glob, Grep, and NotebookEdit",
    );
    expect(request.options.systemPrompt.append).toContain(
      "move, rename, or delete",
    );
    expect(request.options.systemPrompt.append).toContain(
      "Arcelle Room MCP tools",
    );
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("disables nested-sandbox Bash without disabling Claude's native file tools", async () => {
    queryMock.mockReturnValueOnce({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0,
        };
      },
      close: vi.fn(),
    });
    const runtime = new ClaudeAgentSdkRuntime();
    const run = await runtime.startTurn(
      {
        runId: "run-no-bash",
        roomId: "room-1",
        provider: "claude",
        model: "sonnet",
        privacyMode: "cloud-direct",
        workspacePath: "/tmp/Arcelle Room",
        runtimePath: "/tmp/Arcelle Runtime/run-no-bash",
        writeEnabled: true,
        exposureVerified: true,
      },
      { text: "Edit and organize the notes." },
    );
    for await (const _event of run.events) {
      /* drain */
    }

    const request = queryMock.mock.calls.at(-1)?.[0] as {
      options: {
        disallowedTools: string[];
        tools: unknown;
        systemPrompt: { append: string };
      };
    };
    expect(request.options.disallowedTools).toEqual([
      "Bash",
      "WebFetch",
      "WebSearch",
    ]);
    expect(request.options.tools).toEqual({
      type: "preset",
      preset: "claude_code",
    });
    expect(request.options.systemPrompt.append).toMatch(
      /move, rename, or delete[\s\S]*Arcelle Room MCP tools/,
    );
    expect(request.options.systemPrompt.append).toContain(
      "Bash is unavailable in this runtime.",
    );
  });

  it("omits Arcelle's default model alias so Claude uses its configured model", async () => {
    queryMock.mockReturnValueOnce({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0,
        };
      },
      close: vi.fn(),
    });
    const runtime = new ClaudeAgentSdkRuntime();
    const run = await runtime.startTurn(
      {
        runId: "run-default-model",
        roomId: "room-1",
        provider: "claude",
        model: "default",
        privacyMode: "cloud-direct",
        workspacePath: "/tmp/Arcelle Room",
        runtimePath: "/tmp/Arcelle Runtime/run-default-model",
        writeEnabled: false,
        exposureVerified: true,
      },
      { text: "Review notes.md." },
    );
    for await (const _event of run.events) {
      /* drain */
    }

    const request = queryMock.mock.calls.at(-1)?.[0] as {
      options: { model?: string };
    };
    expect(request.options.model).toBeUndefined();
  });

  it("canonicalizes aliased workspace paths and reports native tool failures", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "arcelle-claude-alias-"));
    const physical = path.join(root, "physical-room");
    const alias = path.join(root, "room-alias");
    mkdirSync(physical);
    symlinkSync(physical, alias, "dir");
    let releaseResult!: () => void;
    const resultGate = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    const sdkQuery = {
      async *[Symbol.asyncIterator]() {
        await resultGate;
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0,
        };
      },
      close: vi.fn(),
    };
    queryMock.mockReturnValueOnce(sdkQuery);

    try {
      const runtime = new ClaudeAgentSdkRuntime("claude");
      const run = await runtime.startTurn(
        {
          runId: "run-alias",
          roomId: "room-alias",
          provider: "claude",
          model: "sonnet",
          privacyMode: "cloud-direct",
          workspacePath: alias,
          runtimePath: path.join(root, "runtime"),
          writeEnabled: true,
          exposureVerified: true,
        },
        { text: "Edit notes.txt." },
      );
      const request = queryMock.mock.calls.at(-1)?.[0] as {
        options: {
          cwd: string;
          sandbox: {
            filesystem: { allowRead: string[]; allowWrite: string[] };
          };
          hooks: Record<
            string,
            Array<{ hooks: Array<(...args: unknown[]) => Promise<unknown>> }>
          >;
        };
      };
      const canonical = realpathSync(physical);
      expect(request.options.cwd).toBe(canonical);
      expect(request.options.sandbox.filesystem.allowRead).toEqual([canonical]);
      expect(request.options.sandbox.filesystem.allowWrite).toEqual([
        canonical,
      ]);

      const preTool = request.options.hooks["PreToolUse"]![0]!.hooks[0]!;
      await expect(
        preTool({
          hook_event_name: "PreToolUse",
          tool_name: "Write",
          tool_input: { file_path: path.join(canonical, "notes.txt") },
          tool_use_id: "write-1",
        }),
      ).resolves.toMatchObject({
        hookSpecificOutput: { permissionDecision: "allow" },
      });

      const failedTool =
        request.options.hooks["PostToolUseFailure"]![0]!.hooks[0]!;
      await failedTool(
        {
          hook_event_name: "PostToolUseFailure",
          tool_name: "Write",
          tool_input: { file_path: path.join(canonical, "notes.txt") },
          tool_use_id: "write-1",
          error: `Sensitive diagnostic for ${canonical}`,
        },
        "write-1",
      );
      releaseResult();
      const events = [];
      for await (const event of run.events) events.push(event);
      expect(events).toContainEqual({
        type: "tool_completed",
        runId: "run-alias",
        tool: "Write",
        toolId: "write-1",
        error:
          "Claude tool failed. Provider diagnostics were omitted to protect room data.",
      });
      expect(
        events.filter(
          (event) =>
            event.type === "tool_started" && event.toolId === "write-1",
        ),
      ).toHaveLength(1);
      expect(
        events.filter(
          (event) =>
            event.type === "tool_completed" && event.toolId === "write-1",
        ),
      ).toHaveLength(1);
      expect(events.some((event) => event.type === "run_failed")).toBe(true);
      expect(events.some((event) => event.type === "run_completed")).toBe(
        false,
      );
      expect(JSON.stringify(events)).not.toContain(canonical);
    } finally {
      releaseResult();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
