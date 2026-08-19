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
//!
//! MIGRATION (sidecar-only): model I/O now flows through the Python sidecar,
//! which talks to Ollama itself but CANNOT start it. So [`ensure_up`] (+ the
//! [`Busy`] guard and idle watcher) is wired into the Ollama gateway via
//! `ollama::wake_daemon`, called before every model-loading sidecar request and
//! held for the call's duration — Rust still owns the `ollama serve` process
//! lifecycle (on-demand spawn here, app-exit teardown via [`stop_if_ours`]).

use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long Ollama is asked to hold a warmed model resident — the `keep_alive`
/// this app sends (`commands::models::KEEP_ALIVE_WARM`, and the literal in
/// `ollama::warm`). Stated here as a Duration because the idle policy below is
/// defined against it and a bare string cannot be compared; the test at the
/// foot of this file pins the two together.
const KEEP_ALIVE_WARM_WINDOW: Duration = Duration::from_secs(30 * 60);

/// Stop a daemon WE started once holding it open has stopped buying anything.
///
/// This is a PROCESS backstop, not a memory policy, and the difference is the
/// whole point: `keep_alive` decides how long the model stays in RAM, this
/// decides how long the `ollama serve` we spawned outlives it. At five minutes
/// it was the shorter of the two, so the app asked for thirty minutes of warmth
/// and then SIGTERMed the daemon holding it at five — and every return after a
/// short pause paid a full cold start the app had already decided not to
/// charge. Coming back to a room after stepping away is the most common way a
/// person meets it, and it was the slowest path in.
///
/// DERIVED, not written down, so the ordering cannot come apart again: whatever
/// the warm window becomes, the process backstop stays five minutes behind it.
/// A literal here is what let the two drift for as long as they did.
pub const IDLE_SLEEP: Duration =
    Duration::from_secs(KEEP_ALIVE_WARM_WINDOW.as_secs() + 5 * 60);
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
/// duration and bumps the idle clock at BOTH ends, so the window is measured
/// from the last call to touch the daemon rather than the last one to finish.
pub struct Busy;

impl Busy {
    fn new() -> Self {
        // Both writes under the `our_pid` lock, which the idle watcher holds
        // across its ENTIRE check-and-kill. Without that shared lock the watcher
        // sampled `inflight`, then spawned `kill` — milliseconds in which a call
        // could be admitted onto a daemon already being terminated, so the first
        // thing a returning user did came back as a transport error.
        //
        // The clock is wound forward at the START of a call as well as at its
        // end: a call beginning one tick before the deadline was invisible to
        // the idle reading, which was taken from the last call to FINISH.
        let _own = lc().our_pid.lock();
        lc().inflight.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut t) = lc().last_used.lock() {
            *t = Instant::now();
        }
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

/// The HOST of a base URL, lowercased — scheme, credentials, port and path all
/// stripped, IPv6 literals unbracketed. Substring matching on the whole URL is
/// not good enough: `http://localhost-box.lan:11434` and
/// `http://ollama.127.0.0.1.nip.io` both CONTAIN a loopback spelling while
/// naming somebody else's machine.
fn host_of(base: &str) -> String {
    let after_scheme = base.rsplit("://").next().unwrap_or(base);
    let authority = after_scheme.split('/').next().unwrap_or(after_scheme);
    let hostport = authority.rsplit('@').next().unwrap_or(authority);
    let host = match hostport.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(v6),
        None => hostport.split(':').next().unwrap_or(hostport),
    };
    host.trim().to_ascii_lowercase()
}

/// Is the resolved base URL a local daemon we may start/stop? A remote override
/// (the closet supercomputer) is off-limits — starting a local daemon for it
/// wastes the user's time and then reports the REMOTE box down anyway.
///
/// Also the TRANSPORT half of "does this content leave the Mac?"
/// (`capabilities::ollama_runs_here`): the same question the daemon manager asks
/// is the one the privacy door has to ask, so there is one answer for both.
pub(crate) fn base_is_local(base: &str) -> bool {
    let host = host_of(base);
    host == "localhost"
        || host == "0.0.0.0"
        || host == "::1"
        || host == "::"
        || host.starts_with("127.")
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
        if base_is_local(base) {
            // A daemon answering on this Mac may be one WE started and were
            // force-quit away from — take it back before deciding it is a
            // stranger's. Only ever a local base: nothing on another machine
            // can be a process this app spawned.
            adopt_orphan();
        }
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
    let Some(bin) = ollama_bin() else {
        eprintln!("[ollama] not starting the daemon: no `ollama` binary on PATH or in /Applications");
        return Err("OLLAMA_DOWN".to_string());
    };
    // Detach: its own session, so it outlives this call but we still hold its
    // PID. stderr is PIPED, not discarded — a busy port, a broken install and
    // "not enough memory" all end up as the same generic OLLAMA_DOWN line, and
    // the daemon's own explanation was the only thing that told them apart.
    let mut child = match Command::new(&bin)
        .arg("serve")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[ollama] could not start `{bin} serve`: {e}");
            return Err("OLLAMA_DOWN".to_string());
        }
    };
    let pid = child.id();
    if let Some(stderr) = child.stderr.take() {
        // MANDATORY once piped: nobody reading fills the pipe and wedges the
        // daemon mid-write. Mirrors to `arcelle-ollama.log`, the only copy a
        // bundled app (which has no usable stderr of its own) can keep.
        crate::sidecar_lifecycle::mirror_stderr(stderr, "ollama", daemon_log_path());
    }
    if let Ok(mut slot) = lc().our_pid.lock() {
        *slot = Some(pid);
    }
    write_pid_file(&pid_file_path(), pid);
    // Reap on exit rather than leaking the handle: `ollama serve` is stopped and
    // restarted every time the idle watcher sleeps it, and an unwaited child
    // leaves a `<defunct>` entry under the app's name each time.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
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
    // the PID so the watcher can't later kill an innocent process, and stop it.
    if let Ok(mut slot) = lc().our_pid.lock() {
        if slot.map(|p| p == pid).unwrap_or(false) {
            *slot = None;
        }
    }
    let _ = std::fs::remove_file(pid_file_path());
    let _ = Command::new("kill").arg(pid.to_string()).status();
    eprintln!(
        "[ollama] `{bin} serve` never answered within {}s — see {}",
        START_TIMEOUT.as_secs(),
        daemon_log_path().display()
    );
    Err("OLLAMA_DOWN".to_string())
}

/// Where the daemon's stderr is mirrored, alongside the sidecar's own log.
pub fn daemon_log_path() -> std::path::PathBuf {
    std::env::temp_dir().join("arcelle-ollama.log")
}

/// Where the PID of a daemon WE spawned is recorded, so an abnormal exit cannot
/// orphan it forever.
///
/// Beside the daemon's stderr mirror rather than in the app's data folder:
/// nothing on this path has an `AppHandle` (the gateway calls it off any
/// command), and the two files describe the same process. If the temp directory
/// is swept between runs the only cost is a daemon we no longer recognise —
/// which is exactly today's behaviour — never a process stopped by mistake.
fn pid_file_path() -> std::path::PathBuf {
    std::env::temp_dir().join("arcelle-ollama.pid")
}

fn write_pid_file(path: &std::path::Path, pid: u32) {
    if let Err(e) = std::fs::write(path, pid.to_string()) {
        eprintln!(
            "[ollama] could not record the daemon's pid at {}: {e} — a crash would orphan it",
            path.display()
        );
    }
}

fn read_pid_file(path: &std::path::Path) -> Option<u32> {
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

/// Is this `ps` command line the exact invocation [`ensure_up`] spawns —
/// `<path ending in /ollama> serve`, nothing after it?
///
/// Whole invocation, not two words found somewhere in it: "contains ollama"
/// also matches `node /Users/me/ollama-tools/cli.js serve`, and what this
/// answer buys is the right to SIGTERM the process.
fn is_our_serve_command(cmd: &str) -> bool {
    let cmd = cmd.trim().to_ascii_lowercase();
    let Some(bin) = cmd.strip_suffix(" serve") else {
        return false;
    };
    std::path::Path::new(bin)
        .file_name()
        .map_or(false, |f| f == "ollama")
}

/// Is `pid` a live `ollama serve` right now?
///
/// The recorded number alone does not earn the right to SIGTERM anything: PIDs
/// are recycled, and by the next launch that one may belong to the user's
/// editor. The command line has to still be the daemon we wrote down.
fn is_ollama_serve(pid: u32) -> bool {
    Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| is_our_serve_command(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or(false)
}

/// Take back a daemon this app spawned before an abnormal exit.
///
/// [`stop_if_ours`] runs on a clean quit; a force-quit, a crash or a `kill -9`
/// never reaches it and the `ollama serve` it started keeps running. The next
/// launch found that daemon answering, recorded no PID, and by the safety rule
/// at the top of this file could then neither sleep it nor stop it — ever. The
/// PID file is what carries ownership across that gap; the `ps` check is what
/// keeps the rule intact, so a stranger's daemon is still never touched.
fn adopt_orphan() {
    if lc().our_pid.lock().map(|s| s.is_some()).unwrap_or(true) {
        return; // already ours this run — nothing to adopt
    }
    let path = pid_file_path();
    let Some(pid) = read_pid_file(&path) else {
        return;
    };
    if !is_ollama_serve(pid) {
        // Dead, or the number now belongs to something else. Forget it rather
        // than re-asking `ps` before every model call for the rest of the run.
        let _ = std::fs::remove_file(&path);
        return;
    }
    if let Ok(mut slot) = lc().our_pid.lock() {
        if slot.is_some() {
            return; // another caller adopted it while we were asking `ps`
        }
        *slot = Some(pid);
    } else {
        return;
    }
    eprintln!("[ollama] adopted the `ollama serve` (pid {pid}) left behind by an earlier run");
    start_watcher();
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
            // The whole decision under the `our_pid` lock that `Busy::new` also
            // takes. Sampling the condition and THEN spawning `kill` left a
            // window in which a call could take its guard, find the daemon
            // reachable, and be answered by a process already terminating.
            let Ok(mut slot) = lc().our_pid.lock() else {
                continue;
            };
            let Some(pid) = *slot else { continue };
            let Ok(idle) = lc().last_used.lock().map(|t| t.elapsed()) else {
                continue;
            };
            let inflight = lc().inflight.load(Ordering::SeqCst);
            if !should_sleep(true, idle, inflight) {
                continue;
            }
            // SIGTERM lets Ollama unload models and exit cleanly.
            let _ = Command::new("kill").arg(pid.to_string()).status();
            *slot = None;
            let _ = std::fs::remove_file(pid_file_path());
        }
    });
}

/// ADD-31: is the daemon answering right now? Cheap probe for UI feedback
/// ("Starting the local AI…") — never starts anything.
pub async fn is_awake(base: &str) -> bool {
    reachable(base).await
}

/// Locking the room ends the reason to stay warm.
///
/// [`IDLE_SLEEP`] is sized for a person who stepped away from an OPEN room and
/// is about to come back. Locking is that person saying they are done, and a
/// daemon we spawned holding a multi-gigabyte model for another half hour
/// behind a password screen is a resource nobody asked us to spend. Nothing is
/// killed here: the idle clock is wound back so the next watcher tick makes the
/// ordinary decision (ours, quiet, nothing in flight) — an external daemon is
/// still never touched, and a job still draining is still protected by
/// `inflight`.
pub(crate) fn note_room_closed() {
    if let Ok(mut t) = lc().last_used.lock() {
        *t = Instant::now()
            .checked_sub(IDLE_SLEEP)
            .unwrap_or_else(Instant::now);
    }
}

/// Stop a daemon we started, now — used on app shutdown so we never leak a
/// background `ollama serve` we spawned. A no-op for an external daemon.
///
/// Also removes the daemon's stderr mirror: it is a plain temp file useful only
/// while the session that produced it is being diagnosed, so it should not
/// outlive a clean quit (same rule as the sidecar's own log).
pub fn stop_if_ours() {
    if let Ok(mut slot) = lc().our_pid.lock() {
        if let Some(pid) = slot.take() {
            let _ = Command::new("kill").arg(pid.to_string()).status();
            // Only once something was actually stopped: a PID recorded by a run
            // that crashed before this one is the ONLY way that daemon can ever
            // be adopted, and a quit that never made a model call must not
            // throw it away.
            let _ = std::fs::remove_file(pid_file_path());
        }
    }
    let _ = std::fs::remove_file(daemon_log_path());
}

#[cfg(test)]
mod tests {
    use super::*;

    /// [`lc`] is one process-wide singleton, so the tests that READ it cannot
    /// run beside the tests that WRITE it — `Busy::new` winding the idle clock
    /// forward is the whole point of one of them and would silently rescue
    /// another. Held for the body of every test that touches the singleton.
    fn globals() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

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

    /// Locking the room hands the idle watcher an ordinary sleep decision on
    /// its next tick, instead of holding a spawned daemon — and the model it
    /// is keeping resident — for another `IDLE_SLEEP` behind a password screen.
    /// Still only ever a daemon we own, and still never one with work in flight.
    #[test]
    fn locking_the_room_lets_the_idle_watcher_sleep_our_daemon() {
        let _g = globals();
        note_room_closed();
        let idle = lc().last_used.lock().unwrap().elapsed();
        assert!(
            should_sleep(true, idle, 0),
            "after a lock the next tick should sleep a daemon we started; idle read as {idle:?} \
             against a {IDLE_SLEEP:?} window"
        );
        assert!(
            !should_sleep(false, idle, 0),
            "an external daemon is still never ours to stop"
        );
        assert!(
            !should_sleep(true, idle, 1),
            "work still in flight still keeps the daemon up"
        );
    }

    /// `KEEP_ALIVE_WARM_WINDOW` mirrors a string in another module. A textual
    /// assertion rather than an import: `commands` is private, and widening it
    /// for one constant would be a bigger change than the fact it guards. Move
    /// the wire value and this fails HERE, beside the policy that depends on it.
    #[test]
    fn the_warm_window_matches_the_keep_alive_we_send() {
        let models = include_str!("commands/models.rs");
        assert!(
            models.contains(r#"KEEP_ALIVE_WARM: &str = "30m""#),
            "commands::models::KEEP_ALIVE_WARM is no longer \"30m\" — IDLE_SLEEP is sized \
             against it and has to move with it"
        );
        assert_eq!(KEEP_ALIVE_WARM_WINDOW, Duration::from_secs(30 * 60));
    }

    #[test]
    fn base_locality_is_recognized() {
        assert!(base_is_local("http://127.0.0.1:11434"));
        assert!(base_is_local("http://localhost:11434"));
        assert!(!base_is_local("http://closet.local:11434"));
        assert!(!base_is_local("http://192.168.1.50:11434"));
    }

    #[test]
    fn a_remote_host_that_merely_spells_loopback_is_not_this_mac() {
        // The check used to be `contains`, so any of these started a local
        // daemon nobody asked for, waited for it, and then reported the REMOTE
        // box down anyway.
        assert!(!base_is_local("http://localhost-box.lan:11434"));
        assert!(!base_is_local("http://my-localhost.example.com:11434"));
        assert!(!base_is_local("http://ollama.127.0.0.1.nip.io:11434"));
        assert!(!base_is_local("http://box:11434/127.0.0.1"));
        // …while the real loopback spellings still are.
        assert!(base_is_local("http://127.0.0.5:11434"));
        assert!(base_is_local("http://[::1]:11434"));
        assert!(base_is_local("http://user:pw@localhost:11434"));
        assert!(base_is_local("127.0.0.1:11434"));
    }

    #[test]
    fn busy_guard_tracks_inflight() {
        let _g = globals();
        let before = lc().inflight.load(Ordering::SeqCst);
        {
            let _g = Busy::new();
            assert_eq!(lc().inflight.load(Ordering::SeqCst), before + 1);
        }
        assert_eq!(lc().inflight.load(Ordering::SeqCst), before);
    }

    /// The watcher samples the idle clock and `inflight` and then spends
    /// milliseconds spawning `kill`. A call that starts inside that window used
    /// to be invisible to both readings — the clock only moved when a call
    /// FINISHED — so the daemon could be terminated under a request that had
    /// already been admitted, and the user's first message after a pause came
    /// back as a transport error.
    #[test]
    fn a_call_that_starts_now_stops_the_next_tick_from_sleeping_the_daemon() {
        let _g = globals();
        note_room_closed(); // the watcher would sleep it on the next tick
        let busy = Busy::new();
        let idle = lc().last_used.lock().unwrap().elapsed();
        assert!(
            idle < IDLE_SLEEP,
            "the idle clock was not wound forward when the call STARTED: read {idle:?} \
             against a {IDLE_SLEEP:?} window, so a tick between its start and its end \
             sleeps the daemon it is using"
        );
        assert!(!should_sleep(true, idle, 0));
        drop(busy);
        // …and once it is over the idle window starts again from the end of it.
        let after = lc().last_used.lock().unwrap().elapsed();
        assert!(after < IDLE_SLEEP, "the clock did not restart at the call's end");
    }

    #[test]
    fn a_recorded_pid_round_trips_and_junk_is_ignored() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("arcelle-ollama-test-{}.pid", std::process::id()));
        let _ = std::fs::remove_file(&path);
        assert_eq!(read_pid_file(&path), None, "a missing record is not a pid");
        write_pid_file(&path, 4242);
        assert_eq!(read_pid_file(&path), Some(4242));
        std::fs::write(&path, "not a pid\n").unwrap();
        assert_eq!(read_pid_file(&path), None, "a corrupt record is not a pid");
        let _ = std::fs::remove_file(&path);
    }

    /// Adoption may only ever hand us back an `ollama serve`. A PID is recycled
    /// the moment the daemon dies, so believing the recorded number on its own
    /// would eventually SIGTERM whatever inherited it.
    #[test]
    fn only_a_live_ollama_daemon_can_be_adopted() {
        assert!(
            !is_ollama_serve(std::process::id()),
            "the test runner is not an ollama daemon"
        );
        assert!(!is_ollama_serve(1), "launchd is not an ollama daemon");
        // A PID that cannot exist: `ps` finds nothing and must not claim it.
        assert!(!is_ollama_serve(u32::MAX));
    }

    /// The command line that earns a SIGTERM is the one we spawn, whole. A
    /// looser reading ("ends in serve, mentions ollama somewhere") hands the
    /// same right to any process that happens to have the word on its argument
    /// list — a wrapper script, a checkout, a log path.
    #[test]
    fn only_the_invocation_we_spawn_reads_as_our_daemon() {
        for cmd in [
            "/Applications/Ollama.app/Contents/Resources/ollama serve",
            "/opt/homebrew/bin/ollama serve\n",
            "/OPT/Homebrew/bin/Ollama Serve",
        ] {
            assert!(is_our_serve_command(cmd), "should be ours: {cmd:?}");
        }
        for cmd in [
            "node /Users/me/ollama-tools/cli.js serve",
            "/opt/homebrew/bin/ollama serve --port 11500",
            "/opt/homebrew/bin/ollama run llama3",
            "/usr/local/bin/my-ollama-proxy serve",
            " serve",
            "serve",
            "",
        ] {
            assert!(!is_our_serve_command(cmd), "should not be ours: {cmd:?}");
        }
    }
}
