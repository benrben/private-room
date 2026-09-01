import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import { api } from "../api";
import type { BrowseClearScope, BrowseJournalRow, BrowserInfo, FileMeta } from "../apiTypes";
import { announcement, stalledBanner } from "./browserAnnounce";
import { infoAfterMissedPoll, MISSES_BEFORE_CLOSED, pageIsParked, type ChromeView } from "./browserChrome";
import { groupSessions, type JournalFacet } from "./browserJournal";

export const POLL_MS = 1200;
/** How long after a navigation event the title and readiness keep settling —
 *  one extra sample, rather than waiting out the slow tick. */
export const SETTLE_MS = 700;
export const ignoreSearchQuestion = (_query: string) => {};
export const ignoreAttachedFile = (_file: FileMeta) => {};

/** A journal row's time, in the reader's own zone.
 *
 * The rows are stored UTC (`...Z`). Printing that string with the `Z` filed off
 * dated 3pm work as noon — every other time in the app is local, and a record
 * you have to convert in your head is not a record you can check. */
export function journalTime(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime())
    ? at
    : d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" });
}

/** The scheme of the page actually on screen — `null` for a blank tab or an
 *  address that will not parse. */
export function schemeOf(url?: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

export function parkNativeBrowser(sentRef: MutableRefObject<string>): boolean {
  if (sentRef.current === "parked") return false;
  sentRef.current = "parked";
  void api.browserSetBounds(0, 0, 1, 1).catch(() => {});
  return true;
}

export function freshStageBounds(
  stageRef: RefObject<HTMLDivElement | null>,
  sentRef: MutableRefObject<string>,
): DOMRect | null {
  const element = stageRef.current;
  if (!element) return null;
  const bounds = element.getBoundingClientRect();
  if (bounds.width < 2 || bounds.height < 2) return null;
  const key = `${bounds.left},${bounds.top},${bounds.width},${bounds.height}`;
  if (key === sentRef.current) return null;
  sentRef.current = key;
  return bounds;
}

export function pushNativeBrowserBounds(
  chromeView: ChromeView,
  stageRef: RefObject<HTMLDivElement | null>,
  sentRef: MutableRefObject<string>,
) {
  if (pageIsParked(chromeView)) {
    parkNativeBrowser(sentRef);
    return;
  }
  const bounds = freshStageBounds(stageRef, sentRef);
  if (!bounds) return;
  void api
    .browserSetBounds(bounds.left, bounds.top, bounds.width, bounds.height)
    .catch(() => {});
}

export type ForgetPage = (typing: boolean) => void;

export function recordMissedBrowserInfo(
  missesRef: MutableRefObject<number>,
  wasOpenRef: MutableRefObject<boolean>,
  setInfo: Dispatch<SetStateAction<BrowserInfo>>,
  forgetThePage: ForgetPage,
  editing: boolean,
) {
  missesRef.current += 1;
  setInfo((previous) => infoAfterMissedPoll(previous, missesRef.current));
  if (missesRef.current >= MISSES_BEFORE_CLOSED && wasOpenRef.current) {
    wasOpenRef.current = false;
    forgetThePage(editing);
  }
}

export async function requestBrowserInfo(
  missesRef: MutableRefObject<number>,
  wasOpenRef: MutableRefObject<boolean>,
  setInfo: Dispatch<SetStateAction<BrowserInfo>>,
  forgetThePage: ForgetPage,
  editing: boolean,
): Promise<BrowserInfo | null> {
  try {
    const next = await api.browserInfo();
    missesRef.current = 0;
    return next;
  } catch {
    recordMissedBrowserInfo(
      missesRef,
      wasOpenRef,
      setInfo,
      forgetThePage,
      editing,
    );
    return null;
  }
}

export function recordBrowserSession(
  next: BrowserInfo,
  wasOpenRef: MutableRefObject<boolean>,
  setInfo: Dispatch<SetStateAction<BrowserInfo>>,
  forgetThePage: ForgetPage,
  editing: boolean,
) {
  setInfo(next);
  if (wasOpenRef.current && !next.open) forgetThePage(editing);
  wasOpenRef.current = next.open === true;
}

export function announceBrowserInfo(
  next: BrowserInfo,
  lastInfoRef: MutableRefObject<BrowserInfo | null>,
  setAnnounce: Dispatch<SetStateAction<string>>,
) {
  const said = announcement(lastInfoRef.current, next);
  lastInfoRef.current = next;
  if (said) setAnnounce(said);
}

export async function returnBrowserFocus(
  next: BrowserInfo,
  addressRef: RefObject<HTMLInputElement | null>,
  setAnnounce: Dispatch<SetStateAction<string>>,
) {
  if (!next.leaveRequested) return;
  await api.browserFocusApp().catch(() => {});
  addressRef.current?.focus();
  setAnnounce(
    "Keyboard returned to the browser toolbar. The address box has focus.",
  );
}

export function updateBrowserAddress(
  next: BrowserInfo,
  editing: boolean,
  searchOpenRef: RefObject<boolean>,
  setAddress: Dispatch<SetStateAction<string>>,
) {
  if (!editing && !searchOpenRef.current && next.url) setAddress(next.url);
}

export async function verifyBrowserPrivacy(
  next: BrowserInfo,
  verifiedForRef: MutableRefObject<string | null>,
  setEphemeral: Dispatch<SetStateAction<boolean | null>>,
) {
  if (!next.open) {
    setEphemeral(null);
    verifiedForRef.current = null;
    return;
  }
  const shieldFor = next.url ?? "";
  if (verifiedForRef.current === shieldFor) return;
  verifiedForRef.current = shieldFor;
  const answer = await api.browserVerifyPrivate().catch(() => null);
  if (answer === null) verifiedForRef.current = null;
  setEphemeral(answer);
}

export function browserIsLoading(info: BrowserInfo, blank: boolean, busy: boolean): boolean {
  return (
    busy ||
    (info.open === true && !blank && !info.error && info.ready !== "complete")
  );
}

export function browserResultsAreInFront(searchOpen: boolean, searching: boolean): boolean {
  return searchOpen || searching;
}

export function cachedBrowserItemCount(scope: BrowseClearScope | null): number {
  if (!scope) return 0;
  return scope.journal + scope.searches + scope.pages + scope.images;
}

export function browserJournalView(
  journal: BrowseJournalRow[],
  session: string | undefined,
  facets: JournalFacet[],
  showEarlier: boolean,
) {
  const allSessions = groupSessions(journal, session ?? "", facets);
  return {
    sessions: showEarlier ? allSessions : allSessions.slice(0, 1),
    earlier: Math.max(0, allSessions.length - 1),
  };
}

export function visibleBrowserUrl(
  resultsInFront: boolean,
  blank: boolean,
  url: string | null | undefined,
): string | null | undefined {
  if (resultsInFront || blank) return null;
  return url;
}

export function browserConnectionView(
  info: BrowserInfo,
  resultsInFront: boolean,
  blank: boolean,
) {
  const scheme = schemeOf(visibleBrowserUrl(resultsInFront, blank, info.url));
  const secure = scheme === "https:";
  return {
    stalled: resultsInFront ? null : stalledBanner(info),
    secure,
    insecure: scheme === "http:",
    schemeLabel: secure
      ? "Encrypted connection — this page was served over HTTPS."
      : "Not encrypted — this page was served over plain HTTP. Anything you type into it, including passwords, travels in the clear.",
  };
}
