// BROWSE-1: the synchronous navigation gate — the Electron wiring.
//
// Port of `navigation_allowed`/`recheck_host_off_thread`/
// `halt_private_navigation` in src-tauri/src/browser.rs, wired to
// `will-frame-navigate` and `will-redirect` instead of wry's `on_navigation`.
//
// It runs on the main thread for every navigation, so it does only LITERAL
// checks and never DNS — a blocking resolve here would stall the UI on every
// click. The resolving half runs off-thread below, and sub-resources are
// covered by contentBlocking.ts. Three layers, one invariant: the browser is
// never a path to this Mac.
//
// WHY `will-frame-navigate` AND NOT `will-navigate`: `will-navigate` fires only
// for the main frame, with no way to see a sub-frame's navigation at all.
// `will-frame-navigate` fires for every frame — the same shape wry's single
// hook had — but hands over a real `isMainFrame` boolean. That ground truth is
// what retires `believable_for`'s same-host HEURISTIC for this job: wry could
// not tell a sub-frame from the main frame, which is why an `about:blank`
// iframe could overwrite a page's record and "vanish" it. Here the record is
// only ever written for `isMainFrame`, so a sub-frame cannot touch it at all.
//
// WHY `will-redirect` AS WELL — A GAP NEITHER OF THE OBVIOUS PORTS HAS:
// browser.rs's own doc comment says the gate runs for "EVERY top-level
// navigation — typed, clicked, redirected or scripted". Electron splits those:
// `will-frame-navigate` does NOT fire for a server-side redirect, which gets
// its own `will-redirect` event. Confirmed against a live Electron process — a
// 302 produced exactly one event, and it was `will-redirect`. Without this
// listener a page that answers 302 → `http://127.0.0.1/` would walk straight
// past the gate. Both events accept `preventDefault()` to refuse the
// navigation, and `will-redirect` carries the same `url`/`isMainFrame`.
//
// WHY `loadURL` NEEDS ITS OWN CHECK: Electron documents that neither event
// fires "when the navigation is started programmatically with APIs like
// `webContents.loadURL`" — also confirmed live. That is not a hole: browser.rs
// already gives the agent path a STRONGER, separate check ("Agent-initiated
// navigation additionally resolves the host (DNS) before loading"), which on
// this side lives in browser.ts's `ensure()`/`newTab()`. This module covers
// exactly what wry's hook covered for every OTHER navigation.
//
// THE HALT: Rust runs `window.stop()` through the page because wry has no
// first-class "abandon this load". `WebContents.stop()` is that method, so it
// is called directly — one fewer moving part, and not something a hostile
// document can shadow.

import type {
  Event as ElectronEvent,
  WebContents,
  WebContentsWillFrameNavigateEventParams,
  WebContentsWillRedirectEventParams,
} from "electron";
import { checkPublicHttpUrl, hostResolvesPrivate } from "./guard.js";
import { isAppLinkScheme, isRecordableUrl, needsHostRecheck, portFor } from "./navGuard.js";

export interface NavigationDeps {
  journal(kind: string, url: string, detail: string): void;
  emitBlocked(url: string): void;
  /** Called ONLY for a navigation Electron itself confirms is on the main
   *  frame — the ground truth that replaces `believable_for`'s guess here. */
  recordMainFrameUrl(url: string): void;
}

/** The minimum of `WebContents` this module needs, so the gate's decisions are
 *  testable against a scripted fake rather than a live renderer. */
export interface NavigatableContents {
  on(
    event: "will-frame-navigate",
    listener: (event: ElectronEvent<WebContentsWillFrameNavigateEventParams>) => void,
  ): unknown;
  on(
    event: "will-redirect",
    listener: (event: ElectronEvent<WebContentsWillRedirectEventParams>) => void,
  ): unknown;
  stop(): void;
  isDestroyed(): boolean;
}

/** The literal half of the guard: exactly the check `fetch_page` uses. */
function isPublicHttpUrl(url: string): boolean {
  try {
    checkPublicHttpUrl(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve an allowed navigation's host in the background and pull the page back
 * if the name turns out to point into this Mac or the local network. Port of
 * `recheck_host_off_thread` + `halt_private_navigation`.
 *
 * A SECOND layer, not the first: the load has begun by the time an answer
 * arrives, so it cannot promise the request was never sent. What it promises is
 * that the page is not left sitting on a local service's response, and that the
 * attempt is journalled like every other blocked address instead of passing
 * silently because it was spelled as a name. The content rules cannot cover
 * this — they match address TEXT, so a name that resolves privately looks
 * public to them too.
 *
 * Only a name that genuinely resolves PRIVATE halts a page. A name that does
 * not resolve at all fails to load on its own, and reporting that as a
 * private-address block would be the untrue red banner `mailto:` links used to
 * get.
 */
export function recheckHostOffThread(
  contents: Pick<NavigatableContents, "stop" | "isDestroyed">,
  url: URL,
  deps: NavigationDeps,
): Promise<void> {
  if (!needsHostRecheck(url)) return Promise.resolve();
  const shown = url.toString();
  return hostResolvesPrivate(url.hostname, portFor(url)).then((isPrivate) => {
    if (!isPrivate) return;
    if (!contents.isDestroyed()) contents.stop();
    deps.journal(
      "blocked",
      shown,
      "Navigation stopped: that name resolves to this Mac or a private network.",
    );
    deps.emitBlocked(shown);
  });
}

interface NavigationAttempt {
  url: string;
  isMainFrame: boolean;
  preventDefault(): void;
}

function navigationUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function rejectAppLink(event: NavigationAttempt, deps: NavigationDeps): void {
  deps.journal(
    "open",
    event.url,
    "This link opens another app, which the private browser does not do — nothing was loaded.",
  );
  event.preventDefault();
}

function rejectNonPublicUrl(event: NavigationAttempt, deps: NavigationDeps): void {
  deps.journal("blocked", event.url, "Navigation blocked: private or non-web address.");
  deps.emitBlocked(event.url);
  event.preventDefault();
}

function recordNavigation(event: NavigationAttempt, url: URL, deps: NavigationDeps): void {
  if (event.isMainFrame && isRecordableUrl(url)) {
    deps.recordMainFrameUrl(event.url);
  }
}

/**
 * The gate itself, as one pure-ish decision over one attempted navigation, so
 * both events share exactly one implementation. Port of `navigation_allowed`.
 */
export function gateNavigation(
  contents: Pick<NavigatableContents, "stop" | "isDestroyed">,
  event: NavigationAttempt,
  deps: NavigationDeps,
): void {
  const parsed = navigationUrl(event.url);
  if (parsed === null) {
    // Nothing this gate recognises as a real destination; leave Chromium's own
    // handling of it alone rather than inventing a verdict.
    return;
  }

  // `about:blank` is a frame's own idle state, never a destination — blocking
  // it would break the page for real.
  if (parsed.protocol === "about:") return;

  if (isAppLinkScheme(parsed.protocol)) {
    rejectAppLink(event, deps);
    return;
  }

  if (!isPublicHttpUrl(event.url)) {
    rejectNonPublicUrl(event, deps);
    return;
  }

  recordNavigation(event, parsed, deps);
  void recheckHostOffThread(contents, parsed, deps);
}

/** Attach the gate to one page's `WebContents`, on both of the events a
 *  navigation can arrive through. */
export function attachNavigationGating(
  contents: NavigatableContents | WebContents,
  deps: NavigationDeps,
): void {
  const c = contents as NavigatableContents;
  c.on("will-frame-navigate", (event) => gateNavigation(c, event, deps));
  c.on("will-redirect", (event) => gateNavigation(c, event, deps));
}
