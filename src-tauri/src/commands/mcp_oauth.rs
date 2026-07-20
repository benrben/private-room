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

/// The `/.well-known/oauth-protected-resource` URL for a base resource URL —
/// the fallback when a server sends no `WWW-Authenticate` (probe path).
pub(crate) fn well_known_prm(resource_url: &str) -> String {
    let origin = origin_of(resource_url);
    format!("{origin}/.well-known/oauth-protected-resource")
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

/// The endpoints we need off an Authorization Server Metadata document.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AuthServerMeta {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub registration_endpoint: Option<String>,
    pub scopes_supported: Vec<String>,
}

pub(crate) fn parse_auth_server_metadata(json: &serde_json::Value) -> Option<AuthServerMeta> {
    Some(AuthServerMeta {
        authorization_endpoint: json["authorization_endpoint"].as_str()?.to_string(),
        token_endpoint: json["token_endpoint"].as_str()?.to_string(),
        registration_endpoint: json["registration_endpoint"].as_str().map(String::from),
        scopes_supported: json["scopes_supported"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default(),
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

// -------------------------------------------------------- async HTTP steps

fn http() -> Result<reqwest::Client, String> {
    // rustls: auth servers are HTTPS/h2 and macOS native-tls doesn't reliably
    // negotiate h2 via ALPN (see mcp_registry). Identify ourselves too.
    reqwest::Client::builder()
        .use_rustls_tls()
        .user_agent(concat!("PrivateRoom/", env!("CARGO_PKG_VERSION")))
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

/// Fetch a JSON metadata document.
async fn fetch_json(url: &str) -> Result<serde_json::Value, String> {
    let resp = http()?
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("discovery request to {url} failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("{url} returned HTTP {}", resp.status().as_u16()));
    }
    resp.json().await.map_err(|e| format!("{url} sent invalid JSON: {e}"))
}

/// PRM URL → the auth server's endpoints. Follows RFC 9728 → RFC 8414.
pub(crate) async fn discover(prm_url: &str) -> Result<AuthServerMeta, String> {
    let prm = fetch_json(prm_url).await?;
    let servers = parse_resource_metadata(&prm);
    let auth_server = servers
        .into_iter()
        .next()
        .ok_or("the resource metadata lists no authorization servers")?;
    // RFC 8414: metadata lives at /.well-known/oauth-authorization-server.
    let meta_url = format!(
        "{}/.well-known/oauth-authorization-server",
        auth_server.trim_end_matches('/')
    );
    let asm = fetch_json(&meta_url).await?;
    parse_auth_server_metadata(&asm)
        .ok_or_else(|| "authorization server metadata is missing required endpoints".into())
}

/// RFC 7591 dynamic client registration for a public + PKCE client.
async fn register_client(endpoint: &str, redirect_uri: &str) -> Result<String, String> {
    let body = serde_json::json!({
        "client_name": "Private Room",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });
    let resp = http()?
        .post(endpoint)
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
    post_token(token_endpoint, &form, client_id).await
}

/// Refresh an expired access token (RFC 6749 §6). Foundation for the
/// refresh-on-connect follow-up — a stored `token_endpoint` + `client_id` +
/// `refresh_token` is all it needs, so no re-discovery.
#[allow(dead_code)]
pub(crate) async fn refresh_tokens(
    token_endpoint: &str,
    client_id: &str,
    refresh_token: &str,
) -> Result<TokenSet, String> {
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
) -> Result<TokenSet, String> {
    let resp = http()?
        .post(endpoint)
        .form(form)
        .send()
        .await
        .map_err(|e| format!("token request failed: {e}"))?;
    let status = resp.status();
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg = v["error_description"]
            .as_str()
            .or_else(|| v["error"].as_str())
            .unwrap_or("token request rejected");
        return Err(msg.to_string());
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
                       "clientInfo": {"name": "Private Room", "version": "probe"}}
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

/// Serve exactly one request, extract `?code=&state=`, and show the user a
/// "you can close this tab" page. Times out so a cancelled sign-in can't hang.
async fn await_callback(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    let accept = tokio::time::timeout(AUTH_TIMEOUT, listener.accept())
        .await
        .map_err(|_| "timed out waiting for the browser sign-in".to_string())?;
    let (mut stream, _) = accept.map_err(|e| e.to_string())?;
    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let target = req
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("");
    let (code, state) = parse_callback_query(target);
    let ok = !code.is_empty() && state == expected_state;
    let page = if ok {
        "<h2>Signed in.</h2><p>You can close this tab and return to Private Room.</p>"
    } else {
        "<h2>Sign-in failed.</h2><p>Return to Private Room and try again.</p>"
    };
    let body = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\n\r\n{page}",
        page.len()
    );
    let _ = stream.write_all(body.as_bytes()).await;
    let _ = stream.flush().await;
    if !ok {
        return Err("the sign-in did not complete (state mismatch or denied)".into());
    }
    Ok(code)
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

fn urldecode(s: &str) -> String {
    let bytes = s.replace('+', " ");
    let bytes = bytes.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
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
    let prm_url = www_authenticate
        .and_then(parse_www_authenticate)
        .unwrap_or_else(|| well_known_prm(resource_url));
    let meta = discover(&prm_url).await?;
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
    let scope = meta.scopes_supported.join(" ");
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

    #[test]
    fn well_known_prm_uses_origin_only() {
        assert_eq!(
            well_known_prm("https://mcp.example.com/mcp/v1"),
            "https://mcp.example.com/.well-known/oauth-protected-resource"
        );
    }

    #[test]
    fn parses_metadata_documents() {
        let prm = serde_json::json!({
            "authorization_servers": ["https://auth.example.com"]
        });
        assert_eq!(parse_resource_metadata(&prm), vec!["https://auth.example.com"]);
        let asm = serde_json::json!({
            "authorization_endpoint": "https://auth.example.com/authorize",
            "token_endpoint": "https://auth.example.com/token",
            "registration_endpoint": "https://auth.example.com/register",
            "scopes_supported": ["read", "write"]
        });
        let m = parse_auth_server_metadata(&asm).unwrap();
        assert_eq!(m.authorization_endpoint, "https://auth.example.com/authorize");
        assert_eq!(m.token_endpoint, "https://auth.example.com/token");
        assert_eq!(m.registration_endpoint.as_deref(), Some("https://auth.example.com/register"));
        assert_eq!(m.scopes_supported, vec!["read", "write"]);
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
    fn token_store_round_trips() {
        let conn = db::open_in_memory_schema();
        assert!(load_tokens(&conn, "github").is_none());
        let t = TokenSet {
            access_token: "at".into(),
            refresh_token: Some("rt".into()),
            expires_at: 123,
            client_id: Some("cid".into()),
            token_endpoint: Some("https://auth.example.com/token".into()),
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
