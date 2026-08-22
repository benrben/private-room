/**
 * Port of `browse_guard_url` (`src-tauri/src/commands/browse.rs`) — the FULL
 * guard for an address a person or the agent supplied: the literal
 * public-address check AND a DNS resolve, which the synchronous navigation
 * hook cannot afford to do inline.
 *
 * Both halves are already ported in `guard.ts` (`checkPublicHttpUrl`, and
 * SEC-5's `resolvePublicAddr` rebinding recheck), so this is a composition,
 * not a new guard. It stays its own module because it is the one call that
 * touches the NETWORK before anything is fetched — `browser.ts`'s own
 * `guardDestination` is deliberately the literal half only.
 */

import { checkPublicHttpUrl, resolvePublicAddr } from "./guard.js";

/**
 * Refuse a private or non-web address by name, then resolve its host and
 * refuse it again if DNS disagrees. Answers the URL in its normalized
 * spelling — the same string everything downstream caches, journals and
 * navigates under.
 */
export async function browseGuardUrl(url: string): Promise<string> {
  const parsed = checkPublicHttpUrl(url);
  const host = parsed.hostname;
  if (!host) {
    throw new Error("Invalid URL: no host.");
  }
  // Rust's `port_or_known_default()`: the URL's own port, else the scheme's.
  // `checkPublicHttpUrl` has already refused anything that is not http(s).
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "http:" ? 80 : 443;
  await resolvePublicAddr(host, port);
  return parsed.toString();
}
