import type { BrowserInfo } from "../apiTypes";

/* Item #18: what a screen reader is TOLD about the private browser.
 *
 * The page is a native child webview floating over the window. A sighted user
 * sees it repaint; nothing in the host DOM changes at all, so assistive tech
 * has no event to report and the user is simply not told where they are. The
 * browser chrome already polls `browser_info` every 1200 ms — this turns that
 * poll into the announcements, which is why the whole feature costs no new IPC.
 *
 * It lives in its own module because it is the one piece of this that can be
 * tested without a DOM: the repo's frontend harness is `node --test` over
 * type-stripped modules (see tests/contract/address.test.mjs), with no React
 * renderer.
 *
 * TWO RULES, both anti-fabrication:
 *   1. Never say "loaded" unless the page said `readyState === "complete"`.
 *      A poll that lands mid-navigation knows the URL and not much else.
 *   2. Return null when nothing worth saying changed. A live region that
 *      re-announces the same sentence every 1.2 seconds is not information,
 *      it is a page nobody can use.
 */

/** The host of a page, for saying WHERE you are without reading a URL aloud
 *  character by character. `null` when the address will not parse. */
export function hostOf(url?: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** The identity of a page state, for "has anything worth announcing changed".
 *  Deliberately includes `ready`: the same URL going from loading to complete
 *  is the single most important transition there is. */
function identity(info: BrowserInfo | null): string {
  if (!info || !info.open) return "closed";
  if (info.blank) return "blank";
  return openPageIdentity(info);
}

function openPageIdentity(info: BrowserInfo): string {
  // `protection` is part of the identity because a blocker that fails after the
  // page has settled changes nothing else in this record — without it, the one
  // announcement that matters most would be suppressed as "nothing changed".
  const guard = info.protection?.state ?? "";
  return `${info.url ?? ""} ${info.title ?? ""} ${info.ready ?? ""} ${info.error ?? ""} ${guard}`;
}

/** The spoken half of the shield.
 *
 * A protection failure is drawn as a banner and a gold chip, and a screen
 * reader sees neither. It rides on the sentence about the page rather than
 * interrupting with one of its own: it is a fact ABOUT this page, and a
 * separate announcement would either be missed between polls or repeat itself
 * every time anything else about the page changed.
 *
 * `unknown` says nothing at all. The compile is asynchronous, and narrating
 * "we have not heard back yet" on every navigation is noise rather than
 * information — the chip carries that state for the people who can see it. */
export function guardClause(info: BrowserInfo): string {
  const state = info.protection?.state;
  if (state === "failed") {
    return " Tracker blocking is off — the block list failed to load.";
  }
  if (state === "unavailable") {
    return " Tracker blocking is unavailable on this system.";
  }
  return "";
}

/** The SEEN half of "this page has stopped answering".
 *
 * `browser_info` reports the reason a poll got no answer, and the address bar
 * then falls back to Rust's own record of where the page was sent — so the
 * chrome looks completely normal while what is on screen may be anything at
 * all. A sighted user was told nothing: the reason existed only in the live
 * region, which is exactly the "empty must read as empty" hole this app is
 * built against. `null` when there is nothing to say. */
export function stalledBanner(info: BrowserInfo): string | null {
  if (!info.open || info.blank || !info.error) return null;
  const reason = info.error.trim();
  return reason
    ? `This page has stopped answering (${reason}), so the address and anything read from it may be out of date. Reload to try again.`
    : "This page has stopped answering, so the address and anything read from it may be out of date. Reload to try again.";
}

/** What to put in the live region, or `null` to leave it alone. */
export function announcement(
  prev: BrowserInfo | null,
  next: BrowserInfo,
): string | null {
  if (identity(prev) === identity(next)) return null;
  return announcementForChangedInfo(next);
}

function announcementForChangedInfo(next: BrowserInfo): string {
  // The end of a browsing sitting is an EVENT, and it is the one that clears
  // the session. A sighted user watches the chrome go blank; this is the only
  // way anyone else learns it happened.
  if (!next.open) {
    return "All private pages are closed. This browsing session is cleared — its history, cookies and cache are gone.";
  }
  if (next.blank) return "New tab. Nothing is loaded yet — type an address or a search.";
  // A page that stopped answering is the one state where the address bar and
  // the truth can disagree, so it outranks everything else.
  if (next.error) return `This page is not answering. ${next.error}`;

  return pageAnnouncement(next);
}

function pageAnnouncement(next: BrowserInfo): string {
  const host = hostOf(next.url);
  const where = host ?? next.url ?? "an unnamed page";
  const title = (next.title ?? "").trim();
  if (next.ready !== "complete") {
    return `Loading ${where}.${guardClause(next)}`;
  }

  return loadedPageAnnouncement(next, where, title);
}

function loadedPageAnnouncement(next: BrowserInfo, where: string, title: string): string {
  // The scheme is SPOKEN, not left to a padlock icon: "anything you type into
  // this page travels in the clear" is not something to encode as a glyph.
  const wire = next.url?.startsWith("http://") === true ? " Not encrypted." : "";
  const guard = guardClause(next);
  return title
    ? `Loaded: ${title}. ${where}.${wire}${guard}`
    : `Loaded ${where}. This page has no title.${wire}${guard}`;
}
