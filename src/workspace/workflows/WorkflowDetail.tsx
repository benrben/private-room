import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { confirm } from "@tauri-apps/plugin-dialog";
import {
  api,
  Schedule,
  Workflow,
  WorkflowBinding,
  WorkflowDef,
  WorkflowEdge,
  WorkflowNode,
  WorkflowRun,
} from "../../api";
import { WSState } from "../state";
import { WSActions } from "../actions";
import { PipelineCanvas } from "./PipelineCanvas";
import { NodeParamSheet } from "./NodeParamSheet";
import { SchedulePopover } from "./SchedulePopover";
import { RunHistory } from "./RunHistory";
import { branchFor } from "./selectors";
import { WorkflowGlyph, WORKFLOW_ICON_CHOICES } from "./workflowGlyph";
import { PlayIcon, PinIcon, CalendarClockIcon } from "../../icons";
import { coveredKinds } from "../../viewers/registry";

/** The file kinds a workflow binding can be limited to.
 *
 * Read from the viewer registry rather than restated here. This list was a
 * FOURTH hand-maintained copy of the kind union (with Rust's format table, the
 * ViewerKind type and the registry itself) and had already gone stale: a
 * workflow could not be pointed at a presentation, a book, an archive or a
 * notebook, because those kinds simply weren't offered as buttons. */
const KIND_UNION = coveredKinds();

type Props = { s: WSState; a: WSActions; workflow: Workflow };

/** The comma-joined extension list for a binding's text input. */
function extsOf(b: WorkflowBinding): string {
  return b.scope === "file" ? (b.exts ?? []).join(", ") : "";
}
/** Parse a comma-separated extension list (drops leading dots, lowercases). */
function parseExts(raw: string): string[] {
  return raw
    .split(",")
    .map((x) => x.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean);
}

/** Turn a backend validation sentence (which names nodes by their internal id,
 * e.g. `Node 'nmrt1v6mp1' …`) into human text — swapping each quoted id for the
 * step's label — and surface the first referenced node id so the error can be
 * clicked to select that step. */
function humanizeError(msg: string, nodes: WorkflowNode[]): { text: string; nodeId: string | null } {
  let nodeId: string | null = null;
  const text = msg.replace(/'([^']+)'/g, (m, id) => {
    const n = nodes.find((x) => x.id === id);
    if (!n) return m;
    if (!nodeId) nodeId = id;
    return `"${(n.label && String(n.label)) || id}"`;
  });
  return { text, nodeId };
}

function newNode(idx: number): WorkflowNode {
  return {
    id: `n${Date.now().toString(36)}${idx}`,
    label: "New step",
    kind: "generate",
    model: "auto",
    prompt: "Summarize:\n{{input}}",
  };
}

export function WorkflowDetail({ s, a, workflow }: Props) {
  const [def, setDef] = useState<WorkflowDef>(workflow.definition);
  const [name, setName] = useState(workflow.name);
  const [emoji, setEmoji] = useState(workflow.emoji || "⚙️");
  const [binding, setBinding] = useState(workflow.binding);
  // Raw text mirror of binding.exts so trailing commas survive as the user types.
  const [extsText, setExtsText] = useState(() => extsOf(workflow.binding));
  const [selected, setSelected] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  /** True while the backend validator is deciding — see the effect below. */
  const [checking, setChecking] = useState(true);
  // Dirty = the form actually differs from the saved workflow, so toggling a
  // value back to its original (e.g. Script mode Import→Pipe→Import) clears Save.
  const dirty = useMemo(
    () =>
      name !== workflow.name ||
      (emoji || "⚙️") !== (workflow.emoji || "⚙️") ||
      JSON.stringify(def) !== JSON.stringify(workflow.definition) ||
      JSON.stringify(binding) !== JSON.stringify(workflow.binding),
    [name, emoji, def, binding, workflow],
  );
  // The saved form itself — NOT its timestamp. Pin/Unpin/Deactivate bump
  // `updatedAt` without touching a single edited field, and re-seeding on the
  // timestamp threw away whatever was in the editor (those buttons sit right
  // next to Save). Keyed on the content, they no longer disturb the form, while
  // a real save or an outside edit still re-seeds it.
  const savedForm = useMemo(
    () =>
      JSON.stringify([
        workflow.name,
        workflow.emoji || "⚙️",
        workflow.definition,
        workflow.binding,
      ]),
    [workflow],
  );
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [showSched, setShowSched] = useState(false);
  // Where to place the schedule popover: the Schedule button's rect at open
  // time. The popover renders in a body-level portal because every `.pane`
  // is `overflow: hidden` + `container-type: inline-size` — the latter makes
  // the pane the containing block even for `position: fixed` descendants, so
  // an in-tree popover gets clipped to a sliver at the pane edge (live QA
  // 2026-07-23: "can't see the scheduler popup").
  const schedBtnRef = useRef<HTMLButtonElement>(null);
  const [schedAnchor, setSchedAnchor] = useState<{ top: number; right: number } | null>(null);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);

  // Re-seed from the store when the selected workflow, or its saved form,
  // changes.
  useEffect(() => {
    setDef(workflow.definition);
    setName(workflow.name);
    setEmoji(workflow.emoji || "⚙️");
    setBinding(workflow.binding);
    setExtsText(extsOf(workflow.binding));
    /* dirty is derived from a diff */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow.id, savedForm]);

  // Load schedule + run history; refresh when the workflows list changes (a run
  // finishing emits workflows-changed → the list refreshes → we re-fetch).
  useEffect(() => {
    let live = true;
    api.getWorkflowSchedule(workflow.id).then((v) => live && setSchedule(v)).catch(() => {});
    api.getWorkflowRuns(workflow.id).then((v) => live && setRuns(v)).catch(() => {});
    return () => {
      live = false;
    };
  }, [workflow.id, s.workflows]);

  // Validate on every edit (single source of truth — the backend validator).
  //
  // `checking` exists because "no errors yet" and "no errors" are not the same
  // thing. `errors` starts empty and the validator is async, so a brand-new draft
  // — zero nodes, the least valid workflow there is — rendered with Activate
  // ENABLED until the first result landed, and the same stale-empty window
  // reopened after every edit. Live QA 2026-08-03 activated an empty workflow
  // through it. Unknown is not valid; it just isn't known to be invalid yet.
  useEffect(() => {
    let live = true;
    setChecking(true);
    api
      .validateWorkflow(def, binding)
      .then((e) => {
        if (!live) return;
        setErrors(e);
        setChecking(false);
      })
      .catch((e) => {
        if (!live) return;
        // A validator we couldn't reach must not read as a clean bill of health.
        setErrors([`Couldn't check this workflow: ${String(e)}`]);
        setChecking(false);
      });
    return () => {
      live = false;
    };
  }, [def, binding]);

  const selectedNode = def.nodes.find((n) => n.id === selected) ?? null;
  const runningJobId = runs.find((r) => r.status === "running")?.jobId ?? null;
  const liveStatus = runningJobId ? s.wfNodeStatus[runningJobId] : undefined;
  const isFileScoped = binding.scope === "file";
  const valid = !checking && errors.length === 0;

  const nodeCount = useMemo(() => def.nodes.length, [def]);

  function updateNode(n: WorkflowNode) {
    setDef((d) => ({ ...d, nodes: d.nodes.map((x) => (x.id === n.id ? n : x)) }));
    /* dirty is derived from a diff */
  }
  function deleteNode(id: string) {
    setDef((d) => ({
      ...d,
      nodes: d.nodes.filter((n) => n.id !== id),
      edges: d.edges.filter((e) => e.from !== id && e.to !== id),
    }));
    setSelected(null);
    /* dirty is derived from a diff */
  }
  function updateEdges(edges: WorkflowEdge[]) {
    setDef((d) => ({ ...d, edges }));
    /* dirty is derived from a diff */
  }
  /** Add a step. With `afterId`, splice it in right after that node — rewiring
   * that node's successors through the new step. A condition/route picks ONE
   * path, so rewiring all of its outcomes through a single plain step would
   * silently un-branch it: there the new step is spliced into the FIRST outcome
   * only, leaving the others wired as they were. Without `afterId`, append at
   * the tail. */
  function addNode(afterId?: string | null) {
    setDef((d) => {
      const n = newNode(d.nodes.length);
      if (!afterId) {
        const last = d.nodes[d.nodes.length - 1];
        const edges = last ? [...d.edges, { from: last.id, to: n.id }] : d.edges;
        return { ...d, nodes: [...d.nodes, n], edges };
      }
      const after = d.nodes.find((x) => x.id === afterId);
      const successors = d.edges.filter((e) => e.from === afterId);
      if (after && (after.kind === "condition" || after.kind === "route")) {
        const spliced = successors[0];
        const edges: WorkflowEdge[] = spliced
          ? [...d.edges.map((e) => (e === spliced ? { ...e, to: n.id } : e)), { from: n.id, to: spliced.to }]
          : [...d.edges, { from: afterId, to: n.id, branch: branchFor(after, successors) }];
        return { ...d, nodes: [...d.nodes, n], edges };
      }
      const rest = d.edges.filter((e) => e.from !== afterId);
      const edges: WorkflowEdge[] = [
        ...rest,
        { from: afterId, to: n.id },
        ...successors.map((e) => ({ from: n.id, to: e.to })),
      ];
      return { ...d, nodes: [...d.nodes, n], edges };
    });
    /* dirty is derived from a diff */
  }
  /** Add a PARALLEL branch: a new step wired from `afterId` WITHOUT rewiring its
   * existing successors, so `afterId` now fans out to two children (the engine
   * runs independent branches concurrently on the cloud/CPU lanes). Off a
   * condition/route the new edge takes the next free outcome label instead. */
  function addBranchNode(afterId: string) {
    setDef((d) => {
      const n = newNode(d.nodes.length);
      const after = d.nodes.find((x) => x.id === afterId);
      const branch = branchFor(after, d.edges.filter((e) => e.from === afterId));
      return { ...d, nodes: [...d.nodes, n], edges: [...d.edges, { from: afterId, to: n.id, branch }] };
    });
    /* dirty is derived from a diff */
  }

  async function save() {
    await a.saveWorkflowEdits(workflow.id, { name, emoji, definition: def, binding });
    /* dirty is derived from a diff */
  }
  async function saveAndActivate() {
    await save();
    await a.setWorkflowStatus(workflow.id, "active");
  }

  /** Back to the library. The form lives only in this component and Save is off
   * while the def is still incomplete — which is most of the time mid-edit — so
   * leaving used to drop the work silently. Ask instead. */
  async function leave() {
    if (dirty) {
      const ok = await confirm(
        valid
          ? "Leave without saving your changes to this workflow?"
          : "This workflow has unsaved changes, and they can't be saved until the listed problems are fixed. Leave and lose them?",
        { title: "Unsaved changes", kind: "warning" },
      );
      if (!ok) return;
    }
    s.setWfDetailId(null);
  }

  function toggleKind(k: string) {
    if (binding.scope !== "file") return;
    const kinds = binding.kinds ?? [];
    const next = kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k];
    setBinding({ ...binding, kinds: next });
    /* dirty is derived from a diff */
  }
  function setBindingExts(raw: string) {
    if (binding.scope !== "file") return;
    setExtsText(raw);
    setBinding({ ...binding, exts: parseExts(raw) });
    /* dirty is derived from a diff */
  }
  function setBindingFile(fileId: string | null) {
    if (binding.scope !== "file") return;
    setBinding({ ...binding, file_id: fileId });
    /* dirty is derived from a diff */
  }

  return (
    <div className="wf-page">
      <div className="viewer-head">
        <button className="subtle btn-ic" onClick={() => void leave()}>
          ← Library
        </button>
        <div className="wf-icon-pick">
          <button
            type="button"
            className="wf-icon-btn"
            aria-haspopup="menu"
            aria-expanded={showIconPicker}
            title="Choose an icon"
            aria-label="Choose an icon for this workflow"
            onClick={() => setShowIconPicker((v) => !v)}
          >
            <WorkflowGlyph emoji={emoji} size={18} />
          </button>
          {showIconPicker && (
            <>
              <div className="menu-backdrop" onMouseDown={() => setShowIconPicker(false)} />
              <div className="wf-icon-grid" role="menu" aria-label="Workflow icon">
                {WORKFLOW_ICON_CHOICES.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    role="menuitemradio"
                    aria-checked={(emoji || "⚙️") === c.key}
                    className={`wf-icon-choice${(emoji || "⚙️") === c.key ? " active" : ""}`}
                    title={c.label}
                    aria-label={c.label}
                    onClick={() => {
                      setEmoji(c.key);
                      setShowIconPicker(false);
                      /* dirty is derived from a diff */
                    }}
                  >
                    <WorkflowGlyph emoji={c.key} size={18} />
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        {/* The workflow's name is edited in place, so the field is drawn as the
            title it is: no box until you touch it, then the pen's own focus
            stroke. It carries user-typed text, which is always the interface
            sans and never the hand. */}
        <input
          className="viewer-title wf-title-input"
          aria-label="Workflow name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            /* dirty is derived from a diff */
          }}
        />
        <span className="viewer-actions wf-detail-actions">
          <button className="subtle btn-ic" disabled={workflow.status !== "active"} onClick={() => void a.runWorkflowNow(workflow.id)}>
            <PlayIcon size={12} /> Run now
          </button>
          {workflow.status === "active" ? (
            <button className="subtle" onClick={() => void a.setWorkflowStatus(workflow.id, "draft")}>
              Deactivate
            </button>
          ) : (
            // A disabled button with no reason beside it reads as a broken
            // button. `title` + aria-disabled also make the blocked state
            // legible to the accessibility tree, which is how QA inspects this
            // — reported as "Activate is enabled" when it was disabled with
            // nothing to say why.
            <button
              className="primary"
              disabled={!valid}
              aria-disabled={!valid}
              title={
                checking
                  ? "Checking this workflow…"
                  : errors.length
                    ? `Can't activate yet — ${errors[0]}`
                    : "Save and activate this workflow"
              }
              onClick={() => void saveAndActivate()}
            >
              Activate
            </button>
          )}
          <button className="subtle" disabled={!dirty || !valid} onClick={() => void save()}>
            Save
          </button>
          {!isFileScoped && (
            <button
              className={`subtle btn-ic${workflow.pinned ? " active" : ""}`}
              title={workflow.pinned ? "Unpin from the top bar" : "Pin to the top bar"}
              onClick={() => void a.setWorkflowPinned(workflow.id, !workflow.pinned)}
            >
              <PinIcon size={12} /> {workflow.pinned ? "Pinned" : "Pin"}
            </button>
          )}
          <button
            ref={schedBtnRef}
            className="subtle btn-ic"
            onClick={() => {
              const r = schedBtnRef.current?.getBoundingClientRect();
              setSchedAnchor(
                r ? { top: r.bottom + 6, right: window.innerWidth - r.right } : null,
              );
              setShowSched((v) => !v);
            }}
          >
            <CalendarClockIcon size={12} /> Schedule
          </button>
          {/* Destructive actions are drawn in the urgent ink across the whole
              product, so this one stops being indistinguishable from Save. */}
          <button
            className="subtle danger"
            data-agent-blocked
            onClick={async () => {
              const ok = await confirm(`Delete the workflow “${workflow.name}”? This can't be undone.`, {
                title: "Delete workflow",
                kind: "warning",
              });
              if (ok) await a.deleteWorkflow(workflow.id);
            }}
          >
            Delete
          </button>
          {showSched &&
            createPortal(
              <div
                style={{
                  position: "fixed",
                  top: schedAnchor?.top ?? 90,
                  right: Math.max(schedAnchor?.right ?? 16, 8),
                  zIndex: 1000,
                }}
              >
                <SchedulePopover
                  schedule={schedule}
                  disabled={isFileScoped}
                  onClose={() => setShowSched(false)}
                  onSave={(sc) => void a.setWorkflowSchedule(workflow.id, sc)}
                />
              </div>,
              document.body,
            )}
        </span>
      </div>

      <div className="wf-body">
        {workflow.status === "draft" && (
          <div className="wf-badges wf-detail-badges">
            <span className="wf-badge draft">Draft — activate to run on schedule</span>
            {workflow.createdBy === "agent" && <span className="wf-badge agent">Drafted by the agent</span>}
          </div>
        )}

        {errors.length > 0 && (
          <div className="wf-errors">
            Fix these before activating:
            <ul>
              {errors.map((e, i) => {
                const { text, nodeId } = humanizeError(e, def.nodes);
                return (
                  <li key={i}>
                    {nodeId ? (
                      <button
                        type="button"
                        className="wf-error-link"
                        onClick={() => setSelected(nodeId)}
                        title="Select this step"
                      >
                        {text}
                      </button>
                    ) : (
                      text
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <PipelineCanvas
          def={def}
          status={liveStatus}
          selectedId={selected}
          onSelect={setSelected}
          onAddAfter={addNode}
          onAddBranch={addBranchNode}
          editable
        />

        {selectedNode && (
          <NodeParamSheet
            node={selectedNode}
            onChange={updateNode}
            onDelete={() => deleteNode(selectedNode.id)}
            edges={def.edges}
            allNodes={def.nodes}
            onEdgesChange={updateEdges}
            files={s.files}
          />
        )}

        {/* Binding editor */}
        <div className="node-param-sheet">
          <label>
            Where it appears
            <div className="wf-seg" role="radiogroup" aria-label="Where it appears">
              <button
                type="button"
                role="radio"
                aria-checked={binding.scope === "general"}
                className={binding.scope === "general" ? "active" : ""}
                onClick={() => {
                  setBinding({ scope: "general" });
                  /* dirty is derived from a diff */
                }}
              >
                General
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={binding.scope === "file"}
                className={binding.scope === "file" ? "active" : ""}
                onClick={() => {
                  setBinding({ scope: "file", kinds: [], exts: [] });
                  setExtsText("");
                  /* dirty is derived from a diff */
                }}
              >
                Specific files
              </button>
            </div>
          </label>
          {binding.scope === "file" && (
            <>
              {/* A group of toggles, not a <label>: a label may only name one
                  control, and these are chips. They were styled as badges with
                  the border stripped off, which left them under the 24px
                  minimum target, with no boundary, and with their on/off state
                  carried by colour alone. .nb-chip-btn brings the target, the
                  focus ring and the circled "on" treatment; aria-pressed puts
                  the state in the accessibility tree where colour cannot. */}
              <div className="field" role="group" aria-label="File kinds it runs on">
                <span className="field-head">File kinds it runs on</span>
                <div className="wf-chips">
                  {KIND_UNION.map((k) => {
                    const on = (binding.kinds ?? []).includes(k);
                    return (
                      <button
                        key={k}
                        type="button"
                        aria-pressed={on}
                        className={`nb-chip nb-chip-btn${on ? " is-on" : ""}`}
                        onClick={() => toggleKind(k)}
                      >
                        {k}
                      </button>
                    );
                  })}
                </div>
              </div>
              <label>
                File extensions <span className="wf-field-hint">(comma-separated, e.g. pdf, docx)</span>
                <input
                  type="text"
                  value={extsText}
                  placeholder="pdf, docx, md"
                  onChange={(e) => setBindingExts(e.target.value)}
                />
              </label>
              <label>
                Only this specific file{" "}
                <span className="wf-field-hint">(optional — overrides kinds/exts)</span>
                <select
                  value={binding.file_id ?? ""}
                  onChange={(e) => setBindingFile(e.target.value || null)}
                >
                  <option value="">Any matching file</option>
                  {binding.file_id && !s.files.some((f) => f.id === binding.file_id) && (
                    <option value={binding.file_id}>(bound file — not in this room)</option>
                  )}
                  {s.files.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
        </div>

        <h3 className="wf-sec-head">Run history</h3>
        <RunHistory runs={runs} nodeCount={nodeCount} nodes={def.nodes} />
      </div>
    </div>
  );
}
