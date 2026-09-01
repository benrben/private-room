import type { WorkflowEdge, WorkflowNode } from "../../api";
import { KIND_DEFAULTS, KIND_LABELS, kindLabel } from "./kinds";
import { branchFor } from "./selectors";
import { MODEL_KINDS, ModelPicker, NodeKindFields } from "./NodeKindFields";

type Props = {
  node: WorkflowNode;
  onChange: (node: WorkflowNode) => void;
  onDelete: () => void;
  edges?: WorkflowEdge[];
  allNodes?: WorkflowNode[];
  onEdgesChange?: (edges: WorkflowEdge[]) => void;
  files?: { id: string; name: string }[];
};
type SetNode = (key: string, value: unknown) => void;
type FormProps = { node: WorkflowNode; set: SetNode };
type BranchOption = [string, string];

const NODE_KINDS: [string, string][] = Object.entries(KIND_LABELS);
function nodeName(node: WorkflowNode): string {
  return (node.label && String(node.label).trim()) || kindLabel(node.kind);
}
function FanInEditor({
  node,
  edges = [],
  allNodes = [],
  onEdgesChange,
}: Pick<Props, "node" | "edges" | "allNodes" | "onEdgesChange">) {
  const others = allNodes.filter((other) => other.id !== node.id);
  if (!onEdgesChange || others.length === 0) return null;
  const toggle = (fromId: string) => {
    const plain = edges.some(
      (edge) =>
        edge.from === fromId && edge.to === node.id && edge.branch == null,
    );
    const from = allNodes.find((other) => other.id === fromId);
    const branch = branchFor(
      from,
      edges.filter((edge) => edge.from === fromId),
    );
    const next = plain
      ? edges.filter(
          (edge) =>
            !(
              edge.from === fromId &&
              edge.to === node.id &&
              edge.branch == null
            ),
        )
      : [
          ...edges,
          branch
            ? { from: fromId, to: node.id, branch }
            : { from: fromId, to: node.id },
        ];
    onEdgesChange(next);
  };
  return (
    <div className="wf-branches">
      <div className="wf-branch-label">Runs after (inputs)</div>
      <div className="caption">
        Check several to merge parallel branches into this step.
      </div>
      {others.map((other) => {
        const plain = edges.some(
          (edge) =>
            edge.from === other.id &&
            edge.to === node.id &&
            edge.branch == null,
        );
        const viaBranch = edges.some(
          (edge) =>
            edge.from === other.id &&
            edge.to === node.id &&
            edge.branch != null,
        );
        return (
          <label key={other.id} className="wf-input-row">
            <input
              type="checkbox"
              checked={plain || viaBranch}
              disabled={viaBranch}
              onChange={() => toggle(other.id)}
            />
            <span>
              {nodeName(other)}
              {viaBranch ? " (via branch)" : ""}
            </span>
          </label>
        );
      })}
    </div>
  );
}

function branchOptions(node: WorkflowNode): BranchOption[] {
  if (node.kind === "route")
    return (Array.isArray(node.labels) ? node.labels : []).map((label) => [
      String(label),
      String(label),
    ]);
  return [
    ["then", "then →"],
    ["else", "else →"],
  ];
}
function nextBranch(
  options: BranchOption[],
  edges: WorkflowEdge[],
  id: string,
): string {
  const used = new Set(
    edges.filter((edge) => edge.from === id).map((edge) => edge.branch ?? ""),
  );
  return (
    options.find(([value]) => !used.has(value))?.[0] ??
    options[0]?.[0] ??
    "then"
  );
}
function branchSource(node: WorkflowNode) {
  return node.kind === "condition" || node.kind === "route";
}
function RouteHint({
  node,
  options,
}: {
  node: WorkflowNode;
  options: BranchOption[];
}) {
  if (node.kind !== "route" || options.length >= 2) return null;
  return (
    <div className="caption">
      Add at least two labels above to route between.
    </div>
  );
}
function EmptyBranchHint({ own }: { own: WorkflowEdge[] }) {
  if (own.length > 0) return null;
  return (
    <div className="caption">
      No branches yet — add one to route each outcome.
    </div>
  );
}
function OwnBranchRows({
  node,
  own,
  options,
  allNodes,
  edit,
  remove,
}: {
  node: WorkflowNode;
  own: { edge: WorkflowEdge; index: number }[];
  options: BranchOption[];
  allNodes: WorkflowNode[];
  edit: (index: number, patch: Partial<WorkflowEdge>) => void;
  remove: (index: number) => void;
}) {
  const others = allNodes.filter((other) => other.id !== node.id);
  return (
    <>
      {own.map(({ edge, index }) => (
        <div key={index} className="wf-branch-row">
          <select
            value={edge.branch ?? options[0]?.[0] ?? ""}
            onChange={(event) => edit(index, { branch: event.target.value })}
          >
            {options.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            value={edge.to}
            onChange={(event) => edit(index, { to: event.target.value })}
          >
            {others.map((other) => (
              <option key={other.id} value={other.id}>
                {nodeName(other)}
              </option>
            ))}
          </select>
          <button
            className="subtle"
            title="Remove branch"
            aria-label="Remove branch"
            onClick={() => remove(index)}
          >
            ×
          </button>
        </div>
      ))}
    </>
  );
}
function ActiveBranchEditor({
  node,
  edges,
  allNodes,
  onEdgesChange,
}: {
  node: WorkflowNode;
  edges: WorkflowEdge[];
  allNodes: WorkflowNode[];
  onEdgesChange: (edges: WorkflowEdge[]) => void;
}) {
  const options = branchOptions(node);
  const others = allNodes.filter((other) => other.id !== node.id);
  const own = edges.filter((edge) => edge.from === node.id);
  const edit = (index: number, patch: Partial<WorkflowEdge>) =>
    onEdgesChange(
      edges.map((edge, at) => (at === index ? { ...edge, ...patch } : edge)),
    );
  const remove = (index: number) =>
    onEdgesChange(edges.filter((_, at) => at !== index));
  const add = () => {
    const at = allNodes.findIndex((other) => other.id === node.id);
    const target =
      (at >= 0 ? allNodes[at + 1]?.id : undefined) ?? others[0]?.id;
    if (target)
      onEdgesChange([
        ...edges,
        {
          from: node.id,
          to: target,
          branch: nextBranch(options, edges, node.id),
        },
      ]);
  };
  const rows = edges
    .map((edge, index) => ({ edge, index }))
    .filter(({ edge }) => edge.from === node.id);
  return (
    <div className="wf-branches">
      <div className="wf-branch-label">Branches (where each outcome goes)</div>
      <RouteHint node={node} options={options} />
      <EmptyBranchHint own={own} />
      <OwnBranchRows
        node={node}
        own={rows}
        options={options}
        allNodes={allNodes}
        edit={edit}
        remove={remove}
      />
      <button className="subtle" onClick={add} disabled={others.length === 0}>
        + Add branch
      </button>
    </div>
  );
}
function BranchEditor({
  node,
  edges = [],
  allNodes = [],
  onEdgesChange,
}: Pick<Props, "node" | "edges" | "allNodes" | "onEdgesChange">) {
  if (!onEdgesChange || !branchSource(node)) return null;
  return (
    <ActiveBranchEditor
      node={node}
      edges={edges}
      allNodes={allNodes}
      onEdgesChange={onEdgesChange}
    />
  );
}

function SheetHeader({
  node,
  set,
  onKindChange,
}: FormProps & { onKindChange: (kind: string) => void }) {
  return (
    <>
      <label>
        Step name
        <input
          type="text"
          value={String(node.label ?? "")}
          placeholder={kindLabel(node.kind)}
          onChange={(event) => set("label", event.target.value)}
        />
      </label>
      <label>
        Step type
        <select
          value={node.kind}
          onChange={(event) => onKindChange(event.target.value)}
        >
          {NODE_KINDS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

export function NodeParamSheet({
  node,
  onChange,
  onDelete,
  edges,
  allNodes,
  onEdgesChange,
  files,
}: Props) {
  const set = (key: string, value: unknown) =>
    onChange({ ...node, [key]: value });
  const setKind = (kind: string) => {
    if (kind !== node.kind)
      onChange({
        id: node.id,
        label: node.label,
        kind,
        ...KIND_DEFAULTS[kind],
      } as WorkflowNode);
  };
  return (
    <div className="node-param-sheet">
      <SheetHeader node={node} set={set} onKindChange={setKind} />
      <NodeKindFields node={node} set={set} files={files} />
      {MODEL_KINDS.has(node.kind) && <ModelPicker node={node} set={set} />}
      <FanInEditor
        node={node}
        edges={edges}
        allNodes={allNodes}
        onEdgesChange={onEdgesChange}
      />
      <BranchEditor
        node={node}
        edges={edges}
        allNodes={allNodes}
        onEdgesChange={onEdgesChange}
      />
      <button
        className="nb-btn nb-btn-danger wf-delete-step"
        data-agent-blocked
        onClick={onDelete}
      >
        Delete step
      </button>
    </div>
  );
}
