import type { WorkflowNode } from "../../apiTypes";

/** Every engine-supported step kind and its human label. This is the ONE place
 * that maps an implementation `kind` (file_pass, agent_run…) to the words a user
 * reads, so the canvas, the step inspector, and accessibility labels all agree —
 * no surface ever shows the raw `file_pass` token. */
export const KIND_LABELS: Record<string, string> = {
  generate: "Generate text",
  summarize_file: "Summarize a file",
  file_pass: "Full-file pass",
  for_each_file: "For each file",
  agent_run: "Ask the agent",
  extract: "Extract fields",
  route: "Route by content",
  vote: "Vote / consensus",
  refine: "Refine (critique loop)",
  plan_and_map: "Plan & map",
  transform: "Transform text",
  merge: "Merge branches",
  http_fetch: "Fetch a URL",
  script_run: "Run a script",
  save_file: "Save a file",
  condition: "Condition",
};

/** Fields each kind needs seeded on a kind switch. serde requires the required
 * fields to even parse the def, so seeding them keeps validation showing
 * actionable field errors instead of an opaque parse failure.
 *
 * Every key here must be one the engine's own variant declares
 * (`commands/jobs/workflow.rs`). `condition` used to seed `input: ""`, which the
 * Rust variant dropped — no screen showed it, no code read it, and every new
 * workflow file carried it. Unknown keys parse fine, so it was invisible; that
 * is exactly why it needs a test rather than a reader noticing.
 *
 * It lives beside `KIND_LABELS` for the same reason that does: one place the
 * palette is described, so the inspector, the canvas and the backend backfill
 * cannot drift. */
export const KIND_DEFAULTS: Record<string, Record<string, unknown>> = {
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
  condition: { op: "not_empty", value: "" },
};

/** Human label for a step kind — falls back to a de-underscored version of the
 * raw kind so an unknown/new kind still reads as words, never `file_pass`. */
export const kindLabel = (kind: string): string =>
  KIND_LABELS[kind] ?? kind.replace(/_/g, " ");

/** The name shown for a step: the user's own label when set, otherwise the
 * human kind label. Guarantees a step is never displayed as a blank or as a
 * raw `kind` token. Mirrors the backend backfill in workflow.rs. */
export const nodeTitle = (n: WorkflowNode): string =>
  (n.label && String(n.label).trim()) || kindLabel(n.kind);
