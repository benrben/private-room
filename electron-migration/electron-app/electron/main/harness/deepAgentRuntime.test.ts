import { describe, expect, it, vi } from "vitest";
import type { RoomManagerState } from "../roomManager.js";
import type { RunViaSidecarRequest } from "../sidecar.js";
import { DeepAgentRuntime } from "./deepAgentRuntime.js";
import type { HarnessContext, HarnessEvent } from "./types.js";

function state(): RoomManagerState {
  return {
    room: {
      path: "/room",
      descriptor: { kind: "workspace-folder", roomId: "room-1", rootPath: "/room" },
      workspace: {},
      conn: {
        prepare: vi.fn(() => ({ get: vi.fn(() => ({ baseline_completed: 1, status: "running" })) })),
      },
    },
  } as unknown as RoomManagerState;
}

function context(writeEnabled = false): HarnessContext {
  return {
    runId: "run-1",
    roomId: "room-1",
    provider: "ollama-local",
    model: "qwen3:14b",
    workspacePath: "/room",
    runtimePath: "/runtime/run-1",
    privacyMode: "local",
    writeEnabled,
    exposureVerified: true,
  };
}

describe("DeepAgentRuntime", () => {
  it("starts the Python Deep Harness through a run-scoped MCP bridge and normalizes events", async () => {
    let request: RunViaSidecarRequest | null = null;
    const runSidecar = vi.fn(async (req, opts) => {
      request = req;
      opts.onEvent("ask-agent", { runId: req.runId, chatId: "", v: { id: "files.read", label: "File agent" } });
      opts.onEvent("ask-delta", { runId: req.runId, chatId: "", v: "Found it" });
      opts.onEvent("ask-token-usage", { runId: req.runId, chatId: "", v: { input_tokens: 12, output_tokens: 3 } });
      return { kind: "done" as const, text: "Found it", usage: null, plan: null };
    });
    const runtime = new DeepAgentRuntime(state(), () => {}, undefined, runSidecar);
    const started = await runtime.startTurn(context(), { text: "read notes" });
    const events: HarnessEvent[] = [];
    for await (const event of started.events) events.push(event);

    expect(request).toMatchObject({
      harness: "deep",
      model: "qwen3:14b",
      runId: "run-1",
      ollamaBaseUrl: "http://127.0.0.1:11434",
      provider: null,
      mcp: { workspaceWrite: false, baselineRunId: "" },
    });
    expect((request as unknown as RunViaSidecarRequest).mcp.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(events).toEqual(expect.arrayContaining([
      { type: "run_started", runId: "run-1", harness: "arcelle-deep" },
      { type: "agent_started", runId: "run-1", agentId: "files.read", label: "File agent" },
      { type: "text_delta", runId: "run-1", text: "Found it" },
      { type: "usage_updated", runId: "run-1", inputTokens: 12, outputTokens: 3, costUsd: undefined },
      { type: "run_completed", runId: "run-1", status: "completed" },
    ]));
  });

  it("grants write tools only with the protected run baseline", async () => {
    let request: RunViaSidecarRequest | null = null;
    const runtime = new DeepAgentRuntime(state(), () => {}, undefined, vi.fn(async (req) => {
      request = req;
      return { kind: "done" as const, text: "done", usage: null, plan: null };
    }));
    const started = await runtime.startTurn(context(true), { text: "edit notes" });
    for await (const _event of started.events) { /* drain */ }
    expect(request).toMatchObject({ mcp: { workspaceWrite: true, baselineRunId: "run-1" } });
  });
});
