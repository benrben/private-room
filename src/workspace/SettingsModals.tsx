import { RoomInfo } from "../api";
import { CloseIcon, LinkIcon, LockIcon } from "../icons";
import Settings from "../Settings";
import { WSState } from "./state";
import { WSActions } from "./actions";

/** Room settings, the SEC-1 MCP start-approval dialog, and the ADD-12 add-link
 * modal. Extracted verbatim. */
export default function SettingsModals({
  s,
  a,
  info,
}: {
  s: WSState;
  a: WSActions;
  info: RoomInfo;
}) {
  return (
    <>
      {s.showSettings && (
        <Settings
          ai={s.ai}
          model={s.model}
          onModelChange={a.changeModel}
          onModelsChanged={a.refreshAi}
          onClose={() => {
            s.setShowSettings(false);
            a.refreshWebAccess();
            a.refreshAutolock();
          }}
        />
      )}

      {info.pendingMcp && !s.mcpDialogDismissed && (
        <div className="settings-backdrop mcp-approve-backdrop">
          <div className="settings mcp-approve">
            <div className="settings-head">
              <span className="badge-label">
                <LockIcon size={15} /> This room wants to start programs
              </span>
            </div>
            <div className="settings-body">
              <p className="mcp-approve-lead">
                Opening <strong>{info.name}</strong> wants to run these programs
                on this Mac to give the AI extra tools. Only allow this if you
                trust whoever made the room.
              </p>
              <div className="mcp-approve-list">
                {info.pendingMcp.servers.map((srv) => (
                  <div key={srv.name} className="mcp-approve-server">
                    <div className="mcp-approve-name">{srv.name}</div>
                    <code className="mcp-approve-cmd">{srv.command}</code>
                  </div>
                ))}
              </div>
            </div>
            <div className="settings-actions mcp-approve-actions">
              <button
                className="subtle"
                onClick={a.keepMcpOff}
                disabled={s.approvingMcp}
              >
                Keep off
              </button>
              <button
                className="primary"
                onClick={a.approveMcp}
                disabled={s.approvingMcp}
              >
                {s.approvingMcp ? "Starting…" : "Allow"}
              </button>
            </div>
          </div>
        </div>
      )}

      {s.showAddLink && (
        <div
          className="settings-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !s.importingLink)
              s.setShowAddLink(false);
          }}
        >
          <div className="settings add-link-modal">
            <div className="settings-head">
              <span className="badge-label">
                <LinkIcon size={15} /> Add a web link
              </span>
              <button
                className="subtle btn-ic"
                title="Close"
                onClick={() => s.setShowAddLink(false)}
                disabled={s.importingLink}
              >
                <CloseIcon size={12} />
              </button>
            </div>
            <div className="settings-body">
              <p className="settings-hint">
                This fetches one page from the internet.
              </p>
              <input
                className="add-link-input"
                autoFocus
                dir="auto"
                placeholder="https://example.com/article"
                value={s.linkUrl}
                onChange={(e) => s.setLinkUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") a.submitLink();
                  if (e.key === "Escape" && !s.importingLink) s.setShowAddLink(false);
                }}
              />
              <div className="settings-actions">
                <button
                  className="subtle"
                  onClick={() => s.setShowAddLink(false)}
                  disabled={s.importingLink}
                >
                  Cancel
                </button>
                <button
                  className="primary"
                  onClick={a.submitLink}
                  disabled={s.importingLink || !s.linkUrl.trim()}
                >
                  {s.importingLink ? "Fetching…" : "Save page"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
