import type { Schedule, ScheduleArg, WorkflowBinding } from "../../api";

/** Short day names, in `Date.getDay()` order — index 5 IS Friday, which is what
 * a weekly schedule's `param` ("5 16:00") stores. The schedule popover's day
 * picker and the handwritten note on a card read the same array, so the two can
 * never disagree about which day a "5" is. */
export const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** How often a workflow runs, as ONE value the library card, its identity edge
 * and the schedule popover all read from.
 *
 * Cadence is IDENTITY — what kind of workflow this is — not STATUS, which is
 * how its last run went. That distinction drives two decisions here:
 *
 *   `mark` is a paper.css HUE setter (.nb-mark-*), never a semantic one. The
 *   five semantic hues are spoken for by run status (done/failed/running), and
 *   a card shows both at once, so borrowing them for cadence would make green
 *   mean two things on one card. Same reasoning as the token-budget bar's five
 *   category fills in tokens.css.
 *
 *   the card draws cadence as an EDGE and status as a badge with a word, so
 *   even where the hues rhyme the two are told apart by treatment.
 *
 * `note` is the human phrase — handwriting's natural home. `exact` is the
 * precise clock time or interval, which is technical data and stays mono, so a
 * schedule never reads as though the app rounded it. */
export interface Cadence {
  /** A .nb-mark-* class, or "" for a workflow with no cadence to advertise. */
  mark: string;
  /** The human phrase: "every day at", "every Fri at", "on a timer, every". */
  note: string;
  /** The exact value the phrase ends on ("08:00", "30 min"), or null. */
  exact: string | null;
}

/** A phrase plus its exact value, with the dangling preposition dropped when
 * there is no value to hang off it. */
function at(word: string, value: string): { note: string; exact: string | null } {
  return value ? { note: `${word} at`, exact: value } : { note: word, exact: null };
}

export function cadenceOf(
  schedule: Schedule | ScheduleArg | null | undefined,
  binding?: WorkflowBinding | null,
): Cadence {
  // Asked first because it is absolute: a file-scoped workflow takes a file as
  // its input, and the scheduler refuses it outright (see SchedulePopover's
  // `disabled` branch). Whatever a stale schedule row says, this is the truth.
  if (binding?.scope === "file") {
    return { mark: "nb-mark-pink", note: "when you run it on a file", exact: null };
  }
  const kind = schedule?.kind ?? "";
  if (!kind) return { mark: "", note: "only when you run it", exact: null };
  // `Schedule` always carries `enabled`; `ScheduleArg` may omit it, and a
  // template that omits it means "on".
  const enabled = schedule && "enabled" in schedule ? schedule.enabled !== false : true;
  // A switched-off schedule is not a manual workflow — it is a scheduled one
  // that is not running. Saying "only when you run it" would quietly lose the
  // fact that there is a schedule sitting there waiting to be turned back on.
  if (!enabled) return { mark: "", note: "schedule paused", exact: null };

  const param = (schedule?.param ?? "").trim();
  if (kind === "daily") return { mark: "nb-mark-yellow", ...at("every day", param) };
  if (kind === "weekly") {
    // "5 16:00" — day index then time, exactly as the scheduler stores it.
    const parts = param.split(/\s+/);
    const day = DOW[Number(parts[0])];
    return { mark: "nb-mark-blue", ...at(day ? `every ${day}` : "every week", parts[1] || "") };
  }
  if (kind === "interval") {
    return {
      mark: "nb-mark-green",
      note: param ? "on a timer, every" : "on a timer",
      exact: param ? `${param} min` : null,
    };
  }
  // An unknown kind from a newer backend still reads as words rather than as a
  // raw token, and still earns no colour it has not been given a meaning for.
  return { mark: "", note: kind, exact: param || null };
}

/** The cadence written out: a handwritten calendar note, then the exact time in
 * mono. `countdown` is a duration ("in 4h") — also the hand's job — and is
 * omitted for anything without a next run.
 *
 * Colour is never the only carrier of cadence: this line is the WORD half of
 * the signal the card's marker edge carries in colour. */
export function CadenceNote({
  cadence,
  countdown,
}: {
  cadence: Cadence;
  countdown?: string;
}) {
  return (
    <span className="wf-cadence">
      <span className="wf-cadence-note">{cadence.note}</span>
      {cadence.exact && <span className="wf-cadence-at">{cadence.exact}</span>}
      {countdown && <span className="wf-cadence-in">{countdown}</span>}
    </span>
  );
}
