import { useState } from "react";
import { api, ScriptInfo, WorkflowRun } from "../../api";
import { ScriptIcon, PlayIcon, ClockIcon } from "../../icons";
import { WSState } from "../state";
import { WSActions } from "../actions";
import { SchedulePopover } from "../workflows/SchedulePopover";
import { RunHistory } from "../workflows/RunHistory";

function fmtWhen(ts: string | null | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

/** One script's row on the Scripts page: identity + deps/inputs/outputs chips,
 * approval state, last-run status, and Run / Schedule / History actions. */
export function ScriptRow({ sc, s, a }: { sc: ScriptInfo; s: WSState; a: WSActions }) {
  const [schedOpen, setSchedOpen] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);

  // Live progress for this script's latest run (workflow jobs are jobs).
  const jobId = sc.lastRun?.jobId ?? undefined;
  const live = jobId ? s.jobProgress[jobId] : undefined;
  const lastStatus = sc.lastRun?.status ?? null;

  async function toggleHistory() {
    if (histOpen) {
      setHistOpen(false);
      return;
    }
    setHistOpen(true);
    if (sc.workflowId) {
      try {
        setRuns(await api.getWorkflowRuns(sc.workflowId));
      } catch {
        setRuns([]);
      }
    }
  }

  return (
    <div className={`script-row${sc.changedSinceApproval ? " needs-review" : ""}`}>
      <div className="script-row-main">
        <span className="script-row-title" title={sc.name}>
          <ScriptIcon size={15} /> {sc.name}
          <span className="script-lang">{sc.lang}</span>
        </span>
        {sc.changedSinceApproval && (
          <span className="script-ribbon" title="This script changed since it was approved — review and run it to re-approve.">
            Needs review
          </span>
        )}
        <span className="script-row-status">
          {live ? (
            <span className="script-running">
              <span className="rec-dot pulsing" /> {live.label}
            </span>
          ) : lastStatus ? (
            <span className={`wf-badge ${lastStatus === "error" ? "dot-err" : "dot-ok"}`}>
              {lastStatus}
              {sc.lastRun?.finishedAt ? ` · ${fmtWhen(sc.lastRun.finishedAt)}` : ""}
            </span>
          ) : (
            <span className="caption">never run</span>
          )}
        </span>
      </div>

      <div className="script-chips">
        {sc.deps.length > 0 && (
          <span className="script-chip deps" title="Python packages (installed by uv)">
            📦 {sc.deps.join(", ")}
          </span>
        )}
        {sc.inputs.map((i) => (
          <span key={`in-${i}`} className="script-chip in" title="Reads this room file">
            → {i}
          </span>
        ))}
        {sc.outputs.map((o) => (
          <span key={`out-${o}`} className="script-chip out" title="Writes this room file back">
            ← {o}
          </span>
        ))}
        {sc.shortcut !== "none" && (
          <span className="script-chip shortcut" title="Shows as a one-click shortcut">
            {sc.shortcut === "global" ? "top-bar shortcut" : "file shortcut"}
          </span>
        )}
      </div>

      <div className="script-row-actions">
        <button
          className="subtle btn-ic"
          title="Run this script now — outputs are saved into the room"
          disabled={!!live}
          onClick={() => void a.runScript(sc.fileId)}
        >
          <PlayIcon size={13} /> Run
        </button>
        {/* Scheduling requires an approved script (the executor parks a scheduled
            run whose content isn't approved on this Mac). */}
        {sc.approved ? (
          <span className="script-sched-wrap">
            <button
              className={`subtle btn-ic${sc.schedule?.enabled ? " active" : ""}`}
              title="Schedule this script"
              onClick={() => setSchedOpen((o) => !o)}
            >
              <ClockIcon size={13} />
              {sc.schedule?.enabled ? `${sc.schedule.kind}` : "Schedule"}
            </button>
            {schedOpen && (
              <div className="script-sched-pop">
                <SchedulePopover
                  schedule={sc.schedule}
                  disabled={false}
                  onSave={(arg) => void a.scheduleScript(sc.fileId, arg)}
                  onClose={() => setSchedOpen(false)}
                />
              </div>
            )}
          </span>
        ) : (
          // Scheduling is locked until the script is approved. Render a clearly
          // DISABLED Schedule button — not tappable text that reads like an
          // action — so a click can't feel like a silent no-op. The wrapping
          // span carries the tooltip, since a disabled button swallows hover.
          <span
            className="script-sched-wrap"
            title="Run this script once and choose “Always allow” — then you can schedule it."
          >
            <button className="subtle btn-ic" disabled aria-disabled="true">
              <ClockIcon size={13} /> Schedule
            </button>
          </span>
        )}
        {sc.workflowId && (
          <button className="subtle btn-ic" onClick={() => void toggleHistory()}>
            {histOpen ? "Hide runs" : "Runs"}
          </button>
        )}
      </div>

      {histOpen && (
        <div className="script-history">
          <RunHistory runs={runs} nodeCount={1} />
        </div>
      )}
    </div>
  );
}
