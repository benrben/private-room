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
//!
//! IN THE BUILD as of audit findings 80 + 228. It was written complete and
//! unit-tested but never declared, so none of it shipped and neither command
//! could be invoked. All four halves are now wired, and they only make sense
//! together — a download button that fetches 45 MB into a folder nothing looks
//! in is worse than no button:
//!   1. `mod runtimes; pub use runtimes::*;` in `commands.rs`,
//!   2. `commands::mcp_runtime_for_command` + `commands::mcp_provision_runtime`
//!      in `lib.rs`'s `invoke_handler`,
//!   3. `mcp.rs`'s launcher prepending the downloaded bin dirs to
//!      `login_shell_path()` — without it a downloaded runtime is on no PATH
//!      the child ever sees. The launcher has no `AppHandle`, so the prefix is
//!      PUBLISHED here ([`refresh_path_prefix`]) at startup and after every
//!      provision, and the launcher reads [`cached_path_prefix`],
//!   4. the "Download runtime" prompt in `src/workspace/ConnectorsView.tsx`.

use futures_util::StreamExt;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};
use tokio::io::AsyncWriteExt;

/// Node LTS we pin for the bundled-on-demand Node runtime.
const NODE_VERSION: &str = "v22.11.0";

/// uv release we pin. It used to be fetched from `releases/latest`, which means
/// two installs of the SAME build of this app could execute different binaries —
/// and no digest could be written down for a moving target.
const UV_VERSION: &str = "0.12.5";

/// What the pinned asset must hash to, per arch, taken from the publishers'
/// own checksums for these exact versions:
///   - nodejs.org/dist/v22.11.0/SHASUMS256.txt
///   - the `.sha256` beside each asset of astral-sh/uv 0.12.5
///
/// Written down here rather than fetched beside the download on purpose: a
/// checksum served by the same host over the same session proves only that the
/// tarball is the one that host meant to send. These bytes ship inside a signed
/// app, so a substituted download is refused even when the session itself is
/// the thing that was tampered with. They must be updated with the version
/// above — [`asset`] returns both together so they cannot drift apart.
const UV_SHA256_AARCH64: &str = "5bb0e5fe008a773c3dbcb97ff79cd89e1241464fe9d2f986d52ad8f1b037bd62";
const UV_SHA256_X86_64: &str = "b3b2137477cf96c9686ebfb71524614cec780c673fd73e59bce099aef02e70e8";
const NODE_SHA256_ARM64: &str = "2e89afe6f4e3aa6c7e21c560d8a0453d84807e97850bbb819b998531a22bdfde";
const NODE_SHA256_X64: &str = "668d30b9512137b5f5baeef6c1bb4c46efff9a761ba990a034fb6b28b9da2465";

/// A pinned download: the URL, and the SHA-256 the bytes must have.
struct Asset {
    url: String,
    sha256: &'static str,
}

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

    /// The download for the current CPU arch: where it comes from, and what it
    /// must hash to. One function so a URL can never be changed without its
    /// digest. Pure — unit-tested.
    fn asset(self) -> Result<Asset, String> {
        let arch = std::env::consts::ARCH;
        match self {
            RuntimeKind::Uv => {
                let (a, sha256) = match arch {
                    "aarch64" => ("aarch64", UV_SHA256_AARCH64),
                    "x86_64" => ("x86_64", UV_SHA256_X86_64),
                    other => return Err(format!("no uv build for {other}")),
                };
                Ok(Asset {
                    url: format!(
                        "https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/uv-{a}-apple-darwin.tar.gz"
                    ),
                    sha256,
                })
            }
            RuntimeKind::Node => {
                let (a, sha256) = match arch {
                    "aarch64" => ("arm64", NODE_SHA256_ARM64),
                    "x86_64" => ("x64", NODE_SHA256_X64),
                    other => return Err(format!("no node build for {other}")),
                };
                Ok(Asset {
                    url: format!(
                        "https://nodejs.org/dist/{NODE_VERSION}/node-{NODE_VERSION}-darwin-{a}.tar.gz"
                    ),
                    sha256,
                })
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

/// The published PATH prefix, for readers with no `AppHandle`.
///
/// The stdio connector launcher (`mcp::StdioClient::connect`) is handed a
/// command and an env map and nothing else — there is no app handle to resolve
/// the app-data dir from, and that is exactly the code that has to see a
/// downloaded `uvx`. So the prefix is computed where the handle exists and
/// cached here. Empty until published, which is the correct answer before
/// anything is downloaded anyway.
fn prefix_cell() -> &'static std::sync::RwLock<String> {
    static CELL: std::sync::OnceLock<std::sync::RwLock<String>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| std::sync::RwLock::new(String::new()))
}

/// Recompute and publish the prefix. Called at startup and after a provision —
/// a runtime downloaded mid-session must reach the next connector launch
/// without a restart.
pub fn refresh_path_prefix(app: &tauri::AppHandle) {
    let next = path_prefix(app);
    if let Ok(mut g) = prefix_cell().write() {
        *g = next;
    }
}

/// What the connector launcher prepends to its PATH.
pub fn cached_path_prefix() -> String {
    prefix_cell().read().map(|g| g.clone()).unwrap_or_default()
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

/// Lower-case hex, the spelling every published checksum file uses.
fn hex_digest(bytes: &[u8]) -> String {
    bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
        use std::fmt::Write as _;
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// Why this download must not be unpacked, or `None` when it is the pinned one.
///
/// Said in full: what was expected, what arrived, and that nothing was
/// installed — a runtime that silently declined to install would send the user
/// back to the same button for ever.
fn checksum_refusal(kind: RuntimeKind, expected: &str, got: &str) -> Option<String> {
    if got.eq_ignore_ascii_case(expected) {
        return None;
    }
    Some(format!(
        "the {} download is not the one this app expects, so it was deleted \
         rather than installed (expected SHA-256 {expected}, got {got}). \
         Check the network you are on and try again.",
        kind.label()
    ))
}

/// Download + extract a runtime, emitting `runtime-progress` events. Idempotent:
/// a runtime that's already installed returns immediately.
async fn provision(app: &tauri::AppHandle, kind: RuntimeKind) -> Result<(), String> {
    if is_installed(app, kind) {
        return Ok(());
    }
    let Asset { url, sha256: expected } = kind.asset()?;
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
        .user_agent(concat!("Arcelle/", env!("CARGO_PKG_VERSION")))
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
    // Hashed as it arrives, so nothing is read from disk twice and the bytes
    // that are checked are exactly the bytes that were written.
    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    emit("download", 0, total);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download interrupted: {e}"))?;
        sha2::Digest::update(&mut hasher, &chunk);
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        emit("download", got, total);
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    // BEFORE anything is unpacked, let alone put on a connector's PATH: this
    // is executable content, and TLS alone only says the bytes came from
    // whoever terminated the connection.
    let digest = hex_digest(&sha2::Digest::finalize(hasher));
    if let Some(why) = checksum_refusal(kind, expected, &digest) {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(why);
    }

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
    provision(&app, kind).await?;
    // Publish immediately: without this the freshly-downloaded bin dir is on no
    // PATH any child sees until the next launch, and the connector the user
    // downloaded it FOR would still fail.
    refresh_path_prefix(&app);
    Ok(())
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
        let uv = RuntimeKind::Uv.asset().unwrap();
        assert!(uv.url.starts_with("https://github.com/astral-sh/uv/releases/download/"));
        assert!(uv.url.ends_with("-apple-darwin.tar.gz"));
        let node = RuntimeKind::Node.asset().unwrap();
        assert!(node.url.contains("nodejs.org/dist/"));
        assert!(node.url.ends_with(".tar.gz"));
        assert!(node.url.contains("-darwin-"));
    }

    /// Both halves of a pinned download: a version in the URL, and a digest to
    /// hold the bytes to. `latest` in a URL means two installs of the same
    /// build of this app can run different binaries, and there is nothing a
    /// checksum could even be written against.
    #[test]
    fn every_runtime_download_is_pinned_and_carries_a_digest() {
        for kind in [RuntimeKind::Uv, RuntimeKind::Node] {
            let a = kind.asset().unwrap();
            assert!(!a.url.contains("/latest/"), "{} is not pinned: {}", kind.slug(), a.url);
            assert!(
                a.url.contains(UV_VERSION) || a.url.contains(NODE_VERSION),
                "{} names no version: {}",
                kind.slug(),
                a.url
            );
            assert_eq!(a.sha256.len(), 64, "{} has no SHA-256", kind.slug());
            assert!(
                a.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                "{} digest is not hex",
                kind.slug()
            );
        }
    }

    #[test]
    fn a_download_that_hashes_wrong_is_refused_by_name() {
        // SHA-256 of the empty input, as every implementation gives it — the
        // hex spelling the published checksum files use.
        let empty = hex_digest(&sha2::Digest::finalize(<sha2::Sha256 as sha2::Digest>::new()));
        assert_eq!(empty, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

        assert_eq!(checksum_refusal(RuntimeKind::Uv, &empty, &empty), None);
        // Case is not a difference: checksum files are published both ways.
        assert_eq!(
            checksum_refusal(RuntimeKind::Uv, &empty.to_uppercase(), &empty),
            None
        );
        let why = checksum_refusal(RuntimeKind::Node, &empty, "00").expect("a mismatch passed");
        assert!(why.contains("Node.js runtime"), "{why}");
        assert!(why.contains(&empty), "the expected digest is not named: {why}");
        assert!(why.contains("deleted"), "{why}");
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
