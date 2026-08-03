/** Pure text helpers for the connector marketplace cards and drawer.
 *
 * They live outside `McpMarketplace.tsx` because both of them answer a question
 * about UNTRUSTED registry data — a name and a URL that came straight off the
 * public MCP registry — and that is exactly the kind of thing worth pinning
 * down in a test rather than in a component render.
 */

/** The monogram for a connector with no icon.
 *
 * Deliberately Unicode-aware. The first version stripped everything outside
 * `[A-Za-z0-9 ]` before taking initials, so a connector named only in Chinese,
 * Japanese, Hebrew or Arabic produced an EMPTY string and rendered as a blank
 * coloured square — the one visual identity a card has, gone, for exactly the
 * names a Latin-alphabet reader most needs help telling apart.
 *
 * The rule is the OLD one, generalized: punctuation and symbols are dropped
 * (not turned into separators, so "postgres-mcp server" still reads "PS"),
 * whitespace still splits words, and letters/digits in ANY script now count.
 * A name with no letters or digits at all (all emoji, all symbols) falls back
 * to its first visible character, and only a completely blank name yields "?" —
 * the tile is never empty.
 */
export function initials(name: string): string {
  const words = (name ?? "")
    .replace(/[^\p{L}\p{N}\s]+/gu, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const picked = words
    .slice(0, 2)
    .map((w) => Array.from(w)[0] ?? "")
    .join("");
  if (picked) return picked.toLocaleUpperCase();
  // No letters or digits anywhere — keep whatever the name's first visible
  // glyph is rather than showing nothing.
  const glyph = Array.from((name ?? "").trim())[0];
  return glyph ?? "?";
}

/** The host of a registry entry's endpoint, or "" when it is not a URL at all.
 *
 * `new URL(...)` THROWS on a malformed address, and the drawer read the host
 * during render: one catalogue entry missing its `https://` took the whole app
 * window blank. The registry's addresses are unchecked third-party data, so the
 * only safe assumption is that some of them are junk.
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Is this endpoint something the app could actually connect to? A remote entry
 * whose URL cannot be parsed can only fail at connect time, so the drawer says
 * so up front instead of offering an Install that cannot work. */
export function isUsableEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && !!parsed.host;
  } catch {
    return false;
  }
}
