import type { Workflow, WorkflowBinding, WorkflowDef, WorkflowEdge, WorkflowNode, WorkflowRun } from "../../api";
import type { WSState } from "../state";
import type { WSActions } from "../actions";
import { branchFor } from "./selectors";
import { coveredKinds } from "../../viewers/registry";

export const KIND_UNION = coveredKinds();

export type Props = { s: WSState; a: WSActions; workflow: Workflow };

/** The comma-joined extension list for a binding's text input. */
export function extsOf(b: WorkflowBinding): string {
  return b.scope === "file" ? (b.exts ?? []).join(", ") : "";
}
/** Parse a comma-separated extension list (drops leading dots, lowercases). */
export function parseExts(raw: string): string[] {
  return raw
    .split(",")
    .map((x) => x.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean);
}

/** Turn a backend validation sentence (which names nodes by their internal id,
 * e.g. `Node 'nmrt1v6mp1' …`) into human text — swapping each quoted id for the
 * step's label — and surface the first referenced node id so the error can be
 * clicked to select that step. */
export function humanizeError(
  msg: string,
  nodes: WorkflowNode[],
): { text: string; nodeId: string | null } {
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

type WorkflowForm = {
  name: string;
  emoji: string;
  def: WorkflowDef;
  binding: WorkflowBinding;
};

export function defaultEmoji(emoji: string | null | undefined): string {
  return emoji || "⚙️";
}

export function workflowForm(workflow: Workflow): WorkflowForm {
  return {
    name: workflow.name,
    emoji: defaultEmoji(workflow.emoji),
    def: workflow.definition,
    binding: workflow.binding,
  };
}

export function savedFormKey(workflow: Workflow): string {
  const form = workflowForm(workflow);
  return JSON.stringify([form.name, form.emoji, form.def, form.binding]);
}

export function formIsDirty(form: WorkflowForm, workflow: Workflow): boolean {
  const saved = workflowForm(workflow);
  return (
    form.name !== saved.name ||
    form.emoji !== saved.emoji ||
    JSON.stringify(form.def) !== JSON.stringify(saved.def) ||
    JSON.stringify(form.binding) !== JSON.stringify(saved.binding)
  );
}

export function selectedNodeOf(
  def: WorkflowDef,
  selected: string | null,
): WorkflowNode | null {
  return def.nodes.find((node) => node.id === selected) ?? null;
}

export function runningJobIdOf(runs: WorkflowRun[]): string | null {
  return runs.find((run) => run.status === "running")?.jobId ?? null;
}

export function isFileScopedBinding(binding: WorkflowBinding): boolean {
  return binding.scope === "file";
}

export function isValidWorkflow(checking: boolean, errors: string[]): boolean {
  return !checking && errors.length === 0;
}

type RunBlockInput = {
  checking: boolean;
  dirty: boolean;
  errors: string[];
  fileScoped: boolean;
  isDraft: boolean;
};

export function runBlockReason({
  checking,
  dirty,
  errors,
  fileScoped,
  isDraft,
}: RunBlockInput): string | null {
  if (fileScoped) {
    return "This workflow runs on a chosen file — start it from that file's Actions menu.";
  }
  if (!isDraft) return null;
  if (checking) return "Checking this workflow…";
  if (errors.length > 0) return `Can't run yet — ${errors[0]}`;
  return dirty
    ? "Save your changes first — a test run uses the saved version."
    : null;
}

function appendNode(def: WorkflowDef, node: WorkflowNode): WorkflowDef {
  const last = def.nodes[def.nodes.length - 1];
  const edges = last
    ? [...def.edges, { from: last.id, to: node.id }]
    : def.edges;
  return { ...def, nodes: [...def.nodes, node], edges };
}

function isBranchSource(node: WorkflowNode | undefined): boolean {
  return node?.kind === "condition" || node?.kind === "route";
}

function insertBranchNode(
  def: WorkflowDef,
  node: WorkflowNode,
  afterId: string,
  after: WorkflowNode,
  successors: WorkflowEdge[],
): WorkflowDef {
  const first = successors[0];
  if (first) {
    const edges = [
      ...def.edges.map((edge) =>
        edge === first ? { ...edge, to: node.id } : edge,
      ),
      { from: node.id, to: first.to },
    ];
    return { ...def, nodes: [...def.nodes, node], edges };
  }
  const edges = [
    ...def.edges,
    { from: afterId, to: node.id, branch: branchFor(after, successors) },
  ];
  return { ...def, nodes: [...def.nodes, node], edges };
}

function insertLinearNode(
  def: WorkflowDef,
  node: WorkflowNode,
  afterId: string,
  successors: WorkflowEdge[],
): WorkflowDef {
  const rest = def.edges.filter((edge) => edge.from !== afterId);
  const edges: WorkflowEdge[] = [
    ...rest,
    { from: afterId, to: node.id },
    ...successors.map((edge) => ({ from: node.id, to: edge.to })),
  ];
  return { ...def, nodes: [...def.nodes, node], edges };
}

export function addNodeAfter(
  def: WorkflowDef,
  afterId: string | null | undefined,
): WorkflowDef {
  const node = newNode(def.nodes.length);
  if (!afterId) return appendNode(def, node);
  const after = def.nodes.find((candidate) => candidate.id === afterId);
  const successors = def.edges.filter((edge) => edge.from === afterId);
  return after !== undefined && isBranchSource(after)
    ? insertBranchNode(def, node, afterId, after, successors)
    : insertLinearNode(def, node, afterId, successors);
}

export function addParallelNode(def: WorkflowDef, afterId: string): WorkflowDef {
  const node = newNode(def.nodes.length);
  const after = def.nodes.find((candidate) => candidate.id === afterId);
  const branch = branchFor(
    after,
    def.edges.filter((edge) => edge.from === afterId),
  );
  return {
    ...def,
    nodes: [...def.nodes, node],
    edges: [...def.edges, { from: afterId, to: node.id, branch }],
  };
}

export function runButtonLabel(isDraft: boolean): string {
  return isDraft ? "Test run" : "Run now";
}

export function runButtonTitle(runBlocked: string | null, isDraft: boolean): string {
  if (runBlocked !== null) return runBlocked;
  return isDraft
    ? "Run this draft once now, without activating it"
    : "Run this workflow now";
}

export function activeButtonTitle(checking: boolean, errors: string[]): string {
  if (checking) return "Checking this workflow…";
  if (errors.length > 0) return `Can't activate yet — ${errors[0]}`;
  return "Save and activate this workflow";
}

export function pinButtonLabel(pinned: boolean): string {
  return pinned ? "Pinned" : "Pin";
}

export function pinButtonTitle(pinned: boolean): string {
  return pinned ? "Unpin from the top bar" : "Pin to the top bar";
}
