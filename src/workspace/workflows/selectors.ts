import type { Workflow } from "../../apiTypes";

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
