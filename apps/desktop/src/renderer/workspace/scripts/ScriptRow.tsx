import { useState } from "react";
import { api, ScriptInfo, WorkflowRun } from "../../api";
import { ScriptIcon, PlayIcon, ClockIcon } from "../../icons";
import { WSState } from "../state";
import { WSActions } from "../actions";
import { SchedulePopover } from "../workflows/SchedulePopover";
import { RunHistory } from "../workflows/RunHistory";

function fmtWhen(timestamp: string | null | undefined): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

const GUIDANCE_OPENERS = [
  "Couldn't auto-install '",
  "This script imports a package that isn't installed.",
];

function splitError(error: string): { cause: string; advice: string } {
  const paragraphs = error.split("\n\n");
  const tail = paragraphs.length > 1 ? paragraphs[paragraphs.length - 1].trim() : "";
  const advice = GUIDANCE_OPENERS.some((opener) => tail.startsWith(opener)) ? tail : "";
  const stderr = advice ? paragraphs.slice(0, -1).join("\n\n") : error;
  const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean);
  return {
    cause: lines[lines.length - 1] || lines[0] || error.trim(),
    advice: advice.replace(/\s+/g, " "),
  };
}

function scriptLive(sc: ScriptInfo, state: WSState) {
  const jobId = sc.lastRun?.jobId ?? undefined;
  return jobId ? state.jobProgress[jobId] : undefined;
}

function ScriptTitle({ sc }: { sc: ScriptInfo }) {
  return <span className="script-row-title" title={sc.name}>
    <ScriptIcon size={14} /> {sc.name}
    <span className="script-lang">{sc.lang}</span>
  </span>;
}

function ReviewRibbon({ changed }: { changed: boolean }) {
  if (!changed) return null;
  return <span
    className="script-ribbon"
    title="This script's current content isn't remembered on this Mac — running it will ask for approval again. That is normal after an “Allow once” run, and it is also what an edit looks like."
  >
    Needs review
  </span>;
}

function LastRunStatus({ sc }: { sc: ScriptInfo }) {
  const status = sc.lastRun?.status;
  if (!status) return <span className="caption">never run</span>;
  const finishedAt = sc.lastRun?.finishedAt;
  return <span className={`wf-badge ${status === "error" ? "dot-err" : "dot-ok"}`}>
    {status}{finishedAt ? ` · ${fmtWhen(finishedAt)}` : ""}
  </span>;
}

function ScriptRunStatus({ live, sc }: { live: ReturnType<typeof scriptLive>; sc: ScriptInfo }) {
  if (live) return <span className="script-running"><span className="rec-dot" /> {live.label}</span>;
  if (sc.consecutiveFailures >= 1) return <span className="wf-badge dot-err">Failed {sc.consecutiveFailures}×</span>;
  return <LastRunStatus sc={sc} />;
}

function ScriptHeader({ live, sc }: { live: ReturnType<typeof scriptLive>; sc: ScriptInfo }) {
  return <div className="script-row-main">
    <ScriptTitle sc={sc} />
    <ReviewRibbon changed={sc.changedSinceApproval} />
    <span className="script-row-status"><ScriptRunStatus live={live} sc={sc} /></span>
  </div>;
}

function incidentTitle(count: number) {
  return count === 1 ? " time" : " times in a row — same error";
}

function IncidentActions({ sc, a }: { sc: ScriptInfo; a: WSActions }) {
  return <div className="script-incident-actions">
    <button className="subtle btn-ic" title="Open the script to fix the cause above" onClick={() => void a.viewFile(sc.fileId)}>Open to fix</button>
    <button
      className="subtle btn-ic"
      title={sc.changedSinceApproval ? "Run this script's current content — it will ask for approval first" : "Run again"}
      onClick={() => void a.runScript(sc.fileId)}
    >
      <PlayIcon size={12} /> {sc.changedSinceApproval ? "Run current version" : "Run again"}
    </button>
  </div>;
}

function ScriptIncident({ sc, a, live }: { sc: ScriptInfo; a: WSActions; live: ReturnType<typeof scriptLive> }) {
  if (live || sc.consecutiveFailures < 1 || !sc.lastError) return null;
  const incident = splitError(sc.lastError);
  return <div className="script-incident">
    <div className="script-incident-body">
      <div className="script-incident-title">This script failed {sc.consecutiveFailures}{incidentTitle(sc.consecutiveFailures)}</div>
      <div className="script-incident-cause" title={sc.lastError}>{incident.cause}</div>
      {incident.advice && <div className="caption">{incident.advice}</div>}
    </div>
    <IncidentActions sc={sc} a={a} />
  </div>;
}

function ScriptField({ title, value }: { title: string; value: string }) {
  return <div className="script-field"><dt title={title}>{title}</dt><dd><code>{value}</code></dd></div>;
}

function ListField({ title, values }: { title: string; values: string[] }) {
  if (values.length === 0) return null;
  return <ScriptField title={title} value={values.join(", ")} />;
}

function ScriptShortcut({ shortcut }: { shortcut: ScriptInfo["shortcut"] }) {
  if (shortcut === "none") return null;
  return <div className="script-field"><dt title="Shows as a one-click shortcut">Shortcut</dt><dd>{shortcut === "global" ? "top-bar shortcut" : "file shortcut"}</dd></div>;
}

function hasManifest(sc: ScriptInfo) {
  return sc.deps.length > 0 || sc.inputs.length > 0 || sc.outputs.length > 0 || sc.shortcut !== "none";
}

function ScriptManifest({ sc }: { sc: ScriptInfo }) {
  if (!hasManifest(sc)) return null;
  return <dl className="script-fields">
    <ListField title="Installs" values={sc.deps} />
    <ListField title="Reads" values={sc.inputs} />
    <ListField title="Writes back" values={sc.outputs} />
    <ScriptShortcut shortcut={sc.shortcut} />
  </dl>;
}

function ApprovalCaution({ approved }: { approved: boolean }) {
  if (approved) return null;
  return <p className="script-caution">
    This version has not been approved on this Mac. <strong>Review script</strong> opens the run-consent card, which spells out exactly what would run and what it would be allowed to touch — nothing runs until you approve it.
  </p>;
}

function ScriptRunButton({ sc, a, live }: { sc: ScriptInfo; a: WSActions; live: ReturnType<typeof scriptLive> }) {
  const label = sc.approved ? "Run" : "Review script";
  const title = sc.approved
    ? "Run this script now — outputs are saved into the room"
    : "This version has not been approved — opens the review card; nothing runs until you approve it";
  return <button className={`btn-ic script-go${sc.approved ? "" : " needs-review"}`} title={title} disabled={!!live} onClick={() => void a.runScript(sc.fileId)}>
    <PlayIcon size={14} /> {label}
  </button>;
}

function ScheduleControl({ sc, a }: { sc: ScriptInfo; a: WSActions }) {
  const [open, setOpen] = useState(false);
  if (!sc.approved) return <span className="script-sched-wrap" title="Run this script once and choose “Always allow” — then you can schedule it.">
    <button className="subtle btn-ic" disabled aria-disabled="true"><ClockIcon size={14} /> Schedule</button>
  </span>;
  return <span className="script-sched-wrap">
    <button className={`subtle btn-ic${sc.schedule?.enabled ? " active" : ""}`} title="Schedule this script" onClick={() => setOpen((value) => !value)}>
      <ClockIcon size={14} />{sc.schedule?.enabled ? `${sc.schedule.kind}` : "Schedule"}
    </button>
    {open && <div className="script-sched-pop"><SchedulePopover schedule={sc.schedule} disabled={false} onSave={(arg) => void a.scheduleScript(sc.fileId, arg)} onClose={() => setOpen(false)} /></div>}
  </span>;
}

function RunHistoryControl({ workflowId }: { workflowId: string | null | undefined }) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  async function toggleHistory() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (!workflowId) return;
    try {
      setRuns(await api.getWorkflowRuns(workflowId));
    } catch {
      setRuns([]);
    }
  }
  if (!workflowId) return null;
  return <>
    <button className="subtle btn-ic" aria-expanded={open} onClick={() => void toggleHistory()}>{open ? "Hide runs" : "Runs"}</button>
    {open && <div className="script-history"><div className="script-history-label">Run history</div><RunHistory runs={runs} nodeCount={1} /></div>}
  </>;
}

function ScriptActions({ sc, a, live }: { sc: ScriptInfo; a: WSActions; live: ReturnType<typeof scriptLive> }) {
  return <div className="script-row-actions">
    <ScriptRunButton sc={sc} a={a} live={live} />
    <ScheduleControl sc={sc} a={a} />
    <RunHistoryControl workflowId={sc.workflowId} />
  </div>;
}

/** One script's identity, permission state, run recovery, and controls. */
export function ScriptRow({ sc, s, a }: { sc: ScriptInfo; s: WSState; a: WSActions }) {
  const live = scriptLive(sc, s);
  return <div className={`script-row${sc.changedSinceApproval ? " needs-review" : ""}`}>
    <ScriptHeader sc={sc} live={live} />
    <ScriptIncident sc={sc} a={a} live={live} />
    <ScriptManifest sc={sc} />
    <ApprovalCaution approved={sc.approved} />
    <ScriptActions sc={sc} a={a} live={live} />
  </div>;
}
