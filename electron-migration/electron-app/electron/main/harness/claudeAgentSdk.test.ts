import { describe, expect, it, vi } from "vitest";
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
});
