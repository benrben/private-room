import { describe, expect, it, vi } from "vitest";
import type { RoomManagerState } from "../roomManager.js";
import type { RunViaSidecarRequest } from "../sidecar.js";
import { DeepAgentRuntime } from "./deepAgentRuntime.js";
import type { CloudPrivacyWorkspaceOptions, WorkspaceCalls } from "./legacyCli.js";
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
      temperature: 0,
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
    expect(request).toMatchObject({
      mcp: { workspaceWrite: true, baselineRunId: "run-1" },
      routing: { write: true },
    });
  });

  it("binds cloud Deep file tools to the redacted mirror instead of the real room", async () => {
    let request: RunViaSidecarRequest | null = null;
    const mirrorFactory = vi.fn(() => ({ call: vi.fn(async () => ({})) }));
    const runtime = new DeepAgentRuntime(
      state(),
      () => {},
      undefined,
      vi.fn(async (req) => {
        request = req;
        return { kind: "done" as const, text: "done", usage: null, plan: null };
      }),
      mirrorFactory,
    );
    const started = await runtime.startTurn({
      ...context(true),
      provider: "ollama-cloud",
      model: "gpt-oss:120b-cloud",
      privacyMode: "cloud-redacted",
      workspacePath: "/private/redacted-mirror",
    }, { text: "please make the requested change" });
    for await (const _event of started.events) { /* drain */ }

    expect(mirrorFactory).toHaveBeenCalledWith("/private/redacted-mirror", true);
    expect(request).toMatchObject({ routing: { write: true } });
  });

  it("keeps workspace operations on the mirror but routes standard binary organization to the protected room", async () => {
    const mirror = { call: vi.fn(async () => ({ backend: "mirror" })) };
    const hybrid = { call: vi.fn(async () => ({ backend: "hybrid" })) };
    const mirrorFactory = vi.fn(() => mirror);
    let selectedMirror: WorkspaceCalls | null = null;
    let selectedReal: WorkspaceCalls | null = null;
    let selectedOptions: CloudPrivacyWorkspaceOptions | null = null;
    const hybridFactory = vi.fn((
      mirrorBackend: WorkspaceCalls,
      realBackend: WorkspaceCalls,
      options?: CloudPrivacyWorkspaceOptions,
    ) => {
      selectedMirror = mirrorBackend;
      selectedReal = realBackend;
      selectedOptions = options ?? null;
      return hybrid;
    });
    let request: RunViaSidecarRequest | null = null;
    const runtime = new DeepAgentRuntime(
      state(),
      () => {},
      undefined,
      vi.fn(async (req) => {
        request = req;
        return { kind: "done" as const, text: "done", usage: null, plan: null };
      }),
      mirrorFactory,
      hybridFactory,
    );
    const started = await runtime.startTurn({
      ...context(true),
      provider: "ollama-cloud",
      model: "gpt-oss:120b-cloud",
      privacyMode: "cloud-redacted",
      workspacePath: "/private/redacted-mirror",
    }, { text: "organize the PDF" });
    for await (const _event of started.events) { /* drain */ }

    expect(mirrorFactory).toHaveBeenCalledWith("/private/redacted-mirror", true);
    expect(hybridFactory).toHaveBeenCalledTimes(1);
    expect(selectedMirror).toBe(mirror);
    expect(selectedReal).toEqual(expect.objectContaining({ call: expect.any(Function) }));
    expect(selectedOptions).toEqual({ routeExactMoveRenameToReal: true });
    expect(request).toMatchObject({ routing: { write: true } });
  });

  it("does not forward raw sidecar failures into normalized events", async () => {
    const secret = "Ben Reich Bearer secret-token /room/private.txt";
    const runtime = new DeepAgentRuntime(state(), () => {}, undefined, vi.fn(async () => ({
      kind: "failed" as const,
      error: secret,
      text: "",
      toolRan: false,
      usage: null,
      plan: null,
    })));
    const started = await runtime.startTurn(context(), { text: "read notes" });
    const events: HarnessEvent[] = [];
    for await (const event of started.events) events.push(event);
    const failure = events.find((event) => event.type === "run_failed");
    expect(failure).toMatchObject({ type: "run_failed", runId: "run-1" });
    expect(JSON.stringify(failure)).not.toContain("Ben Reich");
    expect(JSON.stringify(failure)).not.toContain("secret-token");
    expect(JSON.stringify(failure)).not.toContain("/room/private.txt");
  });

  it("does not forward failed specialist report text as a tool error or result", async () => {
    const secret = "Ben Reich Bearer secret-token /room/private.txt";
    const runtime = new DeepAgentRuntime(state(), () => {}, undefined, vi.fn(async (req, opts) => {
      opts.onEvent("ask-report", { runId: req.runId, chatId: "", v: { node: "files.read", ok: false, text: secret } });
      return { kind: "done" as const, text: "", usage: null, plan: null };
    }));
    const started = await runtime.startTurn(context(), { text: "read notes" });
    const events: HarnessEvent[] = [];
    for await (const event of started.events) events.push(event);
    const tool = events.find((event) => event.type === "tool_completed");
    expect(tool).toMatchObject({ type: "tool_completed", tool: "files.read" });
    expect(JSON.stringify(tool)).not.toContain("Ben Reich");
    expect(JSON.stringify(tool)).not.toContain("secret-token");
    expect(JSON.stringify(tool)).not.toContain("/room/private.txt");
  });
});
