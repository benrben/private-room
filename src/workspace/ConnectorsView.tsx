import { useEffect, useState } from "react";
import { api } from "../api";
import { useMcpConfig } from "../settings/useMcpConfig";
import McpMarketplace from "../settings/McpMarketplace";
import { AlertIcon, TrashIcon } from "../icons";

/** The Connectors area (activity rail → "connectors"): manage installed MCP
 * connectors — enable/disable and remove — and browse the marketplace to add
 * more. Moved out of Settings so connectors are a first-class product area. */
export default function ConnectorsView() {
  const {
    mcpConfig,
    setMcpConfig,
    mcpStatuses,
    mcpError,
    applyMcp,
    installServer,
    setServerEnabled,
    removeServer,
    installedNames,
  } = useMcpConfig();

  // Per-connector tool opt-outs: { server: [disabled tool names] }.
  const [toolPrefs, setToolPrefs] = useState<Record<string, string[]>>({});
  // Connectors the user exempted from the tool-count cap.
  const [uncapped, setUncapped] = useState<string[]>([]);
  useEffect(() => {
    api.mcpGetToolPrefs().then(setToolPrefs).catch(() => {});
    api.mcpGetUncapped().then(setUncapped).catch(() => {});
  }, []);
  const toggleTool = (server: string, tool: string, enabled: boolean) =>
    void api.mcpSetToolEnabled(server, tool, enabled).then(setToolPrefs).catch(() => {});
  const toggleUncapped = (server: string, on: boolean) =>
    void api.mcpSetServerUncapped(server, on).then(setUncapped).catch(() => {});

  return (
    <div className="connectors-page">
      <header className="connectors-head">
        <h1>Connectors</h1>
        <p className="settings-hint">
          Give this room extra tools with the Model Context Protocol. Local
          connectors run on your Mac; remote ones reach out over the internet —
          Private Room asks before either starts, and redacts what leaves.
        </p>
      </header>

      {mcpStatuses.length > 0 && (
        <section className="connectors-installed">
          <h2 className="connectors-h2">Installed</h2>
          <div className="mcp-list">
            {mcpStatuses.map((s) => {
              const enabled = s.status !== "disabled";
              const offList = toolPrefs[s.name] ?? [];
              const onCount = s.tools.filter((t) => !offList.includes(t)).length;
              return (
                <div key={s.name} className="connector-item">
                  <div className="mcp-row connector-row">
                    <span className={`mcp-dot ${s.status}`} />
                    <strong>{s.name}</strong>
                    <span
                      className={`mkt-badge ${s.remote ? "remote" : "local"}`}
                      title={
                        s.remote
                          ? "Remote — reaches the internet"
                          : "Local — runs on your Mac"
                      }
                    >
                      {s.remote ? "Remote" : "Local"}
                    </span>
                    <span className="settings-hint connector-status">
                      {s.status === "connected" &&
                        `${onCount} of ${s.tools.length} tool${s.tools.length === 1 ? "" : "s"} on`}
                      {s.status === "connecting" && "connecting…"}
                      {s.status === "disabled" && "off"}
                      {s.status === "failed" && (s.error ?? "failed")}
                    </span>
                    <div className="connector-actions">
                      <label
                        className="mkt-tgl"
                        title={enabled ? "Turn this connector off" : "Turn this connector on"}
                      >
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={(e) =>
                            void setServerEnabled(s.name, e.target.checked)
                          }
                        />
                        <span className="mkt-sw" />
                      </label>
                      <button
                        className="connector-remove"
                        title="Remove this connector"
                        aria-label={`Remove ${s.name}`}
                        onClick={() => void removeServer(s.name)}
                      >
                        <TrashIcon size={14} />
                      </button>
                    </div>
                  </div>
                  {enabled && s.tools.length > 0 && (
                    <details className="connector-tools">
                      <summary>Tools ({onCount}/{s.tools.length})</summary>
                      <p className="settings-hint connector-tools-hint">
                        Turn off tools you don't need — fewer, sharper tools work
                        better. A small local model can only juggle about a dozen at
                        once; cloud models handle many more.
                      </p>
                      <label className="connector-uncap" title="Send every tool below to the assistant, ignoring the tool limit">
                        <input
                          type="checkbox"
                          checked={uncapped.includes(s.name)}
                          onChange={(e) => toggleUncapped(s.name, e.target.checked)}
                        />
                        <span className="mkt-sw" />
                        <span>
                          Send <b>all</b> enabled tools to the assistant (ignore the limit)
                        </span>
                      </label>
                      <div className="connector-tool-list">
                        {s.tools.map((t) => {
                          const on = !offList.includes(t);
                          return (
                            <label key={t} className="connector-tool" title={on ? "On" : "Off"}>
                              <input
                                type="checkbox"
                                checked={on}
                                onChange={(e) => toggleTool(s.name, t, e.target.checked)}
                              />
                              <span className="mkt-sw" />
                              <code>{t}</code>
                            </label>
                          );
                        })}
                      </div>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
          {mcpError && <div className="gate-error">{mcpError}</div>}
        </section>
      )}

      <section className="connectors-marketplace">
        <h2 className="connectors-h2">
          {mcpStatuses.length > 0 ? "Add more" : "Marketplace"}
        </h2>
        <McpMarketplace
          installServer={installServer}
          installedNames={installedNames}
        />
      </section>

      <details className="mcp-advanced connectors-advanced">
        <summary>Advanced: paste or edit the raw config</summary>
        <p className="settings-hint">
          <AlertIcon size={13} className="warn-ic" /> Connected tools are separate
          programs and can reach the internet — what the AI sends them leaves
          this room. Paste the same <code>mcpServers</code> config used by Claude
          Desktop or Cursor.
        </p>
        <textarea
          className="mcp-config"
          rows={10}
          spellCheck={false}
          value={mcpConfig}
          onChange={(e) => setMcpConfig(e.target.value)}
        />
        <div className="settings-actions">
          <button className="primary" onClick={applyMcp}>
            Save & Connect
          </button>
        </div>
      </details>
    </div>
  );
}
