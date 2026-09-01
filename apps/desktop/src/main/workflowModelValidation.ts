import type { Lane, Step } from "./jobs.js";
import { bestDefault } from "./turnContext.js";
import { bestLocalDefault } from "./ollamaModels.js";
import { runsOnThisMac } from "./capabilities.js";
import { scriptLangOf } from "./scriptRun.js";
import { extensionOf } from "./editMatchExtraction.js";
import { FileSelector, NodeKind, WorkflowNode, WorkflowEdge, WorkflowDef, WorkflowBinding } from "./workflowModelCore.js";
import { topoOrder } from "./workflowModelTopology.js";

// ============================================================================
// validation constants (workflow.rs:312-384). Order matters: several appear
// verbatim inside a `.join(", ")` in user-visible error text.
// ============================================================================

/** Ported from `NODE_KINDS`. */
export const NODE_KINDS: readonly string[] = [
  "generate",
  "summarize_file",
  "file_pass",
  "agent_run",
  "save_file",
  "condition",
  "script_run",
  "transform",
  "merge",
  "http_fetch",
  "extract",
  "route",
  "vote",
  "for_each_file",
  "refine",
  "plan_and_map",
];

/** Ported from `TRANSFORM_OPS`. */
export const TRANSFORM_OPS: readonly string[] = [
  "append",
  "prepend",
  "replace",
  "upper",
  "lower",
  "trim",
  "truncate",
  "strip_html",
];

/** Ported from `MERGE_MODES`. */
export const MERGE_MODES: readonly string[] = ["concat", "dedupe_lines", "numbered"];
/** Ported from `SCRIPT_MODES`. */
export const SCRIPT_MODES: readonly string[] = ["import", "transform"];
/** Ported from `VOTE_MODES`. */
export const VOTE_MODES: readonly string[] = ["concat", "majority"];
/** Ported from `FILE_SELECTORS`. */
export const FILE_SELECTORS: readonly string[] = [
  "newest",
  "all",
  "name_like",
  "missing_summary",
  "since_last_run",
  "run_input",
];
/** Ported from `CONDITION_OPS`. */
export const CONDITION_OPS: readonly string[] = [
  "contains",
  "not_contains",
  "is_empty",
  "not_empty",
  "new_files_since_last_run",
];

/** True when a node reads the run's input file (requires a file binding).
 * Ported from `selector_is_run_input`. */
export function selectorIsRunInput(sel: FileSelector): boolean {
  return sel.type === "run_input";
}

/** Ported from `node_uses_run_input`. */
export function nodeUsesRunInput(node: WorkflowNode): boolean {
  switch (node.kind) {
    case "summarize_file":
    case "file_pass":
    case "for_each_file":
      return selectorIsRunInput(node.select);
    default:
      return false;
  }
}

/** True if any node in the def reads the run's input file. Ported from
 * `def_uses_run_input`. */
export function defUsesRunInput(def: WorkflowDef): boolean {
  return def.nodes.some(nodeUsesRunInput);
}

/** Upper bounds on a definition. The assistant writes workflows itself, so a
 * runaway one would save and queue with no warning at all; these are far above
 * anything a real workflow needs and exist only to make "runaway" visible. */
export const MAX_NODES = 60;
/** Ported from `MAX_EDGES`. */
export const MAX_EDGES = 240;
/** Longest a single node's free text may be, in Unicode SCALAR VALUES
 * (`chars().count()`, not UTF-16 code units). Ported from `MAX_NODE_TEXT`. */
export const MAX_NODE_TEXT = 20_000;

/** The free text a node carries, for the length cap. Templates only — never a
 * name, id or op. Ported from `node_text_fields`. */
export type PromptTextNode = Extract<NodeKind, { kind: "generate" | "vote" | "route" }>;
export type InstructionTextNode = Extract<NodeKind, { kind: "file_pass" | "for_each_file" }>;

export const PROMPT_TEXT_KINDS: ReadonlySet<PromptTextNode["kind"]> = new Set([
  "generate",
  "vote",
  "route",
]);
export const INSTRUCTION_TEXT_KINDS: ReadonlySet<InstructionTextNode["kind"]> = new Set([
  "file_pass",
  "for_each_file",
]);

export function isPromptTextNode(kind: NodeKind): kind is PromptTextNode {
  return PROMPT_TEXT_KINDS.has(kind.kind as PromptTextNode["kind"]);
}

export function isInstructionTextNode(kind: NodeKind): kind is InstructionTextNode {
  return INSTRUCTION_TEXT_KINDS.has(kind.kind as InstructionTextNode["kind"]);
}

export function nodeTextFields(kind: NodeKind): string[] {
  if (isPromptTextNode(kind)) return [kind.prompt];
  if (kind.kind === "agent_run") return [kind.question];
  if (kind.kind === "refine") return [kind.prompt, kind.rubric];
  if (kind.kind === "plan_and_map") return [kind.objective];
  if (isInstructionTextNode(kind)) return [kind.instruction];
  return [];
}

/** The node's `kind` tag string. Already the discriminant field here, where
 * Rust's `node_kind_tag` needs a real `match` (an enum variant's NAME is not a
 * runtime string) — kept as a function so the defensive unknown-kind check in
 * {@link validateDefinition} reads the same as the Rust call site. */
export function nodeKindTag(kind: NodeKind): string {
  return kind.kind;
}

/** `usize::MAX` on every Mac this ships to (`usize` is 64-bit on aarch64 and
 * x86_64 darwin alike). */
export const USIZE_MAX = 18_446_744_073_709_551_615n;

/**
 * Does the trimmed text parse as a Rust `usize`, exactly as
 * `value.trim().parse::<usize>()` in `validate_inner`'s truncate check?
 *
 * Two things a naive `/^\d+$/` gets wrong in OPPOSITE directions, both fixed
 * here: Rust's `from_str_radix` accepts a leading `+` (`"+120"` really is
 * `Ok(120)`), and it REFUSES anything past `usize::MAX` with
 * `Err(PosOverflow)`. Only ASCII digits count either way.
 */
export function parsesAsUsize(text: string): boolean {
  const s = text.trim();
  if (!/^\+?[0-9]+$/.test(s)) {
    return false;
  }
  return BigInt(s.startsWith("+") ? s.slice(1) : s) <= USIZE_MAX;
}

// ============================================================================
// Rigor / validate_definition / validate_runnable / validate_inner /
// validate_with_binding (workflow.rs:402-845)
// ============================================================================

/**
 * How hard to check a definition. Ported from `Rigor`.
 *
 * `"saving"` — everything: the gate on save/update and the canvas's live check.
 * A new or edited definition must satisfy every rule we know.
 *
 * `"running"` — only the rules that have ALWAYS been enforced: the gate on
 * starting a run. Rules learned after a workflow was written are advice for its
 * author, not grounds to stop it dead: nothing migrates old definitions, and a
 * SCHEDULED start that fails is invisible (the scheduler just advances
 * `next_run_at` — no run row, no error, no notification), so a newly-strict
 * rule at run time reads as an automation that quietly stopped months after the
 * user set it up. Each grandfathered rule below says what the old behaviour
 * was; all of them still block a SAVE, which is where the user is looking.
 */
export type Rigor = "saving" | "running";

/** Rust's `Result<(), Vec<String>>` as a value — a list of model-fixable
 * sentences, not one message. */
export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Validate a definition, returning model-fixable sentences (`ok` = valid).
 * Checks unknown kinds, per-kind params, duplicate/dangling ids, edge refs,
 * branch legality, size limits, and a Kahn topo sort that NAMES a cycle. The
 * SAVE-time gate — see {@link validateRunnable} for the run-time one.
 */
export function validateDefinition(def: WorkflowDef): ValidationResult {
  return validateInner(def, "saving");
}

/**
 * The RUN-time gate: everything structural (unknown kinds and selectors,
 * dangling edges, illegal branch labels, cycles), minus the rules a definition
 * written by an earlier version could not have known about. See {@link Rigor}.
 */
export function validateRunnable(def: WorkflowDef): ValidationResult {
  return validateInner(def, "running");
}

export interface NodeValidationContext {
  readonly saving: boolean;
  readonly errors: string[];
  readonly ids: Set<string>;
  readonly hasIncoming: ReadonlySet<string>;
  readonly conditionIds: Set<string>;
  readonly routeLabels: Map<string, string[]>;
}

export type NodeVariant<K extends WorkflowNode["kind"]> = Extract<WorkflowNode, { kind: K }>;
export type NodeValidator = (node: WorkflowNode, context: NodeValidationContext) => void;

export function definitionSizeError(def: WorkflowDef): string | null {
  if (def.nodes.length > MAX_NODES) {
    return `The workflow has ${def.nodes.length} steps — the limit is ${MAX_NODES}. Split it into smaller workflows.`;
  }
  if (def.edges.length > MAX_EDGES) {
    return `The workflow has ${def.edges.length} connections — the limit is ${MAX_EDGES}.`;
  }
  return null;
}

export function definitionShapeError(def: WorkflowDef, saving: boolean): string | null {
  if (def.nodes.length === 0) return "The workflow has no nodes — add at least one step.";
  return saving ? definitionSizeError(def) : null;
}

export function recordNodeId(node: WorkflowNode, ids: Set<string>, errors: string[]): void {
  if (node.id.trim() === "") {
    errors.push("A node has an empty id — every node needs a unique id.");
  } else if (ids.has(node.id)) {
    errors.push(`Duplicate node id '${node.id}' — ids must be unique.`);
  } else {
    ids.add(node.id);
  }
}

export function nodeTextIsTooLong(node: WorkflowNode): boolean {
  for (const text of nodeTextFields(node)) {
    if ([...text].length > MAX_NODE_TEXT) return true;
  }
  return false;
}

export function collectNodeIds(nodes: readonly WorkflowNode[], saving: boolean, errors: string[]): Set<string> {
  const ids = new Set<string>();
  for (const node of nodes) {
    recordNodeId(node, ids, errors);
    if (saving && nodeTextIsTooLong(node)) {
      errors.push(`Node '${node.id}' has instructions longer than ${MAX_NODE_TEXT} characters — shorten them.`);
    }
  }
  return ids;
}

export function incomingNodeIds(edges: readonly WorkflowEdge[], ids: ReadonlySet<string>): Set<string> {
  const incoming = new Set<string>();
  for (const edge of edges) {
    if (ids.has(edge.from) && ids.has(edge.to)) incoming.add(edge.to);
  }
  return incoming;
}

export function nodeValidationContext(def: WorkflowDef, saving: boolean, errors: string[]): NodeValidationContext {
  const ids = collectNodeIds(def.nodes, saving, errors);
  return {
    saving,
    errors,
    ids,
    hasIncoming: incomingNodeIds(def.edges, ids),
    conditionIds: new Set<string>(),
    routeLabels: new Map<string, string[]>(),
  };
}

export function validateFileSelector(node: { id: string; select: FileSelector }, errors: string[]): void {
  if (!FILE_SELECTORS.includes(node.select.type)) {
    errors.push(`Node '${node.id}' has an unknown file selector '${node.select.type}' — use one of: ${FILE_SELECTORS.join(", ")}.`);
  }
  if (node.select.type === "name_like" && (node.select.pattern ?? "").trim() === "") {
    errors.push(`Node '${node.id}' selects by name but has no pattern.`);
  }
}

export function validateGenerateNode(node: NodeVariant<"generate">, context: NodeValidationContext): void {
  if (node.prompt.trim() === "") context.errors.push(`Node '${node.id}' (generate) has an empty prompt.`);
}

export function validateSummarizeFileNode(node: NodeVariant<"summarize_file">, context: NodeValidationContext): void {
  validateFileSelector(node, context.errors);
}

export function validateFilePassNode(node: NodeVariant<"file_pass">, context: NodeValidationContext): void {
  validateFileSelector(node, context.errors);
  if (context.saving && node.select.type === "all") {
    context.errors.push(`Node '${node.id}' (file_pass) reads ONE file, so "all files" would read only the newest — use a for_each_file step to cover every file, or select newest/name_like/run_input.`);
  }
}

export function validateAgentRunNode(node: NodeVariant<"agent_run">, context: NodeValidationContext): void {
  if (node.question.trim() === "") context.errors.push(`Node '${node.id}' (agent_run) has an empty question.`);
}

export function validateSaveFileNode(node: NodeVariant<"save_file">, context: NodeValidationContext): void {
  if (node.name_template.trim() === "") context.errors.push(`Node '${node.id}' (save_file) has an empty name.`);
  if (!["html", "md"].includes(node.format)) context.errors.push(`Node '${node.id}' has an unknown format '${node.format}' — use html or md.`);
  if (!["create", "overwrite", "append"].includes(node.mode)) context.errors.push(`Node '${node.id}' has an unknown save mode '${node.mode}' — use create, overwrite or append.`);
}

export function isTextCondition(op: string): boolean {
  return op === "contains" || op === "not_contains";
}

export function readsIncomingText(op: string): boolean {
  return isTextCondition(op) || op === "is_empty" || op === "not_empty";
}

export function conditionNeedleError(node: NodeVariant<"condition">, saving: boolean): string | null {
  if (!saving || !isTextCondition(node.op)) return null;
  return (node.value ?? "").trim() === ""
    ? `Node '${node.id}' checks whether the text contains something but no text was given — type what to look for.`
    : null;
}

export function conditionInputError(node: NodeVariant<"condition">, context: NodeValidationContext): string | null {
  if (!context.saving || !readsIncomingText(node.op)) return null;
  return context.hasIncoming.has(node.id)
    ? null
    : `Node '${node.id}' checks the text coming into it, but nothing runs before it — connect a step to it, or use new_files_since_last_run.`;
}

export function recordValidationError(error: string | null, errors: string[]): void {
  if (error !== null) errors.push(error);
}

export function validateConditionNode(node: NodeVariant<"condition">, context: NodeValidationContext): void {
  context.conditionIds.add(node.id);
  if (!CONDITION_OPS.includes(node.op)) context.errors.push(`Node '${node.id}' has an unknown condition '${node.op}' — use one of: ${CONDITION_OPS.join(", ")}.`);
  recordValidationError(conditionNeedleError(node, context.saving), context.errors);
  recordValidationError(conditionInputError(node, context), context.errors);
}

export function scriptFileError(node: NodeVariant<"script_run">): string | null {
  if (node.file.trim() === "") return `Node '${node.id}' (script_run) has no script file.`;
  if (scriptLangOf(node.file) !== null || extensionOf(node.file) === "") return null;
  return `Node '${node.id}' points at '${node.file}' — only .py or .js scripts can run.`;
}

export function validateScriptRunNode(node: NodeVariant<"script_run">, context: NodeValidationContext): void {
  const fileError = scriptFileError(node);
  if (fileError !== null) context.errors.push(fileError);
  if (!SCRIPT_MODES.includes(node.mode)) context.errors.push(`Node '${node.id}' has an unknown script mode '${node.mode}' — use import or transform.`);
}

export function transformOperationError(node: NodeVariant<"transform">): string | null {
  return TRANSFORM_OPS.includes(node.op)
    ? null
    : `Node '${node.id}' has an unknown transform '${node.op}' — use one of: ${TRANSFORM_OPS.join(", ")}.`;
}

export function replacementFindError(node: NodeVariant<"transform">): string | null {
  return node.op === "replace" && (node.find ?? "") === ""
    ? `Node '${node.id}' (replace) needs a \`find\` string.`
    : null;
}

export function truncateValueError(node: NodeVariant<"transform">): string | null {
  return node.op === "truncate" && !parsesAsUsize(node.value ?? "")
    ? `Node '${node.id}' (truncate) needs \`value\` to be a character count.`
    : null;
}

export function validateTransformNode(node: NodeVariant<"transform">, context: NodeValidationContext): void {
  recordValidationError(transformOperationError(node), context.errors);
  recordValidationError(replacementFindError(node), context.errors);
  recordValidationError(truncateValueError(node), context.errors);
}

export function validateMergeNode(node: NodeVariant<"merge">, context: NodeValidationContext): void {
  if (!MERGE_MODES.includes(node.mode)) context.errors.push(`Node '${node.id}' has an unknown merge mode '${node.mode}' — use one of: ${MERGE_MODES.join(", ")}.`);
}

export function validateHttpFetchNode(node: NodeVariant<"http_fetch">, context: NodeValidationContext): void {
  if (node.url.trim() === "") context.errors.push(`Node '${node.id}' (http_fetch) has no URL.`);
}

export function validateExtractNode(node: NodeVariant<"extract">, context: NodeValidationContext): void {
  if (node.fields.every((field) => field.trim() === "")) context.errors.push(`Node '${node.id}' (extract) lists no fields to pull out.`);
}

export function validateRouteNode(node: NodeVariant<"route">, context: NodeValidationContext): void {
  const labels = node.labels.map((label) => label.trim()).filter((label) => label !== "");
  if (labels.length < 2) context.errors.push(`Node '${node.id}' (route) needs at least two labels to route between.`);
  context.routeLabels.set(node.id, labels);
}

export function validateVoteNode(node: NodeVariant<"vote">, context: NodeValidationContext): void {
  if (node.prompt.trim() === "") context.errors.push(`Node '${node.id}' (vote) has an empty prompt.`);
  if (!VOTE_MODES.includes(node.mode)) context.errors.push(`Node '${node.id}' has an unknown vote mode '${node.mode}' — use concat or majority.`);
}

export function validateForEachFileNode(node: NodeVariant<"for_each_file">, context: NodeValidationContext): void {
  validateFileSelector(node, context.errors);
  if (node.instruction.trim() === "") context.errors.push(`Node '${node.id}' (for_each_file) has an empty instruction.`);
}

export function validateRefineNode(node: NodeVariant<"refine">, context: NodeValidationContext): void {
  if (node.prompt.trim() === "") context.errors.push(`Node '${node.id}' (refine) has an empty prompt.`);
}

export function validatePlanAndMapNode(node: NodeVariant<"plan_and_map">, context: NodeValidationContext): void {
  if (node.objective.trim() === "") context.errors.push(`Node '${node.id}' (plan_and_map) has an empty objective.`);
}

export const NODE_VALIDATORS: { readonly [K in WorkflowNode["kind"]]: (node: NodeVariant<K>, context: NodeValidationContext) => void } = {
  generate: validateGenerateNode,
  summarize_file: validateSummarizeFileNode,
  file_pass: validateFilePassNode,
  agent_run: validateAgentRunNode,
  save_file: validateSaveFileNode,
  condition: validateConditionNode,
  script_run: validateScriptRunNode,
  transform: validateTransformNode,
  merge: validateMergeNode,
  http_fetch: validateHttpFetchNode,
  extract: validateExtractNode,
  route: validateRouteNode,
  vote: validateVoteNode,
  for_each_file: validateForEachFileNode,
  refine: validateRefineNode,
  plan_and_map: validatePlanAndMapNode,
};

export function validateNode(node: WorkflowNode, context: NodeValidationContext): void {
  const validator = NODE_VALIDATORS[node.kind] as NodeValidator | undefined;
  if (validator !== undefined) validator(node, context);
}

export function validateNodes(nodes: readonly WorkflowNode[], context: NodeValidationContext): void {
  for (const node of nodes) validateNode(node, context);
}

export function validateNodeKinds(nodes: readonly WorkflowNode[], errors: string[]): void {
  for (const node of nodes) {
    const tag = nodeKindTag(node);
    if (!NODE_KINDS.includes(tag)) errors.push(`Node '${node.id}' has an unknown kind '${tag}'.`);
  }
}

export function validateUnlabelledBranch(edge: WorkflowEdge, context: NodeValidationContext): void {
  if (!context.saving || edge.branch !== null) return;
  if (context.conditionIds.has(edge.from)) {
    context.errors.push(`Edge ${edge.from}→${edge.to} leaves a condition without saying which outcome it follows — set its branch to 'then' or 'else'.`);
  } else if (context.routeLabels.has(edge.from)) {
    context.errors.push(`Edge ${edge.from}→${edge.to} leaves a route without saying which label it follows — set its branch to one of route '${edge.from}'s labels, or every branch runs at once.`);
  }
}

export function conditionBranchError(edge: WorkflowEdge): string | null {
  if (edge.branch === "then" || edge.branch === "else") return null;
  return `Edge ${edge.from}→${edge.to} has branch '${edge.branch}' — a condition only branches 'then' or 'else'.`;
}

export function routeBranchError(edge: WorkflowEdge, routeLabels: ReadonlyMap<string, readonly string[]>): string | null {
  const labels = routeLabels.get(edge.from) ?? [];
  return labels.includes(edge.branch ?? "")
    ? null
    : `Edge ${edge.from}→${edge.to} has branch '${edge.branch}', but route '${edge.from}' has no such label.`;
}

export function validateLabelledBranch(edge: WorkflowEdge, context: NodeValidationContext): void {
  if (edge.branch === null) return;
  if (context.conditionIds.has(edge.from)) {
    recordValidationError(conditionBranchError(edge), context.errors);
  } else if (context.routeLabels.has(edge.from)) {
    recordValidationError(routeBranchError(edge, context.routeLabels), context.errors);
  } else {
    context.errors.push(`Edge ${edge.from}→${edge.to} has a branch, but '${edge.from}' is not a condition or route node.`);
  }
}

export function validateEdge(edge: WorkflowEdge, context: NodeValidationContext): void {
  if (!context.ids.has(edge.from)) context.errors.push(`An edge starts from unknown node '${edge.from}'.`);
  if (!context.ids.has(edge.to)) context.errors.push(`An edge points to unknown node '${edge.to}'.`);
  validateUnlabelledBranch(edge, context);
  validateLabelledBranch(edge, context);
}

export function validateEdges(edges: readonly WorkflowEdge[], context: NodeValidationContext): void {
  for (const edge of edges) validateEdge(edge, context);
}

export function validationResult(errors: readonly string[]): ValidationResult {
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function validateInner(def: WorkflowDef, rigor: Rigor): ValidationResult {
  const saving = rigor === "saving";
  const shapeError = definitionShapeError(def, saving);
  if (shapeError !== null) return { ok: false, errors: [shapeError] };
  const errors: string[] = [];
  const context = nodeValidationContext(def, saving, errors);
  validateNodes(def.nodes, context);
  validateNodeKinds(def.nodes, errors);
  validateEdges(def.edges, context);
  const topo = topoOrder(def);
  if (!topo.ok) errors.push(`The workflow has a cycle through: ${topo.cycle.join(" → ")} — remove an edge so it can run in order.`);
  return validationResult(errors);
}

/** Cross-check the def against its binding (a run_input node needs file
 * scope). Ported from `validate_with_binding`. */
export function validateWithBinding(def: WorkflowDef, binding: WorkflowBinding): ValidationResult {
  const base = validateDefinition(def);
  if (!base.ok) return base;
  const bindingError = runInputBindingError(def, binding);
  if (bindingError !== null) return { ok: false, errors: [bindingError] };
  return { ok: true };
}

export function firstRunInputNodeId(nodes: readonly WorkflowNode[]): string | null {
  for (const node of nodes) {
    if (nodeUsesRunInput(node)) return node.id;
  }
  return null;
}

export function runInputBindingError(def: WorkflowDef, binding: WorkflowBinding): string | null {
  if (binding.scope === "file") return null;
  const nodeId = firstRunInputNodeId(def.nodes);
  return nodeId === null
    ? null
    : `Node '${nodeId}' reads the run's input file — set the workflow's binding to file-scoped.`;
}
