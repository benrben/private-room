import { useEffect, useState } from "react";
import { FileContent, RoomInfo, formatSize } from "../api";
import {
  ChevronLeftIcon,
  CloseIcon,
  CollapseLeftIcon,
  DotsIcon,
  DownloadIcon,
  EmptyViewerArt,
  EyeIcon,
  FocusIcon,
  LockIcon,
  MicIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  ScriptIcon,
  SendIcon,
  SparkIcon,
  TimeMachineIcon,
} from "../icons";
import RoomMap from "../viewers/RoomMap";
import { fileLabel, formatWhen, provenanceLine } from "./composer";
import ViewerRouter from "./ViewerRouter";
import CloudView from "../viewers/CloudView";
import FrontPage from "./FrontPage";
import MemoryView from "./MemoryView";
import RecordingsPage from "./RecordingsPage";
import { useTextEncoding } from "../viewers/TextEncoding";
import {
  DocSourceCard,
  READER_KINDS,
  ReadingProgress,
  useReadingProgress,
} from "./ReaderShell";
import ConnectorsView from "./ConnectorsView";
import { BrowserView } from "./BrowserView";
import { WSState } from "./state";
import { WSActions } from "./actions";
import { FILE_BEARING_AREAS, WorkArea } from "./types";
import { LayoutApi } from "../shell/useLayout";
import { WorkflowsPage } from "./workflows/WorkflowsPage";
import { WorkflowGlyph } from "./workflows/workflowGlyph";
import { ScriptsPage } from "./scripts/ScriptsPage";
import SkillsView from "./skills/SkillsView";
import { CreatePage } from "./create/CreatePage";
import { QuickActionsMenu, bindingMatches, QuickAction } from "./QuickActions";
import type { ViewerKind } from "../api";

/** Viewers that draw their own toolbar and manage their own scrolling, and so
 * need the full height of the pane rather than sizing to their content.
 *
 * This used to be spelled inline as `kind === "code" || kind === "html"`, which
 * was complete when those were the only two. Every viewer added since has a
 * bar across the top and a scroll region under it, and one that misses this
 * set collapses to content height with its toolbar floating above nothing. */
const FILL_HEIGHT_KINDS = new Set<ViewerKind>([
  "archive",
  "book",
  "code",
  "html",
  "json",
  "log",
  "sheet",
  "csv",
  "slides",
  "subtitle",
  "svg",
  "worddoc",
]);

/** True when a file name is a runnable script (.py/.js). */
function isScriptName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".py") || lower.endsWith(".js");
}

/** True when a media transcript carries real speech — at least one timestamped
 * "[m:ss] …" row with words. The "(transcribed from recording)" provenance line
 * and a lone silence "." don't count, so downstream actions (Minutes) don't
 * offer to summarize a recording that has nothing to summarize. */
function transcriptHasSpeech(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.split("\n").some((line) => {
    const m = line.match(/^\[(?:\d+:)?\d{1,2}:\d{2}\]\s*(.*)$/);
    return m ? /[\p{L}\p{N}]/u.test(m[1]) : false;
  });
}

/** A file's-worth of nothing, so `useTextEncoding` below — a hook, which has
 * to run on every render whether or not a file is open — always has a real
 * `FileContent` to ask rather than needing a nullable signature of its own.
 * `kind: "binary"` is never in `RE_DECODABLE_KINDS`, so with no file open
 * this resolves straight to the hook's idle state. */
const NO_FILE: FileContent = {
  kind: "binary",
  name: "",
  mime: "",
  editable: false,
  text: null,
  dataB64: null,
  mediaToken: null,
  mediaMeta: null,
  webMeta: null,
};

/** The center pane: a stable content header (breadcrumb + pane controls)
 * over the active surface — open file (any viewer), Workflows, Scripts,
 * Room Map, Memory, Recordings, the Front Page, or the sealed-room empty
 * state. An open file always wins, so citations and agent opens are never
 * swallowed by an area page; Escape returns to the area underneath. */
export default function ViewerPane({
  s,
  a,
  info,
  layout,
  area,
  contextArea,
}: {
  s: WSState;
  a: WSActions;
  info: RoomInfo;
  layout: LayoutApi;
  /** The place: which area page draws when no file is open, and where Escape
   * returns to when one is. */
  area: WorkArea;
  /** What the open document's own context is — see Workspace.tsx. Equal to
   * `area` except when a file is showing over an area that does not hold it. */
  contextArea: WorkArea;
}) {
  const { openFile } = s;
  // PRIV-1: the reader's "blocked version" toggle — resets per file.
  const [cloudView, setCloudView] = useState(false);
  useEffect(() => setCloudView(false), [openFile?.id]);
  // Which version's Delete is armed. Local, not a WSState slot: deleting a
  // version is the only History action with no undo, so the armed state must
  // die with the popover rather than survive a file switch.
  const [confirmDeleteVersion, setConfirmDeleteVersion] = useState<string | null>(
    null,
  );
  useEffect(() => setConfirmDeleteVersion(null), [openFile?.id, s.showHistory]);
  // P1-4: the "..." overflow popover (History, Copy all text, Duplicate,
  // Dictate, the cloud-payload preview, the encoding picker). Local, not a
  // WSState slot, for the same reason confirmDeleteVersion is — it belongs to
  // this popover's lifetime, not to the file, and must not survive a switch.
  const [overflowOpen, setOverflowOpen] = useState(false);
  useEffect(() => setOverflowOpen(false), [openFile?.id]);
  // "Preview cloud payload" only means something for a file that HAS text a
  // cloud model would be handed. Asking the kind was a proxy for that and went
  // stale every time a kind was added; ask the file itself.
  const cloudViewable = openFile != null && !!openFile.content.text;
  // P1-4: which of Edit/Run/Duplicate applies, computed once rather than
  // twice (the header used to ask `editModeOf` separately for the Edit
  // button and for Duplicate's own condition).
  const mode = openFile ? a.editModeOf(openFile.content) : null;
  // P1-4: lifted out of ViewerRouter, which used to own this hook entirely,
  // so the header's overflow menu can draw the same picker — see
  // TextEncoding.tsx. `enc` (not `encoding`) on purpose: ViewerRouter passes
  // it straight through to the editors' save banners under that exact name,
  // and `encoding.test.mjs` reads the literal `enc.decoded` text out of the
  // source to make sure every in-place editor still warns about a legacy
  // encoding being converted on save.
  const enc = useTextEncoding(openFile?.id ?? "", openFile?.content ?? NO_FILE);
  // §14, the research reader: a source card at the head of the column and a
  // reading-progress stroke over it. Reading formats only — see READER_KINDS —
  // and never over the cloud-payload preview, which is a diagnostic of what
  // WOULD be sent rather than a document to read.
  const readerShell =
    openFile != null &&
    !cloudView &&
    !s.editMode &&
    READER_KINDS.has(openFile.content.kind);
  // Keyed by file id, so opening the next document starts its own read.
  const reading = useReadingProgress(openFile?.id ?? "");
  const frontPageView =
    s.fp && (s.fp.fileCount > 0 || s.fp.chatCount > 0 || s.fp.memories.length > 0)
      ? s.fp
      : null;
  const AREA_CRUMBS: Record<WorkArea, string> = {
    files: "Files",
    home: "Home",
    map: "Room Map",
    recordings: "Recordings",
    workflows: "Workflows",
    scripts: "Scripts",
    skills: "Skills",
    memory: "Memory & scratch pad",
    connectors: "Connectors",
    create: "Create",
    browser: "Private browser",
  };
  const folderName = openFile
    ? s.folders.find(
        (fo) => fo.id === s.files.find((f) => f.id === openFile.id)?.folderId,
      )?.name
    : undefined;
  // "Describe new files automatically" (Settings > Behavior) — the cached
  // one-liner, when this file has one. P1-4 removed the viewer's own title
  // (the breadcrumb's crumb-title carries the name now), so this is the
  // subtitle line that sits under it; most files won't have one yet.
  const fileDescription = openFile
    ? s.files.find((f) => f.id === openFile.id)?.aiSummary
    : undefined;
  // The trail must name what is ON SCREEN. With nothing open the "files" area
  // renders the room's home page (or the sealed-room empty state), so saying
  // "Files" described a list the user wasn't looking at.
  const areaCrumb =
    area === "files" && !s.showWorkflows && !s.showScripts && !s.showMap
      ? "Home"
      : AREA_CRUMBS[area];
  // The place underneath, when it is not where this document lives. Drawn as a
  // way back rather than as part of the trail: a room file opened from the
  // browser is not browser content, but the browser IS still what Escape
  // returns to, and that was previously true with nothing on screen saying so.
  const backTo = openFile && contextArea !== area ? AREA_CRUMBS[area] : null;
  // BROWSE-1: the page is a NATIVE webview floating above everything this app
  // draws, so any modal, approval card or palette is invisible and unclickable
  // underneath it. Park the page (BrowserView shrinks it to 1×1) whenever one
  // of them is up — not just for the browse-consent card it was written for,
  // which left connector/edit/script approvals waiting behind the page forever.
  const overlayShowing =
    s.browseConsents.length > 0 ||
    s.mcpApprovals.length > 0 ||
    s.editApprovals.length > 0 ||
    s.scriptApprovals.length > 0 ||
    s.showSearch ||
    s.showSettings ||
    s.showShortcuts ||
    s.showFeedback ||
    s.showAddLink ||
    s.aiPrompt !== null ||
    s.studioPrompt !== null ||
    s.compare !== null ||
    s.ctxMenu !== null;
  return (
    <section className="viewer" aria-label="Workspace">
      <div className="editor-breadcrumb-bar">
        <div className="editor-breadcrumb" title={openFile?.content.name}>
          <strong>{info.name}</strong>
          {" / "}
          {openFile ? (
            <>
              {/* Only an area that CONTAINS this file may name itself here.
                  Recordings and Scripts do; nothing else does, so the trail
                  is otherwise the file's own folder — see types.ts. */}
              {FILE_BEARING_AREAS.includes(contextArea)
                ? `${AREA_CRUMBS[contextArea]} / `
                : ""}
              {folderName ? `${folderName} / ` : ""}
              <span className="crumb-title">
                {fileLabel(openFile.content.name, s.files)}
              </span>
            </>
          ) : (
            <span className="crumb-title">{areaCrumb}</span>
          )}
        </div>
        {backTo && (
          <button
            className="crumb-back btn-ic"
            aria-label={`Close this file and go back to ${backTo}`}
            data-tip="Escape"
            onClick={() => s.setOpenFile(null)}
          >
            <ChevronLeftIcon size={12} /> {backTo}
          </button>
        )}
        <div className="pane-actions">
          <button
            className="pane-icon-btn"
            data-tip="Focus this pane"
            aria-label="Give the workspace pane the full width"
            onClick={() => layout.toggleFocus("center")}
          >
            <FocusIcon size={14} />
          </button>
          <button
            className="pane-icon-btn"
            data-tip="Collapse"
            aria-label="Collapse the workspace pane"
            onClick={() => layout.collapsePane("center")}
          >
            <CollapseLeftIcon size={14} />
          </button>
        </div>
      </div>
      {/* The generated one-liner, when this file has one — see fileDescription
          above. Its own strip rather than something squeezed into the
          breadcrumb: the breadcrumb line is the room/folder TRAIL (P0-3) and
          already truncates hard on a narrow pane; this is the file's own
          content and deserves its own row, not a fight for the same pixels. */}
      {openFile && fileDescription && (
        <div className="viewer-file-description" title={fileDescription}>
          {fileDescription}
        </div>
      )}
      {openFile ? (
        <>
          <div className="viewer-head">
            {/* Renaming used to exist ONLY in the library's right-click menu,
                so the file you were actually looking at could not be renamed
                without hunting for its row. Same handler, same commit rules.
                P2-1: this used to sit beside a full-size title repeating the
                same filename the breadcrumb above it (and the tab above
                THAT) already carried, with the folder context, and the
                breadcrumb is the one place that actually earns its keep. No
                replacement title is drawn here — just the affordance that
                slot always had, now icon-only like Close beside it. */}
            {s.renamingFile?.id === openFile.id &&
            s.renamingFile.where === "viewer" ? (
              <input
                className="file-rename-input"
                autoFocus
                dir="auto"
                aria-label="Rename this file"
                value={s.renamingFile.name}
                onChange={(e) =>
                  s.setRenamingFile({
                    id: openFile.id,
                    name: e.target.value,
                    where: "viewer",
                  })
                }
                onBlur={a.commitRenameFile}
                onKeyDown={(e) => {
                  if (e.key === "Enter") a.commitRenameFile();
                  if (e.key === "Escape") s.setRenamingFile(null);
                }}
              />
            ) : (
              <button
                className="pane-icon-btn"
                data-tip="Rename"
                aria-label="Rename this file"
                onClick={() =>
                  // `where` keeps this box and the library row's box off the
                  // screen at the same time — they share one state slot, and
                  // two autoFocus inputs cancel each other on the first blur.
                  s.setRenamingFile({
                    id: openFile.id,
                    name: openFile.content.name,
                    where: "viewer",
                  })
                }
              >
                <PencilIcon size={13} />
              </button>
            )}
            <span className="viewer-actions">
              {/* P1-4: the file's own core verbs, given real button weight
                  (the plain button outline, not .subtle's quiet text) so
                  they read as the 2-3 things this toolbar is actually FOR.
                  Which ones apply is the same per-kind condition as before
                  (a script gets Edit+Run+Export, a recording with a
                  transcript gets Minutes+Export, most documents get
                  Edit+Export) — only the drawing changed, and where the
                  other six-to-eight items went: the overflow menu below. */}
              {!cloudView &&
                (() => {
                  if (!mode) return null;
                  const title =
                    mode === "copy"
                      ? "Edit the extracted text — saving creates a separate Markdown copy; the original file is unchanged"
                      : mode === "docx"
                        ? "Edit this document's text — saving writes it back into the Word file, keeping its styles and layout"
                        : "Switch between preview and editing";
                  return (
                    <button
                      className="btn-ic viewer-primary"
                      title={title}
                      onClick={() => s.setEditMode(!s.editMode)}
                    >
                      {s.editMode ? <EyeIcon size={13} /> : <PencilIcon size={13} />}
                      {s.editMode ? "Preview" : mode === "copy" ? "Edit as text" : "Edit"}
                    </button>
                  );
                })()}
              {/* Wave 5 (Idea 13): a .py/.js file runs from its own header —
                  outputs are saved back into the room, versioned + undoable. */}
              {isScriptName(openFile.content.name) &&
                (() => {
                  const sc = s.scripts.find((x) => x.fileId === openFile.id);
                  const running = !!(sc?.lastRun?.jobId && s.jobProgress[sc.lastRun.jobId]);
                  return (
                    <button
                      className="btn-ic viewer-primary"
                      title="Run this script — outputs are saved into the room"
                      disabled={running}
                      onClick={() => {
                        if (s.editMode && s.editorDirtyRef.current) {
                          s.pushToast("info", "Save your edits first, then run the script.");
                          return;
                        }
                        void a.runScript(openFile.id);
                      }}
                    >
                      <PlayIcon size={13} /> Run
                    </button>
                  );
                })()}
              {(openFile.content.kind === "audio" ||
                openFile.content.kind === "video" ||
                openFile.content.kind === "recording") &&
                transcriptHasSpeech(openFile.content.text) && (
                  <button
                    className="btn-ic viewer-primary"
                    title="Turn this recording's transcript into timeline-style HTML minutes (summary, decisions, action items)"
                    disabled={s.asking}
                    onClick={a.makeMinutes}
                  >
                    <SparkIcon size={13} /> Minutes
                  </button>
                )}
              {(() => {
                // Wave 5 shortcuts: OTHER scripts whose declared inputs/outputs
                // name the open file. Used to show the first two as bare
                // icon-only play-glyph pills beside this menu — exactly the
                // unlabelled-control problem P1-4 is about — so now every
                // one of them, not just the overflow, lives behind the one
                // "Scripts" button.
                const name = openFile.content.name;
                const scriptActions: QuickAction[] = s.scripts
                  .filter(
                    (sc) =>
                      sc.fileId !== openFile.id &&
                      (sc.inputs.includes(name) || sc.outputs.includes(name)),
                  )
                  .map((sc) => ({
                    id: sc.fileId,
                    label: sc.name,
                    icon: <PlayIcon size={13} />,
                    hint: `Run ${sc.name}`,
                    onRun: () => void a.runScript(sc.fileId),
                  }));
                return (
                  <QuickActionsMenu
                    actions={scriptActions}
                    open={s.qaScriptMenuOpen ?? false}
                    onOpenChange={(o) => s.setQaScriptMenuOpen(o)}
                    buttonLabel="Scripts"
                    buttonIcon={<ScriptIcon size={13} />}
                  />
                );
              })()}
              {(() => {
                // Wave 4a shortcuts: file-scoped ACTIVE workflows matching this
                // file, run on the open file with one click.
                const fileActions: QuickAction[] = s.workflows
                  .filter(
                    (w) =>
                      w.status === "active" &&
                      bindingMatches(
                        w.binding,
                        openFile.content.kind,
                        openFile.content.name,
                        openFile.id,
                      ),
                  )
                  .map((w) => ({
                    id: w.id,
                    label: w.name,
                    icon: <WorkflowGlyph emoji={w.emoji} size={15} />,
                    onRun: () =>
                      void a.runWorkflowOn(w.id, openFile.id, openFile.content.name),
                  }));
                return (
                  <QuickActionsMenu
                    actions={fileActions}
                    open={s.qaFileMenuOpen ?? false}
                    onOpenChange={(o) => s.setQaFileMenuOpen(o)}
                    buttonLabel="Actions"
                    buttonIcon={<SparkIcon size={13} />}
                  />
                );
              })()}
              <button
                className="btn-ic viewer-primary"
                title="Export a normal copy out of the room"
                data-agent-blocked
                onClick={() => a.exportOne(openFile.id, openFile.content.name)}
              >
                <DownloadIcon size={13} /> Export
              </button>
              {/* P1-4: everything else — the cloud-payload preview, Duplicate,
                  Copy all text, Dictate, History and the encoding picker that
                  used to be its own strip over the document — collapsed into
                  one popover instead of an eight-wide flat row that clipped
                  on an HTML file. `viewer-overflow-wrap` also anchors the
                  History popover, which used to hang off the History button
                  itself and now hangs off this one instead — same corner of
                  the toolbar, same `history-pop`, untouched inside. */}
              <span className="viewer-overflow-wrap">
                <button
                  className={`subtle btn-ic${cloudView || s.showHistory ? " cloudview-on" : ""}`}
                  title="More actions"
                  aria-label="More actions on this file"
                  aria-haspopup="menu"
                  aria-expanded={overflowOpen}
                  onClick={() => setOverflowOpen((o) => !o)}
                >
                  <DotsIcon size={14} />
                </button>
                {overflowOpen && (
                  <>
                    <div
                      className="menu-backdrop"
                      onMouseDown={() => setOverflowOpen(false)}
                    />
                    <div
                      className="pop-menu viewer-overflow-menu"
                      role="menu"
                      aria-label="More actions on this file"
                    >
                      {cloudViewable && (
                        <button
                          role="menuitem"
                          className="pop-item"
                          onClick={() => {
                            setCloudView(!cloudView);
                            setOverflowOpen(false);
                          }}
                        >
                          {cloudView
                            ? "Close preview"
                            : "Show me exactly what would be sent"}
                        </button>
                      )}
                      {mode === "editor" && (
                        <button
                          role="menuitem"
                          className="pop-item"
                          title="Make a second copy of this file in the room, so you can branch it"
                          onClick={() => {
                            setOverflowOpen(false);
                            void a.duplicateOpenFile();
                          }}
                        >
                          <PlusIcon size={13} /> Duplicate
                        </button>
                      )}
                      {openFile.content.text && (
                        <button
                          role="menuitem"
                          className="pop-item"
                          title="Copy the whole document's extracted text"
                          onClick={() => {
                            setOverflowOpen(false);
                            a.copyAllText();
                          }}
                        >
                          Copy all text
                        </button>
                      )}
                      {openFile.content.editable && (
                        <button
                          role="menuitem"
                          className={`pop-item mic-btn ${a.micState("file").cls}`}
                          title={
                            s.dictOwner === "file" && s.dictState === "recording"
                              ? "Stop and append the words"
                              : "Dictate into this file — your words are appended to its saved content"
                          }
                          disabled={a.micState("file").disabled}
                          // Deliberately does NOT close the menu — Dictate is
                          // a start/stop toggle, and this row's recording dot
                          // is the only way to see (or stop) it once started.
                          onClick={a.dictateIntoFile}
                        >
                          <MicIcon size={12} /> Dictate
                        </button>
                      )}
                      <button
                        role="menuitem"
                        className={`pop-item ${s.showHistory ? "active" : ""}`}
                        onClick={() => {
                          setOverflowOpen(false);
                          a.openHistory();
                        }}
                      >
                        <TimeMachineIcon size={13} /> History
                      </button>
                      {/* The encoding picker never shows here while editing:
                          picking a different encoding re-reads the file's raw
                          bytes and remounts the editor with that new text (see
                          TextEncoding.tsx), which would silently throw away
                          whatever is typed but unsaved. Preview-only, same as
                          the strip this replaced. */}
                      {!s.editMode && enc.picker && (
                        <>
                          <div className="pop-menu-sep" />
                          <div className="viewer-enc-row">{enc.picker}</div>
                        </>
                      )}
                    </div>
                  </>
                )}
                {s.showHistory && (
                  <div className="history-pop">
                    {/* ART-1: what made the state on screen right now. Only
                        rendered when the room actually recorded it — see
                        `provenanceLine`, which returns "" otherwise. */}
                    {provenanceLine(s.headProvenance) && (
                      <div className="tm-now">
                        <span className="tm-now-label">Now</span>
                        <span className="tm-prov">
                          {provenanceLine(s.headProvenance)}
                        </span>
                      </div>
                    )}
                    {s.versions.length === 0 ? (
                      <div className="history-empty">
                        No earlier versions yet.
                      </div>
                    ) : (
                      <div className="time-machine">
                        {s.versions.map((v) =>
                          confirmDeleteVersion === v.id ? (
                            // No undo behind this one: there is no history of
                            // the history. Agent-blocked like every other armed
                            // destructive confirm (ADD-25).
                            <div key={v.id} className="tm-confirm" data-agent-blocked>
                              <span className="tm-confirm-q">
                                Delete this saved version? It cannot be brought
                                back.
                              </span>
                              <div className="tm-confirm-actions">
                                <button
                                  className="primary"
                                  onClick={() => {
                                    setConfirmDeleteVersion(null);
                                    void a.deleteVersion(v.id);
                                  }}
                                >
                                  Delete
                                </button>
                                <button
                                  className="subtle"
                                  onClick={() => setConfirmDeleteVersion(null)}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : s.confirmRestore === v.id ? (
                            // ADD-25: the agent driver must not be able to
                            // confirm a restore it didn't earn.
                            <div key={v.id} className="tm-confirm" data-agent-blocked>
                              <span className="tm-confirm-q">
                                Restore this version? Current changes will be
                                replaced.
                              </span>
                              <div className="tm-confirm-actions">
                                <button
                                  className="primary"
                                  onClick={() => {
                                    s.setConfirmRestore(null);
                                    void a.restoreVersion(v.id);
                                  }}
                                >
                                  Restore
                                </button>
                                <button
                                  className="subtle"
                                  onClick={() => s.setConfirmRestore(null)}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            // Idea 11: the row is no longer one restore button —
                            // it offers a read-only Compare (safe for the agent)
                            // and an armed Restore (still data-agent-blocked).
                            <div key={v.id} className="tm-version">
                              <span className="tm-version-dot" />
                              <span className="tm-cause">
                                {v.cause}
                                {v.pinned && (
                                  <span className="tm-kept" title="Kept — this version is never dropped to make room">
                                    Kept
                                  </span>
                                )}
                                {provenanceLine(v.provenance) && (
                                  <span className="tm-prov">
                                    {provenanceLine(v.provenance)}
                                  </span>
                                )}
                              </span>
                              <span className="tm-time">
                                {formatWhen(v.savedAt)}
                                {v.bytes > 0 && (
                                  <span className="tm-size">
                                    {" · "}
                                    {formatSize(v.bytes)}
                                  </span>
                                )}
                              </span>
                              <span className="tm-actions">
                                <button
                                  className="subtle tm-action"
                                  title="See what changed, side by side"
                                  onClick={() => void a.openCompare(v)}
                                >
                                  Compare
                                </button>
                                <button
                                  className="subtle tm-action"
                                  title={
                                    v.pinned
                                      ? "Stop keeping this version — it can be dropped again once there are newer ones"
                                      : "Keep this version — it is never dropped to make room for newer ones"
                                  }
                                  onClick={() => void a.pinVersion(v.id, !v.pinned)}
                                >
                                  {v.pinned ? "Unkeep" : "Keep"}
                                </button>
                                <button
                                  className="subtle tm-action"
                                  title="Restore this saved version"
                                  onClick={() => s.setConfirmRestore(v.id)}
                                >
                                  Restore
                                </button>
                                {/* Deleting a version is not itself undoable —
                                    there is no history of the history — so it
                                    arms, like Restore does. */}
                                <button
                                  className="subtle tm-action"
                                  title="Delete this saved version and free its space"
                                  data-agent-blocked
                                  onClick={() => setConfirmDeleteVersion(v.id)}
                                >
                                  Delete
                                </button>
                              </span>
                            </div>
                          ),
                        )}
                        {/* The rolling window used to be invisible: the
                            eleventh save silently dropped the oldest version
                            and nothing on screen had ever mentioned a limit.
                            State it, with what history costs and how to opt a
                            version out of it. */}
                        <div className="tm-retention">
                          {`Only the ${s.versionsKept} most recent versions are kept — press Keep to hold on to one.`}
                          {(() => {
                            const total = s.versions.reduce(
                              (n, v) => n + (v.bytes || 0),
                              0,
                            );
                            return total > 0
                              ? ` This file's history uses ${formatSize(total)}.`
                              : "";
                          })()}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </span>
              {/* Live QA: typing in a .pptx or .docx and pressing Close threw
                  the buffer away and returned to Home, with no dialog and no
                  undo. Every other exit asked; this one didn't. */}
              <button
                className="pane-icon-btn"
                data-tip="Close"
                aria-label="Close this file"
                onClick={() =>
                  a.guardLeave("Closing this file", () => s.setOpenFile(null))
                }
              >
                <CloseIcon size={12} />
              </button>
            </span>
          </div>
          {/* Wave 1b (idea 10): the AI wrote this file while the user's editor
              buffer was dirty — the reload was skipped, the user chooses. Both
              paths are safe: every overwrite snapshots to History first. */}
          {s.staleFile === openFile.id && (
            <div className="stale-banner" role="status">
              <span className="stale-banner-text">
                The AI changed this file while you were editing.
              </span>
              <span className="stale-banner-actions">
                <button
                  className="primary"
                  title="Show the AI's version (your unsaved edits are discarded)"
                  onClick={() => {
                    s.setStaleFile(null);
                    s.editorDirtyRef.current = false;
                    void a.viewFile(openFile.id);
                  }}
                >
                  Load AI version
                </button>
                <button
                  className="subtle"
                  title="Keep your buffer — your next ⌘S overwrites; the AI's version stays in History"
                  onClick={() => s.setStaleFile(null)}
                >
                  Keep editing
                </button>
              </span>
            </div>
          )}
          {/* §14: how far down the document the reader has come, drawn as a
              marker stroke across the head of the column. Outside the scroller
              so it stays put while the page moves under it. */}
          {readerShell && <ReadingProgress value={reading.progress} />}
          <div
            // `fill` = this viewer manages its own scrolling and wants the
            // full height. Naming the two kinds that did was fine when there
            // were two; every viewer with its own toolbar and scroll region
            // needs it, and one that doesn't get it collapses to content
            // height with its toolbar floating above nothing.
            className={`viewer-body ${
              FILL_HEIGHT_KINDS.has(openFile.content.kind) ||
              (s.editMode && a.editModeOf(openFile.content) !== "grid")
                ? "fill"
                : ""
            }${readerShell ? " is-reader" : ""}`}
            ref={readerShell ? reading.ref : undefined}
          >
            {/* The room's own record of the document, at the head of its
                column. Stands down for a saved web page: ViewerRouter draws
                PageSource for those, and the page's own declarations are the
                better witness. */}
            {readerShell && !openFile.content.webMeta && (
              <DocSourceCard file={s.files.find((f) => f.id === openFile.id)} />
            )}
            {cloudView ? (
              <CloudView fileId={openFile.id} />
            ) : (
            <ViewerRouter
              openFile={openFile}
              viewerRev={s.viewerRev}
              editMode={s.editMode}
              editModeOf={a.editModeOf}
              enc={enc}
              editCell={a.editCell}
              saveEdit={a.saveEdit}
              saveEditAsCopy={a.saveEditAsCopy}
              onDirtyChange={(d) => {
                s.editorDirtyRef.current = d;
              }}
              // Lets the unsaved-edits dialog's "Save" write the buffer that is
              // about to be unmounted — only the editor holds that text.
              registerSave={(fn) => {
                s.editorSaveRef.current = fn;
              }}
              recording={{
                live: s.recLive,
                saveProgress: s.recSave,
                pushToast: s.pushToast,
                onStart: a.startLiveRecording,
                onPause: a.pauseLiveRecording,
                onResume: a.resumeLiveRecording,
                onStop: a.stopLiveRecording,
              }}
              sttStatus={s.sttStatus}
            />
            )}
          </div>
        </>
      ) : s.showWorkflows ? (
        <WorkflowsPage s={s} a={a} />
      ) : s.showScripts ? (
        <ScriptsPage s={s} a={a} />
      ) : s.showMap ? (
        <div className="room-map-canvas">
          <RoomMap onOpenFile={(id) => a.viewFile(id)} />
        </div>
      ) : area === "browser" ? (
        <BrowserView
          parked={overlayShowing}
          // BROWSE-3: ＋ on a result imports it AND pins it to the composer, so
          // the page's text is in the very next turn rather than only findable
          // by a later search.
          onAttach={(file) => a.toggleAttach(file)}
          onAsk={(query) => s.setQuestion(query)}
        />
      ) : area === "connectors" ? (
        <ConnectorsView />
      ) : area === "skills" ? (
        <SkillsView s={s} a={a} info={info} />
      ) : area === "memory" ? (
        <MemoryView s={s} a={a} info={info} />
      ) : area === "recordings" ? (
        <RecordingsPage s={s} a={a} info={info} />
      ) : area === "create" ? (
        <CreatePage s={s} a={a} />
      ) : frontPageView ? (
        <FrontPage page={frontPageView} s={s} a={a} layout={layout} info={info} />
      ) : (
        <div className="viewer-empty">
          <div className="viewer-empty-icon">
            <EmptyViewerArt />
          </div>
          <h1 className="viewer-empty-title">Your room is sealed</h1>
          <p className="viewer-empty-sub">
            Everything you add stays inside{" "}
            <strong>{info.path.split("/").pop()}</strong>. Add a file, open a
            note, or ask the room a question about everything inside.
          </p>
          <div className="viewer-empty-actions">
            <button className="qa-btn primary" onClick={a.importFiles}>
              <PlusIcon size={15} /> Add a file
            </button>
            <button
              className="qa-btn"
              disabled={
                s.files.length === 0 ||
                s.summaryStarting ||
                s.jobs.some(
                  (j) => j.status === "running" || j.status === "queued",
                )
              }
              onClick={() => void a.startDeepSummary()}
            >
              <SparkIcon size={15} /> Summarize room
            </button>
            <button
              className="qa-btn"
              onClick={() => a.focusComposer(layout)}
            >
              <SendIcon size={14} /> Ask the room
            </button>
          </div>
          <div className="viewer-empty-note">
            <LockIcon size={16} />
            <div>
              <strong>Encrypted on your Mac.</strong> Your data is encrypted
              and never leaves this file unless you choose a cloud model.
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
