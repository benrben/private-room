// BROWSE-1: the content blocker's verdict, per page.
//
// Port of `Protection`/`protection_severity`/`worst_protection` in
// src-tauri/src/browser.rs.
//
// The four states are NOT simplified away even though Chromium's blocking
// attaches synchronously (see contentBlocking.ts). `BrowserProtection` in
// src/shared/apiTypes.ts is the wire contract the shield chip reads, and
// its own doc comment records the defect it exists for: the chip once said
// "Trackers blocked." off an unrelated storage assertion, so a failed blocker
// and a working one looked identical. `unknown` must stay a real state that is
// never rendered as protected, and a page whose blocking registration THREW
// must still be reported as unprotected.
import type { BrowserProtection } from "../../shared/apiTypes.js";

export type Protection = BrowserProtection;

/** The default: nobody has heard back yet. NEVER read as protected. */
export const UNKNOWN_PROTECTION: Protection = { state: "unknown" };

/**
 * How bad a verdict is. `unknown` outranks `active` because a page nobody has
 * heard back about is not a protected page. Port of `protection_severity`.
 */
export function protectionSeverity(verdict: Protection): number {
  switch (verdict.state) {
    case "failed":
      return 3;
    case "unavailable":
      return 2;
    case "unknown":
      return 1;
    case "active":
      return 0;
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

/**
 * The worst of the lot; the FIRST page's reason wins a tie, so the reason
 * belongs to the page that hit the trouble earliest. Empty is `unknown`, never
 * `active` — a browser with no open pages has protected nothing.
 *
 * Port of `worst_protection`. The shield speaks for the WHOLE browser, so one
 * page whose blocker never attached makes the browser unprotected no matter
 * how many of its neighbours are fine.
 */
export function worstProtection(verdicts: readonly Protection[]): Protection {
  let worst: Protection | null = null;
  for (const verdict of verdicts) {
    if (worst === null || protectionSeverity(verdict) > protectionSeverity(worst)) {
      worst = verdict;
    }
  }
  return worst ?? UNKNOWN_PROTECTION;
}
