/** Live connector configuration, approval and connection-manager IPC. */

import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { RoomManagerState } from "./roomManager.js";
import {
  McpManager,
  configKey,
  connectMcpClient,
  parseMcpConfig,
  type ManagerServerEntry,
  type ServerConfig,
} from "./mcpClient.js";
import {
  MCP_TOOL_PREFS_KEY,
  addMcpApproval,
  applyMcpConfig,
  forgetConnectorGrants,
  getMcpConfig,
  mcpAutoApproveFile,
  mcpFingerprint,
  mergeBearer,
  mcpOutboundUnmaskFile,
  readMcpApprovals,
  readMcpConnectorPowers,
  readMcpFlag,
  removeServerFromConfig,
  requireReadableConfig,
  setServerDisabled,
  setToolPref,
  stripBearer,
  writeMcpFlag,
  writeMcpConnectorPower,
} from "./mcpConfig.js";
import { getSetting, setSetting } from "./db-host/settings.js";
import { mcpRegistryOptinStatus, mcpRegistrySearch, setMcpRegistryOptin } from "./mcpRegistry.js";
import type { EventSender } from "./turn.js";
import {
  authorize as authorizeOauth,
  canRefresh,
  clearTokens,
  loadTokens,
  needsRefresh,
  probeWwwAuthenticate,
  saveTokens,
} from "./mcpOauth.js";

function args(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export interface McpRuntime {
  manager: McpManager;
  sessionApprovals: Set<string>;
  reconnect?: (servers: Array<[string, ServerConfig]>) => Promise<ReturnType<McpManager["statuses"]>>;
}

export function createMcpRuntime(): McpRuntime {
  return { manager: new McpManager(), sessionApprovals: new Set() };
}

export function registerMcpSurfaceIpc(
  ipcMain: Pick<IpcMain, "handle">,
  state: RoomManagerState,
  userDataDir: string,
  emit: EventSender,
  runtime: McpRuntime = createMcpRuntime(),
  openBrowser: (url: string) => void | Promise<void> = () => {
    throw new Error("No system-browser opener is available.");
  },
): void {
  const room = () => {
    if (state.room === null) throw new Error("No room is open.");
    return state.room;
  };
  const publish = (): void => emit("mcp-status", runtime.manager.statuses());

  const connectOne = async (name: string, cfg: ServerConfig): Promise<ManagerServerEntry> => {
    const base: ManagerServerEntry = {
      name,
      status: cfg.disabled ? "disabled" : "connecting",
      error: null,
      tools: [],
      remote: cfg.transport.kind === "http",
      client: null,
      configKey: configKey(cfg),
    };
    if (cfg.disabled) return base;
    try {
      const connected = await connectMcpClient(cfg);
      return { ...base, status: "connected", client: connected.client, tools: connected.tools };
    } catch (error) {
      return { ...base, status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  };

  const reconnect = async (servers: Array<[string, ServerConfig]>): Promise<ReturnType<McpManager["statuses"]>> => {
    for (const existing of runtime.manager.servers) existing.client?.close();
    runtime.manager.generation += 1;
    runtime.manager.servers = servers.map(([name, cfg]) => ({
      name,
      status: cfg.disabled ? "disabled" : "connecting",
      error: null,
      tools: [],
      remote: cfg.transport.kind === "http",
      client: null,
      configKey: configKey(cfg),
    }));
    publish();
    runtime.manager.servers = await Promise.all(servers.map(([name, cfg]) => connectOne(name, cfg)));
    publish();
    return runtime.manager.statuses();
  };
  runtime.reconnect = reconnect;

  const persistAndReconnect = async (json: string) => {
    applyMcpConfig(room().conn, json);
    const fingerprint = mcpFingerprint(json);
    addMcpApproval(userDataDir, fingerprint);
    runtime.sessionApprovals.add(fingerprint);
    return reconnect(parseMcpConfig(json));
  };

  ipcMain.handle("mcp_get_config", () => getMcpConfig(room().conn));
  ipcMain.handle("mcp_apply_config", (_event: IpcMainInvokeEvent, raw: unknown) =>
    persistAndReconnect(String(args(raw).json ?? "")),
  );
  ipcMain.handle("mcp_status", () => runtime.manager.statuses());
  ipcMain.handle("approve_mcp", (_event: IpcMainInvokeEvent, raw: unknown) => {
    const fingerprint = String(args(raw).fingerprint ?? "");
    addMcpApproval(userDataDir, fingerprint);
    runtime.sessionApprovals.add(fingerprint);
    return reconnect(parseMcpConfig(getMcpConfig(room().conn)));
  });

  ipcMain.handle("get_mcp_auto_approve", () => readMcpFlag(mcpAutoApproveFile(userDataDir)));
  ipcMain.handle("set_mcp_auto_approve", (_event: IpcMainInvokeEvent, raw: unknown) =>
    writeMcpFlag(mcpAutoApproveFile(userDataDir), args(raw).on === true),
  );
  ipcMain.handle("get_mcp_outbound_unmask", () => readMcpFlag(mcpOutboundUnmaskFile(userDataDir)));
  ipcMain.handle("set_mcp_outbound_unmask", (_event: IpcMainInvokeEvent, raw: unknown) =>
    writeMcpFlag(mcpOutboundUnmaskFile(userDataDir), args(raw).on === true),
  );
  ipcMain.handle("get_mcp_connector_powers", () =>
    JSON.stringify(readMcpConnectorPowers(userDataDir)),
  );
  ipcMain.handle("set_mcp_connector_power", (_event: IpcMainInvokeEvent, raw: unknown) => {
    const a = args(raw);
    return writeMcpConnectorPower(
      userDataDir,
      String(a.server ?? ""),
      String(a.power ?? ""),
      typeof a.value === "boolean" ? a.value : null,
    );
  });

  ipcMain.handle("mcp_registry_optin_status", () => mcpRegistryOptinStatus(userDataDir));
  ipcMain.handle("set_mcp_registry_optin", (_event: IpcMainInvokeEvent, raw: unknown) =>
    setMcpRegistryOptin(userDataDir, args(raw).enabled === true),
  );
  ipcMain.handle("mcp_registry_search", (_event: IpcMainInvokeEvent, raw: unknown) => {
    const a = args(raw);
    return mcpRegistrySearch(
      userDataDir,
      typeof a.query === "string" ? a.query : undefined,
      typeof a.limit === "number" ? a.limit : undefined,
    );
  });

  ipcMain.handle("mcp_set_server_enabled", (_event: IpcMainInvokeEvent, raw: unknown) => {
    const a = args(raw);
    const config = getMcpConfig(room().conn);
    requireReadableConfig(config);
    return persistAndReconnect(setServerDisabled(config, String(a.server ?? ""), a.enabled !== true));
  });
  ipcMain.handle("mcp_remove_server", (_event: IpcMainInvokeEvent, raw: unknown) => {
    const server = String(args(raw).server ?? "");
    const config = getMcpConfig(room().conn);
    requireReadableConfig(config);
    const next = removeServerFromConfig(config, server);
    forgetConnectorGrants(userDataDir, runtime.sessionApprovals, server);
    return persistAndReconnect(next);
  });
  ipcMain.handle("mcp_get_tool_prefs", () => getSetting(room().conn, MCP_TOOL_PREFS_KEY) ?? "{}");
  ipcMain.handle("mcp_set_tool_enabled", (_event: IpcMainInvokeEvent, raw: unknown) => {
    const a = args(raw);
    const next = setToolPref(
      getSetting(room().conn, MCP_TOOL_PREFS_KEY) ?? "{}",
      String(a.server ?? ""),
      String(a.tool ?? ""),
      a.enabled === true,
    );
    setSetting(room().conn, MCP_TOOL_PREFS_KEY, next);
    return next;
  });

  ipcMain.handle("mcp_oauth_status", (_event: IpcMainInvokeEvent, raw: unknown): boolean => {
    const token = loadTokens(room().conn, String(args(raw).server ?? ""));
    return token !== null && (!needsRefresh(token) || canRefresh(token));
  });
  ipcMain.handle("mcp_oauth_authorize", async (_event: IpcMainInvokeEvent, raw: unknown) => {
    const server = String(args(raw).server ?? "");
    const starting = room();
    const roomPath = starting.path;
    const epoch = state.roomEpoch;
    const config = getMcpConfig(starting.conn);
    const found = parseMcpConfig(config).find(([name]) => name === server);
    if (!found || found[1].transport.kind !== "http") {
      throw new Error(`"${server}" is not a remote connector in this room.`);
    }
    const url = found[1].transport.url;
    const challenge = await probeWwwAuthenticate(url);
    const token = await authorizeOauth(url, challenge, {
      openBrowser,
      onAuthorizeUrl: (authorizeUrl) => emit("mcp-oauth-url", { server, url: authorizeUrl }),
    });
    if (!state.room || state.room.path !== roomPath || state.roomEpoch !== epoch) {
      throw new Error(
        `The room this sign-in belongs to was closed while the browser was open, so nothing was saved. Open it again and connect "${server}" from there.`,
      );
    }
    saveTokens(state.room.conn, server, token);
    const merged = mergeBearer(getMcpConfig(state.room.conn), server, token.accessToken);
    setSetting(state.room.conn, "mcp_config", merged);
    const fingerprint = mcpFingerprint(merged);
    addMcpApproval(userDataDir, fingerprint);
    runtime.sessionApprovals.add(fingerprint);
    return reconnect(parseMcpConfig(merged));
  });
  ipcMain.handle("mcp_oauth_sign_out", (_event: IpcMainInvokeEvent, raw: unknown) => {
    const server = String(args(raw).server ?? "");
    clearTokens(room().conn, server);
    const merged = stripBearer(getMcpConfig(room().conn), server);
    setSetting(room().conn, "mcp_config", merged);
    const fingerprint = mcpFingerprint(merged);
    addMcpApproval(userDataDir, fingerprint);
    runtime.sessionApprovals.add(fingerprint);
    return reconnect(parseMcpConfig(merged));
  });

  // Load the persisted approval set for callers that consult this runtime.
  for (const fingerprint of readMcpApprovals(userDataDir)) runtime.sessionApprovals.add(fingerprint);
}
