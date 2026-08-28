import { useEffect, useState } from "react";
import {
  CloseIcon,
  CollapseLeftIcon,
  CreateIcon,
  DownloadIcon,
  FolderIcon,
  GlobeIcon,
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
import { WorkArea, isCreationFile, isSketchFile } from "./types";
import {
  SIDEBAR_TITLES,
  newItemLabel,
  newItemOf,
  type NewItemKind,
} from "./destinations";
import { libraryFiles, libraryStatus } from "./fileVisibility";
import {
  pageAccessibleName,
  pageLabel,
  pageSubtitle,
  type BrowserPagesApi,
} from "./browserPages";
import { LayoutApi } from "../shell/useLayout";
import { visibleWorkflows } from "./workflows/selectors";
import {
  FILE_SORTS,
  FILE_SORT_LABELS,
  sortFiles,
  type FileSort,
} from "./fileSort";

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
export default function LibraryPane({
  s,
  a,
  layout,
  area,
  pages,
  onNewItem,
}: {
  s: WSState;
  a: WSActions;
  layout: LayoutApi;
  area: WorkArea;
  /** The private browser's open pages — read by the Browser destination only.
   * Threaded rather than re-derived here because there is one list and the
   * shell owns it; a second reconciliation would be a second answer. */
  pages: BrowserPagesApi;
  /** The destination's new-item verb (⌘T's other half). */
  onNewItem: (kind: NewItemKind) => void;
}) {
  const filterQ = s.fileFilter.trim().toLowerCase();
  const matchesFilter = (f: import("../api").FileMeta) =>
    !filterQ ||
    f.name.toLowerCase().includes(filterQ) ||
    displayName(f.name).toLowerCase().includes(filterQ);
  // HOME'S POPULATION, once, for every surface Home draws: the folder tree, the
  // evidence checkboxes, the count badge. A section-only object is a full room
  // file and simply is not one of the things Home lists — see fileVisibility.ts.
  // Recordings and the map read `s.files` directly further down, because they
  // are not Home and are not making a claim about what Home shows.
  const shownFiles = sortFiles(libraryFiles(s.files).filter(matchesFilter), s.fileSort);
  const looseFiles = shownFiles.filter((f) => f.folderId === null);
  const attachedIds = new Set(s.attachments.map((f) => f.id));
  // "files" and "home" are the same destination under two names (the rail says
  // Home; "files" is the default lens the room opens in). The map is NOT one of
  // them any more: it draws room content, which never made the room's file list
  // its navigator — it has map controls of its own now.
  const fileArea = area === "files" || area === "home";
  const heading = SIDEBAR_TITLES[area];
  const newItem = newItemOf(area);
  const newLabel = newItemLabel(area);

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

  // A checked file that leaves the trash leaves the selection with it.
  // Restoring or destroying it from its OWN row emptied the panel's bar while
  // the footer below still counted the id — "Put 1 file back in the library",
  // enabled, over a trash that no longer holds it, and an error toast naming a
  // file that is gone when pressed. Lives here, above TrashPanel, because that
  // component returns early on an empty trash — which is exactly when this has
  // to run.
  const trashed = s.trashed;
  const setSelectedTrashIds = s.setSelectedTrashIds;
  useEffect(() => {
    setSelectedTrashIds((cur) => {
      if (cur.size === 0) return cur;
      const live = new Set(trashed.map((f) => f.id));
      const next = new Set([...cur].filter((id) => live.has(id)));
      return next.size === cur.size ? cur : next;
    });
  }, [trashed, setSelectedTrashIds]);

  // null = this destination has no list to count, so no badge is drawn. A hard
  // "0" beside a destination that never lists anything reads as "empty", which
  // is a different and untrue claim.
  const headerCount: number | null = fileArea
    ? libraryFiles(s.files).length
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
                : area === "sketch"
                  ? s.files.filter(isSketchFile).length
                  : area === "browser"
                    ? pages.pages.length
                    : null;

  // A destination that declares no second column gives its width to the
  // workspace rather than drawing an empty one. Nothing does today; the branch
  // exists so that adding such a destination is a one-line declaration in
  // destinations.ts rather than a layout fork here.
  if (heading === null) return null;

  return (
    <>
      {/* ONE HEADER SHAPE FOR EVERY DESTINATION: title, count when there is a
          list to count, primary action when the destination has one, then the
          two pane controls. */}
      <div className="pane-header">
        <div className="pane-heading">{heading}</div>
        {headerCount !== null && (
          <span className="count-badge">{headerCount}</span>
        )}
        {/* The destination's primary action, in the one place every
            destination puts it. Home keeps its richer "Add page or source"
            menu in the footer — it adds six different kinds of thing, which is
            a menu, not a button. */}
        {newItem && newItem !== "note" && (
          <button
            className="pane-new-btn"
            type="button"
            title={`${newLabel} (⌘T)`}
            aria-label={`${newLabel} (Command T)`}
            onClick={() => onNewItem(newItem)}
          >
            <PlusIcon size={12} /> {newLabel}
          </button>
        )}
        {/* Collapse, and no Focus. Focusing THIS pane made the visible set
            exactly ["library"], hiding the workspace — the one pane the layout
            model says cannot be hidden — and the way out, Escape, declines
            while a text field has the keyboard, which this pane's own filter
            box two rows below took the moment you reached for it. "Focus the
            workspace" is the thing people want and it is already in the Layout
            menu, the native View menu and ⌘K. */}
        <div className="pane-actions">
          <button
            className="pane-icon-btn"
            data-tip="Collapse"
            aria-label={`Collapse ${heading}`}
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

      {/* No import strip here. The same `s.importProgress` already draws a full
          activity row in the assistant pane — the same count, the same
          filename, a measured bar and a Running tape — and neither surface can
          stop an import, so the second copy added no control either. It also
          appeared mid-scroll and pushed the file list down under the reader's
          cursor. */}

      {/* Trash is a record of what left the room, not a list you browse — a
          filter box and a "Newest first" sort control that don't move the
          trash at all (it composes its own, unrelated order) don't belong
          here. Suppressed for that tab only; Browse/AI sources keep both. */}
      {((fileArea && s.libraryTab !== "trash") ||
        area === "recordings" ||
        area === "sketch") && (
        <div className="source-tools">
          <label className="search-field">
            <SearchIcon size={14} />
            <input
              type="search"
              placeholder={
                area === "recordings"
                  ? "Filter recordings"
                  : area === "sketch"
                    ? "Filter sketches"
                    : "Filter files and pages"
              }
              aria-label={
                area === "recordings"
                  ? "Filter recordings"
                  : area === "sketch"
                    ? "Filter sketches"
                    : "Filter files and pages"
              }
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
                <CloseIcon size={12} />
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
      {area === "recordings" && <RecordingsNav s={s} a={a} />}
      {area === "workflows" && <WorkflowsNav s={s} a={a} />}
      {area === "scripts" && <ScriptsNav s={s} a={a} />}
      {area === "skills" && <SkillsNav s={s} a={a} />}
      {area === "memory" && <MemoryNav s={s} a={a} />}
      {area === "connectors" && <ConnectorsNav s={s} />}
      {area === "browser" && <PagesNav pages={pages} onNewItem={onNewItem} />}
      {area === "sketch" && <SketchesNav s={s} a={a} onNewItem={onNewItem} />}
      {area === "create" && <CreationsNav s={s} a={a} />}
      {area === "map" && <MapNav s={s} a={a} />}

      {/* Trash has nothing to add — you cannot add a source to what has been
          removed — so its footer does the one bulk action the tab actually
          needs instead of duplicating "+ Add page or source" from Browse.

          Home only. Recordings drew this menu too, and of its seven entries two
          were the same two verbs its own column already offers at the top and
          five made things a list of recordings can never show. Home's footer is
          one rail click away and ⌘K carries the rest. */}
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
      ) : fileArea && (
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
                        Saved as normal files. Private Arcelle data stays encrypted.
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
        // Only when the library is the surface being worked in — hovered, or
        // holding focus. This listener is on the window and the pane stays
        // mounted (hidden panes are `visibility: hidden`, so neither test can
        // match one), so an unscoped ⌘A took select-all away from the whole
        // room: over a PDF or a note it selected library rows instead of the
        // document's text, and with the sidebar collapsed it armed a
        // multi-file selection nothing on screen showed. Same hover-or-focus
        // scoping the PDF viewer uses for ⌘F.
        const pane = document.querySelector(".pane-library");
        const mine =
          !!pane &&
          (pane.matches(":hover") || pane.contains(document.activeElement));
        if (!mine) return;
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
    /* A GROUP, not a `toolbar`: `role="toolbar"` promises arrow-key navigation
       between its controls, and these are plain tab stops. Claiming the role
       without the behaviour is a lie to assistive tech. */
    <div className="selection-bar" role="group" aria-label={`${n} files selected`}>
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
          <FolderIcon size={14} /> Move
        </button>
        <button
          className="chip-btn"
          title="Pin all of these into your next question"
          onClick={() => a.attachFiles(picked)}
        >
          <PaperclipIcon size={14} /> Attach
        </button>
        <button
          className="chip-btn"
          title="Export copies of all of these out of the room"
          onClick={() => void a.exportFiles(picked)}
        >
          <DownloadIcon size={14} /> Export
        </button>
        {/* Same armed confirm as one file's Remove — a set of files must never
            be easier to delete than one of them. The question names the count,
            because "Move to the trash?" over seven files is a different act. */}
        <DeleteControl
          k="selection-remove"
          trigger={<TrashIcon size={14} />}
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
  // "\n", not "\0". A NUL is the classic collision-proof separator and it works
  // perfectly — but it also makes this whole FILE read as binary, so grep, rg
  // and every editor search silently report no matches anywhere in it. A
  // newline cannot appear in a file id either, and leaves the source
  // searchable.
  const orderKey = paintedOrder.join("\n");
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
          Add PDFs, notes, images, code or spreadsheets. They stay as normal
          files, while private Arcelle data stays encrypted.
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
                /* ONE control per folder, not two. The caret was its own
                   button doing the identical thing, and because it had text
                   content ("▸") that glyph WAS its accessible name — announced
                   as "▸ button", with its title never read. The state is on
                   the label button now, where `aria-expanded` says it out loud
                   instead of drawing it. */
                <button
                  className="folder-label"
                  aria-expanded={!collapsed}
                  onClick={() => a.toggleFolderCollapse(folder.id)}
                >
                  <span className="folder-caret" aria-hidden>
                    {collapsed ? "▸" : "▾"}
                  </span>
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
                  <PencilIcon size={14} />
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

function RecordingsNav({ s, a }: { s: WSState; a: WSActions }) {
  // Reads `s.files`, not Home's population: Recordings lists ITS OWN objects,
  // including any a person has removed from the Library. Sorted and filtered by
  // the same controls the header draws, so the list matches them.
  const q = s.fileFilter.trim().toLowerCase();
  const recs = sortFiles(
    s.files.filter(isRecordingFile).filter((f) => !q || f.name.toLowerCase().includes(q)),
    s.fileSort,
  );
  return (
    <div className="library-scroll">
      <button
        className="area-nav-row"
        disabled={s.recLive != null}
        title="Record mic + the Mac's audio with a live transcript"
        onClick={() => void a.startLiveRecording()}
      >
        <span className="browse-icon">
          <MicIcon size={14} />
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
          <MicIcon size={14} />
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
      {workflows.length === 0 && (
        <p className="area-nav-intro">
          Repeatable pipelines over this room's files — run them now or on a
          schedule.
        </p>
      )}
      <button className="area-nav-row" onClick={() => a.openWorkflows()}>
        <span className="browse-icon">
          <PlusIcon size={14} />
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
            {w.emoji ? <span aria-hidden>{w.emoji}</span> : <WorkflowsIcon size={14} />}
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
      {s.scripts.length === 0 && (
        <p className="area-nav-intro">
          Python or JavaScript files in this room, with declared inputs, outputs
          and consent tied to their exact contents.
        </p>
      )}
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
            <ScriptIcon size={14} />
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
      {s.skills.length === 0 && (
        <p className="area-nav-intro">
          Portable instructions and bundled resources the assistant loads only
          when a task matches.
        </p>
      )}
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
          <span className="browse-icon"><BookOpenIcon size={14} /></span>
          <span className="area-nav-main">
            <span className="area-nav-title">{skill.name}</span>
            {/* A skill with no description is offered to the assistant with
                nothing to choose it BY, so "Enabled" over one is the wrong
                fact to lead with — the card in the centre pane already marks
                it Incomplete. Owner checks stay there; only that pane holds
                the agent roster. */}
            <span className="area-nav-copy">
              {skill.description.trim()
                ? `${skill.enabled ? "Enabled" : "Disabled draft"} · ${skill.resourceCount} resource${skill.resourceCount === 1 ? "" : "s"}`
                : "Needs a description — can't be chosen"}
            </span>
          </span>
          <span className="area-nav-state">{skill.createdBy === "agent" ? "AI" : skill.createdBy}</span>
        </button>
      ))}
    </div>
  );
}

/* ---------- Private browser: the open pages ---------- */

/** THE OPEN PRIVATE PAGES, VERTICALLY, IN THE ONE DESTINATION THEY BELONG TO.
 *
 * This column used to be two paragraphs of instructions pointing at a
 * horizontal strip above the workspace — a strip that also carried room
 * documents, recordings and sketches, and that stayed on screen in every other
 * destination. So a private page was visible from Skills and Memory, and the
 * one place that ought to have listed pages listed nothing.
 *
 * A `tablist`, not a `list`, and honestly so: these rows select which page the
 * workspace shows, which is what a tab does. That earns them Left/Right and
 * Home/End, which the roving `tabIndex` below provides.
 *
 * The privacy contract is unchanged and is why the empty state says it ONCE,
 * in one sentence, instead of spending the column on it. This list is the pages
 * open right now, held in memory, never written down — see browserPages.ts. */
function PagesNav({
  pages,
  onNewItem,
}: {
  pages: BrowserPagesApi;
  onNewItem: (kind: NewItemKind) => void;
}) {
  const [dragging, setDragging] = useState("");

  if (pages.pages.length === 0) {
    return (
      <div className="library-scroll">
        <div className="empty-hint">
          No pages open. This browser keeps no history, cookies or cache between
          sessions.
        </div>
        <button className="area-nav-row" onClick={() => onNewItem("page")}>
          <span className="browse-icon">
            <PlusIcon size={14} />
          </span>
          <span className="area-nav-main">
            <span className="area-nav-title">New page</span>
            <span className="area-nav-copy">Search the web, or open an address</span>
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      className="library-scroll"
      role="tablist"
      aria-label="Open private pages"
      aria-orientation="vertical"
    >
      {pages.pages.map((p, index) => {
        const current = p.id === pages.activeId;
        return (
          <div
            key={p.id}
            role="tab"
            aria-selected={current}
            // Roving focus: exactly one row is in the tab order, and the arrows
            // move between them. Without it a tablist claims a keyboard model
            // it does not implement.
            tabIndex={current ? 0 : -1}
            className={`area-nav-row page-row${current ? " is-current" : ""}${
              dragging === p.id ? " is-dragging" : ""
            }`}
            draggable
            onDragStart={() => setDragging(p.id)}
            onDragEnd={() => setDragging("")}
            onDragOver={(e) => {
              e.preventDefault();
              const from = pages.pages.findIndex((x) => x.id === dragging);
              if (from >= 0 && from !== index) pages.move(from, index);
            }}
            onClick={() => pages.select(p.id)}
            onAuxClick={(e) => {
              // Middle-click closes, as everywhere else with tabs.
              if (e.button === 1) {
                e.preventDefault();
                pages.close(p.id);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                pages.select(p.id);
                return;
              }
              // The keyboard equivalent of the hover close button — a control
              // that only exists under a pointer is not a control everyone has.
              if (e.key === "Backspace" || e.key === "Delete") {
                e.preventDefault();
                pages.close(p.id);
                return;
              }
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const count = pages.pages.length;
                const to =
                  (index + (e.key === "ArrowDown" ? 1 : -1) + count) % count;
                pages.select(pages.pages[to].id);
                (e.currentTarget.parentElement?.children[to] as HTMLElement)?.focus();
              }
            }}
          >
            <span className="browse-icon">
              <GlobeIcon size={14} />
            </span>
            <span className="area-nav-main">
              {/* The accessible name carries the host as well, because two
                  pages with the same title are one repeated list item to a
                  screen reader unless the row says which site each is on. */}
              <span className="area-nav-title" aria-hidden>
                {pageLabel(p)}
              </span>
              <span className="sr-only">{pageAccessibleName(p)}</span>
              {/* Only when it says something the title does not — see
                  `pageSubtitle`. A second line repeating the first is a row
                  half wasted. */}
              {pageSubtitle(p) && (
                <span className="area-nav-copy" aria-hidden>
                  {pageSubtitle(p)}
                </span>
              )}
            </span>
            <button
              className="page-close"
              aria-label={`Close ${pageAccessibleName(p)}`}
              title="Close this page"
              onClick={(e) => {
                e.stopPropagation();
                pages.close(p.id);
              }}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Sketches ---------- */

/** Every drawing in the room, and the one that is open.
 *
 * The list and its "New sketch" button used to be the CENTRE pane — a gallery
 * you navigated to, that vanished the moment you opened a drawing, leaving no
 * way to reach the next one without going back. As a sidebar it is beside the
 * canvas the whole time, which is what a list of documents is for.
 *
 * Each row's own status is deliberately absent: `Section only` / `In Library`
 * is drawn once, on the open sketch's toolbar (see ViewerPane), because a badge
 * repeated down every row is decoration rather than information. */
/** "today" / "yesterday" / a short date — the same convention the search
 * results and Activity's history use for a margin date. Deliberately not a
 * clock time: the hour a drawing was started is never the thing anyone is
 * scanning this list for. */
function sketchWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "a drawing";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "Started today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Started yesterday";
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  return `Started ${d.toLocaleDateString(undefined, opts)}`;
}

function SketchesNav({
  s,
  a,
  onNewItem,
}: {
  s: WSState;
  a: WSActions;
  onNewItem: (kind: NewItemKind) => void;
}) {
  const q = s.fileFilter.trim().toLowerCase();
  const sketches = s.files
    .filter(isSketchFile)
    .filter((f) => !q || f.name.toLowerCase().includes(q));
  return (
    <div className="library-scroll" role="list" aria-label="Sketches in this room">
      {s.files.filter(isSketchFile).length === 0 ? (
        <div className="empty-hint">
          Nothing sketched yet. Press New sketch, or ask the room&rsquo;s AI —
          &ldquo;draw my login flow&rdquo; — and it will.
        </div>
      ) : sketches.length === 0 ? (
        <div className="empty-hint">No sketches match “{s.fileFilter}”.</div>
      ) : (
        sketches.map((f) => (
          <div
            key={f.id}
            role="listitem"
            className={`area-nav-row${s.openFile?.id === f.id ? " is-current" : ""}`}
            onClick={() => void a.viewFile(f.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                void a.viewFile(f.id);
              }
            }}
            tabIndex={0}
            title={`Open ${f.name}`}
          >
            <span className="browse-icon">
              <PencilIcon size={14} />
            </span>
            <span className="area-nav-main">
              <span className="area-nav-title">{displayName(f.name)}</span>
              {/* WHAT THE ROW ACTUALLY KNOWS.
                  Every row used to read "a drawing", which is the one thing
                  the reader could already see from the heading above them. The
                  summary is shown when the room has written one; otherwise the
                  line says when the drawing arrived and whether Home lists it,
                  because those are facts this list HAS. It does not invent a
                  size or an object count — the file list carries neither, and
                  a made-up number is worse than a quiet row. */}
              <span className="area-nav-copy">
                {f.aiSummary ?? sketchWhen(f.createdAt)}
              </span>
            </span>
            {/* The two safe row verbs the app already uses everywhere else,
                with the same armed confirm behind the destructive one. */}
            <span className="area-nav-state">
              {libraryStatus(f)?.linked ? (
                <span className="nav-chip" title="Home's Library lists this too">
                  In Library
                </span>
              ) : null}
              <button
                className="chip-btn"
                title="Rename this sketch"
                aria-label={`Rename ${displayName(f.name)}`}
                onClick={(e) => {
                  e.stopPropagation();
                  s.setRenamingFile({ id: f.id, name: f.name, where: "library" });
                }}
              >
                <PencilIcon size={12} />
              </button>
              <DeleteControl
                k={`sketch:${f.id}`}
                trigger={<TrashIcon size={12} />}
                question="Move this sketch to the trash?"
                title="Move this sketch to the trash"
                onConfirm={() => void a.removeFile(f.id)}
                confirmDelete={s.confirmDelete}
                askConfirm={a.askConfirm}
                cancelConfirm={a.cancelConfirm}
              />
            </span>
          </div>
        ))
      )}
      {s.renamingFile?.where === "library" &&
        sketches.some((f) => f.id === s.renamingFile?.id) && (
          <input
            className="folder-rename"
            autoFocus
            dir="auto"
            aria-label="Rename this sketch"
            value={s.renamingFile.name}
            onChange={(e) =>
              s.setRenamingFile({
                id: s.renamingFile!.id,
                name: e.target.value,
                where: "library",
              })
            }
            onBlur={a.commitRenameFile}
            onKeyDown={(e) => {
              if (e.key === "Enter") a.commitRenameFile();
              if (e.key === "Escape") s.setRenamingFile(null);
            }}
          />
        )}
      <button className="area-nav-row" onClick={() => onNewItem("sketch")}>
        <span className="browse-icon">
          <PlusIcon size={14} />
        </span>
        <span className="area-nav-main">
          <span className="area-nav-title">New sketch</span>
          <span className="area-nav-copy">A blank canvas, in Sketches (⌘T)</span>
        </span>
      </button>
    </div>
  );
}

/* ---------- Creations ---------- */

/** What the Create page has made and is making.
 *
 * Three populations in one list, in the order a person cares about them:
 * generations in flight (with their live progress), runs that failed (with
 * their reason, because a failure that vanishes is a charge nobody can
 * account for), and the finished pictures and clips.
 *
 * The FILTERS ARE THE ONES THE DATA SUPPORTS — All / Images / Video, off the
 * files' own mime types. Nothing decorative: a "favourites" or "recent" filter
 * would need a field no creation carries. */
function CreationsNav({ s, a }: { s: WSState; a: WSActions }) {
  const [lens, setLens] = useState<"all" | "image" | "video">("all");
  const jobs = s.jobs.filter((j) => j.kind === "create");
  const running = jobs.filter((j) => j.status === "running" || j.status === "queued");
  // "error", not "failed" — the same status string the Create page's own
  // failure list reads. Two spellings of one status is how a list quietly
  // stops showing the runs it exists to account for.
  const failed = jobs.filter((j) => j.status === "error");
  const outputs = s.files.filter(isCreationFile).filter((f) => {
    if (lens === "all") return true;
    const video = f.mimeType.startsWith("video/");
    return lens === "video" ? video : !video;
  });
  const nothingAtAll =
    running.length === 0 && failed.length === 0 && s.files.filter(isCreationFile).length === 0;

  return (
    <div className="library-scroll">
      {!nothingAtAll && (
        <div className="pane-tabs" role="tablist" aria-label="Filter creations">
          {(["all", "image", "video"] as const).map((k) => (
            <button
              key={k}
              className="pane-tab"
              role="tab"
              aria-selected={lens === k}
              onClick={() => setLens(k)}
            >
              {k === "all" ? "All" : k === "image" ? "Images" : "Video"}
            </button>
          ))}
        </div>
      )}
      {nothingAtAll && (
        <div className="empty-hint">
          Nothing made yet. Describe a picture or a clip in the composer and
          press Create — results land here, and stay in this room.
        </div>
      )}
      {running.length > 0 && <div className="group-heading">Making now</div>}
      {running.map((j) => {
        const p = s.jobProgress[j.id];
        return (
          <div key={j.id} className="area-nav-row is-static">
            <span className="browse-icon">
              <CreateIcon size={14} />
            </span>
            <span className="area-nav-main">
              <span className="area-nav-title">{j.title}</span>
              <span className="area-nav-copy">
                {/* The job's own reported step, or its plain status. Never a
                    made-up percentage: `jobProgress` is absent until the run
                    reports one, and inventing a number for the gap is the
                    fake-progress-bar problem this app has ruled out.
                    The label ALONE, with no done/total after it: a create run
                    carries its real percentage inside the label and leaves the
                    pair at the variation it started on, so the fraction read
                    "Filming… 43% 0/100" — two numbers contradicting each other
                    in one sentence. */}
                {p ? p.label : j.status === "queued" ? "Queued" : "Working…"}
              </span>
            </span>
          </div>
        );
      })}
      {failed.length > 0 && <div className="group-heading">Didn’t finish</div>}
      {failed.map((j) => (
        <div key={j.id} className="area-nav-row is-static" title={j.error ?? undefined}>
          <span className="browse-icon">
            <CreateIcon size={14} />
          </span>
          <span className="area-nav-main">
            <span className="area-nav-title">{j.title}</span>
            <span className="area-nav-copy">{j.error ?? "Failed"}</span>
          </span>
        </div>
      ))}
      {outputs.length > 0 && <div className="group-heading">Made in this room</div>}
      {outputs.map((f) => {
        const status = libraryStatus(f);
        return (
          <button
            key={f.id}
            className={`area-nav-row${s.openFile?.id === f.id ? " is-current" : ""}`}
            onClick={() => void a.viewFile(f.id)}
            title={`Open ${f.name}`}
          >
            <span className="browse-icon">
              <CreateIcon size={14} />
            </span>
            <span className="area-nav-main">
              <span className="area-nav-title">{displayName(f.name)}</span>
              <span className="area-nav-copy">{fileKindLabel(f)}</span>
            </span>
            {/* Only the exception is marked. A promoted creation is the unusual
                one, so it is the one that says so. */}
            {status?.linked && <span className="area-nav-state">In Library</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ---------- Room Map ---------- */

/** The map's own controls: what it is drawing, and how much of it.
 *
 * This column used to be the whole room Library, on the reasoning that the map
 * visualizes room content. That is a statement about the CENTRE pane, not about
 * what a person needs beside it — the map already draws every file as a node,
 * so listing them again next to it was the same navigation twice, and clicking
 * a row took you out of the map you had come to look at.
 *
 * What is here instead is what the existing map model actually supports: the
 * counts it is drawing from, and the search that is the honest way into a large
 * one. Nothing invented — there are no layers or groups in the model, so none
 * are offered. */
function MapNav({ s, a }: { s: WSState; a: WSActions }) {
  const files = s.files.length;
  const folders = s.folders.length;
  const derived = s.files.filter((f) => f.originDestination !== "library").length;
  return (
    <div className="library-scroll">
      {/* The one instruction the map needs, and only while there is nothing on
          it to learn from. A permanent paragraph explaining drag and zoom costs
          a row of the column forever to teach something the first drag
          teaches. */}
      {files === 0 && (
        <div className="empty-hint">
          Nothing to draw yet. Add files to the room and the map fills in.
        </div>
      )}
      <div className="group-heading">What it is drawing</div>
      <div className="area-nav-row is-static">
        <span className="browse-icon">
          <FolderIcon size={14} />
        </span>
        <span className="area-nav-main">
          <span className="area-nav-title">Files</span>
        </span>
        <span className="area-nav-state">{files}</span>
      </div>
      <div className="area-nav-row is-static">
        <span className="browse-icon">
          <FolderIcon size={14} />
        </span>
        <span className="area-nav-main">
          <span className="area-nav-title">Folders</span>
        </span>
        <span className="area-nav-state">{folders}</span>
      </div>
      <div className="area-nav-row is-static">
        <span className="browse-icon">
          <CreateIcon size={14} />
        </span>
        <span className="area-nav-main">
          <span className="area-nav-title">Made in a section</span>
          <span className="area-nav-copy">Sketches, creations and recordings</span>
        </span>
        <span className="area-nav-state">{derived}</span>
      </div>
      <div className="group-heading">Find something</div>
      <button
        className="area-nav-row"
        onClick={() => {
          s.setSearchQuery("");
          s.setShowSearch(true);
        }}
      >
        <span className="browse-icon">
          <SearchIcon size={14} />
        </span>
        <span className="area-nav-main">
          <span className="area-nav-title">Search this room</span>
          <span className="area-nav-copy">Files, chats and memory (⌘K)</span>
        </span>
      </button>
      <button className="area-nav-row" onClick={() => void a.startDeepSummary()}>
        <span className="browse-icon">
          <BookOpenIcon size={14} />
        </span>
        <span className="area-nav-main">
          <span className="area-nav-title">Summarize the room</span>
          <span className="area-nav-copy">One pass over everything here</span>
        </span>
      </button>
    </div>
  );
}

/* ---------- Connectors lens ---------- */

function ConnectorsNav({ s }: { s: WSState }) {
  return (
    <div className="library-scroll">
      {s.mcpStatuses.length === 0 && (
        <p className="area-nav-intro">
          Tool connectors in this room. Manage them and add more in the center
          pane.
        </p>
      )}
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
      {s.memories.length === 0 && (
        <p className="area-nav-intro">
          Durable context the AI may use when relevant. The scratch pad is an
          ordinary private file — it never becomes memory on its own.
        </p>
      )}
      <button
        className="area-nav-row"
        onClick={() => void a.openScratchPad()}
        title='Shared working notes — you and the AI both write "Scratch pad.md"'
      >
        <span className="browse-icon">
          <PencilIcon size={14} />
        </span>
        <span className="area-nav-main">
          <span className="area-nav-title">Scratch pad</span>
          <span className="area-nav-copy">Temporary shared notes — not memory</span>
        </span>
      </button>
      <div className="group-heading">Saved memory</div>
      <div className="area-nav-row is-static">
        <span className="browse-icon">
          <MemoryIcon size={14} />
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
