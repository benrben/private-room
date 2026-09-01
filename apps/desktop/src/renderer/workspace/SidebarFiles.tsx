import { useEffect } from "react";
import { CloseIcon, DownloadIcon, FolderIcon, PaperclipIcon, PencilIcon, TrashIcon } from "../icons";
import { fileKindLabel } from "../api";
import DeleteControl from "./DeleteControl";
import FileRow from "./FileRow";
import type { WSActions } from "./actions";
import { fileLabel } from "./composer";
import type { WSState } from "./state";

export function typingTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return element?.tagName === "INPUT" || element?.tagName === "TEXTAREA" || element?.isContentEditable;
}

export function clearSelectionOnEscape(event: KeyboardEvent, count: number, a: WSActions) {
  if (event.key !== "Escape" || count === 0) return false;
  event.stopPropagation();
  a.clearSelection();
  return true;
}

export function isSelectAll(event: KeyboardEvent) {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a";
}

export function libraryOwnsSelection() {
  const pane = document.querySelector(".pane-library");
  return !!pane && (pane.matches(":hover") || pane.contains(document.activeElement));
}

export function handleSelectionKey(event: KeyboardEvent, count: number, a: WSActions) {
  if (typingTarget(event.target)) return;
  if (clearSelectionOnEscape(event, count, a)) return;
  if (!isSelectAll(event)) return;
  if (!libraryOwnsSelection()) return;
  event.preventDefault();
  a.selectAllVisible();
}

export function SelectionBar({ s, a }: { s: WSState; a: WSActions }) {
  const picked = a.selectedFiles();
  const n = picked.length;

  // Escape clears, ⌘A selects everything on screen. Both are capture-phase and
  // both bail when a text field has focus — ⌘A inside the filter box has to
  // keep meaning "select all this text".
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      handleSelectionKey(e, n, a);
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
export function dragIds(e: React.DragEvent): string[] {
  return e.dataTransfer
    .getData("text/plain")
    .split("\n")
    .map((id) => id.trim())
    .filter(Boolean);
}

export function BrowsePanel({
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
      {s.folders.map((folder) => (
        <FolderGroup key={folder.id} folder={folder} s={s} a={a} shownFiles={shownFiles} filterQ={filterQ} />
      ))}
    </div>
  );
}

export type RoomFolder = WSState["folders"][number];

export function FolderRenameInput({ folder, s, a }: { folder: RoomFolder; s: WSState; a: WSActions }) {
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") a.commitFolderRename();
    if (event.key === "Escape") s.setRenamingFolder(null);
  };
  return (
    <input
      className="folder-rename"
      autoFocus
      dir="auto"
      value={s.renamingFolder?.name ?? ""}
      onChange={(event) => s.setRenamingFolder({ id: folder.id, name: event.target.value })}
      onBlur={a.commitFolderRename}
      onKeyDown={onKeyDown}
    />
  );
}

export function FolderLabel({ folder, count, collapsed, s, a }: { folder: RoomFolder; count: number; collapsed: boolean; s: WSState; a: WSActions }) {
  if (s.renamingFolder?.id === folder.id) return <FolderRenameInput folder={folder} s={s} a={a} />;
  return (
    <button className="folder-label" aria-expanded={!collapsed} onClick={() => a.toggleFolderCollapse(folder.id)}>
      <span className="folder-caret" aria-hidden>{collapsed ? "▸" : "▾"}</span>
      <span className="folder-name" title={folder.name}>{folder.name}</span>
      <span className="count">{count}</span>
    </button>
  );
}

export function moveToFolder(event: React.DragEvent, folderId: string | null, s: WSState, a: WSActions) {
  event.preventDefault();
  const ids = dragIds(event);
  s.setDragOverFolder(null);
  if (ids.length) void a.moveFiles(ids, folderId);
}

export function FolderHead({ folder, files, collapsed, s, a }: { folder: RoomFolder; files: import("../api").FileMeta[]; collapsed: boolean; s: WSState; a: WSActions }) {
  const dragOver = (event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (s.dragOverFolder !== folder.id) s.setDragOverFolder(folder.id);
  };
  return (
    <div className={`folder-head${s.dragOverFolder === folder.id ? " drag-over" : ""}`} onDragOver={dragOver} onDragLeave={() => s.setDragOverFolder(null)} onDrop={(event) => moveToFolder(event, folder.id, s, a)}>
      <FolderLabel folder={folder} count={files.length} collapsed={collapsed} s={s} a={a} />
      <span className="folder-actions">
        <button className="chip-btn" title="Rename folder" aria-label="Rename folder" onClick={() => s.setRenamingFolder({ id: folder.id, name: folder.name })}>
          <PencilIcon size={14} />
        </button>
        <DeleteControl k={`folder:${folder.id}`} trigger={<TrashIcon size={14} />} onConfirm={() => a.deleteFolder(folder.id)} title="Delete folder (its files are kept, just ungrouped)" confirmDelete={s.confirmDelete} askConfirm={a.askConfirm} cancelConfirm={a.cancelConfirm} />
      </span>
    </div>
  );
}

export function FolderFiles({ collapsed, files, s, a }: { collapsed: boolean; files: import("../api").FileMeta[]; s: WSState; a: WSActions }) {
  if (collapsed) return null;
  if (files.length === 0) return <div className="folder-files"><div className="folder-empty">Empty — drag a file here, or use the folder button on a file.</div></div>;
  return <div className="folder-files">{files.map((file) => <FileRow key={file.id} f={file} s={s} a={a} />)}</div>;
}

export function FolderGroup({ folder, s, a, shownFiles, filterQ }: { folder: RoomFolder; s: WSState; a: WSActions; shownFiles: import("../api").FileMeta[]; filterQ: string }) {
  const files = shownFiles.filter((file) => file.folderId === folder.id);
  if (filterQ && files.length === 0) return null;
  const collapsed = s.collapsedFolders.has(folder.id);
  return (
    <div className="folder-group">
      <FolderHead folder={folder} files={files} collapsed={collapsed} s={s} a={a} />
      <FolderFiles collapsed={collapsed} files={files} s={s} a={a} />
    </div>
  );
}

/* ---------- AI sources: the evidence set for the next answer ---------- */

export function SourceScope({ count }: { count: number }) {
  const selected = count > 0;
  const title = selected ? `Scope: ${count} selected file${count === 1 ? "" : "s"}` : "Scope: Whole room";
  const explanation = selected
    ? "Answers draw only on the checked files — nothing else in the room. Uncheck all to search the whole room again."
    : "With nothing checked, the AI automatically pulls the most relevant passages from every file in this room. Check files below to answer from only those.";
  return (
    <div className="sources-scope" role="status">
      <span className={`scope-tag ${selected ? "selected" : "auto"}`}>{title}</span>
      <p className="area-nav-intro">{explanation}</p>
    </div>
  );
}

export function AttachedSources({ files, s, a }: { files: import("../api").FileMeta[]; s: WSState; a: WSActions }) {
  if (files.length === 0) return null;
  return <><div className="group-heading">Attached to the next question</div>{files.map((file) => <SourceRow key={file.id} f={file} s={s} a={a} checked />)}</>;
}

export function AvailableSourceEmpty({ available, shown, s }: { available: import("../api").FileMeta[]; shown: import("../api").FileMeta[]; s: WSState }) {
  if (available.length > 0 || shown.length > 0) return null;
  const message = s.files.length === 0 ? "No files yet — add one to ground the AI's answers." : `No files match “${s.fileFilter}”.`;
  return <div className="empty-hint">{message}</div>;
}

export function AvailableSources({ files, shownFiles, s, a }: { files: import("../api").FileMeta[]; shownFiles: import("../api").FileMeta[]; s: WSState; a: WSActions }) {
  return (
    <>
      <div className="group-heading">Available in this room</div>
      <AvailableSourceEmpty available={files} shown={shownFiles} s={s} />
      {files.map((file) => <SourceRow key={file.id} f={file} s={s} a={a} checked={false} />)}
    </>
  );
}

export function SourcesPanel({ s, a, shownFiles, attachedIds }: { s: WSState; a: WSActions; shownFiles: import("../api").FileMeta[]; attachedIds: Set<string> }) {
  const attached = shownFiles.filter((file) => attachedIds.has(file.id));
  const available = shownFiles.filter((file) => !attachedIds.has(file.id));
  return (
    <div className="library-scroll" role="group" aria-label="AI sources">
      <SourceScope count={s.attachments.length} />
      <AttachedSources files={attached} s={s} a={a} />
      <AvailableSources files={available} shownFiles={shownFiles} s={s} a={a} />
    </div>
  );
}
export function SourceRow({
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
