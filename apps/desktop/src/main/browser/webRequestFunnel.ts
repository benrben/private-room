// BROWSE-1: THE one webRequest funnel.
//
// `session.webRequest.onBeforeRequest` keeps at most ONE listener per session —
// a second, unrelated registration does not compose with the first, it silently
// REPLACES it. That is Electron's own twin of the WKContentRuleList
// silent-total-failure `rules.ts`'s header describes, and it is why this
// migration's plan doc (Part D §2) calls `enableBlockingInSession()` a trap:
// calling `@ghostery/adblocker-electron`'s helper after hand-registering the
// private-network guard would silently evict the guard; registering the guard
// after it would silently evict the block/allow decision. Either way half of
// "the browser is never a path to this Mac" goes dark with no error and no log
// line. So `enableBlockingInSession` is never called, and this module is the ONE
// place a page's session's `onBeforeRequest` is ever registered from.
// `contentBlocking.ts`'s `attachContentBlocking` is the primitive that performs
// that registration; nothing outside this file and contentBlocking.test.ts
// should call it directly.
//
// THE ORDER, unchanged from `classifyRequest` (rules.ts), which this module
// composes rather than re-implements — see that module's header for why the
// ordering IS the policy, and why duplicating it here would only give it a
// second place to drift:
//
//   1. The private-network guard, on EVERY request including every
//      sub-resource — the layer that closes the
//      `<img src="http://localhost:11434/api/delete">` hole no navigation hook
//      can see.
//   2. The curated tracker/ad table, third-party non-main-frame loads only.
//
// WHAT THIS MODULE ADDS. `attachContentBlocking` alone decides block/allow and,
// optionally, says what it did — it deliberately does not decide whether a
// cancellation is worth a journal line, on the stated grounds that "a
// per-request journal line would be a browsing history" (right for a tracker
// pixel, wrong for a blocked navigation the user needs to see). This module is
// that decision, wired once so every page gets it the same way:
//
//   * PRIVATE-NETWORK on a `mainFrame` request — journalled ("blocked") and
//     raised as `browser-blocked`, in the exact wording `navigation.ts`'s
//     `gateNavigation` and `browser.ts`'s `guardDestination` already use for the
//     identical fact at their own layers, so three layers catching the same
//     address read as one sentence in the journal rather than three.
//     `classifyRequest` can only ever answer `"private-network"` for a
//     `mainFrame` request — its tracker branch returns `null` for `mainFrame`
//     before the third-party check runs, because an ad rule must not refuse a
//     top-level load of the tracker's own site — so this is also, precisely,
//     every main-frame block.
//   * PRIVATE-NETWORK on anything else, and every TRACKER block — counted,
//     never journalled. Defense in depth, not a fact about where the person
//     went; the plan doc's own split ("subresource blocks count silently",
//     `browser.rs:948-961`).
//
// The count runs in every branch, for both reasons. "Actual cancellations" is
// the plan doc's own phrase for what the number owes the user and draws no line
// between them — and the shield's "N blocked" badge was a mockup number that
// counted nothing at all (product audit, 2026-08-15), so a counter that quietly
// excluded the private-network reason would still be lying to the reader who
// most needs the true one.
//
// A GENUINE GAP THIS CLOSES, not a hypothetical one. `navigation.ts`'s header
// and `browser.ts`'s `guardDestination` both record — confirmed against a live
// Electron process — that neither `will-frame-navigate` nor `will-redirect`
// fires for a programmatic `webContents.loadURL`, which is why `browser.ts`
// guards its own `newTab`/`ensure` calls before ever reaching `loadURL`.
// `popup.ts`'s `setWindowOpenHandler` does not go through that wrapper: it
// finishes a denied popup with a direct `contents.loadURL(details.url)`. A page
// running `window.open("http://192.168.1.1/admin")` therefore reaches NEITHER
// navigation gate, and this registration is the only thing between that call and
// the local network. For every navigation the other two gates DO cover,
// `event.preventDefault()` runs before the underlying request is dispatched, so
// this funnel never sees those and there is no double journal line where they
// overlap.
//
// ---------------------------------------------------------------------------
// THE OTHER TWO HALVES OF `enableBlockingInSession()`, BY HAND — and why one of
// them is nothing rather than something.
//
// Read out of the dependency itself (`@ghostery/adblocker-electron`'s built
// `index.js`), not guessed: `enableBlockingInSession()` does three things.
// `loadNetworkFilters` registers the `onBeforeRequest` block/allow decision
// (superseded above, by this migration's own explicit decision not to wire that
// package in) AND a `session.webRequest.onHeadersReceived` handler that builds a
// `Content-Security-Policy` response header out of `getCSPDirectives()`.
// `loadCosmeticFilters` registers a session preload plus an `ipcMain.handle`
// round trip (`onInjectCosmeticFilters`) that hides elements by CSS selector.
//
// BOTH of those read entirely out of Ghostery's PARSED FILTER LIST — the `$csp=`
// filter options and `##selector` cosmetic rules EasyList/EasyPrivacy carry.
// This port loads no such data. `rules.ts` is a straight port of `rules.rs`,
// whose `rules_json()` emits `{"action": {"type": "block"}}` for every rule and
// nothing else (checked against the source, not assumed), and no cosmetic
// concept ever existed on either side of this port (no `insertCSS`, no
// `css-display-none`, anywhere in `src-tauri/src/browser/`). So there is no CSP
// directive and no selector in this port, old or new, to inject — nothing
// dropped by leaving both unbuilt.
//
// A hand-written CSP is a different case from cosmetic filtering and worth
// separating rather than waving through: nothing stops this module inventing
// SOME policy and injecting it on every response. Two reasons that would be
// worse than the gap it claims to close:
//
//   1. Grounded in `TRACKER_DOMAINS`, it is dead on arrival. Headers are only
//      received for a request that was ALLOWED — anything `onHeadersReceived`
//      could act on for a listed host was already cancelled by this same
//      funnel's `onBeforeRequest`, so a handler re-checking the table it already
//      vetoed by has no live case to execute.
//   2. Grounded in anything broader, it is invented policy no spec here asks
//      for. CSP directives are allow-lists with no negation — "block these
//      hosts" cannot be phrased as a response header at all, only "allow only
//      these" — which risks breaking exactly the pages `rules.ts`'s header says
//      this port exists not to break. That trade was already declined once for
//      the tracker LIST (curated table over full EasyList/EasyPrivacy);
//      inventing a CSP would make the identical trade again by another door.
//
// And `onHeadersReceived` keeps the same one-registration-per-session contract
// `onBeforeRequest` does, so an inert handler would not be neutral: it would sit
// in that slot and silently absorb a REAL future CSP feature's registration —
// the exact silent-eviction failure this module exists to prevent, moved one
// hook over. Leaving the slot unclaimed IS the correct by-hand equivalent of an
// `enableBlockingInSession()` whose filter engine has nothing to say. Flagged
// rather than quietly decided: this is the same shape as the plan doc's open
// question #1, and if a future batch bundles real filter-list data, THAT is
// where a real `onHeadersReceived` registration belongs, argued on its own
// merits.

import type { Session } from "electron";
import {
  attachContentBlocking,
  type BlockingSessionLike,
  type ContentBlockingResult,
} from "./contentBlocking.js";

/** Verbatim wording `navigation.ts`'s `gateNavigation` and `browser.ts`'s
 *  `guardDestination` already use for the identical fact at their own layers —
 *  kept identical rather than a near-duplicate, since a reader comparing
 *  journal lines from different layers should see one sentence, not three
 *  phrasings of it. */
const PRIVATE_NAVIGATION_BLOCKED_DETAIL = "Navigation blocked: private or non-web address.";

export interface WebRequestFunnelDeps {
  /** The page's own recorded top-level URL — passed straight through to
   *  `attachContentBlocking`; see `ContentBlockingDeps.recordedTopUrl` for why
   *  this and not a live read. */
  recordedTopUrl(): string | undefined;
  journal(kind: string, url: string, detail: string): void;
  emitBlocked(url: string): void;
  /** One real cancellation happened on this page's session, for either reason.
   *  Persisting it (`Page.blockedCount`, tabs.ts) is the caller's job, matching
   *  every other piece of per-page state this port keeps in the tab ledger
   *  rather than inside Electron glue. */
  countBlocked(): void;
}

/**
 * Register THE webRequest funnel on one page's session: the single
 * `onBeforeRequest` registration that session will ever carry, with the journal
 * / event / count wiring `attachContentBlocking` alone leaves to its caller. See
 * this module's header for the ordering, the main-frame/sub-resource split, and
 * why nothing is registered on `onHeadersReceived` alongside it.
 *
 * Idempotent to call again on the SAME session — `onBeforeRequest`'s
 * one-listener contract means a second call replaces the first registration with
 * an identical one, which is exactly what `browser.ts`'s `retryProtection()`
 * ("Try again") relies on.
 */
export function registerWebRequestFunnel(
  session: BlockingSessionLike | Session,
  deps: WebRequestFunnelDeps,
): ContentBlockingResult {
  return attachContentBlocking(session, {
    recordedTopUrl: deps.recordedTopUrl,
    onBlocked: (url, reason, resourceType) => {
      deps.countBlocked();
      if (resourceType === "mainFrame" && reason === "private-network") {
        deps.journal("blocked", url, PRIVATE_NAVIGATION_BLOCKED_DETAIL);
        deps.emitBlocked(url);
      }
    },
  });
}
