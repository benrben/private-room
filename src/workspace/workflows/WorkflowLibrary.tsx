import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, Schedule, Workflow, WorkflowRun, WorkflowTemplate } from "../../api";
import { WSState } from "../state";
import { WSActions } from "../actions";
import { PlusIcon, SparklesIcon, PinIcon } from "../../icons";
import { WorkflowGlyph } from "./workflowGlyph";
import { runDotClass, visibleWorkflows } from "./selectors";

type Props = { s: WSState; a: WSActions };

/** Make a clickable card behave as a real button for keyboard/AT users. */
function cardButton(activate: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: activate,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    },
  };
}

/** The AI-authoring bar: describe a workflow in plain language and the backend
 * composes it on whatever engine the room uses (the model returns the definition
 * as JSON text, validated + saved as a draft in Rust — so it works even with an
 * external CLI like Codex that has no room tools). On success we open the draft. */
function ComposeBar({ s, a }: Props) {
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the textarea to fit the description (capped by max-height in CSS,
  // after which it scrolls) so a long, multi-sentence workflow prompt stays fully
  // visible instead of scrolling off a single line.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 136)}px`;
  }, [desc]);

  async function compose() {
    const d = desc.trim();
    if (!d || busy) return;
    setBusy(true);
    s.pushToast("info", "Composing a workflow…");
    try {
      const id = await api.composeWorkflow(d);
      setDesc("");
      await a.refreshWorkflows();
      a.openWorkflowDetail(id);
      s.pushToast("success", "Draft ready — review and activate it.");
    } catch (e) {
      s.pushToast("error", typeof e === "string" ? e : "Couldn't compose that workflow.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wf-compose">
      <div className="wf-compose-head">
        <span className="wf-compose-spark">
          <SparklesIcon size={16} />
        </span>
        <span>Describe a workflow and let the assistant build it</span>
      </div>
      <div className="wf-compose-row">
        <textarea
          ref={taRef}
          className="wf-compose-input"
          placeholder="e.g. every morning, summarize any new PDFs and save a digest"
          value={desc}
          disabled={busy}
          rows={1}
          onChange={(e) => setDesc(e.target.value)}
          onKeyDown={(e) => {
            // Enter composes; Shift+Enter inserts a newline for a longer prompt.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void compose();
            }
          }}
        />
        <button className="wf-compose-btn" onClick={() => void compose()} disabled={busy || !desc.trim()}>
          {busy ? "Composing…" : "Compose with AI"}
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

/** The colored last-run status dot for a card, or null if it never ran.
 *
 * The colour comes from `runDotClass`, the same helper the run-history rows
 * use. This map used to carry its own, and its `?? ["dot-ok", …]` fallback made
 * GREEN the default for every status not spelled out here — so a run that was
 * stopped, or that the app quit under (`paused`), and one still waiting to
 * start (`queued`) both wore the success dot on the card. Only the LABEL is
 * local now, because these cards say "Ran OK" where the history row prints the
 * raw status. */
function lastRunBadge(run: WorkflowRun | null | undefined) {
  if (!run) return null;
  const labels: Record<string, string> = {
    done: "Ran OK",
    error: "Failed",
    running: "Running",
    queued: "Waiting",
    paused: "Stopped",
  };
  return (
    <span className={`wf-badge ${runDotClass(run.status)}`}>
      {labels[run.status] ?? run.status}
    </span>
  );
}

export function WorkflowLibrary({ s, a }: Props) {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [schedules, setSchedules] = useState<Record<string, Schedule | null>>({});
  const [lastRuns, setLastRuns] = useState<Record<string, WorkflowRun | null>>({});
  const [now, setNow] = useState(() => Date.now());
  // Templates stay reachable AFTER the first workflow exists (the empty-state
  // gallery used to be the only way in — this toggle restores access).
  const [showTemplates, setShowTemplates] = useState(false);

  // Wave 5 (Idea 13): the per-script auto-workflows (created_by='script') have
  // their own home on the Scripts page — hide them from the workflow library.
  const visible = useMemo(() => visibleWorkflows(s.workflows), [s.workflows]);

  // Always load templates (empty-state shows them; the toolbar toggle reopens
  // the gallery once you already have workflows).
  useEffect(() => {
    api.workflowTemplates().then(setTemplates).catch(() => {});
  }, []);

  // Each card's schedule badge/countdown and last-run dot, fetched in ONE sweep
  // per list change instead of two independent ones. Refreshes with the
  // workflows list (a finished run emits workflows-changed), but every sweep
  // after the first waits a moment first, so a burst — save, then activate,
  // then the event — collapses into one sweep instead of re-fetching every
  // workflow's schedule AND run history three times over. The first sweep is
  // immediate: the badges belong on the first paint.
  const sweptRef = useRef(false);
  useEffect(() => {
    if (visible.length === 0) return;
    let live = true;
    const timer = window.setTimeout(() => {
      sweptRef.current = true;
      void Promise.all(
        visible.map(async (w) => {
          const [schedule, runs] = await Promise.all([
            api.getWorkflowSchedule(w.id).catch(() => null),
            api.getWorkflowRuns(w.id).catch(() => [] as WorkflowRun[]),
          ]);
          return [w.id, schedule, runs[0] ?? null] as const;
        }),
      ).then((rows) => {
        if (!live) return;
        setSchedules(Object.fromEntries(rows.map(([id, sc]) => [id, sc])));
        setLastRuns(Object.fromEntries(rows.map(([id, , run]) => [id, run])));
      });
    }, sweptRef.current ? 150 : 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
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

  const templateGrid = (
    <div className="wf-grid">
      {templates.map((t) => (
        <div key={t.name} className="wf-card tmpl" {...cardButton(() => void a.instantiateTemplate(t))}>
          <div className="wf-card-top">
            <span className="wf-card-emoji">
              <WorkflowGlyph emoji={t.emoji} size={18} />
            </span>
            <span className="wf-card-name">{t.name}</span>
            {t.schedule && <span className="wf-badge">{t.schedule.kind}</span>}
          </div>
          <div className="wf-card-desc">{t.description}</div>
          <div className="wf-card-cta">Use template →</div>
        </div>
      ))}
      <div className="wf-card wf-card-blank" {...cardButton(() => void a.createBlankWorkflow())}>
        <div className="wf-card-top">
          <span className="wf-card-emoji">
            <PlusIcon size={17} />
          </span>
          <span className="wf-card-name">Blank workflow</span>
        </div>
        <div className="wf-card-desc">Start from an empty pipeline and add steps yourself.</div>
      </div>
    </div>
  );

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
        {templateGrid}
      </div>
    );
  }

  return (
    <div className="wf-body">
      <ComposeBar s={s} a={a} />
      <div className="wf-toolbar">
        <div className="wf-section-label">Your workflows</div>
        <button
          className="wf-new-btn btn-ic"
          aria-pressed={showTemplates}
          onClick={() => setShowTemplates((v) => !v)}
        >
          <SparklesIcon size={13} /> {showTemplates ? "Hide templates" : "From template"}
        </button>
        <button className="wf-new-btn btn-ic" onClick={() => void a.createBlankWorkflow()}>
          <PlusIcon size={13} /> New workflow
        </button>
      </div>
      {showTemplates && (
        <>
          <div className="wf-section-label">Start from a template</div>
          {templateGrid}
          <div className="wf-section-label" style={{ marginTop: "1rem" }}>
            Your workflows
          </div>
        </>
      )}
      <div className="wf-grid">
        {visible.map((w) => {
          const sc = schedules[w.id];
          const bb = bindingBadge(w);
          return (
            <div key={w.id} className="wf-card" {...cardButton(() => a.openWorkflowDetail(w.id))}>
              <div className="wf-card-top">
                <span className="wf-card-emoji">
                  <WorkflowGlyph emoji={w.emoji} size={18} />
                </span>
                <span className="wf-card-name">{w.name}</span>
                {w.pinned && (
                  <span className="wf-card-pin" title="Pinned to the top bar" aria-label="Pinned to the top bar">
                    <PinIcon size={13} />
                  </span>
                )}
              </div>
              {w.description && <div className="wf-card-desc">{w.description}</div>}
              <div className="wf-badges">
                {w.status === "draft" && <span className="wf-badge draft">Draft</span>}
                {lastRunBadge(lastRuns[w.id])}
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
