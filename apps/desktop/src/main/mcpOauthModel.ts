import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { getSetting, setSetting } from "./db-host/settings.js";

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
export function asRecord(v: unknown): Record<string, unknown> {
  return isPlainObject(v) ? v : {};
}

export const HTTP_TIMEOUT_MS = 30_000;
/** How long the flow waits for the user to finish the browser sign-in. */
export const AUTH_TIMEOUT_MS = 300_000;

export function b64url(bytes: Buffer): string {
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
  for (const byte of Buffer.from(s, "utf8")) {
    out += encodedQueryByte(byte);
  }
  return out;
}

function encodedQueryByte(byte: number): string {
  if (isUnreservedQueryByte(byte)) return String.fromCharCode(byte);
  return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
}

const UNRESERVED_QUERY_SYMBOLS = new Set([0x2d, 0x5f, 0x2e, 0x7e]);

function isUnreservedQueryByte(byte: number): boolean {
  if (asciiByteBetween(byte, 0x41, 0x5a)) return true;
  if (asciiByteBetween(byte, 0x61, 0x7a)) return true;
  if (asciiByteBetween(byte, 0x30, 0x39)) return true;
  return UNRESERVED_QUERY_SYMBOLS.has(byte);
}

export function asciiByteBetween(byte: number, first: number, last: number): boolean {
  return byte >= first && byte <= last;
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
  const wire = parsedTokenWire(raw);
  if (wire === null) return null;
  return tokenSetFromWire(wire);
}

function parsedTokenWire(raw: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null; // an empty string (cleared) or corrupt row both read as "no tokens"
  }
}

function tokenSetFromWire(wire: Record<string, unknown>): TokenSet | null {
  const accessToken = stringTokenField(wire, "access_token");
  if (accessToken === null) return null;
  return {
    accessToken,
    refreshToken: stringTokenField(wire, "refresh_token"),
    expiresAt: numberTokenField(wire, "expires_at"),
    clientId: stringTokenField(wire, "client_id"),
    tokenEndpoint: stringTokenField(wire, "token_endpoint"),
    refreshRejected: wire["refresh_rejected"] === true,
  };
}

function stringTokenField(wire: Record<string, unknown>, key: string): string | null {
  const value = wire[key];
  return typeof value === "string" ? value : null;
}

function numberTokenField(wire: Record<string, unknown>, key: string): number {
  const value = wire[key];
  return typeof value === "number" ? value : 0;
}

/** Ported from `clear_tokens` — an empty value reads back as "no tokens" (see
 * {@link loadTokens}), matching the Rust source's own comment. */
export function clearTokens(db: Database.Database, server: string): void {
  setSetting(db, tokenKey(server), "");
}

export function nowSecs(): number {
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
