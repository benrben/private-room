import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpRuntime } from "./mcpSurfaceIpc.js";
import type { RoomManagerState } from "./roomManager.js";

const fakes = vi.hoisted(() => ({
  canRefresh: vi.fn(),
  getSetting: vi.fn(),
  loadTokens: vi.fn(),
  needsRefresh: vi.fn(),
  readMcpApprovals: vi.fn(() => [] as string[]),
}));

vi.mock("./mcpClient.js", () => ({
  McpManager: class McpManager {},
  configKey: vi.fn(),
  connectMcpClient: vi.fn(),
  parseMcpConfig: vi.fn(() => []),
}));
vi.mock("./mcpConfig.js", () => ({
  MCP_TOOL_PREFS_KEY: "mcp_tool_prefs",
  addMcpApproval: vi.fn(),
  applyMcpConfig: vi.fn(),
  forgetConnectorGrants: vi.fn(),
  getMcpConfig: vi.fn(),
  mcpAutoApproveFile: vi.fn(),
  mcpFingerprint: vi.fn(),
  mergeBearer: vi.fn(),
  mcpOutboundUnmaskFile: vi.fn(),
  readMcpApprovals: fakes.readMcpApprovals,
  readMcpConnectorPowers: vi.fn(),
  readMcpFlag: vi.fn(),
  removeServerFromConfig: vi.fn(),
  requireReadableConfig: vi.fn(),
  setServerDisabled: vi.fn(),
  setToolPref: vi.fn(),
  stripBearer: vi.fn(),
  writeMcpConnectorPower: vi.fn(),
  writeMcpFlag: vi.fn(),
}));
vi.mock("./db-host/settings.js", () => ({ getSetting: fakes.getSetting, setSetting: vi.fn() }));
vi.mock("./mcpRegistry.js", () => ({
  mcpRegistryOptinStatus: vi.fn(),
  mcpRegistrySearch: vi.fn(),
  setMcpRegistryOptin: vi.fn(),
}));
vi.mock("./mcpOauth.js", () => ({
  authorize: vi.fn(),
  canRefresh: fakes.canRefresh,
  clearTokens: vi.fn(),
  loadTokens: fakes.loadTokens,
  needsRefresh: fakes.needsRefresh,
  probeWwwAuthenticate: vi.fn(),
  saveTokens: vi.fn(),
}));

import { registerMcpSurfaceIpc } from "./mcpSurfaceIpc.js";

type OAuthStatusHandler = (event: unknown, raw: unknown) => boolean;

function oauthStatusHandler(): { handler: OAuthStatusHandler; conn: object } {
  const handlers = new Map<string, OAuthStatusHandler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: OAuthStatusHandler) => handlers.set(channel, handler)),
  };
  const conn = { fake: "mcp-db" };
  const runtime: McpRuntime = {
    manager: {} as McpRuntime["manager"],
    sessionApprovals: new Set(),
  };
  const state = {
    room: { conn, path: "/fabricated/room.roomai", name: "Fabricated", password: "unused" },
    roomEpoch: 1,
  } as unknown as RoomManagerState;

  registerMcpSurfaceIpc(ipcMain as never, state, "/fabricated/user-data", vi.fn(), runtime);
  const handler = handlers.get("mcp_oauth_status");
  if (handler === undefined) throw new Error("mcp_oauth_status handler was not registered");
  return { handler, conn };
}

beforeEach(() => {
  vi.clearAllMocks();
  fakes.readMcpApprovals.mockReturnValue([]);
});

describe("mcp_oauth_status with fabricated credential state", () => {
  it("reports false for an absent fabricated token without evaluating refresh state", () => {
    const { handler, conn } = oauthStatusHandler();
    fakes.loadTokens.mockReturnValue(null);

    expect(handler({}, null)).toBe(false);

    expect(fakes.loadTokens).toHaveBeenCalledWith(conn, "");
    expect(fakes.needsRefresh).not.toHaveBeenCalled();
    expect(fakes.canRefresh).not.toHaveBeenCalled();
  });

  it("reports true for a fabricated fresh token without asking whether it can refresh", () => {
    const { handler, conn } = oauthStatusHandler();
    const token = { accessToken: "fabricated-fresh" };
    fakes.loadTokens.mockReturnValue(token);
    fakes.needsRefresh.mockReturnValue(false);

    expect(handler({}, { server: "remote" })).toBe(true);

    expect(fakes.loadTokens).toHaveBeenCalledWith(conn, "remote");
    expect(fakes.needsRefresh).toHaveBeenCalledWith(token);
    expect(fakes.canRefresh).not.toHaveBeenCalled();
  });

  it("reports true for an expired fabricated token that can refresh", () => {
    const { handler, conn } = oauthStatusHandler();
    const token = { accessToken: "fabricated-expired", refreshToken: "fabricated-refresh" };
    fakes.loadTokens.mockReturnValue(token);
    fakes.needsRefresh.mockReturnValue(true);
    fakes.canRefresh.mockReturnValue(true);

    expect(handler({}, { server: 42 })).toBe(true);

    expect(fakes.loadTokens).toHaveBeenCalledWith(conn, "42");
    expect(fakes.canRefresh).toHaveBeenCalledWith(token);
  });

  it("reports false for an expired fabricated token that cannot refresh", () => {
    const { handler } = oauthStatusHandler();
    const token = { accessToken: "fabricated-expired" };
    fakes.loadTokens.mockReturnValue(token);
    fakes.needsRefresh.mockReturnValue(true);
    fakes.canRefresh.mockReturnValue(false);

    expect(handler({}, { server: "remote" })).toBe(false);
  });
});
