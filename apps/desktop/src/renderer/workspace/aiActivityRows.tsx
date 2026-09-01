import { useEffect, useState } from "react";
import {
  api,
  splitExternalModel,
  type HarnessApprovalDecision,
  type HarnessCapabilities,
  type HarnessProvider,
} from "../api";
import type { WSState } from "./state";
import {
  registerHarnessRun,
  mergeHarnessHistory,
  resolveHarnessApproval,
  type HarnessUiRun,
} from "./harnessUi";

export function StateTape({ word, mark }: { word: string; mark: string }) {
  return <span className={`nb-tape ${mark} activity-flag`}>{word}</span>;
}

const HARNESS_PROVIDER_LABEL: Record<string, string> = {
  claude: "Claude", codex: "Codex", "ollama-local": "Ollama local", "ollama-cloud": "Ollama cloud", openrouter: "OpenRouter",
};
const HARNESS_STATUS: Record<string, { word: string; mark: string }> = {
  completed: { word: "Done", mark: "nb-sem-done" }, rolled_back: { word: "Rolled back", mark: "nb-sem-done" }, failed: { word: "Failed", mark: "nb-sem-urgent" }, interrupted: { word: "Interrupted", mark: "nb-sem-urgent" }, running: { word: "Running", mark: "nb-sem-linked" }, waiting: { word: "Waiting", mark: "nb-sem-pending" }, cancelled: { word: "Stopped", mark: "nb-sem-pending" }, starting: { word: "Running", mark: "nb-sem-pending" },
};

function harnessPrivacyMode(provider: HarnessProvider, privacyOn: boolean | null) {
  if (provider === "ollama-local") return "local";
  return privacyOn ? "cloud-redacted" : "cloud-direct";
}

function harnessDisclosure(provider: HarnessProvider, privacyOn: boolean | null) {
  if (provider === "ollama-local") return "Local Ollama works through Arcelle's controlled file backend. It receives no database keys or unrestricted system paths.";
  if (privacyOn) return "Cloud Privacy is on. The agent works in a temporary redacted copy; protected values and original binary files stay on this Mac.";
  return "Cloud Privacy is off. The cloud agent can receive the real room files. File changes are enabled with an encrypted rollback baseline; the private .arcelle folder stays blocked.";
}

function providerModel(provider: HarnessProvider, roomModel: string, externalModel: string | undefined) {
  return ["ollama-local", "ollama-cloud", "openrouter"].includes(provider) ? roomModel : (externalModel ?? "default");
}

function runButtonLabel(starting: boolean, writeEnabled: boolean) {
  if (starting) return "Starting…";
  return writeEnabled ? "Run with file access" : "Run read-only";
}

function HarnessForm({ s, capabilities, error, provider, setProvider, model, setModel, prompt, setPrompt, writeEnabled, setWriteEnabled, starting, start, refresh }: {
  s: WSState; capabilities: HarnessCapabilities | null; error: string; provider: HarnessProvider; setProvider: (provider: HarnessProvider) => void; model: string; setModel: (model: string) => void; prompt: string; setPrompt: (prompt: string) => void; writeEnabled: boolean; setWriteEnabled: (enabled: boolean) => void; starting: boolean; start: () => void; refresh: () => void;
}) {
  const [, externalModel] = splitExternalModel(s.model ?? "");
  const available = capabilities?.providers[provider];
  const changeProvider = (value: string) => { const next = value as HarnessProvider; setProvider(next); setModel(providerModel(next, s.model ?? "", externalModel ?? undefined)); };
  const disabled = [!prompt.trim(), starting, available?.enabled !== true].some(Boolean);
  return <><p className="activity-copy harness-disclosure">{harnessDisclosure(provider, s.privacyOn)}</p><div className="harness-compose"><div className="harness-options"><label>Agent<select value={provider} onChange={(event) => changeProvider(event.target.value)}><option value="codex">Codex</option><option value="claude">Claude</option><option value="ollama-local">Ollama local</option><option value="ollama-cloud">Ollama cloud</option><option value="openrouter">OpenRouter</option></select></label><label>Model<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="default" /></label><label className="settings-label harness-write-toggle"><input type="checkbox" checked={writeEnabled} onChange={(event) => setWriteEnabled(event.target.checked)} />Allow file changes</label></div><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe the work for the workspace agent…" aria-label="Workspace agent task" rows={3} />{error && <p className="gate-error" role="alert">{error}</p>}{available && !available.enabled && <p className="activity-copy">Unavailable: {available.reason ?? "the runtime self-test did not pass."}</p>}<div className="harness-actions"><button className="primary" disabled={disabled} onClick={start}>{runButtonLabel(starting, writeEnabled)}</button><button className="subtle" onClick={refresh}>Test agents again</button></div></div></>;
}

function harnessLive(run: HarnessUiRun) {
  return ["starting", "running", "waiting"].includes(run.status);
}

function harnessConflicts(run: HarnessUiRun) {
  return run.changes.filter((change) => change.rollbackState === "conflict").map((change) => change.relativePath);
}

function HarnessRunMetadata({ run }: { run: HarnessUiRun }) {
  const finished = run.completedAt ? ` · Finished ${new Date(run.completedAt).toLocaleString()}` : "";
  return <div className="activity-copy">{[run.harness, run.model, run.privacyMode].filter(Boolean).join(" · ")}{` · Started ${new Date(run.startedAt).toLocaleString()}`}{finished}</div>;
}

function HarnessInterruption({ run }: { run: HarnessUiRun }) {
  if (run.status !== "interrupted") return null;
  return <div className="activity-copy">The app closed before this run finished. Its recorded file changes remain reviewable and protected by the saved baseline.</div>;
}

function HarnessPlan({ plan }: { plan: string | null }) {
  if (!plan) return null;
  return <div className="activity-copy"><strong>Plan:</strong> {plan}</div>;
}

function HarnessTool({ tool }: { tool: string | null }) {
  if (!tool) return null;
  return <div className="activity-copy">Using {tool}…</div>;
}

function HarnessOutput({ text, error }: { text: string; error: string | null }) {
  return <>{text && <pre className="harness-output">{text}</pre>}{error && <div className="gate-error" role="alert">{error}</div>}</>;
}

function HarnessRunDetails({ run }: { run: HarnessUiRun }) {
  return <><HarnessRunMetadata run={run} /><HarnessInterruption run={run} /><HarnessPlan plan={run.plan} /><HarnessTool tool={run.currentTool} /><HarnessOutput text={run.text} error={run.error} /></>;
}

function HarnessApprovals({ run, approve }: { run: HarnessUiRun; approve: (run: HarnessUiRun, requestId: string, decision: HarnessApprovalDecision) => void }) {
  return <>{run.approvals.map((request) => <HarnessApproval key={request.requestId} run={run} request={request} approve={approve} />)}</>;
}

function HarnessApproval({ run, request, approve }: { run: HarnessUiRun; request: HarnessUiRun["approvals"][number]; approve: (run: HarnessUiRun, requestId: string, decision: HarnessApprovalDecision) => void }) {
  return <div className="harness-approval" data-agent-blocked="true"><strong>{request.tool} needs approval</strong><span>{request.detail}</span><div className="harness-actions"><button className="primary" onClick={() => approve(run, request.requestId, "allow-once")}>Allow once</button>{request.tool !== "cloud_writeback" && <button className="subtle" onClick={() => approve(run, request.requestId, "allow-run")}>Allow for run</button>}<button className="subtle danger" onClick={() => approve(run, request.requestId, "deny")}>Deny</button></div></div>;
}

function HarnessChanges({ run }: { run: HarnessUiRun }) {
  if (run.changes.length === 0) return null;
  const word = run.changes.length === 1 ? "change" : "changes";
  return <details className="harness-changes" open={run.status === "completed"}><summary>{run.changes.length} file {word}</summary><ul>{run.changes.map((change) => <li key={change.relativePath}><code>{change.relativePath}</code> — {change.change}</li>)}</ul></details>;
}

function HarnessUsage({ run }: { run: HarnessUiRun }) {
  if (run.inputTokens <= 0 && run.outputTokens <= 0) return null;
  const cost = run.costUsd != null ? ` · $${run.costUsd.toFixed(4)}` : "";
  return <div className="activity-copy">{run.inputTokens.toLocaleString()} input · {run.outputTokens.toLocaleString()} output tokens{cost}</div>;
}

function canRollback(run: HarnessUiRun) {
  return [!harnessLive(run), run.writeEnabled, run.baselineCompleted, run.rollbackStatus === "none", run.changes.length > 0].every(Boolean);
}

function HarnessRunActions({ run, busy, rollback, toast }: { run: HarnessUiRun; busy: boolean; rollback: (run: HarnessUiRun) => void; toast: WSState["pushToast"] }) {
  if (harnessLive(run)) return <div className="harness-actions"><button className="subtle danger" onClick={() => void api.harnessCancel(run.runId).catch((error) => toast("error", String(error)))}>Stop</button></div>;
  if (!canRollback(run)) return null;
  return <div className="harness-actions"><button className="subtle" disabled={busy} onClick={() => rollback(run)}>{busy ? "Restoring…" : "Roll back file changes"}</button></div>;
}

function HarnessConflicts({ runId, conflicts, busy, restore }: { runId: string; conflicts: string[]; busy: boolean; restore: (runId: string, paths: string[]) => void }) {
  if (conflicts.length === 0) return null;
  return <div className="harness-conflicts" data-agent-blocked="true"><p>These files changed again after the run, so Arcelle kept them: {conflicts.join(", ")}.</p><button className="subtle" disabled={busy} onClick={() => restore(runId, conflicts)}>Restore baselines as copies</button></div>;
}

function HarnessRunRow({ run, conflicts, busy, approve, rollback, restore, toast }: { run: HarnessUiRun; conflicts: string[]; busy: boolean; approve: (run: HarnessUiRun, requestId: string, decision: HarnessApprovalDecision) => void; rollback: (run: HarnessUiRun) => void; restore: (runId: string, paths: string[]) => void; toast: WSState["pushToast"] }) {
  const status = HARNESS_STATUS[run.status] ?? HARNESS_STATUS.starting;
  return <article className="activity-row harness-run"><div className="activity-row-head"><span className="activity-row-title">{HARNESS_PROVIDER_LABEL[run.provider ?? ""] ?? "Workspace agent"}</span><StateTape {...status} /></div><HarnessRunDetails run={run} /><HarnessApprovals run={run} approve={approve} /><HarnessChanges run={run} /><HarnessUsage run={run} /><HarnessRunActions run={run} busy={busy} rollback={rollback} toast={toast} /><HarnessConflicts runId={run.runId} conflicts={conflicts} busy={busy} restore={restore} /></article>;
}

/** Native workspace-agent launcher and audit cards. */
export function HarnessRunner({ s, runs }: { s: WSState; runs: HarnessUiRun[] }) {
  const [capabilities, setCapabilities] = useState<HarnessCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState("");
  const [provider, setProvider] = useState<HarnessProvider>("codex");
  const [, externalModel] = splitExternalModel(s.model ?? "");
  const [model, setModel] = useState(externalModel ?? "default");
  const [prompt, setPrompt] = useState("");
  const [writeEnabled, setWriteEnabled] = useState(true);
  const [starting, setStarting] = useState(false);
  const [rollbackBusy, setRollbackBusy] = useState<string | null>(null);
  const [restoreConflicts, setRestoreConflicts] = useState<Record<string, string[]>>({});
  const refresh = () => { setCapabilityError(""); void api.harnessCapabilities().then(setCapabilities).catch((error) => { setCapabilities(null); setCapabilityError(String(error)); }); };
  useEffect(refresh, []);
  const start = async () => {
    const text = prompt.trim();
    if (!text || starting) return;
    setStarting(true);
    try {
      const requestedModel = model.trim() || "default";
      const privacyMode = harnessPrivacyMode(provider, s.privacyOn);
      const result = await api.harnessStart({ provider, model: requestedModel, privacyMode, writeEnabled, text });
      s.setHarnessRuns((current) => registerHarnessRun(current, result.runId, provider, { model: requestedModel, privacyMode, writeEnabled }));
      setPrompt("");
    } catch (error) { s.pushToast("error", `Couldn't start the workspace agent: ${String(error)}`); refresh(); } finally { setStarting(false); }
  };
  const approve = async (run: HarnessUiRun, requestId: string, decision: HarnessApprovalDecision) => {
    try { if (requestId === `cloud-writeback-${run.runId}`) await api.harnessCloudWriteback(run.runId, decision === "allow-once" || decision === "allow-run"); else await api.harnessApprove(run.runId, requestId, decision); s.setHarnessRuns((current) => resolveHarnessApproval(current, run.runId, requestId)); } catch (error) { s.pushToast("error", `Couldn't answer the agent request: ${String(error)}`); }
  };
  const rollback = async (run: HarnessUiRun) => {
    setRollbackBusy(run.runId);
    try { const result = await api.harnessRollback(run.runId); setRestoreConflicts((all) => ({ ...all, [run.runId]: result.conflicts })); const count = result.restored.length + result.removedCreated.length; const copy = result.conflicts.length ? `Restored ${count} changes. ${result.conflicts.length} newer file changes were kept.` : `Restored ${count} agent file changes.`; s.pushToast(result.conflicts.length ? "info" : "success", copy); const history = await api.harnessListRuns(); s.setHarnessRuns((all) => mergeHarnessHistory(all, history)); api.listFiles().then(s.setFiles).catch(() => {}); } catch (error) { s.pushToast("error", `Couldn't roll back this run: ${String(error)}`); } finally { setRollbackBusy(null); }
  };
  const restore = async (runId: string, paths: string[]) => {
    setRollbackBusy(runId);
    try { const created = await api.harnessRestoreBaselineCopies(runId, paths); setRestoreConflicts((all) => ({ ...all, [runId]: [] })); s.pushToast("success", `Restored ${created.length} baseline ${created.length === 1 ? "copy" : "copies"}.`); api.listFiles().then(s.setFiles).catch(() => {}); api.harnessListRuns().then((history) => s.setHarnessRuns((all) => mergeHarnessHistory(all, history))).catch(() => {}); } catch (error) { s.pushToast("error", `Couldn't restore baseline copies: ${String(error)}`); } finally { setRollbackBusy(null); }
  };
  return <section className="harness-runner" aria-label="Workspace agents"><div className="activity-group-title">Workspace agent</div><HarnessForm s={s} capabilities={capabilities} error={capabilityError} provider={provider} setProvider={setProvider} model={model} setModel={setModel} prompt={prompt} setPrompt={setPrompt} writeEnabled={writeEnabled} setWriteEnabled={setWriteEnabled} starting={starting} start={() => void start()} refresh={refresh} />{runs.map((run) => <HarnessRunRow key={run.runId} run={run} conflicts={restoreConflicts[run.runId] ?? harnessConflicts(run)} busy={rollbackBusy === run.runId} approve={(entry, requestId, decision) => void approve(entry, requestId, decision)} rollback={(entry) => void rollback(entry)} restore={(runId, paths) => void restore(runId, paths)} toast={s.pushToast} />)}</section>;
}

function HistoryRow({ j }: { j: WSState["jobs"][number] }) {
  const when = Date.parse(j.updatedAt);
  return <div className="activity-row history"><div className="activity-row-head"><span className="activity-row-title">{j.title}</span><StateTape word="Done" mark="nb-sem-done" /><span className="activity-state">{Number.isNaN(when) ? "" : new Date(when).toLocaleString()}</span></div><div className="activity-copy ap-note">Finished{j.total > 0 ? ` — ${Math.min(j.cursor, j.total)} of ${j.total} steps` : ""}</div></div>;
}

type HistoryJob = WSState["jobs"][number];

export function groupHistoryRuns(jobs: HistoryJob[]): HistoryJob[][] {
  const groups: HistoryJob[][] = [];
  for (const job of jobs) {
    const current = groups[groups.length - 1];
    const previous = current?.[current.length - 1];
    if (previous && previous.title === job.title && sameLocalDay(previous.updatedAt, job.updatedAt)) {
      current.push(job);
    } else {
      groups.push([job]);
    }
  }
  return groups;
}

function sameLocalDay(a: string, b: string): boolean {
  const first = new Date(a);
  const second = new Date(b);
  if (Number.isNaN(first.getTime()) || Number.isNaN(second.getTime())) return false;
  return first.toDateString() === second.toDateString();
}

function dayLabelOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "that day";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return "today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "yesterday";
  const options: Intl.DateTimeFormatOptions = date.getFullYear() === now.getFullYear()
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" };
  return `on ${date.toLocaleDateString(undefined, options)}`;
}

function HistoryGroupRow({ jobs }: { jobs: HistoryJob[] }) {
  const [expanded, setExpanded] = useState(false);
  const latest = jobs[0];
  const name = latest.title;
  const runCount = jobs.length;
  const allSucceeded = jobs.every((job) => job.error == null && (job.total <= 0 || job.cursor >= job.total));
  const when = Date.parse(latest.updatedAt);
  const summary = allSucceeded ? `${runCount} runs, all finished.` : `${runCount} runs — not every one finished all its steps.`;
  const runsId = `history-group-runs-${latest.id}`;
  return <div className="activity-row history activity-history-group"><div className="activity-row-head"><span className="activity-row-title">{name} — {runCount} runs {dayLabelOf(latest.updatedAt)}{allSucceeded ? ", all clean" : ", some incomplete"}</span><StateTape word="Done" mark="nb-sem-done" /><span className="activity-state">{Number.isNaN(when) ? "" : new Date(when).toLocaleString()}</span></div><div className="activity-copy ap-note">{summary}</div><div className="activity-row-actions"><button className="subtle" aria-expanded={expanded} aria-controls={runsId} onClick={() => setExpanded((value) => !value)}>{expanded ? "Hide runs" : "Show runs"}</button></div>{expanded && <div id={runsId} className="activity-history-group-runs">{jobs.map((job) => <HistoryRow key={job.id} j={job} />)}</div>}</div>;
}

export function HistoryEntry({ jobs }: { jobs: HistoryJob[] }) {
  return jobs.length > 1 ? <HistoryGroupRow jobs={jobs} /> : <HistoryRow j={jobs[0]} />;
}
