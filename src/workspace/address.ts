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

/** Decide what the user meant. `null` means "nothing to do" (empty input).
 *
 * Order matters: the explicit forms (`?` and a scheme) win over the guesses,
 * so there is always a way to force either behavior on ambiguous text. */
export function classifyAddress(input: string): AddressIntent | null {
  const text = input.trim();
  if (!text) return null;

  // "?query" — force a search for text that would otherwise look like a host.
  if (text.startsWith("?")) {
    const query = text.slice(1).trim();
    return query ? { kind: "search", query } : null;
  }

  // An explicit scheme is a decision the user already made.
  if (text.includes("://")) return { kind: "url", url: text };

  // No URL has a space in it. This is the case that used to produce the
  // developer-shaped `Invalid URL:` banner.
  if (/\s/.test(text)) return { kind: "search", query: text };

  if (HOSTISH.test(text) || IPV4.test(text) || HOST_PORT.test(text)) {
    return { kind: "url", url: `https://${text}` };
  }

  // A bare word: "weather", "בנק ישראל". Nothing about it addresses a host.
  return { kind: "search", query: text };
}
