import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { jobMeter } from "./jobProgress";
import {
  RoomInfo,
} from "../api";
import {
  ActivityIcon,
  ChatBubbleIcon,
  CloseIcon,
  CloudIcon,
  CollapseRightIcon,
  FocusIcon,
  SparkIcon,
} from "../icons";
import { isCloudRoute, trustState } from "./markup";
import {
  BrowserScope,
  OpenPage,
  OpenSketch,
  ROOM_ONLY,
  chatScope,
  readablePage,
  scopeLabel,
} from "./browserScope";
import { browserPageSnapshot, subscribeBrowserPage } from "./browserSignal";
import { currentSketchFocus, subscribeSketchFocus } from "./sketchFocus";
import { setTurnScope } from "./chatActions";
import { displayName } from "./composer";
import ChatPane from "./ChatPane";
import StudioShelf from "./StudioShelf";
import PodcastPanel from "./PodcastPanel";
import { WSState } from "./state";
import { WSActions } from "./actions";
import { WorkArea } from "./types";
import { LayoutApi } from "../shell/useLayout";
import {
  groupActivity,
  HISTORY_LIMIT,
  pendingApprovalCount,
  runningJobCount,
} from "../shell/activity";
import {
  groupHistoryRuns,
  HarnessRunner,
  HistoryEntry,
  StateTape,
} from "./aiActivityRows";

export { groupHistoryRuns } from "./aiActivityRows";

const STEP_KINDS: readonly string[] = ["studio", "podcast_audio"];

/** Not a scope. The last option in the scope select opens the sources list
 * rather than changing what the turn reads — see the strip below for why it
 * lives inside the same control. */
const PICK_FILES = "__pick_files";

/** The tab order the strip renders, and the order the arrow keys walk. */
const AI_TABS = ["chat", "studio", "activity"] as const;

/** Pane 3: persistent Chat / Studio / Activity tabs. Chat keeps the entire
 * existing conversation surface; Studio hosts the room's transformations;
 * Activity centralizes background jobs, imports, saves, and approvals. */
type AiPaneProps = {
  s: WSState;
  a: WSActions;
  info: RoomInfo;
  layout: LayoutApi;
  area: WorkArea;
};

function activityTabLabel(pendingApprovals: number, jobsRunning: number) {
  if (pendingApprovals > 0) return "Activity — something needs your approval";
  if (jobsRunning > 0) return "Activity — background work is running";
  return "Activity";
}

function activityBadge(pendingApprovals: number, jobsRunning: number) {
  if (pendingApprovals > 0) return <span className="nb-circled nb-sem-pending ap-tab-count" aria-hidden="true" title="Something needs your approval">{pendingApprovals}</span>;
  if (jobsRunning > 0) return <span className="ap-tab-live" aria-hidden="true" title="Background work is running" />;
  return null;
}

function tabDestination(key: string, current: number) {
  if (key === "ArrowLeft") return (current + AI_TABS.length - 1) % AI_TABS.length;
  if (key === "ArrowRight") return (current + 1) % AI_TABS.length;
  if (key === "Home") return 0;
  if (key === "End") return AI_TABS.length - 1;
  return -1;
}

function AiTabButton({ tab, active, setTab, children, label }: {
  tab: typeof AI_TABS[number];
  active: typeof AI_TABS[number];
  setTab: WSState["setAiTab"];
  children: React.ReactNode;
  label: string;
}) {
  return (
    <button id={`ai-tab-${tab}`} className="assistant-tab" role="tab" aria-selected={active === tab} tabIndex={active === tab ? 0 : -1} aria-label={label} data-tip={tab[0].toUpperCase() + tab.slice(1)} onClick={() => setTab(tab)}>
      {children}
    </button>
  );
}

function AiTabs({ s, layout, pendingApprovals, jobsRunning }: Pick<AiPaneProps, "s" | "layout"> & { pendingApprovals: number; jobsRunning: number }) {
  const onTabKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const from = AI_TABS.indexOf(s.aiTab);
    if (from < 0 || !(event.target as HTMLElement).closest(".assistant-tab")) return;
    const to = tabDestination(event.key, from);
    if (to < 0) return;
    event.preventDefault();
    s.setAiTab(AI_TABS[to]);
    document.getElementById(`ai-tab-${AI_TABS[to]}`)?.focus();
  };
  return (
    <div className="assistant-header" role="tablist" aria-label="AI tools" onKeyDown={onTabKey}>
      <AiTabButton tab="chat" active={s.aiTab} setTab={s.setAiTab} label="Chat"><ChatBubbleIcon size={14} /><span>Chat</span></AiTabButton>
      <AiTabButton tab="studio" active={s.aiTab} setTab={s.setAiTab} label="Studio"><SparkIcon size={14} /><span>Studio</span></AiTabButton>
      <AiTabButton tab="activity" active={s.aiTab} setTab={s.setAiTab} label={activityTabLabel(pendingApprovals, jobsRunning)}><ActivityIcon size={14} /><span>Activity</span>{activityBadge(pendingApprovals, jobsRunning)}</AiTabButton>
      <div className="pane-actions">
        <button className="pane-icon-btn" data-tip="Focus this pane" aria-label="Give the AI pane the full width" onClick={() => layout.toggleFocus("ai")}><FocusIcon size={14} /></button>
        <button className="pane-icon-btn" data-tip="Collapse" aria-label="Collapse the AI pane" onClick={() => layout.collapsePane("ai")}><CollapseRightIcon size={14} /></button>
      </div>
    </div>
  );
}

function ChatView({ s, a, info, layout, subject, view, setChosen, cloud, trust }: {
  s: WSState;
  a: WSActions;
  info: RoomInfo;
  layout: LayoutApi;
  subject: Parameters<typeof chatScope>[0];
  view: ReturnType<typeof chatScope>;
  setChosen: (value: BrowserScope) => void;
  cloud: boolean;
  trust: ReturnType<typeof trustState>;
}) {
  const chooseScope = (value: string) => {
    if (value === PICK_FILES) {
      s.setLibraryTab("sources");
      layout.showPane("library");
      return;
    }
    setChosen(value as BrowserScope);
  };
  return (
    <>
      <div className="context-strip">
        <span className="context-label"><span className="context-label-prefix">Answering from </span><select className="context-scope" aria-label="What this chat answers from" title="Change what this chat answers from" value={view.scope} onChange={(event) => chooseScope(event.target.value)}>{view.available.map((scope) => <option key={scope} value={scope}>{scopeLabel(scope, subject)}</option>)}<option value={PICK_FILES}>{s.attachments.length > 0 ? "Change which files are attached…" : "Choose files…"}</option></select></span>
        {view.sendsPageText && cloud && <span className="context-leaves" title={trust.title}>The page’s text will leave your Mac.</span>}
        <span className={`local-mini ${trust.tone}`} title={trust.title}>{cloud ? <CloudIcon size={12} /> : <span className="status-dot" aria-hidden />}<span>{trust.label}</span></span>
      </div>
      <ChatPane s={s} a={a} info={info} />
    </>
  );
}

export default function AiPane({ s, a, info, layout, area }: AiPaneProps) {
  // One definition, shared with the status bar and the Activity list — see
  // ../shell/activity.
  const pendingApprovals = pendingApprovalCount(s);
  const jobsRunning = runningJobCount(s);
  const cloud = isCloudRoute(s.model, s.ai);
  // Same vocabulary as the top-bar badge and the status-bar trust chip
  // (workspace/markup.ts trustState) — the pill below and the scope's own
  // disclosure must never say something different about the same room's route.
  const trust = trustState(cloud, s.privacyOn);
  // What the browser is showing, and what the reader has chosen to do about it.
  // The pick is state; the scope is derived, so leaving the browser retires a
  // stale choice instead of carrying it somewhere it means nothing.
  const page = useOpenPage();
  // …and the same for the drawing on screen, which publishes its own selection
  // because nothing between the canvas and this pane has any use for it.
  const sketch = useOpenSketch(s.openFile);
  const [chosen, setChosen] = useState<BrowserScope | null>(null);
  const subject = useMemo(
    () => ({
      area,
      page,
      // Reported by the chrome's own poll (`browser_info.hasSelection`), so
      // offering the scope costs no round trip — and it is only ever true for a
      // selection that can actually be read back.
      hasSelection: page?.hasSelection === true,
      sketch,
      attachments: s.attachments.length,
    }),
    [area, page, sketch, s.attachments.length],
  );
  const view = useMemo(() => chatScope(subject, chosen), [subject, chosen]);
  // The scope belongs to the strip that states it: while this pane is on
  // screen the send honours it, and the moment it is gone the room-wide
  // default is the truth again.
  useEffect(() => {
    setTurnScope(view);
    return () => setTurnScope(ROOM_ONLY);
  }, [view]);
  return (
    <>
      <AiTabs s={s} layout={layout} pendingApprovals={pendingApprovals} jobsRunning={jobsRunning} />

      {s.aiTab === "chat" && <ChatView s={s} a={a} info={info} layout={layout} subject={subject} view={view} setChosen={setChosen} cloud={cloud} trust={trust} />}

      {s.aiTab === "studio" && <StudioView s={s} a={a} area={area} />}

      {s.aiTab === "activity" && <ActivityPanel s={s} a={a} />}
    </>
  );
}

/**
 * The page the private browser is showing, while its text can actually be read.
 *
 * Subscribed rather than polled. `browser_info` is not a cheap read — it is an
 * `evaluateJavaScript` round trip into the native page — and the browser's own
 * chrome already pays for one every 1.2s against that same webview, so a second
 * poll here doubled the cost of standing in the Browser to buy a strictly worse
 * answer: whether the view is parked lives in `BrowserView`'s React state,
 * where no host command can see it. That component publishes what it alone
 * knows (workspace/browserSignal), which also makes this null by construction
 * whenever the Browser is not the destination on screen.
 */
function useOpenPage(): OpenPage | null {
  const signal = useSyncExternalStore(subscribeBrowserPage, browserPageSnapshot);
  return useMemo(() => readablePage(signal), [signal]);
}

/**
 * The drawing on screen, as the scope rule wants it.
 *
 * Two halves from two owners, joined here: WHICH file is open is the shell's
 * knowledge, and WHAT is selected inside it is the canvas's. They are checked
 * against each other rather than trusted — a viewer that has been swapped out
 * for another file can leave its last selection behind for a moment, and a
 * scope offered from that would name one drawing and answer from another.
 */
function useOpenSketch(openFile: WSState["openFile"]): OpenSketch | null {
  const focus = useSyncExternalStore(subscribeSketchFocus, currentSketchFocus);
  return useMemo(() => {
    if (!openFile || !openFile.content.name.toLowerCase().endsWith(".sketch")) {
      return null;
    }
    return {
      fileId: openFile.id,
      name: displayName(openFile.content.name),
      selection: focus?.fileId === openFile.id ? focus.selection : [],
    };
  }, [openFile, focus]);
}

/* ---------- Studio tab ---------- */

function hasSummaryJob(jobs: WSState["jobs"]) {
  return jobs.some((job) => job.kind === "deep_summary" && (job.status === "running" || job.status === "queued"));
}

function StudioStep({ s }: { s: WSState }) {
  if (!s.studioStep.text) return null;
  return <div className="studio-running" role="status"><span className="nb-tape nb-sem-pending">Working</span><span className={s.studioStep.local ? "studio-running-step" : "studio-running-cloud"}>{s.studioStep.text}</span></div>;
}

function StudioSummary({ s, a }: { s: WSState; a: WSActions }) {
  const working = s.summaryStarting || hasSummaryJob(s.jobs);
  return (
    <button className="studio-row ap-sig-d" disabled={s.files.length === 0 || working} title="Write a short overview of this room and what's inside — runs in the background" onClick={() => void a.startDeepSummary()}>
      <span className="studio-row-icon"><SparkIcon size={14} /></span>
      <span className="studio-row-text"><span className="studio-row-title">Summarize the room</span><span className="studio-row-copy">A cited overview of everything inside</span></span>
      <span className={`studio-row-state${working ? " is-working nb-tape nb-sem-pending" : ""}`}>{working ? "Working…" : "Create"}</span>
    </button>
  );
}

function StudioPrivacyNote({ s }: { s: WSState }) {
  const location = isCloudRoute(s.model, s.ai) ? " — but the current engine is a cloud model, so prompts leave this Mac" : ", processed on this Mac";
  return <div className="studio-note nb-taped"><strong>Private by design.</strong> Studio uses only this room's content{location}.</div>;
}

function PodcastStudio({ scope, s, a }: { scope: string; s: WSState; a: WSActions }) {
  return <div className="studio-tab-view"><p className="studio-intro">Give this script voices and record it. Each host reads in their own voice; the finished episode is saved back into the room.</p><PodcastPanel fileId={scope} s={s} a={a} /></div>;
}

function StudioView({ s, a, area }: { s: WSState; a: WSActions; area: WorkArea }) {
  void area;
  const scope = s.openFile?.id;
  if (s.openPodcast && scope) return <PodcastStudio scope={scope} s={s} a={a} />;
  return (
    <div className="studio-tab-view">
      <p className="studio-intro">Turn {scope ? "the open file" : "this room's sources"} into something useful. Outputs are saved back into the room.</p>
      <StudioStep s={s} />
      <StudioShelf scope={scope} s={s} a={a} />
      <div className="studio-section-title">Whole room</div>
      <StudioSummary s={s} a={a} />
      <StudioPrivacyNote s={s} />
    </div>
  );
}

/* ---------- Activity tab ---------- */

function useElapsed(jobActive: boolean) {
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!jobActive) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [jobActive]);
  return useMemo(() => (createdAt: string) => {
    const start = Date.parse(createdAt);
    if (Number.isNaN(start)) return "";
    const seconds = Math.max(0, Math.round((nowTick - start) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }, [nowTick]);
}

function isSavingRecording(s: WSState) {
  return s.recSave != null || s.recLive?.status === "saving";
}

function activityIsEmpty(values: unknown[]) {
  return !values.some(Boolean);
}

function ApprovalRows({ s, count }: { s: WSState; count: number }) {
  if (count === 0) return null;
  return <><div className="activity-group-title">Needs your approval</div>
    {s.scriptApprovals.map((request) => <div key={request.id} className="activity-row"><div className="activity-row-head"><span className="activity-row-title">Run script {request.name}?</span><StateTape word="Waiting" mark="nb-sem-pending" /></div><div className="activity-copy">The consent card is open — approving is always your click, never the agent's.</div></div>)}
    {s.mcpApprovals.map((request) => <McpApprovalRow key={request.id} request={request} />)}
    {s.browseConsents.map((request) => <div key={request.id} className="activity-row"><div className="activity-row-head"><span className="activity-row-title">Type room information into a page?</span><StateTape word="Waiting" mark="nb-sem-pending" /></div><div className="activity-copy">The assistant wants to type something private into {request.field} — review the open consent card.</div></div>)}
    {s.editApprovals.map((request) => <div key={request.id} className="activity-row"><div className="activity-row-head"><span className="activity-row-title">Apply AI edits?</span><StateTape word="Diff ready" mark="nb-sem-pending" /></div><div className="activity-copy">Review the proposed change before anything is written.</div></div>)}
  </>;
}

function McpApprovalRow({ request }: { request: WSState["mcpApprovals"][number] }) {
  const title = request.confirm ? `Delete ${request.tool} “${request.server}”?` : `Tool call: ${request.tool}`;
  const copy = request.confirm ? "The AI asked to delete something that cannot be restored — review the open card." : "A connected tool wants to run — review the open consent card.";
  return <div className="activity-row"><div className="activity-row-head"><span className="activity-row-title">{title}</span><StateTape word="Waiting" mark="nb-sem-pending" /></div><div className="activity-copy">{copy}</div></div>;
}

function OcrActivity({ files }: { files: string[] }) {
  if (files.length === 0) return null;
  const title = files.length === 1 ? "Reading a scanned page" : `Reading ${files.length} scanned pages`;
  return <div className="activity-row" role="status"><div className="activity-row-head"><span className="activity-row-title">{title}</span><StateTape word="Running" mark="nb-sem-linked" /></div><div className="activity-copy">{files.join(", ")}</div><div className="activity-progress"><span className="indeterminate" /></div></div>;
}

function ImportActivity({ progress }: { progress: WSState["importProgress"] }) {
  if (!progress) return null;
  const percent = Math.round((progress.done / Math.max(1, progress.total)) * 100);
  return <div className="activity-row" role="status"><div className="activity-row-head"><span className="activity-row-title">Importing {progress.done + 1} of {progress.total}</span><StateTape word="Running" mark="nb-sem-linked" /></div><div className="activity-copy">{progress.name}</div><div className="activity-progress"><span style={{ width: `${percent}%` }} /></div></div>;
}

function SummaryStarting({ s }: { s: WSState }) {
  if (!s.summaryStarting || hasSummaryJob(s.jobs)) return null;
  return <div className="activity-row" role="status"><div className="activity-row-head"><span className="activity-row-title">Room summary</span><StateTape word="Starting…" mark="nb-sem-linked" /></div><div className="activity-progress"><span className="indeterminate" /></div></div>;
}

function recordingCopy(s: WSState) {
  if (s.recSave?.stage === "writing") return "Audio saved — writing into the room…";
  if (s.recSave && s.recSave.remaining > 0) return `Audio saved — transcribing (${s.recSave.remaining} to go)`;
  return "Audio saved — finishing the transcript…";
}

function RecordingActivity({ s, a, elapsedOf }: { s: WSState; a: WSActions; elapsedOf: (createdAt: string) => string }) {
  if (!isSavingRecording(s)) return null;
  const openFile = () => { if (s.recLive?.fileId) void a.viewFile(s.recLive.fileId); };
  return <div className="activity-row" role="status"><div className="activity-row-head"><span className="activity-row-title">Saving recording</span><StateTape word="Saving" mark="nb-sem-linked" />{s.recSave && <span className="activity-state">{elapsedOf(s.recSave.startedAt)}</span>}</div><div className="activity-copy ap-note">{recordingCopy(s)}</div>{s.recLive?.fileId && <div className="activity-row-actions"><button className="subtle" title="Open the recording" onClick={openFile}>Open</button></div>}</div>;
}

function LiveActivity({ s, a, running, parked, elapsedOf }: { s: WSState; a: WSActions; running: WorkspaceJob[]; parked: WorkspaceJob[]; elapsedOf: (createdAt: string) => string }) {
  const saving = isSavingRecording(s);
  const hasLive = [running.length, s.summaryStarting, s.importProgress, s.ocrFiles.length, saving].some(Boolean);
  return <section className="activity-live" aria-label="Work happening now">{hasLive && <div className="activity-group-title">Running now</div>}<OcrActivity files={s.ocrFiles} /><ImportActivity progress={s.importProgress} /><SummaryStarting s={s} /><RecordingActivity s={s} a={a} elapsedOf={elapsedOf} />{running.map((job) => <JobRow key={job.id} j={job} s={s} a={a} elapsedOf={elapsedOf} />)}{parked.length > 0 && <div className="activity-group-title">Stopped — waiting for you</div>}{parked.map((job) => <JobRow key={job.id} j={job} s={s} a={a} elapsedOf={elapsedOf} />)}</section>;
}

function OrganizedActivity({ records }: { records: WSState["organized"] }) {
  if (records.length === 0) return null;
  return <section className="activity-organized" aria-label="Organised by the assistant"><div className="activity-group-title">Library changes <span className="activity-history-note">made by the assistant, at your request</span></div>{records.map((record) => <OrganizedRow key={record.seq} record={record} />)}</section>;
}

function OrganizedRow({ record }: { record: WSState["organized"][number] }) {
  const title = record.linked ? "Added" : "Removed";
  const copy = record.linked ? "Home’s Library now lists it too. It stayed in its own section, and nothing was copied." : "Home’s Library no longer lists it. The object itself is untouched, in its own section.";
  return <div className="activity-row history"><div className="activity-row-head"><span className="activity-row-title">{title} “{displayName(record.name)}”</span><StateTape word="Done" mark="nb-sem-done" /></div><div className="activity-copy ap-note">{copy}</div></div>;
}

function HistoryActivity({ history, shown }: { history: WorkspaceJob[]; shown: WorkspaceJob[] }) {
  if (shown.length === 0) return null;
  const note = history.length > shown.length ? `the ${shown.length} most recent of ${history.length} — a record, nothing to act on` : "a record, nothing to act on";
  return <section className="activity-history" aria-label="What already happened"><div className="activity-group-title">History <span className="activity-history-note">{note}</span></div>{groupHistoryRuns(shown).map((group) => <HistoryEntry key={group[0].id} jobs={group} />)}</section>;
}

function IdleActivity({ show }: { show: boolean }) {
  if (!show) return null;
  return <div className="activity-empty"><ActivityIcon size={16} /><p>The room is idle. Work you start will show its progress here.</p></div>;
}

function ActivityPanel({ s, a }: { s: WSState; a: WSActions }) {
  const pending = pendingApprovalCount(s);
  const { active: running, parked, history } = groupActivity(s.jobs);
  const shown = history.slice(0, HISTORY_LIMIT);
  const organized = s.organized.slice(0, HISTORY_LIMIT);
  const runs = Object.values(s.harnessRuns ?? {}).sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  const elapsedOf = useElapsed(runningJobCount(s) > 0);
  const idle = activityIsEmpty([pending, runningJobCount(s), parked.length, history.length, organized.length, runs.length, s.importProgress, s.privacyScanning]);
  return <div className="activity-view"><p className="activity-summary">Background work, imports, saves, and consent requests stay in one predictable place.</p><HarnessRunner s={s} runs={runs} /><ApprovalRows s={s} count={pending} /><LiveActivity s={s} a={a} running={running} parked={parked} elapsedOf={elapsedOf} /><OrganizedActivity records={organized} /><HistoryActivity history={history} shown={shown} /><IdleActivity show={idle} /></div>;
}

const JOB_FLAG: Record<string, { word: string; mark: string }> = {
  running: { word: "Running", mark: "nb-sem-linked" },
  queued: { word: "Queued", mark: "nb-sem-pending" },
  paused: { word: "Paused", mark: "nb-sem-pending" },
  error: { word: "Failed", mark: "nb-sem-urgent" },
  done: { word: "Done", mark: "nb-sem-done" },
};

function jobFlag(status: string): { word: string; mark: string } {
  return JOB_FLAG[status] ?? { word: "Waiting", mark: "nb-sem-pending" };
}

type WorkspaceJob = WSState["jobs"][number];
type JobMeter = ReturnType<typeof jobMeter>;

function queuePosition(job: WorkspaceJob, jobs: WorkspaceJob[]) {
  return jobs.filter((other) => other.status === "queued" && other.createdAt <= job.createdAt).length;
}

function queueOrdinal(position: number) {
  return ["th", "st", "nd", "rd"][position] ?? "th";
}

function studioStepFor(job: WorkspaceJob, s: WSState) {
  return STEP_KINDS.includes(job.kind) && s.studioStep.text ? s.studioStep.text : null;
}

function friendlyJobError(error: string | null) {
  if (error === "OLLAMA_DOWN") return "The local AI isn't running.";
  if (error?.startsWith("MODEL_MISSING")) return "The AI model isn't installed.";
  return error;
}

function pausedDescription(reason: string | null, meter: JobMeter) {
  if (reason && meter.figure) return `${reason} Picks up at ${meter.figure.done} of ${meter.figure.total}.`;
  if (reason) return `${reason} Picks up where it stopped.`;
  if (meter.figure) return `Paused at ${meter.figure.done} of ${meter.figure.total}`;
  return "Paused";
}

function queuedDescription(position: number) {
  return `Waiting — ${position}${queueOrdinal(position)} in line`;
}

function runningDescription(step: string | null, liveLabel: string | undefined) {
  return step ?? liveLabel ?? "Working…";
}

function stoppedDescription(job: WorkspaceJob, meter: JobMeter) {
  if (job.status === "error") return friendlyJobError(job.error) ?? "Stopped.";
  return pausedDescription(job.parkedReason ?? null, meter);
}

function jobDescription({ job, queued, running, position, step, liveLabel, meter }: {
  job: WorkspaceJob;
  queued: boolean;
  running: boolean;
  position: number;
  step: string | null;
  liveLabel: string | undefined;
  meter: JobMeter;
}) {
  if (queued) return queuedDescription(position);
  if (running) return runningDescription(step, liveLabel);
  return stoppedDescription(job, meter);
}

function JobHeader({ job, running, elapsedOf, dismiss }: {
  job: WorkspaceJob;
  running: boolean;
  elapsedOf: (createdAt: string) => string;
  dismiss: () => void;
}) {
  return (
    <div className="activity-row-head">
      <span className="activity-row-title">{job.title}</span>
      <StateTape {...jobFlag(job.status)} />
      {running ? <span className="activity-state">{elapsedOf(job.createdAt)}</span> : (
        <button className="chip-btn" title="Dismiss this job" aria-label="Dismiss this job" onClick={dismiss}>
          <CloseIcon size={12} />
        </button>
      )}
    </div>
  );
}

function passWindowCount(plan: WorkspaceJob["plan"]) {
  const windows = (plan as { windows?: unknown[] } | null)?.windows;
  return Array.isArray(windows) ? windows.length : 0;
}

function PassMosaic({ job, done, running }: { job: WorkspaceJob; done: number; running: boolean }) {
  if (job.kind !== "file_pass") return null;
  const windows = passWindowCount(job.plan);
  if (windows < 2) return null;
  const cells = Math.min(windows, 192);
  const mapped = Math.min(done, windows);
  const cellsDone = Math.floor((mapped * cells) / windows);
  const weaving = running && done >= windows;
  return (
    <div className={`pass-mosaic${weaving ? " weaving" : ""}`} title={`${mapped} of ${windows} parts read`}>
      {Array.from({ length: cells }, (_, cell) => (
        <span
          key={cell}
          className={`pass-cell${cell < cellsDone ? " on" : ""}${cell === cellsDone && running && !weaving ? " now" : ""}`}
          style={{ "--h": Math.round((cell * 300) / cells) } as CSSProperties}
        />
      ))}
    </div>
  );
}

function JobMeterView({ meter }: { meter: JobMeter }) {
  return (
    <div className="activity-meter">
      <div className="activity-progress">
        <span className={meter.indeterminate ? "indeterminate" : undefined} style={meter.indeterminate ? undefined : { width: `${meter.percent}%` }} />
      </div>
      {meter.figure && <span className="activity-figure">{meter.figure.done}/{meter.figure.total}</span>}
    </div>
  );
}

function jobFootClass(step: string | null, job: WorkspaceJob, running: boolean, s: WSState) {
  if (step && running && job.status !== "queued" && !s.studioStep.local) return "activity-copy studio-running-cloud";
  return `activity-copy${job.status === "error" ? "" : " ap-note"}`;
}

function JobAction({ job, queued, running, pause, resume }: {
  job: WorkspaceJob;
  queued: boolean;
  running: boolean;
  pause: () => void;
  resume: () => void;
}) {
  if (queued) return <button className="subtle" title="Remove this job from the queue" onClick={pause}>Remove</button>;
  if (running) return <button className="subtle" title="Stop — it checkpoints so you can resume later" onClick={pause}>Stop</button>;
  return <button className="subtle" onClick={resume}>{job.status === "error" ? "Retry" : "Resume"}</button>;
}

function JobRow({ j, s, a, elapsedOf }: {
  j: WorkspaceJob;
  s: WSState;
  a: WSActions;
  elapsedOf: (createdAt: string) => string;
}) {
  const live = s.jobProgress[j.id];
  const queued = j.status === "queued";
  const running = j.status === "running" || queued;
  const meter = jobMeter(j.status, j.cursor, j.total, live);
  const position = queued ? queuePosition(j, s.jobs) : 0;
  const step = studioStepFor(j, s);
  const description = jobDescription({ job: j, queued, running, position, step, liveLabel: live?.label, meter });
  return (
    <div className={`activity-row job ${j.status}`} role="status">
      <JobHeader job={j} running={running} elapsedOf={elapsedOf} dismiss={() => void a.dismissJob(j.id)} />
      <PassMosaic job={j} done={live?.done ?? j.cursor} running={running} />
      <JobMeterView meter={meter} />
      <div className="activity-row-foot">
        <span className={jobFootClass(step, j, running, s)}>{description}</span>
        <JobAction job={j} queued={queued} running={running} pause={() => void a.pauseJob(j.id)} resume={() => void a.resumeJob(j.id)} />
      </div>
    </div>
  );
}
