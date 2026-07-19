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
  PencilIcon,
  PlusIcon,
  ScriptIcon,
  SearchIcon,
  TrashIcon,
  WorkflowsIcon,
} from "../icons";
import { displayName } from "./composer";
import DeleteControl from "./DeleteControl";
import FileRow from "./FileRow";
import { WSState } from "./state";
import { WSActions } from "./actions";
import { WorkArea } from "./types";
import { LayoutApi } from "../shell/useLayout";

/** True for files that belong to the Recordings lens: engine-made recordings
 * plus imported audio/video (they transcribe in the background too). */
function isRecordingFile(f: import("../api").FileMeta): boolean {
  return (
    f.source === "recording" ||
    f.mimeType.startsWith("audio/") ||
    f.mimeType.startsWith("video/")
  );
}

/** A short human word for a file's type, from its metadata. */
function fileKindLabel(f: import("../api").FileMeta): string {
  if (f.source === "recording") return "recording";
  const m = f.mimeType;
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("image/")) return "image";
  if (m === "application/pdf") return "PDF";
  const lower = f.name.toLowerCase();
  if (lower.endsWith(".md")) return "note";
  if (lower.endsWith(".csv") || lower.endsWith(".xlsx")) return "sheet";
  if (lower.endsWith(".py") || lower.endsWith(".js")) return "script";
  if (lower.endsWith(".docx")) return "document";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "HTML";
  return "file";
}

const AREA_HEADINGS: Record<WorkArea, string> = {
  files: "Library",
  home: "Library",
  map: "Library",
  recordings: "Recordings",
  workflows: "Workflows",
  scripts: "Scripts",
  memory: "Memory",
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
  const shownFiles = s.files.filter(matchesFilter);
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

  const headerCount = fileArea
    ? s.files.length
    : area === "workflows"
      ? s.workflows.length
      : area === "scripts"
        ? s.scripts.length
        : area === "recordings"
          ? s.files.filter(isRecordingFile).length
          : s.memories.length;

  return (
    <>
      <div className="pane-header">
        <div className="pane-heading">{AREA_HEADINGS[area]}</div>
        <span className="count-badge">{headerCount}</span>
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

      {(fileArea || area === "recordings") && (
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
                onClick={() => s.setFileFilter("")}
              >
                <CloseIcon size={11} />
              </button>
            )}
          </label>
        </div>
      )}

      {fileArea && s.libraryTab === "browse" && (
        <BrowsePanel
          s={s}
          a={a}
          shownFiles={shownFiles}
          looseFiles={looseFiles}
          filterQ={filterQ}
        />
      )}
      {fileArea && s.libraryTab === "sources" && (
        <SourcesPanel s={s} a={a} shownFiles={shownFiles} attachedIds={attachedIds} />
      )}
      {area === "recordings" && <RecordingsNav s={s} a={a} shownFiles={shownFiles} />}
      {area === "workflows" && <WorkflowsNav s={s} a={a} />}
      {area === "scripts" && <ScriptsNav s={s} a={a} />}
      {area === "memory" && <MemoryNav s={s} a={a} />}

      {(fileArea || area === "recordings") && (
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
                  <button
                    className="pop-item"
                    role="menuitem"
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
                        Import a page or a YouTube transcript/video
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

/* ---------- Browse: the real folder tree ---------- */

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
        const id = e.dataTransfer.getData("text/plain");
        s.setDragOverFolder(null);
        if (id) a.moveFile(id, null);
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
      <p className="area-nav-intro">
        Checked files are attached to your next question.{" "}
        {s.attachments.length === 0
          ? "With none checked, the AI searches the whole room for relevant passages."
          : `Answers will draw on ${s.attachments.length} attached source${s.attachments.length === 1 ? "" : "s"}.`}
      </p>
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
        aria-label={`Use ${displayName(f.name)} in AI answers`}
        onChange={() => a.toggleAttach(f)}
      />
      <button
        className="source-open"
        type="button"
        onClick={() => void a.viewFile(f.id)}
        title={`Open ${f.name}`}
      >
        <div className="source-line">
          <span className="source-name">{displayName(f.name)}</span>
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
  return (
    <div className="library-scroll">
      <p className="area-nav-intro">
        Repeatable pipelines over this room's files — run them now or on a
        schedule.
      </p>
      <button className="area-nav-row" onClick={() => void a.createBlankWorkflow()}>
        <span className="browse-icon">
          <PlusIcon size={15} />
        </span>
        <span className="area-nav-main">
          <span className="area-nav-title">New workflow</span>
          <span className="area-nav-copy">Start blank or pick a template</span>
        </span>
      </button>
      <div className="group-heading">In this room</div>
      {s.workflows.length === 0 && (
        <div className="empty-hint">
          No workflows yet — create one, or start from a template in the
          center pane.
        </div>
      )}
      {s.workflows.map((w) => (
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
