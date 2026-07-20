//! Download-on-first-use runtimes for local MCP connectors.
//!
//! A local (stdio) connector runs via `uvx` (Python servers) or `npx`/`node`
//! (Node servers). Rather than make the user install those toolchains by hand in
//! a terminal, the app fetches a self-contained copy the first time a connector
//! needs one and keeps it under the app's own data folder (per-Mac, never inside
//! a room file — same trust model as `mcp_approvals.json`).
//!
//! This reaches the internet, so it is an explicit, user-triggered action: the
//! UI says what it pulls and from where, and only a click starts it.
//!
//! - `uv` (astral.sh): one self-contained binary that also provisions its own
//!   Python, so a single download covers every PyPI-based MCP server.
//! - `node` (nodejs.org): the official macOS tarball; we keep `bin/` + `lib/`
//!   (node, npm, npx) so npm-based servers run without a system Node.
//!
//! Docker-based servers can't be auto-provisioned (Docker is a background
//! service, not a binary), so those surface a clear "install Docker" note.

use futures_util::StreamExt;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};
use tokio::io::AsyncWriteExt;

/// Node LTS we pin for the bundled-on-demand Node runtime.
const NODE_VERSION: &str = "v22.11.0";

/// A runtime the app can download on demand.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeKind {
    Uv,
    Node,
}

impl RuntimeKind {
    fn slug(self) -> &'static str {
        match self {
            RuntimeKind::Uv => "uv",
            RuntimeKind::Node => "node",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "uv" => Some(Self::Uv),
            "node" => Some(Self::Node),
            _ => None,
        }
    }

    /// Which runtime a connector's command needs, if it's one we can provide.
    /// Pure — unit-tested.
    fn for_command(cmd: &str) -> Option<Self> {
        // Only the leaf matters ("/usr/bin/uvx" → "uvx").
        let leaf = cmd.rsplit('/').next().unwrap_or(cmd);
        match leaf {
            "uvx" | "uv" | "uvenv" => Some(Self::Uv),
            "npx" | "npm" | "node" => Some(Self::Node),
            _ => None,
        }
    }

    /// A friendly label for the UI.
    fn label(self) -> &'static str {
        match self {
            RuntimeKind::Uv => "Python runtime (uv)",
            RuntimeKind::Node => "Node.js runtime",
        }
    }

    /// Where it's fetched from + rough size, shown so the download is transparent.
    fn source(self) -> &'static str {
        match self {
            RuntimeKind::Uv => "astral.sh · ~22 MB",
            RuntimeKind::Node => "nodejs.org · ~45 MB",
        }
    }

    /// The download asset URL for the current CPU arch. Pure — unit-tested.
    fn asset_url(self) -> Result<String, String> {
        let arch = std::env::consts::ARCH;
        match self {
            RuntimeKind::Uv => {
                let a = match arch {
                    "aarch64" => "aarch64",
                    "x86_64" => "x86_64",
                    other => return Err(format!("no uv build for {other}")),
                };
                Ok(format!(
                    "https://github.com/astral-sh/uv/releases/latest/download/uv-{a}-apple-darwin.tar.gz"
                ))
            }
            RuntimeKind::Node => {
                let a = match arch {
                    "aarch64" => "arm64",
                    "x86_64" => "x64",
                    other => return Err(format!("no node build for {other}")),
                };
                Ok(format!(
                    "https://nodejs.org/dist/{NODE_VERSION}/node-{NODE_VERSION}-darwin-{a}.tar.gz"
                ))
            }
        }
    }

    /// Subdir (under the install dir) that goes on PATH once installed. uv sits
    /// at the top; Node keeps its `bin/`.
    fn bin_subdir(self) -> &'static str {
        match self {
            RuntimeKind::Uv => "",
            RuntimeKind::Node => "bin",
        }
    }

    /// A file whose presence proves the runtime extracted successfully.
    fn marker(self) -> &'static str {
        match self {
            RuntimeKind::Uv => "uv",
            RuntimeKind::Node => "bin/node",
        }
    }
}

// ----------------------------------------------------------------- filesystem

/// The per-Mac runtimes root, in the app data folder (never inside a room).
fn runtimes_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("runtimes");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn install_dir(app: &tauri::AppHandle, kind: RuntimeKind) -> Result<PathBuf, String> {
    Ok(runtimes_root(app)?.join(kind.slug()))
}

fn is_installed(app: &tauri::AppHandle, kind: RuntimeKind) -> bool {
    install_dir(app, kind)
        .map(|d| d.join(kind.marker()).exists())
        .unwrap_or(false)
}

/// The directory to put on PATH for an installed runtime (`None` if not yet
/// installed).
fn bin_dir(app: &tauri::AppHandle, kind: RuntimeKind) -> Option<PathBuf> {
    if !is_installed(app, kind) {
        return None;
    }
    let d = install_dir(app, kind).ok()?;
    Some(match kind.bin_subdir() {
        "" => d,
        sub => d.join(sub),
    })
}

/// PATH fragment (colon-joined) for every runtime we've downloaded — prepended
/// to the connector's PATH so a downloaded `uvx`/`npx` wins over anything on the
/// system. Empty when nothing is downloaded.
pub fn path_prefix(app: &tauri::AppHandle) -> String {
    [RuntimeKind::Uv, RuntimeKind::Node]
        .into_iter()
        .filter_map(|k| bin_dir(app, k))
        .map(|p| p.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(":")
}

/// True when `cmd` resolves to an existing file in one of the PATH dirs. Pure —
/// unit-tested.
fn which_in(cmd: &str, path: &str) -> bool {
    let leaf = cmd.rsplit('/').next().unwrap_or(cmd);
    path.split(':')
        .filter(|p| !p.is_empty())
        .any(|dir| Path::new(dir).join(leaf).exists())
}

// -------------------------------------------------------------- availability

/// What it takes to run a connector's command right now.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    /// The command can run as-is (a downloaded or system runtime satisfies it).
    available: bool,
    /// The runtime we could download to satisfy it (`"uv"` | `"node"`), if any.
    kind: Option<String>,
    /// A one-time download would make it available.
    provisionable: bool,
    /// Human-readable one-liner for the UI.
    note: String,
}

/// Decide whether `command` can run, and if not, whether a download fixes it.
fn status_for(app: &tauri::AppHandle, command: &str) -> RuntimeStatus {
    // The exact PATH the launcher will use: downloaded runtimes first, then the
    // login-shell PATH (Homebrew, ~/.local/bin, …).
    let prefix = path_prefix(app);
    let base = crate::mcp::login_shell_path();
    let full = if prefix.is_empty() {
        base.to_string()
    } else {
        format!("{prefix}:{base}")
    };
    if which_in(command, &full) {
        return RuntimeStatus {
            available: true,
            kind: None,
            provisionable: false,
            note: String::new(),
        };
    }
    match RuntimeKind::for_command(command) {
        Some(kind) => RuntimeStatus {
            available: false,
            kind: Some(kind.slug().to_string()),
            provisionable: true,
            note: format!(
                "First install downloads the {} once ({}). Nothing else to set up.",
                kind.label(),
                kind.source()
            ),
        },
        None => RuntimeStatus {
            available: false,
            kind: None,
            provisionable: false,
            note: format!(
                "This connector needs \u{201c}{command}\u{201d}, which the app can't \
                 download for you — install it yourself (e.g. Docker Desktop) to use it."
            ),
        },
    }
}

// ------------------------------------------------------------- provisioning

/// Download + extract a runtime, emitting `runtime-progress` events. Idempotent:
/// a runtime that's already installed returns immediately.
async fn provision(app: &tauri::AppHandle, kind: RuntimeKind) -> Result<(), String> {
    if is_installed(app, kind) {
        return Ok(());
    }
    let url = kind.asset_url()?;
    let root = runtimes_root(app)?;
    let dir = install_dir(app, kind)?;
    let tmp = root.join(format!("{}.download", kind.slug()));

    let emit = |phase: &str, got: u64, total: u64| {
        let _ = app.emit(
            "runtime-progress",
            serde_json::json!({
                "kind": kind.slug(), "phase": phase, "got": got, "total": total,
            }),
        );
    };

    // rustls: nodejs.org / GitHub are HTTP/2 and macOS native-tls doesn't
    // reliably negotiate h2 via ALPN (see mcp_registry).
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .user_agent(concat!("PrivateRoom/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("could not reach {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download of {} returned HTTP {}", kind.label(), resp.status().as_u16()));
    }
    let total = resp.content_length().unwrap_or(0);

    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| format!("could not write the download: {e}"))?;
    let mut got = 0u64;
    let mut stream = resp.bytes_stream();
    emit("download", 0, total);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download interrupted: {e}"))?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        emit("download", got, total);
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    // Extract into a clean dir. macOS ships bsdtar at /usr/bin/tar, which
    // auto-detects gzip; strip the archive's single top-level dir.
    emit("extract", got, total);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = tokio::process::Command::new("/usr/bin/tar")
        .arg("-xzf")
        .arg(&tmp)
        .arg("-C")
        .arg(&dir)
        .arg("--strip-components=1")
        .output()
        .await
        .map_err(|e| format!("could not run tar: {e}"))?;
    let _ = tokio::fs::remove_file(&tmp).await;
    if !out.status.success() {
        let _ = std::fs::remove_dir_all(&dir);
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("could not unpack the {}: {}", kind.label(), err.trim()));
    }
    if !is_installed(app, kind) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(format!("the {} didn't unpack as expected", kind.label()));
    }
    emit("done", got.max(1), got.max(1));
    Ok(())
}

// ------------------------------------------------------------------ commands

/// Whether a connector's command can run, and if not, whether one download fixes
/// it — drives the "Download runtime" prompt in the install drawer.
#[tauri::command]
pub fn mcp_runtime_for_command(app: tauri::AppHandle, command: String) -> RuntimeStatus {
    status_for(&app, &command)
}

/// Download a runtime (`"uv"` | `"node"`) once. Emits `runtime-progress`.
#[tauri::command]
pub async fn mcp_provision_runtime(app: tauri::AppHandle, kind: String) -> Result<(), String> {
    let kind = RuntimeKind::parse(&kind).ok_or_else(|| format!("unknown runtime \"{kind}\""))?;
    provision(&app, kind).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_maps_to_the_right_runtime() {
        assert_eq!(RuntimeKind::for_command("uvx"), Some(RuntimeKind::Uv));
        assert_eq!(RuntimeKind::for_command("uv"), Some(RuntimeKind::Uv));
        assert_eq!(RuntimeKind::for_command("npx"), Some(RuntimeKind::Node));
        assert_eq!(RuntimeKind::for_command("node"), Some(RuntimeKind::Node));
        // A full path is handled by its leaf.
        assert_eq!(RuntimeKind::for_command("/opt/homebrew/bin/npx"), Some(RuntimeKind::Node));
        // Docker / anything else is not provisionable.
        assert_eq!(RuntimeKind::for_command("docker"), None);
        assert_eq!(RuntimeKind::for_command("some-server"), None);
    }

    #[test]
    fn asset_urls_are_platform_correct() {
        // Whatever arch the test runs on, the URL is well-formed for it.
        let uv = RuntimeKind::Uv.asset_url().unwrap();
        assert!(uv.starts_with("https://github.com/astral-sh/uv/releases/latest/download/uv-"));
        assert!(uv.ends_with("-apple-darwin.tar.gz"));
        let node = RuntimeKind::Node.asset_url().unwrap();
        assert!(node.contains("nodejs.org/dist/"));
        assert!(node.ends_with(".tar.gz"));
        assert!(node.contains("-darwin-"));
    }

    #[test]
    fn which_in_checks_each_path_dir_by_leaf() {
        let tmp = std::env::temp_dir().join(format!("pr-which-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("uvx"), b"x").unwrap();
        let dir = tmp.to_string_lossy().into_owned();
        // Found only in the dir that actually holds the file.
        assert!(which_in("uvx", &format!("/nope:{dir}")));
        assert!(!which_in("npx", &format!("/nope:{dir}")));
        // A full path resolves by its basename against each PATH dir.
        assert!(which_in("/x/y/uvx", &dir));
        // Empty PATH never matches.
        assert!(!which_in("uvx", ""));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn parse_round_trips() {
        assert_eq!(RuntimeKind::parse("uv"), Some(RuntimeKind::Uv));
        assert_eq!(RuntimeKind::parse("node"), Some(RuntimeKind::Node));
        assert_eq!(RuntimeKind::parse("nope"), None);
    }
}
