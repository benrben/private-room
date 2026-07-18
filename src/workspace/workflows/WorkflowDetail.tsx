import { useEffect, useMemo, useState } from "react";
import { api, Schedule, Workflow, WorkflowDef, WorkflowNode, WorkflowRun } from "../../api";
import { WSState } from "../state";
import { WSActions } from "../actions";
import { PipelineCanvas } from "./PipelineCanvas";
import { NodeParamSheet } from "./NodeParamSheet";
import { SchedulePopover } from "./SchedulePopover";
import { RunHistory } from "./RunHistory";

const KIND_UNION = [
  "image", "pdf", "docx", "sheet", "csv", "markdown", "html", "code", "text",
  "audio", "video", "recording", "binary",
];

type Props = { s: WSState; a: WSActions; workflow: Workflow };

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
  const [selected, setSelected] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [showSched, setShowSched] = useState(false);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);

  // Re-seed from the store when the selected workflow (or its saved form) changes.
  useEffect(() => {
    setDef(workflow.definition);
    setName(workflow.name);
    setEmoji(workflow.emoji || "⚙️");
    setBinding(workflow.binding);
    setDirty(false);
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
    setDirty(true);
  }
  function deleteNode(id: string) {
    setDef((d) => ({
      ...d,
      nodes: d.nodes.filter((n) => n.id !== id),
      edges: d.edges.filter((e) => e.from !== id && e.to !== id),
    }));
    setSelected(null);
    setDirty(true);
  }
  function addNode() {
    setDef((d) => {
      const n = newNode(d.nodes.length);
      const last = d.nodes[d.nodes.length - 1];
      const edges = last ? [...d.edges, { from: last.id, to: n.id }] : d.edges;
      return { ...d, nodes: [...d.nodes, n], edges };
    });
    setDirty(true);
  }

  async function save() {
    await a.saveWorkflowEdits(workflow.id, { name, emoji, definition: def, binding });
    setDirty(false);
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
    setDirty(true);
  }

  return (
    <div className="wf-page">
      <div className="viewer-head">
        <button className="subtle btn-ic" onClick={() => s.setWfDetailId(null)}>
          ← Library
        </button>
        <input
          className="wf-emoji-input"
          style={{ width: "2.2rem", textAlign: "center", font: "inherit" }}
          value={emoji}
          onChange={(e) => {
            setEmoji(e.target.value);
            setDirty(true);
          }}
        />
        <input
          className="viewer-title"
          style={{ font: "inherit", fontWeight: 600, border: "none", background: "transparent", flex: 1 }}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
          }}
        />
        <span className="viewer-actions" style={{ position: "relative" }}>
          <button className="subtle" disabled={workflow.status !== "active"} onClick={() => void a.runWorkflowNow(workflow.id)}>
            ▶ Run now
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
              className="subtle"
              title={workflow.pinned ? "Unpin from the top bar" : "Pin to the top bar"}
              onClick={() => void a.setWorkflowPinned(workflow.id, !workflow.pinned)}
            >
              {workflow.pinned ? "📌 Pinned" : "📌 Pin"}
            </button>
          )}
          <button className="subtle" onClick={() => setShowSched((v) => !v)}>
            🕒 Schedule
          </button>
          <button className="subtle" data-agent-blocked onClick={() => void a.deleteWorkflow(workflow.id)}>
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
              {errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}

        <PipelineCanvas
          def={def}
          status={liveStatus}
          selectedId={selected}
          onSelect={setSelected}
          onAddAfter={addNode}
          editable
        />

        {selectedNode && (
          <NodeParamSheet
            node={selectedNode}
            onChange={updateNode}
            onDelete={() => deleteNode(selectedNode.id)}
          />
        )}

        {/* Binding editor */}
        <div className="node-param-sheet">
          <label>
            Where it appears
            <div className="wf-seg">
              <button
                className={binding.scope === "general" ? "active" : ""}
                onClick={() => {
                  setBinding({ scope: "general" });
                  setDirty(true);
                }}
              >
                General
              </button>
              <button
                className={binding.scope === "file" ? "active" : ""}
                onClick={() => {
                  setBinding({ scope: "file", kinds: [], exts: [] });
                  setDirty(true);
                }}
              >
                Specific files
              </button>
            </div>
          </label>
          {binding.scope === "file" && (
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
          )}
        </div>

        <h3 style={{ marginTop: "1.2rem" }}>Run history</h3>
        <RunHistory runs={runs} nodeCount={nodeCount} />
      </div>
    </div>
  );
}
