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
  // Counted through `groupActivity`, not by repeating its status test here.
  // The badge and the Activity list making the same judgement SEPARATELY is
  // how they came to disagree once already; with decision #12 there are now
  // three groups to keep in step, so the rule gets exactly one home and every
  // reader derives from it.
  const jobs = groupActivity(s.jobs).active.length;
  const saving = s.recSave != null || s.recLive?.status === "saving";
  return jobs + (s.summaryStarting ? 1 : 0) + (saving ? 1 : 0);
}

/* ---------- Activity is two things, not one list (owner decision #12) ---------- */

/** The least a grouping rule needs to know about a job. Kept structural so the
 * rule can be tested without the whole `Job` shape (and so the status strings
 * stay the single thing it depends on). */
export interface ActivityJob {
  status: string;
}

export interface ActivityGroups<T> {
  /** Work happening right now: a runner is driving it, or the queue is about
   * to. Stop / Remove act on these. */
  active: T[];
  /** Stopped with work left to do — paused, or parked by a lock or a crash, or
   * failed. Resume / Retry act on these. Still the LIVE manager: every one of
   * them is a thing the user can pick back up. */
  parked: T[];
  /** Finished. A record of what happened, and nothing to act on. */
  history: T[];
}

/** Split Activity into the manager and the log.
 *
 * The owner's decision #12: Activity is BOTH a live manager AND an audit log,
 * and the two must be visually separated rather than sorted together. `active`
 * and `parked` are the manager (both actionable, but "running" and "waiting for
 * you" are different enough to deserve their own headings); `history` is the
 * log.
 *
 * `history` is an ALLOW-LIST of exactly the one status that means finished, not
 * "everything that isn't running". That direction matters: a status this build
 * has never heard of — a newer room file, a kind added later — falls into
 * `parked`, where it is at worst an extra card the user can dismiss. The other
 * direction would file live work under "already happened", which is the one
 * outcome the split exists to prevent. */
export function groupActivity<T extends ActivityJob>(jobs: T[]): ActivityGroups<T> {
  const groups: ActivityGroups<T> = { active: [], parked: [], history: [] };
  for (const j of jobs) {
    if (j.status === "running" || j.status === "queued") groups.active.push(j);
    else if (j.status === "done") groups.history.push(j);
    else groups.parked.push(j);
  }
  return groups;
}

/** How many finished jobs the history section shows. The log is a record, not
 * an archive — a room that has run a scheduled workflow every morning for a
 * month would otherwise push the live section off the top of the pane. Anything
 * beyond this is not hidden silently: the section says how many it is showing. */
export const HISTORY_LIMIT = 25;
