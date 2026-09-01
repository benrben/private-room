import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDownloadEngineDeps: vi.fn(() => ({})),
  createLiveRuntimeTool: vi.fn(),
  effectivePower: vi.fn(),
  forgetConnectorGrants: vi.fn(),
  mcpAutoApproveFile: vi.fn(() => "/fake/auto-approve"),
  mcpOutboundUnmaskFile: vi.fn(() => "/fake/outbound-unmask"),
  readMcpConnectorPowers: vi.fn(),
  readMcpFlag: vi.fn(),
  remoteSeamRedactor: vi.fn(() => null),
}));

vi.mock("./mediaDownloadSurfaceIpc.js", () => ({ createDownloadEngineDeps: mocks.createDownloadEngineDeps }));
vi.mock("./liveRuntimeTools.js", () => ({ createLiveRuntimeTool: mocks.createLiveRuntimeTool }));
vi.mock("./mcpConfig.js", () => ({
  MCP_CONFIG_KEY: "mcp_config",
  MCP_TOOL_PREFS_KEY: "mcp_tool_prefs",
  effectivePower: mocks.effectivePower,
  forgetConnectorGrants: mocks.forgetConnectorGrants,
  mcpAutoApproveFile: mocks.mcpAutoApproveFile,
  mcpOutboundUnmaskFile: mocks.mcpOutboundUnmaskFile,
  parseToolPrefs: vi.fn(() => ({})),
  readMcpConnectorPowers: mocks.readMcpConnectorPowers,
  readMcpFlag: mocks.readMcpFlag,
}));
vi.mock("./privacy.js", () => ({ remoteSeamRedactor: mocks.remoteSeamRedactor }));

import { createAgentUiRuntime } from "./agentUiSurfaceIpc.js";
import { applyLiveAppServices, createLiveStudioDeps, type LiveAppServices } from "./liveAppServices.js";
import { createRoomManagerState } from "./roomManager.js";

const route = { serverName: "fabricated", toolName: "lookup" } as never;

function serviceFakes(): LiveAppServices {
  return {
    roomDeps: {},
    userDataDir: "/fake",
    mcp: { manager: { servers: [], statuses: () => [] } },
    agentUi: createAgentUiRuntime(),
    files: {},
    browser: {},
    sttModelState: {},
    resourcesPath: null,
    runtimeTool: vi.fn(),
  } as unknown as LiveAppServices;
}

function connectorRuntime(servers: unknown[]) {
  const services = serviceFakes();
  (services.mcp.manager as unknown as { servers: unknown[] }).servers = servers;
  const runtime = applyLiveAppServices({} as never, createRoomManagerState(), vi.fn(), services);
  if (runtime.callConnectorTool === undefined) throw new Error("connector tool callback was not installed");
  return runtime.callConnectorTool;
}

function connector(name: string, client: unknown) {
  return { name, status: "connected", client, remote: false, tools: [] };
}

function approvalRuntime(onRequest?: (payload: Record<string, unknown>, state: ReturnType<typeof createRoomManagerState>) => void) {
  const state = createRoomManagerState();
  const emit = vi.fn((event: string, payload: Record<string, unknown>) => {
    if (event === "mcp-approve-request") onRequest?.(payload, state);
  });
  const runtime = applyLiveAppServices({} as never, state, emit, serviceFakes());
  if (!runtime.connectorApproved) throw new Error("approval callback was not installed");
  return { state, emit, connectorApproved: runtime.connectorApproved };
}

beforeEach(() => {
  mocks.effectivePower.mockReset().mockReturnValue(false);
  mocks.mcpAutoApproveFile.mockClear();
  mocks.readMcpConnectorPowers.mockReset().mockReturnValue({});
  mocks.readMcpFlag.mockReset().mockReturnValue(false);
  mocks.remoteSeamRedactor.mockClear();
  mocks.forgetConnectorGrants.mockReset().mockReturnValue(0);
});

describe("live connector approval", () => {
  it("allows an already approved fabricated connector without prompting again", async () => {
    const runtime = approvalRuntime();
    runtime.state.mcpSessionOk.add("fabricated");

    await expect(runtime.connectorApproved(route, { query: "private" })).resolves.toBe(true);

    expect(runtime.emit).not.toHaveBeenCalled();
    expect(mocks.readMcpConnectorPowers).not.toHaveBeenCalled();
  });

  it("allows a fabricated connector covered by its configured auto-approval power", async () => {
    mocks.effectivePower.mockReturnValue(true);
    const runtime = approvalRuntime();

    await expect(runtime.connectorApproved(route, { query: "private" })).resolves.toBe(true);

    expect(runtime.emit).not.toHaveBeenCalled();
    expect(mocks.mcpAutoApproveFile).toHaveBeenCalledWith("/fake");
  });

  it("remembers an explicit fabricated approval and omits the next consent request", async () => {
    const runtime = approvalRuntime((payload, state) => {
      state.mcpPending.get(String(payload.id))?.({ approved: true, remember: true });
    });

    await expect(runtime.connectorApproved(route, { query: "private" })).resolves.toBe(true);
    await expect(runtime.connectorApproved(route, { query: "private" })).resolves.toBe(true);

    expect(runtime.emit).toHaveBeenCalledTimes(1);
    expect(runtime.emit).toHaveBeenCalledWith("mcp-approve-request", expect.objectContaining({
      server: "fabricated",
      tool: "lookup",
      args: '{\n  "query": "private"\n}',
    }));
    expect(runtime.state.mcpSessionOk.has("fabricated")).toBe(true);
  });

  it("returns a fabricated declined consent without remembering the connector", async () => {
    const runtime = approvalRuntime((payload, state) => {
      state.mcpPending.get(String(payload.id))?.({ approved: false, remember: true });
    });

    await expect(runtime.connectorApproved(route, {})).resolves.toBe(false);

    expect(runtime.state.mcpSessionOk.has("fabricated")).toBe(false);
  });

  it("times out an unanswered connector consent and clears the pending request", async () => {
    vi.useFakeTimers();
    try {
      const runtime = approvalRuntime();
      const approval = runtime.connectorApproved(route, {});
      await vi.runAllTimersAsync();
      await expect(approval).resolves.toBe(false);
      expect(runtime.state.mcpPending).toEqual(new Map());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("live application dependency wiring", () => {
  it("exposes the current workspace room to both tool and Studio dependencies", () => {
    const state = createRoomManagerState();
    const workspace = { kind: "fabricated workspace" };
    const db = {
      kind: "db",
      prepare: vi.fn(() => ({ raw: () => ({ get: () => undefined }) })),
    };
    state.room = { conn: db, path: "/room", name: "Room", workspace } as never;
    const services = serviceFakes();
    services.roomDeps.jobQueue = { kind: "queue" } as never;

    const runtime = applyLiveAppServices({} as never, state, vi.fn(), services);

    expect(runtime.currentRoom?.()).toEqual({ db, path: "/room", workspace });
    expect(runtime.runStudioDeps?.rooms.current()).toEqual({ db, path: "/room", name: "Room", workspace });
    expect(runtime.downloadJob).toBeDefined();
    expect(runtime.workflowRun).toBeDefined();
  });

  it("returns null from both live room views after the room closes", () => {
    const state = createRoomManagerState();
    const runtime = applyLiveAppServices({} as never, state, vi.fn(), serviceFakes());
    expect(runtime.currentRoom?.()).toBeNull();
    expect(createLiveStudioDeps(state, vi.fn()).rooms.current()).toBeNull();
  });

  it("routes normal UI requests, destructive consent, and grant removal through live state", async () => {
    const state = createRoomManagerState();
    const services = serviceFakes();
    mocks.forgetConnectorGrants.mockReturnValue(3);
    const emit = vi.fn((event: string, payload: Record<string, unknown>) => {
      if (event === "agent-ui-request") {
        services.agentUi.pending.get(String(payload.id))?.({ snapshot: "fabricated" });
      }
      if (event === "mcp-approve-request") {
        state.mcpPending.get(String(payload.id))?.({ approved: true, remember: false });
      }
    });
    const runtime = applyLiveAppServices({} as never, state, emit, services);

    await expect(runtime.agentUi?.("ui_snapshot", {})).resolves.toEqual({ snapshot: "fabricated" });
    await expect(runtime.agentUi?.("media_frame", {})).rejects.toThrow("No room is open");
    await expect(runtime.confirmDestructive?.("delete", "file", "cannot be undone")).resolves.toBe(true);
    expect(runtime.mcpForgetConnectorGrants?.("fabricated")).toEqual({ cleared: 3 });
    expect(mocks.forgetConnectorGrants).toHaveBeenCalledWith("/fake", state.mcpSessionOk, "fabricated");
  });

  it("uses connector-specific outbound power and the live remote redaction seam", () => {
    mocks.readMcpConnectorPowers.mockReturnValue({ fabricated: { outboundUnmask: true } });
    mocks.effectivePower.mockReturnValue(true);
    mocks.remoteSeamRedactor.mockReturnValue({
      redactor: {
        redactValue: vi.fn((value: unknown, report: { entitiesHidden: number }) => {
          report.entitiesHidden = 2;
          return { protected: value };
        }),
        restore: vi.fn((text: string) => `restored:${text}`),
      },
    });
    const runtime = applyLiveAppServices({} as never, createRoomManagerState(), vi.fn(), serviceFakes());

    expect(runtime.outboundUnmaskFor?.("fabricated")).toBe(true);
    expect(mocks.mcpOutboundUnmaskFile).toHaveBeenCalledWith("/fake");
    expect(runtime.remoteSeam?.redactValue({ secret: "Ada" })).toEqual({
      value: { protected: { secret: "Ada" } },
      entitiesHidden: 2,
    });
    expect(runtime.remoteSeam?.restore("token")).toBe("restored:token");
  });
});

describe("live connector tool calls", () => {
  it("passes a validated fabricated route and arguments to its connected client", async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "fabricated result" }] });
    const callConnectorTool = connectorRuntime([connector("fabricated", { callTool })]);
    const args = { query: "fabricated query" };

    await expect(callConnectorTool(route, args)).resolves.toEqual({
      content: [{ type: "text", text: "fabricated result" }],
    });
    expect(callTool).toHaveBeenCalledWith("lookup", args);
  });

  it.each([
    ["a missing connector", []],
    ["a connector without a client", [connector("fabricated", null)]],
  ])("maps %s to the unavailable connector error", async (_label, servers) => {
    const callConnectorTool = connectorRuntime(servers);

    await expect(callConnectorTool(route, {})).rejects.toThrow("Connector “fabricated” is no longer connected.");
  });

  it("preserves a fabricated connector refusal", async () => {
    const refusal = new Error("fabricated connector refused the tool");
    const callTool = vi.fn().mockRejectedValue(refusal);
    const callConnectorTool = connectorRuntime([connector("fabricated", { callTool })]);

    await expect(callConnectorTool(route, { query: "fabricated query" })).rejects.toBe(refusal);
    expect(callTool).toHaveBeenCalledWith("lookup", { query: "fabricated query" });
  });
});
