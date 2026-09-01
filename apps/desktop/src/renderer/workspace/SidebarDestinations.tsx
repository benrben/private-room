import { useState } from "react";
import { BookOpenIcon, CloseIcon, GlobeIcon, MicIcon, PencilIcon, PlusIcon, ScriptIcon, TrashIcon, WorkflowsIcon } from "../icons";
import { isRecordingFile } from "../api";
import type { WSActions } from "./actions";
import { pageAccessibleName, pageLabel, pageSubtitle, type BrowserPagesApi } from "./browserPages";
import type { NewItemKind } from "./destinations";
import DeleteControl from "./DeleteControl";
import { displayName } from "./composer";
import FileRow from "./FileRow";
import { libraryStatus } from "./fileVisibility";
import { sortFiles } from "./fileSort";
import type { WSState } from "./state";
import { isSketchFile } from "./types";
import { visibleWorkflows } from "./workflows/selectors";

export function RecordingsNav({ s, a }: { s: WSState; a: WSActions }) {
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

export function WorkflowsNav({ s, a }: { s: WSState; a: WSActions }) {
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
      {workflows.map((workflow) => <WorkflowRow key={workflow.id} workflow={workflow} s={s} a={a} />)}
    </div>
  );
}

export type RoomWorkflow = WSState["workflows"][number];

export function WorkflowGlyph({ workflow }: { workflow: RoomWorkflow }) {
  if (workflow.emoji) return <span aria-hidden>{workflow.emoji}</span>;
  return <WorkflowsIcon size={14} />;
}

export function workflowCopy(workflow: RoomWorkflow) {
  const status = workflow.status === "active" ? "Active" : "Draft";
  const pinned = workflow.pinned ? " · Pinned" : "";
  const creator = workflow.createdBy === "user" ? "" : ` · by ${workflow.createdBy}`;
  return `${status}${pinned}${creator}`;
}

export function WorkflowRow({ workflow, s, a }: { workflow: RoomWorkflow; s: WSState; a: WSActions }) {
  return (
    <button className={`area-nav-row${s.wfDetailId === workflow.id ? " is-current" : ""}`} onClick={() => a.openWorkflowDetail(workflow.id)}>
      <span className="browse-icon"><WorkflowGlyph workflow={workflow} /></span>
      <span className="area-nav-main"><span className="area-nav-title">{workflow.name}</span><span className="area-nav-copy">{workflowCopy(workflow)}</span></span>
      <span className="area-nav-state">{workflow.binding.scope === "general" ? "" : "File"}</span>
    </button>
  );
}

/* ---------- Scripts lens ---------- */

export function ScriptsNav({ s, a }: { s: WSState; a: WSActions }) {
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

export function SkillsNav({ s, a }: { s: WSState; a: WSActions }) {
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
export type BrowserPage = BrowserPagesApi["pages"][number];

export function pageDirection(key: string) {
  return ({ ArrowDown: 1, ArrowUp: -1 } as Record<string, number | undefined>)[key];
}

export function isPageActivation(key: string) {
  return key === "Enter" || key === " ";
}

export function isPageCloseKey(key: string) {
  return key === "Backspace" || key === "Delete";
}

export function handlePageKey(event: React.KeyboardEvent<HTMLDivElement>, index: number, page: BrowserPage, pages: BrowserPagesApi) {
  if (isPageActivation(event.key)) {
    event.preventDefault();
    pages.select(page.id);
    return;
  }
  if (isPageCloseKey(event.key)) {
    event.preventDefault();
    pages.close(page.id);
    return;
  }
  const direction = pageDirection(event.key);
  if (!direction) return;
  event.preventDefault();
  const target = (index + direction + pages.pages.length) % pages.pages.length;
  pages.select(pages.pages[target].id);
  (event.currentTarget.parentElement?.children[target] as HTMLElement)?.focus();
}

export function handlePageDragOver(event: React.DragEvent<HTMLDivElement>, index: number, dragging: string, pages: BrowserPagesApi) {
  event.preventDefault();
  const from = pages.pages.findIndex((page) => page.id === dragging);
  if (from >= 0 && from !== index) pages.move(from, index);
}

export function PageSubtitle({ page }: { page: BrowserPage }) {
  const subtitle = pageSubtitle(page);
  if (!subtitle) return null;
  return <span className="area-nav-copy" aria-hidden>{subtitle}</span>;
}

export function PageRow({ page, index, pages, dragging, setDragging }: { page: BrowserPage; index: number; pages: BrowserPagesApi; dragging: string; setDragging: (id: string) => void }) {
  const current = page.id === pages.activeId;
  return (
    <div
      role="tab"
      aria-selected={current}
      tabIndex={current ? 0 : -1}
      className={`area-nav-row page-row${current ? " is-current" : ""}${dragging === page.id ? " is-dragging" : ""}`}
      draggable
      onDragStart={() => setDragging(page.id)}
      onDragEnd={() => setDragging("")}
      onDragOver={(event) => handlePageDragOver(event, index, dragging, pages)}
      onClick={() => pages.select(page.id)}
      onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); pages.close(page.id); } }}
      onKeyDown={(event) => handlePageKey(event, index, page, pages)}
    >
      <span className="browse-icon"><GlobeIcon size={14} /></span>
      <span className="area-nav-main">
        <span className="area-nav-title" aria-hidden>{pageLabel(page)}</span>
        <span className="sr-only">{pageAccessibleName(page)}</span>
        <PageSubtitle page={page} />
      </span>
      <button className="page-close" aria-label={`Close ${pageAccessibleName(page)}`} title="Close this page" onClick={(event) => { event.stopPropagation(); pages.close(page.id); }}>
        <CloseIcon size={12} />
      </button>
    </div>
  );
}

export function EmptyPages({ onNewItem }: { onNewItem: (kind: NewItemKind) => void }) {
  return (
    <div className="library-scroll">
      <div className="empty-hint">No pages open. This browser keeps no history, cookies or cache between sessions.</div>
      <button className="area-nav-row" onClick={() => onNewItem("page")}>
        <span className="browse-icon"><PlusIcon size={14} /></span>
        <span className="area-nav-main"><span className="area-nav-title">New page</span><span className="area-nav-copy">Search the web, or open an address</span></span>
      </button>
    </div>
  );
}

export function PagesNav({ pages, onNewItem }: { pages: BrowserPagesApi; onNewItem: (kind: NewItemKind) => void }) {
  const [dragging, setDragging] = useState("");
  if (pages.pages.length === 0) return <EmptyPages onNewItem={onNewItem} />;
  return (
    <div className="library-scroll" role="tablist" aria-label="Open private pages" aria-orientation="vertical">
      {pages.pages.map((page, index) => <PageRow key={page.id} page={page} index={index} pages={pages} dragging={dragging} setDragging={setDragging} />)}
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
export function sketchWhen(iso: string): string {
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

export function SketchesNav({
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
