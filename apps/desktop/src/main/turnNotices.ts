/**
 * The app's own notices for an answer that produced no real reply, and the
 * predicate that tells them apart from a genuine model answer.
 *
 * Ported verbatim from `src-tauri/src/commands/agent.rs`: the `LOST_REPLY_*`/
 * `STOPPED_*` constants, `empty_reply_notice`, `is_failure_notice`,
 * `background_work_live`, and the anti-fabrication check `claims_unbacked_action`.
 */

// ------------------------------------------------------------------ notices

/** No answer, and nothing was written — safe to just retry. Ported verbatim. */
export const LOST_REPLY_CLEAN =
  "*(The agent finished without producing an answer — the reply was lost before " +
  "it reached the app, so nothing was written. Please try again.)*";

/** No answer, but a write ALREADY COMMITTED. Ported verbatim. */
export const LOST_REPLY_AFTER_WRITE =
  "*(The agent finished without producing an answer — the reply was lost before " +
  "it reached the app. A change was already applied to this room before that " +
  "happened; check the file and undo it if it was not what you wanted.)*";

/** No answer and no write, but durable background work in this room is
 * STILL RUNNING. Ported verbatim. */
export const LOST_REPLY_WITH_JOB =
  "*(The agent finished without producing an answer — the reply was lost before " +
  "it reached the app, and nothing was written. Background work in this room is " +
  "still running: check the Jobs list before asking again, so you don't start " +
  "the same job twice.)*";

/** The mid-run failure note's stable fragment. Ported verbatim. */
export const STOPPED_MID_RUN = "hit an error and stopped mid-run";

/** The stop notices' stable fragment — every one of the three below carries
 * it, which is how {@link isFailureNotice} recognises them. Ported verbatim. */
export const STOPPED_NO_ANSWER = "was stopped before it produced an answer";

/** Stop pressed before any answer arrived, and nothing was written. Ported
 * verbatim. */
export const STOPPED_NO_ANSWER_CLEAN =
  "*(The agent was stopped before it produced an answer, and nothing was written.)*";

/** Stopped with no answer, but a write ALREADY COMMITTED. Ported verbatim. */
export const STOPPED_NO_ANSWER_AFTER_WRITE =
  "*(The agent was stopped before it produced an answer. A change was already applied to " +
  "this room before the stop; check the file and undo it if it was not what you wanted.)*";

/** Stopped with no answer and no write, but durable background work in this
 * room is STILL RUNNING. Ported verbatim. */
export const STOPPED_NO_ANSWER_WITH_JOB =
  "*(The agent was stopped before it produced an answer, and nothing was written. " +
  "Background work in this room is still running: check the Jobs list before asking " +
  "again, so you don't start the same job twice.)*";

/** Indexed by stopped/wrote/jobLive bits. The repeated after-write entries
 * preserve the original priority: a committed write matters more than the
 * job state. */
const EMPTY_REPLY_NOTICES = [
  LOST_REPLY_CLEAN,
  LOST_REPLY_WITH_JOB,
  LOST_REPLY_AFTER_WRITE,
  LOST_REPLY_AFTER_WRITE,
  STOPPED_NO_ANSWER_CLEAN,
  STOPPED_NO_ANSWER_WITH_JOB,
  STOPPED_NO_ANSWER_AFTER_WRITE,
  STOPPED_NO_ANSWER_AFTER_WRITE,
] as const;

/**
 * Which of the app's own notices stands in for an EMPTY reply. Ported
 * verbatim from `empty_reply_notice`. `stopped` splits the table in two: an
 * empty result after Stop is what the user asked for, so reporting it as a
 * reply LOST before it reached the app — and asking for a retry — would
 * describe an app failure that did not happen.
 */
export function emptyReplyNotice(stopped: boolean, wrote: boolean, jobLive: boolean): string {
  const index = Number(stopped) * 4 + Number(wrote) * 2 + Number(jobLive);
  return EMPTY_REPLY_NOTICES[index]!;
}

/**
 * Is durable background work still live in the open room? Ported from
 * `background_work_live`. The real dependency (`db::list_jobs`, i.e. a jobs
 * table) is not ported in this batch — no `db-host/jobs.ts` exists yet (see
 * `execTool.ts`'s `job_status`/`start_file_pass` stubs, which are the same
 * gap) — so this takes the job-status read as an injected function rather
 * than reaching into a concrete DB module. `undefined` from `jobStatuses`
 * stands for "no room is open, or the read failed", which — matching Rust's
 * `.unwrap_or(false)` — is NOT treated as "nothing is running": a failed
 * read must never claim either way, so both cases answer `false` here too.
 */
export function backgroundWorkLive(jobStatuses: () => Array<{ status: string }> | undefined): boolean {
  const jobs = jobStatuses();
  if (jobs === undefined) {
    return false;
  }
  return jobs.some((j) => j.status === "running" || j.status === "queued");
}

/**
 * Is this assistant message one of Arcelle's own failure notices rather than
 * a real answer? Ported verbatim from `is_failure_notice`.
 */
export function isFailureNotice(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith("*(The agent ") &&
    (t.includes("the reply was lost before it reached the app") ||
      t.includes(STOPPED_MID_RUN) ||
      t.includes(STOPPED_NO_ANSWER))
  );
}

// ------------------------------------------------------------ unbacked claims

/** Verb phrases that assert a WRITE already happened. Ported verbatim from
 * `WRITE_CLAIMS`. */
const WRITE_CLAIMS: readonly string[] = [
  "i've updated",
  "i have updated",
  "i've edited",
  "i have edited",
  "i've changed",
  "i have changed",
  "i've saved",
  "i have saved",
  "i've fixed",
  "i have fixed",
  "i've rewritten",
  "i've rewrote",
  "i updated the",
  "i edited the",
  "i changed the",
  "i saved the",
  "i fixed the",
  "i've created",
  "i created the",
  "i set ",
  "file has been updated",
  "file was updated",
  "file has been saved",
  "file was saved",
  "file has been changed",
  "the file is updated",
];

/** Verb phrases that assert a HIGHLIGHT already happened. Ported verbatim
 * from `HL_CLAIMS`. */
const HL_CLAIMS: readonly string[] = [
  "i've highlighted",
  "i have highlighted",
  "i highlighted the",
  "i've marked",
  "i marked the",
  "i've boxed",
  "i boxed the",
  "i've circled",
];

/** Negation/conditional guards checked on the SAME LINE as a matched claim.
 * Ported verbatim from the inline array in `claims_unbacked_action`. */
const NEGATION_GUARDS: readonly string[] = [
  "not ",
  "n't",
  "unable",
  "cannot",
  "can't",
  "could not",
  "couldn't",
  "would ",
  "if ",
];

function hasClaim(lower: string, claims: readonly string[]): boolean {
  for (const c of claims) {
    let from = 0;
    for (;;) {
      const pos = lower.indexOf(c, from);
      if (pos === -1) {
        break;
      }
      const lineStart = lower.lastIndexOf("\n", pos - 1) + 1;
      const nextNl = lower.indexOf("\n", pos);
      const lineEnd = nextNl === -1 ? lower.length : nextNl;
      const line = lower.slice(lineStart, lineEnd);
      const negated = NEGATION_GUARDS.some((n) => line.includes(n));
      if (!negated) {
        return true;
      }
      from = lineEnd;
    }
  }
  return false;
}

/**
 * Conservative check for a first-person/passive past-tense claim that a file
 * was changed or a passage highlighted, when the runtime knows no such
 * effect occurred. Ported verbatim from `claims_unbacked_action`, including
 * the fenced-code-block skip and the same-line negation guard.
 */
export function claimsUnbackedAction(text: string, wrote: boolean, highlighted: boolean): boolean {
  const prose = unfencedNoticeProse(text);
  const lower = prose.toLowerCase();
  return missingWriteClaim(lower, wrote) || missingHighlightClaim(lower, highlighted);
}

function unfencedNoticeProse(text: string): string {
  // Drop fenced blocks (diffs, code, viewer markup) before scanning prose.
  let prose = "";
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      prose += line;
      prose += "\n";
    }
  }
  return prose;
}

function missingWriteClaim(lower: string, wrote: boolean): boolean {
  return !wrote && hasClaim(lower, WRITE_CLAIMS);
}

function missingHighlightClaim(lower: string, highlighted: boolean): boolean {
  return !highlighted && hasClaim(lower, HL_CLAIMS);
}
