/* BROWSE-3: what the address bar does with what you typed.
 *
 * The placeholder has always said "Search or enter a web address"; until now
 * only the second half existed, and typing "best pizza nyc" produced
 * `Invalid URL: https://best pizza nyc`. This is the missing half.
 *
 * The one rule worth defending: a FAILED navigation never silently becomes a
 * search. Typing an internal hostname that doesn't resolve must not broadcast
 * it to seven engines — the error banner offers a search button instead, so
 * the leak requires a deliberate click. Everything here is decided BEFORE
 * anything is sent anywhere, from the text alone.
 */

export type AddressIntent =
  | { kind: "url"; url: string }
  | { kind: "search"; query: string };

/** A single token that is really a host: `example.com`, `x.co/path`,
 *  `localhost:3000`, `192.168.1.1`. The guard still refuses the private ones
 *  by name — this only decides whether the text was ADDRESSED at something. */
const HOSTISH = /^[^\s/?#]+\.[^\s/?#.]{2,}([/:?#].*)?$/;
const HOST_PORT = /^[^\s/?#]+:\d+([/?#].*)?$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#].*)?$/;

function forcedSearch(text: string): AddressIntent | null | undefined {
  if (!text.startsWith("?")) return undefined;
  const query = text.slice(1).trim();
  return query ? { kind: "search", query } : null;
}

function hostLike(text: string): boolean {
  return HOSTISH.test(text) || IPV4.test(text) || HOST_PORT.test(text);
}

function inferredIntent(text: string): AddressIntent {
  if (hostLike(text)) return { kind: "url", url: `https://${text}` };
  return { kind: "search", query: text };
}

/** Decide what the user meant. `null` means "nothing to do" (empty input).
 *
 * Order matters: the explicit forms (`?` and a scheme) win over the guesses,
 * so there is always a way to force either behavior on ambiguous text. */
export function classifyAddress(input: string): AddressIntent | null {
  const text = input.trim();
  if (!text) return null;

  // "?query" — force a search for text that would otherwise look like a host.
  const forced = forcedSearch(text);
  if (forced !== undefined) return forced;

  // An explicit scheme is a decision the user already made.
  if (text.includes("://")) return { kind: "url", url: text };

  // No URL has a space in it. This is the case that used to produce the
  // developer-shaped `Invalid URL:` banner.
  if (/\s/.test(text)) return { kind: "search", query: text };

  // A bare word: "weather", "בנק ישראל". Nothing about it addresses a host.
  return inferredIntent(text);
}

/** Must this address be FETCHED to be saved, rather than read off the page
 *  that is already on screen?
 *
 *  Two cases, and only two. A video page's value is its CAPTIONS, which the
 *  rendered DOM does not contain; a PDF/image/archive is a binary that has to
 *  go through the download funnel. `import_link` handles both — capturing the
 *  live page would save neither.
 *
 *  For anything else the live page WINS: the toolbar's "Save link" used to
 *  re-fetch the address as a stranger even with the page open in front of you,
 *  so a signed-in or paywalled article saved its sign-in wall under the real
 *  page's title. Nothing said so.
 */
export function needsFreshFetch(url: string): boolean {
  let path = "";
  let host = "";
  try {
    const u = new URL(url);
    path = u.pathname.toLowerCase();
    host = u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    // Not parseable: the live page is the only thing we could read anyway.
    return false;
  }
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return true;
  return /\.(pdf|docx?|pptx?|xlsx?|csv|zip|png|jpe?g|gif|webp|mp[34]|m4a|mov|epub)$/.test(
    path,
  );
}
