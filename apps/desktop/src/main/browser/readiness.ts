// BROWSE-1: the eval/readiness vocabulary — the pure decisions around
// `eval_json`/`probe_ready`/`wait_ready` in src-tauri/src/browser.rs.
//
// Ports `Readiness`, `classify_ready`, `readiness_from_probe_error`,
// `eval_lost_to_navigation`, and the strings `EVAL_TIMED_OUT`/`EVAL_LOST`/
// `SCRIPT_REFUSED` plus the four timing constants.
//
// WHY THE TWO FAILURE STRINGS SURVIVE THE TRANSPORT CHANGE.
// `WKWebView.evaluateJavaScript` neither awaits promises nor reports
// exceptions — a real throw and a resolved `undefined` both arrive as the empty
// string — which is what forced `EVAL_LOST` to exist as a DISTINCT diagnosis
// from a timeout: WebKit drops a pending completion handler when the document
// under it goes away, and the ordinary way a document goes away is a
// NAVIGATION. Electron's `executeJavaScript` is a real Promise, but a promise
// racing an in-flight navigation is not thereby well-behaved, and nothing in
// its public API promises the rejection is reliably distinguishable, version to
// version, from any other failure. So evalBridge.ts keeps exactly these two
// readings and never invents a third; the wording matters as much as the
// classification (the old text said "the browser closed", which is a guess, and
// usually the wrong one — nothing closed).

import { START_BLANK } from "./tabs.js";

/** How long one round trip may take. Generous, because a heavy page can block
 *  its own main thread for a while. Port of `EVAL_TIMEOUT`. */
export const EVAL_TIMEOUT_MS = 15_000;
/** Poll interval while waiting on an async page ticket. */
export const POLL_INTERVAL_MS = 60;
/** Poll interval while waiting for a navigation's page script to come up. */
export const READY_POLL_MS = 120;
/** How long to let a document that appeared MID-ACTION finish arriving before
 *  deciding whether a lost ticket was a navigation or a real failure. Short:
 *  this is the tail of an action the user is watching, not a fresh page load. */
export const READY_BUDGET_NAV_MS = 10_000;

/** What an eval answers when a round trip runs out of time. Named because
 *  `readinessFromProbeError` has to tell it apart from "the document answered
 *  nothing at all": the eval budget outlasts the smallest readiness budget, so
 *  one stuck probe expires the whole wait on its own. */
export const EVAL_TIMED_OUT = "The page did not answer in time.";

/** What an eval answers when its underlying call is LOST rather than answered.
 *  Deliberately does NOT diagnose a closed browser. */
export const EVAL_LOST = "The page was replaced while it was answering.";

/** What a page that will not run the assistant's script is told, wherever we
 *  find out. Deliberately does NOT say "try again": the tools already wait for
 *  readiness themselves, so by the time this is reached the page is genuinely
 *  refusing — and an invitation to retry is what turned one failure into a
 *  twenty-round loop in live QA. */
export const SCRIPT_REFUSED =
  "This page will not run the assistant's page script, so it cannot be read or " +
  "operated. Nothing was done — tell the user this page can't be driven.";

export type Readiness = "ready" | "loading" | "refused";

/**
 * What the readiness probe learned. Port of `classify_ready`.
 *
 * `recordIsBlank` is our own record of whether this tab is genuinely meant to
 * be blank (Rust's `is_blank`). It is the only way to tell the two meanings of
 * a blank page apart: a page still parked on the blank start document answers
 * the ping exactly like a real one, so "the script is up" is not the same
 * question as "the page we asked for is up".
 */
export function classifyReady(v: unknown, recordIsBlank: boolean): Readiness {
  const obj = v as { ok?: unknown; url?: unknown; refused?: unknown } | null | undefined;
  if (obj && obj.ok === true) {
    const onBlank = obj.url === START_BLANK;
    return onBlank && !recordIsBlank ? "loading" : "ready";
  }
  if (obj && obj.refused === true) return "refused";
  return "loading";
}

/**
 * How a FAILED readiness probe should be read. Port of
 * `readiness_from_probe_error`. `null` is "the document answered nothing, and
 * never will" — the PDF case, which the wait is right to report as refused.
 *
 * The two probe failures that are NOT that page at all:
 *  * `EVAL_TIMED_OUT` — the JavaScript thread is blocked, which is exactly
 *    `loading`. Reading it as `null` reported a merely busy page with
 *    `SCRIPT_REFUSED`, worded to stop the model retrying.
 *  * `EVAL_LOST` — the document under the probe was replaced. A probe
 *    interrupted BY a navigation is the strongest evidence there is that a
 *    navigation is in progress.
 */
export function readinessFromProbeError(err: string): Readiness | null {
  return err === EVAL_TIMED_OUT || err === EVAL_LOST ? "loading" : null;
}

/**
 * Did this round trip fail because A NAVIGATION TOOK THE DOCUMENT out from
 * under it? Port of `eval_lost_to_navigation`.
 *
 * Asked by the info poll, which lands inside a navigation sooner or later — and
 * for the FIRST navigation of a page, very nearly always. Without this the
 * strongest evidence that a navigation is happening reached the toolbar as
 * "This page is not answering", over a page that had just finished loading.
 */
export function evalLostToNavigation(err: string): boolean {
  return err === EVAL_LOST;
}

export { START_BLANK };
