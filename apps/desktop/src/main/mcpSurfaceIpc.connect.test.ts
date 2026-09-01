import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "./mcpClient.js";
import type { McpRuntime } from "./mcpSurfaceIpc.js";
import type { RoomManagerState } from "./roomManager.js";

const mocks = vi.hoisted(() => ({
  addApproval: vi.fn(),
  applyConfig: vi.fn(),
  authorize: vi.fn(),
  cachedPathPrefix: vi.fn(() => "/cached-runtimes/bin"),
  clearTokens: vi.fn(),
  configKey: vi.fn(),
  connect: vi.fn(),
  fingerprint: vi.fn(),
  forgetGrants: vi.fn(),
  getConfig: vi.fn(() => "{\"mcpServers\":{}}"),
  getSetting: vi.fn(),
  parseConfig: vi.fn(() => []),
  readApprovals: vi.fn(() => [] as string[]),
  readConnectorPowers: vi.fn(),
  readFlag: vi.fn(),
  registryOptin: vi.fn(),
  registrySearch: vi.fn(),
  removeServer: vi.fn(),
  setRegistryOptin: vi.fn(),
  setServerDisabled: vi.fn(),
  setSetting: vi.fn(),
  setToolPref: vi.fn(),
  stripBearer: vi.fn(),
  writeConnectorPower: vi.fn(),
  writeFlag: vi.fn(),
}));

vi.mock("./mcpClient.js", () => ({
  McpManager: class McpManager {},
  configKey: mocks.configKey,
  connectMcpClient: mocks.connect,
  parseMcpConfig: mocks.parseConfig,
}));

vi.mock("./runtimeCatalog.js", () => ({
  cachedPathPrefix: mocks.cachedPathPrefix,
}));

vi.mock("./mcpConfig.js", () => ({
  MCP_TOOL_PREFS_KEY: "mcp_tool_prefs",
  addMcpApproval: mocks.addApproval,
  applyMcpConfig: mocks.applyConfig,
  forgetConnectorGrants: mocks.forgetGrants,
  getMcpConfig: mocks.getConfig,
  mcpAutoApproveFile: vi.fn(),
  mcpFingerprint: mocks.fingerprint,
  mergeBearer: vi.fn(),
  mcpOutboundUnmaskFile: vi.fn(),
  readMcpApprovals: mocks.readApprovals,
  readMcpConnectorPowers: mocks.readConnectorPowers,
  readMcpFlag: mocks.readFlag,
  removeServerFromConfig: mocks.removeServer,
  requireReadableConfig: vi.fn(),
  setServerDisabled: mocks.setServerDisabled,
  setToolPref: mocks.setToolPref,
  stripBearer: mocks.stripBearer,
  writeMcpConnectorPower: mocks.writeConnectorPower,
  writeMcpFlag: mocks.writeFlag,
}));

vi.mock("./db-host/settings.js", () => ({
  getSetting: mocks.getSetting,
  setSetting: mocks.setSetting,
}));
vi.mock("./mcpRegistry.js", () => ({
  mcpRegistryOptinStatus: mocks.registryOptin,
  mcpRegistrySearch: mocks.registrySearch,
  setMcpRegistryOptin: mocks.setRegistryOptin,
}));
vi.mock("./mcpOauth.js", () => ({
  authorize: mocks.authorize,
  canRefresh: vi.fn(),
  clearTokens: mocks.clearTokens,
  loadTokens: vi.fn(),
  needsRefresh: vi.fn(),
  probeWwwAuthenticate: vi.fn(),
  saveTokens: vi.fn(),
}));

import { createMcpRuntime, registerMcpSurfaceIpc } from "./mcpSurfaceIpc.js";

function fakeConfig(kind: "http" | "stdio", disabled = false): ServerConfig {
  return kind === "http"
    ? { disabled, transport: { kind, url: `https://${disabled ? "disabled" : "connector"}.invalid/mcp`, headers: {} } }
    : { disabled, transport: { kind, command: "fake-connector", args: [], env: {} } };
}

function fakeRuntime(existing: { close: ReturnType<typeof vi.fn> }): McpRuntime {
  const manager = {
    generation: 3,
    servers: [{
      name: "previous",
      status: "connected",
      error: null,
      tools: [],
      remote: false,
      client: existing,
      configKey: "previous",
    }],
    statuses: vi.fn(function (this: { servers: Array<{ name: string; status: string; error: string | null; tools: Array<{ name: string }>; remote: boolean }> }) {
      return this.servers.map(({ name, status, error, tools, remote }) => ({
        name,
        status,
        error,
        tools: tools.map((tool) => tool.name),
        remote,
      }));
    }),
  };
  return { manager: manager as unknown as McpRuntime["manager"], sessionApprovals: new Set() };
}

describe("registerMcpSurfaceIpc reconnect with fully fake connector and IPC seams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readApprovals.mockReturnValue([]);
    mocks.configKey.mockImplementation((cfg: ServerConfig) => `${cfg.transport.kind}:${cfg.disabled}`);
    mocks.getSetting.mockReturnValue(undefined);
    mocks.setToolPref.mockReturnValue('{"servers":{}}');
    mocks.writeConnectorPower.mockReset().mockReturnValue({});
    mocks.getConfig.mockReturnValue('{"mcpServers":{}}');
    mocks.parseConfig.mockReturnValue([]);
    mocks.fingerprint.mockReturnValue("fake-fingerprint");
    mocks.setServerDisabled.mockReturnValue('{"mcpServers":{}}');
    mocks.removeServer.mockReturnValue('{"mcpServers":{}}');
    mocks.stripBearer.mockReturnValue('{"mcpServers":{}}');
  });

  it("creates isolated manager and session-approval state", () => {
    const first = createMcpRuntime();
    const second = createMcpRuntime();
    first.sessionApprovals.add("one");
    expect(first.manager).not.toBe(second.manager);
    expect(second.sessionApprovals).toEqual(new Set());
  });

  it("wires every state-changing handler through its persistence boundary", async () => {
    const handlers = new Map<string, (event?: unknown, raw?: unknown) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (event?: unknown, raw?: unknown) => unknown) => {
        handlers.set(channel, handler);
      }),
    };
    const conn = { fake: true };
    const state = {
      room: { conn, path: "/fake/room", name: "Fake", password: "unused" },
      roomEpoch: 1,
    } as unknown as RoomManagerState;
    const runtime = fakeRuntime({ close: vi.fn() });
    mocks.readFlag.mockReturnValue(true);
    mocks.readConnectorPowers.mockReturnValue({ remote: { autoApprove: true } });
    mocks.registryOptin.mockReturnValue(true);

    registerMcpSurfaceIpc(ipcMain as never, state, "/fake/user-data", vi.fn(), runtime);

    await expect(handlers.get("mcp_apply_config")?.({}, { json: '{"mcpServers":{}}' })).resolves.toEqual([]);
    await expect(handlers.get("approve_mcp")?.({}, { fingerprint: "approved" })).resolves.toEqual([]);
    expect(handlers.get("set_mcp_auto_approve")?.({}, { on: true })).toBeUndefined();
    expect(handlers.get("set_mcp_outbound_unmask")?.({}, { on: false })).toBeUndefined();
    expect(handlers.get("get_mcp_connector_powers")?.()).toBe('{"remote":{"autoApprove":true}}');
    expect(handlers.get("set_mcp_registry_optin")?.({}, { enabled: true })).toBeUndefined();
    await expect(handlers.get("mcp_set_server_enabled")?.({}, { server: "remote", enabled: true })).resolves.toEqual([]);
    await expect(handlers.get("mcp_remove_server")?.({}, { server: "remote" })).resolves.toEqual([]);
    await expect(handlers.get("mcp_oauth_sign_out")?.({}, { server: "remote" })).resolves.toEqual([]);

    expect(mocks.applyConfig).toHaveBeenCalledWith(conn, '{"mcpServers":{}}');
    expect(mocks.addApproval).toHaveBeenCalledWith("/fake/user-data", "approved");
    expect(runtime.sessionApprovals).toEqual(new Set(["fake-fingerprint", "approved"]));
    expect(mocks.writeFlag).toHaveBeenCalledTimes(2);
    expect(mocks.setRegistryOptin).toHaveBeenCalledWith("/fake/user-data", true);
    expect(mocks.setServerDisabled).toHaveBeenCalledWith('{"mcpServers":{}}', "remote", false);
    expect(mocks.forgetGrants).toHaveBeenCalledWith("/fake/user-data", runtime.sessionApprovals, "remote");
    expect(mocks.clearTokens).toHaveBeenCalledWith(conn, "remote");
  });

  it("keeps the default system-browser boundary explicit when no opener is injected", async () => {
    const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
    const ipcMain = { handle: vi.fn((channel: string, handler: (event: unknown, raw: unknown) => unknown) => handlers.set(channel, handler)) };
    const state = {
      room: { conn: {}, path: "/fake/room", name: "Fake", password: "unused" },
      roomEpoch: 1,
    } as unknown as RoomManagerState;
    const remote = fakeConfig("http");
    mocks.parseConfig.mockReturnValue([["remote", remote]]);
    mocks.authorize.mockImplementation(async (_url, _challenge, options) => {
      await options.openBrowser("https://authorize.invalid");
      return { accessToken: "never-saved" };
    });
    registerMcpSurfaceIpc(ipcMain as never, state, "/fake/user-data", vi.fn(), fakeRuntime({ close: vi.fn() }));

    await expect(handlers.get("mcp_oauth_authorize")?.({}, { server: "remote" })).rejects.toThrow(
      "No system-browser opener is available",
    );
    expect(mocks.addApproval).not.toHaveBeenCalled();
  });

  it("keeps disabled servers local, connects successful servers, and reports both error shapes", async () => {
    const handlers = new Map<string, unknown>();
    const ipcMain = { handle: vi.fn((channel: string, handler: unknown) => handlers.set(channel, handler)) };
    const existing = { close: vi.fn() };
    const runtime = fakeRuntime(existing);
    const emit = vi.fn();
    const connected = { close: vi.fn() };
    mocks.connect.mockImplementation(async (cfg: ServerConfig) => {
      if (cfg.transport.kind === "http") return { client: connected, tools: [{ name: "search" }] };
      if (cfg.disabled) throw new Error("disabled connectors must not be started");
      if (cfg.transport.command === "error") throw new Error("connector refused");
      throw "plain connector failure";
    });

    registerMcpSurfaceIpc(
      ipcMain as never,
      { room: { conn: {}, path: "/fake/room", name: "Fake", password: "unused" }, roomEpoch: 1 } as RoomManagerState,
      "/fake/user-data",
      emit,
      runtime,
    );

    expect(handlers.has("mcp_apply_config")).toBe(true);
    const failedConfig = fakeConfig("stdio");
    failedConfig.transport.command = "error";
    const statuses = await runtime.reconnect!([
      ["disabled", fakeConfig("stdio", true)],
      ["remote", fakeConfig("http")],
      ["error", failedConfig],
      ["raw", fakeConfig("stdio")],
    ]);

    expect(existing.close).toHaveBeenCalledOnce();
    expect(runtime.manager.generation).toBe(4);
    expect(mocks.connect).toHaveBeenCalledTimes(3);
    for (const [, options] of mocks.connect.mock.calls) {
      expect(options).toEqual({ cachedPathPrefix: "/cached-runtimes/bin" });
    }
    expect(emit).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual([
      { name: "disabled", status: "disabled", error: null, tools: [], remote: false },
      { name: "remote", status: "connected", error: null, tools: ["search"], remote: true },
      { name: "error", status: "failed", error: "connector refused", tools: [], remote: false },
      { name: "raw", status: "failed", error: "plain connector failure", tools: [], remote: false },
    ]);
  });

  it("stores a fabricated tool preference without reconnecting a connector", () => {
    const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (event: unknown, raw: unknown) => unknown) => {
        handlers.set(channel, handler);
      }),
    };
    const runtime = fakeRuntime({ close: vi.fn() });
    const state = {
      room: { conn: { fake: true }, path: "/fake/room", name: "Fake", password: "unused" },
      roomEpoch: 1,
    } as RoomManagerState;
    mocks.getSetting.mockReturnValueOnce(undefined).mockReturnValueOnce("{\"existing\":true}");
    mocks.setToolPref
      .mockReturnValueOnce("{\"servers\":{\"writer\":{\"summarize\":true}}}")
      .mockReturnValueOnce("{\"servers\":{\"42\":{\"\":false}}}");

    registerMcpSurfaceIpc(ipcMain as never, state, "/fake/user-data", vi.fn(), runtime);
    const setToolEnabled = handlers.get("mcp_set_tool_enabled")!;

    expect(setToolEnabled({}, { server: "writer", tool: "summarize", enabled: true })).toBe(
      "{\"servers\":{\"writer\":{\"summarize\":true}}}",
    );
    expect(setToolEnabled({}, { server: 42, tool: null, enabled: "true" })).toBe(
      "{\"servers\":{\"42\":{\"\":false}}}",
    );
    expect(mocks.setToolPref.mock.calls).toEqual([
      ["{}", "writer", "summarize", true],
      ["{\"existing\":true}", "42", "", false],
    ]);
    expect(mocks.setSetting.mock.calls).toEqual([
      [state.room!.conn, "mcp_tool_prefs", "{\"servers\":{\"writer\":{\"summarize\":true}}}"],
      [state.room!.conn, "mcp_tool_prefs", "{\"servers\":{\"42\":{\"\":false}}}"],
    ]);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("writes connector-power choices from fabricated IPC values without reconnecting", () => {
    const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (event: unknown, raw: unknown) => unknown) => {
        handlers.set(channel, handler);
      }),
    };
    const runtime = fakeRuntime({ close: vi.fn() });
    const state = {
      room: { conn: { fake: true }, path: "/fake/room", name: "Fake", password: "unused" },
      roomEpoch: 1,
    } as RoomManagerState;
    mocks.writeConnectorPower
      .mockReturnValueOnce({ writer: { auto_approve: true } })
      .mockReturnValueOnce({ "42": {} })
      .mockImplementationOnce(() => { throw new Error("fabricated connector-power write failure"); });

    registerMcpSurfaceIpc(ipcMain as never, state, "/fake/user-data", vi.fn(), runtime);
    const setConnectorPower = handlers.get("set_mcp_connector_power");
    if (!setConnectorPower) throw new Error("connector-power handler missing");

    expect(setConnectorPower({}, { server: "writer", power: "auto_approve", value: true })).toEqual({
      writer: { auto_approve: true },
    });
    expect(setConnectorPower({}, { server: 42, power: null, value: "true" })).toEqual({ "42": {} });
    expect(() => setConnectorPower({}, null)).toThrow("fabricated connector-power write failure");
    expect(mocks.writeConnectorPower.mock.calls).toEqual([
      ["/fake/user-data", "writer", "auto_approve", true],
      ["/fake/user-data", "42", "", null],
      ["/fake/user-data", "", "", null],
    ]);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(runtime.manager.generation).toBe(3);
  });

  it("forwards only string query and numeric limit registry-search values through fake IPC", async () => {
    const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (event: unknown, raw: unknown) => Promise<unknown>) => {
        handlers.set(channel, handler);
      }),
    };
    const runtime = fakeRuntime({ close: vi.fn() });
    const state = {
      room: { conn: { fake: true }, path: "/fake/room", name: "Fake", password: "unused" },
      roomEpoch: 1,
    } as RoomManagerState;
    const listing = { name: "fake-search-result" };
    mocks.registrySearch
      .mockResolvedValueOnce([listing])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("fabricated registry failure"));

    registerMcpSurfaceIpc(ipcMain as never, state, "/fake/user-data", vi.fn(), runtime);
    const registrySearch = handlers.get("mcp_registry_search");
    if (!registrySearch) throw new Error("registry-search handler missing");

    await expect(registrySearch({}, { query: "notes", limit: 12 })).resolves.toEqual([listing]);
    await expect(registrySearch({}, { query: 42, limit: "12" })).resolves.toEqual([]);
    await expect(registrySearch({}, null)).rejects.toThrow("fabricated registry failure");

    expect(mocks.registrySearch.mock.calls).toEqual([
      ["/fake/user-data", "notes", 12],
      ["/fake/user-data", undefined, undefined],
      ["/fake/user-data", undefined, undefined],
    ]);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(runtime.manager.generation).toBe(3);
  });
});
