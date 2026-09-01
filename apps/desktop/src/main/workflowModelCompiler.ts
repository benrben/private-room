import type { Lane, Step } from "./jobs.js";
import { bestDefault } from "./turnContext.js";
import { bestLocalDefault } from "./ollamaModels.js";
import { runsOnThisMac } from "./capabilities.js";
import { scriptLangOf } from "./scriptRun.js";
import { extensionOf } from "./editMatchExtraction.js";
import { NodeKind, WorkflowNode, WorkflowEdge, WorkflowDef } from "./workflowModelCore.js";
import { validateRunnable, validateWithBinding } from "./workflowModelValidation.js";
import { topoOrder } from "./workflowModelTopology.js";

// ============================================================================
// compiler (workflow.rs:908-1029)
// ============================================================================

/**
 * Resolve a node's model choice to (model_name, lane). Ported from
 * `resolve_node_model` (module-private in Rust; exported here so its own
 * behaviour has a direct test). Mirrors `resolve_pass_engine`'s doctrine —
 * engine parity: "auto" and a literal honor whatever the user chose,
 * INCLUDING external CLIs (the sidecar's external backend runs them); "local"
 * stays a hard local pick; "cloud" prefers an installed `:cloud` proxy.
 * Lane = remote engines → Cloud.
 */
export function automaticNodeModel(roomModel: string | null, models: readonly string[]): string {
  return roomModel ?? bestDefault(models);
}

export function cloudNodeModel(models: readonly string[]): string {
  // An installed Ollama entry that is NOT run here — the record's own split,
  // so the `<size>-cloud` spelling counts as a cloud pick too instead of
  // falling through to `bestDefault` (which can be local).
  return models.find((model) => !runsOnThisMac(model)) ?? bestDefault(models);
}

export const SPECIAL_NODE_MODEL_CHOICES: Readonly<Record<string, (models: readonly string[]) => string>> = {
  local: bestLocalDefault,
  cloud: cloudNodeModel,
};

export function nodeModelName(choice: string, roomModel: string | null, models: readonly string[]): string {
  const trimmed = choice.trim();
  if (trimmed === "" || trimmed === "auto") {
    return automaticNodeModel(roomModel, models);
  }
  const resolveSpecial = SPECIAL_NODE_MODEL_CHOICES[trimmed];
  return resolveSpecial === undefined ? trimmed : resolveSpecial(models);
}

export function resolveNodeModel(
  choice: string,
  roomModel: string | null,
  models: readonly string[]
): { readonly model: string; readonly lane: Lane } {
  const name = nodeModelName(choice, roomModel, models);
  const lane: Lane = runsOnThisMac(name) ? "local_llm" : "cloud";
  return { model: name, lane };
}

export type ModelWorkflowNode = { id: string; label: string } & Extract<NodeKind, { model: string }>;

export const MODEL_NODE_KINDS: ReadonlySet<ModelWorkflowNode["kind"]> = new Set([
  "generate",
  "extract",
  "route",
  "vote",
  "for_each_file",
  "refine",
  "plan_and_map",
]);

export const AUTO_MODEL_NODE_KINDS: ReadonlySet<"summarize_file" | "file_pass" | "agent_run"> = new Set([
  "summarize_file",
  "file_pass",
  "agent_run",
]);

export function hasNodeModel(node: WorkflowNode): node is ModelWorkflowNode {
  return MODEL_NODE_KINDS.has(node.kind as ModelWorkflowNode["kind"]);
}

/** The per-kind model/lane match `compile_workflow` inlines — factored out for
 * readability; not itself a named Rust function. */
export function resolveModelForNode(
  node: WorkflowNode,
  roomModel: string | null,
  models: readonly string[]
): { readonly model: string; readonly lane: Lane } {
  if (hasNodeModel(node)) {
    return resolveNodeModel(node.model, roomModel, models);
  }
  if (AUTO_MODEL_NODE_KINDS.has(node.kind as "summarize_file" | "file_pass" | "agent_run")) {
    return resolveNodeModel("auto", roomModel, models);
  }
  // Deterministic, no model call — the CPU lane (fans out to 4).
  return { model: "", lane: "cpu" };
}

/** One compiled step's `params` — Rust's `json!({"node":…, "model":…,
 * "incoming":…})`. `model` is JSON `null` (not `""`) when the node makes no
 * model call, and `incoming[].branch` is `null` for an unlabelled edge. */
export interface WorkflowStepParams {
  readonly node: WorkflowNode;
  readonly model: string | null;
  readonly incoming: ReadonlyArray<{ readonly parent: number; readonly branch: string | null }>;
}

/** Rust's `Result<Vec<Step>, Vec<String>>` as a value. */
export type CompileResult =
  | { readonly ok: true; readonly steps: Step[] }
  | { readonly ok: false; readonly errors: readonly string[] };

export type WorkflowIncoming = { parent: number; branch: string | null };

export function normalizeRouteLabels(node: WorkflowNode): WorkflowNode {
  if (node.kind !== "route") return node;
  return {
    ...node,
    labels: node.labels.map((label) => label.trim()).filter((label) => label !== ""),
  };
}

export function incomingWorkflowSteps(
  nodeId: string,
  edges: readonly WorkflowEdge[],
  stepOf: ReadonlyMap<string, number>,
): WorkflowIncoming[] {
  const incoming: WorkflowIncoming[] = [];
  for (const edge of edges) {
    if (edge.to !== nodeId) continue;
    const parent = stepOf.get(edge.from);
    if (parent !== undefined) incoming.push({ parent, branch: edge.branch });
  }
  return incoming;
}

export function compiledWorkflowStep(
  nodeId: string,
  index: number,
  nodeOf: ReadonlyMap<string, WorkflowNode>,
  stepOf: ReadonlyMap<string, number>,
  edges: readonly WorkflowEdge[],
  roomModel: string | null,
  models: readonly string[],
): Step {
  const original = nodeOf.get(nodeId);
  /* c8 ignore next 3 -- topoOrder only ever names ids that came from def.nodes */
  if (original === undefined) {
    throw new Error(`internal: topo order named unknown node '${nodeId}'`);
  }
  const node = normalizeRouteLabels(original);
  const incoming = incomingWorkflowSteps(nodeId, edges, stepOf);
  const dependsOn = incoming.map((edge) => edge.parent);
  const { model, lane } = resolveModelForNode(node, roomModel, models);
  const params: WorkflowStepParams = { node, model: model === "" ? null : model, incoming };
  return { id: index, lane, kind: "workflow_node", params, dependsOn };
}

/**
 * Compile a validated def into a dense, dependency-ordered `Step` plan. Each
 * step's params carry the node, its resolved model, and its incoming edges (so
 * the executor is self-contained per step — the immutable-snapshot doctrine).
 * Ported from `compile_workflow`.
 */
export function compileWorkflow(
  def: WorkflowDef,
  roomModel: string | null,
  models: readonly string[]
): CompileResult {
  // The RUN-time gate: a definition already on disk must still start. Every
  // save path validates strictly first (`validateWithBinding`), so an
  // authoring mistake is still caught where it can be fixed.
  const runnable = validateRunnable(def);
  if (!runnable.ok) {
    return runnable;
  }
  const topo = topoOrder(def);
  const order = (topo as { readonly ok: true; readonly order: string[] }).order;
  // node id -> step index (dense, topo order), and node id -> the node. Both
  // are keyed by a room-controlled node id, so both are Maps, never `{}`.
  const stepOf = new Map<string, number>(order.map((id, i) => [id, i]));
  const nodeOf = new Map<string, WorkflowNode>(def.nodes.map((n) => [n.id, n]));

  const steps = order.map((nodeId, index) => compiledWorkflowStep(
    nodeId,
    index,
    nodeOf,
    stepOf,
    def.edges,
    roomModel,
    models,
  ));

  return { ok: true, steps };
}

/** The resolved default model for a def (for display/snapshot). Ported from
 * `default_resolved_model`. */
export function defaultResolvedModel(roomModel: string | null, models: readonly string[]): string {
  return resolveNodeModel("auto", roomModel, models).model;
}
