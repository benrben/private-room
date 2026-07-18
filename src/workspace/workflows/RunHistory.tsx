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
                    <pre>{a}</pre>
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
