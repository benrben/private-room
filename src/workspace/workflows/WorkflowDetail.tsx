import { useEffect, useMemo, useState } from "react";
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
import { WorkflowGlyph, WORKFLOW_ICON_CHOICES } from "./workflowGlyph";
import { PlayIcon, PinIcon, CalendarClockIcon } from "../../icons";

const KIND_UNION = [
  "image", "pdf", "docx", "sheet", "csv", "markdown", "html", "code", "text",
  "audio", "video", "recording", "binary",
];

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
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [showSched, setShowSched] = useState(false);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);

  // Re-seed from the store when the selected workflow (or its saved form) changes.
  useEffect(() => {
    setDef(workflow.definition);
    setName(workflow.name);
    setEmoji(workflow.emoji || "⚙️");
    setBinding(workflow.binding);
    setExtsText(extsOf(workflow.binding));
    /* dirty is derived from a diff */
  }, [workflow.id, workflow.updatedAt]);

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
  useEffect(() => {
    let live = true;
    api.validateWorkflow(def, binding).then((e) => live && setErrors(e)).catch(() => {});
    return () => {
      live = false;
    };
  }, [def, binding]);

  const selectedNode = def.nodes.find((n) => n.id === selected) ?? null;
  const runningJobId = runs.find((r) => r.status === "running")?.jobId ?? null;
  const liveStatus = runningJobId ? s.wfNodeStatus[runningJobId] : undefined;
  const isFileScoped = binding.scope === "file";
  const valid = errors.length === 0;

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
   * that node's successors through the new step (branch labels are dropped since
   * the new step is a plain generate node). Without it, append at the tail. */
  function addNode(afterId?: string | null) {
    setDef((d) => {
      const n = newNode(d.nodes.length);
      if (!afterId) {
        const last = d.nodes[d.nodes.length - 1];
        const edges = last ? [...d.edges, { from: last.id, to: n.id }] : d.edges;
        return { ...d, nodes: [...d.nodes, n], edges };
      }
      const successors = d.edges.filter((e) => e.from === afterId);
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
   * runs independent branches concurrently on the cloud/CPU lanes). */
  function addBranchNode(afterId: string) {
    setDef((d) => {
      const n = newNode(d.nodes.length);
      return { ...d, nodes: [...d.nodes, n], edges: [...d.edges, { from: afterId, to: n.id }] };
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
        <button className="subtle btn-ic" onClick={() => s.setWfDetailId(null)}>
          ← Library
        </button>
        <div className="wf-icon-pick" style={{ position: "relative" }}>
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
        <input
          className="viewer-title"
          style={{ font: "inherit", fontWeight: 600, border: "none", background: "transparent", flex: 1 }}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            /* dirty is derived from a diff */
          }}
        />
        <span className="viewer-actions" style={{ position: "relative" }}>
          <button className="subtle btn-ic" disabled={workflow.status !== "active"} onClick={() => void a.runWorkflowNow(workflow.id)}>
            <PlayIcon size={12} /> Run now
          </button>
          {workflow.status === "active" ? (
            <button className="subtle" onClick={() => void a.setWorkflowStatus(workflow.id, "draft")}>
              Deactivate
            </button>
          ) : (
            <button className="primary" disabled={!valid} onClick={() => void saveAndActivate()}>
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
          <button className="subtle btn-ic" onClick={() => setShowSched((v) => !v)}>
            <CalendarClockIcon size={12} /> Schedule
          </button>
          <button
            className="subtle"
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
          {showSched && (
            <div style={{ position: "absolute", top: "100%", right: 0, zIndex: 30 }}>
              <SchedulePopover
                schedule={schedule}
                disabled={isFileScoped}
                onClose={() => setShowSched(false)}
                onSave={(sc) => void a.setWorkflowSchedule(workflow.id, sc)}
              />
            </div>
          )}
        </span>
      </div>

      <div className="wf-body">
        {workflow.status === "draft" && (
          <div className="wf-badges" style={{ marginBottom: "0.6rem" }}>
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
              <label>
                File kinds it runs on
                <div className="wf-badges">
                  {KIND_UNION.map((k) => (
                    <button
                      key={k}
                      className={`wf-badge ${(binding.kinds ?? []).includes(k) ? "agent" : ""}`}
                      style={{ cursor: "pointer", border: "none" }}
                      onClick={() => toggleKind(k)}
                    >
                      {k}
                    </button>
                  ))}
                </div>
              </label>
              <label>
                File extensions{" "}
                <span style={{ opacity: 0.6, fontWeight: 400 }}>(comma-separated, e.g. pdf, docx)</span>
                <input
                  type="text"
                  value={extsText}
                  placeholder="pdf, docx, md"
                  onChange={(e) => setBindingExts(e.target.value)}
                />
              </label>
              <label>
                Only this specific file{" "}
                <span style={{ opacity: 0.6, fontWeight: 400 }}>(optional — overrides kinds/exts)</span>
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

        <h3 style={{ marginTop: "1.2rem" }}>Run history</h3>
        <RunHistory runs={runs} nodeCount={nodeCount} nodes={def.nodes} />
      </div>
    </div>
  );
}
