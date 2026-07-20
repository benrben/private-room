//! ADD-33: manage the local Python/LangGraph agent sidecar the same way
//! [`crate::ollama_lifecycle`] manages the Ollama daemon.
//!
//! The sidecar is the OPTIONAL agent brain: when the `agent_engine` setting is
//! `langgraph`, [`crate::sidecar`] runs the answer through it instead of the
//! native `agent_loop`. This module owns the process — spawn it on demand, learn
//! the loopback port it chose, hand out its base URL, and SIGTERM it on app exit.
//!
//! Same safety rule as Ollama: we only ever stop a process WE spawned, and it is
//! bound to `127.0.0.1` only. The sidecar never sees the room key — it reaches
//! the room's tools solely through the token-guarded loopback MCP bridge.

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long to wait for a freshly spawned sidecar to announce its port and pass
/// a health check before giving up (Python import of langgraph is not instant).
const START_TIMEOUT: Duration = Duration::from_secs(30);

struct Lifecycle {
    /// PID of the sidecar child WE spawned, or `None` when not running.
    our_pid: Mutex<Option<u32>>,
    /// The base URL (`http://127.0.0.1:PORT`) of the running sidecar, once known.
    base_url: Mutex<Option<String>>,
}

fn lc() -> &'static Lifecycle {
    static LC: OnceLock<Lifecycle> = OnceLock::new();
    LC.get_or_init(|| Lifecycle {
        our_pid: Mutex::new(None),
        base_url: Mutex::new(None),
    })
}

/// How to launch the sidecar. In a bundled app this is the PyInstaller one-file
/// binary shipped in `Resources/`; in dev it's the project venv's Python running
/// the package as a module. The bundled binary is preferred so a released app
/// needs no Python on the user's machine.
fn launch_command() -> Option<Command> {
    // 1) Bundled PyInstaller onedir binary next to the app resources. The extra
    //    `arcelle-sidecar/` level is the onedir folder; the executable of the
    //    same name sits inside it beside its _internal/ dylibs.
    if let Ok(exe) = std::env::current_exe() {
        // .../Arcelle.app/Contents/MacOS/arcelle  ->  ../Resources/
        if let Some(macos_dir) = exe.parent() {
            let bundled = macos_dir
                .join("../Resources/sidecar/arcelle-sidecar/arcelle-sidecar")
                .canonicalize()
                .ok();
            if let Some(path) = bundled {
                if path.exists() {
                    return Some(Command::new(path));
                }
            }
        }
    }
    // 2) Dev fallback: an explicit interpreter + the source package.
    //    ARCELLE_SIDECAR_PYTHON lets a developer point at the venv that has
    //    langgraph installed; ARCELLE_SIDECAR_DIR is the package parent.
    let python = std::env::var("ARCELLE_SIDECAR_PYTHON").ok()?;
    let dir = std::env::var("ARCELLE_SIDECAR_DIR")
        .unwrap_or_else(|_| default_dev_sidecar_dir());
    if !std::path::Path::new(&python).exists() {
        return None;
    }
    let mut cmd = Command::new(python);
    cmd.arg("-m").arg("arcelle_sidecar").current_dir(dir);
    Some(cmd)
}

/// The in-repo sidecar package dir, relative to the running binary's source tree
/// — only used in dev when `ARCELLE_SIDECAR_DIR` is unset.
fn default_dev_sidecar_dir() -> String {
    concat!(env!("CARGO_MANIFEST_DIR"), "/../sidecar").to_string()
}

/// Ensure a sidecar is up and return its base URL. If one we started is already
/// running, reuse it. Otherwise spawn it, read the `SIDECAR_PORT=` line it prints
/// on stdout, and health-check it. `Err` means the sidecar could not start — the
/// caller falls back to the native engine.
pub async fn ensure_up() -> Result<String, String> {
    if let Some(url) = current_base_url() {
        if health(&url).await {
            return Ok(url);
        }
        // A recorded sidecar that no longer answers: forget it and respawn.
        forget();
    }
    // Single-flight spawn: two concurrent asks must not each launch a sidecar.
    static SPAWNING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _spawn_lock = SPAWNING.lock().await;
    if let Some(url) = current_base_url() {
        if health(&url).await {
            return Ok(url);
        }
    }
    spawn_and_wait().await
}

fn current_base_url() -> Option<String> {
    lc().base_url.lock().ok().and_then(|g| g.clone())
}

fn forget() {
    if let Ok(mut u) = lc().base_url.lock() {
        *u = None;
    }
    if let Ok(mut p) = lc().our_pid.lock() {
        *p = None;
    }
}

/// Spawn the process, block (on a blocking thread) reading stdout until it prints
/// `SIDECAR_PORT=N`, then confirm `/health`. The port line is how we learn the
/// ephemeral port without a bind-and-release race.
async fn spawn_and_wait() -> Result<String, String> {
    let mut cmd = launch_command().ok_or_else(|| "SIDECAR_UNAVAILABLE".to_string())?;
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|_| "SIDECAR_UNAVAILABLE".to_string())?;
    let pid = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "SIDECAR_UNAVAILABLE".to_string())?;

    // Read the announce line on a blocking thread (std pipe), bounded by a
    // timeout race so a silent/hung child cannot wedge the ask forever.
    let port = tokio::time::timeout(
        START_TIMEOUT,
        tokio::task::spawn_blocking(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Some(p) = parse_port_line(&line) {
                    return Some(p);
                }
            }
            None
        }),
    )
    .await;

    let port = match port {
        Ok(Ok(Some(p))) => p,
        _ => {
            // Never announced a port (crash on import, bad interpreter): reap it
            // so we don't leak the child, and report unavailable.
            let _ = Command::new("kill").arg(pid.to_string()).status();
            return Err("SIDECAR_UNAVAILABLE".to_string());
        }
    };
    // Keep the child handle alive for the process lifetime by leaking it: the
    // sidecar is a long-lived daemon we manage by PID (like `ollama serve`),
    // stopped via `stop_if_ours` on exit. Dropping `child` here would not kill
    // it (no kill_on_drop on std Command), but we must not join it either.
    std::mem::forget(child);

    let url = format!("http://127.0.0.1:{port}");
    let start = Instant::now();
    while start.elapsed() < START_TIMEOUT {
        if health(&url).await {
            if let Ok(mut slot) = lc().our_pid.lock() {
                *slot = Some(pid);
            }
            if let Ok(mut slot) = lc().base_url.lock() {
                *slot = Some(url.clone());
            }
            return Ok(url);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let _ = Command::new("kill").arg(pid.to_string()).status();
    Err("SIDECAR_UNAVAILABLE".to_string())
}

/// Parse the `SIDECAR_PORT=NNNN` handshake line the sidecar prints on startup.
fn parse_port_line(line: &str) -> Option<u16> {
    line.trim().strip_prefix("SIDECAR_PORT=")?.trim().parse().ok()
}

/// True when the sidecar answers `/health` with `{"ok": true}` within ~1s.
async fn health(base: &str) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let resp = match client.get(format!("{base}/health")).send().await {
        Ok(r) => r,
        Err(_) => return false,
    };
    if !resp.status().is_success() {
        return false;
    }
    resp.json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| v.get("ok").and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

/// Stop a sidecar we started — used on app shutdown so we never leak a
/// background Python process we spawned. A no-op if none is running.
pub fn stop_if_ours() {
    if let Ok(mut slot) = lc().our_pid.lock() {
        if let Some(pid) = slot.take() {
            let _ = Command::new("kill").arg(pid.to_string()).status();
        }
    }
    if let Ok(mut u) = lc().base_url.lock() {
        *u = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_port_handshake_line() {
        assert_eq!(parse_port_line("SIDECAR_PORT=53421"), Some(53421));
        assert_eq!(parse_port_line("  SIDECAR_PORT=8000  "), Some(8000));
        assert_eq!(parse_port_line("SIDECAR_PORT=notaport"), None);
        assert_eq!(parse_port_line("uvicorn running on ..."), None);
        assert_eq!(parse_port_line("PORT=1234"), None);
    }

    #[test]
    fn dev_sidecar_dir_points_at_the_package() {
        assert!(default_dev_sidecar_dir().ends_with("/sidecar"));
    }
}
