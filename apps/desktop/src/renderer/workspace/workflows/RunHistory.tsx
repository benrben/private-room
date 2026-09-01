import { useState } from "react";
import { api, WorkflowNode, WorkflowRun } from "../../api";
import { CircleCheckIcon } from "../../icons";
import { runDotClass } from "./selectors";

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

function parsedObject(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringField(value: Record<string, unknown>, name: string): string | null {
  return typeof value[name] === "string" ? value[name] : null;
}

function parseStep(raw: string): Step {
  const wf = parsedObject(raw);
  if (!wf) return { result: raw, skipped: false, branch: null, nodeLabel: null, nodeKind: null };
  return {
    result: stringField(wf, "result") ?? raw,
    skipped: wf.skipped === true,
    branch: stringField(wf, "branch"),
    nodeLabel: stringField(wf, "node_label"),
    nodeKind: stringField(wf, "node_kind"),
  };
}

function isScriptReport(value: Record<string, unknown>): boolean {
  return typeof value.exitCode === "number" && ("stdoutTail" in value || "stderrTail" in value);
}

/** A script node's result is itself a ScriptRunReport JSON (import mode). */
function asScriptReport(result: string): ScriptReport | null {
  const report = parsedObject(result);
  return report && isScriptReport(report) ? report as ScriptReport : null;
}

/** The copyable text for a step (the script streams for a report, else result). */
function copyText(step: Step): string {
  const report = asScriptReport(step.result);
  if (report) {
    return [report.stdoutTail, report.stderrTail].filter(Boolean).join("\n").trim() || step.result;
  }
  return step.result;
}

/** How many further indices to ask for once a batch came back full. */
const STEP_PROBE = 4;
/** A run cannot have more steps than this. A stored artifact index is a step
 * id in the plan, and a plan that long is a bug elsewhere — bound the walk
 * rather than let one keep asking. */
const MAX_RUN_STEPS = 200;

/** Every step artifact a finished run recorded.
 *
 * `hint` is the workflow's node count as the EDITOR has it now, which is not
 * this run's size: a run of the 6-step version, listed after two steps were
 * deleted (saved or not), showed four and said nothing about the rest. So the
 * hint only sizes the first batch, and the walk continues while artifacts keep
 * coming — the run's own length decides where it stops.
 */
async function fetchRunSteps(jobId: string, hint: number): Promise<(string | null)[]> {
  const steps: (string | null)[] = [];
  let want = Math.max(hint, 1);
  while (steps.length < MAX_RUN_STEPS) {
    const from = steps.length;
    const batch = await Promise.all(
      Array.from({ length: Math.min(want, MAX_RUN_STEPS - from) }, (_, i) =>
        api.getJobStepArtifact(jobId, from + i).catch(() => null),
      ),
    );
    steps.push(...batch);
    // A batch with nothing in it is past the end of what this run wrote — a
    // run that failed at step 2 recorded no step 3, and neither did a run of
    // exactly this many steps.
    if (batch.every((a) => a == null)) break;
    want = STEP_PROBE;
  }
  // Drop the empty tail the probe asked for, so "no step artifacts recorded"
  // still describes the run rather than the probe.
  while (steps.length > 0 && steps[steps.length - 1] == null) steps.pop();
  return steps;
}

function StepBody({ step }: { step: Step }) {
  const report = asScriptReport(step.result);
  if (report) return <ScriptReportBody report={report} />;
  return <PlainStepBody step={step} />;
}

function ScriptReportBody({ report }: { report: ScriptReport }) {
  const imported = (report.imported ?? []).flatMap((file) => file.name ? [file.name] : []);
  return (
    <div className="script-report">
      <span className={`wf-badge ${report.exitCode === 0 ? "dot-ok" : "dot-err"}`}>exit {report.exitCode}</span>
      <ScriptStream label="stdout" text={report.stdoutTail} />
      <ScriptStream label="stderr" text={report.stderrTail} error />
      <ImportedFiles names={imported} />
    </div>
  );
}

function ScriptStream({ label, text, error = false }: { label: string; text: string | undefined; error?: boolean }) {
  if (!text?.trim()) return null;
  return (
    <div className={`script-stream${error ? " err" : ""}`}>
      <strong>{label}</strong>
      <pre>{text}</pre>
    </div>
  );
}

function ImportedFiles({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return <div className="caption">Imported {names.length} file(s): {names.join(", ")}</div>;
}

function PlainStepBody({ step }: { step: Step }) {
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
      <StepHeader index={index} step={step} fallback={fallback} copied={copied} onCopy={copy} />
      <div className="run-step-body">
        <StepBody step={step} />
      </div>
    </div>
  );
}

function StepHeader({
  index,
  step,
  fallback,
  copied,
  onCopy,
}: {
  index: number;
  step: Step;
  fallback?: WorkflowNode;
  copied: boolean;
  onCopy: () => Promise<void>;
}) {
  return (
    <div className="run-step-head">
      <strong>{stepTitle(step, fallback, index)}</strong>
      <StepKind kind={step.nodeKind ?? fallback?.kind ?? null} />
      <StepBranch branch={step.branch} />
      <span className={`wf-badge ${step.skipped ? "" : "dot-ok"}`}>{step.skipped ? "skipped" : "done"}</span>
      <span className="run-step-spacer" />
      <CopyStepButton result={step.result} copied={copied} onCopy={onCopy} />
    </div>
  );
}

function stepTitle(step: Step, fallback: WorkflowNode | undefined, index: number): string {
  const fallbackLabel = fallback?.label ? String(fallback.label) : null;
  return step.nodeLabel ?? fallbackLabel ?? `Step ${index + 1}`;
}

function StepKind({ kind }: { kind: string | null }) {
  if (!kind) return null;
  return <span className="run-step-kind">{kind.replace(/_/g, " ")}</span>;
}

function StepBranch({ branch }: { branch: string | null }) {
  if (!branch) return null;
  return <span className="wf-badge">branch: {branch}</span>;
}

function CopyStepButton({ result, copied, onCopy }: { result: string; copied: boolean; onCopy: () => Promise<void> }) {
  if (!result.trim()) return null;
  return (
    <button className="subtle run-step-copy btn-ic" onClick={() => void onCopy()} title="Copy this step's output">
      {copied ? <><CircleCheckIcon size={12} /> Copied</> : "Copy"}
    </button>
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
    if (artifacts[run.id]) return;
    const jobId = run.jobId;
    // A run with no job never recorded anything — record that as an ANSWER, so
    // the empty-state line below is only ever shown once the fetch is settled.
    if (!jobId) {
      setArtifacts((a) => ({ ...a, [run.id]: [] }));
      return;
    }
    const steps = await fetchRunSteps(jobId, nodeCount);
    setArtifacts((a) => ({ ...a, [run.id]: steps }));
  }

  if (runs.length === 0) {
    return <div className="caption run-history-empty">No runs yet.</div>;
  }

  const collapsed = leadingFailureCount(runs);
  const shown = runsAfterCollapse(runs, collapsed);
  return (
    <div className="run-history nb-connect">
      <RunRows
        runs={shown}
        collapsed={collapsed}
        nodes={nodes}
        openRun={openRun}
        artifacts={artifacts}
        onToggle={toggle}
      />
    </div>
  );
}

/** Collapse a LEADING streak of identical failures (newest-first) into one
 * representative row + a count, so a script that failed 5× the same way reads
 * as a single incident here too — not five identical rows. */
function leadingFailureCount(runs: WorkflowRun[]): number {
  const firstErr = runError(runs[0]);
  let lead = 0;
  for (const r of runs) {
    // "error" is the ONLY failure status a run row is ever written with
    // (running | queued | paused | done | error — see db/workflows.rs). The old
    // `|| r.status === "failed"` half could never be true; the same dead check
    // was already removed from its Rust twin in commands/scripts.rs.
    if (!hasErrorFromRunStart(r, firstErr)) break;
    lead++;
  }
  return lead >= 2 ? lead : 0;
}

function runError(run: WorkflowRun | undefined): string {
  return run?.error ?? "";
}

function hasErrorFromRunStart(run: WorkflowRun, firstError: string): boolean {
  return run.status === "error" && runError(run) === firstError;
}

function runsAfterCollapse(runs: WorkflowRun[], collapsed: number): WorkflowRun[] {
  if (collapsed === 0) return runs;
  return [runs[0], ...runs.slice(collapsed)];
}

function RunRows({
  runs,
  collapsed,
  nodes,
  openRun,
  artifacts,
  onToggle,
}: {
  runs: WorkflowRun[];
  collapsed: number;
  nodes: WorkflowNode[] | undefined;
  openRun: string | null;
  artifacts: Record<string, (string | null)[]>;
  onToggle: (run: WorkflowRun) => Promise<void>;
}) {
  return (
    <>
      {runs.map((run, index) => (
        <RunRow
          key={run.id}
          run={run}
          collapsed={index === 0 ? collapsed : 0}
          nodes={nodes}
          expanded={openRun === run.id}
          steps={artifacts[run.id]}
          onToggle={onToggle}
        />
      ))}
    </>
  );
}

function RunRow({
  run,
  collapsed,
  nodes,
  expanded,
  steps,
  onToggle,
}: {
  run: WorkflowRun;
  collapsed: number;
  nodes: WorkflowNode[] | undefined;
  expanded: boolean;
  steps: (string | null)[] | undefined;
  onToggle: (run: WorkflowRun) => Promise<void>;
}) {
  return (
    <div className="run-row">
      <RunRowHead run={run} expanded={expanded} onToggle={onToggle} />
      <CollapsedFailureCount count={collapsed} />
      <RunStepArtifacts expanded={expanded} steps={steps} nodes={nodes} />
    </div>
  );
}

function RunRowHead({ run, expanded, onToggle }: { run: WorkflowRun; expanded: boolean; onToggle: (run: WorkflowRun) => Promise<void> }) {
  return (
    <button type="button" className="run-row-head" aria-expanded={expanded} onClick={() => void onToggle(run)}>
      <span className={`wf-badge ${runDotClass(run.status)}`}>{run.status}</span>
      <span className="run-row-trigger">{run.trigger}</span>
      <span className="run-row-when">{fmt(run.startedAt)}</span>
      {run.error && <span className="run-row-err">{run.error}</span>}
      <span aria-hidden className="run-row-caret">{expanded ? "▾" : "▸"}</span>
    </button>
  );
}

function CollapsedFailureCount({ count }: { count: number }) {
  if (count === 0) return null;
  const earlier = count - 1;
  const suffix = earlier === 1 ? "" : "s";
  return <div className="run-step caption">+ {earlier} earlier run{suffix} failed the same way</div>;
}

function RunStepArtifacts({
  expanded,
  steps,
  nodes,
}: {
  expanded: boolean;
  steps: (string | null)[] | undefined;
  nodes: WorkflowNode[] | undefined;
}) {
  if (!expanded) return null;
  if (steps === undefined) return <div className="run-step caption">Loading this run's steps…</div>;
  if (steps.every((step) => step == null)) return <div className="run-step caption">No step artifacts recorded.</div>;
  return <div>{steps.map((step, index) => artifactRow(step, index, nodes))}</div>;
}

function artifactRow(step: string | null, index: number, nodes: WorkflowNode[] | undefined) {
  if (step == null) return null;
  return <StepRow key={index} index={index} raw={step} fallback={nodes?.[index]} />;
}
