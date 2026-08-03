//! ADD-33: manage the local Python/LangGraph agent sidecar the same way
//! [`crate::ollama_lifecycle`] manages the Ollama daemon.
//!
//! The sidecar is the app's SOLE AI engine — not an option and not a preference.
//! The native `agent_loop` it once stood beside is deleted, so if this module
//! cannot start the process the app cannot answer at all; there is nothing to
//! fall back to. (The old `agent_engine` setting is gone too.) This module owns
//! the process — spawn it on demand, learn the loopback port it chose, hand out
//! its base URL, and SIGTERM it on app exit.
//!
//! Same safety rule as Ollama: we only ever stop a process WE spawned, and it is
//! bound to `127.0.0.1` only. The sidecar never sees the room key — it reaches
//! the room's tools solely through the token-guarded loopback MCP bridge.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
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
    /// Requests WE currently have in flight on that sidecar. Never replace a
    /// sidecar while this is > 0 unless it is provably gone: the count is the
    /// only thing that distinguishes "nobody is using it" from "the user's
    /// answer is streaming through it right now".
    inflight: AtomicUsize,
}

fn lc() -> &'static Lifecycle {
    static LC: OnceLock<Lifecycle> = OnceLock::new();
    LC.get_or_init(|| Lifecycle {
        our_pid: Mutex::new(None),
        base_url: Mutex::new(None),
        inflight: AtomicUsize::new(0),
    })
}

/// The shared secret every sidecar this app process spawns is given, and that
/// every request of ours carries.
///
/// The port is loopback-only, but on a Mac loopback is not a boundary: without
/// this, any other program running as the user could drive the agent — start
/// runs, generate text, search the web, delete downloaded models. The room MCP
/// bridge and `hub_mcp` have always demanded a token; the sidecar was the odd
/// one out. Minted once per app process (two v4 UUIDs = 244 random bits),
/// handed over in the child's ENVIRONMENT so it never reaches stdout, the
/// stderr log or disk, and never logged here either.
pub fn auth_token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| {
        format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        )
    })
}

/// The environment variable the sidecar reads it from (`server.TOKEN_ENV`).
const TOKEN_ENV: &str = "ARCELLE_SIDECAR_TOKEN";

/// Stamp our token on a sidecar request. EVERY request to the sidecar goes
/// through here — a call site that forgets it gets a 401 instead of an answer,
/// so this is the one place the header is spelled.
pub fn authed(rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    rb.header("authorization", format!("Bearer {}", auth_token()))
}

/// RAII marker for ONE request we have in flight on the sidecar, mirroring
/// [`crate::ollama_lifecycle::Busy`]. Every caller of [`ensure_up`] takes one and
/// holds it for the whole duration of its HTTP call — a streaming answer, a
/// ten-hour file pass — so [`ensure_up`] on another task cannot SIGTERM the
/// process that is serving it.
pub struct Busy;

/// Register one in-flight sidecar request; the returned guard unregisters it on
/// drop (including when the future is cancelled by Stop).
pub fn busy() -> Busy {
    lc().inflight.fetch_add(1, Ordering::SeqCst);
    Busy
}

impl Drop for Busy {
    fn drop(&mut self) {
        lc().inflight.fetch_sub(1, Ordering::SeqCst);
    }
}

fn inflight() -> usize {
    lc().inflight.load(Ordering::SeqCst)
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
/// on stdout, and health-check it. `Err` means the sidecar could not start, and
/// there is nothing behind it — the caller surfaces an error to the user.
///
/// Callers must take a [`busy`] guard for the lifetime of the request they then
/// make, so a concurrent `ensure_up` can see that the sidecar is serving
/// something before it decides to replace it.
pub async fn ensure_up() -> Result<String, String> {
    if let Some(url) = current_base_url() {
        let verdict = probe_recorded(&url).await;
        if verdict == Probe::Healthy {
            return Ok(url);
        }
        if !should_replace(verdict, inflight()) {
            // It accepted the connection, so the process is alive — it is merely
            // busy — and requests of ours are riding on it. Ride on it too: the
            // caller's own budget decides, rather than this probe killing an
            // answer that is mid-stream.
            return Ok(url);
        }
        // A recorded sidecar that is genuinely gone, or wedged with nothing of
        // ours riding on it: STOP it, then respawn. Merely forgetting it left a
        // wedged Python process holding its port, its resident memory and its
        // Ollama connection until the Mac was restarted, and every subsequent
        // stall stacked another one up.
        stop_ours();
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

/// The recorded sidecar's base URL, WITHOUT starting one.
///
/// [`ensure_up`] is the wrong door for teardown work: locking a room must never
/// spawn the AI service just to tell it to forget something, and "there is no
/// sidecar" is the same outcome as "it forgot".
pub(crate) fn base_url_if_running() -> Option<String> {
    current_base_url()
}

/// Stop the sidecar WE spawned, if any, and drop what we knew about it. Used
/// both on app shutdown and when a recorded sidecar stops answering: a process
/// that has wedged still owns its port and its memory, so respawning without
/// killing it leaks one Python process per stall.
fn stop_ours() {
    if let Ok(mut u) = lc().base_url.lock() {
        *u = None;
    }
    let pid = lc().our_pid.lock().ok().and_then(|mut p| p.take());
    if let Some(pid) = pid {
        // SIGTERM by PID; the reaper thread `spawn_and_wait` left running on the
        // `Child` handle collects it, so no `<defunct>` entry is left behind.
        let _ = Command::new("kill").arg(pid.to_string()).status();
    }
}

/// Where the sidecar's stderr is mirrored. A released app launched from Finder has
/// no usable stderr of its own, so "run it from a terminal" is not a diagnosis path
/// for a user — the traceback has to land in a file.
pub fn stderr_log_path() -> std::path::PathBuf {
    std::env::temp_dir().join("arcelle-sidecar.log")
}

/// The PREVIOUS run's log. The app restarts the sidecar automatically the moment
/// it stops answering, so truncating on every spawn wiped the traceback that
/// explained the crash before anyone could read it — exactly the one-off failure
/// that is hardest to reproduce. One generation is kept here instead.
pub fn previous_stderr_log_path() -> std::path::PathBuf {
    std::env::temp_dir().join("arcelle-sidecar.prev.log")
}

/// Drain the child's stderr on a detached thread, mirroring each line to the app's
/// own stderr (useful in dev) and appending it to [`stderr_log_path`] (the only copy
/// a bundled app keeps). Draining is MANDATORY, not a nicety: `Stdio::piped()` with
/// nobody reading fills the pipe buffer and blocks the sidecar mid-write.
fn drain_stderr(stderr: std::process::ChildStderr) {
    // Rotate rather than truncate: the run that just died is usually the one
    // worth reading, and it is the run the auto-restart replaced.
    let _ = std::fs::rename(stderr_log_path(), previous_stderr_log_path());
    mirror_stderr(stderr, "sidecar", stderr_log_path());
}

/// Drain a child's piped stderr on a detached thread, mirroring each line to the
/// app's own stderr (useful in dev) and appending it to `path` (the only copy a
/// bundled app keeps). Shared with [`crate::ollama_lifecycle`], whose daemon has
/// the same "the explanation only exists on stderr" problem.
///
/// Draining is MANDATORY once a pipe is requested, not a nicety: `Stdio::piped()`
/// with nobody reading fills the pipe buffer and blocks the child mid-write.
pub(crate) fn mirror_stderr(
    stderr: std::process::ChildStderr,
    tag: &'static str,
    path: std::path::PathBuf,
) {
    std::thread::spawn(move || {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&path)
            .ok();
        let mut written = 0usize;
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[{tag}] {line}");
            // Keep DRAINING past the budget (an unread pipe wedges the child)
            // but stop growing the file. A chatty daemon logging every request
            // for hours must not fill the user's disk with a temp file nothing
            // reads, and the useful part of a crash log is where it started.
            if written >= STDERR_LOG_BUDGET {
                continue;
            }
            if let Some(f) = file.as_mut() {
                let _ = writeln!(f, "{line}");
                let _ = f.flush();
                written += line.len() + 1;
                if written >= STDERR_LOG_BUDGET {
                    let _ = writeln!(f, "[arcelle] log budget reached — further output dropped");
                    let _ = f.flush();
                }
            }
        }
    });
}

/// How much of a child's stderr is kept on disk per run.
const STDERR_LOG_BUDGET: usize = 2 * 1024 * 1024;

/// Spawn the process, block (on a blocking thread) reading stdout until it prints
/// `SIDECAR_PORT=N`, then confirm `/health`. The port line is how we learn the
/// ephemeral port without a bind-and-release race.
async fn spawn_and_wait() -> Result<String, String> {
    let mut cmd = launch_command().ok_or_else(|| {
        unavailable("no sidecar to launch — no bundled binary in Resources/ and no \
                     ARCELLE_SIDECAR_PYTHON pointing at a Python with the package")
    })?;
    // The shared secret, handed over out of band. Environment rather than a
    // second stdout line: the announce line is parsed (and, when a start goes
    // wrong, read by a human), and a secret has no business there.
    cmd.env(TOKEN_ENV, auth_token());
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        // NOT `Stdio::null()`. The sidecar's ENTIRE diagnostic channel is stderr:
        // `logging.basicConfig` installs a root StreamHandler there, uvicorn writes
        // "Exception in ASGI application" + traceback there, and asyncio writes
        // "Task exception was never retrieved" there. Discarding it is why a run that
        // visibly did work could fail with NO error message anywhere on the machine
        // (live QA 2026-07-30) — the traceback naming the cause was printed and
        // thrown away. Piped here and drained below; an undrained pipe would fill
        // and wedge the child, so the reader thread is not optional.
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| unavailable(&format!("could not start the sidecar: {e}")))?;
    let pid = child.id();
    if let Some(stderr) = child.stderr.take() {
        drain_stderr(stderr);
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| unavailable("the sidecar's stdout could not be captured"))?;

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
            // Never announced a port (crash on import, bad interpreter, a
            // START_TIMEOUT elapsed): kill it so we don't leak the child, and
            // say WHICH of those it was — the traceback itself is already in
            // `stderr_log_path`.
            let _ = Command::new("kill").arg(pid.to_string()).status();
            let _ = child.wait();
            return Err(unavailable(&format!(
                "the sidecar printed no SIDECAR_PORT line within {}s (see {})",
                START_TIMEOUT.as_secs(),
                stderr_log_path().display()
            )));
        }
    };
    // The sidecar is a long-lived daemon we manage by PID (like `ollama serve`),
    // stopped via `stop_if_ours` on exit — so the handle must outlive this call.
    // It used to be `std::mem::forget`-ed, which never waits: every restart (and
    // the daemon restarts on every stall) left a `<defunct>` entry under the
    // app's name for the rest of the session. Park the handle on a thread that
    // does nothing but `wait`, which reaps it the moment it actually exits.
    std::thread::spawn(move || {
        let _ = child.wait();
    });

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
    Err(unavailable(&format!(
        "the sidecar announced port {port} but never passed /health within {}s (see {})",
        START_TIMEOUT.as_secs(),
        stderr_log_path().display()
    )))
}

/// The sidecar-could-not-start error. The `SIDECAR_UNAVAILABLE` head is kept
/// because it is the string the surfaces above match on; the reason follows it
/// instead of being discarded, so a broken interpreter, a busy port and a crash
/// on import stop reading as the same blank failure.
fn unavailable(reason: &str) -> String {
    format!("SIDECAR_UNAVAILABLE: {reason}")
}

/// Parse the `SIDECAR_PORT=NNNN` handshake line the sidecar prints on startup.
fn parse_port_line(line: &str) -> Option<u16> {
    line.trim().strip_prefix("SIDECAR_PORT=")?.trim().parse().ok()
}

/// What one `/health` probe of a recorded sidecar found.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Probe {
    /// Answered `{"ok": true}` — reuse it.
    Healthy,
    /// Did not answer in time, but the connection was ACCEPTED: the process is
    /// alive, its event loop is just busy (a local model streaming through it, a
    /// multi-megabyte body being parsed, swap pressure).
    Busy,
    /// Nothing is listening on that port any more — the process is gone.
    Gone,
}

/// How long one probe waits for `/health`.
const HEALTH_TIMEOUT: Duration = Duration::from_millis(1500);
/// How many probes a recorded sidecar gets before we act on the answer, and the
/// gap between them. One missed probe is not evidence of anything; only the
/// healthy path is hot, and it returns on the first attempt.
const PROBE_ATTEMPTS: usize = 3;
const PROBE_GAP: Duration = Duration::from_millis(300);

/// Should a recorded sidecar be SIGTERMed and replaced? Pure, so the policy is
/// testable without a process: a live-but-busy sidecar is replaced only when
/// nothing of ours is riding on it (otherwise the kill takes down a streaming
/// answer or a running job), while one that is gone has nothing to protect.
fn should_replace(verdict: Probe, inflight: usize) -> bool {
    match verdict {
        Probe::Healthy => false,
        Probe::Busy => inflight == 0,
        Probe::Gone => true,
    }
}

/// Probe a recorded sidecar up to [`PROBE_ATTEMPTS`] times. Any healthy answer
/// wins immediately; a single accepted-but-silent attempt is enough to rule out
/// "the process is gone", because a dead port refuses instantly.
async fn probe_recorded(base: &str) -> Probe {
    let mut verdict = Probe::Gone;
    for attempt in 0..PROBE_ATTEMPTS {
        match probe_once(base).await {
            Probe::Healthy => return Probe::Healthy,
            Probe::Busy => verdict = Probe::Busy,
            Probe::Gone => {}
        }
        if attempt + 1 < PROBE_ATTEMPTS {
            tokio::time::sleep(PROBE_GAP).await;
        }
    }
    verdict
}

/// One `/health` probe, classified. Anything that is not a refused connection
/// counts as ALIVE: an answer we could not parse, a non-2xx status and a timeout
/// all came from a process that is still there.
async fn probe_once(base: &str) -> Probe {
    let client = match reqwest::Client::builder().timeout(HEALTH_TIMEOUT).build() {
        Ok(c) => c,
        // Our own failure to build a client says nothing about the sidecar, and
        // must never be the reason one is killed.
        Err(_) => return Probe::Busy,
    };
    let resp = match client.get(format!("{base}/health")).send().await {
        Ok(r) => r,
        Err(e) if e.is_connect() => return Probe::Gone,
        Err(_) => return Probe::Busy,
    };
    if !resp.status().is_success() {
        return Probe::Busy;
    }
    let ok = resp
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| v.get("ok").and_then(|b| b.as_bool()))
        .unwrap_or(false);
    if ok {
        Probe::Healthy
    } else {
        Probe::Busy
    }
}

/// True when the sidecar answers `/health` with `{"ok": true}` within ~1.5s.
async fn health(base: &str) -> bool {
    probe_once(base).await == Probe::Healthy
}

/// Stop a sidecar we started — used on app shutdown so we never leak a
/// background Python process we spawned. A no-op if none is running.
///
/// Also removes the stderr mirrors. They are plain, unencrypted files in the
/// Mac's shared temp folder holding whatever the engine printed, they are only
/// useful while the session that produced them is being diagnosed, and nothing
/// in the app ever offered to open them — so leaving them behind after a clean
/// quit is only a leak.
pub fn stop_if_ours() {
    stop_ours();
    let _ = std::fs::remove_file(stderr_log_path());
    let _ = std::fs::remove_file(previous_stderr_log_path());
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
    fn the_sidecar_token_is_a_usable_secret_and_rides_on_every_request() {
        let tok = auth_token();
        // Stable for the process — a fresh one per call would 401 against the
        // sidecar we already spawned with the first.
        assert_eq!(tok, auth_token());
        assert!(tok.len() >= 32, "{}", tok.len());
        // A header value: no whitespace, no newline, nothing to smuggle with.
        assert!(tok.chars().all(|c| c.is_ascii_alphanumeric()), "{tok}");

        let req = authed(reqwest::Client::new().post("http://127.0.0.1:1/run"))
            .build()
            .unwrap();
        assert_eq!(
            req.headers().get("authorization").unwrap(),
            &format!("Bearer {tok}")
        );
    }

    #[test]
    fn no_sidecar_request_is_sent_without_the_token() {
        // The sidecar now refuses an unauthenticated caller, so a request site
        // that skips `authed` is a dead feature — a 401 where an answer was.
        // This is the guard that finds the NEXT one, at compile time rather
        // than in front of a user.
        for (name, src) in [
            ("sidecar.rs", include_str!("sidecar.rs")),
            ("ollama.rs", include_str!("ollama.rs")),
        ] {
            for (n, line) in src.lines().enumerate() {
                let hit = line.contains(".post(format!(\"{base}");
                if hit && !line.contains("authed(") {
                    panic!("{name}:{} posts to the sidecar unauthenticated: {line}", n + 1);
                }
            }
        }
    }

    #[test]
    fn dev_sidecar_dir_points_at_the_package() {
        assert!(default_dev_sidecar_dir().ends_with("/sidecar"));
    }

    #[test]
    fn an_unavailable_error_keeps_the_reason_it_used_to_drop() {
        // Three unrelated failures (nothing to launch, spawn failed, no port
        // line) all used to surface as the bare sentinel, so a broken Python
        // install, a busy port and a crash on import were indistinguishable.
        let e = unavailable("could not start the sidecar: No such file or directory");
        assert!(e.starts_with("SIDECAR_UNAVAILABLE"), "{e}");
        assert!(e.contains("No such file or directory"), "{e}");
    }

    #[test]
    fn a_busy_sidecar_is_never_killed_out_from_under_a_request() {
        // Regression: one missed 1.5s /health probe used to SIGTERM the sidecar,
        // and `ensure_up` runs before EVERY sidecar request — including the ones
        // a tool call makes while an answer is streaming. A moment of event-loop
        // starvation therefore killed the user's in-flight answer and any
        // background job (a file pass has a ten-hour budget) sharing the process.
        assert!(!should_replace(Probe::Healthy, 0));
        assert!(!should_replace(Probe::Healthy, 3));
        // Alive (the connection was accepted) with work of ours riding on it.
        assert!(!should_replace(Probe::Busy, 1));
        assert!(!should_replace(Probe::Busy, 9));
        // Alive but idle → replacing it costs nothing, and this is how a
        // genuinely wedged sidecar still gets recovered rather than leaked.
        assert!(should_replace(Probe::Busy, 0));
        // Nothing is listening any more: there is nothing left to protect.
        assert!(should_replace(Probe::Gone, 0));
        assert!(should_replace(Probe::Gone, 4));
    }

    #[test]
    fn the_busy_guard_counts_requests_in_flight() {
        let before = inflight();
        {
            let _a = busy();
            assert_eq!(inflight(), before + 1);
            let _b = busy();
            assert_eq!(inflight(), before + 2);
        }
        assert_eq!(inflight(), before);
    }

    #[tokio::test]
    async fn a_silent_port_reads_as_busy_and_a_closed_one_as_gone() {
        // The whole distinction rests on this: a wedged Python process still has
        // its socket bound, so the kernel completes the handshake and the probe
        // TIMES OUT, while a process that is really gone refuses instantly.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        // Bound, never answers — alive.
        assert_eq!(probe_once(&format!("http://127.0.0.1:{port}")).await, Probe::Busy);
        drop(listener);
        // Same port with nothing behind it — gone.
        assert_eq!(probe_once(&format!("http://127.0.0.1:{port}")).await, Probe::Gone);
    }

    #[test]
    fn the_two_stderr_mirrors_are_distinct_files() {
        // The current run's log is rotated to the `.prev` name on each spawn, so
        // the crash that triggered the automatic restart survives it.
        assert_ne!(stderr_log_path(), previous_stderr_log_path());
        assert!(stderr_log_path().to_string_lossy().ends_with("arcelle-sidecar.log"));
        assert!(previous_stderr_log_path()
            .to_string_lossy()
            .ends_with("arcelle-sidecar.prev.log"));
    }
}
