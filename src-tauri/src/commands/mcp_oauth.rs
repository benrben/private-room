//! OAuth 2.1 for remote MCP connectors (MCP authorization spec, 2025-06-18).
//!
//! Hosted servers (GitHub, Notion, Stripe…) answer an unauthenticated request
//! with `401` + a `WWW-Authenticate` header pointing at their Protected Resource
//! Metadata (RFC 9728). From there we discover the Authorization Server (RFC
//! 8414), register a public client (RFC 7591 dynamic client registration), and
//! run the authorization-code flow with PKCE (RFC 7636) through the system
//! browser and a loopback redirect. The resulting token is stored encrypted in
//! the room DB (like `leash_token`) and attached as a `Bearer` header when the
//! connector connects.
//!
//! The pure pieces here — PKCE, header/metadata parsing, the authorize URL, the
//! token request bodies, and the token store — are unit-tested. The interactive
//! orchestration (`authorize`) composes those tested primitives; it needs a live
//! OAuth MCP server to exercise end to end.

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::db;

const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
/// How long we wait for the user to finish the browser sign-in.
const AUTH_TIMEOUT: Duration = Duration::from_secs(300);

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

// ------------------------------------------------------------------- PKCE

/// A PKCE pair: the secret `verifier` we keep, and the `challenge` (its SHA-256,
/// base64url) we send in the authorize request.
#[derive(Clone, Debug)]
pub(crate) struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

pub(crate) fn generate_pkce() -> Pkce {
    let mut raw = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut raw);
    let verifier = b64url(&raw); // 43 chars, RFC 7636 §4.1 compliant
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    Pkce { verifier, challenge }
}

// ----------------------------------------------------------- discovery parse

/// Pull the Protected Resource Metadata URL out of a 401's `WWW-Authenticate`
/// header: `Bearer resource_metadata="https://…/.well-known/…"`. RFC 9728.
pub(crate) fn parse_www_authenticate(header: &str) -> Option<String> {
    // Find `resource_metadata="..."` (case-insensitive key), return the quoted
    // value. Tolerant of extra params and spacing.
    let lower = header.to_ascii_lowercase();
    let key = "resource_metadata";
    let at = lower.find(key)?;
    let after = &header[at + key.len()..];
    let after = after.trim_start().strip_prefix('=')?.trim_start();
    let after = after.strip_prefix('"')?;
    let end = after.find('"')?;
    Some(after[..end].to_string())
}

/// The `/.well-known/oauth-protected-resource` URLs to try for a base resource
/// URL — the fallback when a server sends no `WWW-Authenticate` (probe path).
///
/// RFC 9728 §3.1 puts the RESOURCE's own path after the well-known segment, so
/// a server hosting several MCP resources publishes one document per path and
/// the origin-only URL 404s. The origin-only form stays as the second
/// candidate: a server with a single resource commonly publishes only that.
pub(crate) fn well_known_prm(resource_url: &str) -> Vec<String> {
    let base = resource_url.trim_end_matches('/');
    let origin = origin_of(base);
    let path = base.strip_prefix(&origin).unwrap_or("");
    let mut out = vec![format!("{origin}/.well-known/oauth-protected-resource{path}")];
    let origin_only = format!("{origin}/.well-known/oauth-protected-resource");
    if !out.contains(&origin_only) {
        out.push(origin_only);
    }
    out
}

fn origin_of(url: &str) -> String {
    // scheme://host[:port] — strip any path.
    match url.split_once("://") {
        Some((scheme, rest)) => {
            let host = rest.split('/').next().unwrap_or(rest);
            format!("{scheme}://{host}")
        }
        None => url.trim_end_matches('/').to_string(),
    }
}

/// Protected Resource Metadata → the authorization servers it trusts.
pub(crate) fn parse_resource_metadata(json: &serde_json::Value) -> Vec<String> {
    json["authorization_servers"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

/// What the RESOURCE says it needs (RFC 9728 `scopes_supported`) — the only
/// scopes the consent screen may be asked for. The authorization server's own
/// list is everything it CAN issue, which for a read-only connector means
/// putting write and admin on the consent screen for nothing.
pub(crate) fn parse_prm_scopes(json: &serde_json::Value) -> Vec<String> {
    json["scopes_supported"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

/// The endpoints we need off an Authorization Server Metadata document.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AuthServerMeta {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub registration_endpoint: Option<String>,
}

pub(crate) fn parse_auth_server_metadata(json: &serde_json::Value) -> Option<AuthServerMeta> {
    Some(AuthServerMeta {
        authorization_endpoint: json["authorization_endpoint"].as_str()?.to_string(),
        token_endpoint: json["token_endpoint"].as_str()?.to_string(),
        registration_endpoint: json["registration_endpoint"].as_str().map(String::from),
    })
}

/// Build the authorize URL (RFC 6749 §4.1.1 + PKCE + RFC 8707 `resource`).
pub(crate) fn build_authorize_url(
    endpoint: &str,
    client_id: &str,
    redirect_uri: &str,
    challenge: &str,
    state: &str,
    scope: &str,
    resource: &str,
) -> String {
    let q = [
        ("response_type", "code"),
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
        ("state", state),
        ("scope", scope),
        ("resource", resource),
    ];
    let query = q
        .iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(k, v)| format!("{k}={}", urlencode(v)))
        .collect::<Vec<_>>()
        .join("&");
    let sep = if endpoint.contains('?') { '&' } else { '?' };
    format!("{endpoint}{sep}{query}")
}

/// Minimal percent-encoding for query values (RFC 3986 unreserved kept).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ------------------------------------------------------------- token store

/// A stored credential set for one remote connector.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub(crate) struct TokenSet {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Unix seconds when the access token expires (0 = unknown/never).
    #[serde(default)]
    pub expires_at: u64,
    /// The dynamically-registered client id, reused on refresh.
    #[serde(default)]
    pub client_id: Option<String>,
    /// The token endpoint, stored so a refresh is self-contained (no re-discovery).
    #[serde(default)]
    pub token_endpoint: Option<String>,
    /// Set once the provider REFUSED this refresh token — the user revoked the
    /// app, or the grant expired. A silent renewal can never succeed again, so
    /// the sign-in indicator must stop reading "Signed in" and offer the browser
    /// again. Cleared by signing in (a fresh set never carries it).
    #[serde(default)]
    pub refresh_rejected: bool,
}

/// Why a token request failed. A provider that REJECTS it (any non-2xx —
/// `invalid_grant` after the user revoked the app, an expired refresh token) is
/// final: retrying renews nothing. A transport failure is NOT final — the Mac
/// may simply be offline, and treating that as a dead sign-in would push the
/// user through the browser for a connector that still works.
#[derive(Debug)]
pub(crate) enum TokenError {
    Rejected(String),
    Unreachable(String),
}

impl TokenError {
    /// True when the sign-in itself is over, not just this attempt.
    pub(crate) fn is_rejected(&self) -> bool {
        matches!(self, Self::Rejected(_))
    }
}

impl std::fmt::Display for TokenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rejected(m) | Self::Unreachable(m) => f.write_str(m),
        }
    }
}

fn token_key(server: &str) -> String {
    format!("oauth:{server}")
}

pub(crate) fn save_tokens(conn: &rusqlite::Connection, server: &str, t: &TokenSet) -> Result<(), String> {
    let json = serde_json::to_string(t).map_err(|e| e.to_string())?;
    db::set_setting(conn, &token_key(server), &json)
}

pub(crate) fn load_tokens(conn: &rusqlite::Connection, server: &str) -> Option<TokenSet> {
    let raw = db::get_setting(conn, &token_key(server))?;
    serde_json::from_str(&raw).ok()
}

pub(crate) fn clear_tokens(conn: &rusqlite::Connection, server: &str) -> Result<(), String> {
    // An empty value reads back as "no tokens" (load parses "" → None).
    db::set_setting(conn, &token_key(server), "")
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// True when the access token is missing or within 60s of expiry.
pub(crate) fn needs_refresh(t: &TokenSet) -> bool {
    t.access_token.is_empty() || (t.expires_at != 0 && t.expires_at <= now_secs() + 60)
}

/// True when an expiring token can be renewed without the user: we kept a
/// refresh token, the token endpoint and the registered client id at sign-in —
/// and the provider has not already refused that refresh token. Having the
/// pieces on file is not the same as them still working, and a connector whose
/// sign-in was revoked has to say so or the only way back is deleting it.
pub(crate) fn can_refresh(t: &TokenSet) -> bool {
    let filled = |v: &Option<String>| v.as_deref().is_some_and(|s| !s.is_empty());
    !t.refresh_rejected
        && filled(&t.refresh_token)
        && filled(&t.token_endpoint)
        && filled(&t.client_id)
}

/// The stored set marked un-renewable, for persisting after the provider refused
/// the refresh token. The rest is kept: it still records which account this was,
/// and signing in replaces the whole set anyway. A transport failure must NEVER
/// reach here — see [`TokenError`].
pub(crate) fn mark_refresh_rejected(t: &TokenSet) -> TokenSet {
    TokenSet {
        refresh_rejected: true,
        ..t.clone()
    }
}

/// Fold a refresh response into the stored set. RFC 6749 §6 lets the server
/// omit `refresh_token` (the old one stays valid), and the token endpoint we
/// discovered at sign-in never comes back in the response — keeping both is
/// what makes the NEXT refresh self-contained too. Pure — unit-tested.
pub(crate) fn merge_refreshed(stored: &TokenSet, mut fresh: TokenSet) -> TokenSet {
    if fresh.refresh_token.is_none() {
        fresh.refresh_token = stored.refresh_token.clone();
    }
    if fresh.token_endpoint.is_none() {
        fresh.token_endpoint = stored.token_endpoint.clone();
    }
    if fresh.client_id.is_none() {
        fresh.client_id = stored.client_id.clone();
    }
    fresh
}

/// Renew a stored token that is at (or near) expiry, returning the token set to
/// persist. `None` means "nothing to do": the token is still good, or there is
/// nothing to renew it with and the user has to sign in again by hand.
pub(crate) async fn refresh_if_expiring(
    stored: &TokenSet,
) -> Option<Result<TokenSet, TokenError>> {
    if !needs_refresh(stored) || !can_refresh(stored) {
        return None;
    }
    let endpoint = stored.token_endpoint.as_deref()?;
    let client_id = stored.client_id.as_deref()?;
    let refresh_token = stored.refresh_token.as_deref()?;
    Some(
        refresh_tokens(endpoint, client_id, refresh_token)
            .await
            .and_then(|fresh| {
                if fresh.access_token.is_empty() {
                    // A 200 with no token is not a renewal — merging it would
                    // write an empty `Bearer` header over the working one. The
                    // endpoint answered, so retrying gains nothing.
                    return Err(TokenError::Rejected(
                        "the refresh response carried no access token".to_string(),
                    ));
                }
                Ok(merge_refreshed(stored, fresh))
            }),
    )
}

// -------------------------------------------------------- async HTTP steps

fn http() -> Result<reqwest::Client, String> {
    // rustls: auth servers are HTTPS/h2 and macOS native-tls doesn't reliably
    // negotiate h2 via ALPN (see mcp_registry). Identify ourselves too.
    reqwest::Client::builder()
        .use_rustls_tls()
        .user_agent(concat!("Arcelle/", env!("CARGO_PKG_VERSION")))
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

/// Every address in this flow that the CONNECTOR chose, checked before we go
/// anywhere near it.
///
/// The sign-in flow is the one place the app follows addresses a remote server
/// hands it: the `WWW-Authenticate` challenge names the protected-resource
/// metadata document, that document names an authorization server, and that
/// server's own metadata names the authorize, token and registration
/// endpoints. A hostile (or merely compromised) connector could therefore point
/// any of them at `http://127.0.0.1:…` or a `192.168.x.x` box and use this Mac
/// as a probe of its own network — the classic SSRF shape, and the reason
/// `web::check_public_http_url` exists for every other outbound fetch.
///
/// This is the LITERAL half of the check, and on its own it was never enough: a
/// name that resolves to 127.0.0.1 passes it. Nothing outbound calls it
/// directly — [`guarded_client`] does, and every address the CONNECTOR chose
/// goes through that, so a new discovery step cannot leave with less. The one
/// request that does not is [`probe_www_authenticate`], which asks the server
/// the user themselves configured — an MCP server on this Mac is a legitimate
/// thing to connect to, and refusing it here would only break that.
fn checked_endpoint(url: &str) -> Result<reqwest::Url, String> {
    crate::web::check_public_http_url(url)
        .map_err(|_| format!("{url} is a local or private-network address — refused."))
}

/// One hop of one OAuth request, with the whole outbound guard on it.
///
/// The literal check above only sees what the connector WROTE. A hostname it
/// controls can still resolve to 127.0.0.1 (DNS rebinding), so the host is
/// resolved here and every address it returns has to be public — and the
/// client is then pinned to the address that was checked, closing the window
/// where the check and the connection resolve differently. Redirects are never
/// followed by reqwest: a `Location` is chosen by the same untrusted server, so
/// it comes back through this function ([`fetch_json`]) or is not followed at
/// all. Same doctrine, and the same reasons, as `web::fetch`'s `guarded_get`.
async fn guarded_client(url: &str) -> Result<(reqwest::Url, reqwest::Client), String> {
    let parsed = checked_endpoint(url)?;
    let host = parsed
        .host_str()
        .ok_or_else(|| format!("{url} has no host — refused."))?
        .to_string();
    let port = parsed.port_or_known_default().unwrap_or(443);
    crate::web::resolve_public_addr(&host, port)
        .await
        .map_err(|e| format!("{url}: {e}"))
        .and_then(|addr| {
            // rustls: auth servers are HTTPS/h2 and macOS native-tls doesn't
            // reliably negotiate h2 via ALPN (see mcp_registry). Identify
            // ourselves too.
            reqwest::Client::builder()
                .use_rustls_tls()
                .user_agent(concat!("Arcelle/", env!("CARGO_PKG_VERSION")))
                .timeout(HTTP_TIMEOUT)
                .redirect(reqwest::redirect::Policy::none())
                .resolve(&host, addr)
                .build()
                .map_err(|e| e.to_string())
        })
        .map(|client| (parsed, client))
}

/// How many redirects one metadata fetch may follow. Every hop is re-checked
/// by [`guarded_client`], which is the only reason following them is safe.
const MAX_REDIRECTS: usize = 3;

/// Where a response says to go next, absolutized against the URL it came from.
/// `None` for anything that is not a redirect carrying a usable `Location` —
/// which then falls through to the normal status handling. Pure — unit-tested.
fn redirect_target(status: u16, location: Option<&str>, from: &reqwest::Url) -> Option<String> {
    if !matches!(status, 301 | 302 | 303 | 307 | 308) {
        return None;
    }
    let location = location?.trim();
    if location.is_empty() {
        return None;
    }
    from.join(location).ok().map(|u| u.to_string())
}

/// Fetch a JSON metadata document.
async fn fetch_json(url: &str) -> Result<serde_json::Value, String> {
    let mut next = url.to_string();
    for _ in 0..=MAX_REDIRECTS {
        let (parsed, client) = guarded_client(&next).await?;
        let resp = client
            .get(parsed.clone())
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| format!("discovery request to {next} failed: {e}"))?;
        let location = resp
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        if let Some(hop) = redirect_target(resp.status().as_u16(), location.as_deref(), &parsed) {
            next = hop;
            continue;
        }
        if !resp.status().is_success() {
            return Err(format!("{next} returned HTTP {}", resp.status().as_u16()));
        }
        return resp
            .json()
            .await
            .map_err(|e| format!("{next} sent invalid JSON: {e}"));
    }
    Err(format!("{url} redirected too many times"))
}

/// The authorization-server metadata URLs to try for one issuer, in order.
///
/// RFC 8414 §3.1 INSERTS the well-known segment between the host and the
/// issuer's path (`https://host/.well-known/oauth-authorization-server/tenant-42`)
/// — which is what multi-tenant deployments publish, and what appending the
/// segment could never find. The appended form is the OIDC Discovery 1.0
/// layout, which many of the same servers also answer, and an OIDC-only server
/// has no `oauth-authorization-server` document at all. An issuer without a
/// path makes the two forms identical, hence the de-duplication.
pub(crate) fn auth_metadata_urls(issuer: &str) -> Vec<String> {
    let issuer = issuer.trim_end_matches('/');
    let origin = origin_of(issuer);
    let path = issuer.strip_prefix(&origin).unwrap_or("");
    let mut out: Vec<String> = Vec::new();
    for name in ["oauth-authorization-server", "openid-configuration"] {
        for candidate in [
            format!("{origin}/.well-known/{name}{path}"),
            format!("{issuer}/.well-known/{name}"),
        ] {
            if !out.contains(&candidate) {
                out.push(candidate);
            }
        }
    }
    out
}

/// PRM URL candidates → the auth server's endpoints, plus the scopes the
/// RESOURCE asks for. Follows RFC 9728 → RFC 8414.
///
/// Every candidate is tried before the sign-in is declared impossible: a
/// resource may publish its metadata under either well-known form, and a
/// document listing several authorization servers means the first one being
/// down or misconfigured is not the resource's last word. Only the final
/// failure is reported — an earlier 404 on a URL that was only ever a guess is
/// not what went wrong.
pub(crate) async fn discover(prm_urls: &[String]) -> Result<(AuthServerMeta, Vec<String>), String> {
    let mut last = "no protected-resource metadata URL to try".to_string();
    for prm_url in prm_urls {
        let prm = match fetch_json(prm_url).await {
            Ok(v) => v,
            Err(e) => {
                last = e;
                continue;
            }
        };
        let scopes = parse_prm_scopes(&prm);
        let servers = parse_resource_metadata(&prm);
        if servers.is_empty() {
            last = format!("{prm_url} lists no authorization servers");
            continue;
        }
        for server in &servers {
            for meta_url in auth_metadata_urls(server) {
                match fetch_json(&meta_url).await {
                    Ok(asm) => match parse_auth_server_metadata(&asm) {
                        Some(meta) => return Ok((meta, scopes)),
                        None => {
                            last = format!("{meta_url} is missing required endpoints");
                        }
                    },
                    Err(e) => last = e,
                }
            }
        }
    }
    Err(last)
}

/// RFC 7591 dynamic client registration for a public + PKCE client.
async fn register_client(endpoint: &str, redirect_uri: &str) -> Result<String, String> {
    let (url, client) = guarded_client(endpoint).await?;
    let body = serde_json::json!({
        "client_name": "Arcelle",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });
    let resp = client
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("client registration failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("client registration returned HTTP {}", resp.status().as_u16()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    v["client_id"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| "registration response had no client_id".into())
}

/// Exchange the authorization code for tokens (RFC 6749 §4.1.3 + PKCE).
async fn exchange_code(
    token_endpoint: &str,
    client_id: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<TokenSet, String> {
    let form = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", client_id),
        ("code_verifier", verifier),
    ];
    post_token(token_endpoint, &form, client_id)
        .await
        .map_err(|e| e.to_string())
}

/// Refresh an expired access token (RFC 6749 §6). A stored `token_endpoint` +
/// `client_id` + `refresh_token` is all it needs, so no re-discovery. Driven by
/// [`refresh_if_expiring`], which every connector connect runs first.
pub(crate) async fn refresh_tokens(
    token_endpoint: &str,
    client_id: &str,
    refresh_token: &str,
) -> Result<TokenSet, TokenError> {
    let form = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", client_id),
    ];
    post_token(token_endpoint, &form, client_id).await
}

async fn post_token(
    endpoint: &str,
    form: &[(&str, &str)],
    client_id: &str,
) -> Result<TokenSet, TokenError> {
    // Unreachable, not Rejected: a refused address says nothing about whether
    // the stored refresh token is still good, and `mark_refresh_rejected` must
    // not retire a live sign-in over it.
    let (url, client) = guarded_client(endpoint)
        .await
        .map_err(TokenError::Unreachable)?;
    let resp = client
        .post(url)
        .form(form)
        .send()
        .await
        .map_err(|e| TokenError::Unreachable(format!("token request failed: {e}")))?;
    let status = resp.status();
    let v: serde_json::Value = resp
        .json()
        .await
        // A reply we can't read is not a refusal — don't retire a sign-in for it.
        .map_err(|e| TokenError::Unreachable(e.to_string()))?;
    if !status.is_success() {
        let msg = v["error_description"]
            .as_str()
            .or_else(|| v["error"].as_str())
            .unwrap_or("token request rejected");
        return Err(TokenError::Rejected(msg.to_string()));
    }
    Ok(parse_token_response(&v, client_id))
}

/// Parse a token endpoint response into a `TokenSet`. Pure — unit-tested.
pub(crate) fn parse_token_response(v: &serde_json::Value, client_id: &str) -> TokenSet {
    let expires_at = match v["expires_in"].as_u64() {
        Some(secs) => now_secs() + secs,
        None => 0,
    };
    TokenSet {
        access_token: v["access_token"].as_str().unwrap_or("").to_string(),
        refresh_token: v["refresh_token"].as_str().map(String::from),
        expires_at,
        client_id: Some(client_id.to_string()),
        token_endpoint: None,
        // A set the provider just issued is renewable by definition.
        refresh_rejected: false,
    }
}

/// Probe a remote MCP URL for its `WWW-Authenticate` header — the direct route
/// to the resource-metadata URL (RFC 9728) when the server sends one. Best
/// effort: `None` on any error falls back to the well-known PRM path.
pub(crate) async fn probe_www_authenticate(url: &str) -> Option<String> {
    let resp = http()
        .ok()?
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .json(&serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                       "clientInfo": {"name": "Arcelle", "version": "probe"}}
        }))
        .send()
        .await
        .ok()?;
    if resp.status().as_u16() != 401 {
        return None;
    }
    resp.headers()
        .get("www-authenticate")
        .and_then(|v| v.to_str().ok())
        .map(String::from)
}

// ------------------------------------------------------ loopback callback

/// Bind a loopback listener and return (redirect_uri, listener). The port is
/// ephemeral so nothing needs to be reserved.
async fn bind_callback() -> Result<(String, TcpListener), String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("could not bind the callback listener: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    Ok((format!("http://127.0.0.1:{port}/callback"), listener))
}

/// How long one connection has to send its request line. Short: the browser
/// has already made the request by the time it connects.
const CALLBACK_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Cap on the bytes read looking for the request line. Far above any real
/// authorization code (the old single 4 KB read could truncate a long one),
/// and small enough that a local process cannot stream memory into us.
const MAX_CALLBACK_REQUEST: usize = 64 * 1024;

/// The request target ("/callback?code=…") of one connection, read with its own
/// timeout and a bounded buffer. `None` for a connection that sends nothing in
/// time, closes early, or overruns the cap — none of those is the callback.
async fn read_request_target(stream: &mut tokio::net::TcpStream) -> Option<String> {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 2048];
    let line = tokio::time::timeout(CALLBACK_READ_TIMEOUT, async {
        loop {
            if let Some(at) = buf.iter().position(|b| *b == b'\n') {
                return Some(String::from_utf8_lossy(&buf[..at]).into_owned());
            }
            if buf.len() >= MAX_CALLBACK_REQUEST {
                return None;
            }
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => return None,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        }
    })
    .await
    .ok()??;
    line.split_whitespace().nth(1).map(str::to_string)
}

async fn write_callback_page(stream: &mut tokio::net::TcpStream, ok: bool) {
    let page = if ok {
        "<h2>Signed in.</h2><p>You can close this tab and return to Arcelle.</p>"
    } else {
        "<h2>Sign-in failed.</h2><p>Return to Arcelle and try again.</p>"
    };
    let body = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\n\r\n{page}",
        page.len()
    );
    let _ = stream.write_all(body.as_bytes()).await;
    let _ = stream.flush().await;
}

/// Serve the browser's redirect, extract `?code=&state=`, and show the user a
/// "you can close this tab" page.
///
/// Every connection until the deadline gets a look, not just the first one.
/// Browsers open speculative connections and close them again, and serving
/// exactly one accepted socket lost real sign-ins to them: a socket that sent
/// nothing blocked the read forever (only the accept was under a timeout), and
/// one that closed immediately consumed the single accept and reported failure
/// for a sign-in the user had completed correctly. Only a request that carries
/// a `code` — or the provider's own `error` — ends the wait.
async fn await_callback(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    let timed_out = || "timed out waiting for the browser sign-in".to_string();
    let deadline = tokio::time::Instant::now() + AUTH_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(timed_out());
        }
        let accepted = tokio::time::timeout(remaining, listener.accept())
            .await
            .map_err(|_| timed_out())?;
        let (mut stream, _) = accepted.map_err(|e| e.to_string())?;
        let Some(target) = read_request_target(&mut stream).await else {
            continue;
        };
        // The user pressed Deny, or the provider refused: that IS an answer,
        // and it is the provider's words rather than our guess at them.
        if let Some(why) = callback_error(&target) {
            write_callback_page(&mut stream, false).await;
            return Err(format!("the provider refused the sign-in: {why}"));
        }
        let (code, state) = parse_callback_query(&target);
        if code.is_empty() {
            // A speculative connection, a favicon request, anything that is not
            // the redirect: leave the wait open for the real one.
            continue;
        }
        let ok = state == expected_state;
        write_callback_page(&mut stream, ok).await;
        if !ok {
            return Err("the sign-in did not complete (the browser sent back a different sign-in's state)".into());
        }
        return Ok(code);
    }
}

/// The provider's own refusal off a callback target, `error_description` for
/// preference. Pure — unit-tested.
pub(crate) fn callback_error(target: &str) -> Option<String> {
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut error = None;
    let mut description = None;
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            match k {
                "error" => error = Some(urldecode(v)),
                "error_description" => description = Some(urldecode(v)),
                _ => {}
            }
        }
    }
    let error = error.filter(|e| !e.is_empty())?;
    Some(match description.filter(|d| !d.is_empty()) {
        Some(d) => format!("{error} — {d}"),
        None => error,
    })
}

/// Pull `code` and `state` out of a `/callback?code=…&state=…` request target.
/// Pure — unit-tested.
pub(crate) fn parse_callback_query(target: &str) -> (String, String) {
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut code = String::new();
    let mut state = String::new();
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            let val = urldecode(v);
            match k {
                "code" => code = val,
                "state" => state = val,
                _ => {}
            }
        }
    }
    (code, state)
}

/// Percent-decode a query value.
///
/// Byte by byte, never by re-slicing the `&str`: `&s[i + 1..i + 3]` panics when
/// a `%` is followed by a multi-byte character, and the whole sign-in task went
/// down with it — the drawer sat on "Waiting for your browser…" for ever. This
/// runs on anything a local process can send the loopback port.
fn urldecode(s: &str) -> String {
    fn hex(b: u8) -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            b'A'..=b'F' => Some(b - b'A' + 10),
            _ => None,
        }
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                match (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                    (Some(hi), Some(lo)) => {
                        out.push(hi * 16 + lo);
                        i += 3;
                        continue;
                    }
                    // Not an escape after all — keep the byte as it arrived.
                    _ => out.push(bytes[i]),
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Run the full interactive authorization for one remote connector at
/// `resource_url`, returning tokens to store. Composes the tested primitives;
/// opens the system browser via `open_browser`. Needs a live OAuth MCP server
/// to verify end to end.
pub(crate) async fn authorize(
    resource_url: &str,
    www_authenticate: Option<&str>,
    open_browser: impl Fn(&str) -> Result<(), String>,
) -> Result<TokenSet, String> {
    let prm_urls = match www_authenticate.and_then(parse_www_authenticate) {
        // The server named its own metadata document; nothing to guess at.
        Some(url) => vec![url],
        None => well_known_prm(resource_url),
    };
    let (meta, prm_scopes) = discover(&prm_urls).await?;
    let (redirect_uri, listener) = bind_callback().await?;
    let client_id = match &meta.registration_endpoint {
        Some(reg) => register_client(reg, &redirect_uri).await?,
        None => return Err("this server requires manual client setup (no registration endpoint)".into()),
    };
    let pkce = generate_pkce();
    let state = b64url(&{
        let mut s = [0u8; 16];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut s);
        s
    });
    // Only what the RESOURCE published. Asking for the union of everything the
    // authorization server supports put write and admin on the consent screen
    // for a connector that may only need to read, and the stored token then
    // carried them. With nothing published we send no `scope` at all
    // (`build_authorize_url` drops empty parameters) and the provider applies
    // its own default, which is a narrower ask than its superset.
    let scope = prm_scopes.join(" ");
    let url = build_authorize_url(
        &meta.authorization_endpoint,
        &client_id,
        &redirect_uri,
        &pkce.challenge,
        &state,
        &scope,
        resource_url,
    );
    open_browser(&url)?;
    let code = await_callback(listener, &state).await?;
    let mut token =
        exchange_code(&meta.token_endpoint, &client_id, &code, &pkce.verifier, &redirect_uri)
            .await?;
    // Keep the token endpoint so a later refresh needs no re-discovery.
    token.token_endpoint = Some(meta.token_endpoint);
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SSRF: every address in the sign-in flow past the user's own server URL
    /// is chosen by the connector, so a private one must be refused before any
    /// request is made — the same rule every other outbound fetch follows.
    #[test]
    fn discovery_and_token_endpoints_refuse_private_addresses() {
        for url in [
            "http://127.0.0.1:11434/.well-known/oauth-authorization-server",
            "http://localhost:8080/token",
            "http://192.168.1.20/register",
            "http://[::1]:9000/token",
            "http://router.local/authorize",
            "http://169.254.169.254/latest/meta-data/",
        ] {
            let err = checked_endpoint(url).unwrap_err();
            assert!(err.contains("private-network"), "should refuse {url}: {err}");
        }
        assert!(checked_endpoint("https://auth.example.com/token").is_ok());
    }

    /// The literal check above is only half of it: the client that actually
    /// leaves the machine has to resolve the name, refuse a private answer, and
    /// pin what it checked. A private literal must never get that far.
    #[tokio::test]
    async fn the_outbound_client_refuses_a_private_address() {
        for url in ["http://127.0.0.1:11434/token", "http://192.168.1.20/register"] {
            assert!(guarded_client(url).await.is_err(), "should refuse {url}");
        }
    }

    /// A redirect is chosen by the same server the guard exists to distrust, so
    /// following one means running the WHOLE check again on the target — which
    /// is only possible because the hop is computed rather than handed to
    /// reqwest's redirect policy.
    #[test]
    fn a_redirect_hop_is_resolved_and_then_re_checked() {
        let from = reqwest::Url::parse("https://auth.example.com/.well-known/x").unwrap();
        assert_eq!(
            redirect_target(302, Some("http://127.0.0.1:11434/api/generate"), &from).as_deref(),
            Some("http://127.0.0.1:11434/api/generate"),
        );
        // …and that computed hop is exactly what the guard then refuses.
        assert!(checked_endpoint("http://127.0.0.1:11434/api/generate").is_err());
        // Relative Location, absolutized against the URL it came from.
        assert_eq!(
            redirect_target(301, Some("/other"), &from).as_deref(),
            Some("https://auth.example.com/other"),
        );
        // Not a redirect, or a redirect with nothing usable → normal handling.
        assert_eq!(redirect_target(200, Some("/other"), &from), None);
        assert_eq!(redirect_target(302, None, &from), None);
        assert_eq!(redirect_target(302, Some("  "), &from), None);
    }

    /// A refused endpoint must never be read as the provider REFUSING the
    /// refresh token: that retires the sign-in and forces the user back through
    /// the browser for something the server never said.
    #[tokio::test]
    async fn a_private_token_endpoint_is_unreachable_not_rejected() {
        let err = refresh_tokens("http://127.0.0.1:9/token", "cid", "rt")
            .await
            .unwrap_err();
        assert!(!err.is_rejected(), "must not retire the sign-in: {err}");
    }

    #[test]
    fn pkce_pair_is_well_formed() {
        let p = generate_pkce();
        // Verifier 43 chars (32 bytes b64url-nopad), URL-safe alphabet only.
        assert_eq!(p.verifier.len(), 43);
        assert!(p.verifier.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        // Challenge is the b64url SHA-256 of the verifier ASCII.
        assert_eq!(p.challenge, b64url(&Sha256::digest(p.verifier.as_bytes())));
        // Two calls differ (randomness).
        assert_ne!(generate_pkce().verifier, p.verifier);
    }

    #[test]
    fn parses_www_authenticate_resource_metadata() {
        let h = r#"Bearer error="invalid_token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource""#;
        assert_eq!(
            parse_www_authenticate(h).as_deref(),
            Some("https://mcp.example.com/.well-known/oauth-protected-resource")
        );
        assert_eq!(parse_www_authenticate("Bearer").none_ish(), true);
    }

    /// RFC 9728 §3.1: the resource's path goes AFTER the well-known segment, so
    /// a host with several MCP resources 404s on the origin-only URL. Both
    /// forms are tried, path first.
    #[test]
    fn well_known_prm_tries_the_resource_path_first() {
        assert_eq!(
            well_known_prm("https://mcp.example.com/mcp/v1"),
            vec![
                "https://mcp.example.com/.well-known/oauth-protected-resource/mcp/v1",
                "https://mcp.example.com/.well-known/oauth-protected-resource",
            ]
        );
        // A resource at the root makes the two identical — one candidate, not
        // the same request twice.
        assert_eq!(
            well_known_prm("https://mcp.example.com/"),
            vec!["https://mcp.example.com/.well-known/oauth-protected-resource"]
        );
    }

    /// A multi-tenant issuer (`https://auth.example.com/tenant-42`) publishes
    /// its metadata with the well-known segment INSERTED, so appending it — the
    /// only form this used to build — could never find the document, and every
    /// such connector died on a 404 with no way forward in the app.
    #[test]
    fn auth_metadata_urls_cover_the_path_and_oidc_forms() {
        assert_eq!(
            auth_metadata_urls("https://auth.example.com/tenant-42"),
            vec![
                "https://auth.example.com/.well-known/oauth-authorization-server/tenant-42",
                "https://auth.example.com/tenant-42/.well-known/oauth-authorization-server",
                "https://auth.example.com/.well-known/openid-configuration/tenant-42",
                "https://auth.example.com/tenant-42/.well-known/openid-configuration",
            ]
        );
        // A path-less issuer: the two forms coincide, so two candidates, and a
        // trailing slash must not produce a doubled one.
        assert_eq!(
            auth_metadata_urls("https://auth.example.com/"),
            vec![
                "https://auth.example.com/.well-known/oauth-authorization-server",
                "https://auth.example.com/.well-known/openid-configuration",
            ]
        );
    }

    #[test]
    fn parses_metadata_documents() {
        let prm = serde_json::json!({
            "authorization_servers": ["https://auth.example.com"],
            "scopes_supported": ["read"]
        });
        assert_eq!(parse_resource_metadata(&prm), vec!["https://auth.example.com"]);
        // The consent screen asks for what the RESOURCE published, never the
        // authorization server's whole catalogue.
        assert_eq!(parse_prm_scopes(&prm), vec!["read"]);
        let asm = serde_json::json!({
            "authorization_endpoint": "https://auth.example.com/authorize",
            "token_endpoint": "https://auth.example.com/token",
            "registration_endpoint": "https://auth.example.com/register",
            "scopes_supported": ["read", "write", "admin"]
        });
        let m = parse_auth_server_metadata(&asm).unwrap();
        assert_eq!(m.authorization_endpoint, "https://auth.example.com/authorize");
        assert_eq!(m.token_endpoint, "https://auth.example.com/token");
        assert_eq!(m.registration_endpoint.as_deref(), Some("https://auth.example.com/register"));
        // A PRM with no scopes means NO scope parameter — the provider's own
        // default — rather than the AS-wide superset above.
        assert!(parse_prm_scopes(&serde_json::json!({"authorization_servers": []})).is_empty());
        let url = build_authorize_url("https://a/authorize", "c", "http://127.0.0.1:1/cb", "CH", "ST", "", "https://r");
        assert!(!url.contains("scope="), "{url}");
        // Missing token_endpoint → None (can't proceed).
        let bad = serde_json::json!({"authorization_endpoint": "x"});
        assert!(parse_auth_server_metadata(&bad).is_none());
    }

    #[test]
    fn authorize_url_has_pkce_and_encoded_params() {
        let url = build_authorize_url(
            "https://auth.example.com/authorize",
            "client123",
            "http://127.0.0.1:5000/callback",
            "CHAL",
            "STATE",
            "read write",
            "https://mcp.example.com/mcp",
        );
        assert!(url.contains("response_type=code"));
        assert!(url.contains("code_challenge=CHAL"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("client_id=client123"));
        // redirect_uri and scope space are percent-encoded.
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fcallback"));
        assert!(url.contains("scope=read%20write"));
        assert!(url.contains("resource=https%3A%2F%2Fmcp.example.com%2Fmcp"));
    }

    #[test]
    fn parses_callback_query() {
        let (code, state) = parse_callback_query("/callback?code=abc123&state=xyz&extra=1");
        assert_eq!(code, "abc123");
        assert_eq!(state, "xyz");
        // Percent-encoded code is decoded.
        let (code, _) = parse_callback_query("/callback?code=a%2Fb&state=s");
        assert_eq!(code, "a/b");
        // No query → empty.
        assert_eq!(parse_callback_query("/callback"), (String::new(), String::new()));
        // A malformed escape used to PANIC the sign-in task (re-slicing the
        // &str through a multi-byte character), leaving the drawer waiting for
        // a browser that had already answered. Anything on the loopback port
        // can send these.
        assert_eq!(parse_callback_query("/callback?code=%a\u{FFFD}&state=s").0, "%a\u{FFFD}");
        assert_eq!(parse_callback_query("/callback?code=ab%").0, "ab%");
        assert_eq!(parse_callback_query("/callback?code=%zz").0, "%zz");
        assert_eq!(parse_callback_query("/callback?code=a%2").0, "a%2");
        // `+` is a space, and a lone trailing `%` after a decoded escape still
        // survives.
        assert_eq!(parse_callback_query("/callback?code=a+b%2Fc%").0, "a b/c%");
    }

    /// A denied consent screen redirects with `error=`, not `code=`. The wait
    /// now ignores requests without a code (browsers pre-connect), so a refusal
    /// has to be recognised or the drawer would sit there until it timed out.
    #[test]
    fn a_refused_signin_is_read_off_the_callback() {
        assert_eq!(
            callback_error("/callback?error=access_denied&state=s").as_deref(),
            Some("access_denied"),
        );
        assert_eq!(
            callback_error("/callback?error=invalid_scope&error_description=Scope+admin+is+unknown")
                .as_deref(),
            Some("invalid_scope — Scope admin is unknown"),
        );
        // The successful callback is not an error, and neither is a browser's
        // speculative GET.
        assert_eq!(callback_error("/callback?code=abc&state=s"), None);
        assert_eq!(callback_error("/favicon.ico"), None);
        assert_eq!(callback_error("/callback?error=&state=s"), None);
    }

    /// Browsers open speculative connections and close them again, and one can
    /// land on the callback port before the redirect does. Serving exactly one
    /// accepted socket meant that connection consumed the sign-in: the user
    /// completed it correctly and got "the sign-in did not complete".
    #[tokio::test]
    async fn only_the_real_callback_ends_the_wait() {
        let (_redirect, listener) = bind_callback().await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { await_callback(listener, "ST").await });

        // A speculative connection: accepted, then closed with nothing sent.
        drop(tokio::net::TcpStream::connect(addr).await.unwrap());
        // A request that is not the callback at all.
        let mut noise = tokio::net::TcpStream::connect(addr).await.unwrap();
        noise
            .write_all(b"GET /favicon.ico HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .unwrap();
        // The redirect the user's browser actually makes.
        let mut real = tokio::net::TcpStream::connect(addr).await.unwrap();
        real.write_all(b"GET /callback?code=abc123&state=ST HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .unwrap();

        // Bounded so a regression fails the suite instead of hanging it for
        // the five minutes a real sign-in is allowed.
        let got = tokio::time::timeout(Duration::from_secs(10), task)
            .await
            .expect("the wait should have ended at the real callback")
            .unwrap();
        assert_eq!(got.unwrap(), "abc123");
    }

    #[test]
    fn parses_token_response_and_expiry() {
        let v = serde_json::json!({
            "access_token": "at1", "refresh_token": "rt1", "expires_in": 3600
        });
        let t = parse_token_response(&v, "client123");
        assert_eq!(t.access_token, "at1");
        assert_eq!(t.refresh_token.as_deref(), Some("rt1"));
        assert!(t.expires_at > now_secs()); // roughly now + 3600
        assert_eq!(t.client_id.as_deref(), Some("client123"));
        assert!(!needs_refresh(&t));
        // No expiry field → expires_at 0 (unknown), not "expired".
        let t2 = parse_token_response(&serde_json::json!({"access_token": "x"}), "c");
        assert_eq!(t2.expires_at, 0);
        assert!(!needs_refresh(&t2));
        // Empty access token always needs refresh.
        let t3 = parse_token_response(&serde_json::json!({}), "c");
        assert!(needs_refresh(&t3));
    }

    #[test]
    fn expiring_token_is_renewable_and_the_refresh_folds_in() {
        // Everything a silent renewal needs was stored at sign-in.
        let mut t = TokenSet {
            access_token: "at".into(),
            refresh_token: Some("rt".into()),
            expires_at: now_secs() + 10, // inside the 60s window
            client_id: Some("cid".into()),
            token_endpoint: Some("https://auth.example.com/token".into()),
            refresh_rejected: false,
        };
        assert!(needs_refresh(&t));
        assert!(can_refresh(&t), "an expiring token with a refresh token is not dead");
        // Missing any one piece means the user really does have to sign in again.
        for strip in 0..3 {
            let mut broken = t.clone();
            match strip {
                0 => broken.refresh_token = None,
                1 => broken.token_endpoint = None,
                _ => broken.client_id = None,
            }
            assert!(!can_refresh(&broken));
        }
        // A refresh response omits the endpoint (and often the refresh token);
        // both must survive so the NEXT renewal is self-contained too.
        let fresh = parse_token_response(
            &serde_json::json!({"access_token": "at2", "expires_in": 3600}),
            "cid",
        );
        assert!(fresh.token_endpoint.is_none());
        let merged = merge_refreshed(&t, fresh);
        assert_eq!(merged.access_token, "at2");
        assert_eq!(merged.refresh_token.as_deref(), Some("rt"));
        assert_eq!(
            merged.token_endpoint.as_deref(),
            Some("https://auth.example.com/token")
        );
        assert!(!needs_refresh(&merged));
        // A rotated refresh token replaces the old one.
        let rotated = parse_token_response(
            &serde_json::json!({"access_token": "at3", "refresh_token": "rt2"}),
            "cid",
        );
        assert_eq!(merge_refreshed(&t, rotated).refresh_token.as_deref(), Some("rt2"));
        // A token that is still good is left alone.
        t.expires_at = now_secs() + 3600;
        assert!(!needs_refresh(&t));
    }

    #[test]
    fn a_revoked_signin_stops_reading_as_renewable() {
        // Having a refresh token, endpoint and client id on file is not the same
        // as them still WORKING. Once the provider refuses the refresh token the
        // drawer must stop saying "Signed in" with a greyed-out button — that
        // button is the only way to re-authorize, so leaving it inert left the
        // user with nothing but removing the connector and adding it again.
        let live = TokenSet {
            access_token: "at".into(),
            refresh_token: Some("rt".into()),
            expires_at: now_secs() + 10,
            client_id: Some("cid".into()),
            token_endpoint: Some("https://auth.example.com/token".into()),
            refresh_rejected: false,
        };
        assert!(needs_refresh(&live) && can_refresh(&live));

        let dead = mark_refresh_rejected(&live);
        assert!(!can_refresh(&dead), "a refused grant is not renewable");
        // What `mcp_oauth_status` computes: signed in = still good, or renewable.
        let signed_in = |t: &TokenSet| !needs_refresh(t) || can_refresh(t);
        assert!(signed_in(&live));
        assert!(!signed_in(&dead), "the sign-in button has to become usable");
        // Nothing else is thrown away — the account is still identifiable, and
        // signing in again replaces the whole set.
        assert_eq!(dead.refresh_token, live.refresh_token);
        assert_eq!(dead.token_endpoint, live.token_endpoint);
        // The flag survives the store, and older tokens (written before it
        // existed) read back as renewable rather than failing to parse.
        let conn = db::open_in_memory_schema();
        save_tokens(&conn, "vendor", &dead).unwrap();
        assert!(!can_refresh(&load_tokens(&conn, "vendor").unwrap()));
        db::set_setting(
            &conn,
            "oauth:legacy",
            r#"{"access_token":"at","refresh_token":"rt","expires_at":1,
                "client_id":"cid","token_endpoint":"https://auth.example.com/token"}"#,
        )
        .unwrap();
        assert!(can_refresh(&load_tokens(&conn, "legacy").unwrap()));
    }

    #[test]
    fn only_a_refusal_retires_a_signin_not_a_flaky_network() {
        // Being offline is not a revoked account: retiring the sign-in for a
        // transport failure would push the user through the browser for a
        // connector that still works perfectly.
        assert!(TokenError::Rejected("invalid_grant".into()).is_rejected());
        assert!(!TokenError::Unreachable("token request failed: dns error".into()).is_rejected());
        assert_eq!(
            TokenError::Rejected("invalid_grant".into()).to_string(),
            "invalid_grant"
        );
    }

    #[test]
    fn token_store_round_trips() {
        let conn = db::open_in_memory_schema();
        assert!(load_tokens(&conn, "github").is_none());
        let t = TokenSet {
            access_token: "at".into(),
            refresh_token: Some("rt".into()),
            expires_at: 123,
            client_id: Some("cid".into()),
            token_endpoint: Some("https://auth.example.com/token".into()),
            refresh_rejected: false,
        };
        save_tokens(&conn, "github", &t).unwrap();
        assert_eq!(load_tokens(&conn, "github").unwrap(), t);
        // Per-server isolation.
        assert!(load_tokens(&conn, "notion").is_none());
        clear_tokens(&conn, "github").unwrap();
        assert!(load_tokens(&conn, "github").is_none());
    }

    // Tiny helper so the header test reads cleanly.
    trait NoneIsh {
        fn none_ish(&self) -> bool;
    }
    impl<T> NoneIsh for Option<T> {
        fn none_ish(&self) -> bool {
            self.is_none()
        }
    }
}
