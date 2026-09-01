import { describe, expect, it, vi } from "vitest";
import type { McpRuntime } from "./mcpSurfaceIpc.js";
import type { RoomManagerState } from "./roomManager.js";

const mocks = vi.hoisted(() => ({
  addApproval: vi.fn(),
  authorize: vi.fn(),
  fingerprint: vi.fn(),
  getConfig: vi.fn(),
  mergeBearer: vi.fn(),
  probe: vi.fn(),
  saveTokens: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock("./mcpConfig.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./mcpConfig.js")>(),
  addMcpApproval: mocks.addApproval,
  getMcpConfig: mocks.getConfig,
  mcpFingerprint: mocks.fingerprint,
  mergeBearer: mocks.mergeBearer,
}));
vi.mock("./mcpOauth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./mcpOauth.js")>(),
  authorize: mocks.authorize,
  probeWwwAuthenticate: mocks.probe,
  saveTokens: mocks.saveTokens,
}));
vi.mock("./db-host/settings.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./db-host/settings.js")>(),
  setSetting: mocks.setSetting,
}));

import { authorizeMcpConnector } from "./mcpSurfaceIpc.js";

const REMOTE_CONFIG = JSON.stringify({
  mcpServers: {
    remote: { type: "http", url: "https://connector.invalid/mcp", headers: {} },
  },
});

function fakeState(): RoomManagerState {
  return {
    room: { conn: { fake: true }, path: "/fake/room.roomai", name: "Fake", password: "unused" },
    roomEpoch: 7,
  } as unknown as RoomManagerState;
}

function fakeRuntime(): McpRuntime {
  return { manager: {} as McpRuntime["manager"], sessionApprovals: new Set() };
}

function setupHappyPath(state: RoomManagerState) {
  const token = { accessToken: "fake-access", refreshToken: "fake-refresh" };
  mocks.getConfig.mockReturnValue(REMOTE_CONFIG);
  mocks.probe.mockResolvedValue("Bearer fake challenge");
  mocks.mergeBearer.mockReturnValue(REMOTE_CONFIG);
  mocks.fingerprint.mockReturnValue("fake-fingerprint");
  mocks.authorize.mockImplementation(async (_url, _challenge, options) => {
    await options.openBrowser("https://auth.invalid/authorize");
    options.onAuthorizeUrl("https://auth.invalid/authorize");
    return token;
  });
  return token;
}

describe("authorizeMcpConnector with injected OAuth fakes", () => {
  it("preserves challenge, browser/event, token-save, approval, and reconnect ordering", async () => {
    vi.clearAllMocks();
    const state = fakeState();
    const runtime = fakeRuntime();
    const token = setupHappyPath(state);
    const openBrowser = vi.fn();
    const emit = vi.fn();
    const reconnect = vi.fn(async () => [{ name: "remote", status: "disabled" }]);

    await expect(authorizeMcpConnector({
      state,
      userDataDir: "/fake/user-data",
      emit,
      runtime,
      openBrowser,
      reconnect,
      server: "remote",
    })).resolves.toEqual([{ name: "remote", status: "disabled" }]);

    expect(mocks.probe).toHaveBeenCalledWith("https://connector.invalid/mcp");
    expect(openBrowser).toHaveBeenCalledWith("https://auth.invalid/authorize");
    expect(emit).toHaveBeenCalledWith("mcp-oauth-url", {
      server: "remote",
      url: "https://auth.invalid/authorize",
    });
    expect(mocks.saveTokens).toHaveBeenCalledWith(state.room!.conn, "remote", token);
    expect(mocks.mergeBearer).toHaveBeenCalledWith(REMOTE_CONFIG, "remote", "fake-access");
    expect(mocks.setSetting).toHaveBeenCalledWith(state.room!.conn, "mcp_config", REMOTE_CONFIG);
    expect(mocks.addApproval).toHaveBeenCalledWith("/fake/user-data", "fake-fingerprint");
    expect(runtime.sessionApprovals).toEqual(new Set(["fake-fingerprint"]));
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("does not save credentials or reconnect when the room changes during fake authorization", async () => {
    vi.clearAllMocks();
    const state = fakeState();
    const runtime = fakeRuntime();
    setupHappyPath(state);
    mocks.authorize.mockImplementationOnce(async () => {
      state.room = null;
      return { accessToken: "fake-access" };
    });
    const reconnect = vi.fn();

    await expect(authorizeMcpConnector({
      state,
      userDataDir: "/fake/user-data",
      emit: vi.fn(),
      runtime,
      openBrowser: vi.fn(),
      reconnect,
      server: "remote",
    })).rejects.toThrow('The room this sign-in belongs to was closed while the browser was open');

    expect(mocks.saveTokens).not.toHaveBeenCalled();
    expect(mocks.setSetting).not.toHaveBeenCalled();
    expect(mocks.addApproval).not.toHaveBeenCalled();
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("refuses a local connector before any fake OAuth request or browser action", async () => {
    vi.clearAllMocks();
    const state = fakeState();
    mocks.getConfig.mockReturnValue(JSON.stringify({
      mcpServers: { local: { command: "never-run", args: [] } },
    }));
    const openBrowser = vi.fn();

    await expect(authorizeMcpConnector({
      state,
      userDataDir: "/fake/user-data",
      emit: vi.fn(),
      runtime: fakeRuntime(),
      openBrowser,
      reconnect: vi.fn(),
      server: "local",
    })).rejects.toThrow('"local" is not a remote connector in this room.');

    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
  });
});
