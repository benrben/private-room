import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, ConnectorPowers, McpServerStatus } from "../api";

/** Each server whose `Authorization` header exists in `stored` (what the room
 *  holds now) and is missing from `posted` (what the page is about to write).
 *  Unparseable JSON on either side names nothing: this answers one question,
 *  and "I could not tell" is not "yes". */
export function signInsDroppedBy(stored: string, posted: string): string[] {
  type Entry = { headers?: Record<string, string> };
  const servers = (json: string): Record<string, Entry> => {
    try {
      const root = JSON.parse(json) as { mcpServers?: Record<string, Entry> } | null;
      return root?.mcpServers ?? {};
    } catch {
      return {};
    }
  };
  const before = servers(stored);
  const after = servers(posted);
  return Object.keys(before).filter(
    (name) =>
      before[name]?.headers?.Authorization &&
      name in after &&
      !after[name]?.headers?.Authorization,
  );
}

/** Connections section: the mcpServers JSON config, live per-server status, and
 * the connector powers that config runs under. */
export function useMcpConfig() {
  const [mcpConfig, setMcpConfig] = useState("");
  const [mcpStatuses, setMcpStatuses] = useState<McpServerStatus[]>([]);
  const [mcpError, setMcpError] = useState("");
  // The two independent connector powers (owner's split, 2026-08-03):
  // `autoApprove` = run connector tools without a consent card; `outboundUnmask`
  // = let a remote connector receive the room's real values instead of the
  // privacy door's placeholders. Both default OFF, so the initial value here
  // must be `false` or a switch reads ON for a frame before Rust answers and the
  // user is briefly told their details are already leaving. The real state lives
  // in Rust; mirror it here. Optimistic set so a switch never lags the click.
  const [autoApprove, setAutoApproveState] = useState(false);
  const [outboundUnmask, setOutboundUnmaskState] = useState(false);
  // The per-connector answers that OVERRIDE those two (owner's decision:
  // per connector). Absent = "follow the switch", which is why this is a map of
  // optional booleans rather than two booleans per connector — an empty map is
  // an install that has never made a per-connector choice, and it must behave
  // exactly as it did before this existed.
  const [connectorPowers, setConnectorPowers] = useState<ConnectorPowers>({});

  useEffect(() => {
    api.mcpGetConfig().then(setMcpConfig).catch(() => {});
    api.mcpStatus().then(setMcpStatuses).catch(() => {});
    api.getMcpAutoApprove().then(setAutoApproveState).catch(() => {});
    api.getMcpOutboundUnmask().then(setOutboundUnmaskState).catch(() => {});
    api.mcpGetConnectorPowers().then(setConnectorPowers).catch(() => {});
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
      const dropped = signInsDroppedBy(await api.mcpGetConfig(), mcpConfig);
      if (dropped.length) {
        // The editor holds a copy taken when the page opened. Signing a
        // connector in writes its bearer into the room's config behind that
        // copy, so re-posting it silently signs the connector back OUT — it
        // reconnects with no token, every call 401s, and the drawer still says
        // "Signed in". Refused rather than merged: a token nobody can see is
        // not something to guess about on the user's behalf.
        setMcpError(
          `This box was loaded before ${dropped.join(", ")} signed in, so saving it now would ` +
            `drop that sign-in. Reopen Connections to pick up the current config, then re-apply ` +
            `your change (or use Sign out if you meant to remove it).`,
        );
        return;
      }
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
    // Merge into what the ROOM holds right now, never into the copy this page
    // loaded. A connector signed in since then has had its bearer written into
    // the config behind us, and re-posting the older snapshot dropped it — the
    // connector reconnected unauthenticated while the drawer read "Signed in".
    const current = await api.mcpGetConfig();
    let root: { mcpServers?: Record<string, unknown> } = {};
    if (current.trim()) {
      try {
        root = JSON.parse(current);
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

  // Flip one of the two powers — optimistic, then persist. On failure, reload
  // the true value so the switch never lies about what the backend will do.
  // Each writes ONLY its own flag; nothing here touches the other.
  async function setAutoApprove(on: boolean) {
    setAutoApproveState(on);
    try {
      await api.setMcpAutoApprove(on);
    } catch {
      api.getMcpAutoApprove().then(setAutoApproveState).catch(() => {});
    }
  }

  async function setOutboundUnmask(on: boolean) {
    setOutboundUnmaskState(on);
    try {
      await api.setMcpOutboundUnmask(on);
    } catch {
      api.getMcpOutboundUnmask().then(setOutboundUnmaskState).catch(() => {});
    }
  }

  // One connector's answer for one power — `null` puts it back to following the
  // switch above. NOT optimistic: the backend returns the stored map and we show
  // that, because a per-connector grant is a permission and the page must never
  // display one the backend rejected or dropped.
  async function setConnectorPower(
    server: string,
    power: "auto_approve" | "outbound_unmask",
    value: boolean | null,
  ) {
    setMcpError("");
    try {
      setConnectorPowers(await api.mcpSetConnectorPower(server, power, value));
    } catch (e) {
      setMcpError(String(e));
      api.mcpGetConnectorPowers().then(setConnectorPowers).catch(() => {});
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

  return {
    mcpConfig,
    setMcpConfig,
    mcpStatuses,
    mcpError,
    applyMcp,
    installServer,
    setServerEnabled,
    removeServer,
    autoApprove,
    setAutoApprove,
    outboundUnmask,
    setOutboundUnmask,
    connectorPowers,
    setConnectorPower,
    installedNames: mcpStatuses.map((s) => s.name),
  };
}
