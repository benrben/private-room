import { api, RoomInfo } from "../api";
import {
  CloseIcon,
  DownloadIcon,
  FolderIcon,
  GraphIcon,
  LinkIcon,
  MemoryIcon,
  MicIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SparkIcon,
  TrashIcon,
} from "../icons";
import { displayName } from "./composer";
import DeleteControl from "./DeleteControl";
import FileRow from "./FileRow";
import { WSState } from "./state";
import { WSActions } from "./actions";

/** Pane 1: file explorer + folders + client filter + Summarize/Memory chips +
 * the Memory panel. Extracted verbatim from the pane-1 block. */
export default function Sidebar({
  s,
  a,
  info,
}: {
  s: WSState;
  a: WSActions;
  info: RoomInfo;
}) {
  const filterQ = s.fileFilter.trim().toLowerCase();
  const matchesFilter = (f: import("../api").FileMeta) =>
    !filterQ ||
    f.name.toLowerCase().includes(filterQ) ||
    displayName(f.name).toLowerCase().includes(filterQ);
  const shownFiles = s.files.filter(matchesFilter);
  const looseFiles = shownFiles.filter((f) => f.folderId === null);
  return (
    <aside className="sidebar" style={{ width: s.sidebarW }}>
      <div
        className={`side-head${s.dragOverFolder === "__root__" ? " drag-over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (s.dragOverFolder !== "__root__") s.setDragOverFolder("__root__");
        }}
        onDragLeave={() => s.setDragOverFolder(null)}
        onDrop={(e) => {
          e.preventDefault();
          const id = e.dataTransfer.getData("text/plain");
          s.setDragOverFolder(null);
          if (id) a.moveFile(id, null);
        }}
      >
        <span>Files</span>
        <span className="side-head-actions">
          {s.files.length > 0 && (
            <button
              className={`add-btn${s.showMap ? " active" : ""}`}
              title={
                s.showMap
                  ? "Back to the file list"
                  : "Map — see how these files relate"
              }
              onClick={() => s.setShowMap((m) => !m)}
            >
              <GraphIcon size={14} /> Map
            </button>
          )}
          <div className="add-menu-wrap">
            <button
              className="add-btn"
              title="Add something to this room"
              onClick={() => s.setAddMenuOpen((o) => !o)}
            >
              <PlusIcon size={14} /> Add
            </button>
            {s.addMenuOpen && (
              <>
                <div
                  className="menu-backdrop"
                  onMouseDown={() => s.setAddMenuOpen(false)}
                />
                <div className="pop-menu add-menu">
                  <button
                    className="pop-item"
                    onClick={() => {
                      a.importFiles();
                      s.setAddMenuOpen(false);
                    }}
                  >
                    <DownloadIcon size={14} /> File
                  </button>
                  <button
                    className="pop-item"
                    onClick={() => {
                      a.startCreateFolder();
                      s.setAddMenuOpen(false);
                    }}
                  >
                    <FolderIcon size={14} /> Folder
                  </button>
                  <button
                    className="pop-item"
                    onClick={() => {
                      s.setLinkUrl("");
                      s.setShowAddLink(true);
                      s.setAddMenuOpen(false);
                    }}
                  >
                    <LinkIcon size={14} /> Web link
                  </button>
                  <button
                    className="pop-item"
                    disabled={a.micState("note").disabled}
                    onClick={() => {
                      a.recordVoiceNote();
                      s.setAddMenuOpen(false);
                    }}
                  >
                    <MicIcon size={14} /> Voice note
                  </button>
                  <button
                    className="pop-item"
                    disabled={a.micState("journal").disabled}
                    onClick={() => {
                      a.dictateJournal();
                      s.setAddMenuOpen(false);
                    }}
                  >
                    <MicIcon size={14} /> Journal entry
                  </button>
                </div>
              </>
            )}
          </div>
        </span>
      </div>
      <div className="side-search">
        <SearchIcon size={14} />
        <input
          className="side-search-input"
          placeholder="Search files…"
          value={s.fileFilter}
          onChange={(e) => s.setFileFilter(e.target.value)}
        />
        {s.fileFilter && (
          <button
            className="side-search-clear"
            title="Clear"
            onClick={() => s.setFileFilter("")}
          >
            <CloseIcon size={12} />
          </button>
        )}
      </div>
      <button
        className="summarize-btn"
        title="Write a short overview of this room and what's inside"
        disabled={s.summarizing}
        onClick={a.summarizeRoom}
      >
        {s.summarizing ? (
          s.summarizeProgress || "Summarizing…"
        ) : (
          <>
            <SparkIcon size={14} /> Summarize room
          </>
        )}
      </button>
      <button
        className={`memory-chip${s.showMemoryIntro ? " glow" : ""}`}
        title="What the AI remembers about you — visible and editable"
        onClick={a.revealMemory}
      >
        <span className="memory-chip-label">
          <MemoryIcon size={14} /> Memory
        </span>
        <span className="count">{s.memories.length}</span>
      </button>
      {s.showMemoryIntro && (
        <div className="memory-intro">
          This is your room's memory — everything the AI remembers about
          you, visible and editable any time.
          <button
            className="memory-intro-dismiss"
            onClick={() => {
              s.setShowMemoryIntro(false);
              try {
                localStorage.setItem(`memoryIntroSeen:${info.name}`, "1");
              } catch {
                /* non-fatal */
              }
            }}
          >
            Got it
          </button>
        </div>
      )}
      <div className="file-list">
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
                  const id = e.dataTransfer.getData("text/plain");
                  s.setDragOverFolder(null);
                  if (id) a.moveFile(id, folder.id);
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

      <div
        ref={s.memoryHeadRef}
        className="side-head clickable"
        onClick={() => s.setShowMemory(!s.showMemory)}
      >
        <span>
          Memory <span className="count">{s.memories.length}</span>
        </span>
        <span>{s.showMemory ? "▾" : "▸"}</span>
      </div>
      {s.showMemory && (
        <div className="memory-panel">
          {s.memories.map((m) =>
            s.editingMemory?.id === m.id ? (
              <div key={m.id} className="memory-row editing">
                <input
                  className="memory-edit-input"
                  autoFocus
                  dir="auto"
                  value={s.editingMemory.content}
                  onChange={(e) =>
                    s.setEditingMemory({ id: m.id, content: e.target.value })
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") a.saveMemoryEdit();
                    if (e.key === "Escape") s.setEditingMemory(null);
                  }}
                />
                <button
                  className="chip-btn"
                  title="Save"
                  onClick={a.saveMemoryEdit}
                >
                  ✓
                </button>
                <button
                  className="chip-btn"
                  title="Cancel"
                  onClick={() => s.setEditingMemory(null)}
                >
                  ✕
                </button>
              </div>
            ) : (
              <div key={m.id} className="memory-row">
                <span dir="auto">{m.content}</span>
                <span className="memory-actions">
                  <button
                    className="chip-btn"
                    title="Edit this memory"
                    onClick={() =>
                      s.setEditingMemory({ id: m.id, content: m.content })
                    }
                  >
                    <PencilIcon size={13} />
                  </button>
                  <DeleteControl
                    k={`mem:${m.id}`}
                    trigger="×"
                    onConfirm={async () => {
                      await api.deleteMemory(m.id);
                      s.setMemories(await api.listMemories());
                    }}
                    title="Forget this"
                    confirmDelete={s.confirmDelete}
                    askConfirm={a.askConfirm}
                    cancelConfirm={a.cancelConfirm}
                  />
                </span>
              </div>
            ),
          )}
          <div className="memory-add">
            <input
              placeholder="Something the AI should always remember…"
              value={s.memoryDraft}
              dir="auto"
              onChange={(e) => s.setMemoryDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && a.addMemory()}
            />
            <button
              className={`subtle btn-ic mic-btn ${a.micState("memory").cls}`}
              title={
                s.dictOwner === "memory" && s.dictState === "recording"
                  ? "Stop recording"
                  : "Speak a memory"
              }
              disabled={a.micState("memory").disabled}
              onClick={() =>
                a.dictateTo("memory", (text) =>
                  s.setMemoryDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text)),
                )
              }
            >
              <MicIcon size={12} />
            </button>
            <button className="subtle" onClick={a.addMemory}>
              Add
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
