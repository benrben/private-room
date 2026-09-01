import { randomBytes } from "node:crypto";
import {
  AUTH_TIMEOUT_MS,
  b64url,
  buildAuthorizeUrl,
  generatePkce,
  parseWwwAuthenticate,
  type TokenSet,
  wellKnownPrm,
} from "./mcpOauthModel.js";
import {
  REAL_GUARD,
  discover,
  exchangeCode,
  registerClient,
  type OutboundGuard,
} from "./mcpOauthHttp.js";
import { awaitCallback, bindCallback } from "./mcpOauthCallback.js";

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
