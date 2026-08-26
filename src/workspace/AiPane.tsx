import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { jobMeter } from "./jobProgress";
import {
  api,
  RoomInfo,
  splitExternalModel,
  type HarnessApprovalDecision,
  type HarnessCapabilities,
  type HarnessProvider,
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
  registerHarnessRun,
  resolveHarnessApproval,
  type HarnessUiRun,
} from "./harnessUi";

/** Not a scope. The last option in the scope select opens the sources list
 * rather than changing what the turn reads — see the strip below for why it
 * lives inside the same control. */
const PICK_FILES = "__pick_files";

/** The tab order the strip renders, and the order the arrow keys walk. */
const AI_TABS = ["chat", "studio", "activity"] as const;

/** Job kinds that narrate themselves through `studio-step` rather than through
 * `job-progress`. Both emit one progress event ("Starting…") and then go quiet
 * for minutes; the podcast recorder is on the list because its steps include
 * the one saying every line is sent to a cloud voice service, which is a
 * privacy consequence and must not go unsaid because the row that carried it
 * was folded into the job's own. Emitters: commands/studios.rs and
 * commands/studios/podcast_audio.rs. */
const STEP_KINDS: readonly string[] = ["studio", "podcast_audio"];

/** Pane 3: persistent Chat / Studio / Activity tabs. Chat keeps the entire
 * existing conversation surface; Studio hosts the room's transformations;
 * Activity centralizes background jobs, imports, saves, and approvals. */
export default function AiPane({
  s,
  a,
  info,
  layout,
  area,
}: {
  s: WSState;
  a: WSActions;
  info: RoomInfo;
  layout: LayoutApi;
  area: WorkArea;
}) {
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
  // A `role="tablist"` owes Left/Right and Home/End, and ONE Tab stop rather
  // than one per tab — the same contract shell/TabStrip.tsx keeps. This strip
  // announced the pattern and answered none of it, on the pane a person meets
  // every session. The header also holds the pane's own icon buttons, so the
  // handler acts only when a tab has the focus.
  const onTabKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const from = AI_TABS.indexOf(s.aiTab);
    if (from < 0 || !(e.target as HTMLElement).closest(".assistant-tab")) return;
    const to =
      e.key === "ArrowLeft"
        ? (from + AI_TABS.length - 1) % AI_TABS.length
        : e.key === "ArrowRight"
          ? (from + 1) % AI_TABS.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? AI_TABS.length - 1
              : -1;
    if (to < 0) return;
    e.preventDefault();
    s.setAiTab(AI_TABS[to]);
    document.getElementById(`ai-tab-${AI_TABS[to]}`)?.focus();
  };
  return (
    <>
      <div
        className="assistant-header"
        role="tablist"
        aria-label="AI tools"
        onKeyDown={onTabKey}
      >
        <button
          id="ai-tab-chat"
          className="assistant-tab"
          role="tab"
          aria-selected={s.aiTab === "chat"}
          tabIndex={s.aiTab === "chat" ? 0 : -1}
          aria-label="Chat"
          data-tip="Chat"
          onClick={() => s.setAiTab("chat")}
        >
          <ChatBubbleIcon size={14} />
          <span>Chat</span>
        </button>
        <button
          id="ai-tab-studio"
          className="assistant-tab"
          role="tab"
          aria-selected={s.aiTab === "studio"}
          tabIndex={s.aiTab === "studio" ? 0 : -1}
          aria-label="Studio"
          data-tip="Studio"
          onClick={() => s.setAiTab("studio")}
        >
          <SparkIcon size={14} />
          <span>Studio</span>
        </button>
        <button
          id="ai-tab-activity"
          className="assistant-tab"
          role="tab"
          aria-selected={s.aiTab === "activity"}
          tabIndex={s.aiTab === "activity" ? 0 : -1}
          aria-label={
            pendingApprovals > 0
              ? "Activity — something needs your approval"
              : jobsRunning > 0
                ? "Activity — background work is running"
                : "Activity"
          }
          data-tip="Activity"
          onClick={() => s.setAiTab("activity")}
        >
          <ActivityIcon size={14} />
          <span>Activity</span>
          {/* Two different things used to share one 6px dot in two different
              colours, so "something needs your approval" and "work is running"
              were told apart by hue alone. They are different SHAPES now — a
              hand-circled count and a live dot — and the count says how many.
              The tab's own aria-label still carries the words. */}
          {pendingApprovals > 0 ? (
            <span
              className="nb-circled nb-sem-pending ap-tab-count"
              aria-hidden="true"
              title="Something needs your approval"
            >
              {pendingApprovals}
            </span>
          ) : jobsRunning > 0 ? (
            <span
              className="ap-tab-live"
              aria-hidden="true"
              title="Background work is running"
            />
          ) : null}
        </button>
        <div className="pane-actions">
          <button
            className="pane-icon-btn"
            data-tip="Focus this pane"
            aria-label="Give the AI pane the full width"
            onClick={() => layout.toggleFocus("ai")}
          >
            <FocusIcon size={14} />
          </button>
          <button
            className="pane-icon-btn"
            data-tip="Collapse"
            aria-label="Collapse the AI pane"
            onClick={() => layout.collapsePane("ai")}
          >
            <CollapseRightIcon size={14} />
          </button>
        </div>
      </div>

      {s.aiTab === "chat" && (
        <>
          <div className="context-strip">
            <span className="context-label">
              <span className="context-label-prefix">Answering from </span>
              {/* One control, always. This slot used to be a select when a page
                  was on screen and a button that navigated away when one was
                  not — the same appearance for two different acts, and no route
                  to the sources list at all while the select was showing. The
                  files option stays last and is not a scope; it opens the list
                  and leaves the chosen scope alone. Nothing may float over the
                  native web page — but this is the sibling pane, so a plain
                  select is exactly what it looks like. */}
              <select
                className="context-scope"
                aria-label="What this chat answers from"
                title="Change what this chat answers from"
                value={view.scope}
                onChange={(e) => {
                  if (e.target.value === PICK_FILES) {
                    s.setLibraryTab("sources");
                    layout.showPane("library");
                    return;
                  }
                  setChosen(e.target.value as BrowserScope);
                }}
              >
                {view.available.map((k) => (
                  <option key={k} value={k}>
                    {scopeLabel(k, subject)}
                  </option>
                ))}
                <option value={PICK_FILES}>
                  {s.attachments.length > 0
                    ? "Change which files are attached…"
                    : "Choose files…"}
                </option>
              </select>
            </span>
            {/* The consequence of the scope, in the words the composer's own
                cloud strip uses for the same fact. Only when it is true: on a
                local route the page text is read and answered on this Mac, and
                the trust pill beside this already says so. */}
            {view.sendsPageText && cloud && (
              <span className="context-leaves" title={trust.title}>
                The page’s text will leave your Mac.
              </span>
            )}
            <span className={`local-mini ${trust.tone}`} title={trust.title}>
              {cloud ? (
                <CloudIcon size={12} />
              ) : (
                <span className="status-dot" aria-hidden />
              )}
              <span>{trust.label}</span>
            </span>
          </div>
          <ChatPane s={s} a={a} info={info} />
        </>
      )}

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

function StudioView({
  s,
  a,
  area,
}: {
  s: WSState;
  a: WSActions;
  area: WorkArea;
}) {
  void area;
  const scope = s.openFile?.id;
  // The row may only report on the work it starts. Read across every job kind,
  // this greyed itself out and said "Working…" about a film run or a flashcard
  // deck — a false reading on the one row whose state a person waits on. The
  // kind is the same one `startDeepSummary` tests before deciding anything.
  const summaryRunning = s.jobs.some(
    (j) =>
      j.kind === "deep_summary" &&
      (j.status === "running" || j.status === "queued"),
  );
  const working = s.summaryStarting || summaryRunning;
  // A podcast script's own panel takes over the top of this tab. It is the one
  // thing you can make FROM this particular file, and burying it under the
  // three generic "make something new" cards would put the least discoverable
  // action furthest down.
  if (s.openPodcast && scope) {
    return (
      <div className="studio-tab-view">
        <p className="studio-intro">
          Give this script voices and record it. Each host reads in their own
          voice; the finished episode is saved back into the room.
        </p>
        <PodcastPanel fileId={scope} s={s} a={a} />
      </div>
    );
  }
  return (
    <div className="studio-tab-view">
      <p className="studio-intro">
        Turn {scope ? "the open file" : "this room's sources"} into something
        useful. Outputs are saved back into the room.
      </p>
      {/* AUDIT 262 named the step the host has always emitted; it only ever
          reached Activity. On a local model a deck takes minutes, so the tab
          you pressed Create on showed no sign of anything happening at all.
          The word carries it, the pending marker only agrees. */}
      {s.studioStep.text && (
        <div className="studio-running" role="status">
          <span className="nb-tape nb-sem-pending">Working</span>
          {/* A cloud stage says room content is leaving this Mac, which is a
              consequence, not an aside — so it drops the hand and takes the
              caution note, exactly as the chat's route line does for the same
              fact (see .chat-route / .chat-route-cloud in chat.css). The flag
              comes from the event, never from matching the sentence. */}
          <span
            className={
              s.studioStep.local ? "studio-running-step" : "studio-running-cloud"
            }
          >
            {s.studioStep.text}
          </span>
        </div>
      )}
      <StudioShelf scope={scope} s={s} a={a} />
      <div className="studio-section-title">Whole room</div>
      {/* No category hue on this one, deliberately: the three cards above make
          an artefact, this one is about the room itself, and the bare pencil
          tile is the difference. */}
      <button
        className="studio-row ap-sig-d"
        disabled={s.files.length === 0 || working}
        title="Write a short overview of this room and what's inside — runs in the background"
        onClick={() => void a.startDeepSummary()}
      >
        <span className="studio-row-icon">
          <SparkIcon size={14} />
        </span>
        <span className="studio-row-text">
          <span className="studio-row-title">Summarize the room</span>
          <span className="studio-row-copy">
            A cited overview of everything inside
          </span>
        </span>
        <span
          className={`studio-row-state${working ? " is-working nb-tape nb-sem-pending" : ""}`}
        >
          {working ? "Working…" : "Create"}
        </span>
      </button>
      <div className="studio-note nb-taped">
        <strong>Private by design.</strong> Studio uses only this room's
        content{isCloudRoute(s.model, s.ai) ? " — but the current engine is a cloud model, so prompts leave this Mac" : ", processed on this Mac"}.
      </div>
    </div>
  );
}

/* ---------- Activity tab ---------- */

/** A job's state as a WORD, plus the product-wide marker meaning that agrees
 * with it. Activity is the surface a person audits background work from, so
 * nothing here is signalled by hue alone: the tape carries the word, and the
 * marker is the second, redundant cue. Blue is "active", yellow "pending or
 * waiting on you", red "failed", green "complete" — the same five meanings
 * the rest of the product uses, never repurposed locally. */
const JOB_FLAG: Record<string, { word: string; mark: string }> = {
  running: { word: "Running", mark: "nb-sem-linked" },
  queued: { word: "Queued", mark: "nb-sem-pending" },
  paused: { word: "Paused", mark: "nb-sem-pending" },
  error: { word: "Failed", mark: "nb-sem-urgent" },
  done: { word: "Done", mark: "nb-sem-done" },
};

/** A status this build has never heard of is reported as waiting rather than
 * as anything more definite — the same direction `groupActivity` files it in. */
function jobFlag(status: string): { word: string; mark: string } {
  return JOB_FLAG[status] ?? { word: "Waiting", mark: "nb-sem-pending" };
}

/** One strip of tape naming a state. Contains no control, by design: History
 * must render without a single button in it. */
function StateTape({ word, mark }: { word: string; mark: string }) {
  return <span className={`nb-tape ${mark} activity-flag`}>{word}</span>;
}

function ActivityPanel({ s, a }: { s: WSState; a: WSActions }) {
  // A once-a-second tick so running cards' elapsed time advances. Armed only
  // while something is actually running.
  const jobActive = runningJobCount(s) > 0;
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!jobActive) return;
    const t = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [jobActive]);
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

  const pendingApprovals = pendingApprovalCount(s);
  // Decision #12: Activity is a live MANAGER and an audit LOG, and the two are
  // separate places on the screen — not a sort order inside one list. The rule
  // lives in shell/activity.ts so the counters, the attention dot and this list
  // can never disagree about which side a job is on.
  const { active: running, parked, history } = groupActivity(s.jobs);
  const shownHistory = history.slice(0, HISTORY_LIMIT);
  // The assistant's organization changes belong in the same half as finished
  // jobs — something happened, there is nothing to act on — but they are not
  // jobs and are not grouped or counted as any. They have no duration, no
  // progress and no run to resume.
  const organized = s.organized.slice(0, HISTORY_LIMIT);
  const harnessRuns = Object.values(s.harnessRuns ?? {}).sort((left, right) =>
    right.startedAt.localeCompare(left.startedAt),
  );
  // A recording is "being written out" while EITHER signal is up — the two
  // arrive a beat apart, and the counters use the same rule.
  const savingRec = s.recSave != null || s.recLive?.status === "saving";
  const nothing =
    pendingApprovals === 0 &&
    runningJobCount(s) === 0 &&
    parked.length === 0 &&
    history.length === 0 &&
    organized.length === 0 &&
    harnessRuns.length === 0 &&
    !s.importProgress &&
    // The privacy scanner has no job row, so nothing above can see it — and
    // "The room is idle" is a flat claim this pane would otherwise make while
    // the scanner is reading every file. It gets no row here on purpose (it is
    // uncancellable and has nothing to show), so the honest move is to withhold
    // the claim rather than invent a card for it.
    !s.privacyScanning;

  return (
    <div className="activity-view">
      <p className="activity-summary">
        Background work, imports, saves, and consent requests stay in one
        predictable place.
      </p>

      <HarnessRunner s={s} runs={harnessRuns} />

      {pendingApprovals > 0 && (
        <>
          <div className="activity-group-title">Needs your approval</div>
          {s.scriptApprovals.map((r) => (
            <div key={r.id} className="activity-row">
              <div className="activity-row-head">
                <span className="activity-row-title">Run script {r.name}?</span>
                <StateTape word="Waiting" mark="nb-sem-pending" />
              </div>
              <div className="activity-copy">
                The consent card is open — approving is always your click, never
                the agent's.
              </div>
            </div>
          ))}
          {s.mcpApprovals.map((r) => (
            <div key={r.id} className="activity-row">
              <div className="activity-row-head">
                <span className="activity-row-title">
                  {r.confirm ? `Delete ${r.tool} “${r.server}”?` : `Tool call: ${r.tool}`}
                </span>
                <StateTape word="Waiting" mark="nb-sem-pending" />
              </div>
              <div className="activity-copy">
                {r.confirm
                  ? "The AI asked to delete something that cannot be restored — review the open card."
                  : "A connected tool wants to run — review the open consent card."}
              </div>
            </div>
          ))}
          {s.browseConsents.map((r) => (
            <div key={r.id} className="activity-row">
              <div className="activity-row-head">
                <span className="activity-row-title">
                  Type room information into a page?
                </span>
                <StateTape word="Waiting" mark="nb-sem-pending" />
              </div>
              <div className="activity-copy">
                The assistant wants to type something private into {r.field} —
                review the open consent card.
              </div>
            </div>
          ))}
          {s.editApprovals.map((r) => (
            <div key={r.id} className="activity-row">
              <div className="activity-row-head">
                <span className="activity-row-title">Apply AI edits?</span>
                <StateTape word="Diff ready" mark="nb-sem-pending" />
              </div>
              <div className="activity-copy">
                Review the proposed change before anything is written.
              </div>
            </div>
          ))}
        </>
      )}

      {/* The LIVE half: work in flight and work waiting to be picked back up.
          Jobs here can be stopped and resumed; the rows that are not jobs — the
          OCR pass, an import, the recording drain and the optimistic card that
          answers the summary button before the backend does — carry no control,
          because there is nothing to interrupt. */}
      <section className="activity-live" aria-label="Work happening now">
        {(running.length > 0 ||
          s.summaryStarting ||
          s.importProgress ||
          s.ocrFiles.length > 0 ||
          savingRec) && (
          <div className="activity-group-title">Running now</div>
        )}

        {/* AUDIT 262: a scanned page being read. The host has emitted this the
            whole time and nothing listened, so a vision pass that runs for
            minutes on a local model showed no sign of activity anywhere. */}
        {s.ocrFiles.length > 0 && (
          <div className="activity-row" role="status">
            <div className="activity-row-head">
              <span className="activity-row-title">
                Reading {s.ocrFiles.length === 1 ? "a scanned page" : `${s.ocrFiles.length} scanned pages`}
              </span>
              <StateTape word="Running" mark="nb-sem-linked" />
            </div>
            {/* Filenames, so the interface sans — the hand is for the aside,
                never for a path or a name the user has to match by eye. */}
            <div className="activity-copy">{s.ocrFiles.join(", ")}</div>
            <div className="activity-progress">
              <span className="indeterminate" />
            </div>
          </div>
        )}

        {/* AUDIT 262's Studio step had its own card here, beside the JobRow for
            the same run: one card carried the words and no Stop, the other
            carried Stop and the stale "Starting…" the backend emits once. The
            step is on that JobRow now — one card per run. */}

        {s.importProgress && (
          <div className="activity-row" role="status">
            <div className="activity-row-head">
              <span className="activity-row-title">
                Importing {s.importProgress.done + 1} of {s.importProgress.total}
              </span>
              <StateTape word="Running" mark="nb-sem-linked" />
            </div>
            <div className="activity-copy">{s.importProgress.name}</div>
            <div className="activity-progress">
              <span
                style={{
                  width: `${Math.round((s.importProgress.done / Math.max(1, s.importProgress.total)) * 100)}%`,
                }}
              />
            </div>
          </div>
        )}

        {/* The summary command can take seconds to RESOLVE on a cold local
            model; this optimistic card shows the instant the button is pressed,
            so a click is never silent. */}
        {s.summaryStarting &&
          !s.jobs.some(
            (j) =>
              j.kind === "deep_summary" &&
              (j.status === "running" || j.status === "queued"),
          ) && (
            <div className="activity-row" role="status">
              <div className="activity-row-head">
                <span className="activity-row-title">Room summary</span>
                <StateTape word="Starting…" mark="nb-sem-linked" />
              </div>
              <div className="activity-progress">
                <span className="indeterminate" />
              </div>
            </div>
          )}

        {/* A recording being finalized keeps a visible card here, so leaving
            the recording view never turns the save into a mystery. The audio
            is already durable when this card appears — the label says so. */}
        {savingRec && (
          <div className="activity-row" role="status">
            <div className="activity-row-head">
              <span className="activity-row-title">Saving recording</span>
              <StateTape word="Saving" mark="nb-sem-linked" />
              {s.recSave && (
                <span className="activity-state">{elapsedOf(s.recSave.startedAt)}</span>
              )}
            </div>
            <div className="activity-copy ap-note">
              {s.recSave?.stage === "writing"
                ? "Audio saved — writing into the room…"
                : s.recSave && s.recSave.remaining > 0
                  ? `Audio saved — transcribing (${s.recSave.remaining} to go)`
                  : "Audio saved — finishing the transcript…"}
            </div>
            {s.recLive?.fileId && (
              <div className="activity-row-actions">
                <button
                  className="subtle"
                  title="Open the recording"
                  onClick={() => {
                    const id = s.recLive?.fileId;
                    if (id) void a.viewFile(id);
                  }}
                >
                  Open
                </button>
              </div>
            )}
          </div>
        )}

        {/* ADD-30: background-job cards — live progress while running. */}
        {running.map((j) => (
          <JobRow key={j.id} j={j} s={s} a={a} elapsedOf={elapsedOf} />
        ))}

        {parked.length > 0 && (
          <div className="activity-group-title">Stopped — waiting for you</div>
        )}
        {parked.map((j) => (
          <JobRow key={j.id} j={j} s={s} a={a} elapsedOf={elapsedOf} />
        ))}
      </section>

      {/* The AUDIT half (decision #12). Deliberately a separate section with its
          own heading and its own muted styling, not a run of quieter cards at
          the bottom of one list: the user must be able to tell at a glance what
          they can still act on from what is only a record. No job here has an
          ACTION button — a finished job is not a thing you resume — but a
          repeated-run group's own "show runs" disclosure toggle is not a job
          action, it just un-collapses detail already on the screen. */}
      {/* What the assistant changed about how the room is ORGANISED. Its own
          group above the job log, because a promotion is not a run: it took no
          time, it has no steps, and the only thing worth saying about it is
          which object went which way. Before this it existed solely inside the
          turn that made it — findable by scrolling the transcript back to the
          right message, and absent from the panel that offers itself as the
          room's record of what has been done to it. */}
      {organized.length > 0 && (
        <section className="activity-organized" aria-label="Organised by the assistant">
          <div className="activity-group-title">
            Library changes
            <span className="activity-history-note">
              made by the assistant, at your request
            </span>
          </div>
          {organized.map((c) => (
            <div key={c.seq} className="activity-row history">
              <div className="activity-row-head">
                <span className="activity-row-title">
                  {c.linked ? "Added" : "Removed"} “{displayName(c.name)}”
                </span>
                <StateTape word="Done" mark="nb-sem-done" />
              </div>
              <div className="activity-copy ap-note">
                {c.linked
                  ? "Home’s Library now lists it too. It stayed in its own section, and nothing was copied."
                  : "Home’s Library no longer lists it. The object itself is untouched, in its own section."}
              </div>
            </div>
          ))}
        </section>
      )}

      {shownHistory.length > 0 && (
        <section className="activity-history" aria-label="What already happened">
          <div className="activity-group-title">
            History
            <span className="activity-history-note">
              {history.length > shownHistory.length
                ? `the ${shownHistory.length} most recent of ${history.length} — a record, nothing to act on`
                : "a record, nothing to act on"}
            </span>
          </div>
          {/* D4: repeated same-day runs of the same workflow/script collapse to
              one summary row instead of N identical ones — see
              `groupHistoryRuns`. A single run, or a run of something else in
              between, breaks the run and renders exactly as it always did. */}
          {groupHistoryRuns(shownHistory).map((group) =>
            group.length > 1 ? (
              <HistoryGroupRow key={group[0].id} jobs={group} />
            ) : (
              <HistoryRow key={group[0].id} j={group[0]} />
            ),
          )}
        </section>
      )}

      {nothing && (
        <div className="activity-empty">
          <ActivityIcon size={16} />
          <p>The room is idle. Work you start will show its progress here.</p>
        </div>
      )}
    </div>
  );
}

/** Native workspace-agent launcher and audit cards. The event listener lives
 * at Workspace scope, so closing Activity does not lose a running agent. */
function HarnessRunner({ s, runs }: { s: WSState; runs: HarnessUiRun[] }) {
  const [capabilities, setCapabilities] = useState<HarnessCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState("");
  const [provider, setProvider] = useState<HarnessProvider>("codex");
  const [, selectedModel] = splitExternalModel(s.model ?? "");
  const [model, setModel] = useState(selectedModel ?? "default");
  const [prompt, setPrompt] = useState("");
  const [writeEnabled, setWriteEnabled] = useState(false);
  const [starting, setStarting] = useState(false);
  const [rollbackBusy, setRollbackBusy] = useState<string | null>(null);
  const [restoreConflicts, setRestoreConflicts] = useState<Record<string, string[]>>({});

  const refreshCapabilities = () => {
    setCapabilityError("");
    void api.harnessCapabilities().then(setCapabilities).catch((error) => {
      setCapabilities(null);
      setCapabilityError(String(error));
    });
  };
  useEffect(refreshCapabilities, []);

  const available = capabilities?.providers[provider];
  const start = async () => {
    const text = prompt.trim();
    if (!text || starting) return;
    setStarting(true);
    try {
      const result = await api.harnessStart({
        provider,
        model: model.trim() || "default",
        privacyMode: provider === "ollama-local"
          ? "local"
          : s.privacyOn
            ? "cloud-redacted"
            : "cloud-direct",
        writeEnabled,
        text,
      });
      s.setHarnessRuns((current) => registerHarnessRun(current, result.runId, provider));
      setPrompt("");
    } catch (error) {
      s.pushToast("error", `Couldn't start the workspace agent: ${String(error)}`);
      refreshCapabilities();
    } finally {
      setStarting(false);
    }
  };

  const approve = async (
    run: HarnessUiRun,
    requestId: string,
    decision: HarnessApprovalDecision,
  ) => {
    try {
      if (requestId === `cloud-writeback-${run.runId}`) {
        await api.harnessCloudWriteback(
          run.runId,
          decision === "allow-once" || decision === "allow-run",
        );
      } else {
        await api.harnessApprove(run.runId, requestId, decision);
      }
      s.setHarnessRuns((current) =>
        resolveHarnessApproval(current, run.runId, requestId),
      );
    } catch (error) {
      s.pushToast("error", `Couldn't answer the agent request: ${String(error)}`);
    }
  };

  const rollback = async (run: HarnessUiRun) => {
    setRollbackBusy(run.runId);
    try {
      const result = await api.harnessRollback(run.runId);
      setRestoreConflicts((all) => ({ ...all, [run.runId]: result.conflicts }));
      const count = result.restored.length + result.removedCreated.length;
      s.pushToast(
        result.conflicts.length ? "info" : "success",
        result.conflicts.length
          ? `Restored ${count} changes. ${result.conflicts.length} newer file changes were kept.`
          : `Restored ${count} agent file changes.`,
      );
      api.listFiles().then(s.setFiles).catch(() => {});
    } catch (error) {
      s.pushToast("error", `Couldn't roll back this run: ${String(error)}`);
    } finally {
      setRollbackBusy(null);
    }
  };

  const restoreCopies = async (runId: string, paths: string[]) => {
    setRollbackBusy(runId);
    try {
      const created = await api.harnessRestoreBaselineCopies(runId, paths);
      setRestoreConflicts((all) => ({ ...all, [runId]: [] }));
      s.pushToast(
        "success",
        `Restored ${created.length} baseline ${created.length === 1 ? "copy" : "copies"}.`,
      );
      api.listFiles().then(s.setFiles).catch(() => {});
    } catch (error) {
      s.pushToast("error", `Couldn't restore baseline copies: ${String(error)}`);
    } finally {
      setRollbackBusy(null);
    }
  };

  return (
    <section className="harness-runner" aria-label="Workspace agents">
      <div className="activity-group-title">Workspace agent</div>
      <p className="activity-copy harness-disclosure">
        {provider === "ollama-local"
          ? "Local Ollama works through Arcelle's controlled file backend. It receives no database keys or unrestricted system paths."
          : s.privacyOn
          ? "Cloud Privacy is on. The agent works in a temporary redacted copy; protected values and original binary files stay on this Mac."
          : "Cloud Privacy is off. The cloud agent can receive the real room files. Normal workspace files are readable files on disk; the private .arcelle folder stays blocked."}
      </p>
      <div className="harness-compose">
        <div className="harness-options">
          <label>
            Agent
            <select
              value={provider}
              onChange={(event) => {
                const next = event.target.value as HarnessProvider;
                setProvider(next);
                if (next === "ollama-local" || next === "ollama-cloud" || next === "openrouter") {
                  setModel(s.model ?? "");
                } else {
                  setModel(selectedModel ?? "default");
                }
              }}
            >
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
              <option value="ollama-local">Ollama local</option>
              <option value="ollama-cloud">Ollama cloud</option>
              <option value="openrouter">OpenRouter</option>
            </select>
          </label>
          <label>
            Model
            <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="default" />
          </label>
          <label className="settings-label harness-write-toggle">
            <input type="checkbox" checked={writeEnabled} onChange={(event) => setWriteEnabled(event.target.checked)} />
            Allow file changes
          </label>
        </div>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe the work for the workspace agent…"
          aria-label="Workspace agent task"
          rows={3}
        />
        {capabilityError && <p className="gate-error" role="alert">{capabilityError}</p>}
        {available && !available.enabled && (
          <p className="activity-copy">Unavailable: {available.reason ?? "the runtime self-test did not pass."}</p>
        )}
        <div className="harness-actions">
          <button className="primary" disabled={!prompt.trim() || starting || available?.enabled !== true} onClick={() => void start()}>
            {starting ? "Starting…" : writeEnabled ? "Run with file access" : "Run read-only"}
          </button>
          <button className="subtle" onClick={refreshCapabilities}>Test agents again</button>
        </div>
      </div>

      {runs.map((run) => {
        const live = run.status === "starting" || run.status === "running" || run.status === "waiting";
        const conflicts = restoreConflicts[run.runId] ?? [];
        return (
          <article className="activity-row harness-run" key={run.runId}>
            <div className="activity-row-head">
              <span className="activity-row-title">{
                run.provider === "claude" ? "Claude"
                  : run.provider === "codex" ? "Codex"
                    : run.provider === "ollama-local" ? "Ollama local"
                      : run.provider === "ollama-cloud" ? "Ollama cloud"
                        : run.provider === "openrouter" ? "OpenRouter"
                          : "Workspace agent"
              }</span>
              <StateTape
                word={run.status === "completed" ? "Done" : run.status === "failed" ? "Failed" : run.status === "cancelled" ? "Stopped" : run.status === "waiting" ? "Waiting" : "Running"}
                mark={run.status === "completed" ? "nb-sem-done" : run.status === "failed" ? "nb-sem-urgent" : run.status === "running" ? "nb-sem-linked" : "nb-sem-pending"}
              />
            </div>
            {run.plan && <div className="activity-copy"><strong>Plan:</strong> {run.plan}</div>}
            {run.currentTool && <div className="activity-copy">Using {run.currentTool}…</div>}
            {run.text && <pre className="harness-output">{run.text}</pre>}
            {run.error && <div className="gate-error" role="alert">{run.error}</div>}
            {run.approvals.map((request) => (
              <div className="harness-approval" data-agent-blocked="true" key={request.requestId}>
                <strong>{request.tool} needs approval</strong>
                <span>{request.detail}</span>
                <div className="harness-actions">
                  <button className="primary" onClick={() => void approve(run, request.requestId, "allow-once")}>Allow once</button>
                  {request.tool !== "cloud_writeback" && <button className="subtle" onClick={() => void approve(run, request.requestId, "allow-run")}>Allow for run</button>}
                  <button className="subtle danger" onClick={() => void approve(run, request.requestId, "deny")}>Deny</button>
                </div>
              </div>
            ))}
            {run.changes.length > 0 && (
              <details className="harness-changes" open={run.status === "completed"}>
                <summary>{run.changes.length} file {run.changes.length === 1 ? "change" : "changes"}</summary>
                <ul>{run.changes.map((change) => <li key={change.relativePath}><code>{change.relativePath}</code> — {change.change}</li>)}</ul>
              </details>
            )}
            {(run.inputTokens > 0 || run.outputTokens > 0) && <div className="activity-copy">{run.inputTokens.toLocaleString()} input · {run.outputTokens.toLocaleString()} output tokens{run.costUsd != null ? ` · $${run.costUsd.toFixed(4)}` : ""}</div>}
            <div className="harness-actions">
              {live && <button className="subtle danger" onClick={() => void api.harnessCancel(run.runId).catch((error) => s.pushToast("error", String(error)))}>Stop</button>}
              {!live && run.changes.length > 0 && <button className="subtle" disabled={rollbackBusy === run.runId} onClick={() => void rollback(run)}>{rollbackBusy === run.runId ? "Restoring…" : "Roll back file changes"}</button>}
            </div>
            {conflicts.length > 0 && (
              <div className="harness-conflicts" data-agent-blocked="true">
                <p>These files changed again after the run, so Arcelle kept them: {conflicts.join(", ")}.</p>
                <button className="subtle" disabled={rollbackBusy === run.runId} onClick={() => void restoreCopies(run.runId, conflicts)}>Restore baselines as copies</button>
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}

/** One finished job in the audit log. A record, so it carries no Stop, no
 * Resume, no Dismiss — the live section owns every affordance. It reports what
 * the row itself stored (`cursor` of `total`, and when it last moved); nothing
 * here is inferred, because a finished job's own numbers are the only evidence
 * of what it did. */
function HistoryRow({ j }: { j: WSState["jobs"][number] }) {
  const when = Date.parse(j.updatedAt);
  return (
    <div className="activity-row history">
      <div className="activity-row-head">
        <span className="activity-row-title">{j.title}</span>
        {/* `groupActivity` files only `done` here, so the tape is not guessing:
            everything in the log finished. */}
        <StateTape word="Done" mark="nb-sem-done" />
        <span className="activity-state">
          {Number.isNaN(when) ? "" : new Date(when).toLocaleString()}
        </span>
      </div>
      <div className="activity-copy ap-note">
        Finished
        {j.total > 0 ? ` — ${Math.min(j.cursor, j.total)} of ${j.total} steps` : ""}
      </div>
    </div>
  );
}

type HistoryJob = WSState["jobs"][number];

/** D4: a room that runs the same workflow/script every day fills History with
 * identical-looking rows — this collapses a same-day run of the same thing
 * into one group the way a person would read it at a glance.
 *
 * `jobs` must already be in the order History renders them (most recent
 * first — `list_jobs` sorts by `created_at DESC`, and nothing downstream of
 * it reorders). Grouping only ever merges items that are ALREADY adjacent in
 * that order and share both a title and a local calendar day — a run of
 * "stock_metrics.py" on Monday and another on Tuesday stays two separate
 * rows (and two separate groups) even though the titles match, and a
 * different job landing in between breaks the run rather than being skipped
 * over. A group of exactly one job is returned as its own one-element array,
 * so a caller can render it exactly like today (no grouping UI) just by
 * checking `.length > 1`. */
export function groupHistoryRuns(jobs: HistoryJob[]): HistoryJob[][] {
  const groups: HistoryJob[][] = [];
  for (const j of jobs) {
    const current = groups[groups.length - 1];
    const prev = current?.[current.length - 1];
    if (prev && prev.title === j.title && sameLocalDay(prev.updatedAt, j.updatedAt)) {
      current.push(j);
    } else {
      groups.push([j]);
    }
  }
  return groups;
}

function sameLocalDay(a: string, b: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return false;
  return da.toDateString() === db.toDateString();
}

/** "today" / "yesterday" / a compact date, for one group's shared day — the
 * same no-year-unless-it-isn't-this-one convention SearchExpanded's
 * `shortWhen` uses for a margin date. */
function dayLabelOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "that day";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "yesterday";
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  return `on ${d.toLocaleDateString(undefined, opts)}`;
}

/** One collapsed group of 2+ same-day, same-name finished runs. The header
 * line and the summary under it are both built in code from the runs' own
 * fields, so neither is ever blank and neither waits on anything. Individual
 * runs are collapsed by default behind "Show runs" — nothing is deleted,
 * `HistoryRow` still renders each one unchanged once expanded. */
function HistoryGroupRow({ jobs }: { jobs: HistoryJob[] }) {
  const [expanded, setExpanded] = useState(false);
  const latest = jobs[0]; // most recent first, per `groupHistoryRuns`'s contract
  const name = latest.title;
  const runCount = jobs.length;
  // The only per-run signal History's own data actually carries: did a run's
  // cursor reach its own total. `status` can't add anything here — only
  // `done` jobs ever reach History (`groupActivity`), so it is constant
  // within a group and would be a fact with nothing left to say.
  const allSucceeded = jobs.every(
    (j) => j.error == null && (j.total <= 0 || j.cursor >= j.total),
  );
  const when = Date.parse(latest.updatedAt);

  // Written in code, not generated. The only inputs a model had here were the
  // name, the count and whether every run finished — all three already stated
  // exactly in the header line above, so the call could only paraphrase its own
  // evidence less precisely, and paid for the privilege on every visit.
  const summary = allSucceeded
    ? `${runCount} runs, all finished.`
    : `${runCount} runs — not every one finished all its steps.`;

  const runsId = `history-group-runs-${latest.id}`;
  return (
    <div className="activity-row history activity-history-group">
      <div className="activity-row-head">
        <span className="activity-row-title">
          {name} — {runCount} runs {dayLabelOf(latest.updatedAt)}
          {allSucceeded ? ", all clean" : ", some incomplete"}
        </span>
        <StateTape word="Done" mark="nb-sem-done" />
        <span className="activity-state">
          {Number.isNaN(when) ? "" : new Date(when).toLocaleString()}
        </span>
      </div>
      <div className="activity-copy ap-note">{summary}</div>
      <div className="activity-row-actions">
        <button
          className="subtle"
          aria-expanded={expanded}
          aria-controls={runsId}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Hide runs" : "Show runs"}
        </button>
      </div>
      {expanded && (
        <div id={runsId} className="activity-history-group-runs">
          {jobs.map((j) => (
            <HistoryRow key={j.id} j={j} />
          ))}
        </div>
      )}
    </div>
  );
}

function JobRow({
  j,
  s,
  a,
  elapsedOf,
}: {
  j: WSState["jobs"][number];
  s: WSState;
  a: WSActions;
  elapsedOf: (createdAt: string) => string;
}) {
  const live = s.jobProgress[j.id];
  // Wave 4a: a QUEUED job is waiting for the single heavy-work slot — it is
  // not actually running yet, so it shows "Waiting — Nth in line" with a
  // "Remove" affordance (Stop on it is a no-op; cancel_job parks the row).
  const queued = j.status === "queued";
  const running = j.status === "running" || queued;
  const queuePos = queued
    ? s.jobs.filter((o) => o.status === "queued" && o.createdAt <= j.createdAt)
        .length
    : 0;
  // The indeterminate bar means "running, and its position is not yet known".
  // A QUEUED job is neither: it has not started, so it shows its real starting
  // point — 0, or wherever a parked run left off — instead of an animation
  // sliding over work that nothing is doing. Under reduced motion the same
  // animation degrades to a FULL bar, which said a job that had not begun was
  // finished. See jobProgress.ts for the rule and what it refuses to invent.
  const meter = jobMeter(j.status, j.cursor, j.total, live);
  // Only meaningful while the job is stopped-but-resumable; a running job is
  // not being interrupted by anything, and the backend clears the column the
  // moment it moves off 'paused'.
  const parkedReason = !running ? (j.parkedReason ?? null) : null;
  // A Studio run emits `job-progress` exactly once, at the start, so `live`
  // holds "Starting…" for the whole of a run that can take minutes. Its real
  // phases arrive on a separate event, and that is the line worth reading —
  // including the one saying the content is leaving this Mac. Cleared by the
  // terminal job event, so it can never outlive the run it describes.
  const studioStep =
    STEP_KINDS.includes(j.kind) && s.studioStep.text ? s.studioStep.text : null;
  const friendlyError =
    j.error === "OLLAMA_DOWN"
      ? "The local AI isn't running."
      : j.error?.startsWith("MODEL_MISSING")
        ? "The AI model isn't installed."
        : j.error;
  return (
    <div className={`activity-row job ${j.status}`} role="status">
      <div className="activity-row-head">
        <span className="activity-row-title">{j.title}</span>
        {/* The word first, the marker second. A queued job says "Queued", not
            "Running", because the queue is a real state the row already
            explains in its foot. */}
        <StateTape {...jobFlag(queued ? "queued" : j.status)} />
        {running ? (
          <span className="activity-state">{elapsedOf(j.createdAt)}</span>
        ) : (
          <button
            className="chip-btn"
            title="Dismiss this job"
            aria-label="Dismiss this job"
            onClick={() => void a.dismissJob(j.id)}
          >
            <CloseIcon size={12} />
          </button>
        )}
      </div>
      {/* ADD-32: the pass mosaic — one cell per stretch of the file, lighting
          up in spectral order as each part is read. */}
      {j.kind === "file_pass" &&
        (() => {
          const plan = (j.plan ?? {}) as { windows?: unknown[] };
          const nWin = Array.isArray(plan.windows) ? plan.windows.length : 0;
          if (nWin < 2) return null;
          const cells = Math.min(nWin, 192);
          // The mosaic counts against the PLAN's own window count, which is a
          // different quantity from the meter's total and known even when that
          // one is not.
          const done = live?.done ?? j.cursor;
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
      {/* A marker stroke and a written count, never one without the other: a
          length and a colour on their own do not state a quantity, and an
          indeterminate bar has no quantity to state — its label does the work
          instead. */}
      <div className="activity-meter">
        <div className="activity-progress">
          <span
            className={meter.indeterminate ? "indeterminate" : undefined}
            style={meter.indeterminate ? undefined : { width: `${meter.percent}%` }}
          />
        </div>
        {meter.figure && (
          <span className="activity-figure">
            {meter.figure.done}/{meter.figure.total}
          </span>
        )}
      </div>
      <div className="activity-row-foot">
        {/* A cloud stage says room content is leaving this Mac, and it keeps the
            caution treatment here that it had on the card this row replaced —
            the same one chat.css gives .chat-route-cloud for the same fact. The
            flag comes from the event, never from reading the sentence. */}
        <span
          className={
            studioStep && running && !queued && !s.studioStep.local
              ? "activity-copy studio-running-cloud"
              : `activity-copy${j.status === "error" ? "" : " ap-note"}`
          }
        >
          {queued
            ? `Waiting — ${queuePos}${queuePos === 1 ? "st" : queuePos === 2 ? "nd" : queuePos === 3 ? "rd" : "th"} in line`
            : running
              ? (studioStep ?? live?.label ?? "Working…")
              : j.status === "error"
                ? (friendlyError ?? "Stopped.")
                : // A job the APP stopped must not read like one the user
                  // chose to pause. `parkedReason` is set only when the room
                  // was locked (or the app closed) with this job in flight, so
                  // the card names what actually interrupted it — and says the
                  // checkpoint is still there, which is the whole reason Resume
                  // is worth pressing.
                  parkedReason
                  ? meter.figure
                    ? `${parkedReason} Picks up at ${meter.figure.done} of ${meter.figure.total}.`
                    : `${parkedReason} Picks up where it stopped.`
                  : meter.figure
                    ? `Paused at ${meter.figure.done} of ${meter.figure.total}`
                    : "Paused"}
        </span>
        {queued ? (
          <button
            className="subtle"
            title="Remove this job from the queue"
            onClick={() => void a.pauseJob(j.id)}
          >
            Remove
          </button>
        ) : running ? (
          <button
            className="subtle"
            title="Stop — it checkpoints so you can resume later"
            onClick={() => void a.pauseJob(j.id)}
          >
            Stop
          </button>
        ) : (
          <button className="subtle" onClick={() => void a.resumeJob(j.id)}>
            {j.status === "error" ? "Retry" : "Resume"}
          </button>
        )}
      </div>
    </div>
  );
}
