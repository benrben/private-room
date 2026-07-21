import type { WorkflowNode, WorkflowEdge } from "../../api";
import { KIND_LABELS, kindLabel } from "./kinds";

type Props = {
  node: WorkflowNode;
  onChange: (n: WorkflowNode) => void;
  onDelete: () => void;
  /** The def's full edge list — passed so a condition/route step can author its
   * outgoing branches in-place. */
  edges?: WorkflowEdge[];
  /** All nodes in the def — the branch target picker. */
  allNodes?: WorkflowNode[];
  /** Replace the def's edge list (branch editor). */
  onEdgesChange?: (edges: WorkflowEdge[]) => void;
  /** Room files — so a script_run node can pick a .py/.js script. */
  files?: { id: string; name: string }[];
};

const FILE_SELECTORS = [
  ["newest", "Newest file"],
  ["all", "All files"],
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
const TRANSFORM_OPS = [
  ["trim", "Trim whitespace"],
  ["upper", "UPPERCASE"],
  ["lower", "lowercase"],
  ["append", "Append text…"],
  ["prepend", "Prepend text…"],
  ["replace", "Find & replace…"],
  ["truncate", "Truncate to N chars…"],
  ["strip_html", "Strip HTML tags"],
];

/** Every engine-supported step kind and its human label — from the shared
 * kinds map so the dropdown, the canvas, and the backend backfill never drift. */
const NODE_KINDS: [string, string][] = Object.entries(KIND_LABELS);

/** Fields each kind needs seeded on a kind switch. serde requires the required
 * fields to even parse the def, so seeding them keeps validation showing
 * actionable field errors instead of an opaque parse failure. */
const KIND_DEFAULTS: Record<string, Record<string, unknown>> = {
  generate: { prompt: "", model: "auto" },
  summarize_file: { select: { type: "newest" } },
  file_pass: { select: { type: "newest" }, instruction: "", mode: "merge" },
  for_each_file: { select: { type: "all" }, instruction: "", model: "auto" },
  agent_run: { question: "" },
  extract: { fields: [], model: "auto" },
  route: { prompt: "", labels: ["a", "b"], model: "auto" },
  vote: { prompt: "", samples: 3, mode: "concat", model: "auto" },
  refine: { prompt: "", rubric: "", max_rounds: 2, model: "auto" },
  plan_and_map: { objective: "", max_workers: 4, model: "auto" },
  transform: { op: "trim" },
  merge: { mode: "concat" },
  http_fetch: { url: "" },
  script_run: { file: "", mode: "import" },
  save_file: { name_template: "", format: "html", mode: "create" },
  condition: { op: "not_empty", input: "", value: "" },
};

/** Kinds that call a model — they get the auto/local/cloud picker. */
const MODEL_KINDS = new Set([
  "generate",
  "for_each_file",
  "extract",
  "route",
  "vote",
  "refine",
  "plan_and_map",
]);

function nodeName(n: WorkflowNode): string {
  return (n.label && String(n.label).trim()) || kindLabel(n.kind);
}

/** Parse/format a comma-separated string ⇄ string[] (fields, labels). */
function csv(v: unknown): string {
  return Array.isArray(v) ? (v as string[]).join(", ") : "";
}
function parseCsv(raw: string): string[] {
  return raw.split(",").map((x) => x.trim()).filter(Boolean);
}

export function NodeParamSheet({ node, onChange, onDelete, edges, allNodes, onEdgesChange, files }: Props) {
  const set = (k: string, v: unknown) => onChange({ ...node, [k]: v });
  const sel = (node.select as { type?: string; pattern?: string } | undefined) ?? {};
  const setSel = (patch: Record<string, unknown>) =>
    set("select", { type: sel.type ?? "newest", pattern: sel.pattern, ...patch });

  /** Switch a step's kind, seeding the new kind's required/default params. */
  function setKind(kind: string) {
    if (kind === node.kind) return;
    onChange({ id: node.id, label: node.label, kind, ...KIND_DEFAULTS[kind] } as WorkflowNode);
  }

  const scripts = (files ?? []).filter((f) => /\.(py|js)$/i.test(f.name));

  // ---- branch editing (condition then/else, or a route's labels) ----
  const isBranchSource = node.kind === "condition" || node.kind === "route";
  const routeLabels = Array.isArray(node.labels) ? (node.labels as string[]) : [];
  const branchOptions: [string, string][] =
    node.kind === "route"
      ? routeLabels.map((l) => [l, l] as [string, string])
      : [
          ["then", "then →"],
          ["else", "else →"],
        ];
  const otherNodes = (allNodes ?? []).filter((n) => n.id !== node.id);
  function editEdge(globalIdx: number, patch: Partial<WorkflowEdge>) {
    onEdgesChange?.((edges ?? []).map((e, i) => (i === globalIdx ? { ...e, ...patch } : e)));
  }
  function removeEdge(globalIdx: number) {
    onEdgesChange?.((edges ?? []).filter((_, i) => i !== globalIdx));
  }
  function addBranch() {
    // Target the node right after this one (forward → never a back-edge cycle),
    // else the first other node — NEVER "" (which validated as `unknown node ''`).
    const nodes = allNodes ?? [];
    const idx = nodes.findIndex((n) => n.id === node.id);
    const target = (idx >= 0 ? nodes[idx + 1]?.id : undefined) ?? otherNodes[0]?.id;
    if (!target) return; // no possible target (button is disabled anyway)
    // Assign the first UNUSED branch label so route branches don't all reuse "a"
    // and condition auto-fills then → else.
    const used = new Set((edges ?? []).filter((e) => e.from === node.id).map((e) => e.branch ?? ""));
    const branch = branchOptions.find(([v]) => !used.has(v))?.[0] ?? branchOptions[0]?.[0] ?? "then";
    onEdgesChange?.([...(edges ?? []), { from: node.id, to: target, branch }]);
  }

  // ---- fan-in: which steps feed INTO this node (plain, non-branch edges) ----
  function toggleInput(fromId: string) {
    const cur = edges ?? [];
    const has = cur.some((e) => e.from === fromId && e.to === node.id && e.branch == null);
    onEdgesChange?.(
      has
        ? cur.filter((e) => !(e.from === fromId && e.to === node.id && e.branch == null))
        : [...cur, { from: fromId, to: node.id }],
    );
  }

  const ModelSeg = (
    <label>
      Model
      <div className="wf-seg">
        {["auto", "local", "cloud"].map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={(node.model ?? "auto") === m}
            className={(node.model ?? "auto") === m ? "active" : ""}
            onClick={() => set("model", m)}
          >
            {m[0].toUpperCase() + m.slice(1)}
          </button>
        ))}
      </div>
    </label>
  );

  return (
    <div className="node-param-sheet">
      <label>
        Step name
        <input
          type="text"
          value={String(node.label ?? "")}
          placeholder={kindLabel(node.kind)}
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
        <label>
          Prompt <span style={{ opacity: 0.6, fontWeight: 400 }}>({"{{input}} {{files}} {{date}}"})</span>
          <textarea value={String(node.prompt ?? "")} onChange={(e) => set("prompt", e.target.value)} />
        </label>
      )}

      {(node.kind === "summarize_file" || node.kind === "file_pass" || node.kind === "for_each_file") && (
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
              <input type="text" value={String(sel.pattern ?? "")} onChange={(e) => setSel({ pattern: e.target.value })} />
            </label>
          )}
        </>
      )}

      {node.kind === "file_pass" && (
        <>
          <label>
            Instruction
            <textarea value={String(node.instruction ?? "")} onChange={(e) => set("instruction", e.target.value)} />
          </label>
          <label>
            Mode
            <div className="wf-seg">
              {["merge", "stitch"].map((m) => (
                <button key={m} type="button" aria-pressed={(node.mode ?? "merge") === m} className={(node.mode ?? "merge") === m ? "active" : ""} onClick={() => set("mode", m)}>
                  {m}
                </button>
              ))}
            </div>
          </label>
        </>
      )}

      {node.kind === "for_each_file" && (
        <label>
          Instruction <span style={{ opacity: 0.6, fontWeight: 400 }}>(run on EACH file)</span>
          <textarea value={String(node.instruction ?? "")} onChange={(e) => set("instruction", e.target.value)} />
        </label>
      )}

      {node.kind === "agent_run" && (
        <label>
          Question for the agent
          <textarea value={String(node.question ?? "")} onChange={(e) => set("question", e.target.value)} />
        </label>
      )}

      {node.kind === "extract" && (
        <label>
          Fields to pull out <span style={{ opacity: 0.6, fontWeight: 400 }}>(comma-separated)</span>
          <input
            type="text"
            placeholder="title, author, date"
            value={csv(node.fields)}
            onChange={(e) => set("fields", parseCsv(e.target.value))}
          />
        </label>
      )}

      {node.kind === "route" && (
        <>
          <label>
            Question <span style={{ opacity: 0.6, fontWeight: 400 }}>(how to classify {"{{input}}"})</span>
            <textarea value={String(node.prompt ?? "")} onChange={(e) => set("prompt", e.target.value)} />
          </label>
          <label>
            Labels <span style={{ opacity: 0.6, fontWeight: 400 }}>(comma-separated — each becomes a branch)</span>
            <input
              type="text"
              placeholder="urgent, normal, ignore"
              value={csv(node.labels)}
              onChange={(e) => set("labels", parseCsv(e.target.value))}
            />
          </label>
        </>
      )}

      {node.kind === "vote" && (
        <>
          <label>
            Prompt <span style={{ opacity: 0.6, fontWeight: 400 }}>({"{{input}}"})</span>
            <textarea value={String(node.prompt ?? "")} onChange={(e) => set("prompt", e.target.value)} />
          </label>
          <label>
            Samples
            <input
              type="number"
              min={1}
              max={7}
              value={Number(node.samples ?? 3)}
              onChange={(e) => set("samples", Math.max(1, Math.min(7, Number(e.target.value) || 1)))}
            />
          </label>
          <label>
            Combine
            <div className="wf-seg">
              {[
                ["concat", "All samples"],
                ["majority", "Majority"],
              ].map(([v, l]) => (
                <button key={v} type="button" aria-pressed={(node.mode ?? "concat") === v} className={(node.mode ?? "concat") === v ? "active" : ""} onClick={() => set("mode", v)}>
                  {l}
                </button>
              ))}
            </div>
          </label>
        </>
      )}

      {node.kind === "refine" && (
        <>
          <label>
            Prompt <span style={{ opacity: 0.6, fontWeight: 400 }}>({"{{input}} {{files}}"})</span>
            <textarea value={String(node.prompt ?? "")} onChange={(e) => set("prompt", e.target.value)} />
          </label>
          <label>
            Quality bar <span style={{ opacity: 0.6, fontWeight: 400 }}>(what a good result must be)</span>
            <textarea value={String(node.rubric ?? "")} onChange={(e) => set("rubric", e.target.value)} />
          </label>
          <label>
            Max rounds
            <input
              type="number"
              min={1}
              max={4}
              value={Number(node.max_rounds ?? 2)}
              onChange={(e) => set("max_rounds", Math.max(1, Math.min(4, Number(e.target.value) || 1)))}
            />
          </label>
        </>
      )}

      {node.kind === "plan_and_map" && (
        <>
          <label>
            Objective <span style={{ opacity: 0.6, fontWeight: 400 }}>({"{{input}} {{files}}"})</span>
            <textarea value={String(node.objective ?? "")} onChange={(e) => set("objective", e.target.value)} />
          </label>
          <label>
            Max subtasks
            <input
              type="number"
              min={1}
              max={8}
              value={Number(node.max_workers ?? 4)}
              onChange={(e) => set("max_workers", Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
            />
          </label>
        </>
      )}

      {node.kind === "transform" && (
        <>
          <label>
            Operation
            <select value={String(node.op ?? "trim")} onChange={(e) => set("op", e.target.value)}>
              {TRANSFORM_OPS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          {node.op === "replace" && (
            <label>
              Find
              <input type="text" value={String(node.find ?? "")} onChange={(e) => set("find", e.target.value)} />
            </label>
          )}
          {(node.op === "replace" || node.op === "append" || node.op === "prepend" || node.op === "truncate") && (
            <label>
              {node.op === "truncate" ? "Character count" : node.op === "replace" ? "Replace with" : "Text"}
              <input type="text" value={String(node.value ?? "")} onChange={(e) => set("value", e.target.value)} />
            </label>
          )}
        </>
      )}

      {node.kind === "merge" && (
        <label>
          How to combine branches
          <select value={String(node.mode ?? "concat")} onChange={(e) => set("mode", e.target.value)}>
            <option value="concat">Concatenate</option>
            <option value="numbered">Numbered list</option>
            <option value="dedupe_lines">Dedupe lines</option>
          </select>
        </label>
      )}

      {node.kind === "http_fetch" && (
        <label>
          URL <span style={{ opacity: 0.6, fontWeight: 400 }}>({"{{input}} {{date}}"})</span>
          <input type="text" placeholder="https://…" value={String(node.url ?? "")} onChange={(e) => set("url", e.target.value)} />
        </label>
      )}

      {node.kind === "script_run" && (
        <>
          <label>
            Script
            {scripts.length > 0 ? (
              <select value={String(node.file ?? "")} onChange={(e) => set("file", e.target.value)}>
                <option value="">Choose a .py / .js file…</option>
                {Boolean(node.file) && !scripts.some((f) => f.id === node.file || f.name === node.file) && (
                  <option value={String(node.file)}>{String(node.file)} (not in this room)</option>
                )}
                {scripts.map((f) => (
                  <option key={f.id} value={f.name}>
                    {f.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                placeholder="script.py"
                value={String(node.file ?? "")}
                onChange={(e) => set("file", e.target.value)}
              />
            )}
          </label>
          <div className="field" role="radiogroup" aria-label="Script mode">
            <span className="field-head">Mode</span>
            <div className="wf-seg">
              {[
                ["import", "Import files"],
                ["transform", "Pipe (in→out)"],
              ].map(([v, l]) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={(node.mode ?? "import") === v}
                  className={(node.mode ?? "import") === v ? "active" : ""}
                  onClick={() => set("mode", v)}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div className="caption">
            {(node.mode ?? "import") === "transform"
              ? "Pipe mode: the upstream {{input}} is sent to the script's stdin, and its stdout becomes this step's output. Any files the script writes are still imported into the room."
              : "Import mode: the script runs and its output files are imported back into the room; this step's result is the run report (exit code, stdout/stderr)."}
          </div>
        </>
      )}

      {node.kind === "save_file" && (
        <>
          <label>
            File name <span style={{ opacity: 0.6, fontWeight: 400 }}>({"{{date}}"})</span>
            <input type="text" value={String(node.name_template ?? "")} onChange={(e) => set("name_template", e.target.value)} />
          </label>
          <label>
            Format
            <div className="wf-seg">
              {["html", "md"].map((m) => (
                <button key={m} type="button" aria-pressed={(node.format ?? "html") === m} className={(node.format ?? "html") === m ? "active" : ""} onClick={() => set("format", m)}>
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
              <input type="text" value={String(node.value ?? "")} onChange={(e) => set("value", e.target.value)} />
            </label>
          )}
        </>
      )}

      {node.kind === "generate" && ModelSeg}
      {MODEL_KINDS.has(node.kind) && node.kind !== "generate" && ModelSeg}

      {/* Fan-in: pick which steps feed into this one (check several to merge
          parallel branches here). Branch edges from a condition/route are shown
          read-only so they aren't clobbered. */}
      {onEdgesChange && otherNodes.length > 0 && (
        <div className="wf-branches">
          <div className="wf-branch-label">Runs after (inputs)</div>
          <div className="caption">Check several to merge parallel branches into this step.</div>
          {otherNodes.map((n) => {
            const plain = (edges ?? []).some((e) => e.from === n.id && e.to === node.id && e.branch == null);
            const viaBranch = (edges ?? []).some((e) => e.from === n.id && e.to === node.id && e.branch != null);
            return (
              <label key={n.id} className="wf-input-row">
                <input
                  type="checkbox"
                  checked={plain || viaBranch}
                  disabled={viaBranch}
                  onChange={() => toggleInput(n.id)}
                />
                <span>
                  {nodeName(n)}
                  {viaBranch ? " (via branch)" : ""}
                </span>
              </label>
            );
          })}
        </div>
      )}

      {/* Branch editor — condition (then/else) or route (its labels) */}
      {isBranchSource && onEdgesChange && (
        <div className="wf-branches">
          <div className="wf-branch-label">Branches (where each outcome goes)</div>
          {node.kind === "route" && routeLabels.length < 2 && (
            <div className="caption">Add at least two labels above to route between.</div>
          )}
          {!(edges ?? []).some((e) => e.from === node.id) && (
            <div className="caption">No branches yet — add one to route each outcome.</div>
          )}
          {(edges ?? []).map((e, i) =>
            e.from === node.id ? (
              <div key={i} className="wf-branch-row">
                <select value={e.branch ?? branchOptions[0]?.[0] ?? ""} onChange={(ev) => editEdge(i, { branch: ev.target.value })}>
                  {branchOptions.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
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

      <button className="subtle" data-agent-blocked onClick={onDelete} style={{ alignSelf: "flex-start" }}>
        Delete step
      </button>
    </div>
  );
}
