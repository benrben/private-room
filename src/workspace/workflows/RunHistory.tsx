import { useState } from "react";
import { api, WorkflowNode, WorkflowRun } from "../../api";
import { CircleCheckIcon } from "../../icons";

type Props = {
  runs: WorkflowRun[];
  nodeCount: number;
  /** The workflow's current nodes — a best-effort fallback label for OLD runs
   * whose artifacts predate stored node metadata (new runs carry their own). */
  nodes?: WorkflowNode[];
};

function fmt(ts: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

type ScriptReport = {
  exitCode: number;
  imported?: { name?: string }[];
  skipped?: string[];
  stdoutTail?: string;
  stderrTail?: string;
};

/** One step's stored artifact, already unwrapped from the WfArtifact envelope. */
type Step = {
  result: string;
  skipped: boolean;
  branch: string | null;
  nodeLabel: string | null;
  nodeKind: string | null;
};

function parseStep(raw: string): Step {
  try {
    const wf = JSON.parse(raw);
    if (wf && typeof wf === "object") {
      return {
        result: typeof wf.result === "string" ? wf.result : raw,
        skipped: wf.skipped === true,
        branch: typeof wf.branch === "string" ? wf.branch : null,
        nodeLabel: typeof wf.node_label === "string" ? wf.node_label : null,
        nodeKind: typeof wf.node_kind === "string" ? wf.node_kind : null,
      };
    }
  } catch {
    /* not a WfArtifact wrapper — show the raw string as-is */
  }
  return { result: raw, skipped: false, branch: null, nodeLabel: null, nodeKind: null };
}

/** A script node's result is itself a ScriptRunReport JSON (import mode). */
function asScriptReport(result: string): ScriptReport | null {
  try {
    const r = JSON.parse(result);
    if (r && typeof r === "object" && typeof r.exitCode === "number" && ("stdoutTail" in r || "stderrTail" in r)) {
      return r as ScriptReport;
    }
  } catch {
    /* not JSON — a plain-text artifact */
  }
  return null;
}

/** The copyable text for a step (the script streams for a report, else result). */
function copyText(step: Step): string {
  const report = asScriptReport(step.result);
  if (report) {
    return [report.stdoutTail, report.stderrTail].filter(Boolean).join("\n").trim() || step.result;
  }
  return step.result;
}

function StepBody({ step }: { step: Step }) {
  const report = asScriptReport(step.result);
  if (report) {
    const imported = (report.imported ?? []).map((f) => f.name).filter(Boolean);
    return (
      <div className="script-report">
        <span className={`wf-badge ${report.exitCode === 0 ? "dot-ok" : "dot-err"}`}>exit {report.exitCode}</span>
        {report.stdoutTail?.trim() ? (
          <div className="script-stream">
            <strong>stdout</strong>
            <pre>{report.stdoutTail}</pre>
          </div>
        ) : null}
        {report.stderrTail?.trim() ? (
          <div className="script-stream err">
            <strong>stderr</strong>
            <pre>{report.stderrTail}</pre>
          </div>
        ) : null}
        {imported.length > 0 && (
          <div className="caption">
            Imported {imported.length} file(s): {imported.join(", ")}
          </div>
        )}
      </div>
    );
  }
  if (step.skipped && !step.result.trim()) {
    return <div className="caption">Step skipped (an upstream branch was not taken).</div>;
  }
  return <pre>{step.result}</pre>;
}

/** One run's step, with a node-named header + a scrollable, copyable body.
 * `fallback` is the def node at this index — used only when the artifact predates
 * stored node metadata (a best-effort label for old runs). */
function StepRow({ index, raw, fallback }: { index: number; raw: string; fallback?: WorkflowNode }) {
  const [copied, setCopied] = useState(false);
  const step = parseStep(raw);
  const fbLabel = fallback?.label ? String(fallback.label) : null;
  const fbKind = fallback?.kind ?? null;
  const kindRaw = step.nodeKind ?? fbKind;
  const kind = kindRaw ? kindRaw.replace(/_/g, " ") : null;
  const title = step.nodeLabel || fbLabel || `Step ${index + 1}`;
  const statusLabel = step.skipped ? "skipped" : "done";

  async function copy() {
    try {
      await navigator.clipboard.writeText(copyText(step));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — no-op */
    }
  }

  return (
    <div className="run-step">
      <div className="run-step-head">
        <strong>{title}</strong>
        {kind && <span className="run-step-kind">{kind}</span>}
        {step.branch && <span className="wf-badge">branch: {step.branch}</span>}
        <span className={`wf-badge ${step.skipped ? "" : "dot-ok"}`}>{statusLabel}</span>
        <span style={{ flex: 1 }} />
        {step.result.trim() && (
          <button className="subtle run-step-copy btn-ic" onClick={() => void copy()} title="Copy this step's output">
            {copied ? (<><CircleCheckIcon size={12} /> Copied</>) : "Copy"}
          </button>
        )}
      </div>
      <div className="run-step-body">
        <StepBody step={step} />
      </div>
    </div>
  );
}

export function RunHistory({ runs, nodeCount, nodes }: Props) {
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<Record<string, (string | null)[]>>({});

  async function toggle(run: WorkflowRun) {
    if (openRun === run.id) {
      setOpenRun(null);
      return;
    }
    setOpenRun(run.id);
    if (!artifacts[run.id] && run.jobId) {
      const jobId = run.jobId;
      const steps = await Promise.all(
        Array.from({ length: Math.max(nodeCount, 1) }, (_, i) => api.getJobStepArtifact(jobId, i).catch(() => null)),
      );
      setArtifacts((a) => ({ ...a, [run.id]: steps }));
    }
  }

  if (runs.length === 0) {
    return <div className="caption">No runs yet.</div>;
  }

  return (
    <div className="run-history">
      {runs.map((r) => {
        const expanded = openRun === r.id;
        return (
          <div key={r.id} className="run-row">
            <button
              type="button"
              className="run-row-head"
              aria-expanded={expanded}
              onClick={() => void toggle(r)}
            >
              <span className={`wf-badge ${r.status === "error" ? "dot-err" : "dot-ok"}`}>{r.status}</span>
              <span className="run-row-trigger">{r.trigger}</span>
              <span style={{ flex: 1 }}>{fmt(r.startedAt)}</span>
              {r.error && <span style={{ color: "#b33" }}>{r.error}</span>}
              <span aria-hidden style={{ opacity: 0.5 }}>{expanded ? "▾" : "▸"}</span>
            </button>
            {expanded && (
              <div>
                {(artifacts[r.id] ?? []).map((a, i) =>
                  a == null ? null : <StepRow key={i} index={i} raw={a} fallback={nodes?.[i]} />,
                )}
                {(artifacts[r.id] ?? []).every((a) => a == null) && (
                  <div className="run-step caption">No step artifacts recorded.</div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
