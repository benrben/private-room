/**
 * Vitest coverage for `workflowCompose.ts` — this migration's port of
 * `src-tauri/src/commands/jobs/workflow.rs` lines 3596-4427 (`compose_prompt`
 * through the end of `builtin_templates`) plus the earlier helpers
 * `compose_workflow` depends on.
 *
 * TWO STRING ORACLES, BOTH PRODUCED BY `rustc`, NOT BY HAND
 * --------------------------------------------------------
 * {@link EXPECTED_PROMPT} and {@link EXPECTED_TRAILERS} are the captured stdout
 * of standalone Rust programs built from byte-for-byte copies of the real
 * `compose_prompt` and `test_run_trailer` functions, compiled and run with
 * `rustc` against sentinel inputs. The compiler resolved every `format!` escape
 * and every `\`-continuation, so these fixtures cannot carry a transcription
 * error that the implementation happens to share — and they are typed in a
 * DIFFERENT SHAPE from the implementation's own constants (one flat literal
 * here vs. per-line concatenation there) so a slip in either one shows up.
 *
 * That matters concretely: an earlier candidate port of `test_run_trailer`
 * silently paraphrased the tail of the `"paused"` verdict, and its
 * `starts_with("VALIDATED: no")` assertion passed anyway. Every one of the four
 * verdicts is pinned here IN FULL.
 *
 * PORTED RUST TESTS, used as oracles (not copied as production code):
 *   - `compose_prompt_teaches_the_full_palette` (workflow.rs `mod tests`)
 *   - `validate_accepts_a_linear_def_and_the_templates`'s template assertion
 *   - `recover_json_unwraps_fences_think_and_prose` (ollama.rs `mod tests`)
 *   - the spirit of `the_node_reference_agrees_with_the_validator`: the compose
 *     prompt's OWN worked example must pass the real validator.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import { setSetting } from "./db-host/settings.js";
import {
  createWorkflow,
  findWorkflow,
  getSchedule,
  getWorkflow,
  listWorkflows,
} from "./db-host/workflows.js";
import { KEEP_ALIVE_WARM } from "./ollamaModels.js";
import { ROLLBACK_BUSY } from "./turnContext.js";
import {
  CONDITION_OPS,
  FILE_SELECTORS,
  parseWorkflowBinding,
  parseWorkflowDef,
  validateDefinition,
  validateWithBinding,
} from "./workflowModel.js";
import {
  applySchedule,
  backfillNodeLabels,
  builtinTemplates,
  clampTestReport,
  COMPOSE_TEMPERATURE,
  composePrompt,
  composeWorkflow,
  DESCRIBE_WORKFLOW_EMPTY,
  generateOllamaNotImplemented,
  generateTextAnyEngine,
  humanKindLabel,
  OLLAMA_GENERATE_NOT_IMPLEMENTED,
  parseBinding,
  parseDef,
  recoverJson,
  registerWorkflowComposeIpc,
  scheduleFromArgs,
  testRunTrailer,
  validateWorkflowInner,
  workflowTemplates,
  type RoomSource,
} from "./workflowCompose.js";

// ============================================================================
// composePrompt — byte-for-byte against rustc output
// ============================================================================

/** `rustc`'s own stdout for `compose_prompt("TEST_DESCRIPTION_MARKER")`. */
const EXPECTED_PROMPT =
  "You compose an automation workflow for a note-taking app, as JSON only.\n\nOutput ONE JSON object with keys: \"name\" (short), \"emoji\" (one emoji), \"description\" (one sentence), \"definition\", and optionally \"binding\" and \"schedule\". No prose, no code fence — JSON only.\n\n`definition` is a small graph: {\"version\":1,\"nodes\":[...],\"edges\":[...]}. Node kinds and their fields:\n- generate {prompt, model:\"auto\"}\n- summarize_file {select}\n- file_pass {select, instruction, mode}\n- for_each_file {select, instruction, model} — runs the instruction on EACH selected file and joins the results (use instead of file_pass to cover many files)\n- agent_run {question}\n- extract {fields:[\"name\",...]} — pulls named fields out of {{input}} as JSON\n- route {prompt, labels:[\"a\",\"b\",...]} — the model tags {{input}} with ONE label; edges off it use branch:<label> (like condition's then/else, but N-way)\n- vote {prompt, samples:3, mode:\"concat\"|\"majority\"} — runs the prompt N times, aggregates\n- refine {prompt, rubric, max_rounds:2} — generate→critique→revise until it passes\n- plan_and_map {objective, max_workers:4} — splits the objective into subtasks, runs each, synthesizes\n- transform {op, find?, value?} — deterministic text op (append|prepend|replace|upper|lower|trim|truncate|strip_html)\n- merge {mode:\"concat\"|\"dedupe_lines\"|\"numbered\", separator?} — joins parallel branches\n- http_fetch {url} — fetches a web page's text (url may use {{input}})\n- script_run {file, mode:\"import\"|\"transform\"} — runs a .py/.js room script; transform feeds {{input}} on stdin and returns its stdout as a pipe stage\n- save_file {name_template, format:\"html\"|\"md\", mode:\"create\"}\n- condition {op, value}\n`select` is {\"type\":...,\"pattern\"?}. The ONLY valid types: \"newest\" (latest file), \"all\" (every file), \"name_like\" (needs \"pattern\"), \"missing_summary\" (files with no summary yet), \"since_last_run\" (files added since the previous run), \"run_input\" (the file the workflow is invoked on — file binding only). `op` must be one of: contains, not_contains, is_empty, not_empty, new_files_since_last_run.\nEach node needs a unique \"id\", a \"kind\", and a short \"label\" — 2-4 words in the USER'S language describing what THIS step does for them (e.g. \"Find new tickers\", \"Append to dashboard\"), NOT the kind name. edges are [{\"from\",\"to\",\"branch\"?}] (branch \"then\"/\"else\" off a condition, or one of a route's labels off a route; omit branch otherwise). Parallel branches are just several edges out of one node, re-joined by a later node (e.g. a merge). Prompts may use {{input}} (upstream results), {{files}} (the room's file list), {{date}}.\nFor a workflow that runs on the file the user is viewing, set \"binding\":{\"scope\":\"file\",\"kinds\":[\"pdf\"]} and give input-taking nodes \"select\":{\"type\":\"run_input\"}. Otherwise omit binding (general).\nFor a schedule use \"schedule\":{\"kind\":\"daily\",\"param\":\"08:00\"} (kind interval|daily|weekly).\n\nExample: {\"name\":\"Morning digest\",\"emoji\":\"🌅\",\"description\":\"Digest new files each morning.\",\"definition\":{\"version\":1,\"nodes\":[{\"id\":\"gen\",\"kind\":\"generate\",\"label\":\"Write the digest\",\"model\":\"auto\",\"prompt\":\"Digest the files:\\n{{files}}\"},{\"id\":\"save\",\"kind\":\"save_file\",\"label\":\"Save today's digest\",\"name_template\":\"Digest {{date}}\",\"format\":\"html\",\"mode\":\"create\"}],\"edges\":[{\"from\":\"gen\",\"to\":\"save\"}]},\"schedule\":{\"kind\":\"daily\",\"param\":\"08:00\"}}\n\nThe workflow the user wants: TEST_DESCRIPTION_MARKER";

describe("composePrompt", () => {
  it("matches the ACTUAL compiled output of the Rust format! literal, byte for byte", () => {
    expect(composePrompt("TEST_DESCRIPTION_MARKER")).toBe(EXPECTED_PROMPT);
  });

  it("splices the description in verbatim, including quotes, braces and newlines", () => {
    const weird = 'a "quoted" {{input}} description\nwith a newline';
    const prefix = EXPECTED_PROMPT.slice(0, EXPECTED_PROMPT.length - "TEST_DESCRIPTION_MARKER".length);
    expect(composePrompt(weird)).toBe(prefix + weird);
  });

  // Ported from workflow.rs's compose_prompt_teaches_the_full_palette.
  it("teaches the full palette: every file selector and condition op appears", () => {
    const prompt = composePrompt("x");
    for (const sel of FILE_SELECTORS) {
      expect(prompt, `selector '${sel}' missing from compose prompt`).toContain(sel);
    }
    for (const op of CONDITION_OPS) {
      expect(prompt, `condition op '${op}' missing from compose prompt`).toContain(op);
    }
  });

  // The spirit of the_node_reference_agrees_with_the_validator: the worked
  // example the model is shown must survive the validator the model's answer
  // will be judged by, or the prompt teaches a shape we reject.
  it("its own worked example parses and validates for real", () => {
    const prompt = composePrompt("x");
    const marker = "Example: ";
    const idx = prompt.indexOf(marker);
    expect(idx).toBeGreaterThan(-1);
    const exampleJson = prompt.slice(idx + marker.length).split("\n\nThe workflow the user wants:")[0] ?? "";
    const example = JSON.parse(exampleJson) as { definition: unknown; schedule: unknown };
    // Through the REAL parser first, exactly as composeWorkflow does — an
    // omitted `branch` key is only normalized to `null` by the parser, and
    // skipping that step would flag a false "unlabelled edge".
    expect(validateDefinition(parseWorkflowDef(example.definition)).ok).toBe(true);
  });

  it("the example's own schedule is one jobScheduler can actually compute", async () => {
    const prompt = composePrompt("x");
    const exampleJson =
      prompt.slice(prompt.indexOf("Example: ") + "Example: ".length).split("\n\nThe workflow the user wants:")[0] ?? "";
    const example = JSON.parse(exampleJson) as { schedule: { kind: string; param: string } };
    const { nextRunFromNow } = await import("./jobScheduler.js");
    expect(nextRunFromNow(example.schedule.kind, example.schedule.param)).not.toBeNull();
  });
});

// ============================================================================
// recoverJson — oracle: ollama.rs's recover_json_unwraps_fences_think_and_prose
// ============================================================================

describe("recoverJson", () => {
  it.each([
    ['{"markdown":"hi"}', '{"markdown":"hi"}'],
    ['```json\n{"markdown":"hi"}\n```', '{"markdown":"hi"}'],
    ['<think>hmm</think>\n{"a":1}', '{"a":1}'],
    ["```\n[1,2,3]\n```", "[1,2,3]"],
  ])("recovers %j -> %j", (input, expected) => {
    expect(recoverJson(input)).toBe(expected);
  });

  it("returns the trimmed text unchanged when there is no bracket at all", () => {
    expect(recoverJson("  just prose, no json  ")).toBe("just prose, no json");
  });

  it("drops an unterminated <think> span before slicing (everything after it goes)", () => {
    expect(recoverJson('<think>still thinking {"a":1}')).toBe("");
  });

  it("slices to the OUTERMOST bracket pair, dropping prose on both sides", () => {
    expect(recoverJson('Sure! Here you go: {"a":{"b":1}} — hope that helps.')).toBe('{"a":{"b":1}}');
  });
});

// ============================================================================
// generateTextAnyEngine
// ============================================================================

describe("generateTextAnyEngine", () => {
  it("CLI branch: one user message, no options — matching run_external(…, None, None, false)", async () => {
    const runExternalCli = vi.fn().mockResolvedValue({ text: "the answer", usage: null });
    const generateOllama = vi.fn();
    const text = await generateTextAnyEngine("claude-cli", "hello?", { runExternalCli, generateOllama });
    expect(text).toBe("the answer");
    expect(runExternalCli).toHaveBeenCalledWith("claude-cli", [{ role: "user", content: "hello?" }]);
    expect(generateOllama).not.toHaveBeenCalled();
  });

  it("CLI branch recognizes a composite engine string (engine::submodel::effort)", async () => {
    const runExternalCli = vi.fn().mockResolvedValue({ text: "ok", usage: null });
    await generateTextAnyEngine("codex-cli::gpt-5.6-sol::high", "q", { runExternalCli });
    expect(runExternalCli).toHaveBeenCalledWith("codex-cli::gpt-5.6-sol::high", [{ role: "user", content: "q" }]);
  });

  it("CLI branch does NOT strip <think> — Rust only maps strip_think_spans on the ollama arm", async () => {
    const runExternalCli = vi.fn().mockResolvedValue({ text: "<think>x</think>kept", usage: null });
    expect(await generateTextAnyEngine("claude-cli", "q", { runExternalCli })).toBe("<think>x</think>kept");
  });

  it("ollama branch: forwards the messages, temperature and keep-alive the shipped app sends", async () => {
    const generateOllama = vi.fn().mockResolvedValue("<think>reasoning</think>the real answer");
    const text = await generateTextAnyEngine("qwen3.5:4b", "hi", { generateOllama });
    expect(text).toBe("the real answer");
    expect(generateOllama).toHaveBeenCalledWith(
      "qwen3.5:4b",
      [{ role: "user", content: "hi" }],
      COMPOSE_TEMPERATURE,
      KEEP_ALIVE_WARM
    );
    expect(COMPOSE_TEMPERATURE).toBe(0.2);
  });

  it("ollama branch honestly refuses with no injected seam — never a fabricated answer", async () => {
    await expect(generateTextAnyEngine("qwen3.5:4b", "hi")).rejects.toThrow(OLLAMA_GENERATE_NOT_IMPLEMENTED);
  });

  it("the default seam itself rejects with the same honest message, naming ollama::generate", async () => {
    await expect(
      generateOllamaNotImplemented("qwen3.5:4b", [{ role: "user", content: "hi" }], 0.2, "30m")
    ).rejects.toThrow(OLLAMA_GENERATE_NOT_IMPLEMENTED);
    expect(OLLAMA_GENERATE_NOT_IMPLEMENTED).toContain("NOT_IMPLEMENTED:");
    expect(OLLAMA_GENERATE_NOT_IMPLEMENTED).toContain("ollama::generate");
  });
});

// ============================================================================
// humanKindLabel / backfillNodeLabels
// ============================================================================

describe("humanKindLabel", () => {
  it("maps every known kind to its human label", () => {
    expect(humanKindLabel("generate")).toBe("Generate text");
    expect(humanKindLabel("summarize_file")).toBe("Summarize a file");
    expect(humanKindLabel("file_pass")).toBe("Full-file pass");
    expect(humanKindLabel("for_each_file")).toBe("For each file");
    expect(humanKindLabel("agent_run")).toBe("Ask the agent");
    expect(humanKindLabel("extract")).toBe("Extract fields");
    expect(humanKindLabel("route")).toBe("Route by content");
    expect(humanKindLabel("vote")).toBe("Vote / consensus");
    expect(humanKindLabel("refine")).toBe("Refine (critique loop)");
    expect(humanKindLabel("plan_and_map")).toBe("Plan & map");
    expect(humanKindLabel("transform")).toBe("Transform text");
    expect(humanKindLabel("merge")).toBe("Merge branches");
    expect(humanKindLabel("http_fetch")).toBe("Fetch a URL");
    expect(humanKindLabel("script_run")).toBe("Run a script");
    expect(humanKindLabel("save_file")).toBe("Save a file");
    expect(humanKindLabel("condition")).toBe("Condition");
  });

  it("falls back to EVERY underscore replaced with a space for an unknown kind", () => {
    expect(humanKindLabel("some_future_kind")).toBe("some future kind");
    expect(humanKindLabel("")).toBe("");
  });
});

describe("backfillNodeLabels", () => {
  it("fills a blank, whitespace-only, or MISSING label from the node's kind", () => {
    const def = {
      nodes: [
        { id: "a", kind: "generate", label: "" },
        { id: "b", kind: "condition", label: "   " },
        { id: "c", kind: "save_file" },
      ] as Array<Record<string, unknown>>,
    };
    backfillNodeLabels(def);
    expect(def.nodes[0]!.label).toBe("Generate text");
    expect(def.nodes[1]!.label).toBe("Condition");
    expect(def.nodes[2]!.label).toBe("Save a file");
  });

  it("leaves a real label untouched", () => {
    const def = { nodes: [{ id: "a", kind: "generate", label: "Write the digest" }] };
    backfillNodeLabels(def);
    expect(def.nodes[0]!.label).toBe("Write the digest");
  });

  it("no-ops when nodes is missing, not an array, or the value is not an object", () => {
    expect(() => backfillNodeLabels({})).not.toThrow();
    expect(() => backfillNodeLabels({ nodes: "not an array" })).not.toThrow();
    expect(() => backfillNodeLabels("a string")).not.toThrow();
    expect(() => backfillNodeLabels(null)).not.toThrow();
    expect(() => backfillNodeLabels(undefined)).not.toThrow();
  });

  it("skips a non-object entry in nodes rather than throwing", () => {
    const def = { nodes: ["not an object", { id: "a", kind: "generate", label: "" }] };
    expect(() => backfillNodeLabels(def)).not.toThrow();
    expect((def.nodes[1] as Record<string, unknown>).label).toBe("Generate text");
  });

  it("reads `nodes`/`label`/`kind` as OWN keys only, never off a polluted prototype", () => {
    // A model-authored definition can be any JSON; a prototype polluted by some
    // OTHER code must not be able to fake a `label` this then leaves in place.
    const proto = Object.prototype as unknown as Record<string, unknown>;
    proto.label = "INHERITED — must not be seen";
    try {
      const def = { nodes: [{ id: "a", kind: "generate" }] as Array<Record<string, unknown>> };
      backfillNodeLabels(def);
      expect(def.nodes[0]!.label).toBe("Generate text");
    } finally {
      delete proto.label;
    }
  });
});

// ============================================================================
// parseBinding / parseDef
// ============================================================================

describe("parseBinding", () => {
  it("parses a real general and a real file binding", () => {
    expect(parseBinding({ scope: "general" })).toEqual({ scope: "general" });
    expect(parseBinding({ scope: "file", kinds: ["pdf"], exts: [], file_id: null })).toEqual({
      scope: "file",
      kinds: ["pdf"],
      exts: [],
      file_id: null,
    });
  });

  it("defaults to general on absence, JSON null, an unknown scope, or any malformed shape", () => {
    expect(parseBinding(undefined)).toEqual({ scope: "general" });
    expect(parseBinding(null)).toEqual({ scope: "general" });
    expect(parseBinding({ scope: "bogus" })).toEqual({ scope: "general" });
    expect(parseBinding("not an object")).toEqual({ scope: "general" });
    expect(parseBinding(42)).toEqual({ scope: "general" });
  });
});

describe("parseDef", () => {
  it("parses a valid definition", () => {
    const def = parseDef({
      version: 1,
      nodes: [{ id: "a", kind: "generate", prompt: "hi", model: "auto" }],
      edges: [],
    });
    expect(def.nodes).toHaveLength(1);
  });

  it("wraps ANY parse failure in parse_def's exact model-fixable sentence", () => {
    // rustc oracle for the wrapper (the parenthesised detail is serde's, not ours):
    //   "The workflow definition is malformed (PARSE_ERR). Each node needs a
    //    unique id and a valid kind (generate, summarize_file, file_pass,
    //    agent_run, save_file, condition) with its params."
    for (const bad of [{ nodes: [{ id: "a", kind: "not_a_real_kind" }] }, null, 42]) {
      let message = "";
      try {
        parseDef(bad);
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message.startsWith("The workflow definition is malformed (")).toBe(true);
      expect(message.endsWith(
        "). Each node needs a unique id and a valid kind (generate, summarize_file, file_pass, agent_run, save_file, condition) with its params."
      )).toBe(true);
    }
  });
});

// ============================================================================
// scheduleFromArgs
// ============================================================================

describe("scheduleFromArgs", () => {
  it("returns null for a missing, JSON-null, non-object, or kind-less schedule", () => {
    expect(scheduleFromArgs({ name: "x" })).toBeNull();
    expect(scheduleFromArgs({ schedule: null })).toBeNull();
    expect(scheduleFromArgs({ schedule: "daily" })).toBeNull();
    expect(scheduleFromArgs({ schedule: {} })).toBeNull();
    expect(scheduleFromArgs({ schedule: { kind: 5 } })).toBeNull();
    expect(scheduleFromArgs("not an object")).toBeNull();
  });

  it("defaults param to '', enabled and catchUp to true (serde's #[default = \"yes\"])", () => {
    expect(scheduleFromArgs({ schedule: { kind: "daily" } })).toEqual({
      kind: "daily",
      param: "",
      enabled: true,
      catchUp: true,
    });
  });

  it("reads an explicit param/enabled/catchUp", () => {
    expect(
      scheduleFromArgs({ schedule: { kind: "interval", param: "30", enabled: false, catchUp: false } })
    ).toEqual({ kind: "interval", param: "30", enabled: false, catchUp: false });
  });

  it("falls back to snake_case catch_up only when camelCase catchUp is ABSENT", () => {
    expect(scheduleFromArgs({ schedule: { kind: "daily", catch_up: false } })!.catchUp).toBe(false);
  });

  it("a PRESENT but non-boolean catchUp wins over catch_up (Rust's or_else fires on absence only)", () => {
    expect(scheduleFromArgs({ schedule: { kind: "daily", catchUp: "nonsense", catch_up: false } })!.catchUp).toBe(
      true
    );
  });

  it("reads schedule/kind/catch_up as OWN keys only, never off a polluted prototype", () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    proto.schedule = { kind: "daily", param: "03:00" };
    proto.catch_up = false;
    try {
      // No own `schedule` key: Rust's `args.get("schedule")?` answers None.
      expect(scheduleFromArgs({ name: "x" })).toBeNull();
      // Own `schedule`, but no own `catch_up`: the true default, not the
      // inherited false.
      expect(scheduleFromArgs({ schedule: { kind: "daily" } })!.catchUp).toBe(true);
    } finally {
      delete proto.schedule;
      delete proto.catch_up;
    }
  });
});

// ============================================================================
// applySchedule / validateWorkflowInner / composeWorkflow — a real room
// ============================================================================

const GENERAL = { scope: "general" as const };
const linearDef = {
  version: 1,
  nodes: [{ id: "gen", label: "Write", kind: "generate" as const, prompt: "hi", model: "auto" }],
  edges: [],
};
const runInputDef = {
  version: 1,
  nodes: [
    {
      id: "s",
      label: "L",
      kind: "summarize_file" as const,
      select: { type: "run_input", pattern: null },
    },
  ],
  edges: [],
};

/** Every db-backed test opens its own encrypted room and tears it down. */
let tmpDir = "";
let openedDb: Database.Database | null = null;

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "workflow-compose-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  openedDb = createRoom(roomPath, "correct horse battery staple", "Test Room");
  return openedDb;
}

afterEach(() => {
  openedDb?.close();
  openedDb = null;
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  }
});

/** `schedules.workflow_id` is a real FK — the success path needs a row to point at. */
function makeWorkflow(db: Database.Database): string {
  return createWorkflow(db, "Test workflow", "", "✨", linearDef, "test", GENERAL);
}

describe("applySchedule", () => {
  it("clears the schedule when kind is ''", () => {
    const db = freshRoom();
    const id = makeWorkflow(db);
    applySchedule(db, id, linearDef, "daily", "08:00", true, true);
    expect(getSchedule(db, id)).not.toBeNull();
    applySchedule(db, id, linearDef, "", "", true, true);
    expect(getSchedule(db, id)).toBeNull();
  });

  it("refuses to schedule a run_input def", () => {
    const db = freshRoom();
    expect(() => applySchedule(db, "wf1", runInputDef, "daily", "08:00", true, true)).toThrow(
      "This workflow runs on a chosen file — it can't be scheduled."
    );
  });

  it("refuses an invalid schedule spec", () => {
    const db = freshRoom();
    expect(() => applySchedule(db, "wf1", linearDef, "daily", "not-a-time", true, true)).toThrow(
      "That schedule is invalid — check the time or interval."
    );
  });

  it("stores next_run_at when enabled and null when disabled", () => {
    const db = freshRoom();
    const id = makeWorkflow(db);
    applySchedule(db, id, linearDef, "daily", "08:00", true, true);
    expect(getSchedule(db, id)!.nextRunAt).not.toBeNull();
    applySchedule(db, id, linearDef, "daily", "08:00", false, true);
    expect(getSchedule(db, id)!.nextRunAt).toBeNull();
  });
});

describe("validateWorkflowInner", () => {
  it("short-circuits on a binding error WITHOUT reaching for the model list", async () => {
    const db = freshRoom();
    const listModels = vi.fn().mockResolvedValue([]);
    const errs = await validateWorkflowInner(db, runInputDef, GENERAL, { listModels });
    expect(errs.length).toBeGreaterThan(0);
    expect(listModels).not.toHaveBeenCalled();
  });

  it("surfaces the compiler's own errors (a cycle names its nodes)", async () => {
    const db = freshRoom();
    const cyclic = {
      version: 1,
      nodes: [
        { id: "a", label: "A", kind: "generate" as const, prompt: "x", model: "auto" },
        { id: "b", label: "B", kind: "generate" as const, prompt: "x", model: "auto" },
      ],
      edges: [
        { from: "a", to: "b", branch: null },
        { from: "b", to: "a", branch: null },
      ],
    };
    const errs = await validateWorkflowInner(db, cyclic, GENERAL, { listModels: async () => [] });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(" ")).toContain("cycle");
  });

  it("returns no errors for a valid linear def", async () => {
    const db = freshRoom();
    expect(await validateWorkflowInner(db, linearDef, GENERAL, { listModels: async () => [] })).toEqual([]);
  });
});

describe("composeWorkflow", () => {
  const noModels = async (): Promise<string[]> => [];

  it("refuses an empty (or whitespace-only) description without touching db or model", async () => {
    const db = freshRoom();
    const generate = vi.fn();
    await expect(composeWorkflow(db, "   ", { generate })).rejects.toThrow(DESCRIBE_WORKFLOW_EMPTY);
    expect(generate).not.toHaveBeenCalled();
  });

  it("refuses immediately while the room is rolling back", async () => {
    const db = freshRoom();
    const generate = vi.fn();
    await expect(
      composeWorkflow(db, "a workflow", { isRollingBack: () => true, generate })
    ).rejects.toThrow(ROLLBACK_BUSY);
    expect(generate).not.toHaveBeenCalled();
  });

  it("the empty-description refusal wins over the rolling-back one — Rust checks it FIRST", async () => {
    const db = freshRoom();
    await expect(
      composeWorkflow(db, "\t\n  ", { isRollingBack: () => true, generate: vi.fn() })
    ).rejects.toThrow(DESCRIBE_WORKFLOW_EMPTY);
  });

  it("shows the model the TRIMMED description, not the raw one", async () => {
    const db = freshRoom();
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ name: "X", definition: linearDef }));
    await composeWorkflow(db, "  digest my files \n ", { generate, listModels: noModels });
    expect(generate.mock.calls[0]![1]).toBe(composePrompt("digest my files"));
  });

  it("fetches the model list TWICE — once to resolve the model, once inside validate_workflow_inner", async () => {
    const db = freshRoom();
    const listModels = vi.fn().mockResolvedValue([]);
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ name: "X", definition: linearDef }));
    await composeWorkflow(db, "a workflow", { generate, listModels });
    expect(listModels).toHaveBeenCalledTimes(2);
  });

  it("a whitespace-only room model is not a model — it falls through to defaultResolvedModel", async () => {
    const db = freshRoom();
    setSetting(db, "model", "   ");
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ name: "X", definition: linearDef }));
    await composeWorkflow(db, "a workflow", { generate, listModels: noModels });
    expect(generate.mock.calls[0]![0]).not.toBe("   ");
    expect((generate.mock.calls[0]![0] as string).length).toBeGreaterThan(0);
  });

  // The honest seam, exercised the way a real local-model room would hit it: no
  // injected `generate`, so composeWorkflow falls through to the module's own
  // generateTextAnyEngine, whose Ollama branch is NOT_IMPLEMENTED. It must
  // REFUSE — loudly, on the first attempt, with nothing written — rather than
  // no-op into a fabricated or empty draft.
  it("a local-model room refuses honestly on attempt ONE and saves nothing", async () => {
    const db = freshRoom();
    setSetting(db, "model", "qwen3.5:4b");
    await expect(composeWorkflow(db, "digest my files", { listModels: noModels })).rejects.toThrow(
      OLLAMA_GENERATE_NOT_IMPLEMENTED
    );
    expect(listWorkflows(db)).toHaveLength(0);
  });

  it("a generate FAILURE propagates immediately — NOT one of the retryable modes (Rust's `?`)", async () => {
    const db = freshRoom();
    const generate = vi.fn().mockRejectedValue(new Error("engine is down"));
    await expect(composeWorkflow(db, "a workflow", { generate, listModels: noModels })).rejects.toThrow(
      "engine is down"
    );
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("composes and saves a DRAFT on the FIRST attempt when the model answers valid JSON", async () => {
    const db = freshRoom();
    const generate = vi.fn().mockResolvedValue(
      JSON.stringify({
        name: "My workflow",
        emoji: "🌅",
        description: "  A test workflow.  ",
        definition: linearDef,
      })
    );
    const emit = vi.fn();
    const id = await composeWorkflow(db, "digest my files", { generate, listModels: noModels }, emit);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![1]).toBe(composePrompt("digest my files"));
    const saved = getWorkflow(db, id);
    expect(saved.name).toBe("My workflow");
    expect(saved.emoji).toBe("🌅");
    expect(saved.description).toBe("A test workflow.");
    expect(saved.status).toBe("draft");
    expect(saved.createdBy).toBe("agent");
    expect(emit).toHaveBeenCalledWith("workflows-changed", undefined);
  });

  it("stores the BACKFILLED RAW definition, not a round-trip of the parsed struct", async () => {
    const db = freshRoom();
    const generate = vi.fn().mockResolvedValue(
      JSON.stringify({
        name: "Unlabelled",
        definition: { version: 1, nodes: [{ id: "g", kind: "generate", prompt: "hi", model: "auto" }], edges: [] },
      })
    );
    const id = await composeWorkflow(db, "a workflow", { generate, listModels: noModels });
    const stored = findWorkflow(db, id).definition as { nodes: Array<{ label: string }> };
    expect(stored.nodes[0]!.label).toBe("Generate text");
  });

  it("retries ONCE with the previous error folded into the prompt, then succeeds", async () => {
    const db = freshRoom();
    const generate = vi
      .fn()
      .mockResolvedValueOnce("not json at all")
      .mockResolvedValueOnce(JSON.stringify({ name: "Fixed", definition: linearDef }));
    const id = await composeWorkflow(db, "digest my files", { generate, listModels: noModels });
    expect(generate).toHaveBeenCalledTimes(2);
    const second = generate.mock.calls[1]![1] as string;
    expect(second.startsWith(composePrompt("digest my files"))).toBe(true);
    expect(second).toContain("\n\nYour previous attempt was rejected: output was not valid JSON");
    expect(second.endsWith("\nReturn corrected JSON only.")).toBe(true);
    expect(getWorkflow(db, id).name).toBe("Fixed");
  });

  it("retries with 'the JSON had no `definition` object' when the key is absent", async () => {
    const db = freshRoom();
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ name: "x" }));
    await expect(composeWorkflow(db, "a workflow", { generate, listModels: noModels })).rejects.toThrow(
      "Couldn't compose a valid workflow"
    );
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]![1] as string).toContain("the JSON had no `definition` object");
  });

  it("treats a JSON-null definition as PRESENT and lets parse_def reject it (Rust's Some(Null))", async () => {
    const db = freshRoom();
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ name: "x", definition: null }));
    await expect(composeWorkflow(db, "a workflow", { generate, listModels: noModels })).rejects.toThrow(
      "Couldn't compose a valid workflow"
    );
    const second = generate.mock.calls[1]![1] as string;
    expect(second).toContain("The workflow definition is malformed");
    expect(second).not.toContain("the JSON had no `definition` object");
  });

  it("retries on a validation failure, joining the errors with '; '", async () => {
    const db = freshRoom();
    const generate = vi.fn().mockResolvedValue(
      JSON.stringify({ name: "x", definition: { version: 1, nodes: [], edges: [] } })
    );
    await expect(composeWorkflow(db, "a workflow", { generate, listModels: noModels })).rejects.toThrow(
      "Couldn't compose a valid workflow"
    );
    expect(generate.mock.calls[1]![1] as string).toContain("Your previous attempt was rejected:");
  });

  /** Parses cleanly through `parse_def`, then fails `validate_with_binding`
   * TWICE over — so the retry feedback has to carry a `"; "`-joined list. */
  const twoValidationErrors = {
    version: 1,
    nodes: [
      { id: "a", label: "A", kind: "generate" as const, prompt: "x", model: "auto" },
      { id: "a", label: "A again", kind: "generate" as const, prompt: "x", model: "auto" },
    ],
    edges: [{ from: "a", to: "nowhere", branch: null }],
  };

  it("a validation failure is a RETRY case: the numbered errors go back verbatim and the retry can win", async () => {
    const db = freshRoom();
    const generate = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ name: "bad", definition: twoValidationErrors }))
      .mockResolvedValueOnce(JSON.stringify({ name: "good", definition: linearDef }));
    const id = await composeWorkflow(db, "a workflow", { generate, listModels: noModels });
    const second = generate.mock.calls[1]![1] as string;
    expect(second).toContain(
      "Your previous attempt was rejected: Duplicate node id 'a' — ids must be unique.; " +
        "An edge points to unknown node 'nowhere'.\nReturn corrected JSON only."
    );
    // A validation failure is NOT a malformed-definition failure — the two arms
    // set different `last_err`s and must not be conflated.
    expect(second).not.toContain("The workflow definition is malformed");
    expect(getWorkflow(db, id).name).toBe("good");
  });

  it("an unparseable definition (unknown kind) is likewise a RETRY case, not a throw", async () => {
    const db = freshRoom();
    const generate = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          definition: { version: 1, nodes: [{ id: "a", kind: "no_such_kind" }], edges: [] },
        })
      )
      .mockResolvedValueOnce(JSON.stringify({ name: "recovered", definition: linearDef }));
    const id = await composeWorkflow(db, "a workflow", { generate, listModels: noModels });
    expect(generate.mock.calls[1]![1] as string).toContain("The workflow definition is malformed");
    expect(getWorkflow(db, id).name).toBe("recovered");
  });

  it("the retry prompt carries EXACTLY ONE rejection preamble — feedback never compounds", async () => {
    const db = freshRoom();
    const generate = vi.fn().mockResolvedValue("not json");
    await expect(composeWorkflow(db, "a workflow", { generate, listModels: noModels })).rejects.toThrow(
      "Couldn't compose"
    );
    const second = generate.mock.calls[1]![1] as string;
    expect(second.split("Your previous attempt was rejected:")).toHaveLength(2);
    expect(second.split("Return corrected JSON only.")).toHaveLength(2);
  });

  it("the give-up sentence quotes the SECOND attempt's error, not the first's", async () => {
    const db = freshRoom();
    const generate = vi
      .fn()
      .mockResolvedValueOnce("not json at all")
      .mockResolvedValueOnce(JSON.stringify({ name: "x", definition: twoValidationErrors }));
    await expect(composeWorkflow(db, "a workflow", { generate, listModels: noModels })).rejects.toThrow(
      "Couldn't compose a valid workflow (Duplicate node id 'a' — ids must be unique.; " +
        "An edge points to unknown node 'nowhere'.). Try describing it more specifically."
    );
    expect(listWorkflows(db)).toHaveLength(0);
  });

  // `serde_json::Value::get(&str)` answers None for an array, a string, a
  // number, a bool and null alike — every one of them lands on the SAME
  // "no definition" retry arm rather than throwing on a property read.
  it.each(["[1,2,3]", "5", '"a string"', "null", "true"])(
    "a top-level %s takes the no-definition arm rather than crashing",
    async (answer) => {
      const db = freshRoom();
      const generate = vi.fn().mockResolvedValue(answer);
      await expect(composeWorkflow(db, "a workflow", { generate, listModels: noModels })).rejects.toThrow(
        "Couldn't compose a valid workflow (the JSON had no `definition` object)."
      );
      expect(generate).toHaveBeenCalledTimes(2);
    }
  );

  it("an apply_schedule failure propagates (Rust's `?`) — no retry, and the created row stays", async () => {
    const db = freshRoom();
    const generate = vi.fn().mockResolvedValue(
      JSON.stringify({
        name: "On this file",
        definition: runInputDef,
        binding: { scope: "file", kinds: ["pdf"], exts: [], file_id: null },
        schedule: { kind: "daily", param: "08:00" },
      })
    );
    await expect(composeWorkflow(db, "a workflow", { generate, listModels: noModels })).rejects.toThrow(
      "This workflow runs on a chosen file — it can't be scheduled."
    );
    expect(generate).toHaveBeenCalledTimes(1);
    expect(listWorkflows(db)).toHaveLength(1);
  });

  // Rule: `serde_json::Map::get` is OWN-KEY. Every field composeWorkflow reads
  // off the model's JSON — definition, name, emoji, description, binding,
  // schedule — must be invisible when it lives only on a polluted
  // `Object.prototype`. (`__proto__` pollution has been a real bug in this
  // codebase four times; these two tests pin the whole read surface at once.)
  it("a polluted Object.prototype cannot supply the `definition` the model never sent", async () => {
    const db = freshRoom();
    const proto = Object.prototype as unknown as Record<string, unknown>;
    proto.definition = linearDef;
    try {
      const generate = vi.fn().mockResolvedValue("{}");
      await expect(composeWorkflow(db, "a workflow", { generate, listModels: noModels })).rejects.toThrow(
        "the JSON had no `definition` object"
      );
      expect(listWorkflows(db)).toHaveLength(0);
    } finally {
      delete proto.definition;
    }
  });

  it("nor an inherited name / emoji / description / binding / schedule", async () => {
    const db = freshRoom();
    const proto = Object.prototype as unknown as Record<string, unknown>;
    proto.name = "INHERITED NAME";
    proto.emoji = "💀";
    proto.description = "INHERITED DESCRIPTION";
    proto.binding = { scope: "file", kinds: ["pdf"], exts: [], file_id: null };
    proto.schedule = { kind: "daily", param: "03:00" };
    try {
      const generate = vi.fn().mockResolvedValue(JSON.stringify({ definition: linearDef }));
      const id = await composeWorkflow(db, "a workflow", { generate, listModels: noModels });
      const saved = findWorkflow(db, id);
      expect(saved.name).toBe("New workflow");
      expect(saved.emoji).toBe("✨");
      expect(saved.description).toBe("");
      expect(saved.binding).toEqual({ scope: "general" });
      expect(getSchedule(db, id)).toBeNull();
    } finally {
      for (const k of ["name", "emoji", "description", "binding", "schedule"]) {
        delete proto[k];
      }
    }
  });

  it("gives up after exactly two attempts with the corrective, honest sentence", async () => {
    const db = freshRoom();
    const generate = vi.fn().mockResolvedValue("still not json");
    await expect(composeWorkflow(db, "digest my files", { generate, listModels: noModels })).rejects.toThrow(
      /^Couldn't compose a valid workflow \(output was not valid JSON .*\)\. Try describing it more specifically\.$/s
    );
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("recovers a fenced / <think>-wrapped reply through recoverJson before parsing", async () => {
    const db = freshRoom();
    const wrapped =
      "<think>let me think</think>```json\n" + JSON.stringify({ name: "Fenced", definition: linearDef }) + "\n```";
    const id = await composeWorkflow(db, "a workflow", {
      generate: vi.fn().mockResolvedValue(wrapped),
      listModels: noModels,
    });
    expect(getWorkflow(db, id).name).toBe("Fenced");
  });

  it("uses the room's own model setting when set, and defaultResolvedModel otherwise", async () => {
    const db = freshRoom();
    const good = JSON.stringify({ name: "X", definition: linearDef });
    const withoutSetting = vi.fn().mockResolvedValue(good);
    await composeWorkflow(db, "a workflow", { generate: withoutSetting, listModels: noModels });
    const fallbackModel = withoutSetting.mock.calls[0]![0] as string;
    expect(fallbackModel.length).toBeGreaterThan(0);

    setSetting(db, "model", "claude-cli::opus");
    const withSetting = vi.fn().mockResolvedValue(good);
    await composeWorkflow(db, "a workflow", { generate: withSetting, listModels: noModels });
    expect(withSetting.mock.calls[0]![0]).toBe("claude-cli::opus");
  });

  it("applies a schedule from the model's own JSON when it carries one", async () => {
    const db = freshRoom();
    const generate = vi.fn().mockResolvedValue(
      JSON.stringify({ name: "Scheduled", definition: linearDef, schedule: { kind: "daily", param: "09:00" } })
    );
    const id = await composeWorkflow(db, "a workflow", { generate, listModels: noModels });
    const sched = getSchedule(db, id);
    expect(sched!.kind).toBe("daily");
    expect(sched!.param).toBe("09:00");
  });

  it("falls back to 'New workflow' / ✨ / '' when name, emoji and description are blank or missing", async () => {
    const db = freshRoom();
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ name: "  ", emoji: "", definition: linearDef }));
    const id = await composeWorkflow(db, "a workflow", { generate, listModels: noModels });
    const saved = getWorkflow(db, id);
    expect(saved.name).toBe("New workflow");
    expect(saved.emoji).toBe("✨");
    expect(saved.description).toBe("");
  });

  it("stores a file binding the model asked for, rather than silently generalizing it", async () => {
    const db = freshRoom();
    const generate = vi.fn().mockResolvedValue(
      JSON.stringify({
        name: "On this file",
        definition: runInputDef,
        binding: { scope: "file", kinds: ["pdf"], exts: [], file_id: null },
      })
    );
    const id = await composeWorkflow(db, "a workflow", { generate, listModels: noModels });
    expect(findWorkflow(db, id).binding).toEqual({ scope: "file", kinds: ["pdf"], exts: [], file_id: null });
  });

  it("a failed emit never turns a successful compose into a failure", async () => {
    const db = freshRoom();
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ name: "X", definition: linearDef }));
    const emit = vi.fn(() => {
      throw new Error("no window");
    });
    await expect(
      composeWorkflow(db, "a workflow", { generate, listModels: noModels }, emit)
    ).resolves.toBeTypeOf("string");
  });
});

// ============================================================================
// registerWorkflowComposeIpc
// ============================================================================

describe("registerWorkflowComposeIpc", () => {
  function fakeIpc() {
    const handlers = new Map<string, (event: unknown, ...args: never[]) => unknown>();
    return {
      handlers,
      handle(channel: string, fn: (event: unknown, ...args: never[]) => unknown) {
        handlers.set(channel, fn);
      },
    };
  }

  it("registers the exact channel names src/api.ts already invokes", () => {
    const ipc = fakeIpc();
    registerWorkflowComposeIpc(ipc as never, { currentRoom: () => null });
    expect([...ipc.handlers.keys()].sort()).toEqual(["compose_workflow", "workflow_templates"]);
  });

  it("workflow_templates answers without a room open", async () => {
    const ipc = fakeIpc();
    registerWorkflowComposeIpc(ipc as never, { currentRoom: () => null });
    const out = await ipc.handlers.get("workflow_templates")!({} as never);
    expect(out).toEqual(workflowTemplates());
  });

  it("compose_workflow refuses when no room is open", async () => {
    const ipc = fakeIpc();
    registerWorkflowComposeIpc(ipc as never, { currentRoom: () => null });
    const handler = ipc.handlers.get("compose_workflow")!;
    await expect(
      Promise.resolve().then(() => handler({} as never, { description: "x" } as never))
    ).rejects.toThrow("No room is open.");
  });

  it("compose_workflow resolves the room PER CALL and forwards the description", async () => {
    const db = freshRoom();
    const room: RoomSource = { currentRoom: () => ({ db, path: "/tmp/x.roomai" }) };
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ name: "Via IPC", definition: linearDef }));
    const ipc = fakeIpc();
    registerWorkflowComposeIpc(ipc as never, room, { generate, listModels: async () => [] });
    const id = (await ipc.handlers.get("compose_workflow")!({} as never, {
      description: "digest my files",
    } as never)) as string;
    expect(getWorkflow(db, id).name).toBe("Via IPC");
    expect(generate.mock.calls[0]![1]).toBe(composePrompt("digest my files"));
  });
});

// ============================================================================
// testRunTrailer / clampTestReport
// ============================================================================

/** `rustc`'s own stdout for `test_run_trailer(status)`, all four arms, IN FULL —
 * a prefix-only assertion cannot see a drifted tail. */
const EXPECTED_TRAILERS: Record<string, string> = {
  done: "VALIDATED: yes — every step ran to completion. You may now tell the user this works and the draft is ready to review & activate.",
  paused:
    "VALIDATED: no — the run parked before finishing (the PAUSED line above says why), so it did NOT validate the workflow. Do NOT say it's fixed or works, and do NOT start editing steps. If a script needs approving, tell the user to review and run it on the Scripts page; a script can only be confirmed by an approved run.",
  timeout:
    "VALIDATED: unknown — nothing failed; the run was still going when the wait ended. Do NOT call it broken and do NOT start fixing steps. Tell the user it is still running and they can watch it finish on the Workflows page.",
  error:
    "VALIDATED: no — this run did not succeed. Fix the failing step with update_workflow and test again. Do NOT tell the user it's fixed or ready until a test_workflow returns VALIDATED: yes.",
};

describe("testRunTrailer", () => {
  it.each(Object.keys(EXPECTED_TRAILERS))("the %s verdict matches rustc's output in full", (status) => {
    expect(testRunTrailer(status)).toBe(EXPECTED_TRAILERS[status]);
  });

  it("any unknown status takes the same catch-all arm as 'error'", () => {
    expect(testRunTrailer("anything-else")).toBe(EXPECTED_TRAILERS.error);
    expect(testRunTrailer("")).toBe(EXPECTED_TRAILERS.error);
  });

  // Oracle: workflow.rs's a_timed_out_test_run_is_unknown_not_failed.
  it("a timeout reads as UNKNOWN, never as a failure to go and fix", () => {
    const timeout = testRunTrailer("timeout");
    expect(timeout.startsWith("VALIDATED: unknown")).toBe(true);
    expect(timeout).toContain("nothing failed");
    expect(timeout).not.toContain("did not succeed");
    expect(timeout).not.toContain("Fix the failing step");
  });
});

describe("clampTestReport", () => {
  it("passes a short report through untouched", () => {
    expect(clampTestReport("short report")).toBe("short report");
  });

  it("passes a report of EXACTLY the byte cap through untouched", () => {
    const exact = "x".repeat(6000);
    expect(clampTestReport(exact)).toBe(exact);
  });

  it("truncates a long ASCII report at the byte budget", () => {
    const clamped = clampTestReport("x".repeat(7000));
    const suffix = "…\n(report truncated)";
    expect(clamped.endsWith(suffix)).toBe(true);
    const body = clamped.slice(0, clamped.length - suffix.length);
    expect(Buffer.byteLength(body, "utf8")).toBe(6000);
  });

  it("counts UTF-8 BYTES, not UTF-16 code units — a 3-byte-per-char report clamps early", () => {
    // 2100 × "€" = 6300 UTF-8 bytes but only 2100 code units: a `.length`-based
    // budget would not have truncated this at all.
    const clamped = clampTestReport("€".repeat(2100));
    const body = clamped.slice(0, clamped.length - "…\n(report truncated)".length);
    expect(body.length).toBeLessThan(2100);
    expect([...body].every((ch) => ch === "€")).toBe(true);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(6000);
  });

  it("never splits a 4-byte character (a surrogate pair) in half", () => {
    const clamped = clampTestReport("🌅".repeat(1600));
    const body = clamped.slice(0, clamped.length - "…\n(report truncated)".length);
    expect(body).not.toContain("�");
    expect(body.length % 2).toBe(0);
    for (let i = 0; i < body.length; i += 2) {
      expect(body.slice(i, i + 2)).toBe("🌅");
    }
  });
});

// ============================================================================
// builtinTemplates
// ============================================================================

describe("builtinTemplates", () => {
  it("returns SEVEN templates — the Rust doc comment says four, the source defines seven", () => {
    expect(builtinTemplates()).toHaveLength(7);
  });

  it("has the expected names, in the source's own order", () => {
    expect(builtinTemplates().map((t) => t.name)).toEqual([
      "Morning digest",
      "New-file summarizer",
      "Weekly review",
      "Deep read",
      "Compare perspectives",
      "Summarize every file",
      "Triage the newest note",
    ]);
  });

  // Oracle: workflow.rs's validate_accepts_a_linear_def_and_the_templates.
  it("every template parses and validates for real against workflowModel.ts", () => {
    for (const t of builtinTemplates()) {
      const def = parseWorkflowDef(t.definition);
      const binding = parseWorkflowBinding(t.binding);
      const result = validateWithBinding(def, binding);
      expect(result.ok, `"${t.name}" does not validate: ${JSON.stringify(!result.ok ? result.errors : [])}`).toBe(
        true
      );
    }
  });

  it("every scheduled template's schedule computes a real next run", async () => {
    const { nextRunFromNow } = await import("./jobScheduler.js");
    const scheduled = builtinTemplates().filter((t) => t.schedule !== undefined);
    expect(scheduled).toHaveLength(3);
    for (const t of scheduled) {
      expect(
        nextRunFromNow(t.schedule!.kind, t.schedule!.param),
        `"${t.name}"'s ${t.schedule!.kind}/${t.schedule!.param} does not compute a next run`
      ).not.toBeNull();
    }
  });

  it("every template survives a real save through createWorkflow + applySchedule", () => {
    const db = freshRoom();
    for (const t of builtinTemplates()) {
      const id = createWorkflow(db, t.name, t.description, t.emoji, t.definition, "user", t.binding);
      if (t.schedule !== undefined) {
        const def = parseWorkflowDef(t.definition);
        applySchedule(db, id, def, t.schedule.kind, t.schedule.param, t.schedule.enabled, t.schedule.catchUp);
        expect(getSchedule(db, id)!.kind).toBe(t.schedule.kind);
      }
      expect(findWorkflow(db, id).status).toBe("draft");
    }
  });

  it("workflowTemplates() is the command-level alias of builtinTemplates()", () => {
    expect(workflowTemplates()).toEqual(builtinTemplates());
  });
});

// ============================================================================
// The CLI branch's DEFAULT wiring
//
// Every other generateTextAnyEngine test INJECTS runExternalCli, so a default
// that was never wired (or was shadowed by a circular import) would pass all of
// them. This one mocks the module boundary instead and calls with NO deps, so
// it fails if the real `externalAdvisor.runExternalCli` is not what the default
// reaches. It lives LAST in the file because `vi.resetModules()` re-instantiates
// the module graph for every dynamic import after it.
// ============================================================================

describe("generateTextAnyEngine's default CLI seam", () => {
  it("with no injected deps a CLI model reaches externalAdvisor.runExternalCli for real", async () => {
    vi.resetModules();
    const runExternalCli = vi.fn().mockResolvedValue({ text: "from the CLI", usage: null });
    vi.doMock("./externalAdvisor.js", async () => {
      const real = await vi.importActual<typeof import("./externalAdvisor.js")>("./externalAdvisor.js");
      return { ...real, runExternalCli };
    });
    try {
      const mod = await import("./workflowCompose.js");
      expect(await mod.generateTextAnyEngine("claude-cli", "hello?")).toBe("from the CLI");
      expect(runExternalCli).toHaveBeenCalledWith("claude-cli", [{ role: "user", content: "hello?" }]);
    } finally {
      vi.doUnmock("./externalAdvisor.js");
      vi.resetModules();
    }
  });
});
