import { useEffect } from "react";
import {
  CloseIcon,
  CollapseLeftIcon,
  DownloadIcon,
  FocusIcon,
  FolderIcon,
  LinkIcon,
  MemoryIcon,
  MicIcon,
  PaperclipIcon,
  PencilIcon,
  PlusIcon,
  ScriptIcon,
  BookOpenIcon,
  SearchIcon,
  TrashIcon,
  UndoIcon,
  WorkflowsIcon,
} from "../icons";
import { displayName, fileLabel } from "./composer";
import { isRecordingFile, fileKindLabel } from "../api";
import DeleteControl from "./DeleteControl";
import FileRow from "./FileRow";
import TrashPanel from "./TrashPanel";
import { WSState } from "./state";
import { WSActions } from "./actions";
import { WorkArea } from "./types";
import { LayoutApi } from "../shell/useLayout";
import { visibleWorkflows } from "./workflows/selectors";
import {
  FILE_SORTS,
  FILE_SORT_LABELS,
  sortFiles,
  type FileSort,
} from "./fileSort";

const AREA_HEADINGS: Record<WorkArea, string> = {
  files: "Library",
  home: "Library",
  map: "Library",
  recordings: "Recordings",
  workflows: "Workflows",
  scripts: "Scripts",
  skills: "Skills",
  memory: "Memory",
  connectors: "Connectors",
  // The library stays the heading here: a generation lands as an ordinary
  // room file, so the pane beside Create is showing files, not "Create".
  create: "Library",
  sketch: "Library",
  browser: "Private browser",
};

/** The left pane. In the file-centric areas it unifies browsing (the real
 * folder tree with every existing row action) with the AI evidence set
 * (checkboxes = files attached to the next answer). In the Workflows /
 * Scripts / Recordings / Memory areas it becomes that area's navigator. */
export default function LibraryPane({
  s,
  a,
  layout,
  area,
}: {
  s: WSState;
  a: WSActions;
  layout: LayoutApi;
  area: WorkArea;
}) {
  const filterQ = s.fileFilter.trim().toLowerCase();
  const matchesFilter = (f: import("../api").FileMeta) =>
    !filterQ ||
    f.name.toLowerCase().includes(filterQ) ||
    displayName(f.name).toLowerCase().includes(filterQ);
  // One sorted list feeds every file surface below (the folder tree, the
  // evidence checkboxes, the recordings list), so they can never disagree
  // about the order the reader chose.
  const shownFiles = sortFiles(s.files.filter(matchesFilter), s.fileSort);
  const looseFiles = shownFiles.filter((f) => f.folderId === null);
  const attachedIds = new Set(s.attachments.map((f) => f.id));
  const fileArea = area === "files" || area === "home" || area === "map";

  // Same dismissal grammar as the header popovers: Escape closes the Add menu.
  useEffect(() => {
    if (!s.addMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      s.setAddMenuOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [s.addMenuOpen, s]);

  // null = this area has no list to count, so no badge is drawn. A hard "0"
  // beside an area that never lists anything (the browser) reads as "empty",
  // which is a different and untrue claim.
  const headerCount: number | null = fileArea
    ? s.files.length
    : area === "workflows"
      ? visibleWorkflows(s.workflows).length
      : area === "scripts"
        ? s.scripts.length
        : area === "skills"
          ? s.skills.length
        : area === "recordings"
          ? s.files.filter(isRecordingFile).length
          : area === "memory"
            ? s.memories.length
            : area === "connectors"
              ? s.mcpStatuses.length
              : null;

  return (
    <>
      <div className="pane-header">
        <div className="pane-heading">{AREA_HEADINGS[area]}</div>
        {headerCount !== null && (
          <span className="count-badge">{headerCount}</span>
        )}
        <div className="pane-actions">
          <button
            className="pane-icon-btn"
            data-tip="Focus this pane"
            aria-label="Give the Library pane the full width"
            onClick={() => layout.toggleFocus("library")}
          >
            <FocusIcon size={14} />
          </button>
          <button
            className="pane-icon-btn"
            data-tip="Collapse"
            aria-label="Collapse the Library pane"
            onClick={() => layout.collapsePane("library")}
          >
            <CollapseLeftIcon size={14} />
          </button>
        </div>
      </div>

      {fileArea && (
        <div className="pane-tabs" role="tablist" aria-label="Library content">
          <button
            className="pane-tab"
            role="tab"
            aria-selected={s.libraryTab === "browse"}
            onClick={() => s.setLibraryTab("browse")}
          >
            Browse
          </button>
          <button
            className="pane-tab"
            role="tab"
            aria-selected={s.libraryTab === "sources"}
            onClick={() => s.setLibraryTab("sources")}
            title="Choose which files the AI answers from"
          >
            AI sources
            {s.attachments.length > 0 && (
              <span className="count-badge">{s.attachments.length}</span>
            )}
          </button>
          {/* Trash: a peer of Browse, not a buried menu item. The count is the
              only place an AI-initiated deletion announces itself, so it is
              drawn whenever there IS one — and never as a hard 0, which would
              read as a claim about a list nobody is showing. */}
          <button
            className="pane-tab"
            role="tab"
            aria-selected={s.libraryTab === "trash"}
            onClick={() => s.setLibraryTab("trash")}
            title="Files deleted from this room — restorable until deleted for good"
          >
            Trash
            {s.trashed.length > 0 && (
              <span className="count-badge">{s.trashed.length}</span>
            )}
          </button>
        </div>
      )}

      {/* ADD-31: live import queue — a multi-file import used to be invisible
          until it was over. Names the current file and counts progress. */}
      {s.importProgress && (
        <div className="import-strip" role="status">
          <span className="import-strip-count">
            Importing {s.importProgress.done + 1} of {s.importProgress.total}
          </span>
          <span className="import-strip-name">{s.importProgress.name}</span>
        </div>
      )}

      {/* Trash is a record of what left the room, not a list you browse — a
          filter box and a "Newest first" sort control that don't move the
          trash at all (it composes its own, unrelated order) don't belong
          here. Suppressed for that tab only; Browse/AI sources keep both. */}
      {((fileArea && s.libraryTab !== "trash") || area === "recordings") && (
        <div className="source-tools">
          <label className="search-field">
            <SearchIcon size={13} />
            <input
              type="search"
              placeholder={
                area === "recordings" ? "Filter recordings" : "Filter files and pages"
              }
              aria-label="Filter files and pages"
              value={s.fileFilter}
              onChange={(e) => s.setFileFilter(e.target.value)}
            />
            {s.fileFilter && (
              <button
                className="side-search-clear"
                title="Clear the filter"
                aria-label="Clear the filter"
                onClick={() => s.setFileFilter("")}
              >
                <CloseIcon size={11} />
              </button>
            )}
          </label>
          {/* Files were newest-first and nothing else: in a room of a few
              hundred, the one thing a person knows about a document — its
              name — was the one order they could not ask for. */}
          <div className="file-sort">
            <select
              aria-label="Sort files"
              title="Choose how this list is ordered"
              value={s.fileSort}
              onChange={(e) => s.setFileSort(e.target.value as FileSort)}
            >
              {FILE_SORTS.map((k) => (
                <option key={k} value={k}>
                  {FILE_SORT_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {fileArea && s.libraryTab === "browse" && (
        <>
          <SelectionBar s={s} a={a} />
          <BrowsePanel
            s={s}
            a={a}
            shownFiles={shownFiles}
            looseFiles={looseFiles}
            filterQ={filterQ}
          />
        </>
      )}
      {fileArea && s.libraryTab === "sources" && (
        <SourcesPanel s={s} a={a} shownFiles={shownFiles} attachedIds={attachedIds} />
      )}
      {fileArea && s.libraryTab === "trash" && <TrashPanel s={s} a={a} />}
      {area === "recordings" && <RecordingsNav s={s} a={a} shownFiles={shownFiles} />}
      {area === "workflows" && <WorkflowsNav s={s} a={a} />}
      {area === "scripts" && <ScriptsNav s={s} a={a} />}
      {area === "skills" && <SkillsNav s={s} a={a} />}
      {area === "memory" && <MemoryNav s={s} a={a} />}
      {area === "connectors" && <ConnectorsNav s={s} />}
      {area === "browser" && <BrowserNav />}

      {/* Trash has nothing to add — you cannot add a source to what has been
          removed — so its footer does the one bulk action the tab actually
          needs instead of duplicating "+ Add page or source" from Browse. */}
      {fileArea && s.libraryTab === "trash" ? (
        <div className="source-footer">
          <button
            className="add-source-button"
            disabled={s.selectedTrashIds.size === 0}
            title={
              s.selectedTrashIds.size > 0
                ? `Put ${s.selectedTrashIds.size} file${s.selectedTrashIds.size === 1 ? "" : "s"} back in the library`
                : "Select one or more deleted files to restore them"
            }
            onClick={() => {
              const ids = Array.from(s.selectedTrashIds);
              s.setSelectedTrashIds(new Set());
              void a.restoreFiles(ids);
            }}
          >
            <UndoIcon size={14} /> Restore selected
          </button>
        </div>
      ) : (fileArea || area === "recordings") && (
        <div className="source-footer">
          <div className="add-menu-wrap" style={{ width: "100%" }}>
            <button
              className="add-source-button"
              title="Add something to this room"
              onClick={() => s.setAddMenuOpen((o) => !o)}
            >
              <PlusIcon size={14} /> Add page or source
            </button>
            {s.addMenuOpen && (
              <>
                <div
                  className="menu-backdrop"
                  onMouseDown={() => s.setAddMenuOpen(false)}
                />
                <div className="pop-menu add-menu" role="menu">
                  <button
                    className="pop-item"
                    role="menuitem"
                    onClick={() => {
                      a.importFiles();
                      s.setAddMenuOpen(false);
                    }}
                  >
                    <DownloadIcon size={14} />
                    <span className="pop-item-body">
                      Upload files
                      <span className="pop-item-sub">
                        PDF, DOCX, images, audio, CSV, Markdown — stored encrypted
                      </span>
                    </span>
                  </button>
                  <button
                    className="pop-item"
                    role="menuitem"
                    onClick={() => {
                      s.setAddMenuOpen(false);
                      void a.createNewNote();
                    }}
                  >
                    <PencilIcon size={14} />
                    <span className="pop-item-body">
                      New page
                      <span className="pop-item-sub">
                        A blank Markdown note, opened ready to edit
                      </span>
                    </span>
                  </button>
                  <button
                    className="pop-item"
                    role="menuitem"
                    onClick={() => {
                      a.startCreateFolder();
                      s.setAddMenuOpen(false);
                    }}
                  >
                    <FolderIcon size={14} /> New folder
                  </button>
                  {/* The one entry in this menu that reaches the internet. The
                    * command refuses when the room's switch is off; saying so
                    * here means the room does not look online until you click. */}
                  <button
                    className="pop-item"
                    role="menuitem"
                    disabled={!s.webOn}
                    title={
                      s.webOn
                        ? undefined
                        : "This room is offline — turn on Settings → Online features"
                    }
                    onClick={() => {
                      s.setLinkUrl("");
                      s.setShowAddLink(true);
                      s.setAddMenuOpen(false);
                    }}
                  >
                    <LinkIcon size={14} />
                    <span className="pop-item-body">
                      Web link
                      <span className="pop-item-sub">
                        {s.webOn
                          ? "Import a page or a YouTube transcript/video"
                          : "Unavailable while the room is offline"}
                      </span>
                    </span>
                  </button>
                  {/* ADD-27: a Recording file — live transcript while you
                   * (or your meeting) speak. The three mic entries each say
                   * what pressing them captures and saves — starting the
                   * microphone must never be a surprise. */}
                  <button
                    className="pop-item"
                    role="menuitem"
                    disabled={s.recLive != null}
                    title="Record mic + the Mac's audio with a live transcript — works with Meet, Zoom, Teams"
                    onClick={() => {
                      void a.startLiveRecording();
                      s.setAddMenuOpen(false);
                    }}
                  >
                    <MicIcon size={14} />
                    <span className="pop-item-body">
                      Live recording
                      <span className="pop-item-sub">
                        Mic + Mac audio, transcribed as it happens
                      </span>
                    </span>
                  </button>
                  <button
                    className="pop-item"
                    role="menuitem"
                    disabled={a.micState("note").disabled}
                    onClick={() => {
                      a.recordVoiceNote();
                      s.setAddMenuOpen(false);
                    }}
                  >
                    <MicIcon size={14} />
                    <span className="pop-item-body">
                      Voice note
                      <span className="pop-item-sub">
                        Starts the mic — saves the audio in this room
                      </span>
                    </span>
                  </button>
                  <button
                    className="pop-item"
                    role="menuitem"
                    disabled={a.micState("journal").disabled}
                    onClick={() => {
                      a.dictateJournal();
                      s.setAddMenuOpen(false);
                    }}
                  >
                    <MicIcon size={14} />
                    <span className="pop-item-body">
                      Speak a journal entry
                      <span className="pop-item-sub">
                        Starts the mic — transcribed on this Mac into today's
                        journal
                      </span>
                    </span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
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
function SelectionBar({ s, a }: { s: WSState; a: WSActions }) {
  const picked = a.selectedFiles();
  const n = picked.length;

  // Escape clears, ⌘A selects everything on screen. Both are capture-phase and
  // both bail when a text field has focus — ⌘A inside the filter box has to
  // keep meaning "select all this text".
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing =
        el?.tagName === "INPUT" ||
        el?.tagName === "TEXTAREA" ||
        el?.isContentEditable;
      if (typing) return;
      if (e.key === "Escape" && n > 0) {
        e.stopPropagation();
        a.clearSelection();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        a.selectAllVisible();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [a, n]);

  if (n === 0) return null;
  const ids = picked.map((f) => f.id);
  return (
    <div className="selection-bar" role="toolbar" aria-label={`${n} files selected`}>
      <span className="selection-count" role="status">
        {n} selected
      </span>
      <div className="selection-actions">
        <button
          className="chip-btn"
          title="Move all of these into a folder"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            s.setCtxMenu(null);
            s.setMoveMenuFor({ ids, x: r.left, y: r.bottom + 4 });
          }}
        >
          <FolderIcon size={13} /> Move
        </button>
        <button
          className="chip-btn"
          title="Pin all of these into your next question"
          onClick={() => a.attachFiles(picked)}
        >
          <PaperclipIcon size={13} /> Attach
        </button>
        <button
          className="chip-btn"
          title="Export copies of all of these out of the room"
          onClick={() => void a.exportFiles(picked)}
        >
          <DownloadIcon size={13} /> Export
        </button>
        {/* Same armed confirm as one file's Remove — a set of files must never
            be easier to delete than one of them. The question names the count,
            because "Move to the trash?" over seven files is a different act. */}
        <DeleteControl
          k="selection-remove"
          trigger={<TrashIcon size={13} />}
          question={`Move ${n} file${n === 1 ? "" : "s"} to the trash?`}
          title={`Move ${n} file${n === 1 ? "" : "s"} to the trash`}
          onConfirm={() => void a.removeFiles(ids)}
          confirmDelete={s.confirmDelete}
          askConfirm={a.askConfirm}
          cancelConfirm={a.cancelConfirm}
        />
        <button
          className="chip-btn"
          title="Clear the selection"
          aria-label="Clear the selection"
          onClick={a.clearSelection}
        >
          <CloseIcon size={12} />
        </button>
      </div>
    </div>
  );
}

/* ---------- Browse: the real folder tree ---------- */

/** The ids a library drag is carrying.
 *
 * `FileRow` writes one id per line, because dragging a row that is part of the
 * multi-selection drags the whole selection. Splitting here (rather than at
 * each drop site) keeps the two ends of the drag describing the same thing —
 * a single-id drag is just the one-line case, so nothing needed a special path. */
function dragIds(e: React.DragEvent): string[] {
  return e.dataTransfer
    .getData("text/plain")
    .split("\n")
    .map((id) => id.trim())
    .filter(Boolean);
}

function BrowsePanel({
  s,
  a,
  shownFiles,
  looseFiles,
  filterQ,
}: {
  s: WSState;
  a: WSActions;
  shownFiles: import("../api").FileMeta[];
  looseFiles: import("../api").FileMeta[];
  filterQ: string;
}) {
  // THE ORDER THE ROWS ARE PAINTED IN — loose files, then each folder's
  // contents in the order the folders are drawn. Published to state because a
  // shift-range and ⌘A must agree with what is on the screen: computed against
  // `s.files` instead, a range would silently include rows the filter has
  // hidden or the sort has moved elsewhere.
  //
  // Collapsed folders are deliberately EXCLUDED: a range must never sweep in
  // files nobody can see, and "select all" over a collapsed folder would arm a
  // destructive action against rows with no way to review them first.
  const paintedOrder = [
    ...looseFiles.map((f) => f.id),
    ...s.folders.flatMap((folder) =>
      s.collapsedFolders.has(folder.id)
        ? []
        : shownFiles.filter((f) => f.folderId === folder.id).map((f) => f.id),
    ),
  ];
  const orderKey = paintedOrder.join(" ");
  useEffect(() => {
    s.setVisibleFileOrder(paintedOrder);
    // Keyed on the joined order, not the array: a fresh array with identical
    // contents is produced on every render, and setting state from that would
    // loop forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKey]);

  // A selection that outlives the rows it names is a trap — the counts stay
  // right while the actions quietly hit nothing. Prune to what is on screen
  // whenever the visible set changes (a filter typed, a file trashed, a folder
  // collapsed).
  useEffect(() => {
    const visible = new Set(paintedOrder);
    s.setSelectedFileIds((cur) => {
      const kept = [...cur].filter((id) => visible.has(id));
      return kept.length === cur.size ? cur : new Set(kept);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKey]);

  return (
    <div
      className={`library-scroll file-list${s.dragOverFolder === "__root__" ? " drag-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (s.dragOverFolder !== "__root__") s.setDragOverFolder("__root__");
      }}
      onDragLeave={() => s.setDragOverFolder(null)}
      onDrop={(e) => {
        e.preventDefault();
        const ids = dragIds(e);
        s.setDragOverFolder(null);
        if (ids.length) void a.moveFiles(ids, null);
      }}
    >
      {s.creatingFolder !== null && (
        <input
          className="folder-create-input"
          autoFocus
          dir="auto"
          placeholder="New folder name"
          value={s.creatingFolder}
          onChange={(e) => s.setCreatingFolder(e.target.value)}
          onBlur={a.commitCreateFolder}
          onKeyDown={(e) => {
            if (e.key === "Enter") a.commitCreateFolder();
            if (e.key === "Escape") s.setCreatingFolder(null);
          }}
        />
      )}
      {s.files.length === 0 && (
        <div className="empty-hint">
          Add PDFs, notes, images, code or spreadsheets — they are stored
          encrypted inside this room.
        </div>
      )}
      {s.files.length > 0 && shownFiles.length === 0 && (
        <div className="empty-hint">No files match “{s.fileFilter}”.</div>
      )}
      {looseFiles.map((f) => (
        <FileRow key={f.id} f={f} s={s} a={a} />
      ))}
      {s.folders.map((folder) => {
        const inFolder = shownFiles.filter((f) => f.folderId === folder.id);
        if (filterQ && inFolder.length === 0) return null;
        const collapsed = s.collapsedFolders.has(folder.id);
        return (
          <div key={folder.id} className="folder-group">
            <div
              className={`folder-head${s.dragOverFolder === folder.id ? " drag-over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (s.dragOverFolder !== folder.id) s.setDragOverFolder(folder.id);
              }}
              onDragLeave={() => s.setDragOverFolder(null)}
              onDrop={(e) => {
                e.preventDefault();
                const ids = dragIds(e);
                s.setDragOverFolder(null);
                if (ids.length) void a.moveFiles(ids, folder.id);
              }}
            >
              <button
                className="folder-caret-btn"
                title={collapsed ? "Expand" : "Collapse"}
                onClick={() => a.toggleFolderCollapse(folder.id)}
              >
                {collapsed ? "▸" : "▾"}
              </button>
              {s.renamingFolder?.id === folder.id ? (
                <input
                  className="folder-rename"
                  autoFocus
                  dir="auto"
                  value={s.renamingFolder.name}
                  onChange={(e) =>
                    s.setRenamingFolder({ id: folder.id, name: e.target.value })
                  }
                  onBlur={a.commitFolderRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") a.commitFolderRename();
                    if (e.key === "Escape") s.setRenamingFolder(null);
                  }}
                />
              ) : (
                <button
                  className="folder-label"
                  onClick={() => a.toggleFolderCollapse(folder.id)}
                >
                  <span className="folder-name" title={folder.name}>
                    {folder.name}
                  </span>
                  <span className="count">{inFolder.length}</span>
                </button>
              )}
              <span className="folder-actions">
                <button
                  className="chip-btn"
                  title="Rename folder"
                  aria-label="Rename folder"
                  onClick={() =>
                    s.setRenamingFolder({ id: folder.id, name: folder.name })
                  }
                >
                  <PencilIcon size={13} />
                </button>
                <DeleteControl
                  k={`folder:${folder.id}`}
                  trigger={<TrashIcon size={14} />}
                  onConfirm={() => a.deleteFolder(folder.id)}
                  title="Delete folder (its files are kept, just ungrouped)"
                  confirmDelete={s.confirmDelete}
                  askConfirm={a.askConfirm}
                  cancelConfirm={a.cancelConfirm}
                />
              </span>
            </div>
            {!collapsed && (
              <div className="folder-files">
                {inFolder.length === 0 ? (
                  <div className="folder-empty">
                    Empty — drag a file here, or use the folder button on a file.
                  </div>
                ) : (
                  inFolder.map((f) => <FileRow key={f.id} f={f} s={s} a={a} />)
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- AI sources: the evidence set for the next answer ---------- */

function SourcesPanel({
  s,
  a,
  shownFiles,
  attachedIds,
}: {
  s: WSState;
  a: WSActions;
  shownFiles: import("../api").FileMeta[];
  attachedIds: Set<string>;
}) {
  const attached = shownFiles.filter((f) => attachedIds.has(f.id));
  const available = shownFiles.filter((f) => !attachedIds.has(f.id));
  return (
    <div className="library-scroll" role="group" aria-label="AI sources">
      <div className="sources-scope" role="status">
        <span
          className={`scope-tag ${s.attachments.length === 0 ? "auto" : "selected"}`}
        >
          {s.attachments.length === 0
            ? "Scope: Whole room"
            : `Scope: ${s.attachments.length} selected file${s.attachments.length === 1 ? "" : "s"}`}
        </span>
        <p className="area-nav-intro">
          {s.attachments.length === 0
            ? "With nothing checked, the AI automatically pulls the most relevant passages from every file in this room. Check files below to answer from only those."
            : "Answers draw only on the checked files — nothing else in the room. Uncheck all to search the whole room again."}
        </p>
      </div>
      {attached.length > 0 && (
        <>
          <div className="group-heading">Attached to the next question</div>
          {attached.map((f) => (
            <SourceRow key={f.id} f={f} s={s} a={a} checked />
          ))}
        </>
      )}
      <div className="group-heading">Available in this room</div>
      {available.length === 0 && shownFiles.length === 0 && (
        <div className="empty-hint">
          {s.files.length === 0
            ? "No files yet — add one to ground the AI's answers."
            : `No files match “${s.fileFilter}”.`}
        </div>
      )}
      {available.map((f) => (
        <SourceRow key={f.id} f={f} s={s} a={a} checked={false} />
      ))}
    </div>
  );
}

function SourceRow({
  f,
  s,
  a,
  checked,
}: {
  f: import("../api").FileMeta;
  s: WSState;
  a: WSActions;
  checked: boolean;
}) {
  const current = s.openFile?.id === f.id;
  return (
    <div className={`source-row${current ? " is-current" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        aria-label={`Use ${fileLabel(f.name, s.files)} in AI answers`}
        onChange={() => a.toggleAttach(f)}
      />
      <button
        className="source-open"
        type="button"
        onClick={() => void a.viewFile(f.id)}
        title={`Open ${f.name}`}
      >
        <div className="source-line">
          <span className="source-name">{fileLabel(f.name, s.files)}</span>
        </div>
        <div className="source-meta">{fileKindLabel(f)}</div>
      </button>
    </div>
  );
}

/* ---------- Recordings lens ---------- */

function RecordingsNav({
  s,
  a,
  shownFiles,
}: {
  s: WSState;
  a: WSActions;
  shownFiles: import("../api").FileMeta[];
}) {
  const recs = shownFiles.filter(isRecordingFile);
  return (
    <div className="library-scroll">
      <p className="area-nav-intro">
        Capture, transcribe, edit, and export. Recordings are ordinary room
        files — everything here is also in Browse.
      </p>
      <button
        className="area-nav-row"
        disabled={s.recLive != null}
        title="Record mic + the Mac's audio with a live transcript"
        onClick={() => void a.startLiveRecording()}
      >
        <span className="browse-icon">
          <MicIcon size={15} />
        </span>
        <span className="area-nav-main">
          <span className="area-nav-title">New live recording</span>
          <span className="area-nav-copy">Mic + Mac audio, live transcript</span>
        </span>
      </button>
      <button
        className="area-nav-row"
        disabled={a.micState("note").disabled}
        onClick={() => a.recordVoiceNote()}
      >
        <span className="browse-icon">
          <MicIcon size={15} />
        </span>
        <span className="area-nav-main">
          <span className="area-nav-title">Voice note</span>
          <span className="area-nav-copy">Starts the mic — audio saved here</span>
        </span>
      </button>
      <div className="group-heading">In this room</div>
      {recs.length === 0 && (
        <div className="empty-hint">
          No recordings yet. Start one above, or import audio/video files —
          they transcribe themselves in the background.
        </div>
      )}
      {recs.map((f) => (
        <FileRow key={f.id} f={f} s={s} a={a} />
      ))}
    </div>
  );
}

/* ---------- Workflows lens ---------- */

function WorkflowsNav({ s, a }: { s: WSState; a: WSActions }) {
  // Per-script auto-workflows (created_by='script') live on the Scripts page —
  // keep them out of the workflow list so a script isn't shown as "· by script".
  const workflows = visibleWorkflows(s.workflows);
  return (
    <div className="library-scroll">
      <p className="area-nav-intro">
        Repeatable pipelines over this room's files — run them now or on a
        schedule.
      </p>
      <button className="area-nav-row" onClick={() => a.openWorkflows()}>
        <span className="browse-icon">
          <PlusIcon size={15} />
        </span>
        <span className="area-nav-main">
          <span className="area-nav-title">New workflow</span>
          <span className="area-nav-copy">Start blank or pick a template</span>
        </span>
      </button>
      <div className="group-heading">In this room</div>
      {workflows.length === 0 && (
        <div className="empty-hint">
          No workflows yet — create one, or start from a template in the
          center pane.
        </div>
      )}
      {workflows.map((w) => (
        <button
          key={w.id}
          className={`area-nav-row${s.wfDetailId === w.id ? " is-current" : ""}`}
          onClick={() => a.openWorkflowDetail(w.id)}
        >
          <span className="browse-icon">
            {w.emoji ? <span aria-hidden>{w.emoji}</span> : <WorkflowsIcon size={15} />}
          </span>
          <span className="area-nav-main">
            <span className="area-nav-title">{w.name}</span>
            <span className="area-nav-copy">
              {w.status === "active" ? "Active" : "Draft"}
              {w.pinned ? " · Pinned" : ""}
              {w.createdBy !== "user" ? ` · by ${w.createdBy}` : ""}
            </span>
          </span>
          <span className="area-nav-state">
            {w.binding.scope === "general" ? "" : "File"}
          </span>
        </button>
      ))}
    </div>
  );
}

/* ---------- Scripts lens ---------- */

function ScriptsNav({ s, a }: { s: WSState; a: WSActions }) {
  return (
    <div className="library-scroll">
      <p className="area-nav-intro">
        Python or JavaScript files in this room, with declared inputs, outputs
        and consent tied to their exact contents.
      </p>
      <div className="group-heading">In this room</div>
      {s.scripts.length === 0 && (
        <div className="empty-hint">
          No scripts yet — add a .py or .js file with a manifest. The center
          pane shows an example.
        </div>
      )}
      {s.scripts.map((sc) => (
        <button
          key={sc.fileId}
          className={`area-nav-row${s.openFile?.id === sc.fileId ? " is-current" : ""}`}
          onClick={() => void a.viewFile(sc.fileId)}
          title={`Open ${sc.name}`}
        >
          <span className="browse-icon">
            <ScriptIcon size={15} />
          </span>
          <span className="area-nav-main">
            <span className="area-nav-title">{sc.name}</span>
            <span className="area-nav-copy">
              {sc.approved
                ? "Approved"
                : sc.changedSinceApproval
                  ? "Edited — needs approval again"
                  : "Needs review"}
              {sc.shortcut === "global" ? " · Global shortcut" : ""}
            </span>
          </span>
          <span className="area-nav-state">
            {sc.lang === "py" ? "Python" : "JavaScript"}
          </span>
        </button>
      ))}
    </div>
  );
}

/* ---------- Skills lens ---------- */

function SkillsNav({ s, a }: { s: WSState; a: WSActions }) {
  return (
    <div className="library-scroll">
      <p className="area-nav-intro">
        Portable instructions and bundled resources the assistant loads only
        when a task matches.
      </p>
      <div className="group-heading">In this room</div>
      {s.skills.length === 0 && (
        <div className="empty-hint">
          No skills yet — build one with AI, create it manually, or import a
          folder from Claude Code or another Agent Skills client.
        </div>
      )}
      {s.skills.map((skill) => (
        <button
          key={skill.id}
          className={`area-nav-row${s.selectedSkillId === skill.id ? " is-current" : ""}`}
          onClick={() => a.openSkill(skill.id)}
          title={skill.description}
        >
          <span className="browse-icon"><BookOpenIcon size={15} /></span>
          <span className="area-nav-main">
            <span className="area-nav-title">{skill.name}</span>
            <span className="area-nav-copy">
              {skill.enabled ? "Enabled" : "Disabled draft"} · {skill.resourceCount} resource{skill.resourceCount === 1 ? "" : "s"}
            </span>
          </span>
          <span className="area-nav-state">{skill.createdBy === "agent" ? "AI" : skill.createdBy}</span>
        </button>
      ))}
    </div>
  );
}

/* ---------- Private browser lens ---------- */

/** The browser keeps nothing on disk, so this pane has nothing to list — which
 * is exactly why it must SAY so. It used to render the heading and then an
 * empty column, which reads as a bug rather than as a promise being kept. */
function BrowserNav() {
  return (
    <div className="library-scroll">
      <p className="area-nav-intro">
        Open pages live in the tab strip above the page itself — there is no
        list here because this browser keeps no history, no bookmarks and no
        cookies between sessions.
      </p>
      <div className="group-heading">While you browse</div>
      <p className="area-nav-intro">
        Save a page or a download into the room from the browser's own toolbar;
        anything you save becomes an ordinary encrypted room file and appears in
        the Library.
      </p>
    </div>
  );
}

/* ---------- Connectors lens ---------- */

function ConnectorsNav({ s }: { s: WSState }) {
  return (
    <div className="library-scroll">
      <p className="area-nav-intro">
        Tool connectors in this room. Manage them and add more in the center
        pane.
      </p>
      <div className="group-heading">Installed</div>
      {s.mcpStatuses.length === 0 && (
        <div className="empty-hint">
          No connectors yet — browse the marketplace in the center pane to add
          one.
        </div>
      )}
      {s.mcpStatuses.map((m) => (
        <div key={m.name} className="area-nav-row" title={m.name}>
          <span className="browse-icon">
            <span className={`mcp-dot ${m.status}`} />
          </span>
          <span className="area-nav-main">
            <span className="area-nav-title">{m.name}</span>
            <span className="area-nav-copy">
              {m.status === "connected"
                ? `${m.tools.length} tool${m.tools.length === 1 ? "" : "s"}`
                : m.status === "disabled"
                  ? "Off"
                  : m.status === "connecting"
                    ? "Connecting…"
                    : (m.error ?? "Failed")}
            </span>
          </span>
          <span className="area-nav-state">{m.remote ? "Remote" : "Local"}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- Memory lens ---------- */

function MemoryNav({ s, a }: { s: WSState; a: WSActions }) {
  const counts = new Map<string | null, number>();
  for (const m of s.memories) {
    const k = m.category ?? null;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const groups: { key: string | null; label: string }[] = [
    { key: "instruction", label: "Instructions" },
    { key: "preference", label: "Preferences" },
    { key: "project", label: "Projects" },
    { key: "fact", label: "Facts" },
    { key: null, label: "Uncategorized" },
  ];
  return (
    <div className="library-scroll">
      <p className="area-nav-intro">
        Durable context the AI may use when relevant. The scratch pad is an
        ordinary private file — it never becomes memory on its own.
      </p>
      <button
        className="area-nav-row"
        onClick={() => void a.openScratchPad()}
        title='Shared working notes — you and the AI both write "Scratch pad.md"'
      >
        <span className="browse-icon">
          <PencilIcon size={15} />
        </span>
        <span className="area-nav-main">
          <span className="area-nav-title">Scratch pad</span>
          <span className="area-nav-copy">Temporary shared notes — not memory</span>
        </span>
      </button>
      <div className="group-heading">Saved memory</div>
      <div className="area-nav-row is-static">
        <span className="browse-icon">
          <MemoryIcon size={15} />
        </span>
        <span className="area-nav-main">
          <span className="area-nav-title">All memory</span>
        </span>
        <span className="area-nav-state">{s.memories.length}</span>
      </div>
      {groups
        .filter((g) => (counts.get(g.key) ?? 0) > 0)
        .map((g) => (
          <div key={g.key ?? "other"} className="area-nav-row is-static">
            <span className="browse-icon" />
            <span className="area-nav-main">
              <span className="area-nav-title">{g.label}</span>
            </span>
            <span className="area-nav-state">{counts.get(g.key)}</span>
          </div>
        ))}
    </div>
  );
}
