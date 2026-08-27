import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NativeRoomMcpExposure } from "./nativeRoomMcp.js";

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const original = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...original, query: queryMock };
});

import { ClaudeAgentSdkRuntime } from "./claudeAgentSdk.js";

describe("Claude native Room MCP wiring", () => {
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
    const run = await runtime.startTurn({
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
    }, { text: "Organize the files." });
    for await (const _event of run.events) { /* drain */ }

    const request = queryMock.mock.calls[0]?.[0] as {
      options: Record<string, unknown> & {
        mcpServers: Record<string, unknown>;
        sandbox: { network: { allowedDomains: string[] } };
        systemPrompt: { append?: string };
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
    expect(request.options.tools).toEqual({ type: "preset", preset: "claude_code" });
    expect(request.options.sandbox.network.allowedDomains).toEqual(["127.0.0.1"]);
    expect(request.options.systemPrompt.append).toContain("Follow room policy.");
    expect(request.options.systemPrompt.append).toContain(exposure.instructions);
    expect(stop).toHaveBeenCalledTimes(1);
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
    const run = await runtime.startTurn({
      runId: "run-default-model",
      roomId: "room-1",
      provider: "claude",
      model: "default",
      privacyMode: "cloud-direct",
      workspacePath: "/tmp/Arcelle Room",
      runtimePath: "/tmp/Arcelle Runtime/run-default-model",
      writeEnabled: false,
      exposureVerified: true,
    }, { text: "Review notes.md." });
    for await (const _event of run.events) { /* drain */ }

    const request = queryMock.mock.calls.at(-1)?.[0] as { options: { model?: string } };
    expect(request.options.model).toBeUndefined();
  });

  it("canonicalizes aliased workspace paths and reports native tool failures", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "arcelle-claude-alias-"));
    const physical = path.join(root, "physical-room");
    const alias = path.join(root, "room-alias");
    mkdirSync(physical);
    symlinkSync(physical, alias, "dir");
    let releaseResult!: () => void;
    const resultGate = new Promise<void>((resolve) => { releaseResult = resolve; });
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
      const run = await runtime.startTurn({
        runId: "run-alias",
        roomId: "room-alias",
        provider: "claude",
        model: "sonnet",
        privacyMode: "cloud-direct",
        workspacePath: alias,
        runtimePath: path.join(root, "runtime"),
        writeEnabled: true,
        exposureVerified: true,
      }, { text: "Edit notes.txt." });
      const request = queryMock.mock.calls.at(-1)?.[0] as {
        options: {
          cwd: string;
          sandbox: { filesystem: { allowRead: string[]; allowWrite: string[] } };
          hooks: Record<string, Array<{ hooks: Array<(...args: unknown[]) => Promise<unknown>> }>>;
        };
      };
      const canonical = realpathSync(physical);
      expect(request.options.cwd).toBe(canonical);
      expect(request.options.sandbox.filesystem.allowRead).toEqual([canonical]);
      expect(request.options.sandbox.filesystem.allowWrite).toEqual([canonical]);

      const preTool = request.options.hooks["PreToolUse"]![0]!.hooks[0]!;
      await expect(preTool({
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: path.join(canonical, "notes.txt") },
        tool_use_id: "write-1",
      })).resolves.toMatchObject({
        hookSpecificOutput: { permissionDecision: "allow" },
      });

      const failedTool = request.options.hooks["PostToolUseFailure"]![0]!.hooks[0]!;
      await failedTool({
        hook_event_name: "PostToolUseFailure",
        tool_name: "Write",
        tool_input: { file_path: path.join(canonical, "notes.txt") },
        tool_use_id: "write-1",
        error: `Sensitive diagnostic for ${canonical}`,
      }, "write-1");
      releaseResult();
      const events = [];
      for await (const event of run.events) events.push(event);
      expect(events).toContainEqual({
        type: "tool_completed",
        runId: "run-alias",
        tool: "Write",
        toolId: "write-1",
        error: "Claude tool failed. Provider diagnostics were omitted to protect room data.",
      });
      expect(events.filter((event) => event.type === "tool_started" && event.toolId === "write-1")).toHaveLength(1);
      expect(events.filter((event) => event.type === "tool_completed" && event.toolId === "write-1")).toHaveLength(1);
      expect(events.some((event) => event.type === "run_failed")).toBe(true);
      expect(events.some((event) => event.type === "run_completed")).toBe(false);
      expect(JSON.stringify(events)).not.toContain(canonical);
    } finally {
      releaseResult();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
