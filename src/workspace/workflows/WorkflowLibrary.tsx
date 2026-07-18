import { useEffect, useMemo, useState } from "react";
import { api, Schedule, Workflow, WorkflowTemplate } from "../../api";
import { WSState } from "../state";
import { WSActions } from "../actions";

type Props = { s: WSState; a: WSActions };

function countdown(nextRunAt: string | null, now: number): string {
  if (!nextRunAt) return "";
  const t = Date.parse(nextRunAt);
  if (Number.isNaN(t)) return "";
  const secs = Math.round((t - now) / 1000);
  if (secs <= 0) return "due now";
  if (secs < 3600) return `in ${Math.max(1, Math.round(secs / 60))}m`;
  if (secs < 86400) return `in ${Math.round(secs / 3600)}h`;
  return `in ${Math.round(secs / 86400)}d`;
}

function bindingBadge(w: Workflow): string | null {
  if (w.binding.scope !== "file") return null;
  const parts = [...(w.binding.kinds ?? []), ...(w.binding.exts ?? [])];
  return parts.length ? `On: ${parts.join(", ")}` : "On: files";
}

export function WorkflowLibrary({ s, a }: Props) {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [schedules, setSchedules] = useState<Record<string, Schedule | null>>({});
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (s.workflows.length === 0) {
      api.workflowTemplates().then(setTemplates).catch(() => {});
    }
  }, [s.workflows.length]);

  // Fetch each workflow's schedule for its badge/countdown.
  useEffect(() => {
    let live = true;
    Promise.all(
      s.workflows.map((w) =>
        api.getWorkflowSchedule(w.id).then((sc) => [w.id, sc] as const).catch(() => [w.id, null] as const),
      ),
    ).then((pairs) => {
      if (live) setSchedules(Object.fromEntries(pairs));
    });
    return () => {
      live = false;
    };
  }, [s.workflows]);

  // Tick once a minute for the countdowns (only when something is scheduled).
  const anyScheduled = useMemo(
    () => Object.values(schedules).some((sc) => sc?.enabled),
    [schedules],
  );
  useEffect(() => {
    if (!anyScheduled) return;
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, [anyScheduled]);

  if (s.workflows.length === 0) {
    return (
      <div className="wf-body">
        <div className="wf-empty">
          <h3>Automate your room with workflows</h3>
          <p className="caption">
            Compose multi-step LLM pipelines — run them by hand, on a schedule, or from a file's
            Actions menu. Start from a template:
          </p>
        </div>
        <div className="wf-grid">
          {templates.map((t) => (
            <div key={t.name} className="wf-card" onClick={() => void a.instantiateTemplate(t)}>
              <div className="wf-card-top">
                <span className="wf-card-emoji">{t.emoji}</span>
                <span className="wf-card-name">{t.name}</span>
              </div>
              <div className="wf-card-desc">{t.description}</div>
              <div className="wf-badges">
                {t.schedule && <span className="wf-badge">{t.schedule.kind}</span>}
                <span className="wf-badge">Use this template</span>
              </div>
            </div>
          ))}
          <div className="wf-card" onClick={() => void a.createBlankWorkflow()}>
            <div className="wf-card-top">
              <span className="wf-card-emoji">➕</span>
              <span className="wf-card-name">Blank workflow</span>
            </div>
            <div className="wf-card-desc">Start from an empty pipeline.</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="wf-body">
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.6rem" }}>
        <button className="subtle btn-ic" onClick={() => void a.createBlankWorkflow()}>
          ➕ New workflow
        </button>
      </div>
      <div className="wf-grid">
        {s.workflows.map((w) => {
          const sc = schedules[w.id];
          const bb = bindingBadge(w);
          return (
            <div key={w.id} className="wf-card" onClick={() => a.openWorkflowDetail(w.id)}>
              <div className="wf-card-top">
                <span className="wf-card-emoji">{w.emoji || "⚙️"}</span>
                <span className="wf-card-name">{w.name}</span>
                {w.pinned && <span title="Pinned to the top bar">📌</span>}
              </div>
              {w.description && <div className="wf-card-desc">{w.description}</div>}
              <div className="wf-badges">
                {w.status === "draft" && <span className="wf-badge draft">Draft</span>}
                {w.createdBy === "agent" && <span className="wf-badge agent">Drafted by the agent</span>}
                {sc?.enabled && (
                  <span className="wf-badge">
                    {sc.kind} {countdown(sc.nextRunAt, now) && `· ${countdown(sc.nextRunAt, now)}`}
                  </span>
                )}
                {bb && <span className="wf-badge">{bb}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
