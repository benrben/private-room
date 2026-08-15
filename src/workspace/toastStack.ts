import type { Toast } from "./types";

/** WHAT THE TOAST STACK IS ALLOWED TO DO TO THE WORKSPACE.
 *
 * Both rules here are pure and both were written against the same live report:
 * promoting and demoting one sketch a few times left five confirmations stacked
 * over Home, still there after changing destination, none of them expiring.
 * Each carried an Undo, and "a toast with an action waits" was the whole reason
 * — a rule that is right for the offer it was written for (open the file that
 * background job just made) and wrong for a confirmation of something the user
 * can already see and already reverse.
 *
 * Kept out of state.ts because the interesting cases are all edges — a repeat
 * about the same object, a burst that hits the cap, an error that must survive
 * that burst — and edges deserve tests rather than a careful reading. */

/** How many messages may be on screen at once. */
export const MAX_TOASTS = 5;

/** How long a self-dismissing message stays.
 *
 * An offer needs longer than a notice: five seconds is enough to read "Added
 * X to the Library" but not to read it, decide it was wrong, and reach Undo. */
const NOTICE_MS = 5000;
const OFFER_MS = 12000;

/** Add `toast`, and say what the stack looks like afterwards.
 *
 * A message ABOUT something replaces the previous message about that same
 * thing. Only the newest is true: after add-then-remove, the first toast's
 * Undo would put back a state two acts ago, and its sentence describes a
 * Library the object is no longer in. */
export function stackToast(current: Toast[], toast: Toast): Toast[] {
  const kept = toast.about
    ? current.filter((t) => t.about !== toast.about)
    : current;
  const next = [...kept, toast];
  if (next.length <= MAX_TOASTS) return next;
  // Over the cap, drop the oldest self-dismissing message first so a burst of
  // successes can never push an error off the screen.
  const oldestChatty = next.findIndex((t) => t.kind !== "error");
  const victim = oldestChatty >= 0 ? oldestChatty : 0;
  return next.filter((_, i) => i !== victim);
}

/** Milliseconds until this message clears itself, or `null` if it waits to be
 * dismissed.
 *
 * TWO KINDS WAIT, and for the same reason: nothing else will ever say it
 * again. An ERROR is this app's only report that something failed, and there is
 * no log to go back to — clearing one on a timer means a user who looked away
 * is simply never told. An OFFER is the only route to something the app
 * deliberately did not do for you.
 *
 * A message ABOUT an object is neither. The object is on screen, its own
 * controls offer the same act and its inverse, and the change it reports is
 * reversible from the object at any time — so it goes, action or not. */
export function toastLifeMs(toast: Toast): number | null {
  if (toast.kind === "error") return null;
  if (toast.about) return toast.action ? OFFER_MS : NOTICE_MS;
  if (toast.action) return null;
  return NOTICE_MS;
}
