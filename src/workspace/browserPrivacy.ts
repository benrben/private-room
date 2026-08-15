import type { BrowserProtection } from "../apiTypes";

/* WHAT THE SHIELD IS ENTITLED TO SAY.
 *
 * THE DEFECT (product audit, 2026-08-15, rated P0): the chip read "Private" and
 * its tooltip read "Nothing is saved — no history, cookies or cache. Trackers
 * blocked." Every word of that came off ONE check, `browser_verify_private`,
 * which asks the live webview whether its data store is non-persistent. That
 * check is real and worth having. It also has nothing to say about tracker
 * blocking — and while it kept answering yes, the room's own journal was
 * filling with "Content blocking FAILED to load". The interface showed a
 * confident protected state while its protection engine had not initialised.
 *
 * So: TWO facts, asked separately, stated separately, and the weaker one sets
 * the tone. A claim nobody has checked must not look like one that has been —
 * the rule the shield already followed for `pending`, extended to the fact it
 * was silently assuming.
 *
 * The second half of the audit's finding is a copy problem, not a state one.
 * The toolbar said "Nothing is saved" while the journal panel said the
 * assistant's activity is saved inside the room. Both are true, and they only
 * stop contradicting each other once the product names the two things it is
 * talking about: the EPHEMERAL WEB SESSION (history, cookies, cache — gone when
 * the last private page closes) and the DURABLE ROOM RECORD (journal entries
 * and files you deliberately saved — kept, encrypted, in this room). Every
 * string below draws that line rather than choosing a side of it.
 *
 * And the claim this browser must never make at all: private browsing is not
 * anonymity. Safari and Firefox both say so in their own words; a browser that
 * lets an assistant drive it and can send a page to a cloud model owes the user
 * the same sentence, harder.
 *
 * Pure — no React, no bridge — so the wording is testable, which matters
 * because the wording IS the feature here.
 */

/** How well-founded the shield's claim currently is. Ordered weakest-first;
 *  the chip takes the weakest of the two facts it is standing on. */
export type PrivacyTone =
  /** Storage is NOT ephemeral. The browser is not private and says so. */
  | "breached"
  /** Storage is ephemeral, but the tracker blocker failed or is missing. */
  | "degraded"
  /** One of the two checks has not come back. Named for the word the chip
   *  shows, and pointedly NOT "pending": the stylesheet's `--sem-pending` is
   *  the gold caution ink, which is what `degraded` wears. */
  | "checking"
  /** Both checks came back good. */
  | "verified";

export interface PrivacyClaim {
  tone: PrivacyTone;
  /** The one or two words on the chip itself. */
  chip: string;
  /** The chip's title and accessible description: what is true right now. */
  detail: string;
  /** Set when the user should be shown a banner with a Retry, because
   *  something the app can act on has failed. */
  alert: string | null;
}

/** The sentence that resolves the "nothing is saved" / "the journal is saved"
 *  contradiction. Used verbatim on the start screen and in the journal panel so
 *  the two surfaces cannot drift apart again. */
export const EPHEMERAL_VS_ROOM =
  "Page history, cookies and cache clear when the last private page closes. " +
  "The assistant's actions and the files you choose to save stay in this " +
  "encrypted room.";

/** The claim this browser must not let the user assume it is making.
 *
 * Deliberately names the AI provider alongside the network and the site: this
 * browser can hand a page to a model, which is a disclosure the other two do
 * not have to make. */
export const NOT_ANONYMOUS =
  "Private does not mean anonymous: websites, your network and any AI provider " +
  "you choose can still see what you visit.";

/** Read the blocker's verdict on its own terms.
 *
 * An older backend sends no verdict at all. That is `unknown` — never
 * `active`: the entire point of this module is that an unanswered question
 * cannot be rendered as a good answer. */
export function protectionTone(
  protection: BrowserProtection | undefined,
): "verified" | "checking" | "degraded" {
  if (!protection) return "checking";
  if (protection.state === "active") return "verified";
  if (protection.state === "unknown") return "checking";
  return "degraded";
}

/** Why the blocker is not protecting this browser, in the user's terms, or
 *  `null` when it is. WebKit's own `localizedDescription` is carried through
 *  rather than paraphrased — a reason we invent is a reason nobody can act
 *  on. */
export function protectionAlert(
  protection: BrowserProtection | undefined,
): string | null {
  if (!protection) return null;
  if (protection.state === "failed") {
    return `Tracker blocking is OFF: the block list failed to load (${protection.reason}). Pages will load their trackers until this succeeds.`;
  }
  if (protection.state === "unavailable") {
    return `Tracker blocking is unavailable on this system (${protection.reason}). Everything else about this browser is unchanged: nothing is written to disk.`;
  }
  return null;
}

/** The whole claim, from the two facts the browser actually checked.
 *
 * `ephemeral === null` is "the check has not come back", which is the state a
 * failed check also lands in — the caller catches into `null` — so it is
 * treated as unproven rather than as either answer. */
export function privacyClaim(
  ephemeral: boolean | null,
  protection: BrowserProtection | undefined,
  /** Is there a page to make a claim ABOUT? With none open, both checks are
   *  unasked rather than unanswered, and there is nothing in flight. */
  open = true,
): PrivacyClaim {
  if (!open) {
    // "Checking" is what an unanswered check looks like, and it never resolves
    // when nothing is being checked — the chip sat on it indefinitely on the
    // start screen (seen rendered, 2026-08-15). A browser with no page open has
    // made no claim yet, and says so.
    return {
      tone: "checking",
      chip: "No page",
      detail: `No private page is open. ${EPHEMERAL_VS_ROOM} ${NOT_ANONYMOUS}`,
      alert: null,
    };
  }
  if (ephemeral === false) {
    return {
      tone: "breached",
      chip: "Not private",
      detail:
        "WARNING: this page's storage is NOT ephemeral — history, cookies and cache may be written to disk. Close this page.",
      alert:
        "This browser is not private: a page reported a storage that survives the session. Close the private pages and reopen the room.",
    };
  }

  const blocker = protectionTone(protection);
  const alert = protectionAlert(protection);

  if (ephemeral === null || blocker === "checking") {
    return {
      tone: "checking",
      chip: "Checking",
      detail: `Checking this browser's privacy. ${EPHEMERAL_VS_ROOM} ${NOT_ANONYMOUS}`,
      alert,
    };
  }

  if (blocker === "degraded") {
    return {
      tone: "degraded",
      chip: "Partly private",
      detail: `Nothing is written to disk — but tracker blocking is not running. ${EPHEMERAL_VS_ROOM} ${NOT_ANONYMOUS}`,
      alert,
    };
  }

  return {
    tone: "verified",
    chip: "Private",
    detail: `Nothing is written to disk, and the tracker block list is loaded. ${EPHEMERAL_VS_ROOM} ${NOT_ANONYMOUS}`,
    alert: null,
  };
}

/** The start screen's paragraph, which has to make the same two-sided promise
 *  as the chip — and must not claim blocking that is not running. */
export function startScreenCopy(protection: BrowserProtection | undefined): string {
  // `EPHEMERAL_VS_ROOM` already says what clears and when, so the opening
  // clause states only what this screen adds: whether blocking is running. The
  // first draft ran both, and the rendered page read "A browser that keeps
  // nothing: no history, no cookies, no cache. Page history, cookies and cache
  // clear when the last private page closes." — the same promise twice in two
  // consecutive sentences, which reads as padding and buries the third.
  const blocking =
    protectionTone(protection) === "verified"
      ? "Known trackers are blocked."
      : "";
  return [EPHEMERAL_VS_ROOM, blocking, NOT_ANONYMOUS]
    .filter((part) => part !== "")
    .join(" ");
}
