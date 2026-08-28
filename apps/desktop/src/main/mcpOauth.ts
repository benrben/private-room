/**
 * OAuth 2.1 for remote MCP connectors (MCP authorization spec, 2025-06-18).
 * Ported from `src-tauri/src/commands/mcp_oauth.rs` (1313 lines).
 *
 * Hosted servers (GitHub, Notion, Stripe…) answer an unauthenticated request
 * with `401` + a `WWW-Authenticate` header pointing at their Protected Resource
 * Metadata (RFC 9728). From there this discovers the Authorization Server (RFC
 * 8414), registers a public client (RFC 7591 dynamic client registration), and
 * runs the authorization-code flow with PKCE (RFC 7636) through the system
 * browser and a loopback redirect. The resulting token is stored (like
 * `leash_token`) via `db-host/settings.ts`'s `getSetting`/`setSetting` and
 * attached as a `Bearer` header when the connector connects.
 *
 * WIRE COMPATIBILITY: `.room` files open IN PLACE across the Tauri→Electron
 * migration, so a token this module reads or writes must round-trip through the
 * exact JSON shape Rust's `TokenSet` serializes (`access_token`,
 * `refresh_token`, `expires_at`, `client_id`, `token_endpoint`,
 * `refresh_rejected` — snake_case, `#[serde(default)]` on everything but
 * `access_token`). {@link saveTokens}/{@link loadTokens} are the only two
 * functions that know that shape; everywhere else uses the idiomatic camelCase
 * {@link TokenSet}.
 *
 * NOTHING HERE IS STUBBED, including the interactive half. {@link authorize}
 * takes `openBrowser` as an INJECTED function — exactly like the Rust source's
 * own `impl Fn(&str) -> Result<(), String>` parameter — so opening the system
 * browser (Electron's `shell.openExternal`, supplied by the caller) never needs
 * a round trip to a renderer process. The loopback callback listener is a real
 * `node:net` server reading real bytes off a real socket, ported line-for-line
 * from the Rust source's own raw-socket implementation (NOT `node:http`, to
 * keep the same "read the request line myself, with the same bounded buffer and
 * the same not-just-the-first-connection tolerance for a browser's speculative
 * preconnects" shape the Rust source's own comments describe).
 *
 * The one piece that is a CALLBACK rather than an action: `mcp_oauth_authorize`
 * (the Tauri command wrapper in `mcp_cmds.rs`, not this file) emits the sign-in
 * URL to the window before opening the browser, so the UI can offer a manual
 * "open / copy the sign-in link" fallback. That is exposed here as the optional
 * {@link AuthorizeDeps.onAuthorizeUrl} — real, called at the right moment; the
 * actual `webContents.send` belongs to whatever batch wires a window into the
 * connector-marketplace UI.
 *
 * SSRF GUARD, reused rather than reimplemented: every address in this flow past
 * the user's own configured server URL is chosen by the CONNECTOR (the
 * `WWW-Authenticate` challenge names the metadata document, that document names
 * an authorization server, that server's metadata names the authorize/token/
 * registration endpoints) — a hostile connector could point any of them at this
 * Mac's own network. `src-tauri/src/web/guard.rs` is ALREADY ported at
 * `src/main/browser/guard.ts` (`checkPublicHttpUrl` + `resolvePublicAddr`,
 * the exact pair `mcp_oauth.rs`'s own `checked_endpoint`/`guarded_client`
 * call); this module imports and reuses it rather than duplicating the
 * private-network classification a second time.
 *
 * {@link OutboundGuard} below is the ONE seam layered on top of that reused
 * guard, and it exists ONLY so this file's own tests can prove the HTTP-calling
 * logic (redirect walking, error wrapping, form-encoded token exchange) against
 * a real fake loopback server — which the real guard, correctly, refuses to
 * reach. Every exported function defaults to {@link REAL_GUARD}; a caller has
 * to go out of its way to pass anything else, and only this module's own test
 * file does.
 */

import { Agent } from "undici";
import { createHash, randomBytes } from "node:crypto";
import * as net from "node:net";
import type Database from "better-sqlite3-multiple-ciphers";
import { getSetting, setSetting } from "./db-host/settings.js";
import { checkPublicHttpUrl, resolvePublicAddr } from "./browser/guard.js";

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asRecord(v: unknown): Record<string, unknown> {
  return isPlainObject(v) ? v : {};
}

const HTTP_TIMEOUT_MS = 30_000;
/** How long the flow waits for the user to finish the browser sign-in. */
const AUTH_TIMEOUT_MS = 300_000;

function b64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

// ------------------------------------------------------------------- PKCE

/** A PKCE pair: the secret `verifier` kept locally, and the `challenge` (its
 * SHA-256, base64url) sent in the authorize request. Ported from `Pkce`. */
export interface Pkce {
  verifier: string;
  challenge: string;
}

/** Ported from `generate_pkce`. */
export function generatePkce(): Pkce {
  const verifier = b64url(randomBytes(32)); // 43 chars, RFC 7636 §4.1 compliant
  const challenge = b64url(createHash("sha256").update(verifier, "ascii").digest());
  return { verifier, challenge };
}

// ----------------------------------------------------------- discovery parse

/** Pull the Protected Resource Metadata URL out of a 401's `WWW-Authenticate`
 * header: `Bearer resource_metadata="https://…/.well-known/…"`. RFC 9728.
 * Ported verbatim from `parse_www_authenticate`. */
export function parseWwwAuthenticate(header: string): string | null {
  const lower = header.toLowerCase();
  const key = "resource_metadata";
  const at = lower.indexOf(key);
  if (at === -1) return null;
  let after = header.slice(at + key.length).trimStart();
  if (!after.startsWith("=")) return null;
  after = after.slice(1).trimStart();
  if (!after.startsWith('"')) return null;
  after = after.slice(1);
  const end = after.indexOf('"');
  if (end === -1) return null;
  return after.slice(0, end);
}

function originOf(url: string): string {
  const idx = url.indexOf("://");
  if (idx === -1) return url.replace(/\/+$/, "");
  const scheme = url.slice(0, idx);
  const rest = url.slice(idx + 3);
  const host = rest.split("/")[0] ?? rest;
  return `${scheme}://${host}`;
}

/**
 * The `/.well-known/oauth-protected-resource` URLs to try for a base resource
 * URL — the fallback when a server sends no `WWW-Authenticate` (probe path).
 *
 * RFC 9728 §3.1 puts the RESOURCE's own path after the well-known segment, so a
 * server hosting several MCP resources publishes one document per path and the
 * origin-only URL 404s. The origin-only form stays as the second candidate: a
 * server with a single resource commonly publishes only that. Ported verbatim
 * from `well_known_prm`.
 */
export function wellKnownPrm(resourceUrl: string): string[] {
  const base = resourceUrl.replace(/\/+$/, "");
  const origin = originOf(base);
  const p = base.startsWith(origin) ? base.slice(origin.length) : "";
  const out = [`${origin}/.well-known/oauth-protected-resource${p}`];
  const originOnly = `${origin}/.well-known/oauth-protected-resource`;
  if (!out.includes(originOnly)) out.push(originOnly);
  return out;
}

/** Protected Resource Metadata → the authorization servers it trusts. Ported
 * verbatim from `parse_resource_metadata`. */
export function parseResourceMetadata(json: unknown): string[] {
  const servers = asRecord(json)["authorization_servers"];
  return Array.isArray(servers) ? servers.filter((v): v is string => typeof v === "string") : [];
}

/** What the RESOURCE says it needs (RFC 9728 `scopes_supported`) — the only
 * scopes the consent screen may be asked for. The authorization server's own
 * list is everything it CAN issue, which for a read-only connector means
 * putting write and admin on the consent screen for nothing. Ported verbatim
 * from `parse_prm_scopes`. */
export function parsePrmScopes(json: unknown): string[] {
  const scopes = asRecord(json)["scopes_supported"];
  return Array.isArray(scopes) ? scopes.filter((v): v is string => typeof v === "string") : [];
}

/** The endpoints needed off an Authorization Server Metadata document. Ported
 * from `AuthServerMeta`. */
export interface AuthServerMeta {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
}

/** Ported verbatim from `parse_auth_server_metadata`. */
export function parseAuthServerMetadata(json: unknown): AuthServerMeta | null {
  const r = asRecord(json);
  const ae = r["authorization_endpoint"];
  const te = r["token_endpoint"];
  if (typeof ae !== "string" || typeof te !== "string") return null;
  const re = r["registration_endpoint"];
  return {
    authorizationEndpoint: ae,
    tokenEndpoint: te,
    registrationEndpoint: typeof re === "string" ? re : null,
  };
}

/** Minimal percent-encoding for query values (RFC 3986 unreserved kept),
 * byte-level so it matches the Rust source exactly rather than
 * `encodeURIComponent`'s more permissive unreserved set (which leaves `!*'()`
 * unescaped). Ported verbatim from `urlencode`. */
function urlencode(s: string): string {
  let out = "";
  for (const b of Buffer.from(s, "utf8")) {
    if (
      (b >= 0x41 && b <= 0x5a) ||
      (b >= 0x61 && b <= 0x7a) ||
      (b >= 0x30 && b <= 0x39) ||
      b === 0x2d ||
      b === 0x5f ||
      b === 0x2e ||
      b === 0x7e
    ) {
      out += String.fromCharCode(b);
    } else {
      out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** Build the authorize URL (RFC 6749 §4.1.1 + PKCE + RFC 8707 `resource`).
 * Ported verbatim from `build_authorize_url`. */
export function buildAuthorizeUrl(
  endpoint: string,
  clientId: string,
  redirectUri: string,
  challenge: string,
  state: string,
  scope: string,
  resource: string
): string {
  const q: Array<[string, string]> = [
    ["response_type", "code"],
    ["client_id", clientId],
    ["redirect_uri", redirectUri],
    ["code_challenge", challenge],
    ["code_challenge_method", "S256"],
    ["state", state],
    ["scope", scope],
    ["resource", resource],
  ];
  const query = q
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${urlencode(v)}`)
    .join("&");
  const sep = endpoint.includes("?") ? "&" : "?";
  return `${endpoint}${sep}${query}`;
}

/**
 * The authorization-server metadata URLs to try for one issuer, in order.
 *
 * RFC 8414 §3.1 INSERTS the well-known segment between the host and the
 * issuer's path (`https://host/.well-known/oauth-authorization-server/tenant-42`)
 * — which is what multi-tenant deployments publish, and what appending the
 * segment could never find. The appended form is the OIDC Discovery 1.0 layout,
 * which many of the same servers also answer, and an OIDC-only server has no
 * `oauth-authorization-server` document at all. An issuer without a path makes
 * the two forms identical, hence the de-duplication. Ported verbatim from
 * `auth_metadata_urls`.
 */
export function authMetadataUrls(issuer: string): string[] {
  const iss = issuer.replace(/\/+$/, "");
  const origin = originOf(iss);
  const p = iss.startsWith(origin) ? iss.slice(origin.length) : "";
  const out: string[] = [];
  for (const name of ["oauth-authorization-server", "openid-configuration"]) {
    for (const candidate of [`${origin}/.well-known/${name}${p}`, `${iss}/.well-known/${name}`]) {
      if (!out.includes(candidate)) out.push(candidate);
    }
  }
  return out;
}

// ------------------------------------------------------------- token store

/** A stored credential set for one remote connector. Ported from `TokenSet`. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Unix seconds when the access token expires (0 = unknown/never). */
  expiresAt: number;
  /** The dynamically-registered client id, reused on refresh. */
  clientId: string | null;
  /** The token endpoint, stored so a refresh is self-contained (no
   * re-discovery). */
  tokenEndpoint: string | null;
  /** Set once the provider REFUSED this refresh token — the user revoked the
   * app, or the grant expired. A silent renewal can never succeed again, so the
   * sign-in indicator must stop reading "Signed in" and offer the browser
   * again. Cleared by signing in (a fresh set never carries it). */
  refreshRejected: boolean;
}

/** Why a token request failed. A provider that REJECTS it (any non-2xx —
 * `invalid_grant` after the user revoked the app, an expired refresh token) is
 * FINAL: retrying renews nothing. A transport failure is NOT final — the Mac
 * may simply be offline, and treating that as a dead sign-in would push the
 * user through the browser for a connector that still works. Ported from
 * `TokenError`, as a throwable `Error` subclass carrying the same distinction
 * (`rejected`) this codebase's `Result<T,String>` → `throw` convention would
 * otherwise lose. */
export class TokenRequestError extends Error {
  constructor(
    message: string,
    /** True when the sign-in itself is over, not just this attempt — mirrors
     * `TokenError::is_rejected`. */
    public readonly rejected: boolean
  ) {
    super(message);
    this.name = "TokenRequestError";
  }
}

function tokenKey(server: string): string {
  return `oauth:${server}`;
}

/**
 * Persist a token set as the SAME snake_case JSON shape Rust's `serde` derive
 * writes (`Option<T>` as JSON `null` rather than an omitted key) — load-bearing
 * for a room a Tauri-era install carried over, whose stored tokens must still
 * parse. Ported from `save_tokens`.
 */
export function saveTokens(db: Database.Database, server: string, t: TokenSet): void {
  const wire = {
    access_token: t.accessToken,
    refresh_token: t.refreshToken,
    expires_at: t.expiresAt,
    client_id: t.clientId,
    token_endpoint: t.tokenEndpoint,
    refresh_rejected: t.refreshRejected,
  };
  setSetting(db, tokenKey(server), JSON.stringify(wire));
}

/** Ported from `load_tokens` — tolerant of a legacy row missing
 * `refresh_rejected` (defaults `false`), matching Rust's `#[serde(default)]`.
 * `access_token` has no default there, so a row missing it fails to parse and
 * reads back as "no tokens", exactly like `.ok()` collapsing that failure. */
export function loadTokens(db: Database.Database, server: string): TokenSet | null {
  const raw = getSetting(db, tokenKey(server));
  if (raw === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null; // an empty string (cleared) or corrupt row both read as "no tokens"
  }
  const r = asRecord(v);
  if (typeof r["access_token"] !== "string") return null;
  return {
    accessToken: r["access_token"],
    refreshToken: typeof r["refresh_token"] === "string" ? r["refresh_token"] : null,
    expiresAt: typeof r["expires_at"] === "number" ? r["expires_at"] : 0,
    clientId: typeof r["client_id"] === "string" ? r["client_id"] : null,
    tokenEndpoint: typeof r["token_endpoint"] === "string" ? r["token_endpoint"] : null,
    refreshRejected: r["refresh_rejected"] === true,
  };
}

/** Ported from `clear_tokens` — an empty value reads back as "no tokens" (see
 * {@link loadTokens}), matching the Rust source's own comment. */
export function clearTokens(db: Database.Database, server: string): void {
  setSetting(db, tokenKey(server), "");
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

/** True when the access token is missing or within 60s of expiry. Ported
 * verbatim from `needs_refresh`. */
export function needsRefresh(t: TokenSet): boolean {
  return t.accessToken === "" || (t.expiresAt !== 0 && t.expiresAt <= nowSecs() + 60);
}

/** True when an expiring token can be renewed without the user: we kept a
 * refresh token, the token endpoint and the registered client id at sign-in —
 * and the provider has not already refused that refresh token. Having the
 * pieces on file is not the same as them still working, and a connector whose
 * sign-in was revoked has to say so or the only way back is deleting it. Ported
 * verbatim from `can_refresh`. */
export function canRefresh(t: TokenSet): boolean {
  const filled = (v: string | null): boolean => v !== null && v !== "";
  return !t.refreshRejected && filled(t.refreshToken) && filled(t.tokenEndpoint) && filled(t.clientId);
}

/** The stored set marked un-renewable, for persisting after the provider
 * refused the refresh token. The rest is kept: it still records which account
 * this was, and signing in replaces the whole set anyway. A transport failure
 * must NEVER reach here — see {@link TokenRequestError}. Ported verbatim from
 * `mark_refresh_rejected`. */
export function markRefreshRejected(t: TokenSet): TokenSet {
  return { ...t, refreshRejected: true };
}

/** Fold a refresh response into the stored set. RFC 6749 §6 lets the server
 * omit `refresh_token` (the old one stays valid), and the token endpoint
 * discovered at sign-in never comes back in the response — keeping both is what
 * makes the NEXT refresh self-contained too. Ported verbatim from
 * `merge_refreshed`. */
export function mergeRefreshed(stored: TokenSet, fresh: TokenSet): TokenSet {
  return {
    ...fresh,
    refreshToken: fresh.refreshToken ?? stored.refreshToken,
    tokenEndpoint: fresh.tokenEndpoint ?? stored.tokenEndpoint,
    clientId: fresh.clientId ?? stored.clientId,
  };
}

/** `refresh_if_expiring`'s `Option<Result<TokenSet, TokenError>>`, expressed as
 * a discriminated union rather than throwing: `null` genuinely means "nothing
 * to do" (still good, or nothing to renew it with), which is a different shape
 * from a failed attempt and callers need to tell them apart without a try/catch
 * around the "nothing happened" case. */
export type RefreshOutcome = null | { ok: true; token: TokenSet } | { ok: false; error: TokenRequestError };

// -------------------------------------------------------------- SSRF guard

/**
 * The two operations {@link guardedRequest} needs from the reused SSRF guard —
 * see the module doc for why this seam exists (tests only; every exported
 * function defaults to {@link REAL_GUARD}).
 */
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
  const parsedUrl = guard.checkEndpoint(url);
  const host = parsedUrl.hostname;
  if (host === "") {
    throw new Error(`${url} has no host — refused.`);
  }
  const port = parsedUrl.port !== "" ? Number(parsedUrl.port) : parsedUrl.protocol === "http:" ? 80 : 443;
  let addr: { address: string; port: number };
  try {
    addr = await guard.resolveAddr(host, port);
  } catch (e) {
    throw new Error(`${url}: ${errMessage(e)}`);
  }
  const family = addr.address.includes(":") ? 6 : 4;
  const dispatcher = new Agent({
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
        // Node 20+ asks custom lookup functions for `all: true` while its
        // Happy-Eyeballs connector is active. Returning the legacy
        // `(address, family)` shape to that request makes node:net read
        // `address.address` from a string and throw ERR_INVALID_IP_ADDRESS.
        // Every OAuth metadata request then surfaced only "fetch failed" —
        // including Datadog's — even after a public address was resolved and
        // pinned correctly. Preserve the single checked address, but answer in
        // the result shape the caller requested.
        if (options?.all === true) {
          callback(null, [{ address: addr.address, family }]);
        } else {
          callback(null, addr.address, family);
        }
      },
    },
  });
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
    await dispatcher.close().catch(() => undefined);
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
    let prm: unknown;
    try {
      prm = await fetchJsonMetadata(prmUrl, guard);
    } catch (e) {
      last = errMessage(e);
      continue;
    }
    const scopes = parsePrmScopes(prm);
    const servers = parseResourceMetadata(prm);
    if (servers.length === 0) {
      last = `${prmUrl} lists no authorization servers`;
      continue;
    }
    for (const server of servers) {
      for (const metaUrl of authMetadataUrls(server)) {
        try {
          const asm = await fetchJsonMetadata(metaUrl, guard);
          const meta = parseAuthServerMetadata(asm);
          if (meta !== null) {
            return { meta, scopes };
          }
          last = `${metaUrl} is missing required endpoints`;
        } catch (e) {
          last = errMessage(e);
        }
      }
    }
  }
  throw new Error(last);
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
  if (!needsRefresh(stored) || !canRefresh(stored)) {
    return null;
  }
  const endpoint = stored.tokenEndpoint;
  const clientId = stored.clientId;
  const refreshToken = stored.refreshToken;
  if (endpoint === null || clientId === null || refreshToken === null) {
    return null;
  }
  try {
    const fresh = await refreshTokens(endpoint, clientId, refreshToken, guard);
    if (fresh.accessToken === "") {
      // A 200 with no token is not a renewal — merging it would write an empty
      // `Bearer` header over the working one. The endpoint answered, so
      // retrying gains nothing.
      return { ok: false, error: new TokenRequestError("the refresh response carried no access token", true) };
    }
    return { ok: true, token: mergeRefreshed(stored, fresh) };
  } catch (e) {
    if (e instanceof TokenRequestError) {
      return { ok: false, error: e };
    }
    // Anything that is not a token-endpoint answer is a transport failure, and
    // a transport failure must never retire a sign-in.
    return { ok: false, error: new TokenRequestError(errMessage(e), false) };
  }
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
const CALLBACK_READ_TIMEOUT_MS = 10_000;
/** Cap on the bytes read looking for the request line. Far above any real
 * authorization code, and small enough that a local process cannot stream
 * memory into us. */
const MAX_CALLBACK_REQUEST = 64 * 1024;

/** Bind a loopback listener and return `(redirectUri, server)`. The port is
 * ephemeral so nothing needs to be reserved. Ported from `bind_callback`.
 * Exported so a test can drive the real listener over real TCP. */
export async function bindCallback(): Promise<{ redirectUri: string; server: net.Server }> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", (e) => reject(new Error(`could not bind the callback listener: ${errMessage(e)}`)));
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return { redirectUri: `http://127.0.0.1:${port}/callback`, server };
}

/** The request target ("/callback?code=…") of one connection, read with its own
 * timeout and a bounded buffer. `null` for a connection that sends nothing in
 * time, closes early, or overruns the cap — none of those is the callback.
 * Ported from `read_request_target`. */
function readRequestTarget(socket: net.Socket): Promise<string | null> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("end", onClose);
      socket.removeListener("close", onClose);
      socket.removeListener("error", onClose);
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf(0x0a); // '\n'
      if (idx !== -1) {
        const line = buf.subarray(0, idx).toString("utf8");
        // The request LINE is "GET /callback?code=…&state=… HTTP/1.1\r" — only
        // the SECOND whitespace-separated token (the request target itself) is
        // what the rest of this flow wants. Ported verbatim from
        // `read_request_target`'s `line.split_whitespace().nth(1)`; without it
        // the trailing " HTTP/1.1\r" stayed glued onto the last query value,
        // corrupting `state` and reading every real callback as a mismatched
        // sign-in.
        finish(line.split(/\s+/).filter((s) => s.length > 0)[1] ?? null);
        return;
      }
      if (buf.length >= MAX_CALLBACK_REQUEST) {
        finish(null);
      }
    };
    const onClose = (): void => finish(null);
    const timer = setTimeout(() => finish(null), CALLBACK_READ_TIMEOUT_MS);
    socket.on("data", onData);
    socket.on("end", onClose);
    socket.on("close", onClose);
    socket.on("error", onClose);
  });
}

/** The "you can close this tab" page. Always HTTP 200, success or not, matching
 * `write_callback_page` — the STATUS is not how the user is told what happened;
 * the page is. */
async function writeCallbackPage(socket: net.Socket, ok: boolean): Promise<void> {
  const page = ok
    ? "<h2>Signed in.</h2><p>You can close this tab and return to Arcelle.</p>"
    : "<h2>Sign-in failed.</h2><p>Return to Arcelle and try again.</p>";
  const body = `HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: ${Buffer.byteLength(page)}\r\n\r\n${page}`;
  await new Promise<void>((resolve) => {
    socket.write(body, () => resolve());
  });
}

function hexVal(b: number): number | null {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
  return null;
}

/** Percent-decode a query value, byte by byte — never by re-slicing the string
 * at a fixed offset, mirroring the Rust source's own hard-won fix (re-slicing
 * through a multi-byte escape used to panic the whole sign-in task, leaving the
 * drawer waiting for a browser that had already answered). This runs on
 * anything a local process can send the loopback port. Ported verbatim from
 * `urldecode`. */
function urldecode(s: string): string {
  const bytes = Buffer.from(s, "utf8");
  const out: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i]!;
    if (b === 0x2b) {
      out.push(0x20); // '+' -> space
    } else if (b === 0x25 && i + 2 < bytes.length) {
      const hi = hexVal(bytes[i + 1]!);
      const lo = hexVal(bytes[i + 2]!);
      if (hi !== null && lo !== null) {
        out.push(hi * 16 + lo);
        i += 3;
        continue;
      }
      out.push(b); // not an escape after all — keep the byte as it arrived
    } else {
      out.push(b);
    }
    i += 1;
  }
  return Buffer.from(out).toString("utf8");
}

/** Every `k=v` pair of a request target's query, values percent-decoded. */
function callbackParams(target: string): Map<string, string> {
  const q = target.includes("?") ? target.slice(target.indexOf("?") + 1) : "";
  const out = new Map<string, string>();
  for (const pair of q.split("&")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    out.set(pair.slice(0, eq), urldecode(pair.slice(eq + 1)));
  }
  return out;
}

/** Pull `code` and `state` out of a `/callback?code=…&state=…` request target.
 * Ported verbatim from `parse_callback_query`. */
export function parseCallbackQuery(target: string): { code: string; state: string } {
  const params = callbackParams(target);
  return { code: params.get("code") ?? "", state: params.get("state") ?? "" };
}

/** The provider's own refusal off a callback target, `error_description` for
 * preference. Ported verbatim from `callback_error`. */
export function callbackError(target: string): string | null {
  const params = callbackParams(target);
  const error = params.get("error");
  if (error === undefined || error === "") return null;
  const description = params.get("error_description");
  return description !== undefined && description !== "" ? `${error} — ${description}` : error;
}

/**
 * Serve the browser's redirect, extract `?code=&state=`, and show the user a
 * "you can close this tab" page.
 *
 * Every connection until the deadline gets a look, not just the first one.
 * Browsers open speculative connections and close them again, and serving
 * exactly one accepted socket lost real sign-ins to them: a socket that sent
 * nothing blocked the read forever, and one that closed immediately consumed
 * the single accept and reported failure for a sign-in the user had completed
 * correctly. Only a request that carries a `code` — or the provider's own
 * `error` — ends the wait. A persistent `connection` listener queues sockets
 * that arrive while an earlier one is still being read, since a dropped Node
 * event is the equivalent failure. Ported from `await_callback`; exported so a
 * test can drive it over real TCP.
 */
export async function awaitCallback(server: net.Server, expectedState: string, timeoutMs: number): Promise<string> {
  const pending: net.Socket[] = [];
  let waiter: ((s: net.Socket) => void) | null = null;
  const onConnection = (s: net.Socket): void => {
    if (waiter !== null) {
      const w = waiter;
      waiter = null;
      w(s);
    } else {
      pending.push(s);
    }
  };
  server.on("connection", onConnection);

  const nextSocket = (remaining: number): Promise<net.Socket | null> => {
    const queued = pending.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiter = null;
        resolve(null);
      }, remaining);
      waiter = (s): void => {
        clearTimeout(timer);
        resolve(s);
      };
    });
  };

  const timedOut = (): Error => new Error("timed out waiting for the browser sign-in");
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw timedOut();
      const socket = await nextSocket(remaining);
      if (socket === null) throw timedOut();
      const target = await readRequestTarget(socket);
      if (target === null) {
        socket.destroy();
        continue;
      }
      // The user pressed Deny, or the provider refused: that IS an answer, and
      // it is the provider's words rather than our guess at them.
      const why = callbackError(target);
      if (why !== null) {
        await writeCallbackPage(socket, false);
        socket.end();
        throw new Error(`the provider refused the sign-in: ${why}`);
      }
      const { code, state } = parseCallbackQuery(target);
      if (code === "") {
        // A speculative connection, a favicon request, anything that is not the
        // redirect: leave the wait open for the real one.
        socket.destroy();
        continue;
      }
      const ok = state === expectedState;
      await writeCallbackPage(socket, ok);
      socket.end();
      if (!ok) {
        throw new Error("the sign-in did not complete (the browser sent back a different sign-in's state)");
      }
      return code;
    }
  } finally {
    server.removeListener("connection", onConnection);
    // Anything still queued was never answered; `server.close()` does not touch
    // established sockets, and a live one would keep the process (or a test
    // runner) waiting on nothing.
    for (const s of pending.splice(0)) s.destroy();
  }
}

// ---------------------------------------------------------- authorize flow

export interface AuthorizeDeps {
  /** Opens the system browser at the built authorize URL. Electron's
   * `shell.openExternal` (or, in a test, a fake "browser" that drives the
   * loopback redirect itself) — never a renderer round trip, matching the Rust
   * source's own injected `open_browser: impl Fn(&str) -> Result<(), String>`
   * parameter. */
  openBrowser: (url: string) => void | Promise<void>;
  /** `mcp_oauth_authorize`'s `mcp-oauth-url` window event: the UI offers a
   * manual "open / copy the sign-in link" fallback for when the system browser
   * does not come up on its own. Called BEFORE `openBrowser`, exactly like
   * Rust's own `open` closure, which emits and then opens. */
  onAuthorizeUrl?: (url: string) => void;
  authTimeoutMs?: number;
  /** Test-only override of the SSRF guard — see the module doc. Defaults to
   * {@link REAL_GUARD} and production callers should never pass this. */
  guard?: OutboundGuard;
}

/**
 * Run the full interactive authorization for one remote connector at
 * `resourceUrl`, returning tokens to store. Composes every tested primitive
 * above. Ported from `authorize`.
 */
export async function authorize(
  resourceUrl: string,
  wwwAuthenticate: string | null,
  deps: AuthorizeDeps
): Promise<TokenSet> {
  const guard = deps.guard ?? REAL_GUARD;
  // The server named its own metadata document; nothing to guess at. A
  // challenge we cannot read falls back to the well-known probe path, matching
  // Rust's `www_authenticate.and_then(parse_www_authenticate)`.
  const fromChallenge = wwwAuthenticate !== null ? parseWwwAuthenticate(wwwAuthenticate) : null;
  const prmUrls = fromChallenge !== null ? [fromChallenge] : wellKnownPrm(resourceUrl);
  const { meta, scopes } = await discover(prmUrls, guard);
  const { redirectUri, server } = await bindCallback();
  try {
    if (meta.registrationEndpoint === null) {
      throw new Error("this server requires manual client setup (no registration endpoint)");
    }
    const clientId = await registerClient(meta.registrationEndpoint, redirectUri, guard);
    const pkce = generatePkce();
    const state = b64url(randomBytes(16));
    // Only what the RESOURCE published. Asking for the union of everything the
    // authorization server supports put write and admin on the consent screen
    // for a connector that may only need to read, and the stored token then
    // carried them. With nothing published we send no `scope` at all
    // (`buildAuthorizeUrl` drops empty parameters) and the provider applies its
    // own default, which is a narrower ask than its superset.
    const scope = scopes.join(" ");
    const url = buildAuthorizeUrl(
      meta.authorizationEndpoint,
      clientId,
      redirectUri,
      pkce.challenge,
      state,
      scope,
      resourceUrl
    );
    deps.onAuthorizeUrl?.(url);
    await deps.openBrowser(url);
    const code = await awaitCallback(server, state, deps.authTimeoutMs ?? AUTH_TIMEOUT_MS);
    const token = await exchangeCode(meta.tokenEndpoint, clientId, code, pkce.verifier, redirectUri, guard);
    // Keep the token endpoint so a later refresh needs no re-discovery.
    return { ...token, tokenEndpoint: meta.tokenEndpoint };
  } finally {
    server.close();
  }
}
