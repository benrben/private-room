import { useEffect, useState } from "react";
import { DownloadIcon, GlobeIcon, MicIcon } from "../icons";
import { WSState } from "./state";
import { WSActions } from "./actions";

/** Human name for whoever owns the shared dictation mic right now. */
const CAPTURE_OWNER_LABEL: Record<string, string> = {
  note: "Voice note",
  journal: "Journal entry",
  composer: "Dictation",
  memory: "Spoken memory",
  file: "Dictating to file",
};

/** The capture dock — the one unmistakable "the microphone is doing
 * something" surface. Dictation-style capture (voice note, journal,
 * composer dictation) used to run with no visible state at all: the mic
 * was LIVE while the screen showed nothing. This pill names every phase —
 * Preparing → Recording (red dot + timer + Stop) → Transcribing — and is
 * fixed above the composer so it survives menu closes and view switches. */
function CaptureDock({ s }: { s: WSState }) {
  const [elapsed, setElapsed] = useState(0);
  const recording = s.dictState === "recording";
  useEffect(() => {
    if (!recording) {
      setElapsed(0);
      return;
    }
    const t = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(t);
  }, [recording]);
  if (s.dictState === "idle") return null;
  const who = CAPTURE_OWNER_LABEL[s.dictOwner ?? ""] ?? "Recording";
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, "0");
  return (
    <div className={`capture-dock ${s.dictState}`} role="status">
      {s.dictState === "preparing" ? (
        <span className="capture-label">
          <MicIcon size={13} /> Preparing the microphone…
        </span>
      ) : s.dictState === "busy" ? (
        <span className="capture-label">
          <MicIcon size={13} /> {who} — transcribing on this Mac…
        </span>
      ) : (
        <>
          <span className="capture-label rec">
            <span className="rec-dot pulsing" /> {who} · {mm}:{ss}
          </span>
          <button
            className="capture-stop"
            onClick={() => s.recorderRef.current?.stop()}
          >
            Stop &amp; save
          </button>
        </>
      )}
    </div>
  );
}

/** The fixed-position overlays that sit above everything: the MCP tool-call
 * approval card, the file context menu, the "Move to…" menu, the Finder-drop
 * highlight, and the ⌘F search overlay. Extracted verbatim. */
export default function Overlays({ s, a }: { s: WSState; a: WSActions }) {
  const pendingApproval = s.mcpApprovals[0];
  const searchResults = s.searchResults;
  const msgOffset = searchResults ? searchResults.files.length : 0;
  const memOffset = searchResults
    ? searchResults.files.length + searchResults.messages.length
    : 0;
  const searchFlat = a.searchFlat();
  return (
    <>
      <CaptureDock s={s} />
      {pendingApproval && (
        // ADD-25: consent surface — the agent must never be able to click its
        // own tool-call approval ("Allow"), so the driver can't see it.
        <div className="approve-backdrop" data-agent-blocked>
          <div className="approve-card" role="alertdialog" aria-modal="true">
            <div className="approve-title">
              <GlobeIcon size={17} /> Allow a connected tool to run?
            </div>
            <p className="approve-body">
              The AI wants to use{" "}
              <strong>{pendingApproval.tool}</strong> from the{" "}
              <strong>{pendingApproval.server}</strong> connector. This is a
              separate program that can reach the internet — what the AI sends
              it leaves this room.
            </p>
            {pendingApproval.args && pendingApproval.args !== "{}" && (
              <pre className="approve-args">{pendingApproval.args}</pre>
            )}
            <div className="approve-actions">
              <button
                className="primary"
                onClick={() => a.resolveMcpApproval(pendingApproval, "once")}
              >
                Allow once
              </button>
              <button
                onClick={() => a.resolveMcpApproval(pendingApproval, "always")}
              >
                Always allow this connector
              </button>
              <button
                className="danger"
                onClick={() => a.resolveMcpApproval(pendingApproval, "deny")}
              >
                Don't allow
              </button>
            </div>
          </div>
        </div>
      )}
      {s.ctxMenu && (
        <>
          <div className="ctx-backdrop" onMouseDown={() => s.setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); s.setCtxMenu(null); }} />
          <div
            ref={s.ctxMenuElRef}
            className="ctx-menu"
            style={{ top: s.ctxMenu.y, left: s.ctxMenu.x }}
          >
            <button className="ctx-item" onClick={() => { a.viewFile(s.ctxMenu!.file.id); s.setCtxMenu(null); }}>Open</button>
            <button className="ctx-item" onClick={() => { a.toggleAttach(s.ctxMenu!.file); s.setCtxMenu(null); }}>{s.attachments.some((x) => x.id === s.ctxMenu!.file.id) ? "Detach from chat" : "Attach to chat"}</button>
            <button className="ctx-item" onClick={() => { s.setRenamingFile({ id: s.ctxMenu!.file.id, name: s.ctxMenu!.file.name }); s.setCtxMenu(null); }}>Rename…</button>
            <button className="ctx-item" onClick={() => { s.setMoveMenuFor({ id: s.ctxMenu!.file.id, x: s.ctxMenu!.x, y: s.ctxMenu!.y }); s.setCtxMenu(null); }}>Move to…</button>
            <button className="ctx-item" onClick={() => { a.exportOne(s.ctxMenu!.file.id, s.ctxMenu!.file.name); s.setCtxMenu(null); }}>Export a copy…</button>
            {(s.aiActionDefs ?? []).some((x) => x.scope === "file") && (
              <>
                <div className="ctx-sep" />
                <div className="ctx-heading">AI actions · this file</div>
                {(s.aiActionDefs ?? [])
                  .filter((x) => x.scope === "file")
                  .map((x) => (
                    <button
                      key={x.id}
                      className="ctx-item"
                      title={x.description}
                      onClick={() => {
                        const f = s.ctxMenu!.file;
                        s.setCtxMenu(null);
                        a.openAiAction(x, null, [f.id]);
                      }}
                    >
                      {x.title}
                    </button>
                  ))}
              </>
            )}
            <div className="ctx-sep" />
            {s.confirmDelete === `ctx-remove-${s.ctxMenu.file.id}` ? (
              // ADD-25: the agent driver must not be able to click ✓ on a
              // removal it didn't earn.
              <div className="ctx-confirm" data-agent-blocked>
                <span className="ctx-confirm-q">Remove from room?</span>
                <button
                  className="ctx-item danger"
                  onClick={() => {
                    const id = s.ctxMenu!.file.id;
                    a.cancelConfirm();
                    s.setCtxMenu(null);
                    a.removeFile(id);
                  }}
                >
                  ✓ Remove
                </button>
                <button className="ctx-item" onClick={a.cancelConfirm}>
                  ✕ Keep
                </button>
              </div>
            ) : (
              <button
                className="ctx-item danger"
                onClick={() => a.askConfirm(`ctx-remove-${s.ctxMenu!.file.id}`)}
              >
                Remove from room
              </button>
            )}
          </div>
        </>
      )}
      {s.moveMenuFor && (
        <>
          <div
            className="ctx-backdrop"
            onMouseDown={() => s.setMoveMenuFor(null)}
            onContextMenu={(e) => { e.preventDefault(); s.setMoveMenuFor(null); }}
          />
          <div
            ref={s.moveMenuElRef}
            className="ctx-menu"
            style={{ top: s.moveMenuFor.y, left: s.moveMenuFor.x }}
          >
            <div className="ctx-heading">Move to…</div>
            {(() => {
              const mf = s.files.find((f) => f.id === s.moveMenuFor!.id);
              return (
                <>
                  <button
                    className="ctx-item"
                    disabled={!mf || mf.folderId === null}
                    onClick={() => { a.moveFile(s.moveMenuFor!.id, null); s.setMoveMenuFor(null); }}
                  >
                    No folder
                  </button>
                  {s.folders.map((fo) => (
                    <button
                      key={fo.id}
                      className="ctx-item"
                      disabled={mf?.folderId === fo.id}
                      onClick={() => { a.moveFile(s.moveMenuFor!.id, fo.id); s.setMoveMenuFor(null); }}
                    >
                      {fo.name}
                    </button>
                  ))}
                  {s.folders.length === 0 && (
                    <div className="ctx-empty">No folders yet</div>
                  )}
                </>
              );
            })()}
          </div>
        </>
      )}
      {s.dragOver && (
        <div className="drop-overlay">
          <div className="drop-overlay-inner">
            <DownloadIcon size={28} />
            <span>Drop to add to this room</span>
          </div>
        </div>
      )}
      {s.showSearch && (
        <div
          className="search-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) s.setShowSearch(false);
          }}
        >
          <div className="search-panel">
            <input
              className="search-input"
              autoFocus
              dir="auto"
              placeholder="Search files, messages and memories…"
              value={s.searchQuery}
              onChange={(e) => s.setSearchQuery(e.target.value)}
              onKeyDown={a.onSearchKey}
            />
            <div className="search-results">
              {s.searchQuery.trim() &&
                searchResults &&
                searchFlat.length === 0 && (
                  <div className="search-empty">No matches.</div>
                )}
              {s.searchQuery.trim() &&
                searchResults &&
                searchFlat.length > 0 && (
                  <div className="search-summary">
                    {searchResults.files.length} file
                    {searchResults.files.length === 1 ? "" : "s"} ·{" "}
                    {searchResults.messages.length} message
                    {searchResults.messages.length === 1 ? "" : "s"} ·{" "}
                    {searchResults.memories.length} memor
                    {searchResults.memories.length === 1 ? "y" : "ies"}
                  </div>
                )}
              {searchResults && searchResults.files.length > 0 && (
                <div className="search-group">
                  <div className="search-group-head">
                    Files <span className="search-count">{searchResults.files.length}</span>
                  </div>
                  {searchResults.files.map((f, i) => (
                    <button
                      key={f.id}
                      className={`search-result ${s.searchSel === i ? "sel" : ""}`}
                      onMouseEnter={() => s.setSearchSel(i)}
                      onClick={() =>
                        a.activateResult({
                          kind: "file",
                          id: f.id,
                          name: f.name,
                          snippet: f.snippet,
                        })
                      }
                    >
                      <span className="search-result-title">{f.name}</span>
                      <span className="search-result-snippet" dir="auto">
                        {f.snippet}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {searchResults && searchResults.messages.length > 0 && (
                <div className="search-group">
                  <div className="search-group-head">
                    Messages <span className="search-count">{searchResults.messages.length}</span>
                  </div>
                  {searchResults.messages.map((m, i) => {
                    const idx = msgOffset + i;
                    return (
                      <button
                        key={m.messageId}
                        className={`search-result ${s.searchSel === idx ? "sel" : ""}`}
                        onMouseEnter={() => s.setSearchSel(idx)}
                        onClick={() =>
                          a.activateResult({
                            kind: "message",
                            chatId: m.chatId,
                            messageId: m.messageId,
                            snippet: m.snippet,
                          })
                        }
                      >
                        <span className="search-result-snippet" dir="auto">
                          {m.snippet}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {searchResults && searchResults.memories.length > 0 && (
                <div className="search-group">
                  <div className="search-group-head">
                    Memories <span className="search-count">{searchResults.memories.length}</span>
                  </div>
                  {searchResults.memories.map((m, i) => {
                    const idx = memOffset + i;
                    return (
                      <button
                        key={m.id}
                        className={`search-result ${s.searchSel === idx ? "sel" : ""}`}
                        onMouseEnter={() => s.setSearchSel(idx)}
                        onClick={() =>
                          a.activateResult({
                            kind: "memory",
                            id: m.id,
                            snippet: m.snippet,
                          })
                        }
                      >
                        <span className="search-result-snippet" dir="auto">
                          {m.snippet}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="search-hint">
              ↑↓ to move · Enter to open · Esc to close
            </div>
          </div>
        </div>
      )}
    </>
  );
}
