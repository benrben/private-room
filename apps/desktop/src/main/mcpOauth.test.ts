/**
 * Vitest port of `mcp_oauth.rs`'s `mod tests`, PLUS real HTTP round-trips:
 * discovery → registration → PKCE authorize URL → loopback callback → code
 * exchange, driven against REAL `node:http`/`node:net` servers on loopback.
 *
 * The SSRF guard (`checkPublicHttpUrl`/`resolvePublicAddr`, reused from
 * `browser/guard.ts`) correctly REFUSES loopback addresses — that is exactly
 * what several tests below prove, against a real fixture server, mirroring
 * Rust's own `discovery_and_token_endpoints_refuse_private_addresses` /
 * `the_outbound_client_refuses_a_private_address`. Proving the FULL happy path
 * (a successful discover/register/exchange) therefore needs a
 * `PERMISSIVE_TEST_GUARD` that skips the private-network classification while
 * still doing a REAL fetch to a REAL fixture server — see `mcpOauth.ts`'s own
 * `OutboundGuard` doc for why that seam exists and why it changes nothing about
 * the PRODUCTION default (every exported function defaults to `REAL_GUARD`;
 * only this test file ever overrides it).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoom } from "./db-host/open.js";
import {
  authMetadataUrls,
  authorize,
  awaitCallback,
  bindCallback,
  buildAuthorizeUrl,
  callbackError,
  canRefresh,
  clearTokens,
  discover,
  generatePkce,
  loadTokens,
  markRefreshRejected,
  mergeRefreshed,
  needsRefresh,
  parseAuthServerMetadata,
  parseCallbackQuery,
  parsePrmScopes,
  parseResourceMetadata,
  parseTokenResponse,
  parseWwwAuthenticate,
  probeWwwAuthenticate,
  redirectTarget,
  registerClient,
  refreshIfExpiring,
  refreshTokens,
  saveTokens,
  TokenRequestError,
  wellKnownPrm,
  type OutboundGuard,
  type TokenSet,
} from "./mcpOauth.js";

const nowSecs = (): number => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------ the SSRF guard

describe("SSRF: the production guard refuses private addresses for real", () => {
  it("discovery_and_token_endpoints_refuse_private_addresses", async () => {
    for (const url of [
      "http://127.0.0.1:11434/.well-known/oauth-authorization-server",
      "http://localhost:8080/token",
      "http://[::1]:9000/token",
      "http://192.168.1.20/register",
      "http://router.local/authorize",
    ]) {
      await expect(discover([url])).rejects.toThrow(/private-network/);
    }
  });

  it("the_outbound_client_refuses_a_private_address_against_a_real_server", async () => {
    // A REAL server exists at this address — the refusal has to come from the
    // guard, not from "nothing is listening".
    const server = createServer((_req, res) => res.end("{}"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    try {
      await expect(discover([`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`])).rejects.toThrow(
        /private-network/
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("a_private_token_endpoint_is_unreachable_not_rejected", async () => {
    // A refused endpoint must never read as the provider REFUSING the refresh
    // token: that retires the sign-in and forces the user back through the
    // browser for something the server never said.
    const err = await refreshTokens("http://127.0.0.1:9/token", "cid", "rt").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenRequestError);
    expect((err as TokenRequestError).rejected).toBe(false);
  });
});

// ------------------------------------------------------------ pure parsing

describe("pure parsing", () => {
  it("pkce_pair_is_well_formed", () => {
    const p = generatePkce();
    expect(p.verifier.length).toBe(43);
    expect(/^[A-Za-z0-9_-]+$/.test(p.verifier)).toBe(true);
    expect(generatePkce().verifier).not.toBe(p.verifier);
  });

  it("parses_www_authenticate_resource_metadata", () => {
    const h = `Bearer error="invalid_token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"`;
    expect(parseWwwAuthenticate(h)).toBe("https://mcp.example.com/.well-known/oauth-protected-resource");
    expect(parseWwwAuthenticate("Bearer")).toBeNull();
    expect(parseWwwAuthenticate("Bearer resource_metadata=unquoted")).toBeNull();
  });

  it("well_known_prm_tries_the_resource_path_first", () => {
    // RFC 9728 §3.1: the resource's path goes AFTER the well-known segment, so
    // a host with several MCP resources 404s on the origin-only URL.
    expect(wellKnownPrm("https://mcp.example.com/mcp/v1")).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp/v1",
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    ]);
    // A resource at the root makes the two identical — one candidate, not the
    // same request twice.
    expect(wellKnownPrm("https://mcp.example.com/")).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    ]);
  });

  it("auth_metadata_urls_cover_the_path_and_oidc_forms", () => {
    // A multi-tenant issuer publishes its metadata with the well-known segment
    // INSERTED, so appending it could never find the document.
    expect(authMetadataUrls("https://auth.example.com/tenant-42")).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant-42",
      "https://auth.example.com/tenant-42/.well-known/oauth-authorization-server",
      "https://auth.example.com/.well-known/openid-configuration/tenant-42",
      "https://auth.example.com/tenant-42/.well-known/openid-configuration",
    ]);
    expect(authMetadataUrls("https://auth.example.com/")).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server",
      "https://auth.example.com/.well-known/openid-configuration",
    ]);
  });

  it("parses_metadata_documents", () => {
    const prm = { authorization_servers: ["https://auth.example.com"], scopes_supported: ["read"] };
    expect(parseResourceMetadata(prm)).toEqual(["https://auth.example.com"]);
    // The consent screen asks for what the RESOURCE published, never the
    // authorization server's whole catalogue.
    expect(parsePrmScopes(prm)).toEqual(["read"]);
    const asm = {
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      registration_endpoint: "https://auth.example.com/register",
      scopes_supported: ["read", "write", "admin"],
    };
    const m = parseAuthServerMetadata(asm)!;
    expect(m.authorizationEndpoint).toBe("https://auth.example.com/authorize");
    expect(m.tokenEndpoint).toBe("https://auth.example.com/token");
    expect(m.registrationEndpoint).toBe("https://auth.example.com/register");
    // A PRM with no scopes means NO scope parameter — the provider's own
    // default — rather than the AS-wide superset above.
    expect(parsePrmScopes({ authorization_servers: [] })).toEqual([]);
    const url = buildAuthorizeUrl("https://a/authorize", "c", "http://127.0.0.1:1/cb", "CH", "ST", "", "https://r");
    expect(url).not.toContain("scope=");
    // Missing token_endpoint → null (can't proceed).
    expect(parseAuthServerMetadata({ authorization_endpoint: "x" })).toBeNull();
    expect(parseAuthServerMetadata(null)).toBeNull();
  });

  it("authorize_url_has_pkce_and_encoded_params", () => {
    const url = buildAuthorizeUrl(
      "https://auth.example.com/authorize",
      "client123",
      "http://127.0.0.1:5000/callback",
      "CHAL",
      "STATE",
      "read write",
      "https://mcp.example.com/mcp"
    );
    expect(url).toContain("response_type=code");
    expect(url).toContain("code_challenge=CHAL");
    expect(url).toContain("code_challenge_method=S256");
    expect(url).toContain("client_id=client123");
    expect(url).toContain("redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fcallback");
    expect(url).toContain("scope=read%20write");
    expect(url).toContain("resource=https%3A%2F%2Fmcp.example.com%2Fmcp");
    // An endpoint that already carries a query keeps it.
    expect(buildAuthorizeUrl("https://a/authorize?x=1", "c", "r", "ch", "st", "", "res")).toContain("?x=1&response_type");
  });

  it("authorize URL uses strict RFC 3986 byte encoding for punctuation and UTF-8", () => {
    const url = buildAuthorizeUrl(
      "https://auth.example/authorize",
      "client!*'()é",
      "http://127.0.0.1/cb",
      "challenge",
      "state",
      "read",
      "https://resource.example/a?x=!*'()é"
    );
    // encodeURIComponent leaves !*'() unescaped; OAuth query values must not.
    expect(url).toContain("client_id=client%21%2A%27%28%29%C3%A9");
    expect(url).toContain("resource=https%3A%2F%2Fresource.example%2Fa%3Fx%3D%21%2A%27%28%29%C3%A9");
  });

  it("parses_callback_query", () => {
    expect(parseCallbackQuery("/callback?code=abc123&state=xyz&extra=1")).toEqual({ code: "abc123", state: "xyz" });
    expect(parseCallbackQuery("/callback?code=a%2Fb&state=s").code).toBe("a/b");
    expect(parseCallbackQuery("/callback")).toEqual({ code: "", state: "" });
    // A malformed escape used to PANIC the sign-in task in Rust (re-slicing the
    // &str through a multi-byte character), leaving the drawer waiting for a
    // browser that had already answered. Anything on the loopback port can send
    // these, and `decodeURIComponent` would throw on every one of them.
    expect(parseCallbackQuery("/callback?code=%a�&state=s").code).toBe("%a�");
    expect(parseCallbackQuery("/callback?code=ab%").code).toBe("ab%");
    expect(parseCallbackQuery("/callback?code=%zz").code).toBe("%zz");
    expect(parseCallbackQuery("/callback?code=a%2").code).toBe("a%2");
    // `+` is a space, and a lone trailing `%` after a decoded escape survives.
    expect(parseCallbackQuery("/callback?code=a+b%2Fc%").code).toBe("a b/c%");
  });

  it("a_refused_signin_is_read_off_the_callback", () => {
    expect(callbackError("/callback?error=access_denied&state=s")).toBe("access_denied");
    expect(callbackError("/callback?error=invalid_scope&error_description=Scope+admin+is+unknown")).toBe(
      "invalid_scope — Scope admin is unknown"
    );
    // The successful callback is not an error, and neither is a browser's
    // speculative GET.
    expect(callbackError("/callback?code=abc&state=s")).toBeNull();
    expect(callbackError("/favicon.ico")).toBeNull();
    expect(callbackError("/callback?error=&state=s")).toBeNull();
  });

  it("a_redirect_hop_is_resolved_and_then_re_checked", () => {
    // A redirect is chosen by the same server the guard exists to distrust, so
    // following one means running the WHOLE check again on the target — which
    // is only possible because the hop is computed rather than handed to the
    // HTTP client's own redirect policy.
    const from = new URL("https://auth.example.com/.well-known/x");
    expect(redirectTarget(302, "http://127.0.0.1:11434/api/generate", from)).toBe("http://127.0.0.1:11434/api/generate");
    expect(redirectTarget(301, "/other", from)).toBe("https://auth.example.com/other");
    expect(redirectTarget(200, "/other", from)).toBeNull();
    expect(redirectTarget(302, null, from)).toBeNull();
    expect(redirectTarget(302, "  ", from)).toBeNull();
  });

  it("parses_token_response_and_expiry", () => {
    const t = parseTokenResponse({ access_token: "at1", refresh_token: "rt1", expires_in: 3600 }, "client123");
    expect(t.accessToken).toBe("at1");
    expect(t.refreshToken).toBe("rt1");
    expect(t.expiresAt).toBeGreaterThan(nowSecs());
    expect(t.clientId).toBe("client123");
    expect(needsRefresh(t)).toBe(false);
    // No expiry field → expiresAt 0 (unknown), not "expired".
    const t2 = parseTokenResponse({ access_token: "x" }, "c");
    expect(t2.expiresAt).toBe(0);
    expect(needsRefresh(t2)).toBe(false);
    // Empty access token always needs refresh.
    expect(needsRefresh(parseTokenResponse({}, "c"))).toBe(true);
    // An `expires_in` Rust's `as_u64()` would refuse is "unknown", never an
    // expiry in the past.
    expect(parseTokenResponse({ access_token: "x", expires_in: -60 }, "c").expiresAt).toBe(0);
    expect(parseTokenResponse({ access_token: "x", expires_in: "3600" }, "c").expiresAt).toBe(0);
    expect(parseTokenResponse({ access_token: "x", expires_in: NaN }, "c").expiresAt).toBe(0);
    // The ONE documented deviation from `as_u64()`: a positive fractional value
    // becomes a real (truncated) expiry rather than "unknown", so a malformed
    // provider still gets its token renewed ahead of time instead of presenting
    // a dead pass an hour later. See parseTokenResponse's own DEVIATION note.
    const fractional = parseTokenResponse({ access_token: "x", expires_in: 3599.5 }, "c");
    expect(fractional.expiresAt).toBe(nowSecs() + 3599);
    expect(needsRefresh(fractional)).toBe(false);
  });

  it("expiring_token_is_renewable_and_the_refresh_folds_in", () => {
    let t: TokenSet = {
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: nowSecs() + 10, // inside the 60s window
      clientId: "cid",
      tokenEndpoint: "https://auth.example.com/token",
      refreshRejected: false,
    };
    expect(needsRefresh(t)).toBe(true);
    expect(canRefresh(t)).toBe(true);
    // Missing any one piece means the user really does have to sign in again.
    expect(canRefresh({ ...t, refreshToken: null })).toBe(false);
    expect(canRefresh({ ...t, tokenEndpoint: null })).toBe(false);
    expect(canRefresh({ ...t, clientId: null })).toBe(false);
    expect(canRefresh({ ...t, refreshToken: "" })).toBe(false);

    // A refresh response omits the endpoint (and often the refresh token); both
    // must survive so the NEXT renewal is self-contained too.
    const fresh = parseTokenResponse({ access_token: "at2", expires_in: 3600 }, "cid");
    expect(fresh.tokenEndpoint).toBeNull();
    const merged = mergeRefreshed(t, fresh);
    expect(merged.accessToken).toBe("at2");
    expect(merged.refreshToken).toBe("rt");
    expect(merged.tokenEndpoint).toBe("https://auth.example.com/token");
    expect(needsRefresh(merged)).toBe(false);

    // A rotated refresh token replaces the old one.
    const rotated = parseTokenResponse({ access_token: "at3", refresh_token: "rt2" }, "cid");
    expect(mergeRefreshed(t, rotated).refreshToken).toBe("rt2");

    // A token that is still good is left alone.
    t = { ...t, expiresAt: nowSecs() + 3600 };
    expect(needsRefresh(t)).toBe(false);
  });

  it("a_revoked_signin_stops_reading_as_renewable", () => {
    // Having a refresh token, endpoint and client id on file is not the same as
    // them still WORKING. Once the provider refuses the refresh token the
    // drawer must stop saying "Signed in" with a greyed-out button — that
    // button is the only way to re-authorize.
    const live: TokenSet = {
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: nowSecs() + 10,
      clientId: "cid",
      tokenEndpoint: "https://auth.example.com/token",
      refreshRejected: false,
    };
    expect(needsRefresh(live) && canRefresh(live)).toBe(true);
    const dead = markRefreshRejected(live);
    expect(canRefresh(dead)).toBe(false);
    // What `mcp_oauth_status` computes: signed in = still good, or renewable.
    const signedIn = (t: TokenSet): boolean => !needsRefresh(t) || canRefresh(t);
    expect(signedIn(live)).toBe(true);
    expect(signedIn(dead)).toBe(false);
    // Nothing else is thrown away — the account is still identifiable.
    expect(dead.refreshToken).toBe(live.refreshToken);
    expect(dead.tokenEndpoint).toBe(live.tokenEndpoint);
  });

  it("refreshIfExpiring does nothing at all when there is nothing to do", async () => {
    // No network seam is involved in either answer: a good token and an
    // unrenewable one both return null WITHOUT reaching the token endpoint (the
    // real guard would refuse this one, so a request would surface as a throw).
    const good: TokenSet = {
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: nowSecs() + 3600,
      clientId: "cid",
      tokenEndpoint: "http://127.0.0.1:9/token",
      refreshRejected: false,
    };
    expect(await refreshIfExpiring(good)).toBeNull();
    const unrenewable: TokenSet = {
      accessToken: "",
      refreshToken: null,
      expiresAt: 0,
      clientId: null,
      tokenEndpoint: null,
      refreshRejected: false,
    };
    expect(await refreshIfExpiring(unrenewable)).toBeNull();
    // A grant the provider already refused is not tried again either.
    expect(await refreshIfExpiring(markRefreshRejected({ ...good, expiresAt: nowSecs() + 10 }))).toBeNull();
  });

  it("only_a_refusal_retires_a_signin_not_a_flaky_network", () => {
    // Being offline is not a revoked account: retiring the sign-in for a
    // transport failure would push the user through the browser for a connector
    // that still works perfectly.
    expect(new TokenRequestError("invalid_grant", true).rejected).toBe(true);
    expect(new TokenRequestError("dns error", false).rejected).toBe(false);
    expect(new TokenRequestError("invalid_grant", true).message).toBe("invalid_grant");
  });
});

// -------------------------------------------------------------- token store

describe("token store (real room DB)", () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
  });
  function freshRoom(): ReturnType<typeof createRoom> {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-oauth-"));
    const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
    return createRoom(roomPath, "correct horse battery staple", "Test Room");
  }

  it("token_store_round_trips", () => {
    const db = freshRoom();
    expect(loadTokens(db, "github")).toBeNull();
    const t: TokenSet = {
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 123,
      clientId: "cid",
      tokenEndpoint: "https://auth.example.com/token",
      refreshRejected: false,
    };
    saveTokens(db, "github", t);
    expect(loadTokens(db, "github")).toEqual(t);
    // Per-server isolation.
    expect(loadTokens(db, "notion")).toBeNull();
    clearTokens(db, "github");
    expect(loadTokens(db, "github")).toBeNull();
    // Clearing something that was never stored is not an error.
    clearTokens(db, "never-stored");
    expect(loadTokens(db, "never-stored")).toBeNull();
  });

  it("a_revoked_signin_survives_the_store_and_legacy_rows_read_back_as_renewable", () => {
    const db = freshRoom();
    const live: TokenSet = {
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: nowSecs() + 10,
      clientId: "cid",
      tokenEndpoint: "https://auth.example.com/token",
      refreshRejected: false,
    };
    saveTokens(db, "vendor", markRefreshRejected(live));
    expect(canRefresh(loadTokens(db, "vendor")!)).toBe(false);

    // A row written before `refresh_rejected` existed (the snake_case wire
    // shape a Tauri-era room's `.roomai` carries, opened IN PLACE by this
    // migration) must still parse, and read back as renewable.
    db.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run(
      "oauth:legacy",
      JSON.stringify({
        access_token: "at",
        refresh_token: "rt",
        expires_at: 1,
        client_id: "cid",
        token_endpoint: "https://auth.example.com/token",
      })
    );
    expect(canRefresh(loadTokens(db, "legacy")!)).toBe(true);
    // A row that is not a token document at all reads as "no tokens" rather
    // than throwing — Rust's `serde_json::from_str(...).ok()`.
    db.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run("oauth:junk", "{ half-written");
    expect(loadTokens(db, "junk")).toBeNull();
    db.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run("oauth:noaccess", JSON.stringify({ client_id: "c" }));
    expect(loadTokens(db, "noaccess")).toBeNull();
  });

  it("retarget bug class: the token store's half of it", () => {
    // The DETECTION of "this edit changed the destination" is `mcpConfig.ts`'s
    // `resignedServers`/`sameDestination`; this pins the store primitive that
    // detection is required to call, so a fresh sign-in against the NEW
    // endpoint can never start from the old endpoint's leftover refresh token.
    const db = freshRoom();
    const forA: TokenSet = {
      accessToken: "at-for-a",
      refreshToken: "rt-for-a",
      expiresAt: nowSecs() + 3600,
      clientId: "cid",
      tokenEndpoint: "https://a.test/token",
      refreshRejected: false,
    };
    saveTokens(db, "fetch", forA);
    clearTokens(db, "fetch");
    expect(loadTokens(db, "fetch")).toBeNull();
    saveTokens(db, "fetch", { ...forA, accessToken: "at-for-b", refreshToken: null, tokenEndpoint: null });
    expect(loadTokens(db, "fetch")!.tokenEndpoint).toBeNull();
    expect(loadTokens(db, "fetch")!.accessToken).toBe("at-for-b");
  });
});

// ------------------------------------------- the real loopback callback wire

/** Open one connection, optionally write a request line, and let it close.
 * Deliberately raw TCP rather than `fetch`: a connection the listener refuses
 * to treat as the callback is DESTROYED without a reply (matching Rust, which
 * simply drops the socket), which `fetch` would surface as a transport error. */
function knock(port: number, requestLine: string | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => {
      if (requestLine === null) {
        sock.end();
        return;
      }
      sock.write(`${requestLine} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`, () => resolve());
    });
    sock.on("close", () => resolve());
    sock.on("error", () => reject(new Error("connection failed")));
  });
}

describe("the loopback callback listener — real TCP", () => {
  it("ignores a speculative connection and a non-callback request, and resolves on the real redirect", async () => {
    // Browsers open speculative connections and close them again, and one can
    // land on the callback port before the redirect does. Serving exactly one
    // accepted socket meant that connection consumed the sign-in: the user
    // completed it correctly and got "the sign-in did not complete".
    const { server, redirectUri } = await bindCallback();
    const port = Number(new URL(redirectUri).port);
    const waiting = awaitCallback(server, "ST", 10_000);
    await knock(port, null); // accepted, then closed with nothing sent
    await knock(port, "GET /favicon.ico"); // not the callback at all
    await knock(port, "GET /callback?code=abc123&state=ST"); // the real redirect
    await expect(waiting).resolves.toBe("abc123");
    server.close();
  });

  it("refuses a callback whose state belongs to a different sign-in", async () => {
    const { server, redirectUri } = await bindCallback();
    const port = Number(new URL(redirectUri).port);
    const waiting = awaitCallback(server, "ST", 10_000);
    const seen = waiting.catch((e: unknown) => e);
    await knock(port, "GET /callback?code=abc&state=WRONG");
    await expect(waiting).rejects.toThrow(/different sign-in's state/);
    await seen;
    server.close();
  });

  it("reports the provider's own refusal rather than waiting out the clock", async () => {
    const { server, redirectUri } = await bindCallback();
    const port = Number(new URL(redirectUri).port);
    const waiting = awaitCallback(server, "ST", 10_000);
    const seen = waiting.catch((e: unknown) => e);
    await knock(port, "GET /callback?error=access_denied&state=ST");
    await expect(waiting).rejects.toThrow(/provider refused the sign-in: access_denied/);
    await seen;
    server.close();
  });

  it("times out when nothing ever calls back", async () => {
    const { server } = await bindCallback();
    await expect(awaitCallback(server, "ST", 150)).rejects.toThrow(/timed out/);
    server.close();
  });

  it("queues a real callback while an earlier speculative socket is still being read", async () => {
    const { server, redirectUri } = await bindCallback();
    const port = Number(new URL(redirectUri).port);
    const waiting = awaitCallback(server, "ST", 10_000);
    const speculative = await new Promise<Socket>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => resolve(socket));
      socket.on("error", reject);
    });
    // The listener is still waiting for the speculative socket's request line,
    // so this redirect must be queued rather than dropped.
    const redirect = knock(port, "GET /callback?code=queued-code&state=ST");
    const unusedQueuedSocket = await new Promise<Socket>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => resolve(socket));
      socket.on("error", reject);
    });
    const unusedSocketClosed = new Promise<void>((resolve) => unusedQueuedSocket.once("close", resolve));
    speculative.end();
    await redirect;
    await expect(waiting).resolves.toBe("queued-code");
    await unusedSocketClosed;
    server.close();
  });

  it("drops an oversized non-callback request before accepting the real redirect", async () => {
    const { server, redirectUri } = await bindCallback();
    const port = Number(new URL(redirectUri).port);
    const waiting = awaitCallback(server, "ST", 10_000);
    const oversized = await new Promise<Socket>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => resolve(socket));
      socket.on("error", reject);
    });
    const dropped = new Promise<void>((resolve) => oversized.once("close", resolve));
    oversized.write("x".repeat(70_000));
    await dropped;
    await knock(port, "GET /callback?code=after-large-request&state=ST");
    await expect(waiting).resolves.toBe("after-large-request");
    server.close();
  });
});

describe("guarded discovery failure ordering", () => {
  it("continues across an empty PRM and invalid authorization metadata before reporting the final reason", async () => {
    let base = "";
    const server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://placeholder").pathname;
      if (pathname === "/missing") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({}));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (pathname === "/prm-empty") {
        res.end(JSON.stringify({ authorization_servers: [] }));
        return;
      }
      if (pathname === "/prm-invalid") {
        res.end(JSON.stringify({ authorization_servers: [base] }));
        return;
      }
      if (pathname === "/prm-unreachable") {
        res.end(JSON.stringify({ authorization_servers: ["http://127.0.0.1:9"] }));
        return;
      }
      res.end(JSON.stringify({ authorization_endpoint: `${base}/authorize` }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    base = `http://127.0.0.1:${port}`;
    try {
      await expect(discover([`${base}/prm-empty`, `${base}/prm-invalid`], PERMISSIVE_TEST_GUARD)).rejects.toThrow(
        /is missing required endpoints/
      );
      await expect(discover([`${base}/missing`], PERMISSIVE_TEST_GUARD)).rejects.toThrow(/returned HTTP 404/);
      await expect(discover([`${base}/prm-unreachable`], PERMISSIVE_TEST_GUARD)).rejects.toThrow(
        /request to .* failed/
      );
    } finally {
      await closeServer(server);
    }
  });

  it("preserves no-host, resolver, fetch, and HTTPS-default-port guard failures", async () => {
    const noHost: OutboundGuard = {
      checkEndpoint: () => new URL("file:///metadata"),
      resolveAddr: async () => ({ address: "127.0.0.1", port: 80 }),
    };
    await expect(discover(["ignored"], noHost)).rejects.toThrow("ignored has no host — refused.");

    const resolverFailure: OutboundGuard = {
      checkEndpoint: (url) => new URL(url),
      resolveAddr: async () => Promise.reject(new Error("DNS check failed")),
    };
    await expect(discover(["http://oauth.example/metadata"], resolverFailure)).rejects.toThrow("DNS check failed");

    const unreachable: OutboundGuard = {
      checkEndpoint: (url) => new URL(url),
      resolveAddr: async (_host, port) => ({ address: "127.0.0.1", port }),
    };
    await expect(discover(["http://127.0.0.1:9/metadata"], unreachable)).rejects.toThrow(/request to .* failed/);

    let resolvedPort = 0;
    const httpsDefault: OutboundGuard = {
      checkEndpoint: (url) => new URL(url),
      resolveAddr: async (_host, port) => {
        resolvedPort = port;
        return { address: "127.0.0.1", port };
      },
    };
    await expect(discover(["https://127.0.0.1/metadata"], httpsDefault)).rejects.toThrow(/request to .* failed/);
    expect(resolvedPort).toBe(443);
  });

  it("turns an aborted guarded metadata request into the exact timeout error", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(abortError);
    try {
      await expect(discover(["https://oauth.example/metadata"], PERMISSIVE_TEST_GUARD)).rejects.toThrow(
        "request to https://oauth.example/metadata timed out"
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// --------------------------------------------------- real end-to-end wire

/** Skips the private-network classification (the fixture server IS on loopback)
 * while still doing a real fetch — see this file's own module doc. */
const PERMISSIVE_TEST_GUARD: OutboundGuard = {
  checkEndpoint: (url) => new URL(url),
  resolveAddr: async (host, port) => ({ address: host, port }),
};

interface OAuthErrorFixture {
  baseUrl: string;
  server: Server;
}

function startOAuthErrorFixture(): Promise<OAuthErrorFixture> {
  let baseUrl = "";
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://placeholder").pathname;
      if (pathname === "/invalid-json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("not JSON");
        return;
      }
      if (pathname === "/redirect-loop") {
        res.writeHead(302, { location: `${baseUrl}/redirect-loop` });
        res.end();
        return;
      }
      if (pathname === "/register-status") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "registration rejected" }));
        return;
      }
      if (pathname === "/register-missing") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({}));
        return;
      }
      if (pathname === "/token-invalid") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("not JSON");
        return;
      }
      if (pathname === "/token-error") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      if (pathname === "/token-default") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({}));
        return;
      }
      if (pathname === "/prm-manual") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ authorization_servers: [baseUrl] }));
        return;
      }
      if (pathname === "/.well-known/oauth-authorization-server") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ authorization_endpoint: `${baseUrl}/authorize`, token_endpoint: `${baseUrl}/token` }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({}));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve({ baseUrl, server });
    });
  });
}

describe("OAuth protocol failure wire", () => {
  it("keeps unreadable metadata, redirect exhaustion, and registration failures distinct", async () => {
    const fixture = await startOAuthErrorFixture();
    try {
      expect(redirectTarget(302, "http://[", new URL(`${fixture.baseUrl}/source`))).toBeNull();
      await expect(discover([`${fixture.baseUrl}/invalid-json`], PERMISSIVE_TEST_GUARD)).rejects.toThrow(/sent invalid JSON/);
      await expect(discover([`${fixture.baseUrl}/redirect-loop`], PERMISSIVE_TEST_GUARD)).rejects.toThrow(
        /redirected too many times/
      );
      await expect(registerClient("http://127.0.0.1:9/register", "http://127.0.0.1/callback", PERMISSIVE_TEST_GUARD)).rejects.toThrow(
        /client registration failed/
      );
      await expect(registerClient(`${fixture.baseUrl}/register-status`, "http://127.0.0.1/callback", PERMISSIVE_TEST_GUARD)).rejects.toThrow(
        /client registration returned HTTP 400/
      );
      await expect(registerClient(`${fixture.baseUrl}/register-missing`, "http://127.0.0.1/callback", PERMISSIVE_TEST_GUARD)).rejects.toThrow(
        /registration response had no client_id/
      );
    } finally {
      await closeServer(fixture.server);
    }
  });

  it("keeps unreadable and rejected token responses observable without retiring transport failures", async () => {
    const fixture = await startOAuthErrorFixture();
    try {
      await expect(refreshTokens(`${fixture.baseUrl}/token-invalid`, "client", "refresh", PERMISSIVE_TEST_GUARD)).rejects.toMatchObject({
        rejected: false,
      });
      await expect(refreshTokens(`${fixture.baseUrl}/token-error`, "client", "refresh", PERMISSIVE_TEST_GUARD)).rejects.toMatchObject({
        message: "invalid_grant",
        rejected: true,
      });
      await expect(refreshTokens(`${fixture.baseUrl}/token-default`, "client", "refresh", PERMISSIVE_TEST_GUARD)).rejects.toMatchObject({
        message: "token request rejected",
        rejected: true,
      });
    } finally {
      await closeServer(fixture.server);
    }
  });

  it("does not open a browser when metadata requires manual client setup", async () => {
    const fixture = await startOAuthErrorFixture();
    try {
      await expect(
        authorize(`${fixture.baseUrl}/resource`, `Bearer resource_metadata="${fixture.baseUrl}/prm-manual"`, {
          openBrowser: () => {
            throw new Error("browser should not open");
          },
          guard: PERMISSIVE_TEST_GUARD,
        })
      ).rejects.toThrow(/requires manual client setup/);
    } finally {
      await closeServer(fixture.server);
    }
  });

  it("probes the challenge header and degrades to null for ordinary or failed calls", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 401, headers: { "www-authenticate": "Bearer challenge" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockRejectedValueOnce(new Error("offline"));
    try {
      await expect(probeWwwAuthenticate("https://mcp.example/one")).resolves.toBe("Bearer challenge");
      await expect(probeWwwAuthenticate("https://mcp.example/two")).resolves.toBeNull();
      await expect(probeWwwAuthenticate("https://mcp.example/three")).resolves.toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

interface OAuthFixture {
  baseUrl: string;
  server: Server;
  registeredClientIds: string[];
  issuedCodes: Map<string, { clientId: string; codeChallenge: string; redirectUri: string }>;
  tokenRequests: URLSearchParams[];
}

/** A minimal, REAL OAuth authorization server + protected-resource metadata
 * host, all on one loopback `node:http` server, differentiated by path. */
function startOAuthFixture(publicHost = "127.0.0.1"): Promise<OAuthFixture> {
  const registeredClientIds: string[] = [];
  const issuedCodes = new Map<string, { clientId: string; codeChallenge: string; redirectUri: string }>();
  const tokenRequests: URLSearchParams[] = [];
  let clientCounter = 0;
  // Known once `listen()`'s callback runs, below — every request handler
  // closure reads it lazily (on each REQUEST, not at server-creation time), so
  // this is not a temporal-dead-zone hazard.
  let baseUrl = "";

  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://placeholder");
        const bodyText = Buffer.concat(chunks).toString("utf8");

        if (url.pathname === "/.well-known/oauth-protected-resource") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ authorization_servers: [baseUrl], scopes_supported: ["read"] }));
          return;
        }
        if (url.pathname === "/.well-known/oauth-authorization-server") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              authorization_endpoint: `${baseUrl}/authorize`,
              token_endpoint: `${baseUrl}/token`,
              registration_endpoint: `${baseUrl}/register`,
            })
          );
          return;
        }
        if (url.pathname === "/register" && req.method === "POST") {
          clientCounter += 1;
          const clientId = `client-${clientCounter}`;
          registeredClientIds.push(clientId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ client_id: clientId }));
          return;
        }
        if (url.pathname === "/authorize") {
          // The "browser" (the injected openBrowser, below) drives this
          // directly: issue a code and 302 back to the redirect_uri, exactly
          // like a real authorization server's consent-granted response.
          const clientId = url.searchParams.get("client_id") ?? "";
          const codeChallenge = url.searchParams.get("code_challenge") ?? "";
          const redirectUri = url.searchParams.get("redirect_uri") ?? "";
          const state = url.searchParams.get("state") ?? "";
          const code = `code-${Math.random().toString(36).slice(2)}`;
          issuedCodes.set(code, { clientId, codeChallenge, redirectUri });
          res.writeHead(302, {
            Location: `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
          });
          res.end();
          return;
        }
        if (url.pathname === "/token" && req.method === "POST") {
          const form = new URLSearchParams(bodyText);
          tokenRequests.push(form);
          const grant = form.get("grant_type");
          if (grant === "authorization_code") {
            if (!issuedCodes.has(form.get("code") ?? "")) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "invalid_grant" }));
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                access_token: "issued-access-token",
                refresh_token: "issued-refresh-token",
                expires_in: 3600,
              })
            );
            return;
          }
          if (grant === "refresh_token") {
            const rt = form.get("refresh_token");
            if (rt === "dead-refresh-token") {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "invalid_grant", error_description: "the refresh token was revoked" }));
              return;
            }
            if (rt === "hollow-refresh-token") {
              // A 200 that carries NO access token: the endpoint answered, so
              // retrying gains nothing, and merging it would write an empty
              // `Bearer` header over the working one.
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ token_type: "bearer" }));
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ access_token: "renewed-access-token", expires_in: 3600 }));
            return;
          }
          res.writeHead(400, {});
          res.end();
          return;
        }
        res.writeHead(404, {});
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      baseUrl = `http://${publicHost}:${port}`;
      resolve({ baseUrl, server, registeredClientIds, issuedCodes, tokenRequests });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** A stand-in "browser": GETs the authorize URL, follows the fixture's 302
 * straight to the loopback redirect_uri, exactly as a real browser would —
 * proving `awaitCallback`'s real socket-reading path end to end. */
function driveBrowser(): (url: string) => Promise<void> {
  return async (url: string) => {
    // FIRE-AND-FORGET, matching a real browser (and the Rust source's own
    // `open_browser`, a plain non-async `Fn`): `authorize()` awaits this call
    // and only THEN starts `awaitCallback`'s connection listener, so this must
    // return before the redirect chain reaches the loopback callback listener,
    // or the second fetch below deadlocks waiting for a response nothing is yet
    // listening to accept.
    void (async () => {
      const authorizeResp = await fetch(url, { redirect: "manual" });
      const location = authorizeResp.headers.get("location");
      if (location === null) return;
      await fetch(location); // hits the real loopback callback listener
    })();
  };
}

describe("real end-to-end OAuth wire (loopback fixture, permissive test guard)", () => {
  it("pinned metadata requests answer Node's lookup-all shape", async () => {
    const fixture = await startOAuthFixture("oauth.example");
    const pinnedGuard: OutboundGuard = {
      checkEndpoint: (url) => new URL(url),
      resolveAddr: async (_host, port) => ({ address: "127.0.0.1", port }),
    };
    try {
      const result = await discover(
        [`${fixture.baseUrl}/.well-known/oauth-protected-resource`],
        pinnedGuard,
      );
      expect(result.meta.authorizationEndpoint).toBe(`${fixture.baseUrl}/authorize`);
      expect(result.meta.tokenEndpoint).toBe(`${fixture.baseUrl}/token`);
    } finally {
      await closeServer(fixture.server);
    }
  });

  it("discovers, registers, and drives the whole authorize flow to a stored token", async () => {
    const fixture = await startOAuthFixture();
    try {
      const announced: string[] = [];
      const token = await authorize(fixture.baseUrl, null, {
        openBrowser: driveBrowser(),
        onAuthorizeUrl: (u) => announced.push(u),
        guard: PERMISSIVE_TEST_GUARD,
        authTimeoutMs: 5_000,
      });
      expect(token.accessToken).toBe("issued-access-token");
      expect(token.refreshToken).toBe("issued-refresh-token");
      expect(token.tokenEndpoint).toBe(`${fixture.baseUrl}/token`);
      expect(fixture.registeredClientIds.length).toBe(1);
      expect(token.clientId).toBe(fixture.registeredClientIds[0]);

      // The UI's manual "open / copy the sign-in link" fallback is handed the
      // SAME url the browser was opened at.
      expect(announced.length).toBe(1);
      expect(announced[0]).toContain(`${fixture.baseUrl}/authorize?`);
      expect(announced[0]).toContain("code_challenge_method=S256");
      // Only what the RESOURCE published (`scopes_supported: ["read"]`), never
      // the authorization server's whole catalogue.
      expect(announced[0]).toContain("scope=read");

      // PKCE actually round-tripped: the code exchange carried a verifier whose
      // SHA-256 the fixture could (in a real AS) check against the challenge it
      // was handed at /authorize.
      const exchange = fixture.tokenRequests.find((f) => f.get("grant_type") === "authorization_code");
      expect(exchange?.get("code_verifier")).toBeTruthy();
      expect(exchange?.get("client_id")).toBe(fixture.registeredClientIds[0]);
    } finally {
      await closeServer(fixture.server);
    }
  });

  it("discovers via a WWW-Authenticate header naming the PRM URL directly", async () => {
    const fixture = await startOAuthFixture();
    try {
      const www = `Bearer resource_metadata="${fixture.baseUrl}/.well-known/oauth-protected-resource"`;
      const token = await authorize(fixture.baseUrl, www, {
        openBrowser: driveBrowser(),
        guard: PERMISSIVE_TEST_GUARD,
        authTimeoutMs: 5_000,
      });
      expect(token.accessToken).toBe("issued-access-token");
    } finally {
      await closeServer(fixture.server);
    }
  });

  it("refreshes a real expiring token against the fixture's token endpoint", async () => {
    const fixture = await startOAuthFixture();
    try {
      const stored: TokenSet = {
        accessToken: "old",
        refreshToken: "some-refresh-token",
        expiresAt: nowSecs() - 5, // already expired
        clientId: "cid",
        tokenEndpoint: `${fixture.baseUrl}/token`,
        refreshRejected: false,
      };
      const outcome = await refreshIfExpiring(stored, PERMISSIVE_TEST_GUARD);
      if (outcome?.ok !== true) throw new Error("expected a successful refresh");
      expect(outcome.token.accessToken).toBe("renewed-access-token");
      // The endpoint the fixture never returns is carried over from `stored`.
      expect(outcome.token.tokenEndpoint).toBe(`${fixture.baseUrl}/token`);
      expect(outcome.token.refreshToken).toBe("some-refresh-token");
    } finally {
      await closeServer(fixture.server);
    }
  });

  it("a real revoked refresh token comes back Rejected, not Unreachable", async () => {
    const fixture = await startOAuthFixture();
    try {
      const stored: TokenSet = {
        accessToken: "old",
        refreshToken: "dead-refresh-token",
        expiresAt: nowSecs() - 5,
        clientId: "cid",
        tokenEndpoint: `${fixture.baseUrl}/token`,
        refreshRejected: false,
      };
      const outcome = await refreshIfExpiring(stored, PERMISSIVE_TEST_GUARD);
      if (outcome?.ok !== false) throw new Error("expected a rejected refresh");
      expect(outcome.error.rejected).toBe(true);
      expect(outcome.error.message).toContain("revoked");
      // …and that is what `mark_refresh_rejected` is allowed to act on.
      expect(canRefresh(markRefreshRejected(stored))).toBe(false);
    } finally {
      await closeServer(fixture.server);
    }
  });

  it("a 200 carrying no access token is a refusal, not a renewal", async () => {
    const fixture = await startOAuthFixture();
    try {
      const stored: TokenSet = {
        accessToken: "old-but-working",
        refreshToken: "hollow-refresh-token",
        expiresAt: nowSecs() - 5,
        clientId: "cid",
        tokenEndpoint: `${fixture.baseUrl}/token`,
        refreshRejected: false,
      };
      const outcome = await refreshIfExpiring(stored, PERMISSIVE_TEST_GUARD);
      if (outcome?.ok !== false) throw new Error("expected a refusal");
      expect(outcome.error.rejected).toBe(true);
      expect(outcome.error.message).toContain("no access token");
    } finally {
      await closeServer(fixture.server);
    }
  });

  it("a provider that denies consent surfaces as a refusal, not a timeout", async () => {
    const fixture = await startOAuthFixture();
    try {
      const denyingBrowser = async (url: string): Promise<void> => {
        const parsed = new URL(url);
        const redirectUri = parsed.searchParams.get("redirect_uri")!;
        const state = parsed.searchParams.get("state")!;
        // Fire-and-forget — see `driveBrowser`'s own comment for why.
        void fetch(`${redirectUri}?error=access_denied&state=${encodeURIComponent(state)}`);
      };
      await expect(
        authorize(fixture.baseUrl, null, {
          openBrowser: denyingBrowser,
          guard: PERMISSIVE_TEST_GUARD,
          authTimeoutMs: 5_000,
        })
      ).rejects.toThrow(/access_denied/);
    } finally {
      await closeServer(fixture.server);
    }
  });

  it("times out cleanly when the browser never completes the redirect", async () => {
    const fixture = await startOAuthFixture();
    try {
      await expect(
        authorize(fixture.baseUrl, null, {
          openBrowser: async () => {
            /* never drives the redirect */
          },
          guard: PERMISSIVE_TEST_GUARD,
          authTimeoutMs: 300,
        })
      ).rejects.toThrow(/timed out/);
    } finally {
      await closeServer(fixture.server);
    }
  });
});
