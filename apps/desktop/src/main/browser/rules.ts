// BROWSE-1: content blocking, ported as INTENT rather than as WebKit's
// constrained `url-filter` DSL.
//
// Port of src-tauri/src/browser/rules.rs. Two rule families, and the second is
// the security-critical one:
//
//  * Trackers/ads — a curated, deliberately small and high-confidence domain
//    list, blocked for THIRD-PARTY loads only, so the blocker never breaks a
//    page the user actually wanted.
//  * Private network ranges — blocked ALWAYS, first-party included. The
//    navigation guard never sees SUB-RESOURCES, so a page embedding
//    `<img src="http://localhost:11434/api/delete">` would otherwise reach the
//    user's own Ollama daemon. Same invariant as the guard, one layer down.
//
// ARCHITECTURE: no url-filter regex, no compiled rule list, no cache key.
//
// rules.rs's entire second half — "THE ONLY REGEX WebKit's url-filter compiler
// is known to accept", the digest-pinned `RULE_LIST_ID`, the avoidance of
// quantified groups and mid-pattern `$` — exists because
// `WKContentRuleListStore` compiles the JSON through a DFA over a small regex
// subset and REJECTS THE WHOLE LIST, silently, the moment one pattern falls
// outside it (a real shipped incident: `WKErrorDomain` error 6, no diagnostic
// naming the offending pattern, and a browser running with no blocking at all).
// None of that is a property of the POLICY; it is a property of one compiler.
// Chromium's `session.webRequest.onBeforeRequest` is a plain JavaScript
// callback invoked per request — no compiler, no subset, no bulk-rejection
// failure mode — so the policy is expressed here as ordinary predicates over a
// parsed host, and the cache-key/digest machinery is not ported because there
// is no compiled artifact for a stale one to serve.
//
// THE PRIVATE-RANGE CHECK IS NOT A SECOND COPY. It reuses `isPublicIp` from
// guard.ts — the exact function `checkPublicHttpUrl` (the navigation-time
// guard) classifies literal addresses with. rules.rs's own doc comment demands
// the two layers "stay in step" and spends a whole test
// (`private_filters_match_exactly_the_hosts_the_guard_rejects`) reconciling a
// parallel regex list against the guard. Sharing one function is the stronger
// version of that guarantee; the test is ported anyway, because it is what
// makes the claim checkable rather than asserted.
//
// ONE DELIBERATE, FLAGGED DIVERGENCE. rules.rs matches URL TEXT, so
// `^https?://10\.` also blocks the hostname `10.example.com`. Its own test
// comment accepts that as a side effect ("over-blocking a sub-resource is safe,
// under-blocking is not") forced by a regex having no concept of "is this
// actually an IP literal". This port classifies the PARSED hostname, so it does
// not reproduce that over-block — which also means it agrees with
// `checkPublicHttpUrl` (which lets that name through) in BOTH directions rather
// than only one. Reproducing the over-block would mean going back to text
// matching for no security benefit; the difference is tested explicitly in
// rules.test.ts rather than left to be discovered.

import { isIP } from "node:net";
import { isPublicIp } from "./guard.js";
import { stripWww } from "./navGuard.js";

/** Ad/tracker/telemetry hosts. Verbatim port of `TRACKER_DOMAINS`. */
export const TRACKER_DOMAINS: readonly string[] = [
  // Google's ad + analytics estate
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "google-analytics.com",
  "googletagmanager.com",
  "googletagservices.com",
  "adservice.google.com",
  "analytics.google.com",
  // Meta
  "connect.facebook.net",
  "pixel.facebook.com",
  // Amazon ads
  "amazon-adsystem.com",
  "assoc-amazon.com",
  // Large ad exchanges / SSPs
  "adnxs.com",
  "rubiconproject.com",
  "pubmatic.com",
  "openx.net",
  "criteo.com",
  "criteo.net",
  "casalemedia.com",
  "smartadserver.com",
  "adform.net",
  "taboola.com",
  "outbrain.com",
  "sharethrough.com",
  "33across.com",
  "indexww.com",
  "bidswitch.net",
  "spotxchange.com",
  "teads.tv",
  "yieldmo.com",
  "media.net",
  "adroll.com",
  "quantserve.com",
  "quantcast.com",
  "scorecardresearch.com",
  "moatads.com",
  "adsrvr.org",
  "everesttech.net",
  "serving-sys.com",
  "zedo.com",
  // Analytics / session recording / behavioural
  "hotjar.com",
  "hotjar.io",
  "mouseflow.com",
  "fullstory.com",
  "luckyorange.com",
  "inspectlet.com",
  "crazyegg.com",
  "clarity.ms",
  "mixpanel.com",
  "segment.io",
  "segment.com",
  "amplitude.com",
  "heap.io",
  "heapanalytics.com",
  "kissmetrics.com",
  "statcounter.com",
  "chartbeat.com",
  "parsely.com",
  "newrelic.com",
  "nr-data.net",
  "optimizely.com",
  "branch.io",
  "appsflyer.com",
  "adjust.com",
  "kochava.com",
  "braze.com",
  "onesignal.com",
  "matomo.cloud",
  // Ad tech misc
  "bluekai.com",
  "krxd.net",
  "demdex.net",
  "omtrdc.net",
  "2o7.net",
  "adobedtm.com",
  "exelator.com",
  "tapad.com",
  "liveramp.com",
  "rlcdn.com",
  "agkn.com",
  "mathtag.com",
  "turn.com",
  "adsymptotic.com",
  "yieldlab.net",
  "improvedigital.com",
  "gumgum.com",
  "sovrn.com",
  "lijit.com",
];

/**
 * Every scheme a page can reach a local service over. `http(s)` is the
 * sub-resource case; `ws(s)` is the same reach by another name — script with no
 * rule for it can open `ws://127.0.0.1:PORT/` against every port on this Mac
 * and time the failures to enumerate what is listening, and no navigation hook
 * ever sees a WebSocket. Port of `PRIVATE_SCHEME_PREFIXES`.
 */
const PRIVATE_RANGE_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "ws:", "wss:"]);

/** Schemes tracker blocking applies to: `domain_filters` only ever emitted
 *  `^https?://` patterns, so this stays identical rather than quietly widening
 *  the policy while porting it. */
const TRACKER_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * Lowercase, drop the brackets an IPv6 literal carries in `URL.hostname`, and
 * strip the trailing DNS ROOT LABEL.
 *
 * The trailing dot matters and is the one place this port is deliberately
 * STRICTER than the Rust regex: `localhost.` resolves exactly like `localhost`
 * and every service on this Mac answers it, but `^https?://localhost[:/]` does
 * not match `http://localhost./` — the same hole guard.ts's own comment records
 * closing on the navigation side ("http://localhost.:11434/ walked straight
 * through this check"). Closing it here keeps the two layers in step.
 */
function normalizeHost(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.+$/, "");
}

/**
 * `example.com` matches itself and any subdomain of it. The two-rule split
 * `domain_filters` needed (a quantified group is one of the two constructs
 * WebKit's compiler refuses) collapses to one ordinary dot-anchored suffix
 * check once there is no such subset to respect. The leading dot is what stops
 * `notexample.com` matching `example.com`.
 */
export function isTrackerHost(
  hostname: string,
  domains: readonly string[] = TRACKER_DOMAINS,
): boolean {
  const host = normalizeHost(hostname);
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * Is this hostname a private-network destination? The classification
 * `PRIVATE_HOST_FILTERS` was a regex ENCODING of: `localhost`, anything under
 * `.local`, or a literal IP address outside the public ranges.
 *
 * A plain NAME is not private here — the literal check cannot see where a name
 * resolves. That is `needsHostRecheck`'s job on the navigation path, and
 * sub-resources get no equivalent recheck on either side of the port: an
 * accepted gap, not one this port introduces.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".local")) return true;
  if (isIP(host) === 0) return false;
  return !isPublicIp(host);
}

/** The resource kinds Chromium's `webRequest` reports. Kept as a named union so
 *  the `mainFrame` exemption below cannot be silently spelled wrong. */
export type RequestResourceType =
  | "mainFrame"
  | "subFrame"
  | "stylesheet"
  | "script"
  | "image"
  | "font"
  | "object"
  | "xhr"
  | "ping"
  | "cspReport"
  | "media"
  | "webSocket"
  | "other";

export interface ClassifyRequestInput {
  /** The request's own URL. Any scheme; anything outside the two sets above
   *  (`blob:`, `data:`, …) is left alone, matching the anchored scheme
   *  prefixes the Rust filters carried. */
  url: string;
  resourceType: RequestResourceType;
  /** The requesting frame's top-level URL, for third-party classification.
   *  `null` when it genuinely cannot be determined — treated as third-party,
   *  which is the safe-to-over-block side for an ads rule. */
  topLevelUrl: string | null;
}

export type BlockReason = "private-network" | "tracker";

/**
 * The one decision both the Rust rule list and this port exist to make: should
 * this request be blocked, and why?
 *
 * Private ranges are checked FIRST and apply to every load, first-party
 * included — mirroring `private_ranges_all_reach_the_compiled_list_and_come_first`,
 * whose assertion that no private-range rule carries a `load-type` is exactly
 * this ordering.
 *
 * A `mainFrame` request is never third-party relative to itself, so an ad rule
 * (which exists to stop OTHER pages embedding a tracker) must not refuse a
 * top-level load of the tracker's own site. That is WebKit's own third-party
 * determination for a top-level navigation, and it is not academic here: a
 * live Electron probe confirmed `details.frame.top.url` is the EMPTY STRING for
 * the main-frame request of a fresh navigation, so a port that derived
 * "third-party" purely from the frame tree would cancel every top-level
 * navigation to a listed domain.
 */
export function classifyRequest(input: ClassifyRequestInput): BlockReason | null {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return null;
  }
  const host = url.hostname;
  if (!host) return null;

  if (PRIVATE_RANGE_SCHEMES.has(url.protocol) && isPrivateHost(host)) {
    return "private-network";
  }
  if (!TRACKER_SCHEMES.has(url.protocol)) return null;
  if (input.resourceType === "mainFrame") return null;
  if (isThirdParty(host, input.topLevelUrl) && isTrackerHost(host)) {
    return "tracker";
  }
  return null;
}

/**
 * Is `requestHost` third-party relative to the page it was requested from?
 * Reuses exactly the comparison `same_site` makes (strip a leading `www.`,
 * compare hostnames case-insensitively) for a second purpose.
 *
 * No top-level URL on record is treated as third-party, so tracker blocking
 * still applies rather than going quiet during the window before a page's first
 * navigation lands.
 */
export function isThirdParty(requestHost: string, topLevelUrl: string | null): boolean {
  if (!topLevelUrl) return true;
  let top: URL;
  try {
    top = new URL(topLevelUrl);
  } catch {
    return true;
  }
  if (!top.hostname) return true;
  return stripWww(requestHost.toLowerCase()) !== stripWww(top.hostname.toLowerCase());
}
