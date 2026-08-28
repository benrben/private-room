// BROWSE-1: the pure predicates behind the synchronous navigation gate.
//
// Port of the "Guards" section of src-tauri/src/browser.rs: `is_recordable_url`,
// `is_app_link_scheme`, `same_site`, `believable_for`, `needs_host_recheck`.
// The stateful wiring these feed (`navigation_allowed`, the off-thread DNS
// recheck, `halt_private_navigation`) is Electron glue and lives in
// navigation.ts; everything here is a function of its arguments only.

import { isIP } from "node:net";

/**
 * Is this URL a real destination — something that defines what a page IS?
 * Only `http(s)`; `about:blank` (and any other scheme a view navigates to
 * internally) is a frame's idle state, never where the user went.
 *
 * THE VANISHING-PAGE BUG this exists for (owner report 2026-08-01): Google and
 * YouTube both create `about:blank` iframes, and a hook that recorded one as
 * the PAGE's url made `is_blank` true for a page that had loaded perfectly.
 */
export function isRecordableUrl(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

/**
 * Schemes that hand a link to ANOTHER app rather than load a web page.
 * Deliberately a short, named list — an everyday "email us" click is not an
 * attempt to reach this Mac, and reporting it as one put a red banner and a
 * permanent journal line on nothing at all. `file:`, `data:` and `javascript:`
 * at top level are NOT ordinary and keep the loud path.
 */
const APP_LINK_SCHEMES: ReadonlySet<string> = new Set([
  "mailto",
  "tel",
  "sms",
  "facetime",
  "facetime-audio",
  "callto",
  "webcal",
]);

/** `scheme` is accepted with or without the trailing colon `URL.protocol`
 *  carries, so callers can pass either without remembering which. */
export function isAppLinkScheme(scheme: string): boolean {
  const bare = scheme.endsWith(":") ? scheme.slice(0, -1) : scheme;
  return APP_LINK_SCHEMES.has(bare.toLowerCase());
}

/** Rust's `trim_start_matches("www.")` strips the prefix REPEATEDLY, so this
 *  does too — `www.www.example.com` and `example.com` compare equal on both
 *  sides of the port rather than only on one. */
export function stripWww(host: string): string {
  let out = host;
  while (out.startsWith("www.")) out = out.slice(4);
  return out;
}

/**
 * Is `next` the same site as the page's own record — same host past `www.`?
 * Port of `same_site`, including both of its "believe it" escape hatches: an
 * unparseable `current`, and a `current` with no host of its own
 * (`about:blank`) has nothing to contradict.
 *
 * Used for TWO jobs on this side, both documented at their call sites:
 * `believableFor` below, and third-party classification in rules.ts.
 */
export function sameSite(current: string, next: URL): boolean {
  let currentUrl: URL;
  try {
    currentUrl = new URL(current);
  } catch {
    return true;
  }
  const a = currentUrl.hostname;
  const b = next.hostname;
  if (!a) return true;
  if (!b) return false;
  return stripWww(a.toLowerCase()) === stripWww(b.toLowerCase());
}

/**
 * Does a navigation reported for a page describe the PAGE, or one of its
 * frames? Port of `believable_for`.
 *
 * ON THIS SIDE OF THE PORT THIS IS A BACKSTOP, NOT THE MECHANISM. wry's
 * `on_navigation` fired for sub-frames and could not tell them apart, which is
 * the entire reason this heuristic had to exist. Electron's
 * `will-frame-navigate` hands over a real `isMainFrame` boolean, so
 * navigation.ts only records a main-frame navigation and a sub-frame can never
 * touch the record at all — ground truth instead of a guess. Kept exported and
 * tested because the record can also be corrected from the info poll's own
 * `location.href` (`TabRegistry.recordActiveUrl`), where the same question is
 * asked of an answer that did not come with a frame flag.
 */
export function believableFor(
  isActivePage: boolean,
  recordedUrl: string | null | undefined,
  next: URL,
): boolean {
  if (isActivePage) return true;
  return recordedUrl === null || recordedUrl === undefined || sameSite(recordedUrl, next);
}

/**
 * Does this ALLOWED navigation still need its host resolved (DNS) before it can
 * be trusted? Port of `needs_host_recheck`.
 *
 * The literal check only reads the ADDRESS TEXT, and a perfectly ordinary NAME
 * can point at this Mac. An IP LITERAL needs no recheck: the literal check
 * already classified it exactly, in both directions. Only a NAME can say one
 * thing and mean another.
 */
export function needsHostRecheck(url: URL): boolean {
  if (!isRecordableUrl(url)) return false;
  const host = url.hostname;
  if (!host) return false;
  // `hostname` keeps the brackets on an IPv6 literal; strip them or every
  // `[::1]` would be re-resolved as a name.
  const bracketless = host.replace(/^\[/, "").replace(/\]$/, "");
  return isIP(bracketless) === 0;
}

/** The port a host would be reached on, for the off-thread recheck's parity
 *  with Rust's `port_or_known_default()`. */
export function portFor(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "http:" ? 80 : 443;
}
