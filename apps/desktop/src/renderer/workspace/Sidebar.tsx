import { useEffect } from "react";
import {
  CloseIcon,
  CollapseLeftIcon,
  DownloadIcon,
  FolderIcon,
  LinkIcon,
  MicIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  UndoIcon,
} from "../icons";
import { displayName } from "./composer";
import { isRecordingFile } from "../api";
import TrashPanel from "./TrashPanel";
import { WSState } from "./state";
import { WSActions } from "./actions";
import { WorkArea, isSketchFile } from "./types";
import {
  SIDEBAR_TITLES,
  newItemLabel,
  newItemOf,
  type NewItemKind,
} from "./destinations";
import { libraryFiles } from "./fileVisibility";
import { type BrowserPagesApi } from "./browserPages";
import { LayoutApi } from "../shell/useLayout";
import { visibleWorkflows } from "./workflows/selectors";
import {
  FILE_SORTS,
  FILE_SORT_LABELS,
  sortFiles,
  type FileSort,
} from "./fileSort";
import { BrowsePanel, SelectionBar, SourcesPanel } from "./SidebarFiles";
import { PagesNav, RecordingsNav, ScriptsNav, SketchesNav, SkillsNav, WorkflowsNav } from "./SidebarDestinations";
import { ConnectorsNav, CreationsNav, MapNav, MemoryNav } from "./SidebarMoreDestinations";
import { SkinControls } from "../skin/SkinControls";

/** THE CONTEXTUAL SIDEBAR — the second column, whose title, contents, primary
 * action, selection and empty state all come from the ACTIVE DESTINATION.
 *
 * It used to be the Library with a few exceptions bolted on: three
 * destinations rendered an empty column still headed "Library", the browser
 * rendered a paragraph explaining that its pages lived somewhere else, and the
 * room map rendered the whole file list because it happens to draw files. The
 * headings map below is now total over `WorkArea` and lives in
 * workspace/destinations.ts, so a destination added to the union cannot
 * silently inherit Home's column.
 *
 * In Home it is still exactly what it was: browsing (the real folder tree with
 * every row action) plus the AI evidence set plus the trash. */
type LibraryPaneProps = {
  s: WSState;
  a: WSActions;
  layout: LayoutApi;
  area: WorkArea;
  pages: BrowserPagesApi;
  onNewItem: (kind: NewItemKind) => void;
};

type LibraryFileData = {
  filterQ: string;
  looseFiles: import("../api").FileMeta[];
  shownFiles: import("../api").FileMeta[];
  attachedIds: Set<string>;
};

const FILE_AREAS = new Set<WorkArea>(["files", "home"]);

function isFileArea(area: WorkArea) {
  return FILE_AREAS.has(area);
}

function fileMatchesFilter(file: import("../api").FileMeta, filterQuery: string) {
  if (!filterQuery) return true;
  return file.name.toLowerCase().includes(filterQuery) || displayName(file.name).toLowerCase().includes(filterQuery);
}

function useLibraryFileData(s: WSState): LibraryFileData {
  const filterQ = s.fileFilter.trim().toLowerCase();
  const shownFiles = sortFiles(libraryFiles(s.files).filter((file) => fileMatchesFilter(file, filterQ)), s.fileSort);
  return {
    filterQ,
    shownFiles,
    looseFiles: shownFiles.filter((file) => file.folderId === null),
    attachedIds: new Set(s.attachments.map((file) => file.id)),
  };
}

function useAddMenuDismissal(s: WSState) {
  useEffect(() => {
    if (!s.addMenuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      s.setAddMenuOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [s.addMenuOpen, s]);
}

function usePrunedTrashSelection(s: WSState) {
  const trashed = s.trashed;
  const setSelectedTrashIds = s.setSelectedTrashIds;
  useEffect(() => {
    setSelectedTrashIds((current) => {
      if (current.size === 0) return current;
      const liveIds = new Set(trashed.map((file) => file.id));
      const kept = new Set([...current].filter((id) => liveIds.has(id)));
      return kept.size === current.size ? current : kept;
    });
  }, [trashed, setSelectedTrashIds]);
}

const HEADER_COUNT: Partial<Record<WorkArea, (s: WSState, pages: BrowserPagesApi) => number>> = {
  workflows: (s) => visibleWorkflows(s.workflows).length,
  scripts: (s) => s.scripts.length,
  skills: (s) => s.skills.length,
  recordings: (s) => s.files.filter(isRecordingFile).length,
  memory: (s) => s.memories.length,
  connectors: (s) => s.mcpStatuses.length,
  sketch: (s) => s.files.filter(isSketchFile).length,
  browser: (_s, pages) => pages.pages.length,
};

function libraryHeaderCount(s: WSState, area: WorkArea, pages: BrowserPagesApi) {
  if (isFileArea(area)) return libraryFiles(s.files).length;
  return HEADER_COUNT[area]?.(s, pages) ?? null;
}

function HeaderCount({ count }: { count: number | null }) {
  if (count === null) return null;
  return <span className="count-badge">{count}</span>;
}

function HeaderNewItem({ kind, label, onNewItem }: { kind: NewItemKind | null; label: string | null; onNewItem: (kind: NewItemKind) => void }) {
  if (!kind || kind === "note" || !label) return null;
  return (
    <button
      className="pane-new-btn"
      type="button"
      title={`${label} (⌘T)`}
      aria-label={`${label} (Command T)`}
      onClick={() => onNewItem(kind)}
    >
      <PlusIcon size={12} /> {label}
    </button>
  );
}

function LibraryHeader({ heading, count, kind, label, layout, onNewItem }: { heading: string; count: number | null; kind: NewItemKind | null; label: string | null; layout: LayoutApi; onNewItem: (kind: NewItemKind) => void }) {
  return (
    <div className="pane-header">
      <div className="pane-heading">{heading}</div>
      <HeaderCount count={count} />
      <HeaderNewItem kind={kind} label={label} onNewItem={onNewItem} />
      <div className="pane-actions">
        <button className="pane-icon-btn" data-tip="Collapse" aria-label={`Collapse ${heading}`} onClick={() => layout.collapsePane("library")}>
          <CollapseLeftIcon size={14} />
        </button>
      </div>
    </div>
  );
}

function OptionalBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return <span className="count-badge">{count}</span>;
}

function LibraryTabs({ s }: { s: WSState }) {
  return (
    <div className="pane-tabs" role="tablist" aria-label="Library content">
      <button className="pane-tab" role="tab" aria-selected={s.libraryTab === "browse"} onClick={() => s.setLibraryTab("browse")}>Browse</button>
      <button className="pane-tab" role="tab" aria-selected={s.libraryTab === "sources"} onClick={() => s.setLibraryTab("sources")} title="Choose which files the AI answers from">
        AI sources <OptionalBadge count={s.attachments.length} />
      </button>
      <button className="pane-tab" role="tab" aria-selected={s.libraryTab === "trash"} onClick={() => s.setLibraryTab("trash")} title="Files deleted from this room — restorable until deleted for good">
        Trash <OptionalBadge count={s.trashed.length} />
      </button>
    </div>
  );
}

function usesLibraryTools(area: WorkArea, tab: WSState["libraryTab"]) {
  return (isFileArea(area) && tab !== "trash") || area === "recordings" || area === "sketch";
}

function filterInputLabel(area: WorkArea) {
  const labels: Partial<Record<WorkArea, string>> = {
    recordings: "Filter recordings",
    sketch: "Filter sketches",
  };
  return labels[area] ?? "Filter files and pages";
}

function ClearFilter({ value, onClear }: { value: string; onClear: () => void }) {
  if (!value) return null;
  return (
    <button className="side-search-clear" title="Clear the filter" aria-label="Clear the filter" onClick={onClear}>
      <CloseIcon size={12} />
    </button>
  );
}

function LibraryTools({ s, area }: { s: WSState; area: WorkArea }) {
  if (!usesLibraryTools(area, s.libraryTab)) return null;
  const label = filterInputLabel(area);
  return (
    <div className="source-tools">
      <label className="search-field">
        <SearchIcon size={14} />
        <input type="search" placeholder={label} aria-label={label} value={s.fileFilter} onChange={(event) => s.setFileFilter(event.target.value)} />
        <ClearFilter value={s.fileFilter} onClear={() => s.setFileFilter("")} />
      </label>
      <div className="file-sort">
        <select aria-label="Sort files" title="Choose how this list is ordered" value={s.fileSort} onChange={(event) => s.setFileSort(event.target.value as FileSort)}>
          {FILE_SORTS.map((sort) => <option key={sort} value={sort}>{FILE_SORT_LABELS[sort]}</option>)}
        </select>
      </div>
    </div>
  );
}

function FileAreaContent({ s, a, data }: { s: WSState; a: WSActions; data: LibraryFileData }) {
  const panels = {
    browse: <><SelectionBar s={s} a={a} /><BrowsePanel s={s} a={a} shownFiles={data.shownFiles} looseFiles={data.looseFiles} filterQ={data.filterQ} /></>,
    sources: <SourcesPanel s={s} a={a} shownFiles={data.shownFiles} attachedIds={data.attachedIds} />,
    trash: <TrashPanel s={s} a={a} />,
  };
  return panels[s.libraryTab];
}

function AreaContent({ s, a, area, pages, onNewItem, data }: LibraryPaneProps & { data: LibraryFileData }) {
  const content = {
    files: <FileAreaContent s={s} a={a} data={data} />,
    home: <FileAreaContent s={s} a={a} data={data} />,
    recordings: <RecordingsNav s={s} a={a} />,
    workflows: <WorkflowsNav s={s} a={a} />,
    scripts: <ScriptsNav s={s} a={a} />,
    skills: <SkillsNav s={s} a={a} />,
    memory: <MemoryNav s={s} a={a} />,
    connectors: <ConnectorsNav s={s} />,
    browser: <PagesNav pages={pages} onNewItem={onNewItem} />,
    sketch: <SketchesNav s={s} a={a} onNewItem={onNewItem} />,
    create: <CreationsNav s={s} a={a} />,
    map: <MapNav s={s} a={a} />,
    skin: <SkinControls />,
  };
  return content[area];
}

function restoreSelectedTitle(count: number) {
  if (count === 0) return "Select one or more deleted files to restore them";
  return `Put ${count} file${count === 1 ? "" : "s"} back in the library`;
}

function TrashFooter({ s, a }: { s: WSState; a: WSActions }) {
  const restore = () => {
    const ids = Array.from(s.selectedTrashIds);
    s.setSelectedTrashIds(new Set());
    void a.restoreFiles(ids);
  };
  return (
    <div className="source-footer">
      <button className="add-source-button" disabled={s.selectedTrashIds.size === 0} title={restoreSelectedTitle(s.selectedTrashIds.size)} onClick={restore}>
        <UndoIcon size={14} /> Restore selected
      </button>
    </div>
  );
}

function WebLinkDescription({ webOn }: { webOn: boolean }) {
  return <span className="pop-item-sub">{webOn ? "Import a page or a YouTube transcript/video" : "Unavailable while the room is offline"}</span>;
}

function AddMenu({ s, a }: { s: WSState; a: WSActions }) {
  const close = () => s.setAddMenuOpen(false);
  return (
    <div className="pop-menu add-menu" role="menu">
      <button className="pop-item" role="menuitem" onClick={() => { a.importFiles(); close(); }}>
        <DownloadIcon size={14} /><span className="pop-item-body">Upload files<span className="pop-item-sub">Saved as normal files. Private Arcelle data stays encrypted.</span></span>
      </button>
      <button className="pop-item" role="menuitem" onClick={() => { close(); void a.createNewNote(); }}>
        <PencilIcon size={14} /><span className="pop-item-body">New page<span className="pop-item-sub">A blank Markdown note, opened ready to edit</span></span>
      </button>
      <button className="pop-item" role="menuitem" onClick={() => { a.startCreateFolder(); close(); }}><FolderIcon size={14} /> New folder</button>
      <button className="pop-item" role="menuitem" disabled={!s.webOn} title={s.webOn ? undefined : "This room is offline — turn on Settings → Online features"} onClick={() => { s.setLinkUrl(""); s.setShowAddLink(true); close(); }}>
        <LinkIcon size={14} /><span className="pop-item-body">Web link<WebLinkDescription webOn={s.webOn} /></span>
      </button>
      <button className="pop-item" role="menuitem" disabled={s.recLive != null} title="Record mic + the Mac's audio with a live transcript — works with Meet, Zoom, Teams" onClick={() => { void a.startLiveRecording(); close(); }}>
        <MicIcon size={14} /><span className="pop-item-body">Live recording<span className="pop-item-sub">Mic + Mac audio, transcribed as it happens</span></span>
      </button>
      <button className="pop-item" role="menuitem" disabled={a.micState("note").disabled} onClick={() => { a.recordVoiceNote(); close(); }}>
        <MicIcon size={14} /><span className="pop-item-body">Voice note<span className="pop-item-sub">Starts the mic — saves the audio in this room</span></span>
      </button>
      <button className="pop-item" role="menuitem" disabled={a.micState("journal").disabled} onClick={() => { a.dictateJournal(); close(); }}>
        <MicIcon size={14} /><span className="pop-item-body">Speak a journal entry<span className="pop-item-sub">Starts the mic — transcribed on this Mac into today's journal</span></span>
      </button>
    </div>
  );
}

function AddMenuOverlay({ s, a }: { s: WSState; a: WSActions }) {
  if (!s.addMenuOpen) return null;
  return <><div className="menu-backdrop" onMouseDown={() => s.setAddMenuOpen(false)} /><AddMenu s={s} a={a} /></>;
}

function AddSourceFooter({ s, a }: { s: WSState; a: WSActions }) {
  return (
    <div className="source-footer">
      <div className="add-menu-wrap" style={{ width: "100%" }}>
        <button className="add-source-button" title="Add something to this room" onClick={() => s.setAddMenuOpen((open) => !open)}>
          <PlusIcon size={14} /> Add page or source
        </button>
        <AddMenuOverlay s={s} a={a} />
      </div>
    </div>
  );
}

function LibraryFooter({ s, a, area }: { s: WSState; a: WSActions; area: WorkArea }) {
  if (!isFileArea(area)) return null;
  const Footer = s.libraryTab === "trash" ? TrashFooter : AddSourceFooter;
  return <Footer s={s} a={a} />;
}

export default function LibraryPane(props: LibraryPaneProps) {
  const { s, a, layout, area, pages, onNewItem } = props;
  const data = useLibraryFileData(s);
  useAddMenuDismissal(s);
  usePrunedTrashSelection(s);
  const heading = SIDEBAR_TITLES[area];
  if (heading === null) return null;
  const fileArea = isFileArea(area);
  return (
    <>
      <LibraryHeader heading={heading} count={libraryHeaderCount(s, area, pages)} kind={newItemOf(area)} label={newItemLabel(area)} layout={layout} onNewItem={onNewItem} />
      {fileArea && <LibraryTabs s={s} />}
      <LibraryTools s={s} area={area} />
      <AreaContent {...props} data={data} />
      <LibraryFooter s={s} a={a} area={area} />
    </>
  );
}

/* ---------- The multi-selection's own strip ---------- */

/** What is picked, and the things you can do to all of it at once.
 *
 * Only drawn when something IS selected. A permanently-visible bar of disabled
 * verbs teaches nothing and costs a row of the list forever; appearing at the
 * moment it becomes true is also what tells a reader the selection exists.
 *
 * The count is the heading, not a suffix, because it is the one fact that makes
 * every button below it safe to press — "Remove" beside "7 selected" asks a
 * different question than "Remove" on its own. Deletion keeps the SAME armed
 * confirm the single-file path uses (`DeleteControl`), so a multi-file removal
 * is never easier to trigger than a single one. */
