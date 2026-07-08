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

  useEffect(() => {
    api.mcpGetConfig().then(setMcpConfig).catch(() => {});
    api.mcpStatus().then(setMcpStatuses).catch(() => {});
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
  };
}
