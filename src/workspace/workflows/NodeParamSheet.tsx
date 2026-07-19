import type { WorkflowNode, WorkflowEdge } from "../../api";

type Props = {
  node: WorkflowNode;
  onChange: (n: WorkflowNode) => void;
  onDelete: () => void;
  /** The def's full edge list — passed so a condition step can author its
   * then/else branches in-place. */
  edges?: WorkflowEdge[];
  /** All nodes in the def — the branch target picker. */
  allNodes?: WorkflowNode[];
  /** Replace the def's edge list (condition branch editor). */
  onEdgesChange?: (edges: WorkflowEdge[]) => void;
};

const FILE_SELECTORS = [
  ["newest", "Newest file"],
  ["name_like", "Name contains…"],
  ["missing_summary", "Files missing a summary"],
  ["since_last_run", "Added since last run"],
  ["run_input", "The file this runs on"],
];
const CONDITION_OPS = [
  ["not_empty", "Input is not empty"],
  ["is_empty", "Input is empty"],
  ["contains", "Input contains…"],
  ["not_contains", "Input does not contain…"],
  ["new_files_since_last_run", "New files since last run"],
];

/** The six engine-supported step kinds and their human labels. */
const NODE_KINDS: [string, string][] = [
  ["generate", "Generate text"],
  ["summarize_file", "Summarize a file"],
  ["file_pass", "Full-file pass"],
  ["agent_run", "Ask the agent"],
  ["save_file", "Save a file"],
  ["condition", "Condition"],
];

/** Fields each kind needs seeded on a kind switch. serde requires
 * prompt/question/op/name_template to even parse the def, so seeding them (to
 * "" or a sensible default) keeps validation showing actionable field errors
 * instead of an opaque parse failure. `mode` differs per kind, so it is reset. */
const KIND_DEFAULTS: Record<string, Record<string, unknown>> = {
  generate: { prompt: "", model: "auto" },
  summarize_file: { select: { type: "newest" } },
  file_pass: { select: { type: "newest" }, instruction: "", mode: "merge" },
  agent_run: { question: "" },
  save_file: { name_template: "", format: "html", mode: "create" },
  condition: { op: "not_empty", input: "", value: "" },
};

function nodeName(n: WorkflowNode): string {
  return (n.label && String(n.label)) || n.kind;
}

export function NodeParamSheet({ node, onChange, onDelete, edges, allNodes, onEdgesChange }: Props) {
  const set = (k: string, v: unknown) => onChange({ ...node, [k]: v });
  const sel = (node.select as { type?: string; pattern?: string } | undefined) ?? {};
  const setSel = (patch: Record<string, unknown>) =>
    set("select", { type: sel.type ?? "newest", pattern: sel.pattern, ...patch });

  /** Switch a step's kind, seeding the new kind's required/default params. */
  function setKind(kind: string) {
    if (kind === node.kind) return;
    onChange({ id: node.id, label: node.label, kind, ...KIND_DEFAULTS[kind] } as WorkflowNode);
  }

  // ---- condition branch editing (then/else outgoing edges) ----
  const otherNodes = (allNodes ?? []).filter((n) => n.id !== node.id);
  function editEdge(globalIdx: number, patch: Partial<WorkflowEdge>) {
    onEdgesChange?.((edges ?? []).map((e, i) => (i === globalIdx ? { ...e, ...patch } : e)));
  }
  function removeEdge(globalIdx: number) {
    onEdgesChange?.((edges ?? []).filter((_, i) => i !== globalIdx));
  }
  function addBranch() {
    // Default the new branch FORWARD — to the node right after this condition in
    // pipeline order (nodes are appended in order) — so a fresh branch never
    // wires back into an earlier node and forms a cycle. When the condition is
    // the last node, leave the target unset ("") so validation prompts for a
    // real forward pick instead of silently emitting a back-edge into the root.
    const nodes = allNodes ?? [];
    const idx = nodes.findIndex((n) => n.id === node.id);
    // idx >= 0 in practice (the edited node is one of allNodes); guard the -1
    // case explicitly so a not-found node never falls back to nodes[0] (the
    // root) and re-creates the very back-edge cycle this fix removes.
    const target = idx >= 0 ? (nodes[idx + 1]?.id ?? "") : "";
    onEdgesChange?.([...(edges ?? []), { from: node.id, to: target, branch: "then" }]);
  }

  return (
    <div className="node-param-sheet">
      <label>
        Step name
        <input
          type="text"
          value={String(node.label ?? "")}
          onChange={(e) => set("label", e.target.value)}
        />
      </label>

      <label>
        Step type
        <select value={node.kind} onChange={(e) => setKind(e.target.value)}>
          {NODE_KINDS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>

      {node.kind === "generate" && (
        <>
          <label>
            Prompt <span style={{ opacity: 0.6, fontWeight: 400 }}>({"{{input}} {{files}} {{date}}"})</span>
            <textarea
              value={String(node.prompt ?? "")}
              onChange={(e) => set("prompt", e.target.value)}
            />
          </label>
          <label>
            Model
            <div className="wf-seg">
              {["auto", "local", "cloud"].map((m) => (
                <button
                  key={m}
                  className={(node.model ?? "auto") === m ? "active" : ""}
                  onClick={() => set("model", m)}
                >
                  {m[0].toUpperCase() + m.slice(1)}
                </button>
              ))}
            </div>
          </label>
        </>
      )}

      {(node.kind === "summarize_file" || node.kind === "file_pass") && (
        <>
          <label>
            Which file(s)
            <select value={sel.type ?? "newest"} onChange={(e) => setSel({ type: e.target.value })}>
              {FILE_SELECTORS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          {sel.type === "name_like" && (
            <label>
              Name pattern
              <input
                type="text"
                value={String(sel.pattern ?? "")}
                onChange={(e) => setSel({ pattern: e.target.value })}
              />
            </label>
          )}
        </>
      )}

      {node.kind === "file_pass" && (
        <>
          <label>
            Instruction
            <textarea
              value={String(node.instruction ?? "")}
              onChange={(e) => set("instruction", e.target.value)}
            />
          </label>
          <label>
            Mode
            <div className="wf-seg">
              {["merge", "stitch"].map((m) => (
                <button
                  key={m}
                  className={(node.mode ?? "merge") === m ? "active" : ""}
                  onClick={() => set("mode", m)}
                >
                  {m}
                </button>
              ))}
            </div>
          </label>
        </>
      )}

      {node.kind === "agent_run" && (
        <label>
          Question for the agent
          <textarea
            value={String(node.question ?? "")}
            onChange={(e) => set("question", e.target.value)}
          />
        </label>
      )}

      {node.kind === "save_file" && (
        <>
          <label>
            File name <span style={{ opacity: 0.6, fontWeight: 400 }}>({"{{date}}"})</span>
            <input
              type="text"
              value={String(node.name_template ?? "")}
              onChange={(e) => set("name_template", e.target.value)}
            />
          </label>
          <label>
            Format
            <div className="wf-seg">
              {["html", "md"].map((m) => (
                <button
                  key={m}
                  className={(node.format ?? "html") === m ? "active" : ""}
                  onClick={() => set("format", m)}
                >
                  {m}
                </button>
              ))}
            </div>
          </label>
          <label>
            When it exists
            <select value={String(node.mode ?? "create")} onChange={(e) => set("mode", e.target.value)}>
              <option value="create">Create a new file</option>
              <option value="overwrite">Overwrite</option>
              <option value="append">Append</option>
            </select>
          </label>
        </>
      )}

      {node.kind === "condition" && (
        <>
          <label>
            Condition
            <select value={String(node.op ?? "not_empty")} onChange={(e) => set("op", e.target.value)}>
              {CONDITION_OPS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          {(node.op === "contains" || node.op === "not_contains") && (
            <label>
              Text
              <input
                type="text"
                value={String(node.value ?? "")}
                onChange={(e) => set("value", e.target.value)}
              />
            </label>
          )}
          {onEdgesChange && (
            <div className="wf-branches">
              <div className="wf-branch-label">Branches (where each outcome goes)</div>
              {!(edges ?? []).some((e) => e.from === node.id) && (
                <div className="caption">No branches yet — add one to route the then / else outcomes.</div>
              )}
              {(edges ?? []).map((e, i) =>
                e.from === node.id ? (
                  <div key={i} className="wf-branch-row">
                    <select
                      value={e.branch ?? "then"}
                      onChange={(ev) => editEdge(i, { branch: ev.target.value as "then" | "else" })}
                    >
                      <option value="then">then →</option>
                      <option value="else">else →</option>
                    </select>
                    <select value={e.to} onChange={(ev) => editEdge(i, { to: ev.target.value })}>
                      {otherNodes.map((n) => (
                        <option key={n.id} value={n.id}>
                          {nodeName(n)}
                        </option>
                      ))}
                    </select>
                    <button className="subtle" title="Remove branch" onClick={() => removeEdge(i)}>
                      ×
                    </button>
                  </div>
                ) : null,
              )}
              <button className="subtle" onClick={addBranch} disabled={otherNodes.length === 0}>
                + Add branch
              </button>
            </div>
          )}
        </>
      )}

      <button className="subtle" data-agent-blocked onClick={onDelete} style={{ alignSelf: "flex-start" }}>
        Delete step
      </button>
    </div>
  );
}
