import type { WSState } from "../workspace/state";

/** ONE definition of "something is happening", for every place that shows it:
 * the status bar's counters, the Activity tab's attention dot, and the
 * Activity list itself. They used to count separately from the same raw
 * state and disagree for a second after a recording stopped — the badge said
 * nothing was running while the Activity tab said something was. */

export type ApprovalState = Pick<
  WSState,
  "mcpApprovals" | "editApprovals" | "scriptApprovals" | "browseConsents"
>;

export type WorkState = Pick<
  WSState,
  "jobs" | "summaryStarting" | "recSave" | "recLive"
>;

/** Everything waiting on a yes/no from the user. */
export function pendingApprovalCount(s: ApprovalState): number {
  return (
    s.mcpApprovals.length +
    s.editApprovals.length +
    s.scriptApprovals.length +
    s.browseConsents.length
  );
}

/** Background work in flight. A recording being written out counts ONCE,
 * from the moment the live recorder says "saving" until the save progress
 * clears — the two signals arrive a beat apart, and either one alone means
 * work is still happening. */
export function runningJobCount(s: WorkState): number {
  const jobs = s.jobs.filter(
    (j) => j.status === "running" || j.status === "queued",
  ).length;
  const saving = s.recSave != null || s.recLive?.status === "saving";
  return jobs + (s.summaryStarting ? 1 : 0) + (saving ? 1 : 0);
}
