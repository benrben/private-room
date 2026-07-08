import type { IconComponent, RoomServerStatus } from "./types";

interface Props {
  leash: RoomServerStatus;
  leashBusy: boolean;
  toggleLeash: () => void;
  allowCloud: boolean;
  toggleAllowCloud: (next: boolean) => void;
  copyLeashConfig: () => void;
  leashCopied: boolean;
  leashErr: string;
  AlertIcon: IconComponent;
}

export default function RoomServerSection({
  leash,
  leashBusy,
  toggleLeash,
  allowCloud,
  toggleAllowCloud,
  copyLeashConfig,
  leashCopied,
  leashErr,
  AlertIcon,
}: Props) {
  return (
    // THE LEASH — expose the unlocked room as an MCP server.
    <section id="set-leash">
      <h3>Room as a tool (MCP server)</h3>
            <p className="settings-hint">
              Turn this on to let apps on this Mac reach the unlocked room as a
              Model Context Protocol server — so Claude Desktop, Cursor and
              similar tools can read and search it while it's open.
            </p>
            <div className="settings-toggle-row">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={leash.running}
                  disabled={leashBusy}
                  onChange={toggleLeash}
                />
                <span className="switch-track" aria-hidden="true">
                  <span className="switch-thumb" />
                </span>
              </label>
              <span>
                {leash.running
                  ? "The room is reachable as a tool."
                  : "The room is not shared."}
              </span>
            </div>
            {leash.running && (
              <>
                <label className="settings-label">Address</label>
                <input
                  readOnly
                  value={leash.url}
                  onFocus={(e) => e.target.select()}
                />
                <label className="settings-label">
                  Config for Claude Desktop / Cursor
                </label>
                <textarea
                  className="mcp-config"
                  rows={8}
                  readOnly
                  spellCheck={false}
                  value={leash.config}
                  onFocus={(e) => e.target.select()}
                />
                <div className="settings-actions">
                  <button className="btn-ic" onClick={copyLeashConfig}>
                    {leashCopied ? "Copied ✓" : "Copy config"}
                  </button>
                </div>
                <p className="settings-hint">
                  Only apps you paste this into can reach the unlocked room; it
                  dies when you lock.
                </p>
                <label className="settings-label">Allow cloud AI clients</label>
                <div className="settings-toggle-row">
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={allowCloud}
                      disabled={leashBusy}
                      onChange={(e) => toggleAllowCloud(e.target.checked)}
                    />
                    <span className="switch-track" aria-hidden="true">
                      <span className="switch-thumb" />
                    </span>
                  </label>
                  <span>
                    {allowCloud
                      ? "Cloud AI clients may connect."
                      : "Local apps only."}
                  </span>
                </div>
                <p className="settings-hint">
                  <AlertIcon size={13} className="warn-ic" /> With this on, a
                  cloud AI can read this room through the bridge — and what they
                  retrieve, they keep. Leave it off unless you mean it.
                </p>
              </>
            )}
            {leashErr && <div className="gate-error">{leashErr}</div>}
    </section>
  );
}
