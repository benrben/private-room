import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, McpServerStatus } from "../api";

/** Connections section: the mcpServers JSON config, live per-server status, and
 * the guided connector form that merges into that JSON. */
export function useMcpConfig() {
  const [mcpConfig, setMcpConfig] = useState("");
  const [mcpStatuses, setMcpStatuses] = useState<McpServerStatus[]>([]);
  const [mcpError, setMcpError] = useState("");
  // Guided connector form — a friendlier path than hand-editing JSON.
  const [connName, setConnName] = useState("");
  const [connCmd, setConnCmd] = useState("");
  const [connArgs, setConnArgs] = useState("");
  // "Auto mode": blanket consent for connector tool calls AND real (unmasked)
  // arguments to a remote connector — default OFF, so the initial value here
  // must be `false` or the switch reads ON for a frame before Rust answers and
  // the user is briefly told their details are already leaving. The real state
  // lives in Rust; mirror it here. Optimistic set so the switch never lags the
  // click.
  const [autoApprove, setAutoApproveState] = useState(false);

  useEffect(() => {
    api.mcpGetConfig().then(setMcpConfig).catch(() => {});
    api.mcpStatus().then(setMcpStatuses).catch(() => {});
    api.getMcpAutoApprove().then(setAutoApproveState).catch(() => {});
    const unlistenMcp = listen<McpServerStatus[]>("mcp-status", (e) => {
      setMcpStatuses(e.payload);
    });
    return () => {
      unlistenMcp.then((fn) => fn());
    };
  }, []);

  async function applyMcp() {
    setMcpError("");
    try {
      setMcpStatuses(await api.mcpApplyConfig(mcpConfig));
    } catch (e) {
      setMcpError(String(e));
    }
  }

  // Marketplace install: merge one server entry into the mcpServers JSON and
  // apply it. Goes through mcp_apply_config exactly like a hand-typed config, so
  // the SEC-1 fingerprint approval still covers anything a click would start.
  // Returns the fresh statuses; throws (with a readable message) on a bad config
  // or a connect failure so the caller can surface it.
  async function installServer(
    name: string,
    entry: Record<string, unknown>,
  ): Promise<McpServerStatus[]> {
    let root: { mcpServers?: Record<string, unknown> } = {};
    if (mcpConfig.trim()) {
      try {
        root = JSON.parse(mcpConfig);
      } catch {
        throw new Error(
          "The current config isn't valid JSON — fix or clear it under Advanced before installing.",
        );
      }
    }
    const servers = (root.mcpServers ?? {}) as Record<string, unknown>;
    servers[name] = entry;
    root.mcpServers = servers;
    const json = JSON.stringify(root, null, 2);
    setMcpConfig(json);
    const statuses = await api.mcpApplyConfig(json);
    setMcpStatuses(statuses);
    return statuses;
  }

  // Flip "auto mode" — optimistic, then persist. On failure, reload the true
  // value so the switch never lies about what the backend will do.
  async function setAutoApprove(on: boolean) {
    setAutoApproveState(on);
    try {
      await api.setMcpAutoApprove(on);
    } catch {
      api.getMcpAutoApprove().then(setAutoApproveState).catch(() => {});
    }
  }

  // Turn a connector on/off (keeps it in the config) — the disable path.
  async function setServerEnabled(name: string, enabled: boolean) {
    setMcpError("");
    try {
      setMcpStatuses(await api.mcpSetServerEnabled(name, enabled));
      setMcpConfig(await api.mcpGetConfig());
    } catch (e) {
      setMcpError(String(e));
    }
  }

  // Remove a connector from the room entirely.
  async function removeServer(name: string) {
    setMcpError("");
    try {
      setMcpStatuses(await api.mcpRemoveServer(name));
      setMcpConfig(await api.mcpGetConfig());
    } catch (e) {
      setMcpError(String(e));
    }
  }

  // Merge the guided form's fields into the mcpServers JSON so non-technical
  // users never have to hand-write it. The raw editor below stays available
  // for anyone pasting a config from elsewhere.
  function addConnector() {
    setMcpError("");
    const name = connName.trim();
    const command = connCmd.trim();
    if (!name || !command) {
      setMcpError("Give the connector a name and a command.");
      return;
    }
    let root: { mcpServers?: Record<string, unknown> } = {};
    if (mcpConfig.trim()) {
      try {
        root = JSON.parse(mcpConfig);
      } catch {
        setMcpError(
          "The current config isn't valid JSON — fix or clear the box below before adding.",
        );
        return;
      }
    }
    const servers = (root.mcpServers ?? {}) as Record<string, unknown>;
    const args = connArgs.trim() ? connArgs.trim().split(/\s+/) : [];
    servers[name] = args.length ? { command, args } : { command };
    root.mcpServers = servers;
    setMcpConfig(JSON.stringify(root, null, 2));
    setConnName("");
    setConnCmd("");
    setConnArgs("");
  }

  return {
    mcpConfig,
    setMcpConfig,
    mcpStatuses,
    mcpError,
    connName,
    setConnName,
    connCmd,
    setConnCmd,
    connArgs,
    setConnArgs,
    applyMcp,
    addConnector,
    installServer,
    setServerEnabled,
    removeServer,
    autoApprove,
    setAutoApprove,
    installedNames: mcpStatuses.map((s) => s.name),
  };
}
