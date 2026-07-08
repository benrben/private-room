import type { IconComponent, McpServerStatus } from "./types";

interface Props {
  connName: string;
  setConnName: (v: string) => void;
  connCmd: string;
  setConnCmd: (v: string) => void;
  connArgs: string;
  setConnArgs: (v: string) => void;
  addConnector: () => void;
  mcpConfig: string;
  setMcpConfig: (v: string) => void;
  applyMcp: () => void;
  mcpStatuses: McpServerStatus[];
  mcpError: string;
  AlertIcon: IconComponent;
}

export default function McpSection({
  connName,
  setConnName,
  connCmd,
  setConnCmd,
  connArgs,
  setConnArgs,
  addConnector,
  mcpConfig,
  setMcpConfig,
  applyMcp,
  mcpStatuses,
  mcpError,
  AlertIcon,
}: Props) {
  return (
    <section id="set-mcp">
      <h3>Connections (MCP)</h3>
            <p className="settings-hint">
              Advanced: connect external tool programs with the Model Context
              Protocol — paste the same <code>mcpServers</code> config used by
              Claude Desktop or Cursor. For web search you don't need this — use{" "}
              <strong>Online features</strong> above, the one built-in search
              path. A "Could not start …" error means that server's program
              isn't installed on this Mac.
            </p>
            <p className="settings-hint">
              <AlertIcon size={13} className="warn-ic" /> Connected tools are separate programs and can reach the
              internet — what the AI sends them leaves this room. They stay
              off unless you turn them on here, per room.
            </p>
            <div className="connector-form">
              <label className="settings-label">Add a connector</label>
              <input
                type="text"
                placeholder="Name (e.g. yfinance)"
                value={connName}
                onChange={(e) => setConnName(e.target.value)}
              />
              <input
                type="text"
                placeholder="Command (e.g. uvx)"
                value={connCmd}
                onChange={(e) => setConnCmd(e.target.value)}
              />
              <input
                type="text"
                placeholder="Arguments, space-separated (e.g. yfinance-mcp)"
                value={connArgs}
                onChange={(e) => setConnArgs(e.target.value)}
              />
              <div className="settings-actions">
                <button className="btn-ic" onClick={addConnector}>
                  Add to config
                </button>
              </div>
            </div>
            <details className="mcp-advanced">
              <summary>Advanced: edit the raw JSON</summary>
              <textarea
                className="mcp-config"
                rows={9}
                spellCheck={false}
                value={mcpConfig}
                onChange={(e) => setMcpConfig(e.target.value)}
                onKeyDown={(e) => {
                  // Don't let Escape bubble to the modal close and discard edits.
                  if (e.key === "Escape") e.stopPropagation();
                }}
              />
            </details>
            <div className="settings-actions">
              <button className="primary" onClick={applyMcp}>
                Save & Connect
              </button>
            </div>
            {mcpStatuses.length > 0 && (
              <div className="mcp-list">
                {mcpStatuses.map((s) => (
                  <div key={s.name} className="mcp-row">
                    <span className={`mcp-dot ${s.status}`} />
                    <strong>{s.name}</strong>
                    <span className="settings-hint">
                      {s.status === "connected" &&
                        `${s.tools.length} tool${s.tools.length === 1 ? "" : "s"}: ${s.tools.join(", ")}`}
                      {s.status === "connecting" && "connecting…"}
                      {s.status === "disabled" && "off (\"disabled\": true)"}
                      {s.status === "failed" && (s.error ?? "failed")}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {mcpError && <div className="gate-error">{mcpError}</div>}
    </section>
  );
}
