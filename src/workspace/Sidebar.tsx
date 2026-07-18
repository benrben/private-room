import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { api, RoomInfo } from "../api";
import {
  CloseIcon,
  DownloadIcon,
  FolderIcon,
  GraphIcon,
  WorkflowsIcon,
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

/** Wave 1b (idea 5): fixed display order for the memory groups; null = the
 * uncategorized bucket every legacy memory lives in. */
const MEMORY_GROUPS: { key: string | null; label: string }[] = [
  { key: "instruction", label: "Instructions" },
  { key: "preference", label: "Preferences" },
  { key: "project", label: "Projects" },
  { key: "fact", label: "Facts" },
  { key: null, label: "Other" },
];
const CATEGORY_OPTIONS = ["preference", "fact", "project", "instruction"];

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

  // A once-a-second tick so the running job card's elapsed time advances. Only
  // armed while something is actually running, so an idle sidebar never re-renders.
  const jobActive =
    s.summaryStarting ||
    s.recLive?.status === "saving" ||
    s.jobs.some((j) => j.status === "running" || j.status === "queued");
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!jobActive) return;
    const t = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [jobActive]);
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
  const elapsedOf = useMemo(
    () => (createdAt: string) => {
      const start = Date.parse(createdAt);
      if (Number.isNaN(start)) return "";
      const s2 = Math.max(0, Math.round((nowTick - start) / 1000));
      const m = Math.floor(s2 / 60);
      return `${m}:${String(s2 % 60).padStart(2, "0")}`;
    },
    [nowTick],
  );
  return (
    <aside className="sidebar" aria-label="Files" style={{ width: s.sidebarW }}>
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
          {/* Wave 4a: the flagship Workflows entry, beside Map. */}
          <button
            className={`add-btn${s.showWorkflows ? " active" : ""}`}
            title="Workflows — automate multi-step pipelines"
            onClick={() =>
              s.showWorkflows ? a.closeWorkflows() : a.openWorkflows()
            }
          >
            <WorkflowsIcon size={14} /> Workflows
          </button>
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
                  {/* ADD-27: a Recording file — live transcript while you
                   * (or your meeting) speak. The three mic entries each say
                   * what pressing them captures and saves — starting the
                   * microphone must never be a surprise. */}
                  <button
                    className="pop-item"
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
        </span>
      </div>
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
      {(() => {
        const jobRunning = s.jobs.some(
          (j) => j.status === "running" || j.status === "queued",
        );
        const busy = s.summaryStarting || jobRunning;
        return (
          <button
            className="summarize-btn"
            title="Write a short overview of this room and what's inside — runs in the background"
            disabled={busy}
            onClick={() => void a.startDeepSummary()}
          >
            {s.summaryStarting && !jobRunning ? (
              "Starting…"
            ) : (
              <>
                <SparkIcon size={14} /> Summarize room
              </>
            )}
          </button>
        );
      })()}
      {/* Optimistic "Starting…" card the instant the button is pressed, before
          the backend resolves — a cold local model can take seconds to answer,
          and a click must never look like nothing happened. */}
      {s.summaryStarting &&
        !s.jobs.some((j) => j.status === "running" || j.status === "queued") && (
          <div className="job-card running" role="status">
            <div className="job-card-head">
              <span className="job-card-title">Room summary</span>
            </div>
            <div className="job-card-bar">
              <div className="job-card-fill indeterminate" />
            </div>
            <div className="job-card-foot">
              <span className="job-card-label">Starting…</span>
            </div>
          </div>
        )}
      {/* A recording being finalized keeps a visible card here, so leaving
          the recording view never turns the save into a mystery. The audio
          is already durable when this card appears — the label says so. */}
      {s.recLive?.status === "saving" && (
        <div className="job-card running" role="status">
          <div className="job-card-head">
            <span className="job-card-title">Saving recording</span>
            {s.recSave && (
              <span className="job-card-elapsed">{elapsedOf(s.recSave.startedAt)}</span>
            )}
          </div>
          <div className="job-card-bar">
            <div className="job-card-fill indeterminate" />
          </div>
          <div className="job-card-foot">
            <span className="job-card-label">
              {s.recSave?.stage === "writing"
                ? "Audio saved — writing into the room…"
                : s.recSave && s.recSave.remaining > 0
                  ? `Audio saved — transcribing (${s.recSave.remaining} to go)`
                  : "Audio saved — finishing the transcript…"}
            </span>
            <button
              className="job-card-resume"
              title="Open the recording"
              onClick={() => {
                const id = s.recLive?.fileId;
                if (id) void a.viewFile(id);
              }}
            >
              Open
            </button>
          </div>
        </div>
      )}
      {/* ADD-30: background-job cards — live progress while running, Resume
          for a job that was paused or parked by an error. */}
      {s.jobs.map((j) => {
        const live = s.jobProgress[j.id];
        // Wave 4a: a QUEUED job is waiting for the single heavy-work slot — it is
        // not actually running yet, so it shows "Waiting — Nth in line" with a
        // "Remove" affordance (Stop on it is a no-op; cancel_job parks the row).
        const queued = j.status === "queued";
        const running = j.status === "running" || queued;
        const queuePos = queued
          ? s.jobs.filter((o) => o.status === "queued" && o.createdAt <= j.createdAt).length
          : 0;
        const done = live?.done ?? j.cursor;
        const total = Math.max(live?.total ?? j.total, 1);
        const friendlyError =
          j.error === "OLLAMA_DOWN"
            ? "The local AI isn't running."
            : j.error?.startsWith("MODEL_MISSING")
              ? "The AI model isn't installed."
              : j.error;
        return (
          <div key={j.id} className={`job-card ${j.status}`} role="status">
            <div className="job-card-head">
              <span className="job-card-title">{j.title}</span>
              {running ? (
                <span className="job-card-elapsed">{elapsedOf(j.createdAt)}</span>
              ) : (
                <button
                  className="chip-btn"
                  title="Dismiss this job"
                  onClick={() => void a.dismissJob(j.id)}
                >
                  <CloseIcon size={11} />
                </button>
              )}
            </div>
            {/* ADD-32: the pass mosaic — one cell per stretch of the file,
                lighting up in spectral order as each part is read, so you can
                watch the whole file being consumed window by window. */}
            {j.kind === "file_pass" &&
              (() => {
                const plan = (j.plan ?? {}) as { windows?: unknown[] };
                const nWin = Array.isArray(plan.windows) ? plan.windows.length : 0;
                if (nWin < 2) return null;
                const cells = Math.min(nWin, 192);
                const mapsDone = Math.min(done, nWin);
                const cellsDone = Math.floor((mapsDone * cells) / nWin);
                const weaving = running && done >= nWin;
                return (
                  <div
                    className={`pass-mosaic${weaving ? " weaving" : ""}`}
                    title={`${mapsDone} of ${nWin} parts read`}
                  >
                    {Array.from({ length: cells }, (_, c) => (
                      <span
                        key={c}
                        className={`pass-cell${c < cellsDone ? " on" : ""}${
                          c === cellsDone && running && !weaving ? " now" : ""
                        }`}
                        style={{ "--h": Math.round((c * 300) / cells) } as CSSProperties}
                      />
                    ))}
                  </div>
                );
              })()}
            <div className="job-card-bar">
              <div
                className={`job-card-fill${running && !live ? " indeterminate" : ""}`}
                style={
                  running && !live
                    ? undefined
                    : { width: `${Math.min(100, Math.round((done / total) * 100))}%` }
                }
              />
            </div>
            <div className="job-card-foot">
              <span className="job-card-label">
                {queued
                  ? `Waiting — ${queuePos}${queuePos === 1 ? "st" : queuePos === 2 ? "nd" : queuePos === 3 ? "rd" : "th"} in line`
                  : running
                    ? (live?.label ?? "Working…")
                    : j.status === "error"
                      ? (friendlyError ?? "Stopped.")
                      : `Paused at ${done} of ${total}`}
              </span>
              {queued ? (
                <button
                  className="job-card-resume"
                  title="Remove this job from the queue"
                  onClick={() => void a.pauseJob(j.id)}
                >
                  Remove
                </button>
              ) : running ? (
                <button
                  className="job-card-resume"
                  title="Stop — it checkpoints so you can resume later"
                  onClick={() => void a.pauseJob(j.id)}
                >
                  Stop
                </button>
              ) : (
                <button
                  className="job-card-resume"
                  onClick={() => void a.resumeJob(j.id)}
                >
                  {j.status === "error" ? "Retry" : "Resume"}
                </button>
              )}
            </div>
          </div>
        );
      })}
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
      {/* Wave 1b (idea 10): the canonical shared working-notes file. Always
          opens exactly ONE pad (get-or-create on the backend). */}
      <button
        className="memory-chip"
        title='Shared working notes — you and the AI both write "Scratch pad.md"'
        onClick={() => void a.openScratchPad()}
      >
        <span className="memory-chip-label">
          <PencilIcon size={14} /> Scratch pad
        </span>
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
          {/* Wave 1b (idea 5): grouped under small category headers (fixed
              order, empty groups hidden). When nothing is categorized the
              panel keeps its legacy flat look — no lone "Other" header. */}
          {MEMORY_GROUPS.filter((g) =>
            s.memories.some((m) => (m.category ?? null) === g.key),
          ).map((g, _, shown) => (
            <div key={g.key ?? "other"} className="memory-group">
              {!(shown.length === 1 && g.key === null) && (
                <div className="memory-group-head">{g.label}</div>
              )}
              {s.memories
                .filter((m) => (m.category ?? null) === g.key)
                .map((m) =>
                  s.editingMemory?.id === m.id ? (
                    <div key={m.id} className="memory-row editing">
                      <input
                        className="memory-edit-input"
                        autoFocus
                        dir="auto"
                        value={s.editingMemory.content}
                        onChange={(e) =>
                          s.setEditingMemory({
                            id: m.id,
                            content: e.target.value,
                            category: s.editingMemory?.category ?? null,
                          })
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") a.saveMemoryEdit();
                          if (e.key === "Escape") s.setEditingMemory(null);
                        }}
                      />
                      <select
                        className="memory-cat-select"
                        title="Category"
                        value={s.editingMemory.category ?? ""}
                        onChange={(e) =>
                          s.setEditingMemory({
                            id: m.id,
                            content: s.editingMemory?.content ?? m.content,
                            category: e.target.value || null,
                          })
                        }
                      >
                        <option value="">no category</option>
                        {CATEGORY_OPTIONS.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
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
                      <span dir="auto">
                        {m.content}
                        {m.category && (
                          <span className="memory-cat-pill">{m.category}</span>
                        )}
                      </span>
                      <span className="memory-actions">
                        <button
                          className="chip-btn"
                          title="Edit this memory"
                          onClick={() =>
                            s.setEditingMemory({
                              id: m.id,
                              content: m.content,
                              category: m.category ?? null,
                            })
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
            </div>
          ))}
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
            <select
              className="memory-cat-select"
              title="Category for the new memory"
              value={s.memoryDraftCat}
              onChange={(e) => s.setMemoryDraftCat(e.target.value)}
            >
              <option value="">no category</option>
              {CATEGORY_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <button className="subtle" onClick={a.addMemory}>
              Add
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
