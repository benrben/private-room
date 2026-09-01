import { Agent } from "undici";
import { checkPublicHttpUrl, resolvePublicAddr } from "./browser/guard.js";
import {
  HTTP_TIMEOUT_MS,
  authMetadataUrls,
  asRecord,
  errMessage,
  type AuthServerMeta,
  type TokenSet,
  type RefreshOutcome,
  TokenRequestError,
  parseAuthServerMetadata,
  parsePrmScopes,
  parseResourceMetadata,
  canRefresh,
  markRefreshRejected,
  mergeRefreshed,
  needsRefresh,
  nowSecs,
} from "./mcpOauthModel.js";

export interface OutboundGuard {
  checkEndpoint(url: string): URL;
  resolveAddr(host: string, port: number): Promise<{ address: string; port: number }>;
}

/** Every address in this flow that the CONNECTOR chose, checked before this
 * goes anywhere near it. Ported from `checked_endpoint` — wraps whatever
 * `checkPublicHttpUrl` throws into the ONE fixed message, matching Rust's
 * `.map_err(|_| format!("{url} is a local or private-network address —
 * refused."))`. */
function checkedEndpoint(url: string): URL {
  try {
    return checkPublicHttpUrl(url);
  } catch {
    throw new Error(`${url} is a local or private-network address — refused.`);
  }
}

export const REAL_GUARD: OutboundGuard = {
  checkEndpoint: checkedEndpoint,
  resolveAddr: resolvePublicAddr,
};

/** One guarded HTTP round trip's reply, read to completion. The body is read
 * HERE, before the pinned dispatcher is closed — an undici `Agent` closed while
 * a response body is still unread either strands the caller or truncates it, so
 * "hand the caller a live `Response` and clean up in a `finally`" is not
 * available to this shape. */
interface GuardedReply {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
  /** The URL that was actually checked and dialled — a relative `Location` is
   * absolutized against this. */
  parsedUrl: URL;
}

/**
 * One hop of one OAuth request, with the whole outbound guard on it.
 *
 * The literal check only sees what the connector WROTE. A hostname it controls
 * can still resolve to 127.0.0.1 (DNS rebinding), so the host is resolved here
 * and every address it returns has to be public — and the connection is then
 * PINNED to the address that was checked, closing the window where the check
 * and the connection resolve differently. Ported from `guarded_client`,
 * adapted: reqwest's `.resolve(host, addr)` pins a hostname→address mapping on
 * the CLIENT; undici's equivalent is a one-shot `Agent` whose `connect.lookup`
 * always answers with the checked address, handed to `fetch` via its
 * `dispatcher` option (the same option `sidecar.ts` already uses for its own
 * long-lived streaming `Agent`). Redirects are never followed automatically
 * (`redirect: "manual"`) for the same reason reqwest's policy is disabled here:
 * a `Location` is chosen by the same untrusted server, so it must come back
 * through this function ({@link fetchJsonMetadata}) or not be followed at all
 * (every other caller treats an unfollowed redirect as an ordinary non-2xx
 * failure, matching Rust).
 */
async function guardedRequest(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  guard: OutboundGuard = REAL_GUARD
): Promise<GuardedReply> {
  const target = await guardedTarget(url, guard);
  const dispatcher = pinnedDispatcher(target.address);
  try {
    return await fetchGuardedReply(url, init, timeoutMs, dispatcher, target.parsedUrl);
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}

interface GuardedTarget {
  parsedUrl: URL;
  address: { address: string; port: number };
}

async function guardedTarget(url: string, guard: OutboundGuard): Promise<GuardedTarget> {
  const parsedUrl = guard.checkEndpoint(url);
  const host = parsedUrl.hostname;
  if (host === "") {
    throw new Error(`${url} has no host — refused.`);
  }
  const port = endpointPort(parsedUrl);
  const address = await resolvedGuardedAddress(url, guard, host, port);
  return { parsedUrl, address };
}

function endpointPort(url: URL): number {
  return url.port !== "" ? Number(url.port) : url.protocol === "http:" ? 80 : 443;
}

async function resolvedGuardedAddress(
  url: string,
  guard: OutboundGuard,
  host: string,
  port: number
): Promise<{ address: string; port: number }> {
  try {
    return await guard.resolveAddr(host, port);
  } catch (e) {
    throw new Error(`${url}: ${errMessage(e)}`);
  }
}

function pinnedDispatcher(address: { address: string; port: number }): Agent {
  const family = address.address.includes(":") ? 6 : 4;
  return new Agent({
    connect: {
      lookup: (
        _hostname: string,
        options: { all?: boolean } | undefined,
        callback: (
          err: Error | null,
          address: string | Array<{ address: string; family: number }>,
          family?: number,
        ) => void
      ) => {
        respondWithPinnedAddress(address.address, family, options, callback);
      },
    },
  });
}

function respondWithPinnedAddress(
  address: string,
  family: number,
  options: { all?: boolean } | undefined,
  callback: (
    err: Error | null,
    address: string | Array<{ address: string; family: number }>,
    family?: number
  ) => void
): void {
  // Node 20+ asks custom lookup functions for `all: true` while its
  // Happy-Eyeballs connector is active. Returning the legacy `(address,
  // family)` shape to that request makes node:net read `address.address` from
  // a string and throw ERR_INVALID_IP_ADDRESS.
  const all = options?.all === true;
  callback(null, all ? [{ address, family }] : address, all ? undefined : family);
}

async function fetchGuardedReply(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  dispatcher: Agent,
  parsedUrl: URL
): Promise<GuardedReply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
      // The standalone `undici` package's `Dispatcher` type and the
      // `undici-types` bundled into @types/node (what global `fetch`'s
      // `RequestInit` is structurally checked against) are two separately
      // versioned copies of the same shape — real at runtime (Node's fetch IS
      // undici), a false mismatch at the type level. Same cast `sidecar.ts`
      // already uses for its own long-lived streaming `Agent`.
      dispatcher,
    } as unknown as RequestInit);
    const text = await response.text();
    return { status: response.status, ok: response.ok, headers: response.headers, text, parsedUrl };
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`request to ${url} timed out`);
    }
    throw new Error(`request to ${url} failed: ${errMessage(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** JSON out of a guarded reply's body, with the Rust source's own wording for
 * an unreadable document. */
function replyJson(reply: GuardedReply, url: string): unknown {
  try {
    return JSON.parse(reply.text);
  } catch (e) {
    throw new Error(`${url} sent invalid JSON: ${errMessage(e)}`);
  }
}

/** How many redirects one metadata fetch may follow. Every hop is re-checked by
 * {@link guardedRequest}, which is the only reason following them is safe. */
const MAX_REDIRECTS = 3;

/** Where a response says to go next, absolutized against the URL it came from.
 * `null` for anything that is not a redirect carrying a usable `Location` —
 * which then falls through to the normal status handling. Ported verbatim from
 * `redirect_target`. */
export function redirectTarget(status: number, location: string | null, from: URL): string | null {
  if (![301, 302, 303, 307, 308].includes(status)) return null;
  const loc = location?.trim();
  if (loc === undefined || loc === "") return null;
  try {
    return new URL(loc, from).toString();
  } catch {
    return null;
  }
}

/** Fetch a JSON metadata document, following (and re-checking) redirects.
 * Ported from `fetch_json`. */
async function fetchJsonMetadata(url: string, guard: OutboundGuard = REAL_GUARD): Promise<unknown> {
  let next = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const reply = await guardedRequest(
      next,
      { method: "GET", headers: { Accept: "application/json" } },
      HTTP_TIMEOUT_MS,
      guard
    );
    const hop = redirectTarget(reply.status, reply.headers.get("location"), reply.parsedUrl);
    if (hop !== null) {
      next = hop;
      continue;
    }
    if (!reply.ok) {
      throw new Error(`${next} returned HTTP ${reply.status}`);
    }
    return replyJson(reply, next);
  }
  throw new Error(`${url} redirected too many times`);
}

/**
 * PRM URL candidates → the auth server's endpoints, plus the scopes the
 * RESOURCE asks for. Follows RFC 9728 → RFC 8414.
 *
 * Every candidate is tried before the sign-in is declared impossible: a
 * resource may publish its metadata under either well-known form, and a
 * document listing several authorization servers means the first one being down
 * or misconfigured is not the resource's last word. Only the final failure is
 * reported — an earlier 404 on a URL that was only ever a guess is not what went
 * wrong. Ported verbatim from `discover`.
 */
export async function discover(
  prmUrls: readonly string[],
  guard: OutboundGuard = REAL_GUARD
): Promise<{ meta: AuthServerMeta; scopes: string[] }> {
  let last = "no protected-resource metadata URL to try";
  for (const prmUrl of prmUrls) {
    const prmAttempt = await metadataAttempt(prmUrl, guard);
    if ("error" in prmAttempt) {
      last = prmAttempt.error;
      continue;
    }
    const scopes = parsePrmScopes(prmAttempt.value);
    const servers = parseResourceMetadata(prmAttempt.value);
    if (servers.length === 0) {
      last = `${prmUrl} lists no authorization servers`;
      continue;
    }
    const authAttempt = await authorizationMetadata(servers, guard);
    if (authAttempt.meta !== null) {
      return { meta: authAttempt.meta, scopes };
    }
    last = authAttempt.last;
  }
  throw new Error(last);
}

type MetadataAttempt = { value: unknown } | { error: string };

async function metadataAttempt(url: string, guard: OutboundGuard): Promise<MetadataAttempt> {
  try {
    return { value: await fetchJsonMetadata(url, guard) };
  } catch (e) {
    return { error: errMessage(e) };
  }
}

interface AuthorizationMetadataAttempt {
  meta: AuthServerMeta | null;
  last: string;
}

async function authorizationMetadata(
  servers: readonly string[],
  guard: OutboundGuard
): Promise<AuthorizationMetadataAttempt> {
  let last = "no authorization-server metadata URL to try";
  for (const server of servers) {
    for (const url of authMetadataUrls(server)) {
      const attempt = await metadataAttempt(url, guard);
      if ("error" in attempt) {
        last = attempt.error;
        continue;
      }
      const meta = parseAuthServerMetadata(attempt.value);
      if (meta !== null) return { meta, last };
      last = `${url} is missing required endpoints`;
    }
  }
  return { meta: null, last };
}

/** RFC 7591 dynamic client registration for a public + PKCE client. Ported from
 * `register_client`. */
export async function registerClient(
  endpoint: string,
  redirectUri: string,
  guard: OutboundGuard = REAL_GUARD
): Promise<string> {
  const body = {
    client_name: "Arcelle",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  let reply: GuardedReply;
  try {
    reply = await guardedRequest(
      endpoint,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      HTTP_TIMEOUT_MS,
      guard
    );
  } catch (e) {
    throw new Error(`client registration failed: ${errMessage(e)}`);
  }
  if (!reply.ok) {
    throw new Error(`client registration returned HTTP ${reply.status}`);
  }
  const v = asRecord(replyJson(reply, endpoint));
  if (typeof v["client_id"] !== "string") {
    throw new Error("registration response had no client_id");
  }
  return v["client_id"];
}

async function postToken(
  endpoint: string,
  form: Record<string, string>,
  clientId: string,
  guard: OutboundGuard = REAL_GUARD
): Promise<TokenSet> {
  // Unreachable, not Rejected: a refused address says nothing about whether the
  // stored refresh token is still good, and `markRefreshRejected` must not
  // retire a live sign-in over it.
  let reply: GuardedReply;
  try {
    reply = await guardedRequest(
      endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
      },
      HTTP_TIMEOUT_MS,
      guard
    );
  } catch (e) {
    throw new TokenRequestError(`token request failed: ${errMessage(e)}`, false);
  }
  let v: unknown;
  try {
    v = JSON.parse(reply.text);
  } catch (e) {
    // A reply that can't be read is not a refusal — don't retire a sign-in for it.
    throw new TokenRequestError(errMessage(e), false);
  }
  const r = asRecord(v);
  if (!reply.ok) {
    const msg =
      typeof r["error_description"] === "string"
        ? r["error_description"]
        : typeof r["error"] === "string"
          ? r["error"]
          : "token request rejected";
    throw new TokenRequestError(msg, true);
  }
  return parseTokenResponse(v, clientId);
}

/** Exchange the authorization code for tokens (RFC 6749 §4.1.3 + PKCE). Ported
 * from `exchange_code`. */
export async function exchangeCode(
  tokenEndpoint: string,
  clientId: string,
  code: string,
  verifier: string,
  redirectUri: string,
  guard: OutboundGuard = REAL_GUARD
): Promise<TokenSet> {
  const form = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  };
  return postToken(tokenEndpoint, form, clientId, guard);
}

/** Refresh an expired access token (RFC 6749 §6). A stored `token_endpoint` +
 * `client_id` + `refresh_token` is all it needs, so no re-discovery. Driven by
 * {@link refreshIfExpiring}, which every connector connect runs first. Ported
 * verbatim from `refresh_tokens`. */
export async function refreshTokens(
  tokenEndpoint: string,
  clientId: string,
  refreshToken: string,
  guard: OutboundGuard = REAL_GUARD
): Promise<TokenSet> {
  const form = { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId };
  return postToken(tokenEndpoint, form, clientId, guard);
}

/**
 * Parse a token endpoint response into a `TokenSet`. Ported from
 * `parse_token_response`: a negative `expires_in`, or one that is not a number
 * at all, is "unknown" (0) rather than an expiry in the past — the same answer
 * Rust's `as_u64()` gives.
 *
 * DEVIATION (deliberate, one value): a POSITIVE but fractional `expires_in`
 * (`3599.5`) is truncated to a real expiry here, where Rust's `as_u64()` refuses
 * the float and calls it unknown. RFC 6749 §5.1 says the value is an integer, so
 * this is a malformed provider either way — but "unknown" means the token is
 * never renewed ahead of time, which is precisely the dead-pass-after-an-hour
 * failure `refreshed_oauth_config` was written to fix. Truncating renews it
 * instead; nothing downstream can be worse off, because an expiry that is wrong
 * by under a second is still an expiry.
 */
export function parseTokenResponse(v: unknown, clientId: string): TokenSet {
  const r = asRecord(v);
  const expiresIn = r["expires_in"];
  const expiresAt =
    typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn >= 0
      ? nowSecs() + Math.trunc(expiresIn)
      : 0;
  return {
    accessToken: typeof r["access_token"] === "string" ? r["access_token"] : "",
    refreshToken: typeof r["refresh_token"] === "string" ? r["refresh_token"] : null,
    expiresAt,
    clientId,
    tokenEndpoint: null,
    // A set the provider just issued is renewable by definition.
    refreshRejected: false,
  };
}

/**
 * Renew a stored token that is at (or near) expiry, returning the token set to
 * persist. `null` means "nothing to do": the token is still good, or there is
 * nothing to renew it with and the user has to sign in again by hand. Ported
 * from `refresh_if_expiring`.
 */
export async function refreshIfExpiring(
  stored: TokenSet,
  guard: OutboundGuard = REAL_GUARD
): Promise<RefreshOutcome> {
  const details = refreshDetails(stored);
  if (details === null) return null;
  return requestRefresh(stored, details, guard);
}

interface RefreshDetails {
  endpoint: string;
  clientId: string;
  refreshToken: string;
}

function refreshDetails(stored: TokenSet): RefreshDetails | null {
  if (!needsRefresh(stored)) return null;
  if (!canRefresh(stored)) return null;
  return {
    endpoint: stored.tokenEndpoint as string,
    clientId: stored.clientId as string,
    refreshToken: stored.refreshToken as string,
  };
}

async function requestRefresh(
  stored: TokenSet,
  details: RefreshDetails,
  guard: OutboundGuard
): Promise<RefreshOutcome> {
  try {
    const fresh = await refreshTokens(details.endpoint, details.clientId, details.refreshToken, guard);
    return refreshedOutcome(stored, fresh);
  } catch (e) {
    return failedRefreshOutcome(e);
  }
}

function refreshedOutcome(stored: TokenSet, fresh: TokenSet): RefreshOutcome {
  if (fresh.accessToken !== "") return { ok: true, token: mergeRefreshed(stored, fresh) };
  // A 200 with no token is not a renewal — merging it would write an empty
  // `Bearer` header over the working one. The endpoint answered, so retrying
  // gains nothing.
  return { ok: false, error: new TokenRequestError("the refresh response carried no access token", true) };
}

function failedRefreshOutcome(error: unknown): RefreshOutcome {
  // Anything that is not a token-endpoint answer is a transport failure, and a
  // transport failure must never retire a sign-in.
  const tokenError = error instanceof TokenRequestError ? error : new TokenRequestError(errMessage(error), false);
  return { ok: false, error: tokenError };
}

/**
 * Probe a remote MCP URL for its `WWW-Authenticate` header — the direct route
 * to the resource-metadata URL (RFC 9728) when the server sends one. Best
 * effort: `null` on any error falls back to the well-known PRM path.
 *
 * DELIBERATELY UNGUARDED, matching the Rust source exactly: this is the one
 * request in the whole flow whose address the user themselves configured (a
 * connector's own `url`), not one named by a document the connector handed back
 * — an MCP server on this Mac is a legitimate thing to connect to, and routing
 * this through {@link guardedRequest} would refuse every local connector's own
 * OAuth probe. Ported verbatim from `probe_www_authenticate`.
 */
export async function probeWwwAuthenticate(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "Arcelle", version: "probe" },
        },
      }),
    });
    if (resp.status !== 401) return null;
    return resp.headers.get("www-authenticate");
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------ loopback callback

/** How long one connection has to send its request line. Short: the browser has
 * already made the request by the time it connects. */
