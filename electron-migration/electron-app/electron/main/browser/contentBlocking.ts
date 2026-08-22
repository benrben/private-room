// BROWSE-1: content blocking — the Electron `webRequest` wiring.
//
// Port of `attach_rules`/`retry_protection` in src-tauri/src/browser.rs, minus
// everything that was WebKit's compiler rather than the policy (see rules.ts's
// header). `WKContentRuleListStore.compileContentRuleListForIdentifier` is
// asynchronous and can fail, be dropped, or reject the whole list — which is
// what forces browser.rs's `ThenGo`/`defer_navigation`/`DEFER_GRACE` dance and
// its six-exit `settle` funnel. `session.webRequest.onBeforeRequest` is a
// synchronous registration on a `Session` object with no compile, no cache and
// no bulk-rejection mode, so the only failure left is "the registration itself
// threw", and that is what this reports.
//
// ONE SESSION PER PAGE. This is called once per page, not once globally,
// because `Protection` is tracked PER PAGE and must stay a real fact rather
// than one verdict copied onto every tab: rules.rs attaches its list to ONE
// webview's `userContentController` per call, never to "the app". Each page
// getting its own ephemeral `Session` (webviewManager.ts) reproduces that
// independence, and matches `WKWebsiteDataStore.nonPersistentDataStore()`
// handing back a distinct store per call.
//
// NO UNPROTECTED WINDOW. browser.rs parks every new page on `about:blank`
// because the rule list cannot be attached until after the webview exists, so
// the page's opening burst of requests could go out unblocked while the shield
// still read "Private". Here the listener is attached to the session BEFORE the
// view is constructed and long before `loadURL` — a `WebContentsView` fetches
// nothing until it is told to — so there is no such window and nothing to park
// against. That the registration really does cancel a real request is not taken
// on faith: browserLive.test.ts proves it against a live Electron process and a
// real local HTTP server.

import type { OnBeforeRequestListenerDetails, Session } from "electron";
import { classifyRequest, type BlockReason, type RequestResourceType } from "./rules.js";

export type ContentBlockingResult = { ok: true } | { ok: false; reason: string };

/** The minimum of `Session` this module needs, so the listener's own decisions
 *  are testable without a live Electron process. */
export interface BlockingSessionLike {
  webRequest: {
    onBeforeRequest(
      listener: (
        details: OnBeforeRequestListenerDetails,
        callback: (response: { cancel?: boolean }) => void,
      ) => void,
    ): void;
  };
}

export interface ContentBlockingDeps {
  /** The page's own recorded top-level URL, as a last resort for third-party
   *  classification — never asked of a live view, for the same reason nothing
   *  else in this port re-derives a page's URL from one. */
  recordedTopUrl(): string | undefined;
  /** Told what was blocked and why. Optional: the journal is the caller's
   *  concern, and a per-request journal line would be a browsing history. */
  onBlocked?(url: string, reason: BlockReason): void;
}

/**
 * The requesting frame's top-level URL, for third-party classification.
 *
 * A `mainFrame` request is its own top-level document — and this is not a
 * theoretical nicety: a live probe confirmed `details.frame.top.url` is the
 * EMPTY STRING for the main-frame request of a fresh navigation (the frame has
 * not committed yet), so deriving it from the frame tree alone would make every
 * top-level navigation look third-party and cancel any load of a listed domain.
 *
 * For a sub-resource, `frame.top.url` is the direct answer and was confirmed to
 * carry the real top document. Electron's own caveat is that `frame` may be
 * `null` "if accessed after the frame has either navigated or been destroyed",
 * so the page's recorded URL is the fallback.
 */
export function resolveTopLevelUrl(
  details: Pick<OnBeforeRequestListenerDetails, "url" | "resourceType" | "frame">,
  deps: ContentBlockingDeps,
): string | null {
  if (details.resourceType === "mainFrame") return details.url;
  try {
    const top = details.frame?.top?.url;
    if (top) return top;
  } catch {
    // A destroyed frame throws rather than answering; fall through.
  }
  return deps.recordedTopUrl() ?? null;
}

/**
 * Register the block/allow decision on one page's session. Returns
 * synchronously — see the module header for why there is no async half.
 */
export function attachContentBlocking(
  session: BlockingSessionLike | Session,
  deps: ContentBlockingDeps,
): ContentBlockingResult {
  try {
    (session as BlockingSessionLike).webRequest.onBeforeRequest((details, callback) => {
      const reason = classifyRequest({
        url: details.url,
        resourceType: details.resourceType as RequestResourceType,
        topLevelUrl: resolveTopLevelUrl(details, deps),
      });
      if (reason !== null) deps.onBlocked?.(details.url, reason);
      callback({ cancel: reason !== null });
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
