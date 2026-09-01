import { useState } from "react";
import { BookOpenIcon, CreateIcon, FolderIcon, MemoryIcon, PencilIcon, SearchIcon } from "../icons";
import { fileKindLabel } from "../api";
import type { WSActions } from "./actions";
import { displayName } from "./composer";
import { libraryStatus } from "./fileVisibility";
import type { WSState } from "./state";
import { isCreationFile } from "./types";

export type CreationLens = "all" | "image" | "video";
export type CreationJob = WSState["jobs"][number];

export function creationOutputs(files: WSState["files"], lens: CreationLens) {
  return files.filter(isCreationFile).filter((file) => {
    if (lens === "all") return true;
    const video = file.mimeType.startsWith("video/");
    return lens === "video" ? video : !video;
  });
}

export function creationLensLabel(lens: CreationLens) {
  return { all: "All", image: "Images", video: "Video" }[lens];
}

export function CreationFilters({ visible, lens, setLens }: { visible: boolean; lens: CreationLens; setLens: (lens: CreationLens) => void }) {
  if (!visible) return null;
  return (
    <div className="pane-tabs" role="tablist" aria-label="Filter creations">
      {(["all", "image", "video"] as const).map((item) => <button key={item} className="pane-tab" role="tab" aria-selected={lens === item} onClick={() => setLens(item)}>{creationLensLabel(item)}</button>)}
    </div>
  );
}

export function CreationRunningRow({ job, progress }: { job: CreationJob; progress: WSState["jobProgress"][string] | undefined }) {
  const label = progress?.label ?? (job.status === "queued" ? "Queued" : "Working…");
  return (
    <div className="area-nav-row is-static">
      <span className="browse-icon"><CreateIcon size={14} /></span>
      <span className="area-nav-main"><span className="area-nav-title">{job.title}</span><span className="area-nav-copy">{label}</span></span>
    </div>
  );
}

export function RunningCreations({ jobs, progress }: { jobs: CreationJob[]; progress: WSState["jobProgress"] }) {
  if (jobs.length === 0) return null;
  return <><div className="group-heading">Making now</div>{jobs.map((job) => <CreationRunningRow key={job.id} job={job} progress={progress[job.id]} />)}</>;
}

export function FailedCreations({ jobs }: { jobs: CreationJob[] }) {
  if (jobs.length === 0) return null;
  return (
    <><div className="group-heading">Didn’t finish</div>{jobs.map((job) => (
      <div key={job.id} className="area-nav-row is-static" title={job.error ?? undefined}>
        <span className="browse-icon"><CreateIcon size={14} /></span>
        <span className="area-nav-main"><span className="area-nav-title">{job.title}</span><span className="area-nav-copy">{job.error ?? "Failed"}</span></span>
      </div>
    ))}</>
  );
}

export function CreationOutputRow({ file, s, a }: { file: import("../api").FileMeta; s: WSState; a: WSActions }) {
  const linked = libraryStatus(file)?.linked;
  return (
    <button className={`area-nav-row${s.openFile?.id === file.id ? " is-current" : ""}`} onClick={() => void a.viewFile(file.id)} title={`Open ${file.name}`}>
      <span className="browse-icon"><CreateIcon size={14} /></span>
      <span className="area-nav-main"><span className="area-nav-title">{displayName(file.name)}</span><span className="area-nav-copy">{fileKindLabel(file)}</span></span>
      {linked && <span className="area-nav-state">In Library</span>}
    </button>
  );
}

export function CreationOutputs({ files, s, a }: { files: import("../api").FileMeta[]; s: WSState; a: WSActions }) {
  if (files.length === 0) return null;
  return <><div className="group-heading">Made in this room</div>{files.map((file) => <CreationOutputRow key={file.id} file={file} s={s} a={a} />)}</>;
}

export function CreationsNav({ s, a }: { s: WSState; a: WSActions }) {
  const [lens, setLens] = useState<CreationLens>("all");
  const jobs = s.jobs.filter((job) => job.kind === "create");
  const running = jobs.filter((job) => job.status === "running" || job.status === "queued");
  const failed = jobs.filter((job) => job.status === "error");
  const allOutputs = s.files.filter(isCreationFile);
  const outputs = creationOutputs(s.files, lens);
  const empty = running.length === 0 && failed.length === 0 && allOutputs.length === 0;
  return (
    <div className="library-scroll">
      <CreationFilters visible={!empty} lens={lens} setLens={setLens} />
      {empty && <div className="empty-hint">Nothing made yet. Describe a picture or a clip in the composer and press Create — results land here, and stay in this room.</div>}
      <RunningCreations jobs={running} progress={s.jobProgress} />
      <FailedCreations jobs={failed} />
      <CreationOutputs files={outputs} s={s} a={a} />
    </div>
  );
}

/* ---------- Room Map */

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
export function MapNav({ s, a }: { s: WSState; a: WSActions }) {
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

export function ConnectorsNav({ s }: { s: WSState }) {
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
      {s.mcpStatuses.map((connector) => <ConnectorRow key={connector.name} connector={connector} />)}
    </div>
  );
}

export type Connector = WSState["mcpStatuses"][number];

export function connectorSummary(connector: Connector) {
  if (connector.status === "connected") return `${connector.tools.length} tool${connector.tools.length === 1 ? "" : "s"}`;
  if (connector.status === "disabled") return "Off";
  if (connector.status === "connecting") return "Connecting…";
  return connector.error ?? "Failed";
}

export function ConnectorRow({ connector }: { connector: Connector }) {
  return (
    <div className="area-nav-row" title={connector.name}>
      <span className="browse-icon"><span className={`mcp-dot ${connector.status}`} /></span>
      <span className="area-nav-main"><span className="area-nav-title">{connector.name}</span><span className="area-nav-copy">{connectorSummary(connector)}</span></span>
      <span className="area-nav-state">{connector.remote ? "Remote" : "Local"}</span>
    </div>
  );
}

/* ---------- Memory lens ---------- */

export function MemoryNav({ s, a }: { s: WSState; a: WSActions }) {
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
