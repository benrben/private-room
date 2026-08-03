import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { RoomInfo } from "../api";
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
import ChatPane from "./ChatPane";
import StudioShelf from "./StudioShelf";
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
  return (
    <>
      <div
        className="assistant-header"
        role="tablist"
        aria-label="AI tools"
      >
        <button
          className="assistant-tab"
          role="tab"
          aria-selected={s.aiTab === "chat"}
          aria-label="Chat"
          data-tip="Chat"
          onClick={() => s.setAiTab("chat")}
        >
          <ChatBubbleIcon size={14} />
          <span>Chat</span>
        </button>
        <button
          className="assistant-tab"
          role="tab"
          aria-selected={s.aiTab === "studio"}
          aria-label="Studio"
          data-tip="Studio"
          onClick={() => s.setAiTab("studio")}
        >
          <SparkIcon size={14} />
          <span>Studio</span>
        </button>
        <button
          className="assistant-tab"
          role="tab"
          aria-selected={s.aiTab === "activity"}
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
          {(pendingApprovals > 0 || jobsRunning > 0) && (
            <span
              className={`tab-dot${pendingApprovals === 0 ? " busy" : ""}`}
              aria-hidden="true"
              title={
                pendingApprovals > 0
                  ? "Something needs your approval"
                  : "Background work is running"
              }
            />
          )}
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
              {s.attachments.length > 0 ? (
                <button
                  className="context-count"
                  title="Change which files are attached"
                  onClick={() => {
                    s.setLibraryTab("sources");
                    layout.showPane("library");
                  }}
                >
                  {s.attachments.length} attached source
                  {s.attachments.length === 1 ? "" : "s"}
                </button>
              ) : (
                <button
                  className="context-count"
                  title="Pick specific files for the AI to answer from"
                  onClick={() => {
                    s.setLibraryTab("sources");
                    layout.showPane("library");
                  }}
                >
                  the whole room
                </button>
              )}
            </span>
            {(() => {
              // Same vocabulary as the top-bar badge and status-bar trust chip
              // (workspace/markup.ts trustState) — this pill must never say
              // something different about the same room's data route.
              const trust = trustState(cloud, s.privacyOn);
              return (
                <span className={`local-mini ${trust.tone}`} title={trust.title}>
                  {cloud ? (
                    <CloudIcon size={11} />
                  ) : (
                    <span className="status-dot" aria-hidden />
                  )}
                  <span>{trust.label}</span>
                </span>
              );
            })()}
          </div>
          <ChatPane s={s} a={a} info={info} />
        </>
      )}

      {s.aiTab === "studio" && <StudioView s={s} a={a} area={area} />}

      {s.aiTab === "activity" && <ActivityPanel s={s} a={a} />}
    </>
  );
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
  const jobRunning = s.jobs.some(
    (j) => j.status === "running" || j.status === "queued",
  );
  return (
    <div className="studio-tab-view">
      <p className="studio-intro">
        Turn {scope ? "the open file" : "this room's sources"} into something
        useful. Outputs are saved back into the room.
      </p>
      <StudioShelf scope={scope} s={s} a={a} />
      <div className="studio-section-title">Whole room</div>
      <button
        className="studio-row"
        disabled={s.files.length === 0 || s.summaryStarting || jobRunning}
        title="Write a short overview of this room and what's inside — runs in the background"
        onClick={() => void a.startDeepSummary()}
      >
        <span className="studio-row-icon">
          <SparkIcon size={15} />
        </span>
        <span className="studio-row-text">
          <span className="studio-row-title">Summarize the room</span>
          <span className="studio-row-copy">
            A cited overview of everything inside
          </span>
        </span>
        <span className="studio-row-state">
          {s.summaryStarting || jobRunning ? "Working…" : "Create"}
        </span>
      </button>
      <div className="studio-note">
        <strong>Private by design.</strong> Studio uses only this room's
        content{isCloudRoute(s.model, s.ai) ? " — but the current engine is a cloud model, so prompts leave this Mac" : ", processed on this Mac"}.
      </div>
    </div>
  );
}

/* ---------- Activity tab ---------- */

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
  // A recording is "being written out" while EITHER signal is up — the two
  // arrive a beat apart, and the counters use the same rule.
  const savingRec = s.recSave != null || s.recLive?.status === "saving";
  const nothing =
    pendingApprovals === 0 &&
    runningJobCount(s) === 0 &&
    parked.length === 0 &&
    history.length === 0 &&
    !s.importProgress;

  return (
    <div className="activity-view">
      <p className="activity-summary">
        Background work, imports, saves, and consent requests stay in one
        predictable place.
      </p>

      {pendingApprovals > 0 && (
        <>
          <div className="activity-group-title">Needs your approval</div>
          {s.scriptApprovals.map((r) => (
            <div key={r.id} className="activity-row">
              <div className="activity-row-head">
                <span className="activity-row-title">Run script {r.name}?</span>
                <span className="activity-state">Waiting</span>
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
                <span className="activity-state">Waiting</span>
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
                <span className="activity-state">Waiting</span>
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
                <span className="activity-state">Diff ready</span>
              </div>
              <div className="activity-copy">
                Review the proposed change before anything is written.
              </div>
            </div>
          ))}
        </>
      )}

      {/* The LIVE half: work in flight and work waiting to be picked back up.
          Everything in here is actionable — Stop, Remove, Resume, Retry. */}
      <section className="activity-live" aria-label="Work happening now">
        {(running.length > 0 ||
          s.summaryStarting ||
          s.importProgress ||
          s.studioStep ||
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
            </div>
            <div className="activity-copy">{s.ocrFiles.join(", ")}</div>
            <div className="activity-progress">
              <span className="indeterminate" />
            </div>
          </div>
        )}

        {/* AUDIT 262: what the Studio is doing right now. Rust named each step
            from the start and nothing displayed it, so a flashcard deck or a
            mind map sat on "Starting…" for the whole run — minutes, on a local
            model — and the step that says "your cloud AI is writing (content
            leaves this Mac)" never reached the person it is about. */}
        {s.studioStep && (
          <div className="activity-row" role="status">
            <div className="activity-row-head">
              <span className="activity-row-title">Studio</span>
            </div>
            <div className="activity-copy">{s.studioStep}</div>
            <div className="activity-progress">
              <span className="indeterminate" />
            </div>
          </div>
        )}

        {s.importProgress && (
          <div className="activity-row" role="status">
            <div className="activity-row-head">
              <span className="activity-row-title">
                Importing {s.importProgress.done + 1} of {s.importProgress.total}
              </span>
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
          !s.jobs.some((j) => j.status === "running" || j.status === "queued") && (
            <div className="activity-row" role="status">
              <div className="activity-row-head">
                <span className="activity-row-title">Room summary</span>
                <span className="activity-state">Starting…</span>
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
              {s.recSave && (
                <span className="activity-state">{elapsedOf(s.recSave.startedAt)}</span>
              )}
            </div>
            <div className="activity-copy">
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
          they can still act on from what is only a record. Nothing in here has a
          button — a finished job is not a thing you resume. */}
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
          {shownHistory.map((j) => (
            <HistoryRow key={j.id} j={j} />
          ))}
        </section>
      )}

      {nothing && (
        <div className="activity-empty">
          <ActivityIcon size={18} />
          <p>
            Nothing running right now, and nothing finished yet. Studio jobs,
            workflow runs, imports and approval requests appear here while they
            run, then move down to History when they are done.
          </p>
        </div>
      )}
    </div>
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
        <span className="activity-state">
          {Number.isNaN(when) ? "" : new Date(when).toLocaleString()}
        </span>
      </div>
      <div className="activity-copy">
        Finished
        {j.total > 0 ? ` — ${Math.min(j.cursor, j.total)} of ${j.total} steps` : ""}
      </div>
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
  const done = live?.done ?? j.cursor;
  const total = Math.max(live?.total ?? j.total, 1);
  // Only meaningful while the job is stopped-but-resumable; a running job is
  // not being interrupted by anything, and the backend clears the column the
  // moment it moves off 'paused'.
  const parkedReason = !running ? (j.parkedReason ?? null) : null;
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
        {running ? (
          <span className="activity-state">{elapsedOf(j.createdAt)}</span>
        ) : (
          <button
            className="chip-btn"
            title="Dismiss this job"
            aria-label="Dismiss this job"
            onClick={() => void a.dismissJob(j.id)}
          >
            <CloseIcon size={11} />
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
      <div className="activity-progress">
        <span
          className={running && !live ? "indeterminate" : undefined}
          style={
            running && !live
              ? undefined
              : {
                  width: `${Math.min(100, Math.round((done / total) * 100))}%`,
                }
          }
        />
      </div>
      <div className="activity-row-foot">
        <span className="activity-copy">
          {queued
            ? `Waiting — ${queuePos}${queuePos === 1 ? "st" : queuePos === 2 ? "nd" : queuePos === 3 ? "rd" : "th"} in line`
            : running
              ? (live?.label ?? "Working…")
              : j.status === "error"
                ? (friendlyError ?? "Stopped.")
                : // A job the APP stopped must not read like one the user
                  // chose to pause. `parkedReason` is set only when the room
                  // was locked (or the app closed) with this job in flight, so
                  // the card names what actually interrupted it — and says the
                  // checkpoint is still there, which is the whole reason Resume
                  // is worth pressing.
                  parkedReason
                  ? `${parkedReason} Picks up at ${done} of ${total}.`
                  : `Paused at ${done} of ${total}`}
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
