import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { api } from "../api";
import { CheckIcon, CloseIcon, DownloadIcon, GlobeIcon, MicIcon, ScriptIcon } from "../icons";
import { WSState } from "./state";
import { WSActions } from "./actions";
import DiffPreview from "../viewers/DiffPreview";
import { languageForFile } from "../viewers/monacoSetup";
import { LayoutApi } from "../shell/useLayout";
import { toggleTheme } from "../theme";

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
          {/* Live partial transcript for the non-composer mics (the composer
              paints its partials into the box itself). Voice notes have no
              partials — the span just stays empty for them. */}
          {s.dictPartial && s.dictOwner !== "composer" && (
            <span className="capture-partial" dir="auto">
              {s.dictPartial}
            </span>
          )}
          <button
            className="capture-stop"
            onClick={() => {
              // Voice notes still run on MediaRecorder; streaming dictation
              // stops through its session ref. Only one is ever active.
              s.recorderRef.current?.stop();
              s.dictStreamRef.current?.();
            }}
          >
            Stop &amp; save
          </button>
        </>
      )}
    </div>
  );
}

/** One executable palette command (searched alongside room content). */
type PaletteAction = {
  id: string;
  label: string;
  hint: string;
  disabled?: boolean;
  run: () => void;
};

/** Every palette command is a real handler — the same ones the chrome uses. */
function buildPaletteActions(
  s: WSState,
  a: WSActions,
  layout: LayoutApi | undefined,
): PaletteAction[] {
  const leaveAreas = () => {
    s.setShowMap(false);
    s.setShowWorkflows(false);
    s.setShowScripts(false);
    s.setOpenFile(null);
  };
  const acts: PaletteAction[] = [
    { id: "new-chat", label: "New chat", hint: "Start a fresh conversation (⌘N)", run: () => a.newChat() },
    { id: "add-files", label: "Add files…", hint: "Import PDFs, notes, images, audio, sheets", run: () => a.importFiles() },
    { id: "new-page", label: "New page", hint: "A blank Markdown note, ready to edit", run: () => void a.createNewNote() },
    { id: "add-link", label: "Import a web link", hint: "A page or a YouTube transcript/video", run: () => { s.setLinkUrl(""); s.setShowAddLink(true); } },
    { id: "live-rec", label: "Start a live recording", hint: "Mic + Mac audio with a live transcript", disabled: s.recLive != null, run: () => void a.startLiveRecording() },
    { id: "voice-note", label: "Record a voice note", hint: "Starts the mic — audio saved in this room", disabled: a.micState("note").disabled, run: () => a.recordVoiceNote() },
    { id: "summarize", label: "Summarize the room", hint: "A cited overview, in the background", disabled: s.files.length === 0, run: () => void a.startDeepSummary() },
    { id: "go-home", label: "Go to Room home", hint: "Recent work and capabilities", run: () => { leaveAreas(); s.setArea("home"); } },
    { id: "go-map", label: "Open the Room Map", hint: "How files and notes connect", disabled: s.files.length < 2, run: () => { leaveAreas(); s.setShowMap(true); } },
    { id: "go-workflows", label: "Open Workflows", hint: "Pipelines, schedules, run history", run: () => a.openWorkflows() },
    { id: "go-scripts", label: "Open Scripts", hint: "Runnable .py/.js room files", run: () => a.openScripts() },
    { id: "go-memory", label: "Open Memory & scratch pad", hint: "Durable context, visible and editable", run: () => a.revealMemory() },
    { id: "focus-editor", label: "Focus the editor", hint: "Hide both side panes", run: () => layout?.toggleFocus("center") },
    { id: "reset-layout", label: "Reset the three-pane layout", hint: "Restore the balanced default", run: () => layout?.resetLayout() },
    { id: "theme", label: "Switch theme", hint: "Dark ⇄ light", run: () => toggleTheme() },
    { id: "checkpoint", label: "Save a checkpoint", hint: "A room-wide recovery point", run: () => { api.createRoomCheckpoint("").then((m) => s.pushToast("success", `Saved checkpoint “${m.name}”.`)).catch((e) => s.pushToast("error", String(e))); } },
    { id: "export-all", label: "Export all files…", hint: "Plain copies outside the room", disabled: s.files.length === 0, run: () => a.exportAllFiles() },
    { id: "settings", label: "Room settings", hint: "Models, privacy, voice, connections (⌘,)", run: () => s.setShowSettings(true) },
    { id: "feedback", label: "Send feedback…", hint: "Draft locally, then open GitHub", run: () => s.setShowFeedback(true) },
    { id: "lock", label: "Lock this room", hint: "Close and return to the gate (⌘L)", run: () => void a.handleLock() },
  ];
  if (!layout) return acts.filter((x) => x.id !== "focus-editor" && x.id !== "reset-layout");
  return acts;
}

/** The fixed-position overlays that sit above everything: the MCP tool-call
 * approval card, the file context menu, the "Move to…" menu, the Finder-drop
 * highlight, and the ⌘K search/command palette. */
export default function Overlays({
  s,
  a,
  layout,
}: {
  s: WSState;
  a: WSActions;
  layout?: LayoutApi;
}) {
  const pendingApproval = s.mcpApprovals[0];
  const pendingEdit = s.editApprovals[0];
  const pendingScript = s.scriptApprovals[0];
  const searchResults = s.searchResults;
  const msgOffset = searchResults ? searchResults.files.length : 0;
  const memOffset = searchResults
    ? searchResults.files.length + searchResults.messages.length
    : 0;
  const searchFlat = a.searchFlat();
  // Commands that match the query (all of them at rest — the palette's
  // resting state lists what the room can do instead of a blank panel).
  const q = s.searchQuery.trim().toLowerCase();
  const actions = buildPaletteActions(s, a, layout).filter(
    (x) => !q || x.label.toLowerCase().includes(q) || x.hint.toLowerCase().includes(q),
  );
  const actOffset = searchFlat.length;
  const totalItems = searchFlat.length + actions.length;
  const runSel = (idx: number) => {
    if (idx < searchFlat.length) {
      a.activateResult(searchFlat[idx]);
      return;
    }
    const act = actions[idx - actOffset];
    if (act && !act.disabled) {
      s.setShowSearch(false);
      act.run();
    }
  };
  const onPaletteKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      s.setSearchSel((sel) => Math.min(sel + 1, Math.max(totalItems - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      s.setSearchSel((sel) => Math.max(sel - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runSel(s.searchSel);
    }
  };
  return (
    <>
      <CaptureDock s={s} />
      {pendingScript && (
        // Wave 5 (Idea 13): the script-run consent card. Same data-agent-blocked
        // surface as the MCP/edit cards — the UI-driving agent must never approve
        // its own script. The two honest sentences state the real trust class.
        <div className="approve-backdrop" data-agent-blocked>
          <div className="approve-card" role="alertdialog" aria-modal="true">
            <div className="approve-title">
              <ScriptIcon size={17} /> Run a script from this room?
            </div>
            <p className="approve-body">
              <strong>{pendingScript.name}</strong> is a real program:{" "}
              <strong>it can reach the internet.</strong> While it runs, the files it uses are
              placed in a temporary folder outside the room's encryption.
            </p>
            <pre className="approve-args">{pendingScript.interpreterLine}</pre>
            {pendingScript.deps.length > 0 && (
              <div className="script-approve-line">
                <span className="script-approve-key">Installs</span>
                <pre className="approve-args">{pendingScript.deps.join(", ")}</pre>
              </div>
            )}
            {pendingScript.inputs.length > 0 && (
              <div className="script-approve-line">
                <span className="script-approve-key">Reads</span>
                <pre className="approve-args">{pendingScript.inputs.join(", ")}</pre>
              </div>
            )}
            {pendingScript.outputs.length > 0 && (
              <div className="script-approve-line">
                <span className="script-approve-key">Writes back</span>
                <pre className="approve-args">{pendingScript.outputs.join(", ")}</pre>
              </div>
            )}
            <p className="approve-body caption">
              <strong>Allow once</strong> runs it this one time and keeps it marked “Needs review”.
              <br />
              <strong>Always allow this exact script</strong> approves this version — it stops asking
              and can be scheduled. Any edit to the script asks again.
            </p>
            <div className="approve-actions">
              <button
                className="primary"
                onClick={() => a.resolveScriptApproval(pendingScript, "once")}
              >
                Allow once
              </button>
              <button onClick={() => a.resolveScriptApproval(pendingScript, "always")}>
                Always allow this exact script
              </button>
              <button
                className="danger"
                onClick={() => a.resolveScriptApproval(pendingScript, "deny")}
              >
                Don't run
              </button>
            </div>
          </div>
        </div>
      )}
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
      {pendingEdit && (
        // Wave 2 (Idea 6): the diff-preview approval card. Same data-agent-blocked
        // consent surface as the MCP card — the UI-driving agent must never be
        // able to approve its own edit.
        <div className="approve-backdrop" data-agent-blocked>
          <div className="approve-card approve-card-wide" role="alertdialog" aria-modal="true">
            <div className="approve-title">
              Apply {pendingEdit.files.length > 1 ? "these changes" : "this change"} to{" "}
              {pendingEdit.files.length === 1 ? (
                <em>{pendingEdit.files[0].name}</em>
              ) : (
                <strong>{pendingEdit.files.length} files</strong>
              )}
              ?
            </div>
            <div className="approve-diffs">
              {pendingEdit.files.slice(0, 5).map((f, i) => (
                <div className="approve-diff-file" key={`${f.name}-${i}`}>
                  {pendingEdit.files.length > 1 && (
                    <div className="approve-diff-name">{f.name}</div>
                  )}
                  <DiffPreview
                    before={f.before}
                    after={f.after}
                    clipped={f.clipped}
                    language={languageForFile(f.name)}
                  />
                </div>
              ))}
              {pendingEdit.files.length > 5 && (
                <div className="approve-diff-more">
                  …and {pendingEdit.files.length - 5} more file(s) in this change.
                </div>
              )}
            </div>
            <div className="approve-actions">
              <button
                className="primary"
                onClick={() => a.resolveEditApproval(pendingEdit, "once")}
              >
                Apply
              </button>
              {pendingEdit.allowTurn && (
                <button onClick={() => a.resolveEditApproval(pendingEdit, "turn")}>
                  Apply for the rest of this answer
                </button>
              )}
              <button
                className="danger"
                onClick={() => a.resolveEditApproval(pendingEdit, "deny")}
              >
                Don't apply
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
                  className="ctx-item danger btn-ic"
                  onClick={() => {
                    const id = s.ctxMenu!.file.id;
                    a.cancelConfirm();
                    s.setCtxMenu(null);
                    a.removeFile(id);
                  }}
                >
                  <CheckIcon size={13} /> Remove
                </button>
                <button className="ctx-item btn-ic" onClick={a.cancelConfirm}>
                  <CloseIcon size={13} /> Keep
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
              placeholder="Search this room, or run a command…"
              aria-label="Search this room or run a command"
              value={s.searchQuery}
              onChange={(e) => {
                s.setSearchQuery(e.target.value);
                s.setSearchSel(0);
              }}
              onKeyDown={onPaletteKey}
            />
            <div className="search-results">
              {s.searchQuery.trim() &&
                searchResults &&
                totalItems === 0 && (
                  <div className="search-empty">
                    Nothing matches “{s.searchQuery.trim()}” — not in files,
                    chats, memories, or commands.
                  </div>
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
              {actions.length > 0 && (
                <div className="search-group">
                  <div className="search-group-head">
                    Commands <span className="search-count">{actions.length}</span>
                  </div>
                  {actions.map((act, i) => {
                    const idx = actOffset + i;
                    return (
                      <button
                        key={act.id}
                        className={`search-result action ${s.searchSel === idx ? "sel" : ""}`}
                        disabled={act.disabled}
                        onMouseEnter={() => s.setSearchSel(idx)}
                        onClick={() => runSel(idx)}
                      >
                        <span className="search-result-title">{act.label}</span>
                        <span className="search-result-snippet">{act.hint}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="search-hint">
              ↑↓ to move · Enter to run · Esc to close
            </div>
          </div>
        </div>
      )}
    </>
  );
}
