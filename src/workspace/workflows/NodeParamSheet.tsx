import type { WorkflowNode } from "../../api";

type Props = {
  node: WorkflowNode;
  onChange: (n: WorkflowNode) => void;
  onDelete: () => void;
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

export function NodeParamSheet({ node, onChange, onDelete }: Props) {
  const set = (k: string, v: unknown) => onChange({ ...node, [k]: v });
  const sel = (node.select as { type?: string; pattern?: string } | undefined) ?? {};
  const setSel = (patch: Record<string, unknown>) =>
    set("select", { type: sel.type ?? "newest", pattern: sel.pattern, ...patch });

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
        </>
      )}

      <button className="subtle" data-agent-blocked onClick={onDelete} style={{ alignSelf: "flex-start" }}>
        Delete step
      </button>
    </div>
  );
}
