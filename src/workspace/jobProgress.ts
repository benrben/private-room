/**
 * What a background-job row may honestly say about its own progress.
 *
 * Pure, and separate from the row that draws it, so the rule can be argued
 * with in a test rather than discovered by starting a job and watching one.
 *
 * There are exactly three states a row can be in, and the whole point is to
 * keep them apart:
 *
 *  - it has NOT STARTED (queued, or parked part-way) — it has a real position,
 *    and must show that position rather than an animation sliding over work
 *    nothing is doing;
 *  - it is RUNNING and has said how far through it is — it shows that;
 *  - it is RUNNING and has NOT said — it shows a moving bar and no number,
 *    because it has no quantity to state.
 */

/** A live `job-progress` event, as the workspace stores it. */
export interface LiveProgress {
  label: string;
  done: number;
  total: number;
}

export interface JobMeter {
  /** A moving bar: running, position genuinely unknown. */
  indeterminate: boolean;
  /** The written count beside the bar, or null when there is none to write. */
  figure: { done: number; total: number } | null;
  /** Bar width, 0–100. Meaningless while `indeterminate`. */
  percent: number;
}

export function jobMeter(
  status: string,
  /** Where a parked run left off, from the job row itself. */
  cursor: number,
  /** The job's own planned total, which may not be known yet. */
  jobTotal: number,
  live: LiveProgress | undefined,
): JobMeter {
  const total = live?.total ?? jobTotal;
  const done = live?.done ?? cursor;

  /* A total of zero is not a total of one.
   *
   * The bar's width arithmetic needs a non-zero denominator, and clamping with
   * `Math.max(total, 1)` at the point of use quietly supplied one — so a job
   * that had started but not yet planned its steps rendered as "0 / 1": one
   * step, none of them done, both invented, printed beside the word
   * "Starting…". A missing total has to travel as missing all the way to the
   * decision, and only then be replaced for the arithmetic. */
  const known = total > 0;
  const indeterminate = status === "running" && (!live || !known);
  if (indeterminate) return { indeterminate: true, figure: null, percent: 0 };

  if (!known) return { indeterminate: false, figure: null, percent: 0 };
  // A backend that over-counts must not be able to say "13 of 12".
  const shown = Math.min(done, total);
  return {
    indeterminate: false,
    figure: { done: shown, total },
    percent: Math.min(100, Math.round((shown / total) * 100)),
  };
}
