import type { Workflow, WorkflowEdge, WorkflowNode } from "../../apiTypes";

/** The workflows shown to the user. Per-script auto-workflows
 * (`createdBy === "script"`) have their own home on the Scripts page, so both
 * the workflow list AND its count badge hide them.
 *
 * This is the ONE source of truth for "which workflows are visible": the
 * Library-pane count badge, the sidebar nav list, and the full Workflows page
 * all derive from it, so the count can never disagree with what's on screen
 * (the "badge says 3, list shows 1" bug). */
export const visibleWorkflows = (workflows: Workflow[]): Workflow[] =>
  workflows.filter((w) => w.createdBy !== "script");

function branchOptions(from: WorkflowNode): string[] {
  if (from.kind === "condition") return ["then", "else"];
  if (from.kind !== "route") return [];
  if (!Array.isArray(from.labels)) return [];
  return (from.labels as string[]).map((label) => String(label).trim()).filter(Boolean);
}

function firstAvailableBranch(
  options: string[],
  existing: WorkflowEdge[],
): string {
  const used = new Set(existing.map((edge) => edge.branch ?? ""));
  return options.find((option) => !used.has(option)) ?? options[0]!;
}

/** The outcome label a NEW edge off `from` must carry, or undefined when `from`
 * isn't a branch source. Every edge leaving a condition/route has to name its
 * outcome — an unlabelled one is live whichever way the step went, so the step
 * stops choosing and every path runs (and the backend validator now refuses to
 * SAVE one). Picks the first outcome not already wired.
 *
 * It lives here, not beside one of its callers, because the canvas's "add a
 * step after this" / "add a parallel branch" buttons and the param sheet's
 * "Runs after" checkboxes all mint edges: the checkbox was the one that never
 * asked, so checking a condition as an input wrote exactly the unlabelled edge
 * the validator bounces, with nothing in that sheet to fix it with. */
export function branchFor(
  from: WorkflowNode | undefined,
  existing: WorkflowEdge[],
): string | undefined {
  if (!from) return undefined;
  const options = branchOptions(from);
  if (options.length === 0) return undefined;
  return firstAvailableBranch(options, existing);
}

/** The dot class for one run-history row's status.
 *
 * A run that was STOPPED (or that the app quit under) is parked, not finished:
 * it reads "paused" now rather than the old permanent "running", but it still
 * wore the same green dot as a run that completed — success styling for work
 * that did not happen. `dot-run` is the neutral in-between the library already
 * uses for a live run. */
export const runDotClass = (status: string): string =>
  status === "error" || status === "failed"
    ? "dot-err"
    : status === "done"
      ? "dot-ok"
      : "dot-run";
