import { useState } from "react";
import { api, WorkflowRun } from "../../api";

type Props = {
  runs: WorkflowRun[];
  nodeCount: number;
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

/** A script node's step result is a ScriptRunReport JSON. Recognize it so we can
 * render stdout/stderr instead of dumping the raw internal object. */
function asScriptReport(result: string): ScriptReport | null {
  try {
    const r = JSON.parse(result);
    if (
      r &&
      typeof r === "object" &&
      typeof r.exitCode === "number" &&
      ("stdoutTail" in r || "stderrTail" in r)
    ) {
      return r as ScriptReport;
    }
  } catch {
    /* not JSON — a plain-text artifact */
  }
  return null;
}

/** One step's stored artifact. Artifacts are a WfArtifact JSON
 * ({ result, skipped, ... }); unwrap to the human-facing `result`, and for a
 * script node — whose result is itself a ScriptRunReport JSON — show a clean
 * stdout / stderr / exit-code view instead of the raw internal JSON. */
function StepArtifact({ raw }: { raw: string }) {
  let result = raw;
  let skipped = false;
  try {
    const wf = JSON.parse(raw);
    if (wf && typeof wf === "object") {
      if (typeof wf.result === "string") result = wf.result;
      skipped = wf.skipped === true;
    }
  } catch {
    /* not a WfArtifact wrapper — show the raw string as-is */
  }

  const report = asScriptReport(result);
  if (report) {
    const imported = (report.imported ?? []).map((f) => f.name).filter(Boolean);
    return (
      <div className="script-report">
        <span className={`wf-badge ${report.exitCode === 0 ? "dot-ok" : "dot-err"}`}>
          exit {report.exitCode}
        </span>
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
          <div className="caption">Imported {imported.length} file(s): {imported.join(", ")}</div>
        )}
      </div>
    );
  }
  if (skipped && !result.trim()) {
    return <div className="caption">Step skipped.</div>;
  }
  return <pre>{result}</pre>;
}

export function RunHistory({ runs, nodeCount }: Props) {
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
        Array.from({ length: Math.max(nodeCount, 1) }, (_, i) =>
          api.getJobStepArtifact(jobId, i).catch(() => null),
        ),
      );
      setArtifacts((a) => ({ ...a, [run.id]: steps }));
    }
  }

  if (runs.length === 0) {
    return <div className="caption">No runs yet.</div>;
  }

  return (
    <div className="run-history">
      {runs.map((r) => (
        <div key={r.id} className="run-row">
          <div className="run-row-head" onClick={() => void toggle(r)}>
            <span className={`wf-badge ${r.status === "error" ? "dot-err" : "dot-ok"}`}>
              {r.status}
            </span>
            <span className="run-row-trigger">{r.trigger}</span>
            <span style={{ flex: 1 }}>{fmt(r.startedAt)}</span>
            {r.error && <span style={{ color: "#b33" }}>{r.error}</span>}
            <span style={{ opacity: 0.5 }}>{openRun === r.id ? "▾" : "▸"}</span>
          </div>
          {openRun === r.id && (
            <div>
              {(artifacts[r.id] ?? []).map((a, i) =>
                a == null ? null : (
                  <div key={i} className="run-step">
                    <strong>Step {i + 1}</strong>
                    <StepArtifact raw={a} />
                  </div>
                ),
              )}
              {(artifacts[r.id] ?? []).every((a) => a == null) && (
                <div className="run-step caption">No step artifacts recorded.</div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
