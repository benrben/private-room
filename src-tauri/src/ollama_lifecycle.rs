//! ADD-29: make the local Ollama daemon optional and self-managing.
//!
//! Goal: the user never has to keep `ollama serve` running by hand. Real work
//! calls (chat, embed, warm, pull) call [`ensure_up`], which starts the daemon
//! on demand; an idle watcher stops it again after [`IDLE_SLEEP`] of no use.
//!
//! Safety rule — we only ever stop a daemon **we started**. If Ollama.app or a
//! hand-run `ollama serve` is already answering, we record no PID and the
//! watcher leaves it strictly alone. Remote engines (the "closet box" base-URL
//! override) are never started or stopped from here — you can't manage someone
//! else's machine.

use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Stop a daemon we started after this long with no calls in flight.
pub const IDLE_SLEEP: Duration = Duration::from_secs(5 * 60);
/// How often the watcher re-checks the idle condition.
const WATCH_INTERVAL: Duration = Duration::from_secs(30);
/// How long to wait for a freshly spawned daemon to answer before giving up.
const START_TIMEOUT: Duration = Duration::from_secs(20);

struct Lifecycle {
    /// PID of the `ollama serve` child WE spawned, or `None` when the daemon is
    /// external (Ollama.app / user-run) or not running. Only this PID is ever
    /// killed.
    our_pid: Mutex<Option<u32>>,
    /// When the last real call happened — the idle clock.
    last_used: Mutex<Instant>,
    /// Real calls currently running. Never sleep while this is > 0, even past
    /// the idle deadline (a long transcription digest must not be cut off).
    inflight: AtomicUsize,
}

fn lc() -> &'static Lifecycle {
    static LC: OnceLock<Lifecycle> = OnceLock::new();
    LC.get_or_init(|| Lifecycle {
        our_pid: Mutex::new(None),
        last_used: Mutex::new(Instant::now()),
        inflight: AtomicUsize::new(0),
    })
}

/// Pure idle decision, so the policy is unit-testable without spawning
/// anything: sleep only a daemon we own, only once idle past the deadline, and
/// only when nothing is in flight.
fn should_sleep(we_started: bool, idle: Duration, inflight: usize) -> bool {
    we_started && inflight == 0 && idle >= IDLE_SLEEP
}

/// RAII marker for one in-flight real call: keeps the daemon awake for the
/// duration and bumps the idle clock on the way out, so the 5-minute window is
/// measured from the END of the last call.
pub struct Busy;

impl Busy {
    fn new() -> Self {
        lc().inflight.fetch_add(1, Ordering::SeqCst);
        Busy
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        lc().inflight.fetch_sub(1, Ordering::SeqCst);
        if let Ok(mut t) = lc().last_used.lock() {
            *t = Instant::now();
        }
    }
}

/// Is the resolved base URL a local daemon we may start/stop? A remote override
/// (the closet supercomputer) is off-limits.
fn base_is_local(base: &str) -> bool {
    base.contains("127.0.0.1") || base.contains("localhost") || base.contains("0.0.0.0")
}

/// True if the daemon answers `/api/version` within ~1s.
async fn reachable(base: &str) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(1200))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    client
        .get(format!("{base}/api/version"))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Absolute path to the `ollama` binary, resolved once through an interactive
/// login shell (a GUI launch has only a bare launchd PATH; the binary is
/// usually added to PATH in `.zshrc`). Spawning the resolved path directly —
/// rather than `zsh -ilc 'ollama serve'` — means our stored PID is the daemon
/// itself, so a later SIGTERM actually stops it.
fn ollama_bin() -> Option<String> {
    static BIN: OnceLock<Option<String>> = OnceLock::new();
    BIN.get_or_init(|| {
        // The bundled app ships the CLI here; prefer it, then fall back to PATH.
        for cand in ["/Applications/Ollama.app/Contents/Resources/ollama"] {
            if std::path::Path::new(cand).exists() {
                return Some(cand.to_string());
            }
        }
        Command::new("zsh")
            .args(["-ilc", "command -v ollama"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .next()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(String::from)
            })
    })
    .clone()
}

/// Ensure a usable Ollama daemon before a real call. For a local base URL that
/// isn't answering, start `ollama serve` in the background and wait for it to
/// come up, remembering the PID so the idle watcher can stop it later. For a
/// remote base URL, or one already answering, this is just a reachability note.
///
/// Returns a [`Busy`] guard the caller holds for the call's lifetime. `Err`
/// mirrors the existing `OLLAMA_DOWN` contract so callers surface the same
/// friendly message.
pub async fn ensure_up(base: &str) -> Result<Busy, String> {
    let guard = Busy::new();
    if reachable(base).await {
        return Ok(guard);
    }
    if !base_is_local(base) {
        // A remote box we can't manage — report the same down signal.
        return Err("OLLAMA_DOWN".to_string());
    }
    // Single-flight spawn: concurrent callers (an embed and a chat both finding
    // the daemon down) must not each start `ollama serve`. The loser of that
    // race would fail to bind, exit, and OVERWRITE `our_pid` with a dead PID —
    // after which the idle watcher kills the wrong process and the real daemon
    // never sleeps. One async lock serializes the whole probe-spawn-wait.
    static SPAWNING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _spawn_lock = SPAWNING.lock().await;
    // Re-check: the winner of the lock may have already brought it up.
    if reachable(base).await {
        return Ok(guard);
    }
    let bin = ollama_bin().ok_or_else(|| "OLLAMA_DOWN".to_string())?;
    // Detach: no inherited stdio, its own session, so it outlives this call but
    // we still hold its PID.
    let child = Command::new(&bin)
        .arg("serve")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| "OLLAMA_DOWN".to_string())?;
    if let Ok(mut slot) = lc().our_pid.lock() {
        *slot = Some(child.id());
    }
    // Poll until it answers (model load is separate; we only need the socket).
    let start = Instant::now();
    while start.elapsed() < START_TIMEOUT {
        if reachable(base).await {
            start_watcher();
            return Ok(guard);
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    // The spawn never became reachable (port conflict, broken install): forget
    // the PID so the watcher can't later kill an innocent process, and reap it.
    if let Ok(mut slot) = lc().our_pid.lock() {
        if slot.map(|p| p == child.id()).unwrap_or(false) {
            *slot = None;
        }
    }
    let _ = Command::new("kill").arg(child.id().to_string()).status();
    Err("OLLAMA_DOWN".to_string())
}

/// Spawn the idle watcher exactly once. It periodically checks the pure
/// [`should_sleep`] condition and, when met, SIGTERMs the daemon we started and
/// forgets its PID — so the next [`ensure_up`] starts a fresh one.
fn start_watcher() {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return; // already running
    }
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(WATCH_INTERVAL).await;
            let pid = *lc().our_pid.lock().unwrap();
            let idle = lc().last_used.lock().unwrap().elapsed();
            let inflight = lc().inflight.load(Ordering::SeqCst);
            if should_sleep(pid.is_some(), idle, inflight) {
                if let Some(pid) = pid {
                    // SIGTERM lets Ollama unload models and exit cleanly.
                    let _ = Command::new("kill").arg(pid.to_string()).status();
                    *lc().our_pid.lock().unwrap() = None;
                }
            }
        }
    });
}

/// ADD-31: is the daemon answering right now? Cheap probe for UI feedback
/// ("Starting the local AI…") — never starts anything.
pub async fn is_awake(base: &str) -> bool {
    reachable(base).await
}

/// Stop a daemon we started, now — used on app shutdown so we never leak a
/// background `ollama serve` we spawned. A no-op for an external daemon.
pub fn stop_if_ours() {
    if let Ok(mut slot) = lc().our_pid.lock() {
        if let Some(pid) = slot.take() {
            let _ = Command::new("kill").arg(pid.to_string()).status();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_sleeps_a_daemon_we_own_when_idle_and_quiet() {
        // We started it, long idle, nothing running → sleep.
        assert!(should_sleep(true, IDLE_SLEEP, 0));
        assert!(should_sleep(true, IDLE_SLEEP + Duration::from_secs(60), 0));
        // Never touch an external daemon, no matter how idle.
        assert!(!should_sleep(false, IDLE_SLEEP * 10, 0));
        // Ours, idle, but a call is in flight → keep it up.
        assert!(!should_sleep(true, IDLE_SLEEP * 10, 1));
        // Ours and quiet but not yet idle enough → keep it up.
        assert!(!should_sleep(true, IDLE_SLEEP - Duration::from_secs(1), 0));
    }

    #[test]
    fn base_locality_is_recognized() {
        assert!(base_is_local("http://127.0.0.1:11434"));
        assert!(base_is_local("http://localhost:11434"));
        assert!(!base_is_local("http://closet.local:11434"));
        assert!(!base_is_local("http://192.168.1.50:11434"));
    }

    #[test]
    fn busy_guard_tracks_inflight() {
        let before = lc().inflight.load(Ordering::SeqCst);
        {
            let _g = Busy::new();
            assert_eq!(lc().inflight.load(Ordering::SeqCst), before + 1);
        }
        assert_eq!(lc().inflight.load(Ordering::SeqCst), before);
    }
}
