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

/** The human cause line from a script's error text — the executor prefixes
 * "The script failed (exit N):" then the stderr tail; show the most telling
 * line rather than the whole dump. */
function causeLine(err: string): string {
  const lines = err.split("\n").map((l) => l.trim()).filter(Boolean);
  // Prefer the last non-empty stderr line (usually the actual exception);
  // fall back to the first line.
  return lines[lines.length - 1] || lines[0] || err;
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
          <ScriptIcon size={14} /> {sc.name}
          <span className="script-lang">{sc.lang}</span>
        </span>
        {sc.changedSinceApproval && (
          // `changedSinceApproval` means "this exact content is not remembered
          // on this Mac" — and it CANNOT tell an "Allow once" run apart from an
          // edit after "Always allow" (see the Rust field's doc comment). So the
          // tooltip must not claim the script changed: approving a script just
          // this once left it permanently ribboned as though someone had edited
          // a file they never touched.
          <span
            className="script-ribbon"
            title="This script's current content isn't remembered on this Mac — running it will ask for approval again. That is normal after an “Allow once” run, and it is also what an edit looks like."
          >
            Needs review
          </span>
        )}
        <span className="script-row-status">
          {live ? (
            <span className="script-running">
              <span className="rec-dot" /> {live.label}
            </span>
          ) : sc.consecutiveFailures >= 1 ? (
            <span className="wf-badge dot-err">
              Failed {sc.consecutiveFailures}×
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

      {/* ONE incident instead of N identical error rows: cause + a single
          recovery path. The old raw-error-times-5 spam lived here. */}
      {!live && sc.consecutiveFailures >= 1 && sc.lastError && (
        <div className="script-incident">
          <div className="script-incident-body">
            <div className="script-incident-title">
              This script failed {sc.consecutiveFailures}
              {sc.consecutiveFailures === 1 ? " time" : " times in a row — same error"}
            </div>
            <div className="script-incident-cause" title={sc.lastError}>
              {causeLine(sc.lastError)}
            </div>
          </div>
          <div className="script-incident-actions">
            <button
              className="subtle btn-ic"
              title="Open the script to fix the cause above"
              onClick={() => void a.viewFile(sc.fileId)}
            >
              Open to fix
            </button>
            <button
              className="subtle btn-ic"
              disabled={!!live}
              // Same restraint as the ribbon: the flag does not know whether
              // anyone edited anything, so neither the label nor the tooltip
              // may say so.
              title={
                sc.changedSinceApproval
                  ? "Run this script's current content — it will ask for approval first"
                  : "Run again"
              }
              onClick={() => void a.runScript(sc.fileId)}
            >
              <PlayIcon size={12} />{" "}
              {sc.changedSinceApproval ? "Run current version" : "Run again"}
            </button>
          </div>
        </div>
      )}

      {/* The manifest, as notebook fields rather than as a row of chips.
          A chip carried its meaning only in a hover tooltip ("→ portfolio.csv"
          with title "Reads this room file"), which a keyboard never sees and a
          screen reader reads as an arrow. The keys are the same three words the
          run-consent card uses — Installs / Reads / Writes back — so the page
          and the card that gates it describe a script in one vocabulary. */}
      {(sc.deps.length > 0 ||
        sc.inputs.length > 0 ||
        sc.outputs.length > 0 ||
        sc.shortcut !== "none") && (
        <dl className="script-fields">
          {sc.deps.length > 0 && (
            <div className="script-field">
              <dt title="Python packages (installed by uv)">Installs</dt>
              <dd>
                <code>{sc.deps.join(", ")}</code>
              </dd>
            </div>
          )}
          {sc.inputs.length > 0 && (
            <div className="script-field">
              <dt title="Reads these room files">Reads</dt>
              <dd>
                <code>{sc.inputs.join(", ")}</code>
              </dd>
            </div>
          )}
          {sc.outputs.length > 0 && (
            <div className="script-field">
              <dt title="Writes these room files back">Writes back</dt>
              <dd>
                <code>{sc.outputs.join(", ")}</code>
              </dd>
            </div>
          )}
          {sc.shortcut !== "none" && (
            <div className="script-field">
              <dt title="Shows as a one-click shortcut">Shortcut</dt>
              <dd>{sc.shortcut === "global" ? "top-bar shortcut" : "file shortcut"}</dd>
            </div>
          )}
        </dl>
      )}

      {/* An unapproved script has ALWAYS been blocked — `run_script_inner`
          refuses content whose hash is not approved on this Mac. Until now the
          only place that said so was the Run button's tooltip, so a script that
          had never been approved and never been run looked exactly like one
          that had been. A caution note states it in words, at readable size, in
          the interface sans: this is a security fact, never an aside, and never
          the hand. */}
      {!sc.approved && (
        <p className="script-caution">
          This version has not been approved on this Mac.{" "}
          <strong>Review script</strong> opens the run-consent card, which
          spells out exactly what would run and what it would be allowed to
          touch — nothing runs until you approve it.
        </p>
      )}

      <div className="script-row-actions">
        {/* An unapproved script has ALWAYS been blocked — `run_script_inner`
            refuses to execute content whose hash is not approved on this Mac,
            and raises the consent card naming the interpreter, the declared
            manifest and every room file the run would decrypt. What was wrong
            was the BUTTON: labelled "Run", it promised execution that could not
            happen, so the review gate read as broken rather than as working.
            Live QA reported it twice as "unreviewed scripts can still run".
            The gate is unchanged; the button now says what it actually does.

            It is also the one action in this row drawn as a real outlined
            control — Schedule and Runs stay quiet — so the row has a first
            thing to press instead of four equal-weight links. */}
        <button
          className={`btn-ic script-go${sc.approved ? "" : " needs-review"}`}
          title={
            sc.approved
              ? "Run this script now — outputs are saved into the room"
              : "This version has not been approved — opens the review card; nothing runs until you approve it"
          }
          disabled={!!live}
          onClick={() => void a.runScript(sc.fileId)}
        >
          <PlayIcon size={14} /> {sc.approved ? "Run" : "Review script"}
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
              <ClockIcon size={14} />
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
              <ClockIcon size={14} /> Schedule
            </button>
          </span>
        )}
        {sc.workflowId && (
          <button
            className="subtle btn-ic"
            aria-expanded={histOpen}
            onClick={() => void toggleHistory()}
          >
            {histOpen ? "Hide runs" : "Runs"}
          </button>
        )}
      </div>

      {histOpen && (
        <div className="script-history">
          {/* The log gets a name of its own: without one it opened straight
              onto a bare list of statuses hanging off the bottom of the row. */}
          <div className="script-history-label">Run history</div>
          <RunHistory runs={runs} nodeCount={1} />
        </div>
      )}
    </div>
  );
}
