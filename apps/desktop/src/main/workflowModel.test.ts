/**
 * Vitest port of `src-tauri/src/commands/jobs/workflow.rs`'s `#[cfg(test)] mod
 * tests` (workflow.rs:4427-5855), narrowed to the cases that exercise ONLY
 * lines 1-1030 — the data model, its validation, and the compiler. See
 * `workflowModel.ts`'s module doc for what is and is not in scope.
 *
 * PORTED RUST TESTS, by name:
 *   - route_labels_are_cleaned_where_the_edges_were_validated (COMPILE HALF
 *     ONLY — the second half asserts `edge_is_live`, past line 1030)
 *   - resolve_node_model_honors_external_engines_on_the_cloud_lane
 *   - validate_accepts_a_linear_def_and_the_templates (LINEAR-DEF HALF ONLY —
 *     `builtin_templates()` lives at workflow.rs:4263, past line 1030)
 *   - validate_names_a_cycle
 *   - validate_flags_dangling_edges_and_bad_branches
 *   - validate_flags_unknown_selector_and_op
 *   - all_is_a_valid_selector
 *   - run_input_requires_a_file_binding
 *   - compile_produces_dense_topo_ids_and_lanes
 *   - compile_bounces_an_invalid_def
 *   - validate_route_needs_labels_and_legal_branches
 *   - an_unlabelled_exit_from_a_branch_step_is_rejected
 *   - a_text_condition_needs_both_a_needle_and_something_to_read
 *   - a_full_file_pass_may_not_be_pointed_at_all_files
 *   - a_runaway_definition_is_refused
 *   - a_workflow_saved_before_these_rules_existed_still_runs
 *   - validate_flags_bad_transform_and_script_mode
 *   - compile_assigns_cpu_lane_to_deterministic_nodes
 *
 * NOT PORTED — each needs a dependency past line 1030: `edge_liveness_rule`,
 * `condition_ops_evaluate`, `transform_ops_are_deterministic`,
 * `merge_modes_combine_branches`, `compose_prompt_teaches_the_full_palette`,
 * `the_node_reference_agrees_with_the_validator`,
 * `a_name_contains_filter_is_not_a_wildcard`,
 * `a_saved_file_name_cannot_be_a_pasted_model_reply`, the HTML-append pair,
 * the timed-out-run / script-park pair, and the whole resume-characterization
 * block (which drives a real Tauri app + room).
 *
 * PLUS coverage the Rust suite never isolated, because its test module is one
 * block over the whole 5855-line file rather than colocated per function:
 *   - the hand-written parse layer standing in for `#[derive(Deserialize)]`:
 *     every `default_*` fn, every required field, every present-but-wrong-type
 *     rejection
 *   - the two-level FileSelector default (absent key vs present-but-empty)
 *   - `topoOrder`'s tie-break, DIRECTLY and in both its halves (no Rust test
 *     calls `topo_order` directly — every one reaches it only through the
 *     cycle check or `compile_workflow`)
 *   - the `truncate` value's Rust `parse::<usize>()` semantics, in both the
 *     directions a `/^\d+$/` gets wrong
 *   - a `"__proto__"` node id end to end (this codebase's house rule: that bug
 *     class has been found three times already)
 *
 * PLUS an ADVERSARIAL PASS at the end of this file, written against the port
 * rather than for it: cycles that are self-loops / longer rings / rings with a
 * stranded tail / rings whose node id is DUPLICATED (the case that found a real
 * bug — see `topoOrder`'s comment), route labels that only match once trimmed,
 * defs that pass `Rigor::Running` while failing `Rigor::Saving` and vice versa,
 * every `node_text_fields` entry exactly AT and one past `MAX_NODE_TEXT` plus
 * the fields that must stay UNCAPPED, dangling edges in both directions, ids
 * matched raw rather than trimmed, illegal branch labels in every combination
 * of source kind, and `resolve_node_model`'s four arms against model lists that
 * do and do not contain a local/cloud pick. The `topo_order` and
 * `parse::<usize>()` expectations were pinned by COMPILING the Rust, not by
 * reading it.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { resetBaseUrlOverrideForTests } from "./engineRouting.js";
import type { Step } from "./jobs.js";
import {
  CONDITION_OPS,
  DEFAULT_FILE_SELECTOR_WHEN_KEY_ABSENT,
  DEFAULT_VERSION,
  DEFAULT_WF_ARTIFACT,
  FILE_SELECTORS,
  MAX_EDGES,
  MAX_NODES,
  MAX_NODE_TEXT,
  MERGE_MODES,
  NODE_KINDS,
  SCRIPT_MODES,
  SEL_NEWEST,
  TRANSFORM_OPS,
  VOTE_MODES,
  compileWorkflow,
  defUsesRunInput,
  defaultResolvedModel,
  nodeKindTag,
  nodeUsesRunInput,
  parseWfArtifact,
  parseWorkflowBinding,
  parseWorkflowDef,
  parseWorkflowEdge,
  parseWorkflowNode,
  resolveNodeModel,
  selectorIsRunInput,
  topoOrder,
  validateDefinition,
  validateRunnable,
  validateWithBinding,
  type FileSelector,
  type WorkflowDef,
  type WorkflowNode,
  type WorkflowStepParams,
} from "./workflowModel.js";

/** Rust's test-only `fn parse(v) -> WorkflowDef { from_value(v).unwrap() }` —
 * here simply the production reader, aliased for 1:1 readability against the
 * Rust test bodies. */
const parse = parseWorkflowDef;

/** `workflow.rs::tests::linear_def`. */
function linearDef(): WorkflowDef {
  return parse({
    version: 1,
    nodes: [
      { id: "a", kind: "generate", prompt: "hi {{input}}", model: "auto" },
      { id: "b", kind: "save_file", name_template: "out", format: "html", mode: "create" },
    ],
    edges: [{ from: "a", to: "b" }],
  });
}

/** `workflow.rs::tests::branching_def` — seed → gate(condition) →then hot,
 * →else cold → cold2; hot + cold2 → join(merge) → out(save_file). */
function branchingDef(): WorkflowDef {
  return parse({
    nodes: [
      { id: "seed", kind: "transform", op: "append", value: "alpha" },
      { id: "gate", kind: "condition", op: "contains", value: "alpha" },
      { id: "hot", kind: "transform", op: "append", value: " HOT" },
      { id: "cold", kind: "transform", op: "append", value: " COLD" },
      { id: "cold2", kind: "transform", op: "append", value: " COLD2" },
      { id: "join", kind: "merge", mode: "concat", separator: "||" },
      { id: "out", kind: "save_file", name_template: "wf-out", format: "md", mode: "create" },
    ],
    edges: [
      { from: "seed", to: "gate" },
      { from: "gate", to: "hot", branch: "then" },
      { from: "gate", to: "cold", branch: "else" },
      { from: "cold", to: "cold2" },
      { from: "hot", to: "join" },
      { from: "cold2", to: "join" },
      { from: "join", to: "out" },
    ],
  });
}

function paramsOf(step: Step): WorkflowStepParams {
  return step.params as WorkflowStepParams;
}

function stepFor(steps: Step[], nodeId: string): Step {
  const found = steps.find((s) => paramsOf(s).node.id === nodeId);
  if (found === undefined) throw new Error(`no compiled step for node '${nodeId}'`);
  return found;
}

// `runsOnThisMac` reads the resolved Ollama base URL, which a runtime override
// can move off this Mac; clear it so every lane assertion below is about the
// model record, not about leftover state.
beforeEach(() => {
  resetBaseUrlOverrideForTests();
});

// ============================================================================
// compile_workflow
// ============================================================================

describe("compileWorkflow", () => {
  it("route_labels_are_cleaned_where_the_edges_were_validated (compile half)", () => {
    // The validator trims a route's labels and checks the edges against the
    // trimmed list; the runtime sent the RAW list, so a padded label routed to
    // a branch string no edge matched and every handler was skipped.
    const def = parse({
      nodes: [
        { id: "r", kind: "route", prompt: "which?", labels: [" urgent ", "normal", "  "] },
        { id: "hot", kind: "transform", op: "append", value: "!" },
      ],
      edges: [{ from: "r", to: "hot", branch: "urgent" }],
    });
    const result = compileWorkflow(def, null, []);
    expect(result.ok, "this def must compile").toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const node = paramsOf(stepFor(result.steps, "r")).node;
    if (node.kind !== "route") throw new Error("fixture");
    expect(node.labels).toEqual(["urgent", "normal"]);
    // The caller's own definition is left alone (Rust clones the node first).
    const source = def.nodes[0]!;
    if (source.kind !== "route") throw new Error("fixture");
    expect(source.labels).toEqual([" urgent ", "normal", "  "]);
  });

  it("compile_produces_dense_topo_ids_and_lanes", () => {
    // condition(cpu) → generate(local) → save_file(cpu), declared out of order.
    const def = parse({
      nodes: [
        { id: "save", kind: "save_file", name_template: "o" },
        { id: "gen", kind: "generate", prompt: "p", model: "local" },
        // A ROOM-reading condition, so it is legitimately a first step.
        { id: "cond", kind: "condition", op: "new_files_since_last_run" },
      ],
      edges: [
        { from: "cond", to: "gen", branch: "then" },
        { from: "gen", to: "save" },
      ],
    });
    const result = compileWorkflow(def, null, ["qwen3.5:4b"]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const steps = result.steps;
    expect(steps).toHaveLength(3);
    // Dense ids 0..n, every dep lower than its step (a valid resume ordering).
    steps.forEach((s, i) => {
      expect(s.id).toBe(i);
      for (const d of s.dependsOn) {
        expect(d, `step ${s.id} depends on later ${d}`).toBeLessThan(s.id);
      }
    });
    const cond = stepFor(steps, "cond");
    expect(cond.dependsOn).toEqual([]);
    expect(cond.lane).toBe("cpu");
    const gen = stepFor(steps, "gen");
    expect(gen.lane).toBe("local_llm");
    // The generate's incoming edge carries the 'then' branch of the condition.
    const inc = paramsOf(gen).incoming;
    expect(inc).toHaveLength(1);
    expect(inc[0]?.branch).toBe("then");
    expect(inc[0]?.parent).toBe(cond.id);
  });

  it("compile_bounces_an_invalid_def", () => {
    const def = parse({ nodes: [{ id: "a", kind: "generate", prompt: "" }], edges: [] });
    const result = compileWorkflow(def, null, []);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.some((e) => e.includes("empty prompt"))).toBe(true);
  });

  it("compile_assigns_cpu_lane_to_deterministic_nodes", () => {
    const def = parse({
      nodes: [
        { id: "m", kind: "merge", mode: "concat" },
        { id: "e", kind: "extract", fields: ["name"] },
      ],
      edges: [{ from: "m", to: "e" }],
    });
    const result = compileWorkflow(def, null, ["qwen3.5:4b"]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(stepFor(result.steps, "m").lane, "merge is deterministic → CPU lane").toBe("cpu");
    expect(stepFor(result.steps, "e").lane, "extract calls the model").toBe("local_llm");
  });

  it("a deterministic node's `model` param is JSON null, never an empty string", () => {
    const def = parse({ nodes: [{ id: "t", kind: "transform", op: "trim" }], edges: [] });
    const result = compileWorkflow(def, null, ["qwen3.5:4b"]);
    if (!result.ok) throw new Error("unreachable");
    expect(paramsOf(result.steps[0]!).model).toBeNull();
  });

  it("compiles the whole branching def: dense ids, both branch labels carried through", () => {
    const result = compileWorkflow(branchingDef(), null, []);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.steps).toHaveLength(7);
    result.steps.forEach((s, i) => expect(s.id).toBe(i));
    expect(paramsOf(stepFor(result.steps, "hot")).incoming[0]?.branch).toBe("then");
    expect(paramsOf(stepFor(result.steps, "cold")).incoming[0]?.branch).toBe("else");
    // An unlabelled edge carries branch null, not "" or undefined.
    expect(paramsOf(stepFor(result.steps, "gate")).incoming[0]?.branch).toBeNull();
    // The merge fans in from both live branches, in edge-declaration order.
    const join = stepFor(result.steps, "join");
    expect(join.dependsOn).toEqual(
      [stepFor(result.steps, "hot").id, stepFor(result.steps, "cold2").id]
    );
  });
});

// ============================================================================
// resolve_node_model / default_resolved_model
// ============================================================================

describe("resolveNodeModel", () => {
  it("resolve_node_model_honors_external_engines_on_the_cloud_lane", () => {
    const models = ["qwen3.5:4b", "minimax-m3:cloud"];
    // Engine parity: "auto" keeps the room's external CLI choice.
    let r = resolveNodeModel("auto", "claude-cli::opus", models);
    expect(r.model).toBe("claude-cli::opus");
    expect(r.lane).toBe("cloud");
    // A literal external engine is honored too.
    r = resolveNodeModel("codex-cli", null, models);
    expect(r.model).toBe("codex-cli");
    expect(r.lane).toBe("cloud");
    // "local" stays a hard local pick whatever the room engine is.
    r = resolveNodeModel("local", "codex-cli", models);
    expect(r.model).toBe("qwen3.5:4b");
    expect(r.lane).toBe("local_llm");
    // `:cloud` proxies keep riding the cloud lane.
    r = resolveNodeModel("cloud", null, models);
    expect(r.lane).toBe("cloud");
    expect(r.model).toBe("minimax-m3:cloud");
  });

  it("'' and 'auto' are the same choice, and both trim first", () => {
    expect(resolveNodeModel("", "room-pick", []).model).toBe("room-pick");
    expect(resolveNodeModel("  auto  ", "room-pick", []).model).toBe("room-pick");
    // A literal is trimmed too — that is what Rust's `match choice.trim()`
    // binds to its `literal` arm.
    expect(resolveNodeModel("  llama9:7b  ", null, []).model).toBe("llama9:7b");
  });

  it("auto with no room model and no installed models falls back to the tuned default, local lane", () => {
    const r = resolveNodeModel("auto", null, []);
    expect(r.model).toBe("qwen3.5:4b");
    expect(r.lane).toBe("local_llm");
  });

  it("'cloud' with nothing remote installed falls back to bestDefault", () => {
    const r = resolveNodeModel("cloud", null, ["qwen3.5:4b"]);
    expect(r.model).toBe("qwen3.5:4b");
    expect(r.lane).toBe("local_llm");
  });
});

describe("defaultResolvedModel", () => {
  it("is resolveNodeModel('auto', …).model", () => {
    expect(defaultResolvedModel(null, [])).toBe("qwen3.5:4b");
    expect(defaultResolvedModel("claude-cli::opus", [])).toBe("claude-cli::opus");
    expect(defaultResolvedModel(null, ["qwen3.5:4b"])).toBe("qwen3.5:4b");
  });
});

// ============================================================================
// validate_definition
// ============================================================================

describe("validateDefinition", () => {
  it("validate_accepts_a_linear_def_and_the_templates (linear-def half)", () => {
    expect(validateDefinition(linearDef())).toEqual({ ok: true });
    expect(validateDefinition(branchingDef())).toEqual({ ok: true });
  });

  it("refuses a def with no nodes at all", () => {
    const result = validateDefinition({ version: 1, nodes: [], edges: [] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors).toEqual(["The workflow has no nodes — add at least one step."]);
  });

  it("validate_names_a_cycle", () => {
    const def = parse({
      nodes: [
        { id: "a", kind: "generate", prompt: "x" },
        { id: "b", kind: "generate", prompt: "y" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    });
    const result = validateDefinition(def);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(
      result.errors.some((e) => e.includes("cycle") && e.includes("a") && e.includes("b")),
      `cycle must be named: ${JSON.stringify(result.errors)}`
    ).toBe(true);
  });

  it("validate_flags_dangling_edges_and_bad_branches", () => {
    const def = parse({
      nodes: [
        { id: "a", kind: "generate", prompt: "x" },
        { id: "b", kind: "save_file", name_template: "o" },
      ],
      // edge to unknown node + a branch off a non-condition
      edges: [
        { from: "a", to: "ghost" },
        { from: "a", to: "b", branch: "then" },
      ],
    });
    const result = validateDefinition(def);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.some((e) => e.includes("ghost"))).toBe(true);
    expect(result.errors.some((e) => e.includes("not a condition"))).toBe(true);
  });

  it("validate_flags_unknown_selector_and_op", () => {
    const def = parse({
      nodes: [
        { id: "s", kind: "summarize_file", select: { type: "bogus" } },
        { id: "c", kind: "condition", op: "sometimes" },
      ],
      edges: [],
    });
    const result = validateDefinition(def);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.some((e) => e.includes("file selector"))).toBe(true);
    expect(result.errors.some((e) => e.includes("condition"))).toBe(true);
  });

  it("all_is_a_valid_selector", () => {
    const def = parse({ nodes: [{ id: "s", kind: "summarize_file", select: { type: "all" } }], edges: [] });
    expect(validateDefinition(def)).toEqual({ ok: true });
  });

  it("validate_route_needs_labels_and_legal_branches", () => {
    // Fewer than two labels is rejected — and blank labels don't count.
    const bad = parse({ nodes: [{ id: "r", kind: "route", labels: ["only"] }], edges: [] });
    const badResult = validateDefinition(bad);
    expect(badResult.ok).toBe(false);
    if (badResult.ok) throw new Error("unreachable");
    expect(badResult.errors.some((e) => e.includes("two labels"))).toBe(true);

    const padded = parse({ nodes: [{ id: "r", kind: "route", labels: ["real", "   "] }], edges: [] });
    const paddedResult = validateDefinition(padded);
    expect(paddedResult.ok, "a blank label is not a second label").toBe(false);

    // A branch label the route doesn't declare is rejected.
    const bad2 = parse({
      nodes: [
        { id: "r", kind: "route", labels: ["a", "b"] },
        { id: "g", kind: "generate", prompt: "x" },
      ],
      edges: [{ from: "r", to: "g", branch: "c" }],
    });
    const bad2Result = validateDefinition(bad2);
    expect(bad2Result.ok).toBe(false);
    if (bad2Result.ok) throw new Error("unreachable");
    expect(bad2Result.errors.some((e) => e.includes("no such label"))).toBe(true);

    // A legal route graph validates — and an edge matches the TRIMMED label.
    const ok = parse({
      nodes: [
        { id: "r", kind: "route", labels: [" a ", "b"] },
        { id: "g", kind: "generate", prompt: "x" },
        { id: "h", kind: "generate", prompt: "y" },
      ],
      edges: [
        { from: "r", to: "g", branch: "a" },
        { from: "r", to: "h", branch: "b" },
      ],
    });
    expect(validateDefinition(ok)).toEqual({ ok: true });
  });

  it("an_unlabelled_exit_from_a_branch_step_is_rejected", () => {
    const route = parse({
      nodes: [
        { id: "r", kind: "route", labels: ["a", "b"] },
        { id: "g", kind: "generate", prompt: "x" },
        { id: "h", kind: "generate", prompt: "y" },
      ],
      edges: [
        { from: "r", to: "g", branch: "a" },
        { from: "r", to: "h" },
      ],
    });
    const routeResult = validateDefinition(route);
    expect(routeResult.ok).toBe(false);
    if (routeResult.ok) throw new Error("unreachable");
    expect(routeResult.errors.some((e) => e.includes("r→h") && e.includes("which label"))).toBe(true);

    // Same rule off a condition.
    const cond = parse({
      nodes: [
        { id: "s", kind: "transform", op: "trim" },
        { id: "c", kind: "condition", op: "not_empty" },
        { id: "g", kind: "generate", prompt: "x" },
      ],
      edges: [
        { from: "s", to: "c" },
        { from: "c", to: "g" },
      ],
    });
    const condResult = validateDefinition(cond);
    expect(condResult.ok).toBe(false);
    if (condResult.ok) throw new Error("unreachable");
    expect(condResult.errors.some((e) => e.includes("c→g") && e.includes("which outcome"))).toBe(true);

    // A plain (non-branching) step's unlabelled edges are still fine.
    expect(validateDefinition(linearDef())).toEqual({ ok: true });
  });

  it("a_text_condition_needs_both_a_needle_and_something_to_read", () => {
    const emptyNeedle = parse({
      nodes: [
        { id: "s", kind: "transform", op: "trim" },
        { id: "c", kind: "condition", op: "contains", value: "  " },
      ],
      edges: [{ from: "s", to: "c" }],
    });
    const r1 = validateDefinition(emptyNeedle);
    expect(r1.ok).toBe(false);
    if (r1.ok) throw new Error("unreachable");
    expect(r1.errors.some((e) => e.includes("what to look for"))).toBe(true);

    const nothingUpstream = parse({ nodes: [{ id: "c", kind: "condition", op: "not_empty" }], edges: [] });
    const r2 = validateDefinition(nothingUpstream);
    expect(r2.ok).toBe(false);
    if (r2.ok) throw new Error("unreachable");
    expect(r2.errors.some((e) => e.includes("nothing runs before it"))).toBe(true);

    // new_files_since_last_run reads the ROOM, not the pipeline — it is
    // legitimately a first step and needs no value.
    const firstStep = parse({ nodes: [{ id: "c", kind: "condition", op: "new_files_since_last_run" }], edges: [] });
    expect(validateDefinition(firstStep)).toEqual({ ok: true });
  });

  it("a DANGLING incoming edge does not count as something upstream to read", () => {
    // The edge's `from` names no node, so `has_incoming` skips it — the
    // condition is still reported as having nothing before it.
    const def = parse({
      nodes: [{ id: "c", kind: "condition", op: "not_empty" }],
      edges: [{ from: "ghost", to: "c" }],
    });
    const result = validateDefinition(def);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.some((e) => e.includes("nothing runs before it"))).toBe(true);
  });

  it("a_full_file_pass_may_not_be_pointed_at_all_files", () => {
    const def = parse({
      nodes: [{ id: "p", kind: "file_pass", select: { type: "all" }, instruction: "read it" }],
      edges: [],
    });
    const r = validateDefinition(def);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors.some((e) => e.includes("for_each_file") && e.includes("newest"))).toBe(true);

    // for_each_file over "all" is exactly the right shape and stays valid…
    const each = parse({
      nodes: [{ id: "e", kind: "for_each_file", select: { type: "all" }, instruction: "summarize it" }],
      edges: [],
    });
    expect(validateDefinition(each)).toEqual({ ok: true });
    // …and so does summarize_file, which really can take every file.
    const summarize = parse({
      nodes: [{ id: "s", kind: "summarize_file", select: { type: "all" } }],
      edges: [],
    });
    expect(validateDefinition(summarize)).toEqual({ ok: true });
  });

  it("a_runaway_definition_is_refused", () => {
    const nodes = Array.from({ length: MAX_NODES + 1 }, (_, i) => ({ id: `n${i}`, kind: "transform", op: "trim" }));
    const huge = parse({ nodes, edges: [] });
    const r1 = validateDefinition(huge);
    expect(r1.ok).toBe(false);
    if (r1.ok) throw new Error("unreachable");
    expect(r1.errors.some((e) => e.includes("steps"))).toBe(true);
    expect(r1.errors, "the size cap returns immediately, alone").toHaveLength(1);

    // A single node's instructions are bounded too.
    const long = parse({ nodes: [{ id: "g", kind: "generate", prompt: "x".repeat(MAX_NODE_TEXT + 1) }], edges: [] });
    const r2 = validateDefinition(long);
    expect(r2.ok).toBe(false);
    if (r2.ok) throw new Error("unreachable");
    expect(r2.errors.some((e) => e.includes("longer than"))).toBe(true);

    // Right at the limit is still fine.
    const ok = parse({ nodes: [{ id: "g", kind: "generate", prompt: "x".repeat(MAX_NODE_TEXT) }], edges: [] });
    expect(validateDefinition(ok)).toEqual({ ok: true });
  });

  it("the text cap counts CODE POINTS, not UTF-16 units — an emoji prompt at the limit still saves", () => {
    // "🙂" is two UTF-16 units but one `char`; `.length` would double-count it
    // and refuse a prompt Rust accepts.
    const atLimit = parse({ nodes: [{ id: "g", kind: "generate", prompt: "🙂".repeat(MAX_NODE_TEXT) }], edges: [] });
    expect(validateDefinition(atLimit)).toEqual({ ok: true });
    const over = parse({ nodes: [{ id: "g", kind: "generate", prompt: "🙂".repeat(MAX_NODE_TEXT + 1) }], edges: [] });
    expect(validateDefinition(over).ok).toBe(false);
  });

  it("a runaway EDGE count is refused too", () => {
    const edges = Array.from({ length: MAX_EDGES + 1 }, () => ({ from: "a", to: "a" }));
    const huge = parse({ nodes: [{ id: "a", kind: "transform", op: "trim" }], edges });
    const r = validateDefinition(huge);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors).toEqual([`The workflow has ${MAX_EDGES + 1} connections — the limit is ${MAX_EDGES}.`]);
  });

  it("validate_flags_bad_transform_and_script_mode", () => {
    const def = parse({
      nodes: [
        { id: "t", kind: "transform", op: "explode" },
        { id: "s", kind: "script_run", file: "x.py", mode: "sideways" },
      ],
      edges: [],
    });
    const r = validateDefinition(def);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors.some((e) => e.includes("unknown transform"))).toBe(true);
    expect(r.errors.some((e) => e.includes("unknown script mode"))).toBe(true);
  });

  it("flags an empty id and a duplicate id", () => {
    const def = parse({
      nodes: [
        { id: "  ", kind: "transform", op: "trim" },
        { id: "dup", kind: "transform", op: "trim" },
        { id: "dup", kind: "transform", op: "trim" },
      ],
      edges: [],
    });
    const r = validateDefinition(def);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors).toContain("A node has an empty id — every node needs a unique id.");
    expect(r.errors).toContain("Duplicate node id 'dup' — ids must be unique.");
  });

  it("script_run: a bare id is fine, a wrong extension is not, an empty file is not", () => {
    const bareId = parse({ nodes: [{ id: "s", kind: "script_run", file: "01HXYZ" }], edges: [] });
    expect(validateDefinition(bareId), "a bare file id is resolved at run time").toEqual({ ok: true });

    const py = parse({ nodes: [{ id: "s", kind: "script_run", file: "tool.py" }], edges: [] });
    expect(validateDefinition(py)).toEqual({ ok: true });
    const js = parse({ nodes: [{ id: "s", kind: "script_run", file: "tool.js" }], edges: [] });
    expect(validateDefinition(js)).toEqual({ ok: true });

    const sh = parse({ nodes: [{ id: "s", kind: "script_run", file: "tool.sh" }], edges: [] });
    const shResult = validateDefinition(sh);
    expect(shResult.ok).toBe(false);
    if (shResult.ok) throw new Error("unreachable");
    expect(shResult.errors.some((e) => e.includes("only .py or .js scripts can run"))).toBe(true);

    const blank = parse({ nodes: [{ id: "s", kind: "script_run", file: "  " }], edges: [] });
    const blankResult = validateDefinition(blank);
    expect(blankResult.ok).toBe(false);
    if (blankResult.ok) throw new Error("unreachable");
    expect(blankResult.errors.some((e) => e.includes("has no script file"))).toBe(true);
  });

  it("transform/replace needs a `find` — but a single SPACE is a legal needle (Rust checks is_empty, not trim)", () => {
    const missing = parse({ nodes: [{ id: "t", kind: "transform", op: "replace" }], edges: [] });
    const missingResult = validateDefinition(missing);
    expect(missingResult.ok).toBe(false);
    if (missingResult.ok) throw new Error("unreachable");
    expect(missingResult.errors.some((e) => e.includes("needs a `find` string"))).toBe(true);

    const space = parse({ nodes: [{ id: "t", kind: "transform", op: "replace", find: " " }], edges: [] });
    expect(validateDefinition(space)).toEqual({ ok: true });
  });

  it("transform/truncate takes exactly what Rust's `parse::<usize>()` takes", () => {
    const truncate = (value?: string): boolean => {
      const node: Record<string, unknown> = { id: "t", kind: "transform", op: "truncate" };
      if (value !== undefined) node.value = value;
      return validateDefinition(parse({ nodes: [node], edges: [] })).ok;
    };
    expect(truncate("120")).toBe(true);
    expect(truncate("  120  "), "the value is trimmed first").toBe(true);
    expect(truncate("0")).toBe(true);
    // Rust's `from_str_radix` accepts a leading '+' for an unsigned type.
    expect(truncate("+120"), "Rust parses '+120' as 120").toBe(true);
    // …and refuses everything else, including a value past usize::MAX.
    expect(truncate(undefined)).toBe(false);
    expect(truncate("")).toBe(false);
    expect(truncate("-1")).toBe(false);
    expect(truncate("12.5")).toBe(false);
    expect(truncate("1_0")).toBe(false);
    expect(truncate("lots")).toBe(false);
    expect(truncate("١٢٣"), "only ASCII digits count").toBe(false);
    expect(truncate("18446744073709551615"), "usize::MAX itself is fine").toBe(true);
    expect(truncate("18446744073709551616"), "one past usize::MAX is PosOverflow").toBe(false);
  });

  it("extract with no fields at all, or only blank ones, is flagged", () => {
    const none = parse({ nodes: [{ id: "e", kind: "extract", fields: [] }], edges: [] });
    const noneResult = validateDefinition(none);
    expect(noneResult.ok, "`[].all(…)` is true in Rust too").toBe(false);
    const blank = parse({ nodes: [{ id: "e", kind: "extract", fields: ["  ", ""] }], edges: [] });
    expect(validateDefinition(blank).ok).toBe(false);
    const some = parse({ nodes: [{ id: "e", kind: "extract", fields: ["  ", "name"] }], edges: [] });
    expect(validateDefinition(some), "one real field is enough").toEqual({ ok: true });
  });

  it("name_like without a pattern is flagged, on both selector-carrying kinds", () => {
    for (const kind of ["summarize_file", "file_pass", "for_each_file"]) {
      const def = parse({
        nodes: [{ id: "n", kind, select: { type: "name_like", pattern: "  " }, instruction: "do it" }],
        edges: [],
      });
      const r = validateDefinition(def);
      expect(r.ok, kind).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.errors.some((e) => e.includes("selects by name but has no pattern")), kind).toBe(true);
    }
  });

  it("save_file rejects an unknown format and an unknown save mode", () => {
    const def = parse({
      nodes: [{ id: "s", kind: "save_file", name_template: " ", format: "pdf", mode: "clobber" }],
      edges: [],
    });
    const r = validateDefinition(def);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors).toContain("Node 's' (save_file) has an empty name.");
    expect(r.errors).toContain("Node 's' has an unknown format 'pdf' — use html or md.");
    expect(r.errors).toContain("Node 's' has an unknown save mode 'clobber' — use create, overwrite or append.");
  });

  it("every remaining kind's own empty-text rule fires", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ id: "n", kind: "agent_run", question: " " }, "(agent_run) has an empty question"],
      [{ id: "n", kind: "http_fetch", url: " " }, "(http_fetch) has no URL"],
      [{ id: "n", kind: "vote", prompt: " " }, "(vote) has an empty prompt"],
      [{ id: "n", kind: "vote", prompt: "x", mode: "loudest" }, "unknown vote mode 'loudest'"],
      [{ id: "n", kind: "merge", mode: "blend" }, "unknown merge mode 'blend'"],
      [{ id: "n", kind: "refine", prompt: " " }, "(refine) has an empty prompt"],
      [{ id: "n", kind: "plan_and_map", objective: " " }, "(plan_and_map) has an empty objective"],
      [
        { id: "n", kind: "for_each_file", select: { type: "newest" }, instruction: " " },
        "(for_each_file) has an empty instruction",
      ],
    ];
    for (const [node, needle] of cases) {
      const r = validateDefinition(parse({ nodes: [node], edges: [] }));
      expect(r.ok, needle).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.errors.some((e) => e.includes(needle)), `${needle}: ${JSON.stringify(r.errors)}`).toBe(true);
    }
  });
});

// ============================================================================
// validate_with_binding
// ============================================================================

describe("validateWithBinding", () => {
  it("run_input_requires_a_file_binding", () => {
    const def = parse({
      nodes: [{ id: "p", kind: "file_pass", select: { type: "run_input" }, instruction: "read it" }],
      edges: [],
    });
    expect(defUsesRunInput(def)).toBe(true);
    // General binding is rejected…
    const generalResult = validateWithBinding(def, { scope: "general" });
    expect(generalResult.ok).toBe(false);
    if (generalResult.ok) throw new Error("unreachable");
    expect(generalResult.errors).toEqual([
      "Node 'p' reads the run's input file — set the workflow's binding to file-scoped.",
    ]);
    // …file binding is accepted.
    expect(validateWithBinding(def, { scope: "file", kinds: ["pdf"], exts: [], file_id: null })).toEqual({ ok: true });
  });

  it("propagates the plain save-time errors before it ever looks at the binding", () => {
    const def = parse({ nodes: [{ id: "g", kind: "generate", prompt: "" }], edges: [] });
    const r = validateWithBinding(def, { scope: "general" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors.some((e) => e.includes("empty prompt"))).toBe(true);
  });

  it("a def with no run_input node is fine under a general binding", () => {
    expect(validateWithBinding(linearDef(), { scope: "general" })).toEqual({ ok: true });
  });
});

// ============================================================================
// Rigor — the grandfathering split, rule by rule
// ============================================================================

describe("Rigor: saving refuses, an already-saved definition still runs", () => {
  it("a_workflow_saved_before_these_rules_existed_still_runs", () => {
    // Every rule below is checked on SAVE, and `compileWorkflow` runs on every
    // START. So the moment they landed, definitions the app itself wrote
    // stopped being startable — and a SCHEDULED start reports nothing, so a
    // months-old automation just stopped firing. The rules stay; they just
    // apply where the author can act on them.
    const grandfathered: unknown[] = [
      // An unlabelled exit from a condition.
      {
        nodes: [
          { id: "s", kind: "transform", op: "trim" },
          { id: "c", kind: "condition", op: "not_empty" },
          { id: "g", kind: "generate", prompt: "x" },
        ],
        edges: [
          { from: "s", to: "c" },
          { from: "c", to: "g" },
        ],
      },
      // …and from a route.
      {
        nodes: [
          { id: "r", kind: "route", labels: ["a", "b"] },
          { id: "g", kind: "generate", prompt: "x" },
        ],
        edges: [{ from: "r", to: "g" }],
      },
      // A file_pass on "All files" — still an option in the dropdown.
      {
        nodes: [{ id: "p", kind: "file_pass", select: { type: "all" }, instruction: "read it" }],
        edges: [],
      },
      // A condition with an empty needle, with upstream text.
      {
        nodes: [
          { id: "s", kind: "transform", op: "trim" },
          { id: "c", kind: "condition", op: "contains", value: "" },
        ],
        edges: [{ from: "s", to: "c" }],
      },
      // …and one with nothing upstream.
      { nodes: [{ id: "c", kind: "condition", op: "not_empty" }], edges: [] },
      // A prompt longer than the (new) per-node text cap.
      { nodes: [{ id: "g", kind: "generate", prompt: "x".repeat(MAX_NODE_TEXT + 1) }], edges: [] },
    ];
    grandfathered.forEach((raw, i) => {
      const def = parse(raw);
      expect(validateDefinition(def).ok, `#${i}: saving must still refuse it — that is where it gets fixed`).toBe(
        false
      );
      const runnable = validateRunnable(def);
      expect(runnable.ok, `#${i}: an already-saved workflow must still start: ${JSON.stringify(runnable)}`).toBe(true);
      expect(compileWorkflow(def, null, []).ok, `#${i}: starting a run compiles through validateRunnable`).toBe(true);
    });

    // A runaway node count is an authoring guard-rail too…
    const nodes = Array.from({ length: MAX_NODES + 1 }, (_, i) => ({ id: `n${i}`, kind: "transform", op: "trim" }));
    const huge = parse({ nodes, edges: [] });
    expect(validateDefinition(huge).ok).toBe(false);
    expect(validateRunnable(huge).ok).toBe(true);

    // …and so is a runaway edge count.
    const manyEdges = parse({
      nodes: [
        { id: "a", kind: "transform", op: "trim" },
        { id: "b", kind: "transform", op: "trim" },
      ],
      edges: Array.from({ length: MAX_EDGES + 1 }, () => ({ from: "a", to: "b" })),
    });
    expect(validateDefinition(manyEdges).ok).toBe(false);
    expect(validateRunnable(manyEdges).ok).toBe(true);

    // What run-time leniency does NOT cover: a definition that cannot be
    // executed at all is still refused, at both gates.
    const structural: unknown[] = [
      // An unknown selector…
      { nodes: [{ id: "s", kind: "summarize_file", select: { type: "sideways" } }], edges: [] },
      // …an illegal branch label…
      {
        nodes: [
          { id: "c", kind: "condition", op: "new_files_since_last_run" },
          { id: "g", kind: "generate", prompt: "x" },
        ],
        edges: [{ from: "c", to: "g", branch: "maybe" }],
      },
      // …a dangling edge…
      { nodes: [{ id: "g", kind: "generate", prompt: "x" }], edges: [{ from: "g", to: "ghost" }] },
      // …a cycle…
      {
        nodes: [
          { id: "a", kind: "transform", op: "trim" },
          { id: "b", kind: "transform", op: "trim" },
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "a" },
        ],
      },
      // …an empty prompt, an unknown op, a duplicate id, no nodes at all.
      { nodes: [{ id: "g", kind: "generate", prompt: "" }], edges: [] },
      { nodes: [{ id: "t", kind: "transform", op: "explode" }], edges: [] },
      {
        nodes: [
          { id: "d", kind: "transform", op: "trim" },
          { id: "d", kind: "transform", op: "trim" },
        ],
        edges: [],
      },
      { nodes: [], edges: [] },
    ];
    structural.forEach((raw, i) => {
      const def = parse(raw);
      expect(validateDefinition(def).ok, `structural #${i}`).toBe(false);
      expect(validateRunnable(def).ok, `structural #${i}: a def that cannot run must never start`).toBe(false);
    });
  });

  it("names each grandfathered rule as SAVE-only, one at a time", () => {
    // `validate_inner` has exactly SEVEN `if saving` guards (workflow.rs:444,
    // 451, 471, 527, 577, 590, 773) — the last one covers two message shapes,
    // so eight cases below. Each is isolated so a future edit that drops one
    // `saving &&` fails here by name rather than in an aggregate.
    const saveOnly: Array<[string, unknown]> = [
      ["node count cap", { nodes: Array.from({ length: MAX_NODES + 1 }, (_, i) => ({ id: `n${i}`, kind: "transform", op: "trim" })), edges: [] }],
      // a→b, never a self-edge: a self-edge is a CYCLE, which is structural
      // and refused at BOTH gates — it would prove nothing about the cap.
      ["edge count cap", { nodes: [{ id: "a", kind: "transform", op: "trim" }, { id: "b", kind: "transform", op: "trim" }], edges: Array.from({ length: MAX_EDGES + 1 }, () => ({ from: "a", to: "b" })) }],
      ["per-node text cap", { nodes: [{ id: "g", kind: "generate", prompt: "x".repeat(MAX_NODE_TEXT + 1) }], edges: [] }],
      ["file_pass over all files", { nodes: [{ id: "p", kind: "file_pass", select: { type: "all" }, instruction: "read" }], edges: [] }],
      ["empty contains needle", { nodes: [{ id: "s", kind: "transform", op: "trim" }, { id: "c", kind: "condition", op: "contains" }], edges: [{ from: "s", to: "c" }] }],
      ["condition with nothing upstream", { nodes: [{ id: "c", kind: "condition", op: "is_empty" }], edges: [] }],
      ["unlabelled exit from a condition", { nodes: [{ id: "c", kind: "condition", op: "new_files_since_last_run" }, { id: "g", kind: "generate", prompt: "x" }], edges: [{ from: "c", to: "g" }] }],
      ["unlabelled exit from a route", { nodes: [{ id: "r", kind: "route", labels: ["a", "b"] }, { id: "g", kind: "generate", prompt: "x" }], edges: [{ from: "r", to: "g" }] }],
    ];
    for (const [name, raw] of saveOnly) {
      const def = parse(raw);
      expect(validateDefinition(def).ok, `${name}: must block a SAVE`).toBe(false);
      expect(validateRunnable(def).ok, `${name}: must NOT block a RUN`).toBe(true);
    }
  });

  it("the run-time gate keeps every structural rule that is NOT grandfathered", () => {
    const alwaysEnforced: Array<[string, unknown]> = [
      ["empty node list", { nodes: [], edges: [] }],
      ["empty node id", { nodes: [{ id: " ", kind: "transform", op: "trim" }], edges: [] }],
      ["unknown selector", { nodes: [{ id: "s", kind: "summarize_file", select: { type: "nope" } }], edges: [] }],
      ["name_like with no pattern", { nodes: [{ id: "s", kind: "summarize_file", select: { type: "name_like" } }], edges: [] }],
      ["unknown condition op", { nodes: [{ id: "c", kind: "condition", op: "nope" }], edges: [] }],
      ["unknown save mode", { nodes: [{ id: "s", kind: "save_file", name_template: "o", mode: "nope" }], edges: [] }],
      ["unknown script mode", { nodes: [{ id: "s", kind: "script_run", file: "x.py", mode: "nope" }], edges: [] }],
      ["truncate with no count", { nodes: [{ id: "t", kind: "transform", op: "truncate" }], edges: [] }],
      ["route with one label", { nodes: [{ id: "r", kind: "route", labels: ["a"] }], edges: [] }],
      ["branch off a plain node", { nodes: [{ id: "a", kind: "transform", op: "trim" }, { id: "b", kind: "transform", op: "trim" }], edges: [{ from: "a", to: "b", branch: "then" }] }],
      ["condition branch that is neither then nor else", { nodes: [{ id: "c", kind: "condition", op: "new_files_since_last_run" }, { id: "g", kind: "generate", prompt: "x" }], edges: [{ from: "c", to: "g", branch: "perhaps" }] }],
    ];
    for (const [name, raw] of alwaysEnforced) {
      const def = parse(raw);
      expect(validateDefinition(def).ok, `${name}: SAVE`).toBe(false);
      expect(validateRunnable(def).ok, `${name}: RUN`).toBe(false);
    }
  });
});

// ============================================================================
// topo_order — the deterministic tie-break, in both its halves
// ============================================================================

describe("topoOrder", () => {
  it("root nodes run in DECLARED order", () => {
    const def = parse({
      nodes: [
        { id: "c", kind: "transform", op: "trim" },
        { id: "a", kind: "transform", op: "trim" },
        { id: "b", kind: "transform", op: "trim" },
      ],
      edges: [],
    });
    const result = topoOrder(def);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.order, "not sorted, not reversed — declared").toEqual(["c", "a", "b"]);
  });

  it("declared order wins for the initial roots even when non-roots are declared first", () => {
    // y and x are declared FIRST but each has an incoming edge (not roots);
    // root/b/a are declared after them and are all roots. root's own two
    // outgoing edges are declared y-then-x, so y and x join the BACK of the
    // queue in that order, behind b and a.
    const def = parse({
      nodes: [
        { id: "y", kind: "transform", op: "trim" },
        { id: "x", kind: "transform", op: "trim" },
        { id: "root", kind: "transform", op: "trim" },
        { id: "b", kind: "transform", op: "trim" },
        { id: "a", kind: "transform", op: "trim" },
      ],
      edges: [
        { from: "root", to: "y" },
        { from: "root", to: "x" },
      ],
    });
    const result = topoOrder(def);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.order).toEqual(["root", "b", "a", "y", "x"]);
  });

  it("a newly-ready node joins the BACK of the queue, in its parent's EDGE-declaration order", () => {
    // A second layer proves the queue is FIFO end to end: x/y only become
    // ready once b/a finish, and must come after both — a STACK would give
    // ["root","a","y","b","x"], a re-sorted queue ["root","a","b","x","y"].
    const def = parse({
      nodes: [
        { id: "root", kind: "transform", op: "trim" },
        { id: "a", kind: "transform", op: "trim" },
        { id: "b", kind: "transform", op: "trim" },
        { id: "y", kind: "transform", op: "trim" },
        { id: "x", kind: "transform", op: "trim" },
      ],
      edges: [
        { from: "root", to: "b" },
        { from: "root", to: "a" },
        { from: "a", to: "y" },
        { from: "b", to: "x" },
      ],
    });
    const result = topoOrder(def);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.order).toEqual(["root", "b", "a", "x", "y"]);
  });

  it("edges naming unknown nodes are ignored rather than blocking the sort", () => {
    const def = parse({
      nodes: [{ id: "a", kind: "transform", op: "trim" }],
      edges: [
        { from: "ghost", to: "a" },
        { from: "a", to: "ghost" },
      ],
    });
    expect(topoOrder(def)).toEqual({ ok: true, order: ["a"] });
  });

  it("names every still-stuck node on a cycle, and no node outside it", () => {
    const def = parse({
      nodes: [
        { id: "a", kind: "transform", op: "trim" },
        { id: "b", kind: "transform", op: "trim" },
        { id: "free", kind: "transform", op: "trim" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    });
    const result = topoOrder(def);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.cycle.slice().sort()).toEqual(["a", "b"]);
  });

  it("a self-edge is a cycle", () => {
    const def = parse({
      nodes: [{ id: "a", kind: "transform", op: "trim" }],
      edges: [{ from: "a", to: "a" }],
    });
    const result = topoOrder(def);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.cycle).toEqual(["a"]);
    // …and a cycle stops a RUN, not just a save. NOTE what actually reports it:
    // `compile_workflow` calls `validate_runnable` FIRST, and the cycle check is
    // not grandfathered — so the message that comes back is the VALIDATOR's
    // ("The workflow has a cycle through: … — remove an edge…"), never
    // `compile_workflow`'s own terser `format!("cycle through {}", …)` arm.
    // That arm is unreachable in Rust for the same reason and is ported only to
    // keep the two functions line-for-line comparable; asserting a loose
    // `.includes("cycle")` here would pass either way and hide a swap.
    const compiled = compileWorkflow(def, null, []);
    expect(compiled.ok).toBe(false);
    if (compiled.ok) throw new Error("unreachable");
    expect(compiled.errors).toEqual(["The workflow has a cycle through: a — remove an edge so it can run in order."]);
  });
});

// ============================================================================
// the parse layer — every `default_*` fn, and the strictness serde has
// ============================================================================

describe("NodeKind field defaults", () => {
  it("Generate.model defaults to '' (plain String::default(), no named fn)", () => {
    expect(parseWorkflowNode({ id: "a", kind: "generate", prompt: "x" })).toMatchObject({ model: "" });
  });

  it("FilePass.mode defaults to 'merge' (default_mode), instruction to ''", () => {
    expect(parseWorkflowNode({ id: "a", kind: "file_pass", select: { type: "newest" } })).toMatchObject({
      mode: "merge",
      instruction: "",
    });
  });

  it("SaveFile.format defaults to 'html' (default_format), mode to 'create' (default_save_mode)", () => {
    expect(parseWorkflowNode({ id: "a", kind: "save_file", name_template: "out" })).toMatchObject({
      format: "html",
      mode: "create",
    });
  });

  it("ScriptRun.mode defaults to 'import' (default_script_mode)", () => {
    expect(parseWorkflowNode({ id: "a", kind: "script_run", file: "x.py" })).toMatchObject({ mode: "import" });
  });

  it("Merge.mode defaults to 'concat' (default_merge_mode), separator to null", () => {
    expect(parseWorkflowNode({ id: "a", kind: "merge" })).toMatchObject({ mode: "concat", separator: null });
  });

  it("Vote.samples defaults to 3 (default_samples), mode to 'concat' (default_vote_mode)", () => {
    expect(parseWorkflowNode({ id: "a", kind: "vote", prompt: "x" })).toMatchObject({
      samples: 3,
      mode: "concat",
      model: "",
    });
  });

  it("Refine.max_rounds defaults to 2 (default_refine_rounds)", () => {
    expect(parseWorkflowNode({ id: "a", kind: "refine", prompt: "x" })).toMatchObject({
      max_rounds: 2,
      rubric: "",
      model: "",
    });
  });

  it("PlanAndMap.max_workers defaults to 4 (default_max_workers)", () => {
    expect(parseWorkflowNode({ id: "a", kind: "plan_and_map", objective: "x" })).toMatchObject({
      max_workers: 4,
      model: "",
    });
  });

  it("Route.prompt/model default to ''", () => {
    expect(parseWorkflowNode({ id: "r", kind: "route", labels: ["a", "b"] })).toMatchObject({
      prompt: "",
      model: "",
    });
  });

  it("Condition.value and Transform.find/value (Option<String>) default to null", () => {
    const c = parseWorkflowNode({ id: "c", kind: "condition", op: "not_empty" });
    expect((c as { value: string | null }).value).toBeNull();
    const t = parseWorkflowNode({ id: "t", kind: "transform", op: "trim" });
    expect((t as { find: string | null }).find).toBeNull();
    expect((t as { value: string | null }).value).toBeNull();
    // An explicit JSON null reads as None too, exactly like an absent key.
    const explicit = parseWorkflowNode({ id: "c", kind: "condition", op: "not_empty", value: null });
    expect((explicit as { value: string | null }).value).toBeNull();
  });

  it("WorkflowNode.label defaults to '' and the node's JSON stays FLAT (serde(flatten))", () => {
    const n = parseWorkflowNode({ id: "a", kind: "transform", op: "trim" });
    expect(n.label).toBe("");
    // The wire shape the executor and the step editor both read back.
    expect(JSON.parse(JSON.stringify(n))).toEqual({
      id: "a",
      label: "",
      kind: "transform",
      op: "trim",
      find: null,
      value: null,
    });
  });

  it("the flat wire names are snake_case, exactly as Rust serializes them", () => {
    const n = parseWorkflowNode({ id: "s", kind: "save_file", name_template: "out" });
    expect(Object.keys(n)).toContain("name_template");
    const r = parseWorkflowNode({ id: "r", kind: "refine", prompt: "x" });
    expect(Object.keys(r)).toContain("max_rounds");
    const p = parseWorkflowNode({ id: "p", kind: "plan_and_map", objective: "x" });
    expect(Object.keys(p)).toContain("max_workers");
  });
});

describe("WorkflowEdge / WorkflowDef defaults", () => {
  it("WorkflowEdge.branch defaults to null", () => {
    expect(parseWorkflowEdge({ from: "a", to: "b" }).branch).toBeNull();
  });

  it("default_version() — version defaults to 1, edges to []", () => {
    expect(DEFAULT_VERSION).toBe(1);
    const def = parseWorkflowDef({ nodes: [] });
    expect(def.version).toBe(1);
    expect(def.edges).toEqual([]);
  });
});

describe("FileSelector: sel_newest() vs the DERIVED Default", () => {
  it("selNewest is 'newest'", () => {
    expect(SEL_NEWEST).toBe("newest");
  });

  it("a PRESENT (even empty) select object defaults its 'type' to 'newest' via sel_newest()", () => {
    const n = parseWorkflowNode({ id: "s", kind: "summarize_file", select: {} });
    expect((n as { select: FileSelector }).select).toEqual({ type: "newest", pattern: null });
  });

  it("an ABSENT select key falls back to the derived FileSelector::default() — type '', NOT 'newest'", () => {
    const n = parseWorkflowNode({ id: "s", kind: "summarize_file" });
    const select = (n as { select: FileSelector }).select;
    expect(select).toEqual(DEFAULT_FILE_SELECTOR_WHEN_KEY_ABSENT);
    expect(select.type).toBe("");
    expect(select.type).not.toBe(SEL_NEWEST);
  });

  it("…and that reads as an INVALID selector under validation — the user-visible consequence", () => {
    const r = validateDefinition(parseWorkflowDef({ nodes: [{ id: "s", kind: "summarize_file" }], edges: [] }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors.some((e) => e.includes("unknown file selector ''"))).toBe(true);
  });

  it("the shared frozen default is never handed out for a caller to mutate", () => {
    const a = parseWorkflowNode({ id: "s", kind: "summarize_file" }) as { select: FileSelector };
    const b = parseWorkflowNode({ id: "t", kind: "summarize_file" }) as { select: FileSelector };
    expect(a.select).not.toBe(b.select);
    expect(a.select).not.toBe(DEFAULT_FILE_SELECTOR_WHEN_KEY_ABSENT);
  });
});

describe("parse strictness (serde's `default` fires on ABSENCE only)", () => {
  it("throws when a required field is missing", () => {
    expect(() => parseWorkflowNode({ id: "a", kind: "generate" })).toThrow(/prompt/);
    expect(() => parseWorkflowNode({ kind: "generate", prompt: "x" })).toThrow(/id/);
    expect(() => parseWorkflowNode({ id: "a", kind: "agent_run" })).toThrow(/question/);
    expect(() => parseWorkflowNode({ id: "a", kind: "save_file" })).toThrow(/name_template/);
    expect(() => parseWorkflowNode({ id: "a", kind: "extract" })).toThrow(/fields/);
    expect(() => parseWorkflowNode({ id: "a", kind: "route" })).toThrow(/labels/);
    expect(() => parseWorkflowNode({ id: "a", kind: "http_fetch" })).toThrow(/url/);
    expect(() => parseWorkflowNode({ id: "a", kind: "script_run" })).toThrow(/file/);
    expect(() => parseWorkflowNode({ id: "a", kind: "for_each_file" })).toThrow(/instruction/);
    expect(() => parseWorkflowEdge({ from: "a" })).toThrow(/to/);
  });

  it("throws on an unknown node kind, and on a missing/non-string one", () => {
    expect(() => parseWorkflowNode({ id: "a", kind: "bogus" })).toThrow(/unknown node kind/);
    expect(() => parseWorkflowNode({ id: "a" })).toThrow(/'kind'/);
    expect(() => parseWorkflowNode({ id: "a", kind: 7 })).toThrow(/'kind'/);
  });

  it("throws when a PRESENT field has the wrong type — a default never covers a type mismatch", () => {
    expect(() => parseWorkflowNode({ id: "a", kind: "generate", prompt: 5 })).toThrow(/must be a string/);
    expect(() => parseWorkflowNode({ id: "a", kind: "generate", prompt: "x", model: 5 })).toThrow(/must be a string/);
    expect(() => parseWorkflowNode({ id: "a", kind: "generate", prompt: "x", model: null })).toThrow(/must be a string/);
    expect(() => parseWorkflowNode({ id: "a", kind: "vote", prompt: "x", samples: 1.5 })).toThrow(/u32/);
    expect(() => parseWorkflowNode({ id: "a", kind: "vote", prompt: "x", samples: -1 })).toThrow(/u32/);
    expect(() => parseWorkflowNode({ id: "a", kind: "vote", prompt: "x", samples: 2 ** 32 })).toThrow(/u32/);
    expect(() => parseWorkflowNode({ id: "a", kind: "extract", fields: "name" })).toThrow(/array of strings/);
    expect(() => parseWorkflowNode({ id: "a", kind: "extract", fields: [1] })).toThrow(/array of strings/);
    expect(() => parseWorkflowNode({ id: "a", kind: "summarize_file", select: "newest" })).toThrow(/must be an object/);
    expect(() => parseWorkflowNode({ id: "a", kind: "condition", op: "x", value: 5 })).toThrow(/string or null/);
  });

  it("accepts u32::MAX itself for a u32 field", () => {
    expect(parseWorkflowNode({ id: "a", kind: "vote", prompt: "x", samples: 0xffff_ffff })).toMatchObject({
      samples: 0xffff_ffff,
    });
  });

  it("throws when 'nodes' is missing or is not an array", () => {
    expect(() => parseWorkflowDef({})).toThrow(/nodes/);
    expect(() => parseWorkflowDef({ nodes: {} })).toThrow(/must be an array/);
    expect(() => parseWorkflowDef("nope")).toThrow(/must be an object/);
  });

  it("throws when a node/edge entry isn't an object, naming its index", () => {
    expect(() => parseWorkflowDef({ nodes: ["nope"] })).toThrow(/node\[0\]/);
    expect(() => parseWorkflowDef({ nodes: [], edges: ["nope"] })).toThrow(/edge\[0\]/);
    expect(() => parseWorkflowDef({ nodes: [], edges: {} })).toThrow(/must be an array/);
  });

  it("an unknown extra key is IGNORED, as serde does for these structs", () => {
    // The Rust source calls this out explicitly for `condition`: the step
    // editor used to write a dead `input: ""`, and old definitions still parse.
    const n = parseWorkflowNode({ id: "c", kind: "condition", op: "not_empty", input: "" });
    expect(n).toMatchObject({ kind: "condition", op: "not_empty" });
    expect((n as unknown as { input?: string }).input).toBeUndefined();
  });
});

describe("parseWorkflowBinding", () => {
  it("parses the general scope", () => {
    expect(parseWorkflowBinding({ scope: "general" })).toEqual({ scope: "general" });
  });

  it("parses the file scope, defaulting kinds/exts to [] and file_id to null", () => {
    expect(parseWorkflowBinding({ scope: "file" })).toEqual({ scope: "file", kinds: [], exts: [], file_id: null });
  });

  it("reads a fully-populated file scope", () => {
    expect(parseWorkflowBinding({ scope: "file", kinds: ["pdf"], exts: ["pdf"], file_id: "f1" })).toEqual({
      scope: "file",
      kinds: ["pdf"],
      exts: ["pdf"],
      file_id: "f1",
    });
  });

  it("rejects non-string file binding filters", () => {
    expect(() => parseWorkflowBinding({ scope: "file", kinds: ["pdf", 7] })).toThrow(/kinds.*array of strings/);
    expect(() => parseWorkflowBinding({ scope: "file", exts: "pdf" })).toThrow(/exts.*array of strings/);
  });

  it("throws on an unknown scope", () => {
    expect(() => parseWorkflowBinding({ scope: "bogus" })).toThrow(/unknown scope/);
    expect(() => parseWorkflowBinding({})).toThrow(/unknown scope/);
  });
});

// ============================================================================
// WfArtifact
// ============================================================================

describe("parseWfArtifact", () => {
  it("a bare/empty object parses to exactly the fresh-artifact defaults", () => {
    expect(parseWfArtifact({})).toEqual(DEFAULT_WF_ARTIFACT);
  });

  it("a non-object blob also reads as all-defaults — this reader never throws", () => {
    expect(parseWfArtifact(null)).toEqual(DEFAULT_WF_ARTIFACT);
    expect(parseWfArtifact("garbage")).toEqual(DEFAULT_WF_ARTIFACT);
    expect(parseWfArtifact(undefined)).toEqual(DEFAULT_WF_ARTIFACT);
  });

  it("reads every present, correctly-typed field under its snake_case wire name", () => {
    const full = {
      result: "hi",
      skipped: true,
      branch: "then",
      file_id: "f1",
      node_label: "Step 1",
      node_kind: "generate",
    };
    expect(parseWfArtifact(full)).toEqual(full);
  });

  it("a present but wrong-typed field reads as absent, never thrown", () => {
    expect(parseWfArtifact({ result: 5, skipped: "yes", branch: 3 })).toEqual(DEFAULT_WF_ARTIFACT);
  });
});

// ============================================================================
// selector_is_run_input / node_uses_run_input / def_uses_run_input
// ============================================================================

describe("selectorIsRunInput / nodeUsesRunInput / defUsesRunInput", () => {
  it("is true only for a run_input selector", () => {
    expect(selectorIsRunInput({ type: "run_input", pattern: null })).toBe(true);
    expect(selectorIsRunInput({ type: "newest", pattern: null })).toBe(false);
  });

  it("is true for the three selector-carrying kinds, false for every other kind", () => {
    for (const raw of [
      { id: "s", kind: "summarize_file", select: { type: "run_input" } },
      { id: "p", kind: "file_pass", select: { type: "run_input" }, instruction: "x" },
      { id: "f", kind: "for_each_file", select: { type: "run_input" }, instruction: "x" },
    ]) {
      expect(nodeUsesRunInput(parseWorkflowNode(raw)), raw.kind).toBe(true);
    }
    expect(nodeUsesRunInput(parseWorkflowNode({ id: "g", kind: "generate", prompt: "x" }))).toBe(false);
    expect(nodeUsesRunInput(parseWorkflowNode({ id: "s2", kind: "summarize_file", select: { type: "newest" } }))).toBe(
      false
    );
  });

  it("defUsesRunInput is true iff ANY node in the def reads the run input", () => {
    const withIt = parse({
      nodes: [
        { id: "a", kind: "generate", prompt: "x" },
        { id: "p", kind: "file_pass", select: { type: "run_input" }, instruction: "x" },
      ],
      edges: [],
    });
    expect(defUsesRunInput(withIt)).toBe(true);
    expect(defUsesRunInput(linearDef())).toBe(false);
  });
});

// ============================================================================
// node_kind_tag — the defensive re-check for a hand-built node
// ============================================================================

describe("nodeKindTag / the defensive unknown-kind check", () => {
  it("returns the discriminant string", () => {
    expect(nodeKindTag(parseWorkflowNode({ id: "a", kind: "transform", op: "trim" }))).toBe("transform");
  });

  it("REPORTS (never throws on) a node built directly with an invalid kind, bypassing the parser", () => {
    // The Rust source keeps this check explicitly so the message stays
    // actionable for a hand-built def — so a bogus kind must come back as one
    // more validation sentence, and compileWorkflow must return that list
    // rather than blowing up inside its own per-kind match.
    const handBuilt = { id: "x", label: "", kind: "bogus", prompt: "x", model: "" } as unknown as WorkflowNode;
    const def: WorkflowDef = { version: 1, nodes: [handBuilt], edges: [] };
    const r = validateDefinition(def);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors.some((e) => e.includes("unknown kind 'bogus'"))).toBe(true);

    const compiled = compileWorkflow(def, null, []);
    expect(compiled.ok).toBe(false);
    if (compiled.ok) throw new Error("unreachable");
    expect(compiled.errors.some((e) => e.includes("unknown kind 'bogus'"))).toBe(true);
  });
});

// ============================================================================
// constants — order matters (several are joined into user-visible error text)
// ============================================================================

describe("constant lists preserve Rust's declared order", () => {
  it("NODE_KINDS / TRANSFORM_OPS / MERGE_MODES / SCRIPT_MODES / VOTE_MODES / FILE_SELECTORS / CONDITION_OPS", () => {
    expect(NODE_KINDS).toEqual([
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
    ]);
    expect(TRANSFORM_OPS).toEqual(["append", "prepend", "replace", "upper", "lower", "trim", "truncate", "strip_html"]);
    expect(MERGE_MODES).toEqual(["concat", "dedupe_lines", "numbered"]);
    expect(SCRIPT_MODES).toEqual(["import", "transform"]);
    expect(VOTE_MODES).toEqual(["concat", "majority"]);
    expect(FILE_SELECTORS).toEqual(["newest", "all", "name_like", "missing_summary", "since_last_run", "run_input"]);
    expect(CONDITION_OPS).toEqual(["contains", "not_contains", "is_empty", "not_empty", "new_files_since_last_run"]);
  });

  it("the joined lists appear verbatim in the error text a model is asked to fix", () => {
    const r = validateDefinition(parse({ nodes: [{ id: "s", kind: "summarize_file", select: { type: "q" } }], edges: [] }));
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]).toBe(
      "Node 's' has an unknown file selector 'q' — use one of: newest, all, name_like, missing_summary, since_last_run, run_input."
    );
  });

  it("MAX_NODES / MAX_EDGES / MAX_NODE_TEXT", () => {
    expect(MAX_NODES).toBe(60);
    expect(MAX_EDGES).toBe(240);
    expect(MAX_NODE_TEXT).toBe(20_000);
  });
});

// ============================================================================
// prototype-pollution guard — the bug class this codebase has hit three times
// (mcpConfig.ts, privacyRedact.ts, jsonTools.ts/feedbackTools.ts)
// ============================================================================

describe("prototype-pollution guard", () => {
  it("a '__proto__' node id survives parse → validate → topoOrder → compile without touching Object.prototype", () => {
    const def = parse({
      nodes: [
        { id: "__proto__", kind: "route", labels: ["a", "b"], label: "__proto__" },
        { id: "constructor", kind: "generate", prompt: "x" },
        { id: "toString", kind: "generate", prompt: "y" },
      ],
      edges: [
        { from: "__proto__", to: "constructor", branch: "a" },
        { from: "__proto__", to: "toString", branch: "b" },
      ],
    });
    expect(validateDefinition(def)).toEqual({ ok: true });
    expect(topoOrder(def)).toEqual({ ok: true, order: ["__proto__", "constructor", "toString"] });
    const compiled = compileWorkflow(def, null, []);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error("unreachable");
    expect(compiled.steps.map((s) => paramsOf(s).node.id)).toEqual(["__proto__", "constructor", "toString"]);
    expect(Object.prototype.hasOwnProperty.call({}, "polluted")).toBe(false);
    expect(({} as Record<string, unknown>).a).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("a node whose OWN JSON carries a '__proto__' key does not re-parent the parsed node", () => {
    const raw = JSON.parse('{"id":"a","kind":"transform","op":"trim","__proto__":{"polluted":true}}') as unknown;
    const n = parseWorkflowNode(raw);
    expect((n as unknown as { polluted?: boolean }).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});

// ============================================================================
// ADVERSARIAL PASS — cases built to break the port rather than to demonstrate
// it. Every expectation below was checked against the Rust it mirrors; the
// `topo_order` and `parse::<usize>()` ones were checked by COMPILING the Rust
// (a standalone transcription of workflow.rs:869-906 driven by rustc) rather
// than by reading it, because both hang on container semantics — `HashMap` key
// collapse and `from_str_radix`'s sign/overflow handling — that reading gets
// wrong in both directions.
// ============================================================================

describe("adversarial: cycle naming", () => {
  it("a self-loop on a DUPLICATED id is named ONCE — Rust reads `indeg`, a HashMap, not `ids`", () => {
    // A duplicate id is its own reported error, but `validate_inner` runs the
    // topo check anyway, so this pair really does reach `topo_order` together.
    // rustc on the transcribed function: `Err(["x"])`. Filtering the `ids` VEC
    // instead of the `indeg` MAP re-names the node once per declaration and
    // printed "cycle through: x → x".
    const def = parse({
      nodes: [
        { id: "x", kind: "transform", op: "trim" },
        { id: "x", kind: "transform", op: "trim" },
      ],
      edges: [{ from: "x", to: "x" }],
    });
    const topo = topoOrder(def);
    expect(topo.ok).toBe(false);
    if (topo.ok) throw new Error("unreachable");
    expect(topo.cycle).toEqual(["x"]);

    const r = validateDefinition(def);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors).toContain("Duplicate node id 'x' — ids must be unique.");
    expect(r.errors).toContain("The workflow has a cycle through: x — remove an edge so it can run in order.");
  });

  it("a duplicated id inside a two-node cycle is still named once", () => {
    // rustc: `Err(["a", "b"])` — two entries, never three.
    const def = parse({
      nodes: [
        { id: "a", kind: "transform", op: "trim" },
        { id: "b", kind: "transform", op: "trim" },
        { id: "a", kind: "transform", op: "trim" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    });
    const topo = topoOrder(def);
    if (topo.ok) throw new Error("unreachable");
    expect(topo.cycle).toEqual(["a", "b"]);
    const r = validateDefinition(def);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors).toContain("The workflow has a cycle through: a → b — remove an edge so it can run in order.");
  });

  it("a longer cycle names every node ON it, PLUS the tail stranded behind it, and no free node", () => {
    // a→b→c→a is the cycle; d hangs off c and never gets its in-degree
    // decremented, so Rust's "still has in-degree" filter names it too even
    // though d is not itself on the cycle. `free` is untouched and must not
    // appear. rustc on the transcription: `Err(["a", "d", "c", "b"])` — the
    // same SET, in HashMap order.
    const def = parse({
      nodes: [
        { id: "a", kind: "transform", op: "trim" },
        { id: "b", kind: "transform", op: "trim" },
        { id: "c", kind: "transform", op: "trim" },
        { id: "d", kind: "transform", op: "trim" },
        { id: "free", kind: "transform", op: "trim" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "a" },
        { from: "c", to: "d" },
      ],
    });
    const topo = topoOrder(def);
    expect(topo.ok).toBe(false);
    if (topo.ok) throw new Error("unreachable");
    expect(topo.cycle.slice().sort()).toEqual(["a", "b", "c", "d"]);
    expect(topo.cycle, "declared order, and `free` sorted out of the graph cleanly").toEqual(["a", "b", "c", "d"]);

    const r = validateDefinition(def);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors).toContain("The workflow has a cycle through: a → b → c → d — remove an edge so it can run in order.");
    expect(r.errors.some((e) => e.includes("free"))).toBe(false);
  });

  it("a self-edge DOES count as 'something upstream', so the condition's no-input rule stays quiet", () => {
    // `has_incoming` only requires both endpoints to be known ids — a self-edge
    // satisfies that. The def is refused for being a cycle (and for leaving a
    // condition unlabelled on save), never for having nothing to read.
    const def = parse({
      nodes: [{ id: "c", kind: "condition", op: "is_empty" }],
      edges: [{ from: "c", to: "c" }],
    });
    const r = validateDefinition(def);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors.some((e) => e.includes("nothing runs before it"))).toBe(false);
    expect(r.errors).toEqual([
      "Edge c→c leaves a condition without saying which outcome it follows — set its branch to 'then' or 'else'.",
      "The workflow has a cycle through: c — remove an edge so it can run in order.",
    ]);
  });
});

describe("adversarial: route labels, cleaning, and edge matching", () => {
  it("compile's re-clean really runs: padded labels trim, a blank one is dropped, the matched edge survives", () => {
    const def = parse({
      nodes: [
        { id: "r", kind: "route", prompt: "which?", labels: ["\turgent \n", "  ", " normal"] },
        { id: "hot", kind: "transform", op: "append", value: "!" },
        { id: "cool", kind: "transform", op: "append", value: "?" },
      ],
      edges: [
        { from: "r", to: "hot", branch: "urgent" },
        { from: "r", to: "cool", branch: "normal" },
      ],
    });
    expect(validateDefinition(def), "the edges match the TRIMMED labels, so this saves").toEqual({ ok: true });

    const compiled = compileWorkflow(def, null, []);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error("unreachable");
    const routeNode = paramsOf(stepFor(compiled.steps, "r")).node;
    if (routeNode.kind !== "route") throw new Error("fixture");
    // The blank label is GONE, not blanked — `labels.retain(|l| !l.is_empty())`.
    expect(routeNode.labels).toEqual(["urgent", "normal"]);
    // …and each handler's incoming edge still carries the branch string that
    // now matches a label the runtime will actually emit.
    expect(paramsOf(stepFor(compiled.steps, "hot")).incoming).toEqual([
      { parent: stepFor(compiled.steps, "r").id, branch: "urgent" },
    ]);
    expect(paramsOf(stepFor(compiled.steps, "cool")).incoming).toEqual([
      { parent: stepFor(compiled.steps, "r").id, branch: "normal" },
    ]);
    // The caller's own def is untouched — Rust clones the node before mutating.
    const source = def.nodes[0]!;
    if (source.kind !== "route") throw new Error("fixture");
    expect(source.labels).toEqual(["\turgent \n", "  ", " normal"]);
  });

  it("an edge branch carrying the UNTRIMMED label is refused — the check is against the cleaned list", () => {
    const def = parse({
      nodes: [
        { id: "r", kind: "route", labels: [" urgent ", "normal"] },
        { id: "g", kind: "generate", prompt: "x" },
      ],
      edges: [{ from: "r", to: "g", branch: " urgent " }],
    });
    const r = validateDefinition(def);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors).toEqual(["Edge r→g has branch ' urgent ', but route 'r' has no such label."]);
    // Structural, so it blocks a RUN too — this is exactly the mismatch the
    // compile-time re-clean exists to prevent, and it must never reach a job.
    expect(validateRunnable(def).ok).toBe(false);
  });

  it("a route whose labels ALL blank out is refused at both gates", () => {
    const def = parse({ nodes: [{ id: "r", kind: "route", labels: ["  ", "\t", ""] }], edges: [] });
    expect(validateDefinition(def).ok).toBe(false);
    expect(validateRunnable(def).ok).toBe(false);
    const r = validateDefinition(def);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors).toEqual(["Node 'r' (route) needs at least two labels to route between."]);
  });

  it("a route that FAILS its own two-label rule still registers its labels for edge legality", () => {
    // `route_labels.insert` runs after the error push, not instead of it — so a
    // one-label route's edge is checked against that one label, and only the
    // label rule fires.
    const matching = parse({
      nodes: [
        { id: "r", kind: "route", labels: ["only"] },
        { id: "g", kind: "generate", prompt: "x" },
      ],
      edges: [{ from: "r", to: "g", branch: "only" }],
    });
    const m = validateDefinition(matching);
    if (m.ok) throw new Error("unreachable");
    expect(m.errors).toEqual(["Node 'r' (route) needs at least two labels to route between."]);

    const mismatching = parse({
      nodes: [
        { id: "r", kind: "route", labels: ["only"] },
        { id: "g", kind: "generate", prompt: "x" },
      ],
      edges: [{ from: "r", to: "g", branch: "other" }],
    });
    const mm = validateDefinition(mismatching);
    if (mm.ok) throw new Error("unreachable");
    expect(mm.errors).toEqual([
      "Node 'r' (route) needs at least two labels to route between.",
      "Edge r→g has branch 'other', but route 'r' has no such label.",
    ]);
  });
});

describe("adversarial: illegal branch labels", () => {
  it("'then' off a ROUTE and a route label off a CONDITION are both refused, at both gates", () => {
    const thenOffRoute = parse({
      nodes: [
        { id: "r", kind: "route", labels: ["a", "b"] },
        { id: "g", kind: "generate", prompt: "x" },
      ],
      edges: [{ from: "r", to: "g", branch: "then" }],
    });
    const t = validateDefinition(thenOffRoute);
    if (t.ok) throw new Error("unreachable");
    expect(t.errors).toEqual(["Edge r→g has branch 'then', but route 'r' has no such label."]);
    expect(validateRunnable(thenOffRoute).ok).toBe(false);

    const labelOffCondition = parse({
      nodes: [
        { id: "c", kind: "condition", op: "new_files_since_last_run" },
        { id: "g", kind: "generate", prompt: "x" },
      ],
      edges: [{ from: "c", to: "g", branch: "a" }],
    });
    const l = validateDefinition(labelOffCondition);
    if (l.ok) throw new Error("unreachable");
    expect(l.errors).toEqual(["Edge c→g has branch 'a' — a condition only branches 'then' or 'else'."]);
    expect(validateRunnable(labelOffCondition).ok).toBe(false);
  });

  it("a branch on an edge from a node that does not exist reports BOTH problems", () => {
    // `from_condition`/`from_route` are both false for an unknown id, so the
    // dangling-ref sentence and the not-a-branch-source sentence stack.
    const def = parse({
      nodes: [{ id: "g", kind: "generate", prompt: "x" }],
      edges: [{ from: "ghost", to: "g", branch: "then" }],
    });
    const r = validateDefinition(def);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors).toEqual([
      "An edge starts from unknown node 'ghost'.",
      "Edge ghost→g has a branch, but 'ghost' is not a condition or route node.",
    ]);
  });
});

describe("adversarial: dangling edges and how ids are matched", () => {
  it("each endpoint is reported on its own, in edge order, at both gates", () => {
    const def = parse({
      nodes: [{ id: "a", kind: "transform", op: "trim" }],
      edges: [
        { from: "ghost", to: "a" },
        { from: "a", to: "phantom" },
        { from: "ghost", to: "phantom" },
      ],
    });
    const r = validateDefinition(def);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors).toEqual([
      "An edge starts from unknown node 'ghost'.",
      "An edge points to unknown node 'phantom'.",
      "An edge starts from unknown node 'ghost'.",
      "An edge points to unknown node 'phantom'.",
    ]);
    expect(validateRunnable(def).ok, "a def with an edge to nowhere can never run").toBe(false);
    // …and the topo sort ignores all three rather than deadlocking on them.
    expect(topoOrder(def)).toEqual({ ok: true, order: ["a"] });
  });

  it("a node id is matched RAW — a padded id makes an edge that names the trimmed form dangle", () => {
    // `n.id.trim()` decides only EMPTINESS; `ids.insert(n.id)` stores the id
    // verbatim, so " a " and "a" are different nodes.
    const def = parse({
      nodes: [
        { id: " a ", kind: "transform", op: "trim" },
        { id: "b", kind: "transform", op: "trim" },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    const r = validateDefinition(def);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors).toEqual(["An edge starts from unknown node 'a'."]);
  });

  it("an edge OUT of an empty-id node is dangling, so it is not 'something upstream' either", () => {
    // An empty id is never inserted into `ids`, so every edge touching it is a
    // dangling ref — which is exactly why the condition still reports that
    // nothing runs before it.
    const def = parse({
      nodes: [
        { id: "  ", kind: "transform", op: "trim" },
        { id: "c", kind: "condition", op: "is_empty" },
      ],
      edges: [{ from: "  ", to: "c" }],
    });
    const r = validateDefinition(def);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors).toEqual([
      "A node has an empty id — every node needs a unique id.",
      "Node 'c' checks the text coming into it, but nothing runs before it — connect a step to it, or use new_files_since_last_run.",
      "An edge starts from unknown node '  '.",
    ]);
  });
});

describe("adversarial: MAX_NODE_TEXT, field by field", () => {
  /** Every (kind, field) pair `node_text_fields` returns, as a node that is
   * otherwise valid so the cap is the only thing under test. */
  const capped: Array<[string, (text: string) => Record<string, unknown>]> = [
    ["generate.prompt", (t) => ({ id: "n", kind: "generate", prompt: t })],
    ["agent_run.question", (t) => ({ id: "n", kind: "agent_run", question: t })],
    ["vote.prompt", (t) => ({ id: "n", kind: "vote", prompt: t })],
    ["route.prompt", (t) => ({ id: "n", kind: "route", prompt: t, labels: ["a", "b"] })],
    ["refine.prompt", (t) => ({ id: "n", kind: "refine", prompt: t })],
    ["refine.rubric", (t) => ({ id: "n", kind: "refine", prompt: "p", rubric: t })],
    ["plan_and_map.objective", (t) => ({ id: "n", kind: "plan_and_map", objective: t })],
    ["file_pass.instruction", (t) => ({ id: "n", kind: "file_pass", select: { type: "newest" }, instruction: t })],
    [
      "for_each_file.instruction",
      (t) => ({ id: "n", kind: "for_each_file", select: { type: "newest" }, instruction: t }),
    ],
  ];

  it("exactly AT the cap saves; one code point over does not — for every capped field", () => {
    for (const [name, build] of capped) {
      const atLimit = parse({ nodes: [build("x".repeat(MAX_NODE_TEXT))], edges: [] });
      expect(validateDefinition(atLimit), `${name}: ${MAX_NODE_TEXT} is allowed (the check is > , not >=)`).toEqual({
        ok: true,
      });
      const over = parse({ nodes: [build("x".repeat(MAX_NODE_TEXT + 1))], edges: [] });
      const r = validateDefinition(over);
      expect(r.ok, `${name}: one over must be refused`).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.errors).toEqual([`Node 'n' has instructions longer than ${MAX_NODE_TEXT} characters — shorten them.`]);
      // Grandfathered: a workflow saved before the cap existed still starts.
      expect(validateRunnable(over).ok, `${name}: the cap is SAVE-only`).toBe(true);
    }
  });

  it("refine reports ONE sentence even when prompt AND rubric are both over — the loop breaks", () => {
    const both = parse({
      nodes: [{ id: "n", kind: "refine", prompt: "x".repeat(MAX_NODE_TEXT + 1), rubric: "y".repeat(MAX_NODE_TEXT + 1) }],
      edges: [],
    });
    const r = validateDefinition(both);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors).toEqual([`Node 'n' has instructions longer than ${MAX_NODE_TEXT} characters — shorten them.`]);
  });

  it("a field that is NOT free text is uncapped — names, urls, operands, ids and fields are exempt", () => {
    // `node_text_fields` is deliberately "templates only — never a name, id or
    // op". A cap creeping onto one of these would refuse definitions Rust saves.
    const long = "x".repeat(MAX_NODE_TEXT + 1);
    const exempt: Array<[string, Record<string, unknown>]> = [
      ["save_file.name_template", { id: "n", kind: "save_file", name_template: long }],
      ["http_fetch.url", { id: "n", kind: "http_fetch", url: long }],
      ["transform.value", { id: "n", kind: "transform", op: "append", value: long }],
      ["extract.fields[]", { id: "n", kind: "extract", fields: [long] }],
      ["script_run.file", { id: "n", kind: "script_run", file: long }],
      ["condition.value", { id: "n", kind: "condition", op: "new_files_since_last_run", value: long }],
      ["merge.separator", { id: "n", kind: "merge", separator: long }],
      ["summarize_file.select.pattern", { id: "n", kind: "summarize_file", select: { type: "name_like", pattern: long } }],
    ];
    for (const [name, node] of exempt) {
      expect(validateDefinition(parse({ nodes: [node], edges: [] })), `${name} must stay uncapped`).toEqual({ ok: true });
    }
  });
});

describe("adversarial: the Rigor split under mixed errors", () => {
  it("several grandfathered rules broken at once still start", () => {
    // An over-long prompt, a file_pass over "all", an empty needle with nothing
    // upstream, and an unlabelled condition exit — four SAVE-only rules in one
    // def. Saving reports all of them; starting reports none.
    const def = parse({
      nodes: [
        { id: "g", kind: "generate", prompt: "x".repeat(MAX_NODE_TEXT + 1) },
        { id: "p", kind: "file_pass", select: { type: "all" }, instruction: "read it" },
        { id: "c", kind: "condition", op: "contains", value: "  " },
        { id: "h", kind: "generate", prompt: "after" },
      ],
      edges: [{ from: "c", to: "h" }],
    });
    const save = validateDefinition(def);
    expect(save.ok).toBe(false);
    if (save.ok) throw new Error("unreachable");
    expect(save.errors).toEqual([
      `Node 'g' has instructions longer than ${MAX_NODE_TEXT} characters — shorten them.`,
      'Node \'p\' (file_pass) reads ONE file, so "all files" would read only the newest — use a for_each_file step to cover every file, or select newest/name_like/run_input.',
      "Node 'c' checks whether the text contains something but no text was given — type what to look for.",
      "Node 'c' checks the text coming into it, but nothing runs before it — connect a step to it, or use new_files_since_last_run.",
      "Edge c→h leaves a condition without saying which outcome it follows — set its branch to 'then' or 'else'.",
    ]);
    expect(validateRunnable(def)).toEqual({ ok: true });
    expect(compileWorkflow(def, null, []).ok).toBe(true);
  });

  it("one grandfathered + one structural: both gates refuse, but the RUN list carries only the structural one", () => {
    // The distinction is not collapsed in either direction — leniency does not
    // leak onto the structural rule, and strictness does not leak onto the
    // grandfathered one.
    const def = parse({
      nodes: [
        { id: "p", kind: "file_pass", select: { type: "all" }, instruction: "read it" },
        { id: "s", kind: "summarize_file", select: { type: "sideways" } },
      ],
      edges: [],
    });
    const save = validateDefinition(def);
    if (save.ok) throw new Error("unreachable");
    expect(save.errors).toHaveLength(2);

    const run = validateRunnable(def);
    expect(run.ok).toBe(false);
    if (run.ok) throw new Error("unreachable");
    expect(run.errors).toEqual([
      "Node 's' has an unknown file selector 'sideways' — use one of: newest, all, name_like, missing_summary, since_last_run, run_input.",
    ]);
    const compiled = compileWorkflow(def, null, []);
    expect(compiled.ok).toBe(false);
    if (compiled.ok) throw new Error("unreachable");
    expect(compiled.errors).toEqual(run.errors);
  });
});

describe("adversarial: resolveNodeModel across all four choice arms", () => {
  const bothKinds = ["qwen3.5:4b", "minimax-m3:cloud"];
  const localOnly = ["qwen3.5:4b"];
  const cloudOnly = ["minimax-m3:cloud"];

  it("'' and 'auto' take the room's pick when there is one, and bestDefault when there is not", () => {
    for (const choice of ["", "auto", "  ", "\tauto\n"]) {
      expect(resolveNodeModel(choice, "claude-cli::opus", bothKinds), choice).toEqual({
        model: "claude-cli::opus",
        lane: "cloud",
      });
      expect(resolveNodeModel(choice, null, bothKinds), choice).toEqual({ model: "qwen3.5:4b", lane: "local_llm" });
      expect(resolveNodeModel(choice, null, cloudOnly), choice).toEqual({ model: "minimax-m3:cloud", lane: "cloud" });
    }
  });

  it("'local' ignores the room pick entirely, and falls back to the tuned default when nothing local is installed", () => {
    expect(resolveNodeModel("local", "minimax-m3:cloud", bothKinds)).toEqual({ model: "qwen3.5:4b", lane: "local_llm" });
    expect(resolveNodeModel("local", null, cloudOnly), "no local entry to pick").toEqual({
      model: "qwen3.5:4b",
      lane: "local_llm",
    });
    expect(resolveNodeModel("local", null, [])).toEqual({ model: "qwen3.5:4b", lane: "local_llm" });
  });

  it("'cloud' takes the FIRST non-local entry wherever it sits in the list, and bestDefault when there is none", () => {
    expect(resolveNodeModel("cloud", null, bothKinds), "the cloud entry is second").toEqual({
      model: "minimax-m3:cloud",
      lane: "cloud",
    });
    expect(resolveNodeModel("cloud", null, ["minimax-m3:cloud", "glm-5:cloud"]), "first wins").toEqual({
      model: "minimax-m3:cloud",
      lane: "cloud",
    });
    expect(resolveNodeModel("cloud", "qwen3.5:4b", localOnly), "no remote entry → bestDefault, LOCAL lane").toEqual({
      model: "qwen3.5:4b",
      lane: "local_llm",
    });
  });

  it("a literal is honored verbatim (trimmed), whatever is or is not installed", () => {
    expect(resolveNodeModel("llama9:70b", "qwen3.5:4b", bothKinds)).toEqual({
      model: "llama9:70b",
      lane: "local_llm",
    });
    expect(resolveNodeModel("  minimax-m3:cloud  ", null, [])).toEqual({
      model: "minimax-m3:cloud",
      lane: "cloud",
    });
    // "Local"/"Cloud"/"Auto" are NOT the keywords — the match is exact, so a
    // capitalised one is a literal MODEL NAME.
    expect(resolveNodeModel("Local", null, bothKinds)).toEqual({ model: "Local", lane: "local_llm" });
  });

  it("an EMPTY room model is honored verbatim, and compiles to a null params.model on a model node", () => {
    // `room_model.clone().unwrap_or_else(…)` fires only on `None` — `Some("")`
    // passes an empty name straight through, and `compile_workflow`'s
    // `if model.is_empty()` then writes JSON null even for a `generate`.
    expect(resolveNodeModel("auto", "", ["qwen3.5:4b"])).toEqual({ model: "", lane: "local_llm" });
    expect(defaultResolvedModel("", ["qwen3.5:4b"])).toBe("");
    const compiled = compileWorkflow(parse({ nodes: [{ id: "g", kind: "generate", prompt: "p" }], edges: [] }), "", []);
    if (!compiled.ok) throw new Error("unreachable");
    const step = compiled.steps[0]!;
    expect(step.lane).toBe("local_llm");
    expect(paramsOf(step).model).toBeNull();
    // The node's OWN `model` field is untouched by resolution.
    const node = paramsOf(step).node;
    if (node.kind !== "generate") throw new Error("fixture");
    expect(node.model).toBe("");
  });
});

describe("adversarial: compile fidelity on odd graphs", () => {
  it("duplicate edges produce duplicate incoming entries AND duplicate dependsOn — Rust does not dedupe", () => {
    const def = parse({
      nodes: [
        { id: "a", kind: "transform", op: "trim" },
        { id: "b", kind: "transform", op: "trim" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "b" },
      ],
    });
    const compiled = compileWorkflow(def, null, []);
    if (!compiled.ok) throw new Error("unreachable");
    const b = stepFor(compiled.steps, "b");
    expect(paramsOf(b).incoming).toEqual([
      { parent: 0, branch: null },
      { parent: 0, branch: null },
    ]);
    expect(b.dependsOn).toEqual([0, 0]);
  });

  it("incoming follows EDGE-declaration order, not topo order or parent index", () => {
    // join's two edges are declared late-parent-first; the compiled `incoming`
    // must keep that order, because the executor joins parent results in it.
    const def = parse({
      nodes: [
        { id: "x", kind: "transform", op: "append", value: "X" },
        { id: "y", kind: "transform", op: "append", value: "Y" },
        { id: "join", kind: "merge", mode: "concat" },
      ],
      edges: [
        { from: "y", to: "join" },
        { from: "x", to: "join" },
      ],
    });
    const compiled = compileWorkflow(def, null, []);
    if (!compiled.ok) throw new Error("unreachable");
    expect(compiled.steps.map((s) => paramsOf(s).node.id)).toEqual(["x", "y", "join"]);
    expect(paramsOf(stepFor(compiled.steps, "join")).incoming.map((i) => i.parent)).toEqual([1, 0]);
    expect(stepFor(compiled.steps, "join").dependsOn).toEqual([1, 0]);
  });
});

describe("adversarial: the truncate operand, at Rust's exact boundaries", () => {
  const truncate = (value?: string): boolean => {
    const node: Record<string, unknown> = { id: "t", kind: "transform", op: "truncate" };
    if (value !== undefined) node.value = value;
    return validateDefinition(parse({ nodes: [node], edges: [] })).ok;
  };

  it("accepts usize::MAX and a '+'-signed usize::MAX; refuses one past either", () => {
    // rustc: "18446744073709551615" → Ok, "18446744073709551616" → PosOverflow.
    expect(truncate("18446744073709551615")).toBe(true);
    expect(truncate("+18446744073709551615")).toBe(true);
    expect(truncate("18446744073709551616")).toBe(false);
    expect(truncate("+18446744073709551616")).toBe(false);
    // A sign with no digits is InvalidDigit, not zero.
    expect(truncate("+")).toBe(false);
    expect(truncate("-")).toBe(false);
    // Leading zeroes are digits like any other.
    expect(truncate("0000000000000000000000042")).toBe(true);
    // Non-ASCII digits are not digits to `from_str_radix`, which works on bytes.
    expect(truncate("١٢٣")).toBe(false);
    expect(truncate("１２３")).toBe(false);
    // Internal whitespace survives the trim and then fails the parse.
    expect(truncate("1 2")).toBe(false);
  });
});
