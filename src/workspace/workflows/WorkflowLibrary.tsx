import { useEffect, useMemo, useState } from "react";
import { api, Schedule, Workflow, WorkflowTemplate } from "../../api";
import { WSState } from "../state";
import { WSActions } from "../actions";

type Props = { s: WSState; a: WSActions };

/** The AI-authoring bar: describe a workflow in plain language and let the
 * in-room agent compose it with the save_workflow tool. The resulting draft
 * appears in the library on its own (the onWorkflowsChanged event refreshes
 * it), so the user reviews and activates it here. */
function ComposeBar({ s, a }: Props) {
  const [desc, setDesc] = useState("");
  const busy = s.asking;

  function compose() {
    const d = desc.trim();
    if (!d || busy) return;
    const prompt =
      `Create a workflow for this room: ${d}\n\n` +
      `Use the save_workflow tool to save it as a draft I can review. Choose suitable ` +
      `node kinds (generate, summarize_file, file_pass, save_file, condition), a short ` +
      `name, and a fitting emoji. Don't run it — just save the draft.`;
    setDesc("");
    void a.send(prompt);
    s.pushToast("info", "Composing — the draft will appear here when the assistant is done.");
  }

  return (
    <div className="wf-compose">
      <div className="wf-compose-head">
        <span className="wf-compose-spark">✨</span>
        <span>Describe a workflow and let the assistant build it</span>
      </div>
      <div className="wf-compose-row">
        <input
          className="wf-compose-input"
          placeholder="e.g. every morning, summarize any new PDFs and save a digest"
          value={desc}
          disabled={busy}
          onChange={(e) => setDesc(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") compose();
          }}
        />
        <button className="wf-compose-btn" onClick={compose} disabled={busy || !desc.trim()}>
          {busy ? "Assistant busy…" : "Compose with AI"}
        </button>
      </div>
    </div>
  );
}

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

  // Wave 5 (Idea 13): the per-script auto-workflows (created_by='script') have
  // their own home on the Scripts page — hide them from the workflow library.
  const visible = useMemo(
    () => s.workflows.filter((w) => w.createdBy !== "script"),
    [s.workflows],
  );

  useEffect(() => {
    if (visible.length === 0) {
      api.workflowTemplates().then(setTemplates).catch(() => {});
    }
  }, [visible.length]);

  // Fetch each workflow's schedule for its badge/countdown.
  useEffect(() => {
    let live = true;
    Promise.all(
      visible.map((w) =>
        api.getWorkflowSchedule(w.id).then((sc) => [w.id, sc] as const).catch(() => [w.id, null] as const),
      ),
    ).then((pairs) => {
      if (live) setSchedules(Object.fromEntries(pairs));
    });
    return () => {
      live = false;
    };
  }, [visible]);

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

  if (visible.length === 0) {
    return (
      <div className="wf-body">
        <div className="wf-empty">
          <h3>Automate your room with workflows</h3>
          <p className="wf-empty-sub">
            Multi-step LLM pipelines you can run by hand, on a schedule, or from a file's Actions
            menu. Describe one below, or start from a template.
          </p>
        </div>
        <ComposeBar s={s} a={a} />
        <div className="wf-section-label">Start from a template</div>
        <div className="wf-grid">
          {templates.map((t) => (
            <div key={t.name} className="wf-card tmpl" onClick={() => void a.instantiateTemplate(t)}>
              <div className="wf-card-top">
                <span className="wf-card-emoji">{t.emoji}</span>
                <span className="wf-card-name">{t.name}</span>
                {t.schedule && <span className="wf-badge">{t.schedule.kind}</span>}
              </div>
              <div className="wf-card-desc">{t.description}</div>
              <div className="wf-card-cta">Use template →</div>
            </div>
          ))}
          <div className="wf-card wf-card-blank" onClick={() => void a.createBlankWorkflow()}>
            <div className="wf-card-top">
              <span className="wf-card-emoji">＋</span>
              <span className="wf-card-name">Blank workflow</span>
            </div>
            <div className="wf-card-desc">Start from an empty pipeline and add steps yourself.</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="wf-body">
      <ComposeBar s={s} a={a} />
      <div className="wf-toolbar">
        <div className="wf-section-label">Your workflows</div>
        <button className="wf-new-btn" onClick={() => void a.createBlankWorkflow()}>
          ＋ New workflow
        </button>
      </div>
      <div className="wf-grid">
        {visible.map((w) => {
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
