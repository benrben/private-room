//! Wave 5 (Idea 13): the runnable/schedulable SCRIPT runner. A `.py`/`.js` room
//! file becomes a first-class script — a new `script_run` node kind in the Wave
//! 4a workflow engine — so scheduling a script is just an auto-created single-node
//! workflow reusing 4a's queue + scheduler (no parallel job system).
//!
//! Because a spawned interpreter can NEVER read the SQLCipher room DB, every run:
//!   1. materializes each declared room-input into a throwaway workspace
//!      (`app_cache_dir()/script-runs/<job_id>/`, mode 0700),
//!   2. runs the script there with `cwd` = that dir and a minimal env that never
//!      carries the room path or key,
//!   3. imports declared + NEW outputs back through `store_file_bytes` (so writes
//!      are versioned/undoable), and
//!   4. deletes the workspace in the epilogue on EVERY outcome (a startup sweep in
//!      lib.rs removes orphans from a crash).
//!
//! Room mutations happen only in the import-back phase after exit 0, so a
//! Stop/kill/timeout/crash never leaves a partial room write — the run is
//! transactional from the room's point of view.

use super::*;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// Default script timeout (seconds) — the first `uv` run resolves and downloads
/// wheels, so the default is generous.
const DEFAULT_TIMEOUT_SECS: u64 = 600;
const MIN_TIMEOUT_SECS: u64 = 5;
const MAX_TIMEOUT_SECS: u64 = 3600;
/// Stdout/stderr are drained into 32 KB ring tails.
const RING_BYTES: usize = 32 * 1024;
/// How many times the uv runner will auto-install a missing package and retry
/// before giving up (one new package per round). Bounds the loop; enough for a
/// typical data-science script (pandas + yfinance + a couple more).
const MAX_HEAL_ROUNDS: usize = 8;

/// The top-level package name from a Python `ModuleNotFoundError` stderr, if any.
/// `No module named 'pandas.core'` → `pandas`. Used to auto-install a package the
/// script imported but never declared, so the user never has to pip install.
fn missing_module(stderr: &str) -> Option<String> {
    let at = stderr.find("No module named '")?;
    let rest = &stderr[at + "No module named '".len()..];
    let name = rest.split('\'').next()?;
    let top = name.split('.').next()?.trim();
    // Only plain package tokens — never shell out with something odd.
    if top.is_empty() || !top.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return None;
    }
    Some(top.to_string())
}
/// Auto-import caps for NEW (undeclared) files a script creates (decision 2).
const MAX_NEW_FILES: usize = 20;
const MAX_IMPORT_BYTES: u64 = 64 * 1024 * 1024;
/// Cap on room files auto-materialized by name-reference (read side). Bounds the
/// pre-run copy so a room with a huge file list can't balloon the workspace; any
/// matches beyond the cap are skipped (the script can still declare them via
/// `# room-inputs:`).
const MAX_AUTO_MATERIALIZE: usize = 20;
/// Grace between SIGTERM and SIGKILL when killing the process group.
const KILL_GRACE: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------- manifest

/// A script's language, from its file extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScriptLang {
    Py,
    Js,
}

/// Where a script surfaces as a one-click shortcut (decision 3). `file` = the
/// headers of its declared input/output files; `global` = the TopBar; `none` = no
/// shortcut (still runnable from the Scripts page + file header).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Shortcut {
    Global,
    File,
    None,
}

/// The PEP-723 + `room-*` manifest parsed from a script's first 64 lines.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptManifest {
    pub interpreter: ScriptLang,
    pub deps: Vec<String>,
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    pub timeout_secs: u64,
    pub shortcut: Shortcut,
}

impl ScriptManifest {
    pub fn has_deps(&self) -> bool {
        !self.deps.is_empty()
    }
}

/// Language for a file name; None if it isn't a script we run.
pub fn script_lang_of(name: &str) -> Option<ScriptLang> {
    match extraction::extension_of(name).as_str() {
        "py" => Some(ScriptLang::Py),
        "js" => Some(ScriptLang::Js),
        _ => None,
    }
}

/// SHA-256 (hex) of the script's raw bytes — the content-addressed consent key
/// (clone of `text_digest`, but over bytes). Any edit changes the hash → the old
/// approval no longer counts, so a changed script re-prompts for free.
pub fn script_fingerprint(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Parse the manifest from a script's text (decision 3's grammar). Pure — no I/O.
/// Scans the first 64 lines; comment prefix `#` for `.py`, `//` for `.js`; first
/// occurrence of each key wins; keys are case-insensitive. A missing PEP-723
/// block means self-contained (no deps).
pub fn parse_script_manifest(name: &str, text: &str) -> ScriptManifest {
    let lang = script_lang_of(name).unwrap_or(ScriptLang::Py);
    let prefix = match lang {
        ScriptLang::Py => "#",
        ScriptLang::Js => "//",
    };
    let mut deps: Vec<String> = Vec::new();
    let mut inputs: Vec<String> = Vec::new();
    let mut outputs: Vec<String> = Vec::new();
    let mut timeout_secs: Option<u64> = None;
    let mut shortcut: Option<Shortcut> = None;
    let mut deps_seen = false;
    let mut inputs_seen = false;
    let mut outputs_seen = false;

    for raw in text.lines().take(64) {
        let line = raw.trim_start();
        let Some(rest) = line.strip_prefix(prefix) else {
            continue;
        };
        let content = rest.trim();
        let lower = content.to_lowercase();
        // PEP-723 inline dependencies line — read tolerantly, for display and
        // the has-deps decision (uv is the authoritative parser at run time).
        if !deps_seen && lower.starts_with("dependencies") && content.contains('=') {
            deps = extract_quoted(content);
            deps_seen = true;
            continue;
        }
        if let Some(v) = strip_key(&lower, content, "room-inputs") {
            if !inputs_seen {
                inputs = split_names(v);
                inputs_seen = true;
            }
        } else if let Some(v) = strip_key(&lower, content, "room-outputs") {
            if !outputs_seen {
                outputs = split_names(v);
                outputs_seen = true;
            }
        } else if let Some(v) = strip_key(&lower, content, "room-timeout") {
            if timeout_secs.is_none() {
                if let Ok(n) = v.trim().parse::<u64>() {
                    timeout_secs = Some(n.clamp(MIN_TIMEOUT_SECS, MAX_TIMEOUT_SECS));
                }
            }
        } else if let Some(v) = strip_key(&lower, content, "room-shortcut") {
            if shortcut.is_none() {
                shortcut = match v.trim().to_lowercase().as_str() {
                    "global" => Some(Shortcut::Global),
                    "file" => Some(Shortcut::File),
                    "none" => Some(Shortcut::None),
                    _ => None,
                };
            }
        }
    }

    // Default shortcut: file when the script touches room files, else none.
    let shortcut = shortcut.unwrap_or(if inputs.is_empty() && outputs.is_empty() {
        Shortcut::None
    } else {
        Shortcut::File
    });

    ScriptManifest {
        interpreter: lang,
        deps,
        inputs,
        outputs,
        timeout_secs: timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS),
        shortcut,
    }
}

/// If `content` (with `lower` its lowercase) begins with `key:`, return the raw
/// value after the colon (original case preserved for file names).
fn strip_key<'a>(lower: &str, content: &'a str, key: &str) -> Option<&'a str> {
    let want = format!("{key}:");
    if lower.starts_with(&want) {
        Some(&content[want.len()..])
    } else {
        None
    }
}

/// Comma-separated file names → trimmed, non-empty list.
fn split_names(v: &str) -> Vec<String> {
    v.split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Pull the double-quoted strings out of a `dependencies = ["a", "b"]` line.
/// Tolerant: it does not require valid TOML, just the quoted tokens.
fn extract_quoted(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '"' || c == '\'' {
            let quote = c;
            let mut token = String::new();
            for c2 in chars.by_ref() {
                if c2 == quote {
                    break;
                }
                token.push(c2);
            }
            let t = token.trim().to_string();
            if !t.is_empty() {
                out.push(t);
            }
        }
    }
    out
}

// ---------------------------------------------------------------- interpreter

/// Which runtime a script runs on. Pure policy output (decision 4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerChoice {
    /// `uv run --no-project <script.py>` — reads PEP 723, per-script cached env.
    Uv,
    /// `/usr/bin/python3 <script.py>` — dependency-free scripts only.
    Python3,
    /// `node <script.js>` — dependency-free scripts only.
    Node,
}

/// A resolved runtime: the program path + the argv prefix before the script.
#[derive(Debug, Clone)]
pub struct Runner {
    pub program: String,
    pub argv_prefix: Vec<String>,
}

/// Pure runtime-selection policy (decision 4), split out for the unit-test
/// matrix (uv/no-uv × deps/no-deps × py/js). `uv`/`py3`/`node` say whether each
/// is installed.
pub fn interpreter_policy(
    uv: bool,
    py3: bool,
    node: bool,
    lang: ScriptLang,
    has_deps: bool,
) -> Result<RunnerChoice, String> {
    match lang {
        ScriptLang::Py => {
            if uv {
                // uv handles both dependency-free and PEP-723 scripts.
                Ok(RunnerChoice::Uv)
            } else if has_deps {
                Err("This script needs extra Python packages. Install uv (run `brew install uv`) to run scripts with dependencies.".into())
            } else if py3 {
                Ok(RunnerChoice::Python3)
            } else {
                Err("No Python interpreter was found. Install Python 3, or uv (`brew install uv`), to run this script.".into())
            }
        }
        ScriptLang::Js => {
            if has_deps {
                Err("JavaScript scripts with dependencies aren't supported yet — remove the dependency declaration to run this script.".into())
            } else if node {
                Ok(RunnerChoice::Node)
            } else {
                Err("Node.js isn't installed. Install it (`brew install node`) to run JavaScript scripts.".into())
            }
        }
    }
}

/// Probe a binary by an absolute-path candidate list, then a login-shell
/// fallback (a GUI launch has only a bare launchd PATH; user tools live in
/// PATH via `.zshrc`). Mirrors `ollama_lifecycle::ollama_bin`.
fn probe_bin(candidates: &[String], login_probe: &str) -> Option<String> {
    for cand in candidates {
        if !cand.is_empty() && Path::new(cand).exists() {
            return Some(cand.clone());
        }
    }
    Command::new("zsh")
        .args(["-ilc", login_probe])
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
}

fn home() -> String {
    std::env::var("HOME").unwrap_or_default()
}

fn uv_bin() -> Option<String> {
    static BIN: OnceLock<Option<String>> = OnceLock::new();
    BIN.get_or_init(|| {
        probe_bin(
            &[
                format!("{}/.local/bin/uv", home()),
                "/opt/homebrew/bin/uv".into(),
                "/usr/local/bin/uv".into(),
            ],
            "command -v uv",
        )
    })
    .clone()
}

fn python3_bin() -> Option<String> {
    static BIN: OnceLock<Option<String>> = OnceLock::new();
    BIN.get_or_init(|| {
        probe_bin(
            &[
                "/usr/bin/python3".into(),
                "/opt/homebrew/bin/python3".into(),
                "/usr/local/bin/python3".into(),
            ],
            "command -v python3",
        )
    })
    .clone()
}

fn node_bin() -> Option<String> {
    static BIN: OnceLock<Option<String>> = OnceLock::new();
    BIN.get_or_init(|| {
        probe_bin(
            &[
                "/opt/homebrew/bin/node".into(),
                "/usr/local/bin/node".into(),
                "/usr/bin/node".into(),
            ],
            "command -v node",
        )
    })
    .clone()
}

/// Resolve the runtime for a script, per `interpreter_policy` + the probes.
/// Enriches the deps-need-uv error with the actual package names.
pub fn resolve_interpreter(manifest: &ScriptManifest) -> Result<Runner, String> {
    let choice = interpreter_policy(
        uv_bin().is_some(),
        python3_bin().is_some(),
        node_bin().is_some(),
        manifest.interpreter,
        manifest.has_deps(),
    )
    .map_err(|e| {
        if manifest.interpreter == ScriptLang::Py && manifest.has_deps() && uv_bin().is_none() {
            format!(
                "This script needs {}. Install uv (`brew install uv`) to run scripts with dependencies.",
                manifest.deps.join(", ")
            )
        } else {
            e
        }
    })?;
    Ok(match choice {
        RunnerChoice::Uv => {
            // Install declared deps via explicit `--with` flags rather than
            // relying on uv's own PEP-723 parse: a bare `# dependencies = [...]`
            // line (no full `# /// script ... # ///` fence) then still installs,
            // so the assistant only has to list the packages — uv does the rest,
            // no manual pip. `--with` is idempotent and cached across runs.
            let mut argv = vec!["run".into(), "--no-project".into()];
            for d in &manifest.deps {
                argv.push("--with".into());
                argv.push(d.clone());
            }
            Runner {
                program: uv_bin().unwrap_or_default(),
                argv_prefix: argv,
            }
        }
        RunnerChoice::Python3 => Runner {
            program: python3_bin().unwrap_or_default(),
            argv_prefix: vec![],
        },
        RunnerChoice::Node => Runner {
            program: node_bin().unwrap_or_default(),
            argv_prefix: vec![],
        },
    })
}

// ---------------------------------------------------------------- workspace

/// The root under which every run's throwaway workspace lives.
fn script_runs_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    use tauri::Manager as _;
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("script-runs"))
}

/// Remove every orphaned `script-runs/*` workspace left by a crash. Called from
/// lib.rs setup (the `quiesce_stale_jobs` spirit) — at startup no run is live.
pub fn sweep_script_workspaces<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Ok(root) = script_runs_root(app) {
        let _ = std::fs::remove_dir_all(&root);
    }
}

/// Create `script-runs/<job_id>/` at mode 0700, plus a `tmp/` for TMPDIR.
fn make_workspace<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    job_id: &str,
) -> Result<PathBuf, String> {
    let dir = script_runs_root(app)?.join(job_id);
    // Start clean (a resumed job reuses the same id).
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dir.join("tmp")).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// A file we placed in the workspace before the run: its name and content hash,
/// so import-back can tell an untouched input from one modified in place.
pub(crate) struct Materialized {
    name: String,
    sha: String,
}

/// Write each declared input's bytes into the workspace under its real room name
/// (`find_file_like` — newest match wins, same as the agent's tools). A declared
/// input that has no match in the room is skipped (its absence is honest).
fn materialize_inputs(
    conn: &Connection,
    ws: &Path,
    inputs: &[String],
) -> Result<Vec<Materialized>, String> {
    let mut out = Vec::new();
    for want in inputs {
        let Ok((id, real_name)) = db::find_file_like(conn, want) else {
            continue;
        };
        let Some(bytes) = db::get_file_bytes(conn, &id)? else {
            continue;
        };
        let safe = safe_name(&real_name);
        std::fs::write(ws.join(&safe), &bytes).map_err(|e| e.to_string())?;
        out.push(Materialized {
            name: safe,
            sha: script_fingerprint(&bytes),
        });
    }
    Ok(out)
}

/// Room-file names that appear VERBATIM (exact-name substring) in the script
/// text, in the room's listing order, capped at `cap`. Pure — no I/O, and no
/// dedup against declared inputs (the caller handles that). Empty names never
/// match. This lets `pd.read_csv('ETF Tracker — AI Full Stack.csv')` find its
/// file even when the script declared no `# room-inputs:`.
pub(crate) fn referenced_room_files(text: &str, room_files: &[String], cap: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for name in room_files {
        if name.is_empty() || out.iter().any(|n| n == name) {
            continue;
        }
        if text.contains(name.as_str()) {
            out.push(name.clone());
            if out.len() >= cap {
                break;
            }
        }
    }
    out
}

/// Materialize specific room files by their EXACT name into the workspace,
/// skipping any whose `safe_name` collides with a file already materialized (a
/// declared input). Used for the auto-materialized name-referenced files, which
/// we resolve precisely (`file_by_exact_name`) rather than fuzzily. Records each
/// as `Materialized` so import-back knows it was "used" and can save it if the
/// script modified it in place.
fn materialize_named(
    conn: &Connection,
    ws: &Path,
    names: &[String],
    already: &HashSet<String>,
) -> Result<Vec<Materialized>, String> {
    let mut out: Vec<Materialized> = Vec::new();
    for name in names {
        let safe = safe_name(name);
        if already.contains(&safe) || out.iter().any(|m| m.name == safe) {
            continue;
        }
        let Some(meta) = db::file_by_exact_name(conn, name)? else {
            continue;
        };
        let Some(bytes) = db::get_file_bytes(conn, &meta.id)? else {
            continue;
        };
        std::fs::write(ws.join(&safe), &bytes).map_err(|e| e.to_string())?;
        out.push(Materialized {
            name: safe,
            sha: script_fingerprint(&bytes),
        });
    }
    Ok(out)
}

/// Keep a file name to its basename so a room name can never escape the
/// workspace (defence in depth — room names are user-controlled).
fn safe_name(name: &str) -> String {
    Path::new(name)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty() && s != "." && s != "..")
        .unwrap_or_else(|| "file".into())
}

// ---------------------------------------------------------------- execution

/// One process run's raw result.
#[derive(Debug)]
pub struct ExecOut {
    pub exit_code: i32,
    pub stdout_tail: String,
    pub stderr_tail: String,
}

/// Spawn the script in its process group and drive it to completion, honoring
/// cancel + timeout via SIGTERM→SIGKILL of the whole group (so `uv`'s python
/// child dies with it). App-free so it is directly unit-testable.
pub async fn execute_script_in_workspace(
    ws: &Path,
    runner: &Runner,
    script_name: &str,
    timeout_secs: u64,
    cancel: &Arc<AtomicBool>,
) -> Result<ExecOut, String> {
    let mut cmd = Command::new(&runner.program);
    cmd.args(&runner.argv_prefix)
        .arg(script_name)
        .current_dir(ws)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Minimal env — NEVER the room path or key. A workspace-local TMPDIR
        // keeps any scratch the script writes inside the sweepable folder.
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin")
        .env("HOME", home())
        .env("TMPDIR", ws.join("tmp"))
        // Its own process group so `kill -- -<pgid>` reaches uv's python child.
        .process_group(0);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start the script: {e}"))?;
    let pgid = child.id();

    // Drain stdout/stderr on blocking threads into 32 KB ring tails (the
    // sidecar_lifecycle BufReader-on-a-thread pattern).
    let out_buf = Arc::new(Mutex::new(Vec::<u8>::new()));
    let err_buf = Arc::new(Mutex::new(Vec::<u8>::new()));
    if let Some(o) = child.stdout.take() {
        spawn_ring_reader(o, out_buf.clone());
    }
    if let Some(e) = child.stderr.take() {
        spawn_ring_reader(e, err_buf.clone());
    }

    let start = Instant::now();
    let timeout = Duration::from_secs(timeout_secs);
    let status = loop {
        if let Some(st) = child.try_wait().map_err(|e| e.to_string())? {
            break st;
        }
        if cancel.load(Ordering::SeqCst) {
            terminate_group(&mut child, pgid).await;
            return Err("STOPPED".into());
        }
        if start.elapsed() > timeout {
            terminate_group(&mut child, pgid).await;
            return Err(format!("This script timed out after {timeout_secs}s."));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    };

    // Give the reader threads a beat to flush the final chunk.
    tokio::time::sleep(Duration::from_millis(30)).await;
    let stdout_tail = tail_string(&out_buf);
    let stderr_tail = tail_string(&err_buf);
    Ok(ExecOut {
        exit_code: status.code().unwrap_or(-1),
        stdout_tail,
        stderr_tail,
    })
}

/// SIGTERM the group, wait a grace period, then SIGKILL and reap — the
/// ollama_lifecycle `Command::new("kill")` house pattern, applied to the group.
async fn terminate_group(child: &mut std::process::Child, pgid: u32) {
    kill_group(pgid, "-TERM");
    let deadline = Instant::now() + KILL_GRACE;
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    kill_group(pgid, "-KILL");
    let _ = child.wait();
}

fn kill_group(pgid: u32, signal: &str) {
    // `kill -SIG -- -<pgid>` signals the whole process group.
    let _ = Command::new("kill")
        .arg(signal)
        .arg("--")
        .arg(format!("-{pgid}"))
        .status();
}

fn spawn_ring_reader<Rd: Read + Send + 'static>(mut rd: Rd, buf: Arc<Mutex<Vec<u8>>>) {
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match rd.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut b) = buf.lock() {
                        b.extend_from_slice(&chunk[..n]);
                        if b.len() > RING_BYTES {
                            let drop = b.len() - RING_BYTES;
                            b.drain(0..drop);
                        }
                    }
                }
            }
        }
    });
}

fn tail_string(buf: &Arc<Mutex<Vec<u8>>>) -> String {
    buf.lock()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default()
}

// ---------------------------------------------------------------- import-back

/// Whether a materialized file (a declared input OR one auto-materialized because
/// the script referenced its name) should be saved back: its bytes CHANGED during
/// the run (`current_sha` differs from the hash at materialization) AND it was not
/// a declared output (declared outputs already write back via the output path).
/// Pure — the caller reads the file and hashes it.
pub(crate) fn is_modified_used_file(
    original_sha: &str,
    current_sha: &str,
    name: &str,
    declared_outputs: &[String],
) -> bool {
    current_sha != original_sha
        && !declared_outputs.iter().any(|o| safe_name(o) == safe_name(name))
}

/// Import the script's outputs back into the room after a clean exit
/// (decision 2). Returns the imported files (for the report + terminal auto-open)
/// and a list of human-readable skip notes. All writes are versioned via
/// `store_file_bytes`, so every script run is undoable through Time Machine.
pub fn import_outputs(
    conn: &Connection,
    ws: &Path,
    manifest: &ScriptManifest,
    materialized: &[Materialized],
    script_name: &str,
    cause: &str,
) -> Result<(Vec<FileMeta>, Vec<String>), String> {
    let mut imported: Vec<FileMeta> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    // Names already accounted for: the materialized inputs + the script itself.
    let mut handled: HashSet<String> = materialized.iter().map(|m| m.name.clone()).collect();
    handled.insert(safe_name(script_name));

    // 1. Declared outputs: an existing room file → versioned overwrite; a new
    //    name → insert (source='script').
    for want in &manifest.outputs {
        let safe = safe_name(want);
        let path = ws.join(&safe);
        handled.insert(safe.clone());
        if !path.is_file() {
            skipped.push(format!("{want}: the script did not write this declared output"));
            continue;
        }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_IMPORT_BYTES {
            skipped.push(format!("{want}: over the {}MB import cap", MAX_IMPORT_BYTES / 1024 / 1024));
            continue;
        }
        let meta = write_output(conn, want, &bytes, cause)?;
        imported.push(meta);
    }

    // 2. Any NEW file the script created (present after exit, not materialized,
    //    not a declared output) — additive, capped (20 files / 64 MB).
    let mut new_bytes: u64 = 0;
    if let Ok(entries) = std::fs::read_dir(ws) {
        // Deterministic order so the cap drops the same files across runs.
        let mut names: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_file())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        for name in names {
            if handled.contains(&name) {
                continue;
            }
            handled.insert(name.clone());
            let path = ws.join(&name);
            let len = path.metadata().map(|m| m.len()).unwrap_or(0);
            if imported.len() >= MAX_NEW_FILES || new_bytes + len > MAX_IMPORT_BYTES {
                skipped.push(format!("{name}: skipped (new-file import cap reached)"));
                continue;
            }
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            new_bytes += bytes.len() as u64;
            let meta = write_output(conn, &name, &bytes, cause)?;
            imported.push(meta);
        }
    }

    // 3. A materialized file (a declared input OR one auto-materialized because
    //    the script referenced its name) that the script MODIFIED IN PLACE but did
    //    not declare as an output. This intentionally RELAXES the old rule ("a
    //    modified undeclared input is never written back") so a read→modify→write
    //    "sync" script just works without the user declaring room-outputs. It is
    //    safe because: the script demonstrably READ the file (we materialized it
    //    only because it was declared or its name appears in the script), running
    //    it at all required consent, and every write is versioned via
    //    `store_file_bytes` → fully undoable through Time Machine.
    for m in materialized {
        let path = ws.join(&m.name);
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let current = script_fingerprint(&bytes);
        if !is_modified_used_file(&m.sha, &current, &m.name, &manifest.outputs) {
            continue;
        }
        if bytes.len() as u64 > MAX_IMPORT_BYTES {
            skipped.push(format!(
                "{}: over the {}MB import cap — not saved back",
                m.name,
                MAX_IMPORT_BYTES / 1024 / 1024
            ));
            continue;
        }
        let meta = write_output(conn, &m.name, &bytes, cause)?;
        imported.push(meta);
        // Surfaced in the report's notes so the user sees it was an in-place
        // overwrite (a new version they can undo), not a brand-new file.
        skipped.push(format!(
            "{}: updated in place by the script — saved back as a new version (undo via Time Machine)",
            m.name
        ));
    }

    Ok((imported, skipped))
}

/// Write one output into the room: a versioned overwrite when the name already
/// exists (undo via Time Machine), else a new `source='script'` file.
fn write_output(
    conn: &Connection,
    name: &str,
    bytes: &[u8],
    cause: &str,
) -> Result<FileMeta, String> {
    let display = safe_name(name);
    let text = extraction::extract_text(&display, bytes);
    if let Some(existing) = db::file_by_exact_name(conn, &display)? {
        // Snapshot-then-overwrite: every script run is undoable for free.
        store_file_bytes(conn, &existing.id, bytes, text.as_deref(), cause)?;
        db::get_file_meta(conn, &existing.id)
    } else {
        let mime = mime_guess::from_path(&display)
            .first_or(mime_guess::mime::TEXT_PLAIN)
            .essence_str()
            .to_string();
        db::insert_file(conn, &display, &mime, bytes, text.as_deref(), "script")
    }
}

// ---------------------------------------------------------------- runner core

/// One run's report — surfaced as the workflow step artifact (JSON) and drives
/// the terminal auto-open (first imported output, MANUAL runs only). Serialize-
/// only: `FileMeta` (in `imported`) is a Serialize-only view, and the artifact is
/// read back as raw JSON, never deserialized into this struct.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptRunReport {
    pub exit_code: i32,
    pub imported: Vec<FileMeta>,
    pub skipped: Vec<String>,
    pub stdout_tail: String,
    pub stderr_tail: String,
}

/// The full runner phase for one `script_run` node (decisions 1/5/6). Generic
/// over the runtime like `execute_pass_step`, so it compiles under `MockRuntime`
/// (it uses only `app.state::<AppState>()` + std/tokio process). Every DB touch
/// is under the room lock filtered by `room_path` (the execute_pass_step pin).
///
/// `consented_sha256` is the hash approved when this run was enqueued (the
/// immutable snapshot). If the script's CURRENT bytes don't match, the run
/// PARKS — a mid-run edit never silently runs new code.
pub(crate) async fn run_script_process<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    job_id: &str,
    room_path: &str,
    script_file_id: &str,
    consented_sha256: &str,
    cancel: &Arc<AtomicBool>,
) -> Result<ScriptRunReport, String> {
    use tauri::{Emitter, Manager};

    // (a) Read the script bytes + name under the lock; verify the consent hash.
    let (script_name, script_bytes) = {
        let state = app.state::<AppState>();
        let guard = state.room.lock().unwrap();
        let room = guard
            .as_ref()
            .filter(|r| r.path == room_path)
            .ok_or("The room this script belongs to is no longer open.")?;
        let (name, bytes) = db::get_file_bytes_named(&room.conn, script_file_id)?;
        (name, bytes.unwrap_or_default())
    };
    let current_sha = script_fingerprint(&script_bytes);
    if current_sha != consented_sha256 {
        // Aligns with the approval-gates policy: park, never silently run new code.
        return Err("Script changed since it was approved — review it on the Scripts page.".into());
    }

    // (b) Parse the manifest + resolve the interpreter.
    let text = String::from_utf8_lossy(&script_bytes).into_owned();
    let manifest = parse_script_manifest(&script_name, &text);
    let runner = resolve_interpreter(&manifest)?;

    // (c) Workspace + materialize inputs (record hashes for modified detection).
    let ws = make_workspace(app, job_id)?;
    let safe_script = safe_name(&script_name);
    let materialized = {
        let state = app.state::<AppState>();
        let guard = state.room.lock().unwrap();
        let room = guard
            .as_ref()
            .filter(|r| r.path == room_path)
            .ok_or("The room this script belongs to is no longer open.")?;
        // Write the script itself so `<runtime> <script>` can run it.
        std::fs::write(ws.join(&safe_script), &script_bytes).map_err(|e| e.to_string())?;
        let mut mats = materialize_inputs(&room.conn, &ws, &manifest.inputs)?;
        // Auto-materialize any room file whose exact name appears in the script
        // text (e.g. `read_csv('ETF Tracker — AI Full Stack.csv')`), even if it
        // was never declared as a room-input — so scripts "just work". Read-only
        // copy; capped so a huge room can't balloon the workspace. Deduped
        // against the declared inputs already written above; recorded as
        // Materialized so the write-back phase knows these were used.
        let room_names: Vec<String> = db::list_files(&room.conn)?
            .into_iter()
            .map(|f| f.name)
            .collect();
        let referenced = referenced_room_files(&text, &room_names, MAX_AUTO_MATERIALIZE);
        let already: HashSet<String> = mats
            .iter()
            .map(|m| m.name.clone())
            .chain(std::iter::once(safe_script.clone()))
            .collect();
        let extra = materialize_named(&room.conn, &ws, &referenced, &already)?;
        mats.extend(extra);
        mats
    };

    // (d/e/f) Spawn + watch + drain. `finally` removes the workspace on EVERY
    // outcome (decision 1) — done here around the fallible tail.
    let result = run_and_import(
        app,
        room_path,
        &ws,
        &runner,
        &safe_script,
        &manifest,
        &materialized,
        &script_name,
        cancel,
    )
    .await;
    let _ = std::fs::remove_dir_all(&ws);
    let report = result?;

    // room-files-changed after import (the publish-arm precedent).
    if !report.imported.is_empty() {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.emit("room-files-changed", ());
        }
    }
    Ok(report)
}

/// The spawn + import-back tail, split out so `run_script_process` can delete the
/// workspace on every path (Ok, Err, timeout, cancel) around it.
#[allow(clippy::too_many_arguments)]
async fn run_and_import<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    room_path: &str,
    ws: &Path,
    runner: &Runner,
    safe_script: &str,
    manifest: &ScriptManifest,
    materialized: &[Materialized],
    script_name: &str,
    cancel: &Arc<AtomicBool>,
) -> Result<ScriptRunReport, String> {
    use tauri::Manager;
    // uv is detected by its `run` argv prefix; only it can install on the fly.
    let is_uv = runner.argv_prefix.first().map(|s| s == "run").unwrap_or(false);
    let mut out = execute_script_in_workspace(ws, runner, safe_script, manifest.timeout_secs, cancel).await?;

    // Auto-heal: if the script imports a package it never declared, install it and
    // retry — the user should never have to pip install or declare anything for a
    // script to run. Bounded, uv-only, and stops the moment adding a module fails
    // to clear it (its PyPI package name differs from the import name, e.g.
    // PIL→Pillow), which then falls through to the actionable message below.
    let mut healed: Vec<String> = Vec::new();
    if is_uv {
        for _ in 0..MAX_HEAL_ROUNDS {
            if out.exit_code == 0 || cancel.load(Ordering::SeqCst) {
                break;
            }
            let Some(missing) = missing_module(&out.stderr_tail) else { break };
            if healed.contains(&missing) {
                break; // we added it last round and it's still missing → can't heal
            }
            healed.push(missing);
            let mut argv = runner.argv_prefix.clone();
            for pkg in &healed {
                argv.push("--with".into());
                argv.push(pkg.clone());
            }
            let healed_runner = Runner {
                program: runner.program.clone(),
                argv_prefix: argv,
            };
            out = execute_script_in_workspace(ws, &healed_runner, safe_script, manifest.timeout_secs, cancel).await?;
        }
    }

    if out.exit_code != 0 {
        // Nonzero exit → surface the stderr tail as the parking error.
        let tail = out.stderr_tail.trim();
        let mut msg = if tail.is_empty() {
            format!("The script exited with code {}.", out.exit_code)
        } else {
            format!("The script failed (exit {}):\n{}", out.exit_code, tail)
        };
        let stuck = healed.last().filter(|s| out.stderr_tail.contains(s.as_str()));
        if let Some(pkg) = stuck {
            // Auto-install tried but couldn't resolve this one: its PyPI package
            // name differs from the import name. Name it so it can be declared.
            msg.push_str(&format!(
                "\n\nCouldn't auto-install '{pkg}' — its package name on PyPI probably \
                 differs from the import name (e.g. PIL → Pillow, cv2 → opencv-python). \
                 Declare it explicitly in a dependencies line, or ask the assistant to."
            ));
        } else if tail.contains("ModuleNotFoundError")
            || tail.contains("No module named")
            || tail.contains("Cannot find module")
        {
            // A missing package auto-heal didn't engage on (JS, or an odd trace).
            // Point at declaring deps rather than leaving a raw traceback.
            msg.push_str(
                "\n\nThis script imports a package that isn't installed. Declare it in a \
                 dependencies line near the top and it installs automatically on the next \
                 run — no manual pip. For example:\n    \
                 # dependencies = [\"pandas\", \"yfinance\"]\nOr ask the assistant to declare \
                 the script's dependencies.",
            );
        }
        return Err(msg);
    }
    // (g) exit 0 → import back under the room lock, room-pinned.
    let cause = format!("Script ran — {script_name}");
    let (imported, skipped) = {
        let state = app.state::<AppState>();
        let guard = state.room.lock().unwrap();
        let room = guard
            .as_ref()
            .filter(|r| r.path == room_path)
            .ok_or("The room this script belongs to is no longer open.")?;
        import_outputs(&room.conn, ws, manifest, materialized, script_name, &cause)?
    };
    Ok(ScriptRunReport {
        exit_code: out.exit_code,
        imported,
        skipped,
        stdout_tail: out.stdout_tail,
        stderr_tail: out.stderr_tail,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_module_extracts_top_level_package() {
        assert_eq!(
            missing_module("Traceback...\nModuleNotFoundError: No module named 'pandas'"),
            Some("pandas".into())
        );
        // Sub-module error → the installable top-level package.
        assert_eq!(
            missing_module("No module named 'yfinance.utils'"),
            Some("yfinance".into())
        );
        // No such error → nothing to heal.
        assert_eq!(missing_module("ValueError: bad input"), None);
        // Reject anything that isn't a plain package token.
        assert_eq!(missing_module("No module named '../evil'"), None);
    }

    #[test]
    fn uv_runner_installs_declared_deps_with_explicit_with_flags() {
        // Declared deps must reach uv as `--with <pkg>` so a bare dependencies
        // line installs them even without a full PEP-723 fence. Only meaningful
        // when uv is actually resolvable on this machine.
        if uv_bin().is_none() {
            return;
        }
        let m = parse_script_manifest(
            "sync.py",
            "# dependencies = [\"pandas\", \"yfinance\"]\nimport pandas\n",
        );
        assert_eq!(m.deps, vec!["pandas", "yfinance"]);
        let r = resolve_interpreter(&m).expect("uv present → resolves");
        assert!(r.argv_prefix.starts_with(&["run".to_string(), "--no-project".to_string()]));
        // Each dep appears as a `--with <dep>` pair.
        for dep in ["pandas", "yfinance"] {
            let at = r.argv_prefix.iter().position(|a| a == dep);
            assert!(at.is_some_and(|i| i > 0 && r.argv_prefix[i - 1] == "--with"),
                "expected `--with {dep}` in {:?}", r.argv_prefix);
        }
    }

    #[test]
    fn parses_pep723_deps_and_room_keys() {
        let src = "# /// script\n\
                   # dependencies = [\"yfinance\", \"pandas\"]\n\
                   # ///\n\
                   # room-inputs: portfolio.csv, holdings.xlsx\n\
                   # room-outputs: portfolio.csv\n\
                   # room-timeout: 300\n\
                   # room-shortcut: global\n\
                   import sys\n";
        let m = parse_script_manifest("update.py", &src);
        assert_eq!(m.interpreter, ScriptLang::Py);
        assert_eq!(m.deps, vec!["yfinance", "pandas"]);
        assert_eq!(m.inputs, vec!["portfolio.csv", "holdings.xlsx"]);
        assert_eq!(m.outputs, vec!["portfolio.csv"]);
        assert_eq!(m.timeout_secs, 300);
        assert_eq!(m.shortcut, Shortcut::Global);
        assert!(m.has_deps());
    }

    #[test]
    fn js_uses_slash_prefix_and_no_deps_default_shortcut() {
        // `//` prefix for JS; no room-shortcut but has I/O → default File.
        let src = "// room-inputs: data.json\n// room-outputs: out.json\nconsole.log(1)\n";
        let m = parse_script_manifest("tool.js", src);
        assert_eq!(m.interpreter, ScriptLang::Js);
        assert!(m.deps.is_empty());
        assert_eq!(m.inputs, vec!["data.json"]);
        assert_eq!(m.shortcut, Shortcut::File);
        // A `#`-prefixed line is NOT a JS comment → ignored.
        let m2 = parse_script_manifest("tool.js", "# room-inputs: ignored.txt\n");
        assert!(m2.inputs.is_empty());
    }

    #[test]
    fn missing_block_is_self_contained_and_shortcut_none() {
        let m = parse_script_manifest("hello.py", "print('hi')\n");
        assert!(!m.has_deps());
        assert!(m.inputs.is_empty() && m.outputs.is_empty());
        assert_eq!(m.timeout_secs, DEFAULT_TIMEOUT_SECS);
        assert_eq!(m.shortcut, Shortcut::None);
    }

    #[test]
    fn timeout_is_clamped_and_first_occurrence_wins() {
        assert_eq!(parse_script_manifest("a.py", "# room-timeout: 1\n").timeout_secs, MIN_TIMEOUT_SECS);
        assert_eq!(parse_script_manifest("a.py", "# room-timeout: 99999\n").timeout_secs, MAX_TIMEOUT_SECS);
        // First occurrence of a key wins.
        let m = parse_script_manifest("a.py", "# room-inputs: first.csv\n# room-inputs: second.csv\n");
        assert_eq!(m.inputs, vec!["first.csv"]);
    }

    #[test]
    fn manifest_only_scans_first_64_lines() {
        let mut src = String::new();
        for _ in 0..70 {
            src.push_str("x = 1\n");
        }
        src.push_str("# room-inputs: late.csv\n");
        assert!(parse_script_manifest("a.py", &src).inputs.is_empty());
    }

    #[test]
    fn keys_are_case_insensitive() {
        let m = parse_script_manifest("a.py", "# Room-Inputs: A.csv\n# ROOM-SHORTCUT: none\n");
        assert_eq!(m.inputs, vec!["A.csv"]);
        assert_eq!(m.shortcut, Shortcut::None);
    }

    #[test]
    fn fingerprint_is_stable_and_content_sensitive() {
        // Mirrors mcp_fingerprint's contract, over bytes.
        let a = b"print('a')";
        assert_eq!(script_fingerprint(a), script_fingerprint(a));
        assert_ne!(script_fingerprint(a), script_fingerprint(b"print('b')"));
        assert_eq!(script_fingerprint(a).len(), 64);
    }

    #[test]
    fn interpreter_policy_matrix() {
        use RunnerChoice::*;
        // Python: uv wins whenever present (deps or not).
        assert_eq!(interpreter_policy(true, true, false, ScriptLang::Py, true), Ok(Uv));
        assert_eq!(interpreter_policy(true, false, false, ScriptLang::Py, false), Ok(Uv));
        // No uv, no deps → python3.
        assert_eq!(interpreter_policy(false, true, false, ScriptLang::Py, false), Ok(Python3));
        // No uv, has deps → actionable error mentioning uv.
        let e = interpreter_policy(false, true, false, ScriptLang::Py, true).unwrap_err();
        assert!(e.contains("uv"), "{e}");
        // No uv, no python3, no deps → error.
        assert!(interpreter_policy(false, false, false, ScriptLang::Py, false).is_err());
        // JS: dependency-free + node → node.
        assert_eq!(interpreter_policy(false, false, true, ScriptLang::Js, false), Ok(Node));
        // JS with deps → unsupported error.
        assert!(interpreter_policy(false, false, true, ScriptLang::Js, true).is_err());
        // JS no node → install-node error.
        assert!(interpreter_policy(false, false, false, ScriptLang::Js, false).is_err());
    }

    // ---- import-back rules on db::mem() with a temp workspace ----

    fn tmp_ws() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pr-script-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn manifest_out(outputs: &[&str]) -> ScriptManifest {
        ScriptManifest {
            interpreter: ScriptLang::Py,
            deps: vec![],
            inputs: vec![],
            outputs: outputs.iter().map(|s| s.to_string()).collect(),
            timeout_secs: 600,
            shortcut: Shortcut::None,
        }
    }

    // ---- pure helpers: the referenced-file scan + modified-file detection ----

    #[test]
    fn referenced_room_files_matches_exact_names_and_caps() {
        // Test (a): given a script's text and the room's file names, return the
        // ones the script actually references by exact name.
        let text = "import pandas as pd\n\
                    df = pd.read_csv('ETF Tracker — AI Full Stack.csv')\n\
                    notes = open('meeting notes.md').read()\n\
                    df.to_csv('ETF Tracker — AI Full Stack.csv')\n";
        let room = vec![
            "ETF Tracker — AI Full Stack.csv".to_string(),
            "meeting notes.md".to_string(),
            "unrelated.pdf".to_string(),
        ];
        let hit = referenced_room_files(text, &room, 20);
        assert!(hit.contains(&"ETF Tracker — AI Full Stack.csv".to_string()));
        assert!(hit.contains(&"meeting notes.md".to_string()));
        assert!(
            !hit.contains(&"unrelated.pdf".to_string()),
            "a file whose name never appears in the script is not materialized"
        );
        // A name used several times is returned once.
        assert_eq!(
            hit.iter().filter(|n| n.as_str() == "ETF Tracker — AI Full Stack.csv").count(),
            1
        );
        // Empty room names never match.
        assert!(referenced_room_files("a b c", &["".to_string()], 20).is_empty());
        // The cap bounds how many are auto-materialized.
        let many: Vec<String> = (0..30).map(|i| format!("f{i}.csv")).collect();
        let uses = many.join(" ");
        assert_eq!(referenced_room_files(&uses, &many, 5).len(), 5, "capped at 5");
    }

    #[test]
    fn is_modified_used_file_selects_changed_undeclared_files() {
        // Test (b): a materialized file whose hash changed (and that isn't a
        // declared output) is selected for save-back.
        let orig = script_fingerprint(b"orig");
        let changed = script_fingerprint(b"changed");
        assert!(is_modified_used_file(&orig, &changed, "in.csv", &[]), "changed → save back");
        assert!(!is_modified_used_file(&orig, &orig, "in.csv", &[]), "unchanged → leave it");
        // Changed but ALSO declared as an output → the declared-output path owns it.
        assert!(!is_modified_used_file(&orig, &changed, "in.csv", &["in.csv".to_string()]));
    }

    #[test]
    fn declared_existing_output_is_a_versioned_overwrite() {
        let conn = db::mem();
        let existing = db::insert_file(&conn, "report.csv", "text/csv", b"old", Some("old"), "upload").unwrap();
        let ws = tmp_ws();
        std::fs::write(ws.join("report.csv"), b"new,data\n1,2\n").unwrap();
        let (imported, skipped) =
            import_outputs(&conn, &ws, &manifest_out(&["report.csv"]), &[], "s.py", "Script ran — s.py").unwrap();
        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].id, existing.id, "overwrote the same file id");
        assert!(skipped.is_empty());
        // A snapshot exists → the overwrite is undoable via Time Machine.
        let versions = db::list_file_versions(&conn, &existing.id).unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].cause, "Script ran — s.py");
        // The current bytes are the new content.
        assert_eq!(db::get_file_bytes(&conn, &existing.id).unwrap().unwrap(), b"new,data\n1,2\n");
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn declared_new_and_undeclared_new_insert_as_source_script() {
        let conn = db::mem();
        let ws = tmp_ws();
        // A declared-new output and a NEW file the script created (auto-import).
        std::fs::write(ws.join("prices-2026.csv"), b"a,b\n").unwrap();
        std::fs::write(ws.join("extra.txt"), b"note").unwrap();
        let (imported, skipped) =
            import_outputs(&conn, &ws, &manifest_out(&["prices-2026.csv"]), &[], "s.py", "c").unwrap();
        assert_eq!(imported.len(), 2, "declared-new + undeclared-new both imported");
        assert!(skipped.is_empty());
        // Both landed with source='script'.
        let files = db::list_files(&conn).unwrap();
        assert!(files.iter().all(|f| f.source == "script"));
        assert!(files.iter().any(|f| f.name == "prices-2026.csv"));
        assert!(files.iter().any(|f| f.name == "extra.txt"));
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn modified_used_input_is_saved_back_versioned() {
        // The old "a modified undeclared input is never written back" rule is
        // intentionally RELAXED: a materialized file the script changes in place is
        // now saved back as a NEW VERSION even without a room-outputs declaration —
        // the script demonstrably read it, running required consent, and the write
        // is undoable via Time Machine. This is the write side of test (b).
        let conn = db::mem();
        let input =
            db::insert_file(&conn, "in.csv", "text/csv", b"orig", Some("orig"), "upload").unwrap();
        let ws = tmp_ws();
        // The script modified the input in place but did NOT declare it as output.
        std::fs::write(ws.join("in.csv"), b"updated").unwrap();
        let materialized = vec![Materialized { name: "in.csv".into(), sha: script_fingerprint(b"orig") }];
        let (imported, skipped) =
            import_outputs(&conn, &ws, &manifest_out(&[]), &materialized, "s.py", "Script ran — s.py").unwrap();
        // Saved back onto the SAME file id (a versioned overwrite, not a new file).
        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].id, input.id, "overwrote the same file id");
        assert_eq!(db::get_file_bytes(&conn, &input.id).unwrap().unwrap(), b"updated");
        // A snapshot of the pre-run bytes exists → the change is undoable.
        let versions = db::list_file_versions(&conn, &input.id).unwrap();
        assert_eq!(versions.len(), 1);
        // The report notes it was an in-place overwrite.
        assert!(
            skipped.iter().any(|s| s.contains("in.csv") && s.contains("updated in place")),
            "the overwrite is noted: {skipped:?}"
        );
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn untouched_materialized_input_is_not_re_imported() {
        // A materialized file the script did NOT modify stays out of the room —
        // no needless new version.
        let conn = db::mem();
        let input =
            db::insert_file(&conn, "keep.csv", "text/csv", b"same", Some("same"), "upload").unwrap();
        let ws = tmp_ws();
        std::fs::write(ws.join("keep.csv"), b"same").unwrap();
        let materialized = vec![Materialized { name: "keep.csv".into(), sha: script_fingerprint(b"same") }];
        let (imported, skipped) =
            import_outputs(&conn, &ws, &manifest_out(&[]), &materialized, "s.py", "c").unwrap();
        assert!(imported.is_empty(), "an unchanged input is not re-imported");
        assert!(skipped.is_empty(), "nothing to note: {skipped:?}");
        assert!(
            db::list_file_versions(&conn, &input.id).unwrap().is_empty(),
            "no snapshot for an untouched file"
        );
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn new_file_import_is_capped() {
        let conn = db::mem();
        let ws = tmp_ws();
        for i in 0..(MAX_NEW_FILES + 5) {
            std::fs::write(ws.join(format!("f{i:03}.txt")), b"x").unwrap();
        }
        let (imported, skipped) = import_outputs(&conn, &ws, &manifest_out(&[]), &[], "s.py", "c").unwrap();
        assert_eq!(imported.len(), MAX_NEW_FILES, "capped at {MAX_NEW_FILES} new files");
        assert_eq!(skipped.len(), 5, "the overflow is named in the log");
        let _ = std::fs::remove_dir_all(&ws);
    }

    // ---- process integration: real subprocess (/bin/sh is always present) ----

    #[tokio::test]
    async fn cancel_kills_the_whole_process_group() {
        // A sleeping shell script; flipping cancel must tear down the group.
        let ws = tmp_ws();
        std::fs::write(ws.join("sleep.sh"), b"#!/bin/sh\nsleep 30\n").unwrap();
        let runner = Runner { program: "/bin/sh".into(), argv_prefix: vec![] };
        let cancel = Arc::new(AtomicBool::new(false));
        let c2 = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            c2.store(true, Ordering::SeqCst);
        });
        let start = Instant::now();
        let res = execute_script_in_workspace(&ws, &runner, "sleep.sh", 60, &cancel).await;
        assert_eq!(res.unwrap_err(), "STOPPED");
        assert!(start.elapsed() < Duration::from_secs(20), "cancel returned promptly, not after the 30s sleep");
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn timeout_returns_the_timeout_message() {
        let ws = tmp_ws();
        std::fs::write(ws.join("sleep.sh"), b"#!/bin/sh\nsleep 30\n").unwrap();
        let runner = Runner { program: "/bin/sh".into(), argv_prefix: vec![] };
        let cancel = Arc::new(AtomicBool::new(false));
        let res = execute_script_in_workspace(&ws, &runner, "sleep.sh", MIN_TIMEOUT_SECS, &cancel).await;
        assert!(res.unwrap_err().contains("timed out"));
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn nonzero_exit_surfaces_stderr_tail() {
        let ws = tmp_ws();
        std::fs::write(ws.join("fail.sh"), b"#!/bin/sh\necho boom 1>&2\nexit 3\n").unwrap();
        let runner = Runner { program: "/bin/sh".into(), argv_prefix: vec![] };
        let cancel = Arc::new(AtomicBool::new(false));
        let out = execute_script_in_workspace(&ws, &runner, "fail.sh", 30, &cancel).await.unwrap();
        assert_eq!(out.exit_code, 3);
        assert!(out.stderr_tail.contains("boom"));
        let _ = std::fs::remove_dir_all(&ws);
    }

    // ---- required real end-to-end: a dep-free python script through the runner
    //      core, output imported back. Gated behind `which python3`. ----

    #[tokio::test]
    async fn e2e_python_script_imports_output_back() {
        let Some(py) = python3_bin() else {
            eprintln!("skipping e2e: python3 not found on PATH");
            return;
        };
        let conn = db::mem();
        let ws = tmp_ws();
        // A trivial dependency-free script that reads a.txt and writes b.csv.
        std::fs::write(
            ws.join("gen.py"),
            b"open('b.csv','w').write('col\\n' + open('a.txt').read().strip() + '\\n')\n",
        )
        .unwrap();
        std::fs::write(ws.join("a.txt"), b"hello").unwrap();
        let materialized = vec![Materialized { name: "a.txt".into(), sha: script_fingerprint(b"hello") }];
        let runner = Runner { program: py, argv_prefix: vec![] };
        let cancel = Arc::new(AtomicBool::new(false));
        let out = execute_script_in_workspace(&ws, &runner, "gen.py", 60, &cancel).await.unwrap();
        assert_eq!(out.exit_code, 0, "stderr: {}", out.stderr_tail);
        let manifest = manifest_out(&["b.csv"]);
        let (imported, _skipped) =
            import_outputs(&conn, &ws, &manifest, &materialized, "gen.py", "Script ran — gen.py").unwrap();
        assert_eq!(imported.len(), 1, "b.csv was imported back into the room");
        assert_eq!(imported[0].name, "b.csv");
        let bytes = db::get_file_bytes(&conn, &imported[0].id).unwrap().unwrap();
        assert_eq!(String::from_utf8_lossy(&bytes), "col\nhello\n");
        let _ = std::fs::remove_dir_all(&ws);
    }
}
