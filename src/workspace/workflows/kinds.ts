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

/** Human label for a step kind — falls back to a de-underscored version of the
 * raw kind so an unknown/new kind still reads as words, never `file_pass`. */
export const kindLabel = (kind: string): string =>
  KIND_LABELS[kind] ?? kind.replace(/_/g, " ");

/** The name shown for a step: the user's own label when set, otherwise the
 * human kind label. Guarantees a step is never displayed as a blank or as a
 * raw `kind` token. Mirrors the backend backfill in workflow.rs. */
export const nodeTitle = (n: WorkflowNode): string =>
  (n.label && String(n.label).trim()) || kindLabel(n.kind);
