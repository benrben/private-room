//! The connector marketplace: search a live MCP registry and normalize its
//! entries into something the room can install.
//!
//! This is the app's ONLY outbound "phone home", so it is gated behind an
//! explicit per-Mac opt-in (`mcp_registry_optin`): browsing the registry is a
//! network action and the privacy-first product must not do it silently. The
//! normalization ([`normalize_servers`]) is pure and unit-tested, so the shape
//! we depend on is pinned without a network round-trip.
//!
//! Installing an entry does NOT get its own privileged path: the frontend turns
//! an [`InstallSpec`] into the standard `mcpServers` fragment and calls
//! `mcp_apply_config`, so the SEC-1 approval + fingerprint gate still fires for
//! anything a marketplace click would start.

use base64::Engine;
use serde::Serialize;
use std::collections::HashSet;
use std::time::Duration;

/// The official Model Context Protocol registry. Returns `{ "servers": [...] }`.
const REGISTRY_URL: &str = "https://registry.modelcontextprotocol.io/v0/servers";
const REGISTRY_TIMEOUT: Duration = Duration::from_secs(15);

/// Send a request with a few retries + backoff — the registry endpoint is
/// intermittently slow to establish a connection (the first attempt often
/// fails, a retry succeeds), so a single shot is unreliable. The builder is
/// re-cloned each attempt.
async fn send_with_retries(req: reqwest::RequestBuilder) -> Result<reqwest::Response, String> {
    let mut last = String::from("no attempt made");
    for attempt in 0..4u32 {
        let Some(attempt_req) = req.try_clone() else {
            return Err("could not build the registry request".into());
        };
        match attempt_req.send().await {
            Ok(resp) => return Ok(resp),
            Err(e) => {
                last = e.to_string();
                tokio::time::sleep(Duration::from_millis(400 * u64::from(attempt + 1))).await;
            }
        }
    }
    Err(last)
}

/// One normalized marketplace listing — everything the card and the install
/// drawer need, derived from a registry server record.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    /// The registry's fully-qualified id, e.g. `io.github.microsoft/playwright-mcp`.
    pub id: String,
    /// Short display name (the part after the namespace).
    pub name: String,
    /// The registry's human title when it has one (nicer than `name`); the UI
    /// shows this and falls back to `name`.
    pub title: Option<String>,
    /// The server's icon as an inlined `data:` URI — the app's CSP blocks
    /// remote images, so `mcp_registry_search` fetches it through the opted-in
    /// registry seam and inlines it here. `None` → the UI shows a monogram.
    pub icon: Option<String>,
    pub description: String,
    /// The publisher/org, derived from the reverse-DNS namespace.
    pub publisher: String,
    /// True when the publisher demonstrably owns the namespace (the registry's
    /// real trust signal): the namespace owner matches the source repo owner.
    pub verified: bool,
    /// True when this listing installs a REMOTE endpoint — the seam where room
    /// data leaves the Mac. The card badges it amber; local is green.
    pub remote: bool,
    /// `"stdio"` | `"http"` | `"sse"` — shown as a plain badge.
    pub transport: String,
    pub repository: Option<String>,
    /// What "Install" would write into the room's `mcpServers` config.
    pub install: InstallSpec,
    /// The OTHER way to run this connector when the record offers both a local
    /// package and a remote endpoint — so the drawer can offer "run locally vs
    /// use the cloud version". `None` when only one transport exists. Privacy
    /// first: `install` prefers LOCAL, and this holds the remote alternative.
    pub alt_install: Option<InstallSpec>,
}

/// The concrete install shape the frontend expands into an `mcpServers` entry.
/// NOTE: `rename_all` on the enum only camelCases the VARIANT names (the `kind`
/// tag value). The variant FIELDS need their own per-variant `rename_all`, or
/// `env_keys`/`header_keys` ship snake_case and the frontend (which reads
/// `envKeys`/`headerKeys`) sees `undefined` → the drawer crashes.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum InstallSpec {
    /// A local child process. `envKeys` names the environment variables the
    /// server needs, so the drawer can render a field per secret.
    #[serde(rename_all = "camelCase")]
    Stdio {
        command: String,
        args: Vec<String>,
        env_keys: Vec<String>,
    },
    /// A remote HTTP endpoint. `headerKeys` names any auth headers to fill in
    /// (until interactive OAuth lands, the user pastes a token here).
    #[serde(rename_all = "camelCase")]
    Http {
        url: String,
        header_keys: Vec<String>,
    },
}

// ------------------------------------------------------------ normalization

/// Normalize a whole `{"servers": [...]}` registry payload. Tolerant: a record
/// we can't derive an install for (no packages, no remotes) is skipped rather
/// than failing the whole search.
pub(crate) fn normalize_servers(payload: &serde_json::Value) -> Vec<CatalogEntry> {
    // The registry lists a server once per published version, so the same `id`
    // recurs — keep the first (newest) and drop the rest, or the grid shows
    // three identical cards.
    let mut seen = HashSet::new();
    payload["servers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(normalize_one)
        .filter(|e| seen.insert(e.id.clone()))
        .collect()
}

/// The value at the first present key — the registry mixes camelCase (current
/// schema) and snake_case (older docs), so we accept both everywhere.
fn field<'a>(v: &'a serde_json::Value, keys: &[&str]) -> &'a serde_json::Value {
    for k in keys {
        let f = &v[*k];
        if !f.is_null() {
            return f;
        }
    }
    &serde_json::Value::Null
}

fn normalize_one(entry: &serde_json::Value) -> Option<CatalogEntry> {
    // The current registry wraps each item: `{ "server": {...}, "_meta": {...} }`.
    // Older docs put the fields at the top level, so fall back to the item.
    let s = if entry.get("server").is_some() {
        &entry["server"]
    } else {
        entry
    };
    let id = s["name"].as_str()?.to_string();
    let (publisher, name) = split_namespace(&id);
    let title = s["title"].as_str().map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    // The raw icon URL; mcp_registry_search replaces it with a data: URI (or
    // clears it) since the CSP won't load a remote image.
    let icon = s["icons"][0]["src"].as_str().map(String::from);
    let description = s["description"].as_str().unwrap_or("").to_string();
    let repository = s["repository"]["url"].as_str().map(String::from);
    let (install, alt_install) = derive_installs(s)?;
    let (remote, transport) = match &install {
        InstallSpec::Http { .. } => (true, remote_transport(s)),
        InstallSpec::Stdio { .. } => (false, "stdio".to_string()),
    };
    let verified = namespace_owns_repo(&publisher, repository.as_deref());
    Some(CatalogEntry {
        id,
        name,
        title,
        icon,
        description,
        publisher,
        verified,
        remote,
        transport,
        repository,
        install,
        alt_install,
    })
}

/// Split a reverse-DNS registry id into (publisher, display name). The display
/// name is what follows the slash, unless that's a generic token ("mcp",
/// "server", …), in which case the publisher reads better on the card.
fn split_namespace(id: &str) -> (String, String) {
    let (ns, raw_name) = match id.split_once('/') {
        Some((ns, name)) => (ns, name),
        None => ("", id),
    };
    let publisher = publisher_from_ns(ns);
    let name = if is_generic_name(raw_name) && !publisher.is_empty() {
        publisher.clone()
    } else {
        raw_name.to_string()
    };
    (publisher, name)
}

/// The org from a reverse-DNS namespace. `io.github.<owner>` / `io.gitlab.<owner>`
/// → the owner; otherwise the segment right after the leading TLD
/// (`com.notion` → "notion", `ac.inference.sh` → "inference").
fn publisher_from_ns(ns: &str) -> String {
    let segs: Vec<&str> = ns.split('.').filter(|s| !s.is_empty()).collect();
    if segs.len() >= 3 && segs[0] == "io" && (segs[1] == "github" || segs[1] == "gitlab") {
        return segs[2].to_string();
    }
    match segs.as_slice() {
        [] => String::new(),
        [one] => one.to_string(),
        _ => segs[1].to_string(),
    }
}

/// A display name too generic to identify the server on its own.
fn is_generic_name(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "mcp" | "server" | "mcp-server" | "mcpserver" | "mcp_server" | "main" | "app" | "index"
    )
}

/// The registry's trust signal: does the publisher (namespace owner) also own
/// the source repository? `io.github.microsoft/*` published from
/// `github.com/microsoft/*` proves control of the namespace.
fn namespace_owns_repo(publisher: &str, repo: Option<&str>) -> bool {
    if publisher.is_empty() {
        return false;
    }
    let Some(repo) = repo else { return false };
    // The owner is the path segment right after the host in a repo URL.
    let rest = repo.split_once("://").map(|(_, r)| r).unwrap_or(repo);
    let owner = rest.split('/').nth(1).unwrap_or("");
    !owner.is_empty() && owner.eq_ignore_ascii_case(publisher)
}

/// Resolve how a connector installs, returning `(primary, alternative)`.
///
/// PRIVACY FIRST: when a record offers BOTH a local package and a remote
/// endpoint (many do — e.g. run the `uvx` package on your Mac *or* hit the
/// vendor's hosted server), the primary is the LOCAL one so nothing leaves the
/// Mac by default, and the remote is returned as the alternative the drawer can
/// offer ("use the cloud version"). This reverses the earlier remote-first
/// choice, which had us install a vendor's (sometimes dead) hosted host over a
/// perfectly good local package. When only one transport exists it's the
/// primary and there's no alternative. `None` only when neither is derivable.
fn derive_installs(s: &serde_json::Value) -> Option<(InstallSpec, Option<InstallSpec>)> {
    let local = s["packages"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(derive_stdio);
    let remote = derive_remote(s);
    match (local, remote) {
        (Some(l), Some(r)) => Some((l, Some(r))), // both → local default, cloud alt
        (Some(l), None) => Some((l, None)),
        (None, Some(r)) => Some((r, None)),
        (None, None) => None,
    }
}

/// The remote endpoint install, if the record declares one.
fn derive_remote(s: &serde_json::Value) -> Option<InstallSpec> {
    let r = s["remotes"].as_array().and_then(|a| a.first())?;
    let url = r["url"].as_str()?;
    Some(InstallSpec::Http {
        url: url.to_string(),
        header_keys: named_keys(&r["headers"]),
    })
}

fn remote_transport(s: &serde_json::Value) -> String {
    let t = field(&s["remotes"][0], &["type", "transport_type"])
        .as_str()
        .unwrap_or("http");
    match t {
        "sse" => "sse".to_string(),
        _ => "http".to_string(), // streamable-http / http / anything else
    }
}

/// Turn a package record into a runnable command. Honors an explicit
/// `runtimeHint`, else maps the registry type to its usual runner. Accepts both
/// the current schema (`identifier`/`registryType`/`runtimeHint`) and older
/// snake_case (`name`/`registry_name`/`runtime_hint`).
fn derive_stdio(p: &serde_json::Value) -> Option<InstallSpec> {
    let pkg = field(p, &["identifier", "name"]).as_str()?.to_string();
    let registry = field(p, &["registryType", "registry_name"]).as_str().unwrap_or("");
    let hint = field(p, &["runtimeHint", "runtime_hint"]).as_str().unwrap_or("");
    let (command, args) = if !hint.is_empty() {
        (hint.to_string(), runner_args(hint, &pkg))
    } else {
        match registry {
            "pypi" => ("uvx".to_string(), vec![pkg.clone()]),
            "oci" | "docker" => (
                "docker".to_string(),
                vec!["run".into(), "-i".into(), "--rm".into(), pkg.clone()],
            ),
            // npm and unknown default to npx.
            _ => ("npx".to_string(), vec!["-y".into(), pkg.clone()]),
        }
    };
    Some(InstallSpec::Stdio {
        command,
        args,
        env_keys: named_keys(field(p, &["environmentVariables", "environment_variables"])),
    })
}

/// Default args for a known runner + package name.
fn runner_args(runner: &str, pkg: &str) -> Vec<String> {
    match runner {
        "npx" => vec!["-y".into(), pkg.into()],
        "docker" => vec!["run".into(), "-i".into(), "--rm".into(), pkg.into()],
        // uvx / uv / pipx / bunx: just the package.
        _ => vec![pkg.into()],
    }
}

/// Collect `name` fields from an array of `{name, ...}` records (used for env
/// vars and header hints). Empty for anything else.
fn named_keys(v: &serde_json::Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|e| e["name"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

// -------------------------------------------------------------------- icons

/// Fetch one icon and return it as a `data:` URI, or `None` on any problem.
/// Best-effort: only http(s) image responses under a size cap are inlined.
async fn fetch_icon(client: &reqwest::Client, url: &str) -> Option<String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return None;
    }
    let resp = client
        .get(url)
        .timeout(Duration::from_secs(6))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let mime = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|c| c.split(';').next().unwrap_or("").trim().to_string())
        .filter(|c| c.starts_with("image/"))?;
    let bytes = resp.bytes().await.ok()?;
    // Skip empty and anything too big to sit inline in a data URI (~300 KB).
    if bytes.is_empty() || bytes.len() > 300_000 {
        return None;
    }
    Some(format!(
        "data:{};base64,{}",
        mime,
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    ))
}

/// Replace each entry's raw icon URL with an inlined `data:` URI (or clear it).
/// All fetches run concurrently through the same opted-in registry client, so
/// the webview never contacts an icon host and the CSP stays intact.
async fn inline_icons(client: &reqwest::Client, entries: &mut [CatalogEntry]) {
    let fetches = entries.iter().map(|e| {
        let url = e.icon.clone();
        async move {
            match url {
                Some(u) => fetch_icon(client, &u).await,
                None => None,
            }
        }
    });
    let results = futures_util::future::join_all(fetches).await;
    for (e, data) in entries.iter_mut().zip(results) {
        e.icon = data;
    }
}

// ---------------------------------------------------------------- opt-in gate

/// PRIV: the registry opt-in lives in the app's own data folder (per-Mac, never
/// inside a room file) — same trust model as `mcp_approvals.json`.
fn registry_optin_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager as _;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("mcp_registry_optin"))
}

fn registry_opted_in(app: &tauri::AppHandle) -> bool {
    registry_optin_file(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim() == "1")
        .unwrap_or(false)
}

/// Whether the user has turned on registry browsing (the outbound fetch).
#[tauri::command]
pub fn mcp_registry_optin_status(app: tauri::AppHandle) -> bool {
    registry_opted_in(&app)
}

/// Turn registry browsing on or off. On = the app may reach the registry to
/// list connectors; off deletes the flag so it's air-gapped again.
#[tauri::command]
pub fn set_mcp_registry_optin(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let path = registry_optin_file(&app)?;
    if enabled {
        std::fs::write(path, "1").map_err(|e| e.to_string())
    } else {
        let _ = std::fs::remove_file(path);
        Ok(())
    }
}

// -------------------------------------------------------------------- search

/// Search the live registry and return normalized listings. Errors (surfaced to
/// the UI) when browsing is off — the frontend then shows the opt-in gate.
/// `query` filters client-side over name/publisher/description.
#[tauri::command]
pub async fn mcp_registry_search(
    app: tauri::AppHandle,
    query: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<CatalogEntry>, String> {
    if !registry_opted_in(&app) {
        return Err(
            "Browsing the connector registry reaches the internet. Turn it on to search."
                .into(),
        );
    }
    // rustls, not macOS native-tls: the registry is HTTP/2-only and native-tls's
    // ALPN doesn't reliably negotiate h2, which surfaces as "error sending
    // request". rustls does. The endpoint is also intermittently flaky, so retry.
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .user_agent(concat!("PrivateRoom/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(8))
        .timeout(REGISTRY_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    // Search happens SERVER-SIDE via the registry's `search` param — the
    // catalog has far more servers than one page, so filtering a fixed page
    // client-side would miss most matches (e.g. "yahoo" lives past the first
    // page). No query → browse the newest `limit` servers.
    let n = limit.unwrap_or(80).min(200).to_string();
    let mut params: Vec<(&str, String)> = vec![("limit", n)];
    if let Some(q) = query.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        params.push(("search", q.to_string()));
    }
    let req = client
        .get(REGISTRY_URL)
        .header("Accept", "application/json")
        .query(&params);
    let resp = send_with_retries(req).await.map_err(|e| {
        format!(
            "Couldn't reach the connector registry after several tries ({e}). \
             Check your internet connection and try again."
        )
    })?;
    if !resp.status().is_success() {
        return Err(format!("Registry returned HTTP {}.", resp.status().as_u16()));
    }
    let payload: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Registry sent a reply we couldn't read: {e}"))?;
    let mut entries = normalize_servers(&payload);
    inline_icons(&client, &mut entries).await;
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A representative slice of the LIVE registry payload: entries wrapped in
    /// `server`, current camelCase package fields (`registryType`/`identifier`/
    /// `runtimeHint`/`environmentVariables`) and `remotes[].type`. Entry [3] is
    /// the older UNWRAPPED snake_case shape, kept to prove back-compat.
    fn sample() -> serde_json::Value {
        serde_json::json!({
            "servers": [
                { "server": {
                    "name": "io.github.microsoft/playwright-mcp",
                    "title": "Playwright",
                    "description": "Drive a real browser.",
                    "icons": [{"src": "https://ex.com/pw.png", "mimeType": "image/png"}],
                    "repository": {"url": "https://github.com/microsoft/playwright-mcp", "source": "github"},
                    "packages": [
                        {"registryType": "npm", "identifier": "@playwright/mcp",
                         "version": "0.1.0", "runtimeHint": "npx", "transport": {"type": "stdio"}}
                    ]
                }, "_meta": {} },
                { "server": {
                    "name": "io.github.someone/db-tools",
                    "description": "Query Postgres.",
                    "repository": {"url": "https://github.com/otheruser/db-tools"},
                    "packages": [
                        {"registryType": "pypi", "identifier": "db-tools-mcp",
                         "environmentVariables": [{"name": "DATABASE_URL"}]}
                    ]
                } },
                { "server": {
                    "name": "com.notion/notion",
                    "description": "Notion workspace.",
                    "remotes": [
                        {"type": "streamable-http", "url": "https://mcp.notion.com/mcp"}
                    ]
                } },
                // Older UNWRAPPED + snake_case entry — must still normalize.
                {
                    "name": "io.github.legacy/tool",
                    "description": "old shape",
                    "packages": [{"registry_name": "npm", "name": "legacy-mcp", "runtime_hint": "npx"}]
                },
                { "server": { "name": "broken.no-install/x", "description": "no packages or remotes" } }
            ]
        })
    }

    #[test]
    fn normalizes_wrapped_package_with_verified_owner() {
        let e = &normalize_servers(&sample())[0];
        assert_eq!(e.id, "io.github.microsoft/playwright-mcp");
        assert_eq!(e.name, "playwright-mcp");
        // `title` is surfaced separately from the slug `name`; the raw icon URL
        // is extracted here (mcp_registry_search later inlines it as a data URI).
        assert_eq!(e.title.as_deref(), Some("Playwright"));
        assert_eq!(e.icon.as_deref(), Some("https://ex.com/pw.png"));
        assert_eq!(e.publisher, "microsoft");
        assert!(!e.remote);
        assert_eq!(e.transport, "stdio");
        // Local-only → no cloud alternative.
        assert!(e.alt_install.is_none());
        // Namespace owner "microsoft" matches the github repo owner → verified.
        assert!(e.verified);
        match &e.install {
            InstallSpec::Stdio { command, args, .. } => {
                assert_eq!(command, "npx");
                assert_eq!(args, &["-y", "@playwright/mcp"]);
            }
            _ => panic!("expected stdio"),
        }
    }

    #[test]
    fn pypi_maps_to_uvx_and_surfaces_env_keys() {
        let e = &normalize_servers(&sample())[1];
        // Namespace owner "someone" != repo owner "otheruser" → not verified.
        assert!(!e.verified);
        match &e.install {
            InstallSpec::Stdio { command, args, env_keys } => {
                assert_eq!(command, "uvx");
                assert_eq!(args, &["db-tools-mcp"]);
                assert_eq!(env_keys, &["DATABASE_URL"]);
            }
            _ => panic!("expected stdio"),
        }
    }

    #[test]
    fn remote_endpoint_is_flagged_and_http() {
        let e = &normalize_servers(&sample())[2];
        assert!(e.remote);
        assert_eq!(e.transport, "http");
        assert_eq!(e.publisher, "notion");
        // Remote-only → no local alternative.
        assert!(e.alt_install.is_none());
        match &e.install {
            InstallSpec::Http { url, .. } => assert_eq!(url, "https://mcp.notion.com/mcp"),
            _ => panic!("expected http"),
        }
    }

    #[test]
    fn dual_transport_prefers_local_and_offers_cloud_alt() {
        // A record with BOTH a local package and a remote endpoint (mcparmory's
        // google-search is exactly this). Privacy-first: the primary install is
        // the LOCAL package, and the remote is offered as the alternative — the
        // reverse of the old remote-first behavior that installed a dead host.
        let payload = serde_json::json!({"servers": [
            {"server": {
                "name": "com.example/dual",
                "description": "both transports",
                "packages": [{"registryType": "pypi", "identifier": "dual-mcp",
                              "runtimeHint": "uvx", "transport": {"type": "stdio"}}],
                "remotes": [{"type": "streamable-http", "url": "https://mcp.example.com/dual"}]
            }}
        ]});
        let e = &normalize_servers(&payload)[0];
        assert!(!e.remote, "default must be local — nothing leaves the Mac");
        assert_eq!(e.transport, "stdio");
        match &e.install {
            InstallSpec::Stdio { command, args, .. } => {
                assert_eq!(command, "uvx");
                assert_eq!(args, &["dual-mcp"]);
            }
            _ => panic!("primary must be the local package"),
        }
        match e.alt_install.as_ref().expect("cloud alternative present") {
            InstallSpec::Http { url, .. } => assert_eq!(url, "https://mcp.example.com/dual"),
            _ => panic!("alt must be the remote endpoint"),
        }
    }

    #[test]
    fn old_unwrapped_snake_case_still_normalizes() {
        // Back-compat: entry [3] is the pre-wrapper shape.
        let e = &normalize_servers(&sample())[3];
        assert_eq!(e.name, "tool");
        assert_eq!(e.publisher, "legacy");
        match &e.install {
            InstallSpec::Stdio { command, args, .. } => {
                assert_eq!(command, "npx");
                assert_eq!(args, &["-y", "legacy-mcp"]);
            }
            _ => panic!("expected stdio"),
        }
    }

    #[test]
    fn undeployable_records_are_skipped_not_fatal() {
        // 5 entries, the last has neither packages nor remotes → dropped → 4.
        assert_eq!(normalize_servers(&sample()).len(), 4);
    }

    #[tokio::test]
    #[ignore] // hits the live registry — run with `-- --ignored --nocapture`
    async fn live_normalization_yields_entries() {
        let client = reqwest::Client::builder()
            .use_rustls_tls()
            .user_agent("PrivateRoom/test")
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap();
        let mut payload = None;
        for _ in 0..4 {
            if let Ok(r) = client.get(format!("{REGISTRY_URL}?limit=30")).send().await {
                if let Ok(v) = r.json::<serde_json::Value>().await {
                    payload = Some(v);
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        let payload = payload.expect("live fetch failed after retries");
        let entries = normalize_servers(&payload);
        println!("normalized {} entries from live registry", entries.len());
        for e in entries.iter().take(5) {
            println!("  {} | {} | remote={} | {}", e.name, e.publisher, e.remote, e.transport);
        }
        assert!(!entries.is_empty(), "live registry normalized to ZERO entries (the bug)");

        // Server-side search: "yahoo" lives past the first page, so this only
        // works because we pass the registry's `search` param.
        let mut ypayload = None;
        for _ in 0..4 {
            if let Ok(r) = client
                .get(REGISTRY_URL)
                .query(&[("limit", "10"), ("search", "yahoo")])
                .send()
                .await
            {
                if let Ok(v) = r.json::<serde_json::Value>().await {
                    ypayload = Some(v);
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        let yahoo = normalize_servers(&ypayload.expect("yahoo search failed"));
        println!("yahoo search → {} entries: {:?}",
            yahoo.len(), yahoo.iter().map(|e| &e.name).collect::<Vec<_>>());
        assert!(!yahoo.is_empty(), "search=yahoo returned nothing after normalization");
    }

    #[test]
    fn install_spec_serializes_camelcase_fields() {
        // The frontend reads `envKeys`/`headerKeys`; a snake_case leak here makes
        // them `undefined` and crashes the install drawer. Guard both variants.
        let http = serde_json::to_value(InstallSpec::Http {
            url: "https://x".into(),
            header_keys: vec!["Authorization".into()],
        })
        .unwrap();
        assert_eq!(http["kind"], "http");
        assert!(http.get("headerKeys").is_some(), "must be headerKeys, not header_keys");
        assert!(http.get("header_keys").is_none());

        let stdio = serde_json::to_value(InstallSpec::Stdio {
            command: "npx".into(),
            args: vec!["-y".into(), "x".into()],
            env_keys: vec!["TOKEN".into()],
        })
        .unwrap();
        assert_eq!(stdio["kind"], "stdio");
        assert!(stdio.get("envKeys").is_some(), "must be envKeys, not env_keys");
        assert!(stdio.get("env_keys").is_none());
    }

    #[test]
    fn dedupes_repeated_ids_and_prettifies_generic_names() {
        let payload = serde_json::json!({"servers": [
            {"server": {"name": "ac.inference.sh/mcp",
                "remotes": [{"type": "streamable-http", "url": "https://x"}]}},
            {"server": {"name": "ac.inference.sh/mcp",
                "remotes": [{"type": "streamable-http", "url": "https://x"}]}},
            {"server": {"name": "com.notion/notion",
                "remotes": [{"type": "streamable-http", "url": "https://n"}]}},
        ]});
        let entries = normalize_servers(&payload);
        // The two identical ids collapse to one card.
        assert_eq!(entries.len(), 2);
        // Generic "mcp" name → the publisher ("inference") reads better.
        assert_eq!(entries[0].publisher, "inference");
        assert_eq!(entries[0].name, "inference");
        assert_eq!(entries[1].publisher, "notion");
    }

    #[test]
    fn split_and_ownership_helpers() {
        // io.github.<owner> → the owner; other namespaces → last segment.
        assert_eq!(split_namespace("io.github.acme/tool"), ("acme".into(), "tool".into()));
        assert_eq!(split_namespace("com.notion/notion"), ("notion".into(), "notion".into()));
        assert_eq!(split_namespace("bare"), ("".into(), "bare".into()));
        assert!(namespace_owns_repo("acme", Some("https://github.com/acme/tool")));
        assert!(!namespace_owns_repo("acme", Some("https://github.com/evil/tool")));
        assert!(!namespace_owns_repo("acme", None));
    }
}
