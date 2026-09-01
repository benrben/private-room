import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { formatSize, type ViewerKind } from "../api";
import { BookOpenIcon, CloseIcon, DotsIcon, DownloadIcon, EyeIcon, MicIcon, PencilIcon, PlayIcon, PlusIcon, ScriptIcon, SparkIcon, TimeMachineIcon } from "../icons";
import { displayName, formatWhen, provenanceLine } from "./composer";
import { libraryStatus } from "./fileVisibility";
import type { WSState } from "./state";
import type { WSActions } from "./actions";
import type { LayoutApi } from "../shell/useLayout";
import { WorkflowGlyph } from "./workflows/workflowGlyph";
import { QuickActionsMenu, bindingMatches, type QuickAction } from "./QuickActions";
import type { useTextEncoding } from "../viewers/TextEncoding";
import { withQuote } from "./quoteSelection";
import { isScriptName, transcriptHasSpeech, useDismissOnEscape, type ViewerQuote } from "./viewerQuote";

type LibraryPlacement = NonNullable<ReturnType<typeof libraryStatus>>;

function SectionLibraryChip({
  a,
  fileId,
  label,
  status,
  asking,
  setAsking,
}: {
  a: WSActions;
  fileId: string;
  label: string;
  status: LibraryPlacement;
  asking: boolean;
  setAsking: Dispatch<SetStateAction<boolean>>;
}) {
  return (
    <span className="library-chip-wrap">
      <span className="library-chip" role="status">
        Section only
      </span>
      <button
        className="btn-ic library-chip-btn"
        aria-label={`Add ${label} to the Library`}
        aria-haspopup="dialog"
        aria-expanded={asking}
        onClick={() => setAsking((v) => !v)}
      >
        <BookOpenIcon size={12} /> Add to Library
      </button>
      {asking && (
        <>
          <div className="menu-backdrop" onMouseDown={() => setAsking(false)} />
          <div className="pop-menu library-chip-pop" role="dialog" aria-label="Add to Library">
            <p className="library-chip-q">
              <strong>Add to Library?</strong>
              <span>
                “{label}” will also appear in Home. It stays in {status.where},
                and this keeps one file — no duplicate.
              </span>
            </p>
            <div className="library-chip-actions">
              <button className="subtle" autoFocus onClick={() => setAsking(false)}>
                Cancel
              </button>
              <button
                className="primary"
                onClick={() => {
                  setAsking(false);
                  void a.setInLibrary(fileId, true);
                }}
              >
                Add
              </button>
            </div>
          </div>
        </>
      )}
    </span>
  );
}

function LinkedLibraryChip({
  s,
  a,
  fileId,
  label,
  status,
  open,
  setOpen,
}: {
  s: WSState;
  a: WSActions;
  fileId: string;
  label: string;
  status: LibraryPlacement;
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
}) {
  return (
    <span className="library-chip-wrap">
      <button
        className="library-chip is-linked"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`“${label}” is in the Library and in ${status.where}`}
        onClick={() => setOpen((v) => !v)}
      >
        <BookOpenIcon size={12} /> In Library
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onMouseDown={() => setOpen(false)} />
          <div className="pop-menu library-chip-pop" role="menu" aria-label="Library placement">
            <button
              role="menuitem"
              className="pop-item"
              onClick={() => {
                setOpen(false);
                s.setShowMap(false);
                s.setShowScripts(false);
                s.setShowWorkflows(false);
                s.setArea("files");
                s.setLibraryTab("browse");
              }}
            >
              View in Library
            </button>
            <button
              role="menuitem"
              className="pop-item"
              title={`Stop showing this in Home. It stays in ${status.where} — this does not delete it.`}
              onClick={() => {
                setOpen(false);
                void a.setInLibrary(fileId, false);
              }}
            >
              <span className="pop-item-body">
                Remove from Library
                <span className="pop-item-sub">
                  Hides the Home entry — the object stays in {status.where}
                </span>
              </span>
            </button>
          </div>
        </>
      )}
    </span>
  );
}

export function LibraryChip({
  s,
  a,
  fileId,
}: {
  s: WSState;
  a: WSActions;
  fileId: string;
}) {
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  // Both popovers die with the file, like every other menu in this header.
  useEffect(() => {
    setOpen(false);
    setAsking(false);
  }, [fileId]);
  useDismissOnEscape(asking, setAsking);
  useDismissOnEscape(open, setOpen);
  const file = s.files.find((f) => f.id === fileId);
  const status = file ? libraryStatus(file) : null;
  if (!file || !status) return null;
  const label = displayName(file.name);
  return status.linked ? (
    <LinkedLibraryChip {...{ s, a, fileId, label, status, open, setOpen }} />
  ) : (
    <SectionLibraryChip {...{ a, fileId, label, status, asking, setAsking }} />
  );
}

function editButtonTitle(mode: ReturnType<WSActions["editModeOf"]>): string {
  if (mode === "copy") {
    return "Edit the extracted text — saving creates a separate Markdown copy; the original file is unchanged";
  }
  if (mode === "docx") {
    return "Edit this document's text — saving writes it back into the Word file, keeping its styles and layout";
  }
  return "Switch between preview and editing";
}

function EditFileAction({
  cloudView,
  mode,
  s,
}: {
  cloudView: boolean;
  mode: ReturnType<WSActions["editModeOf"]>;
  s: WSState;
}) {
  if (cloudView || !mode) return null;
  const editing = s.editMode;
  return (
    <button
      className="btn-ic viewer-primary"
      title={editButtonTitle(mode)}
      onClick={() => s.setEditMode(!editing)}
    >
      {editing ? <EyeIcon size={14} /> : <PencilIcon size={14} />}
      {editing ? "Preview" : mode === "copy" ? "Edit as text" : "Edit"}
    </button>
  );
}

function ScriptRunAction({ s, a, fileId, name }: { s: WSState; a: WSActions; fileId: string; name: string }) {
  if (!isScriptName(name)) return null;
  const script = s.scripts.find((candidate) => candidate.fileId === fileId);
  const running = Boolean(script?.lastRun?.jobId && s.jobProgress[script.lastRun.jobId]);
  const approved = Boolean(script?.approved);
  const run = () => {
    if (s.editMode && s.editorDirtyRef.current) {
      s.pushToast("info", "Save your edits first, then run the script.");
      return;
    }
    void a.runScript(fileId);
  };
  return (
    <button
      className="btn-ic viewer-primary"
      title={approved ? "Run this script — outputs are saved into the room" : "This version has not been approved — opens the review card; nothing runs until you approve it"}
      disabled={running}
      onClick={run}
    >
      <PlayIcon size={14} /> {approved ? "Run" : "Review script"}
    </button>
  );
}

function ScriptQuickActions({ s, a, fileId, name }: { s: WSState; a: WSActions; fileId: string; name: string }) {
  const actions: QuickAction[] = s.scripts
    .filter((script) => script.fileId !== fileId && (script.inputs.includes(name) || script.outputs.includes(name)))
    .map((script) => ({
      id: script.fileId,
      label: script.name,
      icon: <PlayIcon size={14} />,
      hint: `Run ${script.name}`,
      onRun: () => void a.runScript(script.fileId),
    }));
  return <QuickActionsMenu actions={actions} open={s.qaScriptMenuOpen ?? false} onOpenChange={s.setQaScriptMenuOpen} buttonLabel="Scripts" buttonIcon={<ScriptIcon size={14} />} />;
}

function sketchFileActions(fileId: string, name: string, a: WSActions): QuickAction[] {
  if (!name.toLowerCase().endsWith(".sketch")) return [];
  return [
    { id: "sketch-png", label: "Save a picture (PNG) in this room", icon: <DownloadIcon size={14} />, onRun: () => void a.exportSketchAs(fileId, "png") },
    { id: "sketch-svg", label: "Save a drawing (SVG) in this room", icon: <DownloadIcon size={14} />, onRun: () => void a.exportSketchAs(fileId, "svg") },
  ];
}

function FileQuickActions({ s, a, fileId, kind, name }: { s: WSState; a: WSActions; fileId: string; kind: ViewerKind; name: string }) {
  const workflowActions: QuickAction[] = s.workflows
    .filter((workflow) => workflow.status === "active" && bindingMatches(workflow.binding, kind, name, fileId))
    .map((workflow) => ({
      id: workflow.id,
      label: workflow.name,
      icon: <WorkflowGlyph emoji={workflow.emoji} size={14} />,
      onRun: () => void a.runWorkflowOn(workflow.id, fileId, name),
    }));
  return <QuickActionsMenu actions={[...sketchFileActions(fileId, name, a), ...workflowActions]} open={s.qaFileMenuOpen ?? false} onOpenChange={s.setQaFileMenuOpen} buttonLabel="Actions" buttonIcon={<SparkIcon size={14} />} />;
}

function isMediaTranscript(kind: ViewerKind): boolean {
  return ["audio", "video", "recording"].includes(kind);
}

function MinutesAction({ s, a, kind, text }: { s: WSState; a: WSActions; kind: ViewerKind; text: string | null }) {
  if (!isMediaTranscript(kind) || !transcriptHasSpeech(text)) return null;
  return (
    <button className="btn-ic viewer-primary" title="Turn this recording's transcript into timeline-style HTML minutes (summary, decisions, action items)" disabled={s.asking} onClick={a.makeMinutes}>
      <SparkIcon size={14} /> Minutes
    </button>
  );
}

/** The Sketch destination with nothing selected.
 *
 * Deliberately thin, and thinner than the gallery it replaces: the room's
 * sketches are listed in the contextual sidebar now, so repeating them here
 * would be the same navigation twice — the exact duplication the two-level IA
 * exists to remove. What the centre owes a reader who has just arrived is what
 * this place is for and how to start, and nothing else. */
type HeaderProps = {
  s: WSState;
  a: WSActions;
  openFile: NonNullable<WSState["openFile"]>;
  cloudView: boolean;
  setCloudView: Dispatch<SetStateAction<boolean>>;
  mode: ReturnType<WSActions["editModeOf"]>;
  overflowOpen: boolean;
  setOverflowOpen: Dispatch<SetStateAction<boolean>>;
  cloudViewable: boolean;
  confirmDeleteVersion: string | null;
  setConfirmDeleteVersion: Dispatch<SetStateAction<string | null>>;
  enc: ReturnType<typeof useTextEncoding>;
};

function FileRenameControl({ s, a, openFile }: Pick<HeaderProps, "s" | "a" | "openFile">) {
  const renaming = s.renamingFile;
  const start = () => s.setRenamingFile({ id: openFile.id, name: openFile.content.name, where: "viewer" });
  const keyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") a.commitRenameFile();
    if (event.key === "Escape") s.setRenamingFile(null);
  };
  if (!renaming || renaming.id !== openFile.id || renaming.where !== "viewer") return <button className="pane-icon-btn" data-tip="Rename" aria-label="Rename this file" onClick={start}><PencilIcon size={14} /></button>;
  return <input className="file-rename-input" autoFocus dir="auto" aria-label="Rename this file" value={renaming.name} onChange={(event) => s.setRenamingFile({ id: openFile.id, name: event.target.value, where: "viewer" })} onBlur={a.commitRenameFile} onKeyDown={keyDown} />;
}

function versionHistorySize(versions: WSState["versions"]): string {
  const total = versions.reduce((size, version) => size + (version.bytes || 0), 0);
  return total > 0 ? ` This file's history uses ${formatSize(total)}.` : "";
}

function VersionDeleteConfirm({ a, versionId, setConfirmDeleteVersion }: { a: WSActions; versionId: string; setConfirmDeleteVersion: Dispatch<SetStateAction<string | null>> }) {
  const remove = () => {
    setConfirmDeleteVersion(null);
    void a.deleteVersion(versionId);
  };
  return <div className="tm-confirm" data-agent-blocked><span className="tm-confirm-q">Delete this saved version? It cannot be brought back.</span><div className="tm-confirm-actions"><button className="primary" onClick={remove}>Delete</button><button className="subtle" onClick={() => setConfirmDeleteVersion(null)}>Cancel</button></div></div>;
}

function VersionRestoreConfirm({ s, a, versionId }: { s: WSState; a: WSActions; versionId: string }) {
  const restore = () => {
    s.setConfirmRestore(null);
    void a.restoreVersion(versionId);
  };
  return <div className="tm-confirm" data-agent-blocked><span className="tm-confirm-q">Restore this version? Current changes will be replaced.</span><div className="tm-confirm-actions"><button className="primary" onClick={restore}>Restore</button><button className="subtle" onClick={() => s.setConfirmRestore(null)}>Cancel</button></div></div>;
}

function SavedVersionSummary({ version }: { version: WSState["versions"][number] }) {
  return <><span className="tm-cause">{version.cause}{version.pinned && <span className="tm-kept" title="Kept — this version is never dropped to make room">Kept</span>}{provenanceLine(version.provenance) && <span className="tm-prov">{provenanceLine(version.provenance)}</span>}</span><span className="tm-time">{formatWhen(version.savedAt)}{version.bytes > 0 && <span className="tm-size">{" · "}{formatSize(version.bytes)}</span>}</span></>;
}

function SavedVersionActions({ s, a, version, setConfirmDeleteVersion }: { s: WSState; a: WSActions; version: WSState["versions"][number]; setConfirmDeleteVersion: Dispatch<SetStateAction<string | null>> }) {
  const keepTitle = version.pinned ? "Stop keeping this version — it can be dropped again once there are newer ones" : "Keep this version — it is never dropped to make room for newer ones";
  return <span className="tm-actions"><button className="subtle tm-action" title="See what changed, side by side" onClick={() => void a.openCompare(version)}>Compare</button><button className="subtle tm-action" title={keepTitle} onClick={() => void a.pinVersion(version.id, !version.pinned)}>{version.pinned ? "Unkeep" : "Keep"}</button><button className="subtle tm-action" title="Restore this saved version" onClick={() => s.setConfirmRestore(version.id)}>Restore</button><button className="subtle tm-action" title="Delete this saved version and free its space" data-agent-blocked onClick={() => setConfirmDeleteVersion(version.id)}>Delete</button></span>;
}

function HistoryVersionRow({ s, a, version, confirmDeleteVersion, setConfirmDeleteVersion }: { s: WSState; a: WSActions; version: WSState["versions"][number]; confirmDeleteVersion: string | null; setConfirmDeleteVersion: Dispatch<SetStateAction<string | null>> }) {
  if (confirmDeleteVersion === version.id) return <VersionDeleteConfirm a={a} versionId={version.id} setConfirmDeleteVersion={setConfirmDeleteVersion} />;
  if (s.confirmRestore === version.id) return <VersionRestoreConfirm s={s} a={a} versionId={version.id} />;
  return <div className="tm-version"><span className="tm-version-dot" /><SavedVersionSummary version={version} /><SavedVersionActions s={s} a={a} version={version} setConfirmDeleteVersion={setConfirmDeleteVersion} /></div>;
}

function HistoryList({ s, a, confirmDeleteVersion, setConfirmDeleteVersion }: Pick<HeaderProps, "s" | "a" | "confirmDeleteVersion" | "setConfirmDeleteVersion">) {
  if (s.versions.length === 0) return <div className="history-empty">No earlier versions yet.</div>;
  return <div className="time-machine">{s.versions.map((version) => <HistoryVersionRow key={version.id} s={s} a={a} version={version} confirmDeleteVersion={confirmDeleteVersion} setConfirmDeleteVersion={setConfirmDeleteVersion} />)}<div className="tm-retention">{`Only the ${s.versionsKept} most recent versions are kept — press Keep to hold on to one.`}{versionHistorySize(s.versions)}</div></div>;
}

function HistoryCurrent({ provenance }: { provenance: WSState["headProvenance"] }) {
  const line = provenanceLine(provenance);
  if (!line) return null;
  return <div className="tm-now"><span className="tm-now-label">Now</span><span className="tm-prov">{line}</span></div>;
}

function HistoryPopover({ s, a, confirmDeleteVersion, setConfirmDeleteVersion }: Pick<HeaderProps, "s" | "a" | "confirmDeleteVersion" | "setConfirmDeleteVersion">) {
  if (!s.showHistory) return null;
  return <div className="history-pop"><HistoryCurrent provenance={s.headProvenance} /><HistoryList s={s} a={a} confirmDeleteVersion={confirmDeleteVersion} setConfirmDeleteVersion={setConfirmDeleteVersion} /></div>;
}

function CloudPreviewAction({ available, cloudView, setCloudView, setOverflowOpen }: Pick<HeaderProps, "cloudView" | "setCloudView" | "setOverflowOpen"> & { available: boolean }) {
  if (!available) return null;
  const toggle = () => {
    setCloudView(!cloudView);
    setOverflowOpen(false);
  };
  return <button role="menuitem" className="pop-item" onClick={toggle}>{cloudView ? "Close preview" : "Show me exactly what would be sent"}</button>;
}

function DuplicateAction({ mode, a, setOverflowOpen }: Pick<HeaderProps, "mode" | "a" | "setOverflowOpen">) {
  if (mode !== "editor") return null;
  const duplicate = () => {
    setOverflowOpen(false);
    void a.duplicateOpenFile();
  };
  return <button role="menuitem" className="pop-item" title="Make a second copy of this file in the room, so you can branch it" onClick={duplicate}><PlusIcon size={14} /> Duplicate</button>;
}

function CopyTextAction({ text, a, setOverflowOpen }: { text: string | null; a: WSActions; setOverflowOpen: Dispatch<SetStateAction<boolean>> }) {
  if (!text) return null;
  const copy = () => {
    setOverflowOpen(false);
    a.copyAllText();
  };
  return <button role="menuitem" className="pop-item" title="Copy the whole document's extracted text" onClick={copy}>Copy all text</button>;
}

function DictateAction({ s, a, editable }: { s: WSState; a: WSActions; editable: boolean }) {
  if (!editable) return null;
  const recording = s.dictOwner === "file" && s.dictState === "recording";
  const title = recording ? "Stop and append the words" : "Dictate into this file — your words are appended to its saved content";
  const mic = a.micState("file");
  return <button role="menuitem" className={`pop-item mic-btn ${mic.cls}`} title={title} disabled={mic.disabled} onClick={a.dictateIntoFile}><MicIcon size={12} /> Dictate</button>;
}

function EncodingPicker({ editing, picker }: { editing: boolean; picker: ReactNode }) {
  if (editing || !picker) return null;
  return <><div className="pop-menu-sep" /><div className="viewer-enc-row">{picker}</div></>;
}

function OverflowMenu(props: HeaderProps) {
  if (!props.overflowOpen) return null;
  return <><div className="menu-backdrop" onMouseDown={() => props.setOverflowOpen(false)} /><div className="pop-menu viewer-overflow-menu" role="menu" aria-label="More actions on this file"><CloudPreviewAction available={props.cloudViewable} cloudView={props.cloudView} setCloudView={props.setCloudView} setOverflowOpen={props.setOverflowOpen} /><DuplicateAction mode={props.mode} a={props.a} setOverflowOpen={props.setOverflowOpen} /><CopyTextAction text={props.openFile.content.text} a={props.a} setOverflowOpen={props.setOverflowOpen} /><DictateAction s={props.s} a={props.a} editable={props.openFile.content.editable} /><button role="menuitem" className={`pop-item ${props.s.showHistory ? "active" : ""}`} onClick={() => { props.setOverflowOpen(false); props.a.openHistory(); }}><TimeMachineIcon size={14} /> History</button><EncodingPicker editing={props.s.editMode} picker={props.enc.picker} /></div></>;
}

function overflowButtonClass(cloudView: boolean, historyOpen: boolean): string {
  return `subtle btn-ic${cloudView || historyOpen ? " cloudview-on" : ""}`;
}

function FileOverflow(props: HeaderProps) {
  return <span className="viewer-overflow-wrap"><button className={overflowButtonClass(props.cloudView, props.s.showHistory)} title="More actions" aria-label="More actions on this file" aria-haspopup="menu" aria-expanded={props.overflowOpen} onClick={() => props.setOverflowOpen((open) => !open)}><DotsIcon size={14} /></button><OverflowMenu {...props} /><HistoryPopover s={props.s} a={props.a} confirmDeleteVersion={props.confirmDeleteVersion} setConfirmDeleteVersion={props.setConfirmDeleteVersion} /></span>;
}

function FileActions(props: HeaderProps) {
  const { s, a, openFile, cloudView, mode } = props;
  return <span className="viewer-actions"><EditFileAction cloudView={cloudView} mode={mode} s={s} /><ScriptRunAction s={s} a={a} fileId={openFile.id} name={openFile.content.name} /><MinutesAction s={s} a={a} kind={openFile.content.kind} text={openFile.content.text} /><ScriptQuickActions s={s} a={a} fileId={openFile.id} name={openFile.content.name} /><FileQuickActions s={s} a={a} fileId={openFile.id} kind={openFile.content.kind} name={openFile.content.name} /><button className="btn-ic viewer-primary" title="Export a normal copy out of the room" data-agent-blocked onClick={() => a.exportOne(openFile.id, openFile.content.name)}><DownloadIcon size={14} /> Export</button><FileOverflow {...props} /><button className="pane-icon-btn" data-tip="Close" aria-label="Close this file" onClick={() => a.guardLeave("Closing this file", () => s.setOpenFile(null))}><CloseIcon size={12} /></button></span>;
}

export function FileHeader(props: HeaderProps) {
  return <div className="viewer-head"><FileRenameControl s={props.s} a={props.a} openFile={props.openFile} /><FileActions {...props} /></div>;
}


function quoteInChat(
  event: React.MouseEvent<HTMLButtonElement>,
  quote: ViewerQuote,
  file: NonNullable<WSState["openFile"]>,
  s: WSState,
  layout: LayoutApi,
  setQuote: Dispatch<SetStateAction<ViewerQuote | null>>,
): void {
  event.preventDefault();
  s.setQuestion(withQuote(s.question, quote.text, file.content.name));
  setQuote(null);
  window.getSelection()?.removeAllRanges();
  layout.showPane("ai");
}

export function QuoteAction({ quote, file, s, layout, setQuote }: {
  quote: ViewerQuote | null;
  file: WSState["openFile"];
  s: WSState;
  layout: LayoutApi;
  setQuote: Dispatch<SetStateAction<ViewerQuote | null>>;
}) {
  if (!quote || !file) return null;
  return (
    <button className="quote-selection-btn" style={{ top: quote.top, left: quote.left }} onMouseDown={(event) => quoteInChat(event, quote, file, s, layout, setQuote)}>
      Quote in chat
    </button>
  );
}
