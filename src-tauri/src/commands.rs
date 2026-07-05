use crate::{db, extraction, mcp, ocr, ollama, stt, web};
use base64::Engine;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::State;
use uuid::Uuid;

const DEFAULT_MODEL: &str = "qwen3.5:4b";
const MAX_CONTEXT_CHUNKS: usize = 6;
/// CHG-13: retrieval blends the keyword and vector signals with Reciprocal Rank
/// Fusion (scale-free), so no per-signal weight constants are needed.
/// ADD-13: widen the per-signal candidate pool before blending, so a strong
/// vector-only (synonym) chunk can surface above weak keyword hits.
const RETRIEVE_CANDIDATES: usize = MAX_CONTEXT_CHUNKS * 4;
const MAX_IMPORT_BYTES: u64 = 200 * 1024 * 1024;
const MAX_ATTACHED_IMAGES: usize = 4;
/// Shared character budget for all text attachments in one question — a
/// first-come cap so N attached files can never blow the 8K window.
const MAX_ATTACHED_TEXT_TOTAL: usize = 12_000;
const MAX_HISTORY_MESSAGES: usize = 12;
/// Whole-conversation history budget (chars), applied newest-first so recent
/// turns survive and ancient ones drop wholesale instead of each being cut.
const MAX_HISTORY_CHARS: usize = 12_000;
/// Injected persistent-memory budget (chars) and per-memory write cap.
const MAX_MEMORY_INJECT_CHARS: usize = 1_500;
const MAX_MEMORY_CONTENT_CHARS: usize = 500;
/// External tool results (web pages, search results) can be huge; clamp
/// them so a few rounds still fit the context window.
const MAX_TOOL_RESULT_CHARS: usize = 4000;
/// Cumulative context budget for the agent loop (chars): ~9K tokens of the
/// 12,288-token num_ctx, leaving room for the tool catalog and generation.
const CTX_CHAR_BUDGET: usize = 36_000;
/// Keep the tool catalog small enough for an 8-12K context and a 4B model.
/// A 4B model cannot reliably choose among more than ~12 tools.
const MAX_MCP_TOOLS: usize = 12;
/// Whole-catalog character budget for connected MCP tool specs.
const MAX_MCP_CATALOG_CHARS: usize = 8_000;
/// ADD-21: at most this many cloud-advisor consults per `ask`. A consult is a
/// slow, paid cloud call; one per turn keeps the local loop from flailing into
/// repeated exfiltration when it could just answer.
const MAX_ADVISOR_CALLS: u8 = 1;

const MCP_CONFIG_KEY: &str = "mcp_config";
/// Shown as the starting config. The web-search entry ships disabled so a
/// room never reaches the internet without the user flipping it on.
// Ship an empty scaffold, not a search example: web search has one clear home
// (Settings → Online features). MCP is the advanced "connect external tool
// programs" path — see CHG-2 / RM-5. Rooms that already saved a config keep it.
const DEFAULT_MCP_CONFIG: &str = r#"{
  "mcpServers": {}
}"#;

#[derive(Default)]
pub struct AppState {
    pub room: Mutex<Option<Room>>,
    pub pending_open: Mutex<Option<String>>,
    pub mcp: Mutex<mcp::Manager>,
    /// ADD-7: one cancel flag per in-flight `ask`, keyed by its `ask_id`.
    /// The entry is inserted when an ask starts and removed when it returns
    /// (success, error, or cancel). `cancel_ask` and `close_room` flip flags.
    pub cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// ADD-13: generation stamp for the lazy background embed pass. Each room
    /// unlock bumps it and spawns one loop carrying that stamp; a loop exits
    /// once the stamp moves on (a newer room opened) or the room closes, so at
    /// most one embed pass is ever live.
    pub embed_generation: Arc<std::sync::atomic::AtomicU64>,
    /// CHG-22: single-flight guard for the background one-liner filler, so at
    /// most one runs at a time.
    pub summary_filler: Arc<AtomicBool>,
    /// ADD-21: cloud CLIs detected on this Mac, cached after the first probe.
    /// The probe is an interactive-login-shell spawn (see
    /// `detect_external_blocking`) — too slow to repeat on every `ask` when the
    /// advisor gate needs to know what is installed. `ai_status` refreshes it
    /// whenever Settings is opened.
    pub external_cache: Mutex<Option<Vec<String>>>,
    /// SEC-1b: per-call MCP consent. `mcp_pending` holds the reply channel for
    /// each in-flight approval request (keyed by request id); the frontend
    /// answers via `resolve_mcp_call`. `mcp_session_ok` remembers servers the
    /// user chose "always allow" for, cleared when the room closes.
    pub mcp_pending: Mutex<HashMap<String, tokio::sync::oneshot::Sender<McpDecision>>>,
    pub mcp_session_ok: Mutex<HashSet<String>>,
}

/// The user's answer to a per-call MCP approval prompt.
#[derive(Clone, Copy)]
pub struct McpDecision {
    pub approved: bool,
    pub remember: bool,
}

/// Removes an ask's cancel flag from the registry when the ask returns, on
/// every path (`?` early-return, error, success, or cancel).
struct CancelGuard<'a> {
    state: &'a AppState,
    ask_id: String,
}
impl Drop for CancelGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut m) = self.state.cancels.lock() {
            m.remove(&self.ask_id);
        }
    }
}

pub struct Room {
    pub conn: Connection,
    pub path: String,
    pub name: String,
    /// The room's current password. Held in memory (the key already lives in
    /// SQLCipher's memory anyway) so ADD-4 can re-key a freshly made copy.
    pub password: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RoomInfo {
    pub name: String,
    pub path: String,
    pub file_count: i64,
    pub message_count: i64,
    /// True when the room file lives in a cloud-sync folder (HLT-6).
    pub synced: bool,
    /// SEC-1: set when the room has enabled MCP plug-ins whose config has not
    /// been approved on this Mac. The UI shows an approval dialog and, on
    /// "Allow", calls `approve_mcp` with the fingerprint. None = nothing to ask
    /// (no enabled servers, or this config is already approved).
    pub pending_mcp: Option<McpApproval>,
}

/// SEC-1: what the approval dialog needs — the config fingerprint to approve and
/// the enabled servers that would run, each with its real command line.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpApproval {
    pub fingerprint: String,
    pub servers: Vec<McpServerBrief>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpServerBrief {
    pub name: String,
    /// The full command line the server would run, e.g. "uvx duckduckgo-mcp-server".
    pub command: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileVersion {
    pub id: String,
    pub saved_at: String,
    pub cause: String,
}

/// Recent rooms live OUTSIDE any room, in the app's own data folder. Rooms are
/// encrypted; this list holds only their names and paths, never their contents.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecentRoom {
    pub name: String,
    pub path: String,
    // Unix epoch milliseconds of the last open. Optional so recent.json files
    // written before this field still deserialize (older entries read as None
    // and simply show no timestamp).
    #[serde(default)]
    pub opened_at: Option<i64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub source: String,
    pub has_text: bool,
    pub created_at: String,
    /// ADD-16: owning folder, or None when the file sits at the top level.
    pub folder_id: Option<String>,
    /// HLT-4: true when indexing hit the chunk cap, so only the first part of
    /// the file is searchable. Derived live from the chunk count, no column.
    pub partially_indexed: bool,
}

/// ADD-16: one flat folder. Files reference it by `folder_id`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
}

/// ADD-6: grouped results for the user's own room-wide search (⌘F).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub files: Vec<FileHit>,
    pub messages: Vec<MessageHit>,
    pub memories: Vec<MemoryHit>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub id: String,
    pub name: String,
    pub snippet: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MessageHit {
    pub chat_id: String,
    pub message_id: String,
    pub snippet: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MemoryHit {
    pub id: String,
    pub snippet: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: Vec<FileMeta>,
    pub errors: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub role: String,
    pub content: String,
    pub sources: Vec<String>,
    pub created_at: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    pub id: String,
    pub title: String,
    pub created_at: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: String,
    pub content: String,
    pub created_at: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    /// image | pdf | docx | sheet | csv | markdown | code | text | binary
    pub kind: String,
    pub name: String,
    pub mime: String,
    pub editable: bool,
    pub text: Option<String>,
    pub data_b64: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub running: bool,
    /// ADD-10: Ollama is installed on this Mac (may still not be running).
    /// Lets onboarding tell "not installed" from "installed but not started".
    pub installed: bool,
    pub models: Vec<String>,
    pub default_model: String,
    /// Cloud CLIs detected on this Mac ("claude-cli", "codex-cli").
    pub external: Vec<String>,
}

pub fn is_external_engine(model: &str) -> bool {
    model == "claude-cli" || model == "codex-cli"
}

/// Find cloud coding CLIs on this Mac. GUI apps launched from Finder/Dock get a
/// bare launchd PATH, so ask an INTERACTIVE login shell (`-ilc`) for the user's
/// real environment. Interactive matters: installers for these CLIs (and tools
/// like uv/rustup) commonly add their bin dir — e.g. `~/.local/bin` — only in
/// `.zshrc`, which a non-interactive `-lc` shell never sources, so `-lc` finds
/// nothing and the engine silently never appears.
fn detect_external_blocking() -> Vec<String> {
    let mut found = Vec::new();
    if let Ok(out) = std::process::Command::new("zsh")
        .args(["-ilc", "command -v claude; command -v codex"])
        .output()
    {
        let stdout = String::from_utf8_lossy(&out.stdout);
        for line in stdout.lines() {
            if line.ends_with("/claude") || line == "claude" {
                found.push("claude-cli".to_string());
            }
            if line.ends_with("/codex") || line == "codex" {
                found.push("codex-cli".to_string());
            }
        }
    }
    found
}

/// ADD-21: cloud CLIs on this Mac, cached. Gates the advisor tool without
/// paying the interactive-shell probe on every ask. `ai_status` refreshes it.
async fn detected_externals(state: &State<'_, AppState>) -> Vec<String> {
    if let Some(hit) = state.external_cache.lock().unwrap().clone() {
        return hit;
    }
    let found = tauri::async_runtime::spawn_blocking(detect_external_blocking)
        .await
        .unwrap_or_default();
    *state.external_cache.lock().unwrap() = Some(found.clone());
    found
}

/// ADD-10: is Ollama installed on this Mac at all? Distinct from "running".
/// Matches the interactive-login-shell PATH trick used for the cloud CLIs.
fn ollama_installed_blocking() -> bool {
    if std::path::Path::new("/Applications/Ollama.app").exists() {
        return true;
    }
    std::process::Command::new("zsh")
        .args(["-ilc", "command -v ollama"])
        .output()
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false)
}

/// Run one prompt through a cloud CLI (Claude Code / Codex). The content
/// leaves the machine via the user's own account — surfaced in the UI.
///
/// These CLIs are agents with file access, so attached images are written to
/// a private temp folder for the CLI to open itself, then deleted.
///
/// `cancel` (ADD-7): a watcher thread kills the child process if the user
/// presses Stop, so a runaway cloud answer ends promptly.
async fn run_external(
    engine: &str,
    messages: &[ollama::ChatMessage],
    cancel: Option<Arc<AtomicBool>>,
    // ADD-20: when present, the CLI is given the room's tools over a scoped
    // localhost MCP bridge (claude-cli only for now).
    bridge: Option<&crate::room_mcp::Bridge>,
) -> Result<String, String> {
    use std::io::Write;

    let tmp_dir =
        std::env::temp_dir().join(format!("private-room-cli-{}", Uuid::new_v4()));
    let mut image_paths: Vec<String> = Vec::new();
    for m in messages {
        if let Some(images) = &m.images {
            for b64 in images.iter().take(3) {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) {
                    if image_paths.is_empty() {
                        std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
                    }
                    let path = tmp_dir.join(format!("attachment-{}.png", image_paths.len() + 1));
                    if std::fs::write(&path, bytes).is_ok() {
                        image_paths.push(path.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }

    let mut prompt = String::new();
    for m in messages {
        match m.role.as_str() {
            "system" => prompt.push_str(&format!("Instructions:\n{}\n\n", m.content)),
            "user" => prompt.push_str(&format!("User: {}\n\n", m.content)),
            "assistant" => prompt.push_str(&format!("Assistant: {}\n\n", m.content)),
            _ => {}
        }
    }
    if !image_paths.is_empty() {
        prompt.push_str(&format!(
            "The user attached {} image(s), saved for you at:\n{}\nOpen and view them before answering.\n\n",
            image_paths.len(),
            image_paths.join("\n")
        ));
    }
    if bridge.is_some() {
        prompt.push_str(
            "You are connected to the user's Private Room through MCP tools \
             (mcp__room__*). Use them to list, search, open, edit, create, or \
             annotate the room's files whenever the question involves files — \
             do not guess file contents from memory.\n\n",
        );
    }
    prompt.push_str("Respond to the last user message. Reply with the answer only.");

    // ADD-20: hand the bridge to claude via --mcp-config. The config JSON is
    // written next to the (temp) work dir and removed with it.
    let mut mcp_config_path: Option<std::path::PathBuf> = None;
    if let Some(b) = bridge {
        if engine == "claude-cli" {
            std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
            let p = tmp_dir.join("mcp-room.json");
            std::fs::write(&p, b.mcp_config_json()).map_err(|e| e.to_string())?;
            mcp_config_path = Some(p);
        }
    }
    let cmdline = match (engine, &mcp_config_path) {
        ("claude-cli", Some(p)) => format!(
            "claude -p --mcp-config '{}' --strict-mcp-config --allowedTools 'mcp__room__*'",
            p.to_string_lossy()
        ),
        ("claude-cli", None) => "claude -p".to_string(),
        ("codex-cli", _) => "codex exec -".to_string(),
        _ => return Err("Unknown engine".into()),
    };
    let engine_name = engine.to_string();
    let work_dir = if image_paths.is_empty() {
        std::env::temp_dir()
    } else {
        tmp_dir.clone()
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        // Interactive login shell (`-ilc`), same as detection: from a GUI launch
        // the CLI is only on PATH via `.zshrc`, and the CLI also needs the user's
        // full env to reach its own subtools (git, node, …).
        let mut child = std::process::Command::new("zsh")
            .args(["-ilc", cmdline.as_str()])
            .current_dir(&work_dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Could not start {engine_name}: {e}"))?;
        let pid = child.id();
        child
            .stdin
            .take()
            .ok_or("no stdin")?
            .write_all(prompt.as_bytes())
            .map_err(|e| e.to_string())?;
        // ADD-7: watcher kills the child on Stop. `wait_with_output` keeps
        // draining stdout on this thread, so the pipe never deadlocks.
        let done = Arc::new(AtomicBool::new(false));
        let done_w = done.clone();
        let watcher = std::thread::spawn(move || loop {
            if done_w.load(Ordering::SeqCst) {
                break;
            }
            match &cancel {
                Some(flag) if flag.load(Ordering::SeqCst) => {
                    let _ = std::process::Command::new("kill")
                        .arg(pid.to_string())
                        .status();
                    break;
                }
                Some(_) => std::thread::sleep(std::time::Duration::from_millis(100)),
                None => break,
            }
        });
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        done.store(true, Ordering::SeqCst);
        let _ = watcher.join();
        if !out.status.success() {
            let err: String = String::from_utf8_lossy(&out.stderr).chars().take(400).collect();
            return Err(format!("{engine_name} failed: {err}"));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    // Decrypted content must not linger on disk.
    let _ = std::fs::remove_dir_all(&tmp_dir);
    result
}

/// Settings → Online features "Test search": exercise the real provider
/// path without the model, so a broken pipeline is visible immediately.
#[tauri::command]
pub async fn web_search_test(state: State<'_, AppState>) -> Result<String, String> {
    let (provider, endpoint) = {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        (
            db::get_setting(&room.conn, "web_provider").unwrap_or_default(),
            db::get_setting(&room.conn, "web_endpoint").unwrap_or_default(),
        )
    };
    let hits = match provider.as_str() {
        "duckduckgo" | "brave" => web::search_duckduckgo("duckduckgo").await?,
        "searxng" => web::search_searxng(&endpoint, "searxng").await?,
        _ => {
            return Err(
                "Web access is off in this room — pick a provider above and press Save first. \
                 (Each room has its own setting.)"
                    .into(),
            )
        }
    };
    match hits.first() {
        Some(hit) => Ok(format!(
            "Working ✓ — {} results. Top hit: {}",
            hits.len(),
            hit.title
        )),
        None => Err("The provider responded but returned no results — try again.".into()),
    }
}

fn room_name_from_path(path: &str) -> String {
    std::path::Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Room".into())
}

fn info_of(app: &tauri::AppHandle, room: &Room) -> Result<RoomInfo, String> {
    let (file_count, message_count) = db::room_counts(&room.conn)?;
    Ok(RoomInfo {
        name: room.name.clone(),
        path: room.path.clone(),
        file_count,
        message_count,
        synced: is_synced_path(&room.path),
        pending_mcp: pending_mcp_for(app, &room.conn),
    })
}

/// True when the room file lives under a known cloud-sync root — databases and
/// file sync are a dangerous mix, so the UI warns once (HLT-6). Covers iCloud
/// (`Library/Mobile Documents`), modern `Library/CloudStorage/` (Dropbox,
/// Google Drive, OneDrive), and legacy `~/Dropbox`.
fn is_synced_path(path: &str) -> bool {
    if path.contains("Library/Mobile Documents") || path.contains("Library/CloudStorage/") {
        return true;
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() && path.starts_with(&format!("{home}/Dropbox")) {
            return true;
        }
    }
    false
}

/// The web tools exist for the model only when the user picked a provider
/// in Settings → Online features. "brave" is a legacy value from before the
/// key-less provider existed; those rooms run on DuckDuckGo.
fn web_access_enabled(conn: &Connection) -> bool {
    matches!(
        db::get_setting(conn, "web_provider").as_deref(),
        Some("duckduckgo") | Some("searxng") | Some("brave")
    )
}

/// ADD-21: the "AI advisors" advanced tool is enabled for this room. Off by
/// default — while off, `consult_advisor` is not even offered to the model, so
/// the local model can never send a subtask off this Mac on its own.
fn advisors_enabled(conn: &Connection) -> bool {
    db::get_setting(conn, "advisors_enabled").as_deref() == Some("on")
}

/// ADD-21: sub-option — when the local model consults a Claude advisor, also
/// give that advisor the room's connected MCP tools over the room bridge. A
/// second, separate "content leaves this Mac" decision, so it has its own key.
fn advisor_tools_enabled(conn: &Connection) -> bool {
    db::get_setting(conn, "advisor_tools_enabled").as_deref() == Some("on")
}

/// "B7" → zero-based (row, col). None when it isn't A1 notation.
fn parse_a1(cell: &str) -> Option<(usize, usize)> {
    let cell = cell.trim().to_uppercase();
    let letters: String = cell.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    let digits = &cell[letters.len()..];
    if letters.is_empty() || digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let col = letters
        .chars()
        .fold(0usize, |acc, c| acc * 26 + (c as usize - 'A' as usize + 1))
        - 1;
    let row: usize = digits.parse().ok()?;
    if row == 0 {
        return None;
    }
    Some((row - 1, col))
}

fn is_a1_range(range: &str) -> bool {
    let mut parts = range.splitn(2, ':');
    let first = parts.next().unwrap_or_default();
    match parts.next() {
        Some(second) => parse_a1(first).is_some() && parse_a1(second).is_some(),
        None => parse_a1(first).is_some(),
    }
}

/// Minimal CSV/TSV parser — quoted fields, embedded delimiters and newlines.
fn parse_delim(text: &str, delim: char) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
        } else {
            match c {
                '"' if field.is_empty() => in_quotes = true,
                '\r' => {}
                '\n' => {
                    row.push(std::mem::take(&mut field));
                    rows.push(std::mem::take(&mut row));
                }
                c if c == delim => row.push(std::mem::take(&mut field)),
                _ => field.push(c),
            }
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

fn serialize_delim(rows: &[Vec<String>], delim: char) -> String {
    let mut out = String::new();
    for row in rows {
        let line: Vec<String> = row
            .iter()
            .map(|f| {
                if f.contains(delim) || f.contains('"') || f.contains('\n') {
                    format!("\"{}\"", f.replace('"', "\"\""))
                } else {
                    f.clone()
                }
            })
            .collect();
        out.push_str(&line.join(&delim.to_string()));
        out.push('\n');
    }
    out
}

/// Set one cell (A1 notation) in spreadsheet bytes. Returns the new bytes
/// plus the re-extracted text for the search index. Shared by the agent's
/// set_cells tool and the viewer's grid editing.
fn set_cell_in_bytes(
    name: &str,
    bytes: &[u8],
    sheet: Option<&str>,
    cell: &str,
    value: &str,
) -> Result<(Vec<u8>, Option<String>), String> {
    let cell = cell.trim().to_uppercase();
    let Some((row, col)) = parse_a1(&cell) else {
        return Err(format!("\"{cell}\" is not a cell — use A1 notation like B7."));
    };
    let ext = extraction::extension_of(name);
    match ext.as_str() {
        "csv" | "tsv" => {
            let delim = if ext == "tsv" { '\t' } else { ',' };
            let mut rows = parse_delim(&String::from_utf8_lossy(bytes), delim);
            if rows.len() <= row {
                rows.resize(row + 1, Vec::new());
            }
            if rows[row].len() <= col {
                rows[row].resize(col + 1, String::new());
            }
            rows[row][col] = value.to_string();
            let out = serialize_delim(&rows, delim);
            Ok((out.clone().into_bytes(), Some(out)))
        }
        "xlsx" => {
            let new_bytes = xlsx_set_cell(bytes, sheet, &cell, value)?;
            let text = extraction::extract_text(name, &new_bytes);
            Ok((new_bytes, text))
        }
        _ => Err(format!(
            "\"{name}\" is not an editable spreadsheet — cell editing works on .xlsx and .csv files."
        )),
    }
}

fn xlsx_set_cell(
    bytes: &[u8],
    sheet: Option<&str>,
    cell: &str,
    value: &str,
) -> Result<Vec<u8>, String> {
    let mut book = umya_spreadsheet::reader::xlsx::read_reader(std::io::Cursor::new(bytes), true)
        .map_err(|e| format!("Could not read the spreadsheet: {e}"))?;
    {
        let ws = match sheet {
            Some(name) => book
                .sheet_by_name_mut(name)
                .map_err(|_| format!("No sheet named \"{name}\" in this workbook."))?,
            None => book
                .sheet_mut(0)
                .map_err(|_| "The workbook has no sheets.".to_string())?,
        };
        ws.cell_mut(cell).set_value(value);
    }
    let mut out: Vec<u8> = Vec::new();
    umya_spreadsheet::writer::xlsx::write_writer(&book, &mut out)
        .map_err(|e| format!("Could not write the spreadsheet: {e}"))?;
    Ok(out)
}

/// Case- and whitespace-insensitive form used to verify quotes the model
/// wants to highlight or edit actually exist in a file. Typographic
/// look-alikes (curly quotes, dashes, ligatures) are folded so extracted
/// text and model quotes can meet in the middle.
fn normalize_for_match(s: &str) -> String {
    let mut folded = String::with_capacity(s.len());
    for c in s.to_lowercase().chars() {
        match c {
            '\u{2018}' | '\u{2019}' | '\u{02BC}' => folded.push('\''),
            '\u{201C}' | '\u{201D}' => folded.push('"'),
            '\u{2013}' | '\u{2014}' => folded.push('-'),
            '\u{FB01}' => folded.push_str("fi"),
            '\u{FB02}' => folded.push_str("fl"),
            _ => folded.push(c),
        }
    }
    folded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Build a viewer annotation payload for a file, verifying a text quote appears
/// verbatim in the extracted text (normalization-tolerant, with a space-free
/// fallback for PDFs). Shared by the annotate_file tool and the #highlight
/// workflow so both go through the same ground-truth check. Returns the payload
/// plus a short human description; errs if the quote can't be found or neither a
/// quote nor a cell range was given.
#[allow(clippy::too_many_arguments)]
/// ADD-22: when an exact/normalized annotate quote can't be found (small models
/// paraphrase or drop a word), locate the passage in `extracted` that best
/// matches by word overlap and return it VERBATIM, so the viewer's own matcher
/// can still highlight it. None when nothing is a solid match. The returned
/// string is always a real substring of `extracted` (byte-safe spans), and a
/// strict word-majority is required so we never highlight something unrelated.
fn closest_snippet(extracted: &str, quote: &str) -> Option<String> {
    fn norm(w: &str) -> String {
        w.chars().filter(|c| c.is_alphanumeric()).flat_map(|c| c.to_lowercase()).collect()
    }
    let q_words: Vec<String> = quote.split_whitespace().map(norm).filter(|w| !w.is_empty()).collect();
    if q_words.len() < 3 {
        return None; // too short to approximate safely
    }
    // Haystack words with their original byte spans.
    let mut h: Vec<(usize, usize, String)> = Vec::new();
    let mut start: Option<usize> = None;
    for (i, c) in extracted.char_indices() {
        if c.is_whitespace() {
            if let Some(s) = start.take() {
                let w = norm(&extracted[s..i]);
                if !w.is_empty() {
                    h.push((s, i, w));
                }
            }
        } else if start.is_none() {
            start = Some(i);
        }
    }
    if let Some(s) = start {
        let w = norm(&extracted[s..]);
        if !w.is_empty() {
            h.push((s, extracted.len(), w));
        }
    }
    if h.is_empty() {
        return None;
    }
    let q_set: std::collections::HashSet<&str> = q_words.iter().map(String::as_str).collect();
    let win = q_words.len();
    let mut best: Option<(usize, usize, usize)> = None; // (score, start_idx, end_idx_excl)
    for w in [win.saturating_sub(2).max(2), win, win + 2] {
        if w > h.len() {
            continue;
        }
        for i in 0..=h.len() - w {
            let score = h[i..i + w].iter().filter(|(_, _, word)| q_set.contains(word.as_str())).count();
            if best.map_or(true, |(bs, _, _)| score > bs) {
                best = Some((score, i, i + w));
            }
        }
    }
    let (score, si, ei) = best?;
    if score * 2 <= win {
        return None; // need a strict majority of the quote's words present
    }
    Some(extracted[h[si].0..h[ei - 1].1].to_string())
}

fn build_annotation(
    id: &str,
    real_name: &str,
    extracted: Option<&str>,
    quote: &str,
    range: &str,
    page: Option<u64>,
    sheet: Option<&str>,
    note: Option<&str>,
) -> Result<(serde_json::Value, String), String> {
    let quote = quote.trim();
    if !range.is_empty() {
        if !is_a1_range(range) {
            return Err(format!(
                "\"{range}\" is not a cell range — use A1 notation like B7 or B2:D5."
            ));
        }
        let payload = serde_json::json!({
            "fileId": id, "name": real_name, "sheet": sheet,
            "range": range, "note": note,
        });
        Ok((payload, format!("cells {range}")))
    } else if !quote.is_empty() {
        let haystack = normalize_for_match(extracted.unwrap_or_default());
        let needle = normalize_for_match(quote);
        // PDF extraction breaks words unpredictably; fall back to a space-free
        // comparison before rejecting the quote.
        let found = haystack.contains(&needle)
            || haystack.replace(' ', "").contains(&needle.replace(' ', ""));
        // ADD-22: on a miss, don't hard-fail — anchor on the closest real passage
        // so a paraphrased/near quote still highlights (marked approximate).
        let (final_quote, approx) = if found {
            (quote.to_string(), false)
        } else if let Some(snip) = closest_snippet(extracted.unwrap_or_default(), quote) {
            (snip, true)
        } else {
            return Err(format!(
                "Could not find that text in \"{real_name}\". Copy a short snippet exactly as \
                 it appears in the file (use search_room or open_file to see its text first)."
            ));
        };
        let payload = serde_json::json!({
            "fileId": id, "name": real_name, "quote": final_quote,
            "page": page, "note": note, "approx": approx,
        });
        let described = if approx {
            format!("\"{final_quote}\" (closest match)")
        } else {
            format!("\"{final_quote}\"")
        };
        Ok((payload, described))
    } else {
        Err("Provide either exact text to highlight, or a cell range for spreadsheets.".into())
    }
}

// ---------------------------------------------------------------- room lifecycle

#[tauri::command]
pub fn create_room(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    password: String,
) -> Result<RoomInfo, String> {
    let name = room_name_from_path(&path);
    let conn = db::create_room(&path, &password, &name)?;
    let room = Room {
        conn,
        path,
        name,
        password,
    };
    let info = info_of(&app, &room)?;
    push_recent(&app, &room.name, &room.path);
    *state.room.lock().unwrap() = Some(room);
    refresh_mcp(&app);
    spawn_reextract_backfill(&app);
    spawn_embedding_backfill(&app);
    Ok(info)
}

#[tauri::command]
pub fn open_room(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    password: String,
) -> Result<RoomInfo, String> {
    let conn = db::open_room(&path, &password)?;
    let name = db::get_meta(&conn, "name").unwrap_or_else(|| room_name_from_path(&path));
    let room = Room {
        conn,
        path,
        name,
        password,
    };
    let info = info_of(&app, &room)?;
    push_recent(&app, &room.name, &room.path);
    *state.room.lock().unwrap() = Some(room);
    refresh_mcp(&app);
    spawn_reextract_backfill(&app);
    spawn_embedding_backfill(&app);
    Ok(info)
}

// ---------------------------------------------------------------- speech-to-text (ADD-18)

/// Where the Whisper model lives: <app data dir>/models/<MODEL_FILE>. The
/// engine is compiled in; only these weights download, like Ollama models.
fn stt_model_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("models").join(stt::MODEL_FILE))
}

/// One download at a time; the UI disables the button while this is set.
static STT_DOWNLOADING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SttStatus {
    pub installed: bool,
    pub downloading: bool,
    pub size_mb: u64,
}

#[tauri::command]
pub fn stt_status(app: tauri::AppHandle) -> Result<SttStatus, String> {
    Ok(SttStatus {
        installed: stt_model_path(&app)?.exists(),
        downloading: STT_DOWNLOADING.load(Ordering::SeqCst),
        size_mb: stt::MODEL_SIZE_MB,
    })
}

/// Download the Whisper model (once, ~574 MB) with `stt-download-progress`
/// events `{got, total, percent}`. Streams to a .part file and renames on
/// success, so a cancelled/failed download never leaves a half model behind.
#[tauri::command]
pub async fn stt_download_model(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use tauri::Emitter;

    let dest = stt_model_path(&app)?;
    if dest.exists() {
        return Ok(());
    }
    if STT_DOWNLOADING.swap(true, Ordering::SeqCst) {
        return Err("The dictation model is already downloading.".into());
    }
    let result: Result<(), String> = async {
        if let Some(dir) = dest.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let part = dest.with_extension("bin.part");
        let resp = reqwest::get(stt::MODEL_URL)
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("download failed: {e}"))?;
        let total = resp.content_length().unwrap_or(stt::MODEL_SIZE_MB * 1024 * 1024);
        let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut got: u64 = 0;
        let mut last_pct: u64 = 0;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("download interrupted: {e}"))?;
            std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
            got += chunk.len() as u64;
            let pct = got * 100 / total.max(1);
            if pct != last_pct {
                last_pct = pct;
                let _ = window.emit(
                    "stt-download-progress",
                    serde_json::json!({ "got": got, "total": total, "percent": pct }),
                );
            }
        }
        drop(file);
        std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = std::fs::remove_file(dest.with_extension("bin.part"));
    }
    STT_DOWNLOADING.store(false, Ordering::SeqCst);
    result
}

#[tauri::command]
pub fn stt_delete_model(app: tauri::AppHandle) -> Result<(), String> {
    let path = stt_model_path(&app)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Transcribe recorded audio (mic dictation / talk-to-file): base64 bytes in,
/// text out, fully on-device. `STT_MODEL_MISSING` is the sentinel the UI maps
/// to a "download it in Settings" hint, like OLLAMA_DOWN / MODEL_MISSING.
#[tauri::command]
pub async fn transcribe_audio(
    app: tauri::AppHandle,
    data_b64: String,
    ext: String,
    timestamps: bool,
) -> Result<String, String> {
    let model = stt_model_path(&app)?;
    if !model.exists() {
        return Err("STT_MODEL_MISSING".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let kind = stt::media_kind("", &ext).unwrap_or(stt::MediaKind::Audio);
        let pcm = stt::decode_bytes_to_pcm(&bytes, &ext, kind)?;
        stt::transcribe(&model, &pcm, timestamps)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// ADD-18: transcribe one imported recording on the STT worker lane — the
/// audio/video twin of `run_ocr_job`. On success the timestamped transcript is
/// stored as the file's extracted text (prefixed so the AI knows provenance),
/// making it searchable/quotable. Failures are silent: the file just keeps
/// having no text, exactly like before this feature.
fn run_stt_job(app: &tauri::AppHandle, job: JobMeta) {
    use tauri::{Emitter, Manager};
    let Ok(model) = stt_model_path(app) else { return };
    if !model.exists() {
        let _ = app.emit("stt-progress", (&job.name, "model-missing"));
        return;
    }
    let Some(kind) = stt::media_kind(&job.mime, &job.ext) else { return };
    let _ = app.emit("stt-progress", (&job.name, "started"));
    let Some(bytes) = read_job_bytes(app, &job) else { return };
    let text = stt::decode_bytes_to_pcm(&bytes, &job.ext, kind)
        .and_then(|pcm| stt::transcribe(&model, &pcm, true))
        .unwrap_or_default();
    if text.trim().is_empty() {
        let _ = app.emit("stt-progress", (&job.name, "none"));
        return;
    }
    let full_text = format!("(transcribed from recording)\n{text}");
    {
        let state = app.state::<AppState>();
        let guard = state.room.lock().unwrap();
        match guard.as_ref() {
            Some(room) if room.path == job.room_path => {
                let _ = db::update_file_content(&room.conn, &job.id, &bytes, Some(&full_text));
            }
            _ => return,
        }
    }
    let _ = app.emit("room-files-changed", ());
    let _ = app.emit("stt-progress", (&job.name, "done"));
    // CHG-22: newly-transcribed file → let the one-liner filler pick it up.
    spawn_summary_filler(app.clone(), job.room_path.clone());
}

/// CHG-22: opportunistically fill cached one-liners (files.ai_summary) in the
/// background so the interactive "Summarize room" collapses to a single reduce
/// call. Single-flight; starts after a short delay so it never races the user's
/// first post-import question; yields to any streaming answer; uses a short
/// keep-alive so it never pins the model in RAM. All failures are silent —
/// summarize_room remains the full fallback.
fn spawn_summary_filler(app: tauri::AppHandle, room_path: String) {
    use tauri::Manager;
    let state = app.state::<AppState>();
    // Single-flight: bail if a filler is already running.
    if state.summary_filler.swap(true, Ordering::SeqCst) {
        return;
    }
    let flag = state.summary_filler.clone();
    tauri::async_runtime::spawn(async move {
        // Reset the single-flight flag on every exit path.
        struct Reset(Arc<AtomicBool>);
        impl Drop for Reset {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _reset = Reset(flag);

        // Let the user's first question take priority.
        tokio::time::sleep(std::time::Duration::from_secs(45)).await;

        let models = ollama::list_models().await.unwrap_or_default();
        if models.is_empty() {
            return;
        }
        let (model, still_open) = {
            let state = app.state::<AppState>();
            let guard = state.room.lock().unwrap();
            match guard.as_ref() {
                Some(room) if room.path == room_path => {
                    (model_setting(&room.conn).unwrap_or_else(|| best_default(&models)), true)
                }
                _ => (String::new(), false),
            }
        };
        if !still_open {
            return;
        }
        let model = if is_external_engine(&model) {
            best_default(&models)
        } else {
            model
        };

        // One bounded batch, then exit — a fresh import/OCR event re-triggers.
        let batch = {
            let state = app.state::<AppState>();
            let guard = state.room.lock().unwrap();
            let Some(room) = guard.as_ref() else { return };
            if room.path != room_path {
                return;
            }
            db::files_missing_summary(&room.conn, MAX_SUMMARY_FILES).unwrap_or_default()
        };
        for (id, name, mime, text) in batch {
            // Yield to any in-flight answer, and stop if the room changed.
            {
                let state = app.state::<AppState>();
                if !state.cancels.lock().unwrap().is_empty() {
                    return;
                }
                let guard = state.room.lock().unwrap();
                match guard.as_ref() {
                    Some(room) if room.path == room_path => {}
                    _ => return,
                }
            }
            let liner =
                match summarize_one_file(&model, &name, &mime, &text, KEEP_ALIVE_SHORT).await {
                    Ok(l) => l,
                    // Ollama down / model unloaded under pressure → stop quietly.
                    Err(_) => return,
                };
            if liner.is_empty() {
                continue;
            }
            let state = app.state::<AppState>();
            let guard = state.room.lock().unwrap();
            match guard.as_ref() {
                Some(room) if room.path == room_path => {
                    let _ = db::set_file_ai_summary(&room.conn, &id, &liner);
                }
                _ => return,
            }
        }
    });
}

// ------------------------------------------------------- dictation shaping (ADD-18)
// Ported from alfred's proven dictation pipeline (voicebridge.py): the same
// battle-tested prompt texts, combined into ONE local-model call. Two findings
// inherited from alfred: (1) whisper *-turbo models silently cannot translate,
// so translation happens HERE via the LLM, never in the Whisper step; (2) on
// any LLM failure the raw transcript must survive — callers fall back to it.
// Cloud engines are never used for shaping: dictated words stay on this Mac.

const DICT_TRANSLATE: &str = "Translate it into fluent, natural English. If it is \
already English, keep it unchanged. Preserve meaning and tone.";

const DICT_REWRITE: &str = "Clean up this raw voice transcription: remove filler \
words (um, uh, like), false starts, and repetitions; fix grammar, spelling, and \
punctuation; preserve the speaker's meaning, intent, and tone. Do not add new \
information and do not answer any question contained in the text.";

const DICT_TAIL: &str = "Output ONLY the resulting text, with no preamble, labels, \
explanations, or surrounding quotes.";

/// alfred's Prompt Optimizer — a standalone rewrite instruction (replaces the
/// cleanup instruction instead of extending it).
const DICT_PROMPT_OPTIMIZER: &str = "You are a prompt optimizer. Given any user \
input, automatically rewrite it into a clear, effective prompt. Never ask \
follow-up questions — infer everything from the input alone and preserve the \
user's full original intent (every requirement, entity, constraint, and nuance \
must survive the rewrite; never add goals they didn't imply).\n\nINTERNAL STEPS \
(do not show these):\n1. Deconstruct: extract the core intent, key entities, \
context, output requirements, and constraints.\n2. Develop: silently classify \
the request type and apply the fitting approach (creative → multi-perspective; \
technical → constraint-based precision; educational → clear structure and \
examples; complex → step-by-step framing). Add a role/expertise framing and \
logical structure where it helps.\n3. Auto-detect level: SHORT for simple \
requests (a tight one-paragraph prompt), DETAILED for complex ones (role, \
context, task breakdown, output format).\n\nOUTPUT:\nReturn only the rewritten \
prompt — no preamble, no explanation of changes, no questions.";

/// Intent guidance appended to the cleanup instruction (alfred's BUILTIN_MODES).
/// Returns (guidance, replaces_cleanup).
fn dict_mode_guidance(mode: &str) -> Option<(&'static str, bool)> {
    match mode {
        "raw" => Some(("", false)), // cleanup only
        "email" => Some((
            "Shape it as the body of a clear, courteous email. Do not invent a \
             subject line, greeting, or signature unless they were dictated.",
            false,
        )),
        "message" => Some(("Shape it as a concise, natural chat/Slack message.", false)),
        "commit" => Some((
            "Shape it as a git commit message: a short imperative summary line \
             (<=72 chars), then a blank line, then bullet points if warranted.",
            false,
        )),
        "notes" => Some((
            "Shape it as clean, organized notes (short paragraphs or bullets).",
            false,
        )),
        "prompt" => Some((DICT_PROMPT_OPTIMIZER, true)),
        _ => None,
    }
}

/// Post-process dictated text on the LOCAL model: optional translate-to-English
/// plus an optional intent rewrite, as one combined prompt (alfred's
/// build_combined_prompt shape). `mode="off"` + translate=false returns the
/// text unchanged without any model call.
#[tauri::command]
pub async fn shape_text(
    state: State<'_, AppState>,
    text: String,
    translate: bool,
    mode: String,
) -> Result<String, String> {
    // ADD-22: build the shaping steps WITHOUT translate — translate runs as its
    // own pass first, because one instruction at a time is far more reliable for
    // a small model than translate+cleanup+shape crammed into one prompt.
    let mut shape_steps: Vec<&str> = Vec::new();
    match dict_mode_guidance(&mode) {
        Some((guidance, true)) => shape_steps.push(guidance),
        Some(("", false)) => shape_steps.push(DICT_REWRITE),
        Some((guidance, false)) => {
            shape_steps.push(DICT_REWRITE);
            shape_steps.push(guidance);
        }
        None => {} // "off" or unknown: no rewrite stage
    }
    if !translate && shape_steps.is_empty() {
        return Ok(text);
    }

    // Shaping always runs on a LOCAL model — dictated words never go to a
    // cloud engine, whatever the chat model is set to.
    let models = ollama::list_models()
        .await
        .map_err(|_| "The local AI (Ollama) isn't running — raw transcript kept.".to_string())?;
    if models.is_empty() {
        return Err("No local AI model is installed — raw transcript kept.".into());
    }
    let mut model = {
        let guard = state.room.lock().unwrap();
        guard
            .as_ref()
            .and_then(|room| model_setting(&room.conn))
            .unwrap_or_else(|| best_default(&models))
    };
    if is_external_engine(&model) {
        model = best_default(&models);
    }

    // Pass 1: translate on its own. A failure/empty result keeps the prior text.
    let mut text = text;
    if translate {
        if let Ok(t) = run_dict_pass(&model, &[DICT_TRANSLATE], &text).await {
            let t = t.trim();
            if !t.is_empty() {
                text = t.to_string();
            }
        }
    }
    // Pass 2: cleanup + optional mode shaping (or the prompt optimizer).
    if shape_steps.is_empty() {
        return Ok(text);
    }
    let shaped = run_dict_pass(&model, &shape_steps, &text).await?;
    let shaped = shaped.trim().to_string();
    // Resilience (alfred): never lose the words — empty output → prior text.
    Ok(if shaped.is_empty() { text } else { shaped })
}

/// ADD-22: one dictation-shaping model call. A single instruction gets a plain
/// prompt; multiple instructions keep the numbered "operations in order" shape.
async fn run_dict_pass(model: &str, steps: &[&str], text: &str) -> Result<String, String> {
    let prompt = if steps.len() == 1 {
        format!("{}\n\n{DICT_TAIL}\n\nINPUT TEXT:\n{text}", steps[0])
    } else {
        let numbered = steps
            .iter()
            .enumerate()
            .map(|(i, s)| format!("{}. {s}", i + 1))
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            "You are a text post-processor. Apply the following operations to the \
             INPUT TEXT, in order:\n{numbered}\n\n{DICT_TAIL}\n\nINPUT TEXT:\n{text}"
        )
    };
    let messages = vec![ollama::ChatMessage {
        role: "user".into(),
        content: prompt,
        ..Default::default()
    }];
    let (out, _) =
        ollama::chat_stream_tools(model, messages, None, Some(0.2), None, "5m", |_| {}).await?;
    Ok(out)
}

// ---------------------------------------------------------------- Touch ID (ADD-11)

/// True if a biometric Keychain entry exists for this room path. Never prompts.
#[tauri::command]
pub fn touchid_has(path: String) -> Result<bool, String> {
    Ok(crate::biometrics::has(&path))
}

/// Store the CURRENTLY-OPEN room's password in the Keychain, guarded by
/// biometrics. The secret is read from the in-memory Room — it is never taken
/// from a file and never written anywhere but the Keychain.
#[tauri::command]
pub fn touchid_enable(state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    crate::biometrics::store(&room.path, &room.password)
}

/// Turn Touch ID off for a room: delete its Keychain entry (idempotent).
#[tauri::command]
pub fn touchid_disable(path: String) -> Result<(), String> {
    crate::biometrics::delete(&path)
}

/// Fingerprint-unlock: trigger the system biometric prompt to read the stored
/// password, then take the normal `open_room` path. On cancel/failure this
/// returns a clear error and the UI falls back to the password field.
#[tauri::command]
pub fn touchid_open(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<RoomInfo, String> {
    let password = crate::biometrics::read(&path)?;
    open_room(app, state, path, password)
}

#[tauri::command]
pub async fn close_room(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    use tauri::Emitter;
    // HLT-7: if an answer is streaming, cancel it and wait briefly for its
    // save-partial phase to finish, so locking never races the DB shut.
    {
        let flags: Vec<Arc<AtomicBool>> =
            state.cancels.lock().unwrap().values().cloned().collect();
        if !flags.is_empty() {
            for f in &flags {
                f.store(true, Ordering::SeqCst);
            }
            // Up to ~1s; the ask removes its own entry once it has saved.
            for _ in 0..20 {
                if state.cancels.lock().unwrap().is_empty() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
    }
    // SEC-7: reclaim space before closing when a large amount was freed (e.g.
    // the user deleted big files). Small deletions skip the slow vacuum.
    {
        let guard = state.room.lock().unwrap();
        if let Some(room) = guard.as_ref() {
            if db::reclaimable_bytes(&room.conn).unwrap_or(0) > 10 * 1024 * 1024 {
                let _ = db::vacuum(&room.conn);
            }
        }
    }
    *state.room.lock().unwrap() = None;
    // Dropping the clients kills the server processes (kill_on_drop).
    {
        let mut mgr = state.mcp.lock().unwrap();
        mgr.generation += 1;
        mgr.servers.clear();
    }
    // SEC-1b: per-call MCP consent is per session — forget it on lock, and drop
    // any in-flight approval requests (their awaiters resolve to a decline).
    state.mcp_session_ok.lock().unwrap().clear();
    state.mcp_pending.lock().unwrap().clear();
    let _ = app.emit("mcp-status", Vec::<mcp::ServerStatus>::new());
    Ok(())
}

#[tauri::command]
pub fn room_info(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<RoomInfo>, String> {
    let guard = state.room.lock().unwrap();
    match guard.as_ref() {
        Some(room) => Ok(Some(info_of(&app, room)?)),
        None => Ok(None),
    }
}

#[tauri::command]
pub fn take_pending_open(state: State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(state.pending_open.lock().unwrap().take())
}

// ---------------------------------------------------------------- files


#[tauri::command]
pub fn import_files(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<ImportReport, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let room_path = room.path.clone();
    let mut imported = Vec::new();
    let mut errors = Vec::new();
    // ADD-14: files that arrived with no extractable text and could be scans or
    // photos. OCR runs in the background AFTER import returns, so a big scan
    // never freezes the import.
    let mut ocr_jobs: Vec<JobMeta> = Vec::new();
    for path in paths {
        let file_name = std::path::Path::new(&path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        match std::fs::metadata(&path) {
            Ok(md) if md.len() > MAX_IMPORT_BYTES => {
                errors.push(format!("{file_name}: file is larger than 200 MB"));
                continue;
            }
            Err(e) => {
                errors.push(format!("{file_name}: {e}"));
                continue;
            }
            _ => {}
        }
        match std::fs::read(&path) {
            Ok(bytes) => {
                let mime = mime_guess::from_path(&path)
                    .first_or_octet_stream()
                    .essence_str()
                    .to_string();
                let mut text = extraction::extract_text(&file_name, &bytes);
                // Anything the built-in extractors can't read (ppt, doc, xls,
                // epub, …) gets a second chance through MarkItDown if installed.
                if text.as_deref().map_or(true, |t| t.trim().is_empty())
                    && !extraction::is_image(&mime)
                {
                    text = extraction::markitdown_extract(&path);
                }
                let ext = extraction::extension_of(&file_name);
                let no_text = text.as_deref().map_or(true, |t| t.trim().is_empty());
                let needs_ocr = no_text && ocr::is_ocr_candidate(&mime, &ext);
                // ADD-18: recordings/videos get transcribed in the background,
                // the audio twin of the OCR fallback below.
                let needs_stt = no_text && stt::media_kind(&mime, &ext).is_some();
                match db::insert_file(&room.conn, &file_name, &mime, &bytes, text.as_deref(), "upload")
                {
                    Ok(meta) => {
                        if needs_ocr || needs_stt {
                            // CHG-27: enqueue metadata only; the worker re-reads
                            // bytes from the DB when it runs.
                            ocr_jobs.push(JobMeta {
                                id: meta.id.clone(),
                                name: file_name.clone(),
                                mime: mime.clone(),
                                ext,
                                room_path: room_path.clone(),
                            });
                        }
                        imported.push(meta);
                    }
                    Err(e) => errors.push(format!("{file_name}: {e}")),
                }
            }
            Err(e) => errors.push(format!("{file_name}: {e}")),
        }
    }
    // Release the room lock before kicking off background OCR/STT — the
    // worker lanes re-acquire it once, briefly, only when they have text.
    drop(guard);
    for job in ocr_jobs {
        // Media files route to the transcriber lane, everything else to OCR.
        if stt::media_kind(&job.mime, &job.ext).is_some() {
            enqueue_stt(&app, job);
        } else {
            enqueue_ocr(&app, job);
        }
    }
    // CHG-22: fill one-liners for freshly-imported text files in the background.
    spawn_summary_filler(app.clone(), room_path.clone());
    Ok(ImportReport { imported, errors })
}

/// CHG-27: a background enrichment job carrying only metadata — NOT the file
/// bytes. The file is already in the room DB before dispatch, so the worker
/// re-reads bytes under the room lock; this keeps peak memory to one in-flight
/// file per lane instead of holding every dropped file's bytes at once.
#[derive(Clone)]
struct JobMeta {
    id: String,
    name: String,
    mime: String,
    ext: String,
    room_path: String,
}

/// CHG-27: two lazily-started, long-lived worker lanes (OCR and STT) draining an
/// mpsc channel, so importing 30 scans runs them one at a time instead of
/// spawning 30 concurrent multi-hundred-MB OCR passes that starve the chat.
static OCR_TX: OnceLock<std::sync::mpsc::Sender<JobMeta>> = OnceLock::new();
static STT_TX: OnceLock<std::sync::mpsc::Sender<JobMeta>> = OnceLock::new();

fn enqueue_ocr(app: &tauri::AppHandle, job: JobMeta) {
    let app = app.clone();
    let tx = OCR_TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<JobMeta>();
        std::thread::spawn(move || {
            for job in rx {
                run_ocr_job(&app, job);
            }
        });
        tx
    });
    let _ = tx.send(job);
}

fn enqueue_stt(app: &tauri::AppHandle, job: JobMeta) {
    let app = app.clone();
    let tx = STT_TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<JobMeta>();
        std::thread::spawn(move || {
            for job in rx {
                run_stt_job(&app, job);
            }
        });
        tx
    });
    let _ = tx.send(job);
}

/// Read a job's stored bytes iff its room is still the open one. None → the room
/// was closed/switched while the job was queued; the worker drops the job.
fn read_job_bytes(app: &tauri::AppHandle, job: &JobMeta) -> Option<Vec<u8>> {
    use tauri::Manager;
    let state = app.state::<AppState>();
    let guard = state.room.lock().unwrap();
    match guard.as_ref() {
        Some(room) if room.path == job.room_path => {
            db::get_file_bytes(&room.conn, &job.id).ok().flatten()
        }
        _ => None,
    }
}

/// ADD-14: on-device OCR for one file. On success, store the recognized text
/// (prefixed so the AI can flag OCR uncertainty), re-index it, and tell the UI.
/// Any failure is silent — the file simply keeps having no text.
fn run_ocr_job(app: &tauri::AppHandle, job: JobMeta) {
    use tauri::{Emitter, Manager};
    let _ = app.emit("ocr-progress", (&job.name, "started"));
    let Some(bytes) = read_job_bytes(app, &job) else { return };
    let Some(text) = ocr::recognize(&job.mime, &job.ext, &bytes) else {
        let _ = app.emit("ocr-progress", (&job.name, "none"));
        return;
    };
    let full_text = format!("(text recognized from scan)\n{text}");
    {
        let state = app.state::<AppState>();
        let guard = state.room.lock().unwrap();
        match guard.as_ref() {
            Some(room) if room.path == job.room_path => {
                let _ = db::update_file_content(&room.conn, &job.id, &bytes, Some(&full_text));
            }
            _ => return,
        }
    }
    let _ = app.emit("room-files-changed", ());
    let _ = app.emit("ocr-progress", (&job.name, "done"));
    // CHG-22: newly-readable file → let the one-liner filler pick it up.
    spawn_summary_filler(app.clone(), job.room_path.clone());
}

#[tauri::command]
pub fn list_files(state: State<'_, AppState>) -> Result<Vec<FileMeta>, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::list_files(&room.conn)
}

const MAX_VIEWER_BYTES: usize = 50 * 1024 * 1024;

#[tauri::command]
pub fn get_file_content(state: State<'_, AppState>, id: String) -> Result<FileContent, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let (name, mime, bytes, extracted) = db::get_file_full(&room.conn, &id)?;
    let mime = mime.unwrap_or_default();
    let bytes = bytes.unwrap_or_default();
    let ext = extraction::extension_of(&name);

    let content = |kind: &str, editable: bool, text: Option<String>, b64: bool| FileContent {
        kind: kind.into(),
        name: name.clone(),
        mime: mime.clone(),
        editable,
        text,
        data_b64: if b64 {
            Some(base64::engine::general_purpose::STANDARD.encode(&bytes))
        } else {
            None
        },
    };

    // Clip huge extracted text at a char boundary for preview/edit payloads.
    let clip = |mut t: String| {
        if t.len() > 1_000_000 {
            let mut cut = 1_000_000;
            while !t.is_char_boundary(cut) {
                cut -= 1;
            }
            t.truncate(cut);
            t.push_str("\n\n… (truncated preview)");
        }
        t
    };

    if extraction::is_image(&mime) && bytes.len() <= MAX_VIEWER_BYTES {
        return Ok(content("image", false, None, true));
    }
    // ADD-18: recordings/videos play in the audio/video viewer, carrying their
    // timestamped transcript so "[m:ss]" lines can seek the player.
    if let Some(kind) = stt::media_kind(&mime, &ext) {
        if bytes.len() <= MAX_VIEWER_BYTES {
            let k = if kind == stt::MediaKind::Video { "video" } else { "audio" };
            return Ok(content(k, false, extracted.map(clip), true));
        }
    }
    match ext.as_str() {
        // PDF/DOCX carry their extracted text too, so the viewer can offer
        // "edit as text" (saved as a new copy — the binary can't round-trip).
        "pdf" if bytes.len() <= MAX_VIEWER_BYTES => {
            return Ok(content("pdf", false, extracted.map(clip), true))
        }
        "docx" if bytes.len() <= MAX_VIEWER_BYTES => {
            return Ok(content("docx", false, extracted.map(clip), true))
        }
        "xlsx" | "xls" if bytes.len() <= MAX_VIEWER_BYTES => {
            return Ok(content("sheet", false, None, true))
        }
        "csv" | "tsv" => {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            return Ok(content("csv", true, Some(text), false));
        }
        "md" | "markdown" => {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            return Ok(content("markdown", true, Some(text), false));
        }
        // HTML runs live in a sandboxed preview iframe (the "runner"); the raw
        // source is editable text that round-trips, so Edit drops to Monaco.
        "html" | "htm" if bytes.len() <= 10 * 1024 * 1024 => {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            return Ok(content("html", true, Some(text), false));
        }
        _ => {}
    }
    // Files whose bytes ARE text: viewable and safely editable in place.
    if extraction::is_text_extension(&ext) && bytes.len() <= 10 * 1024 * 1024 {
        let text = String::from_utf8_lossy(&bytes).into_owned();
        return Ok(content("code", true, Some(text), false));
    }
    // Binary formats we could still read text out of (pptx, markitdown output):
    // preview the extracted text read-only — editing it can't round-trip.
    if let Some(text) = extracted {
        let text = clip(text);
        return Ok(content("text", false, Some(text), false));
    }
    Ok(content("binary", false, None, false))
}

/// The single write path for changing an existing file's bytes. Snapshots the
/// CURRENT bytes into version history (ADD-2) tagged with `cause`, then
/// overwrites and rebuilds the search index. Every caller that mutates a file's
/// content goes through here so nothing is ever irreversibly overwritten.
fn store_file_bytes(
    conn: &Connection,
    id: &str,
    bytes: &[u8],
    text: Option<&str>,
    cause: &str,
) -> Result<(), String> {
    db::snapshot_file_version(conn, id, cause)?;
    db::update_file_content(conn, id, bytes, text)
}

#[tauri::command]
pub fn update_file_content(
    state: State<'_, AppState>,
    id: String,
    content: String,
) -> Result<FileMeta, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let name = db::get_file_name(&room.conn, &id)?;
    let bytes = content.as_bytes();
    let text = extraction::extract_text(&name, bytes).unwrap_or_else(|| content.clone());
    store_file_bytes(&room.conn, &id, bytes, Some(&text), "You saved")?;
    db::get_file_meta(&room.conn, &id)
}

/// Grid editing from the viewer: set one spreadsheet cell and re-index.
#[tauri::command]
pub fn set_cell(
    window: tauri::Window,
    state: State<'_, AppState>,
    id: String,
    sheet: Option<String>,
    cell: String,
    value: String,
) -> Result<(), String> {
    use tauri::Emitter;
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let (name, bytes) = db::get_file_bytes_named(&room.conn, &id)?;
    let bytes = bytes.ok_or("File has no stored content.")?;
    let (new_bytes, text) = set_cell_in_bytes(&name, &bytes, sheet.as_deref(), &cell, &value)?;
    store_file_bytes(&room.conn, &id, &new_bytes, text.as_deref(), "You edited")?;
    let _ = window.emit("room-files-changed", ());
    let _ = window.emit("file-updated", &id);
    Ok(())
}

#[tauri::command]
pub fn delete_file(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::delete_file(&room.conn, &id)
}

#[tauri::command]
pub fn save_generated_file(
    state: State<'_, AppState>,
    name: String,
    content: String,
) -> Result<FileMeta, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let name = if extraction::extension_of(&name).is_empty() {
        format!("{name}.md")
    } else {
        name
    };
    let mime = mime_guess::from_path(&name)
        .first_or(mime_guess::mime::TEXT_PLAIN)
        .essence_str()
        .to_string();
    db::insert_file(
        &room.conn,
        &name,
        &mime,
        content.as_bytes(),
        Some(&content),
        "generated",
    )
}

// ---------------------------------------------------------------- import link (ADD-12)

/// A safe, readable Markdown filename derived from a page title (or its URL when
/// the title is empty). Pure so it can be unit-tested.
fn link_file_name(title: &str, url: &str) -> String {
    let base = title.trim();
    let base = if base.is_empty() { url } else { base };
    // Fold path/reserved characters and collapse whitespace to keep one clean
    // line that is valid as a file name on macOS.
    let folded: String = base
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\n' | '\r' | '\t' => ' ',
            _ => c,
        })
        .collect();
    let cleaned = folded.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut name: String = cleaned.chars().take(80).collect();
    name = name.trim().to_string();
    if name.is_empty() {
        name = "Web page".into();
    }
    format!("{name}.md")
}

/// ADD-12: fetch a web page and save a readable offline copy as a Markdown file.
/// Uses `web::fetch_page` WITH the SEC-5 guard, so private/loopback addresses
/// are refused. An explicit user action, so it works even when the AI's web
/// tools are off. The saved file (source "web") is indexed and searchable.
#[tauri::command]
pub async fn import_link(state: State<'_, AppState>, url: String) -> Result<FileMeta, String> {
    // ADD-19: a YouTube link imports the video's own captions as a timestamped
    // transcript (no video download) instead of the watch page's JS soup.
    let is_youtube = web::youtube_video_id(&url).is_some();
    let (title, text) = if is_youtube {
        web::youtube_transcript(&url).await?
    } else {
        web::fetch_page(&url).await?
    };
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let saved = db::current_date(&room.conn);
    let name = if is_youtube {
        link_file_name(&format!("{title} (transcript)"), &url)
    } else {
        link_file_name(&title, &url)
    };
    let content = format!("# {title}\n\nSource: {url}\nSaved: {saved}\n\n{text}");
    db::insert_file(
        &room.conn,
        &name,
        "text/markdown",
        content.as_bytes(),
        Some(&content),
        "web",
    )
}

// ---------------------------------------------------------------- summarize room (ADD-17)

/// The one canonical, overwrite-in-place summary file (ADD-17). ADD-22: now HTML
/// (the Summarize-Room button generates an HTML page rendered in the sandboxed
/// viewer). The legacy Markdown name is still recognized for exclusion below.
const SUMMARY_FILE_NAME: &str = "Room summary.html";
/// Cap per run so a huge room stays within the small local context; the rest are
/// listed by name with a note.
const MAX_SUMMARY_FILES: usize = 50;

/// True for the app's own generated summary file — excluded from its own summary.
/// Matches both the current HTML name and the legacy "Room summary.md" so an old
/// room's Markdown summary isn't fed back into the new one. A user-uploaded file
/// that happens to share the name is NOT excluded (source must be "generated").
fn is_summary_file(name: &str, source: &str) -> bool {
    (name == SUMMARY_FILE_NAME || name == "Room summary.md") && source == "generated"
}

/// Trim a model reply down to a single clean sentence for a file one-liner.
fn clean_one_liner(raw: &str) -> String {
    let line = strip_markup_blocks(raw)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .trim_start_matches(['-', '*', '#', '>', ' '])
        .to_string();
    line.chars().take(200).collect::<String>().trim().to_string()
}

/// ADD-17 map step: one short call describing a single file in a sentence.
/// `keep_alive` lets the background filler use a short warmth (CHG-22) so it
/// never pins the model in RAM, while the interactive path keeps it warm.
async fn summarize_one_file(
    model: &str,
    name: &str,
    mime: &str,
    text: &str,
    keep_alive: &str,
) -> Result<String, String> {
    let messages = vec![
        ollama::ChatMessage::new(
            "system",
            "You describe a single file in ONE short, factual sentence based only on what is given.",
        ),
        ollama::ChatMessage::new(
            "user",
            format!(
                "File name: {name}\nType: {mime}\n\nBeginning of its text:\n{text}\n\n\
                 In one sentence, what is this file about?"
            ),
        ),
    ];
    // ADD-22: a single guaranteed string field, so a chatty model can't wrap the
    // sentence in preamble/markup that clean_one_liner then has to strip.
    let schema = serde_json::json!({
        "type": "object",
        "properties": {"summary": {"type": "string"}},
        "required": ["summary"]
    });
    let raw = ollama::chat_structured(model, messages, Some(0.2), keep_alive, &schema).await?;
    let summary = serde_json::from_str::<serde_json::Value>(raw.trim())
        .ok()
        .and_then(|v| v.get("summary").and_then(|s| s.as_str()).map(str::to_string))
        .unwrap_or(raw);
    Ok(clean_one_liner(&summary))
}

/// ADD-17 reduce step: one call producing the "What this room is for" paragraph
/// and three suggested questions, given the per-file one-liners for context. The
/// deterministic file list is assembled by the caller (never invented here).
async fn combine_summary(
    model: &str,
    room_name: &str,
    memories: &[String],
    file_lines: &str,
) -> Result<(String, Vec<String>), String> {
    let mut context = format!("Room name: {room_name}\n\nFiles and what each is:\n{file_lines}\n");
    if !memories.is_empty() {
        context.push_str("\nMemory notes the user saved for this room:\n");
        for m in memories {
            context.push_str(&format!("- {m}\n"));
        }
    }
    let messages = vec![
        ollama::ChatMessage::new(
            "system",
            "You summarize a personal document room. Write a 'purpose' of 2-4 sentences \
             describing what the room is for, and exactly three example questions the files \
             could answer. Base everything only on the information given; do not list the files.",
        ),
        ollama::ChatMessage::new("user", context),
    ];
    // ADD-22: the two sections used to be begged for in prose and salvaged by
    // split_summary_sections. Now the model fills a guaranteed shape and returns
    // (purpose, questions); the caller assembles the HTML page from these plus
    // the deterministic file list.
    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "purpose": {"type": "string"},
            "questions": {
                "type": "array",
                "items": {"type": "string"},
                "minItems": 3,
                "maxItems": 3
            }
        },
        "required": ["purpose", "questions"]
    });
    let raw = ollama::chat_structured(model, messages, Some(0.4), KEEP_ALIVE_WARM, &schema).await?;
    let parsed: serde_json::Value = serde_json::from_str(raw.trim()).unwrap_or_default();
    let purpose = parsed.get("purpose").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let questions: Vec<String> = parsed
        .get("questions")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|q| q.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Ok((purpose, questions))
}

/// ADD-17: generate (or refresh) the room's single "Room summary.md" via a
/// two-step map-reduce, caching each file's one-liner so re-runs only summarize
/// new or changed files. Emits `summarize-progress` while running. Writes
/// nothing if the model is unreachable (returns the normal friendly error).
#[tauri::command]
pub async fn summarize_room(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<FileMeta, String> {
    use tauri::Emitter;

    // Phase 1 (locked): pull the room name, memories and the file rows.
    let (room_name, explicit_model, memories, files, existing_id) = {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        let conn = &room.conn;
        let all = db::list_files_for_summary(conn)?;
        // Overwrite only the current (HTML) summary; a legacy .md summary is left
        // alone (and excluded from the new one via is_summary_file).
        let existing_id = all
            .iter()
            .find(|f| f.name == SUMMARY_FILE_NAME && f.source == "generated")
            .map(|f| f.id.clone());
        let files: Vec<db::SummaryFile> = all
            .into_iter()
            .filter(|f| !is_summary_file(&f.name, &f.source))
            .collect();
        let memories: Vec<String> =
            db::list_memories(conn)?.into_iter().map(|m| m.content).collect();
        (room.name.clone(), model_setting(conn), memories, files, existing_id)
    };

    if files.is_empty() {
        return Err("This room has no files to summarize yet.".into());
    }

    // Summarization always runs on a LOCAL model (map-reduce needs many small
    // calls); if a cloud engine is selected, fall back to the default local one.
    let models = ollama::list_models()
        .await
        .map_err(|_| "The local AI (Ollama) isn't running — start it and try again.".to_string())?;
    if models.is_empty() {
        return Err("No local AI model is installed yet — download one first.".into());
    }
    let mut model = explicit_model.unwrap_or_else(|| best_default(&models));
    if is_external_engine(&model) {
        model = best_default(&models);
    }

    let capped = files.len() > MAX_SUMMARY_FILES;
    let to_do = files.len().min(MAX_SUMMARY_FILES);

    // Map: a one-liner per file, reusing the cache and filling any gaps.
    // `file_lines` is the text context handed to the reduce step; `file_items`
    // (display, one-liner) drives the deterministic HTML file list.
    let mut file_lines = String::new();
    let mut file_items: Vec<(String, Option<String>)> = Vec::new();
    for (i, f) in files.iter().take(MAX_SUMMARY_FILES).enumerate() {
        let _ = window.emit(
            "summarize-progress",
            format!("Summarizing file {} of {}…", i + 1, to_do),
        );
        let display = match &f.folder {
            Some(folder) => format!("{folder}/{}", f.name),
            None => f.name.clone(),
        };
        let one_liner = if let Some(cached) = &f.ai_summary {
            cached.clone()
        } else if f.text.as_deref().map_or(true, |t| t.trim().is_empty()) {
            // No extractable text (e.g. an image without OCR): list by name and
            // type only, never invent content.
            String::new()
        } else {
            let snippet = f.text.as_deref().unwrap_or("");
            // CHG-26: one flaky file must not abort the whole run. A
            // non-transient error (Ollama down / model missing) still aborts —
            // every remaining call would fail too — but a one-off error just
            // degrades this file to name-and-type (and, being uncached, retries
            // on the next run).
            match summarize_one_file(&model, &f.name, &f.mime, snippet, KEEP_ALIVE_WARM).await {
                Ok(liner) => {
                    if !liner.is_empty() {
                        if let Some(room) = state.room.lock().unwrap().as_ref() {
                            let _ = db::set_file_ai_summary(&room.conn, &f.id, &liner);
                        }
                    }
                    liner
                }
                Err(e) if e == "OLLAMA_DOWN" || e.starts_with("MODEL_MISSING") => {
                    return Err(e);
                }
                Err(_) => String::new(),
            }
        };
        if one_liner.is_empty() {
            file_lines.push_str(&format!("- {display} ({})\n", f.mime));
            file_items.push((display, None));
        } else {
            file_lines.push_str(&format!("- {display} — {one_liner}\n"));
            file_items.push((display, Some(one_liner)));
        }
    }

    // Reduce: purpose paragraph + suggested questions. CHG-24: run the reduce on
    // ONLY the summarized files' one-liners — the beyond-cap name-only tail is
    // for the deterministic "## Files" section and is appended AFTER, so it
    // never crowds the 8K context the model actually needs here.
    let _ = window.emit("summarize-progress", "Writing the summary…");
    let (purpose, questions) = combine_summary(&model, &room_name, &memories, &file_lines).await?;

    if capped {
        for f in files.iter().skip(MAX_SUMMARY_FILES) {
            let display = match &f.folder {
                Some(folder) => format!("{folder}/{}", f.name),
                None => f.name.clone(),
            };
            file_items.push((display, None));
        }
    }

    // ADD-22: assemble a self-contained HTML page (rendered in the sandboxed,
    // network-blocked viewer). Purpose + questions come from the model as
    // guaranteed fields; the file list is deterministic. Everything is escaped.
    let saved_date = {
        let guard = state.room.lock().unwrap();
        guard
            .as_ref()
            .map(|room| db::current_date(&room.conn))
            .unwrap_or_default()
    };
    let mut body = format!("<p><em>Generated on {}</em></p>\n", html_escape(&saved_date));
    body.push_str("<h2>What this room is for</h2>\n");
    body.push_str(&format!(
        "<p>{}</p>\n",
        if purpose.is_empty() {
            "A personal document room.".to_string()
        } else {
            html_escape(&purpose)
        }
    ));
    body.push_str("<h2>Files</h2>\n<ul>\n");
    for (display, liner) in &file_items {
        match liner {
            Some(l) => body.push_str(&format!(
                "<li><strong>{}</strong> — {}</li>\n",
                html_escape(display),
                html_escape(l)
            )),
            None => body.push_str(&format!("<li><strong>{}</strong></li>\n", html_escape(display))),
        }
    }
    body.push_str("</ul>\n");
    if capped {
        body.push_str(&format!(
            "<p><em>Only the first {MAX_SUMMARY_FILES} files were summarized; the rest are listed by name.</em></p>\n"
        ));
    }
    if !questions.is_empty() {
        body.push_str("<h2>Try asking</h2>\n<ol>\n");
        for q in &questions {
            body.push_str(&format!("<li>{}</li>\n", html_escape(q)));
        }
        body.push_str("</ol>\n");
    }
    let content = html_document(&format!("{room_name} — Room summary"), &body);

    // Phase 3 (locked): write the ONE canonical summary file — overwrite in
    // place (ADD-2 keeps the previous versions) or create it the first time.
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let meta = match existing_id {
        Some(id) => {
            store_file_bytes(&room.conn, &id, content.as_bytes(), Some(&content), "Summarized")?;
            db::get_file_meta(&room.conn, &id)?
        }
        None => db::insert_file(
            &room.conn,
            SUMMARY_FILE_NAME,
            "text/html",
            content.as_bytes(),
            Some(&content),
            "generated",
        )?,
    };
    let _ = window.emit("room-files-changed", ());
    Ok(meta)
}

// ---------------------------------------------------------------- data safety

/// ADD-2: a file's saved versions (newest first).
#[tauri::command]
pub fn list_file_versions(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<FileVersion>, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::list_file_versions(&room.conn, &id)
}

/// ADD-2: restore a saved version's bytes. Goes back through `store_file_bytes`,
/// so the CURRENT state is snapshotted first — restoring is itself undoable.
#[tauri::command]
pub fn restore_file_version(
    window: tauri::Window,
    state: State<'_, AppState>,
    version_id: String,
) -> Result<(), String> {
    use tauri::Emitter;
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let (file_id, bytes) = db::get_version(&room.conn, &version_id)?;
    let name = db::get_file_name(&room.conn, &file_id)?;
    let text = extraction::extract_text(&name, &bytes)
        .or_else(|| String::from_utf8(bytes.clone()).ok());
    store_file_bytes(&room.conn, &file_id, &bytes, text.as_deref(), "Restored")?;
    let _ = window.emit("room-files-changed", ());
    let _ = window.emit("file-updated", &file_id);
    Ok(())
}

/// ADD-1: write one file's original bytes out as a normal (unencrypted) file.
#[tauri::command]
pub fn export_file(
    state: State<'_, AppState>,
    id: String,
    dest_path: String,
) -> Result<(), String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let bytes = db::get_file_bytes(&room.conn, &id)?
        .ok_or("This file has no stored content to export.")?;
    std::fs::write(&dest_path, &bytes).map_err(|e| format!("Could not save the file: {e}"))?;
    Ok(())
}

/// Choose a destination name inside a folder that will not overwrite anything:
/// on a clash, insert " (2)", " (3)", … before the extension. `is_taken`
/// reports whether a candidate name already exists.
fn unique_export_name(name: &str, is_taken: impl Fn(&str) -> bool) -> String {
    if !is_taken(name) {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (name[..i].to_string(), name[i..].to_string()),
        _ => (name.to_string(), String::new()),
    };
    let mut n = 2u32;
    loop {
        let candidate = format!("{stem} ({n}){ext}");
        if !is_taken(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// ADD-1: export every file into `dest_dir`, never overwriting. Returns the
/// number written.
#[tauri::command]
pub fn export_all(state: State<'_, AppState>, dest_dir: String) -> Result<u32, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let dir = std::path::Path::new(&dest_dir);
    if !dir.is_dir() {
        return Err("Choose a folder to export into.".into());
    }
    let files = db::list_files(&room.conn)?;
    let mut written = 0u32;
    for f in files {
        let bytes = db::get_file_bytes(&room.conn, &f.id)?.unwrap_or_default();
        // Files written earlier this run land on disk, so the existence check
        // also dedups same-named files against each other.
        let name = unique_export_name(&f.name, |candidate| dir.join(candidate).exists());
        std::fs::write(dir.join(&name), &bytes)
            .map_err(|e| format!("Could not write \"{name}\": {e}"))?;
        written += 1;
    }
    Ok(written)
}

/// SEC-4: rotate the room's password. Verifies `current` on a second throwaway
/// connection, then re-keys the live connection.
#[tauri::command]
pub fn change_password(
    state: State<'_, AppState>,
    current: String,
    new_password: String,
) -> Result<(), String> {
    if new_password.chars().count() < 8 {
        return Err("Password must be at least 8 characters.".into());
    }
    let mut guard = state.room.lock().unwrap();
    let room = guard.as_mut().ok_or("No room is open.")?;
    db::verify_password(&room.path, &current)?;
    db::rekey(&room.conn, &new_password)?;
    room.password = new_password;
    // ADD-11: keep Touch ID working after a password change. Chosen behavior:
    // UPDATE the Keychain entry with the new password (re-store overwrites it).
    // Storing creates a fresh biometric item and needs no prompt. If it somehow
    // fails, delete the stale entry so Touch ID can never hand back the old
    // password — the room then falls back to typing until re-enabled.
    if crate::biometrics::has(&room.path)
        && crate::biometrics::store(&room.path, &room.password).is_err()
    {
        let _ = crate::biometrics::delete(&room.path);
    }
    Ok(())
}

/// ADD-4: a full copy of the open room as it is now, optionally with its own
/// new password. The original is never touched.
#[tauri::command]
pub fn duplicate_room(
    state: State<'_, AppState>,
    dest_path: String,
    new_password: Option<String>,
) -> Result<(), String> {
    if let Some(pw) = &new_password {
        if pw.chars().count() < 8 {
            return Err("Password must be at least 8 characters.".into());
        }
    }
    if std::path::Path::new(&dest_path).exists() {
        return Err("A file already exists at that location.".into());
    }
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::vacuum_into(&room.conn, &dest_path)?;
    if let Some(pw) = new_password {
        if let Err(e) = db::rekey_copy(&dest_path, &room.password, &pw) {
            let _ = std::fs::remove_file(&dest_path);
            return Err(e);
        }
    }
    Ok(())
}

/// SEC-7: compact the open room on demand, reporting how much was reclaimed.
#[tauri::command]
pub fn compact_room(state: State<'_, AppState>) -> Result<String, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let reclaimable = db::reclaimable_bytes(&room.conn)?;
    let mb = reclaimable as f64 / (1024.0 * 1024.0);
    if mb < 0.05 {
        return Ok("Nothing to recover.".into());
    }
    db::vacuum(&room.conn)?;
    Ok(format!("Recovered {mb:.1} MB."))
}

// ---------------------------------------------------------------- recent rooms (ADD-5)

/// Path to the recent-rooms list in the app's own data folder (outside any
/// room). Rooms are encrypted; this file holds only names and paths.
fn recent_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager as _;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("recent.json"))
}

fn read_recent(app: &tauri::AppHandle) -> Vec<RecentRoom> {
    recent_file(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_recent(app: &tauri::AppHandle, list: &[RecentRoom]) -> Result<(), String> {
    let path = recent_file(app)?;
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// Push a room to the front of the recents: most-recent-first, deduped by path,
/// capped at 5.
fn merge_recent(mut list: Vec<RecentRoom>, entry: RecentRoom) -> Vec<RecentRoom> {
    list.retain(|r| r.path != entry.path);
    list.insert(0, entry);
    list.truncate(5);
    list
}

fn push_recent(app: &tauri::AppHandle, name: &str, path: &str) {
    let opened_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64);
    let list = merge_recent(
        read_recent(app),
        RecentRoom {
            name: name.to_string(),
            path: path.to_string(),
            opened_at,
        },
    );
    let _ = write_recent(app, &list);
}

#[tauri::command]
pub fn list_recent(app: tauri::AppHandle) -> Result<Vec<RecentRoom>, String> {
    Ok(read_recent(&app))
}

#[tauri::command]
pub fn remove_recent(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let mut list = read_recent(&app);
    list.retain(|r| r.path != path);
    write_recent(&app, &list)
}

#[tauri::command]
pub fn clear_recent(app: tauri::AppHandle) -> Result<(), String> {
    write_recent(&app, &[])
}

// ---------------------------------------------------------------- memory

/// UX-5: an existing memory whose normalized text equals `content`'s, if any.
/// Shared by the UI command and the AI tool so neither path can create an exact
/// duplicate (ignoring case and whitespace).
fn duplicate_memory(conn: &Connection, content: &str) -> Result<Option<Memory>, String> {
    let norm = normalize_for_match(content);
    Ok(db::list_memories(conn)?
        .into_iter()
        .find(|m| normalize_for_match(&m.content) == norm))
}

#[tauri::command]
pub fn add_memory(state: State<'_, AppState>, content: String) -> Result<Memory, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    // CHG-7: cap length so injected memories stay within the prompt budget.
    let content = clamp_bytes(content, MAX_MEMORY_CONTENT_CHARS);
    // UX-5: never store an exact duplicate; hand back the existing entry instead.
    if let Some(existing) = duplicate_memory(&room.conn, &content)? {
        return Ok(existing);
    }
    db::add_memory(&room.conn, &content)
}

#[tauri::command]
pub fn list_memories(state: State<'_, AppState>) -> Result<Vec<Memory>, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::list_memories(&room.conn)
}

/// UX-5: edit a memory's text in place.
#[tauri::command]
pub fn update_memory(state: State<'_, AppState>, id: String, content: String) -> Result<(), String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let content = clamp_bytes(content, MAX_MEMORY_CONTENT_CHARS);
    db::update_memory(&room.conn, &id, &content)
}

#[tauri::command]
pub fn delete_memory(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::delete_memory(&room.conn, &id)
}

// ---------------------------------------------------------------- folders (ADD-16)

#[tauri::command]
pub fn list_folders(state: State<'_, AppState>) -> Result<Vec<Folder>, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::list_folders(&room.conn)
}

#[tauri::command]
pub fn create_folder(state: State<'_, AppState>, name: String) -> Result<Folder, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::create_folder(&room.conn, &name)
}

#[tauri::command]
pub fn rename_folder(state: State<'_, AppState>, id: String, name: String) -> Result<(), String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::rename_folder(&room.conn, &id, &name)
}

#[tauri::command]
pub fn rename_file(state: State<'_, AppState>, id: String, name: String) -> Result<(), String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::rename_file(&room.conn, &id, &name)
}

#[tauri::command]
pub fn delete_folder(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::delete_folder(&room.conn, &id)
}

#[tauri::command]
pub fn move_file_to_folder(
    state: State<'_, AppState>,
    file_id: String,
    folder_id: Option<String>,
) -> Result<(), String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::move_file_to_folder(&room.conn, &file_id, folder_id.as_deref())
}

// ---------------------------------------------------------------- search (ADD-6)

/// ADD-6: search the user's own room across file names + content, chat
/// messages, and memories. File content rides the FTS5 index (HLT-3); messages
/// and memories use LIKE. Every hit carries a short snippet for the overlay.
#[tauri::command]
pub fn search_all(state: State<'_, AppState>, query: String) -> Result<SearchResults, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let conn = &room.conn;
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(SearchResults {
            files: Vec::new(),
            messages: Vec::new(),
            memories: Vec::new(),
        });
    }
    let needle = trimmed.to_lowercase();

    // Files: content hits (FTS) first, then name-only matches not already shown.
    let mut files: Vec<FileHit> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Some(expr) = fts_match_expr(question_terms(trimmed).iter().map(String::as_str))
        .or_else(|| fts_match_expr(std::iter::once(needle.as_str())))
    {
        for (id, name, chunk) in db::files_content_fts(conn, &expr, 15)? {
            if seen.insert(id.clone()) {
                files.push(FileHit {
                    id,
                    name,
                    snippet: make_snippet(&chunk, trimmed, 60),
                });
            }
        }
    }
    for (id, name) in db::files_name_like(conn, &needle)? {
        if seen.insert(id.clone()) {
            files.push(FileHit {
                snippet: name.clone(),
                id,
                name,
            });
        }
    }

    let messages = db::messages_like(conn, &needle)?
        .into_iter()
        .map(|(chat_id, message_id, content)| MessageHit {
            chat_id,
            message_id,
            snippet: make_snippet(&content, trimmed, 60),
        })
        .collect();

    let memories = db::memories_like(conn, &needle)?
        .into_iter()
        .map(|(id, content)| MemoryHit {
            snippet: make_snippet(&content, trimmed, 60),
            id,
        })
        .collect();

    Ok(SearchResults {
        files,
        messages,
        memories,
    })
}

// ---------------------------------------------------------------- settings

#[tauri::command]
pub fn get_setting(state: State<'_, AppState>, key: String) -> Result<Option<String>, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    Ok(db::get_setting(&room.conn, &key))
}

#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::set_setting(&room.conn, &key, &value)
}

// ---------------------------------------------------------------- mcp

#[tauri::command]
pub fn mcp_get_config(state: State<'_, AppState>) -> Result<String, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    Ok(db::get_setting(&room.conn, MCP_CONFIG_KEY).unwrap_or_else(|| DEFAULT_MCP_CONFIG.to_string()))
}

#[tauri::command]
pub fn mcp_apply_config(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    json: String,
) -> Result<Vec<mcp::ServerStatus>, String> {
    let servers = mcp::parse_config(&json)?;
    {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        db::set_setting(&room.conn, MCP_CONFIG_KEY, &json)?;
    }
    // SEC-1: the user just typed and saved this config, which counts as
    // approval — remember its fingerprint so reopening the room won't re-ask.
    add_mcp_approval(&app, &mcp_fingerprint(&json));
    start_mcp_connections(app, servers);
    Ok(state.mcp.lock().unwrap().statuses())
}

/// SEC-1: SHA-256 of the room's mcp_config JSON, hex-encoded. Any change to the
/// config text changes the fingerprint, so an old approval no longer counts.
fn mcp_fingerprint(config_json: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(config_json.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// SEC-1: the full command line a server would run, e.g. "uvx duckduckgo-mcp-server".
/// Shown in the approval dialog so the user sees exactly what would execute.
fn render_command_line(cfg: &mcp::ServerConfig) -> String {
    let mut parts = Vec::with_capacity(1 + cfg.args.len());
    parts.push(cfg.command.clone());
    parts.extend(cfg.args.iter().cloned());
    parts.join(" ")
}

/// Approved MCP fingerprints live OUTSIDE any room, in the app's own data
/// folder — the room's author is the attacker, so approvals are per-Mac and
/// never travel inside the `.roomai` file (SEC-1).
fn mcp_approvals_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager as _;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("mcp_approvals.json"))
}

fn read_mcp_approvals(app: &tauri::AppHandle) -> Vec<String> {
    mcp_approvals_file(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

fn add_mcp_approval(app: &tauri::AppHandle, fingerprint: &str) {
    let mut list = read_mcp_approvals(app);
    if list.iter().any(|f| f == fingerprint) {
        return;
    }
    list.push(fingerprint.to_string());
    if let Ok(path) = mcp_approvals_file(app) {
        if let Ok(json) = serde_json::to_string_pretty(&list) {
            let _ = std::fs::write(path, json);
        }
    }
}

/// SEC-1: the spawn/approval decision for a room's MCP config, decided PURELY
/// from the config text and the set of already-approved fingerprints — no I/O,
/// so it is unit-testable. `refresh_mcp` (the spawner) and `pending_mcp_for`
/// (the dialog) both route through this, so they can never disagree about
/// whether a config is allowed to run.
#[cfg_attr(not(test), allow(dead_code))]
enum McpGate {
    /// No enabled servers — spawn nothing, show no dialog.
    Nothing,
    /// Enabled servers whose exact config is already approved — start them.
    Start(Vec<(String, mcp::ServerConfig)>),
    /// Enabled servers whose fingerprint is NOT approved — spawn nothing and
    /// ask the user first. `servers` are the enabled ones, for the dialog.
    NeedsApproval {
        fingerprint: String,
        servers: Vec<(String, mcp::ServerConfig)>,
    },
}

fn mcp_gate(config_json: &str, approved: &std::collections::HashSet<String>) -> McpGate {
    let servers = match mcp::parse_config(config_json) {
        Ok(s) => s,
        Err(_) => return McpGate::Nothing,
    };
    if !servers.iter().any(|(_, c)| !c.disabled) {
        return McpGate::Nothing;
    }
    let fingerprint = mcp_fingerprint(config_json);
    if approved.contains(&fingerprint) {
        return McpGate::Start(servers);
    }
    let enabled = servers.into_iter().filter(|(_, c)| !c.disabled).collect();
    McpGate::NeedsApproval {
        fingerprint,
        servers: enabled,
    }
}

/// SEC-1: if the open room's config has ENABLED servers whose fingerprint isn't
/// approved on this Mac, describe them for the approval dialog. None otherwise
/// (no enabled servers, or already approved).
fn pending_mcp_for(app: &tauri::AppHandle, conn: &Connection) -> Option<McpApproval> {
    let config = db::get_setting(conn, MCP_CONFIG_KEY)?;
    let approved: std::collections::HashSet<String> =
        read_mcp_approvals(app).into_iter().collect();
    match mcp_gate(&config, &approved) {
        McpGate::NeedsApproval {
            fingerprint,
            servers,
        } => Some(McpApproval {
            fingerprint,
            servers: servers
                .iter()
                .map(|(name, cfg)| McpServerBrief {
                    name: name.clone(),
                    command: render_command_line(cfg),
                })
                .collect(),
        }),
        McpGate::Start(_) | McpGate::Nothing => None,
    }
}

/// SEC-1: approve the currently open room's plug-in config on this Mac, then
/// start its servers and return their statuses. Declining is simply never
/// calling this — the servers stay stopped.
#[tauri::command]
pub fn approve_mcp(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    fingerprint: String,
) -> Result<Vec<mcp::ServerStatus>, String> {
    add_mcp_approval(&app, &fingerprint);
    refresh_mcp(&app);
    Ok(state.mcp.lock().unwrap().statuses())
}

#[tauri::command]
pub fn mcp_status(state: State<'_, AppState>) -> Result<Vec<mcp::ServerStatus>, String> {
    Ok(state.mcp.lock().unwrap().statuses())
}

/// (Re)connect servers from the open room's saved config. Runs in the
/// background — opening a room must not wait on `uvx` downloads.
fn refresh_mcp(app: &tauri::AppHandle) {
    use tauri::Manager as _;
    let state = app.state::<AppState>();
    let config_json: Option<String> = {
        let guard = state.room.lock().unwrap();
        guard
            .as_ref()
            .and_then(|room| db::get_setting(&room.conn, MCP_CONFIG_KEY))
    };
    // SEC-1: never auto-spawn a room's plug-ins without a per-Mac approval of
    // this exact config. If the gate says NeedsApproval, start NOTHING — the UI
    // surfaces the approval dialog via RoomInfo.pendingMcp and calls approve_mcp
    // on "Allow". This is the SAME decision pending_mcp_for shows the user.
    let approved: std::collections::HashSet<String> =
        read_mcp_approvals(app).into_iter().collect();
    if let Some(McpGate::NeedsApproval { .. }) =
        config_json.as_deref().map(|j| mcp_gate(j, &approved))
    {
        return;
    }
    // Approved, or only-disabled/no config: register the parsed servers (disabled
    // ones simply show as Disabled; enabled+approved ones connect).
    let servers = config_json
        .as_deref()
        .and_then(|j| mcp::parse_config(j).ok())
        .unwrap_or_default();
    start_mcp_connections(app.clone(), servers);
}

fn start_mcp_connections(app: tauri::AppHandle, servers: Vec<(String, mcp::ServerConfig)>) {
    use tauri::{Emitter, Manager as _};
    let generation = {
        let state = app.state::<AppState>();
        let mut mgr = state.mcp.lock().unwrap();
        mgr.generation += 1;
        mgr.servers = servers
            .iter()
            .map(|(name, cfg)| mcp::Server {
                name: name.clone(),
                status: if cfg.disabled {
                    mcp::Status::Disabled
                } else {
                    mcp::Status::Connecting
                },
                error: None,
                tools: Vec::new(),
                client: None,
            })
            .collect();
        mgr.generation
    };
    let _ = app.emit("mcp-status", app.state::<AppState>().mcp.lock().unwrap().statuses());
    for (name, cfg) in servers.into_iter().filter(|(_, c)| !c.disabled) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let result = mcp::Client::connect(&cfg).await;
            let state = app.state::<AppState>();
            {
                let mut mgr = state.mcp.lock().unwrap();
                // A newer config was applied while we were connecting.
                if mgr.generation != generation {
                    return;
                }
                if let Some(entry) = mgr.servers.iter_mut().find(|s| s.name == name) {
                    match result {
                        Ok((client, tools)) => {
                            entry.status = mcp::Status::Connected;
                            entry.tools = tools;
                            entry.client = Some(Arc::new(tokio::sync::Mutex::new(client)));
                        }
                        Err(e) => {
                            entry.status = mcp::Status::Failed;
                            entry.error = Some(e);
                        }
                    }
                }
            }
            let _ = app.emit("mcp-status", app.state::<AppState>().mcp.lock().unwrap().statuses());
        });
    }
}

// ---------------------------------------------------------------- chat / AI

/// Chat default: `DEFAULT_MODEL` (qwen3.5:4b) — text + vision + tool calling,
/// no hidden "thinking" pass. Falls back to the first installed model when the
/// default isn't present.
fn best_default(models: &[String]) -> String {
    if models.is_empty() || models.iter().any(|m| m.starts_with(DEFAULT_MODEL)) {
        return DEFAULT_MODEL.to_string();
    }
    models[0].clone()
}

/// Grounding ("where is X") routes to a Qwen-VL model: measured on a known
/// target, gemma3 puts boxes in the wrong place while qwen2.5vl is accurate
/// without qwen3's slow thinking pass.
fn vision_model(models: &[String], chat_model: &str) -> String {
    models
        .iter()
        .find(|m| m.contains("qwen2.5vl") || m.contains("qwen2.5-vl"))
        .or_else(|| models.iter().find(|m| m.contains("qwen3-vl")))
        .cloned()
        .unwrap_or_else(|| chat_model.to_string())
}

/// HLT-5: keep the chat model resident this long so follow-up questions are
/// snappy. Vision/grounding calls may override this (see `vision_keep_alive`).
const KEEP_ALIVE_WARM: &str = "30m";
/// HLT-5: release a distinct vision model quickly on low-RAM machines.
const KEEP_ALIVE_SHORT: &str = "2m";
/// HLT-5: machines at or above this stay warm even for a second model.
const HIGH_RAM_THRESHOLD_BYTES: u64 = 32 * 1024 * 1024 * 1024;

/// Total physical RAM in bytes, read once (sysinfo). Cached — the value doesn't
/// change while the app runs, and refreshing memory info is not free.
fn total_ram_bytes() -> u64 {
    static RAM: OnceLock<u64> = OnceLock::new();
    *RAM.get_or_init(|| {
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        sys.total_memory()
    })
}

/// HLT-5: how long a vision/grounding call should keep its model resident.
///
/// When the vision model IS the chat model, only one model is ever loaded, so
/// keeping it warm costs nothing — use the warm value. When they differ, holding
/// BOTH resident for 30 minutes has overwhelmed and crashed Ollama on 16 GB
/// Macs. So on machines under 32 GB we release the vision model right after the
/// grounding call (a short keep_alive): repeated marking pays a reload, which is
/// the right tradeoff for stability. Machines with >= 32 GB have the headroom to
/// keep it warm for snappier repeated marking. The chat model always stays warm.
fn vision_keep_alive(total_ram: u64, vision_model: &str, chat_model: &str) -> &'static str {
    if vision_model == chat_model || total_ram >= HIGH_RAM_THRESHOLD_BYTES {
        KEEP_ALIVE_WARM
    } else {
        KEEP_ALIVE_SHORT
    }
}

const MAX_VISION_DIM: u32 = 1024;

/// Normalize an image for the model: transcode to PNG (Ollama only decodes
/// PNG/JPEG — WebP/HEIC/mislabeled files fail with "unknown format") and
/// downscale so vision prefill stays fast. Returns (bytes, width, height).
fn prepare_image(bytes: &[u8]) -> (Vec<u8>, f64, f64) {
    match image::load_from_memory(bytes) {
        Ok(img) => {
            let img = if img.width() > MAX_VISION_DIM || img.height() > MAX_VISION_DIM {
                img.thumbnail(MAX_VISION_DIM, MAX_VISION_DIM)
            } else {
                img
            };
            let (w, h) = (img.width() as f64, img.height() as f64);
            let mut out = Vec::new();
            if img
                .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
                .is_ok()
            {
                (out, w, h)
            } else {
                (bytes.to_vec(), w, h)
            }
        }
        Err(_) => {
            let (w, h) = imagesize::blob_size(bytes)
                .map(|s| (s.width as f64, s.height as f64))
                .unwrap_or((1000.0, 1000.0));
            (bytes.to_vec(), w, h)
        }
    }
}

/// The grounding prompt Qwen-VL models were trained on.
fn grounding_prompt(query: &str, w: f64, h: f64) -> String {
    format!(
        "Outline the position of each instance of the following in this \
         {w:.0}x{h:.0} pixel image: {query}\n\
         Output ONLY a JSON array, no other text, in the format \
         [{{\"bbox_2d\": [x1, y1, x2, y2], \"label\": \"<short name>\"}}]. \
         One element per match, each with a distinct descriptive label. \
         If it is not in the image, output []."
    )
}

/// ADD-22: JSON schema handed to Ollama `format` for the grounding pass, so a
/// small vision model can only ever emit a well-formed box array. `parse_boxes`
/// still handles the coordinate-scale ambiguity (pixel vs 0-1000) a schema
/// can't express, but no longer has to salvage prose or malformed JSON.
fn boxes_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "bbox_2d": {
                    "type": "array",
                    "items": {"type": "number"},
                    "minItems": 4,
                    "maxItems": 4
                },
                "label": {"type": "string"}
            },
            "required": ["bbox_2d", "label"]
        }
    })
}

fn model_setting(conn: &Connection) -> Option<String> {
    db::get_setting(conn, "model")
}

#[tauri::command]
pub async fn ai_status(state: State<'_, AppState>) -> Result<AiStatus, String> {
    let explicit = {
        let guard = state.room.lock().unwrap();
        guard.as_ref().and_then(|room| model_setting(&room.conn))
    };
    let external = tauri::async_runtime::spawn_blocking(detect_external_blocking)
        .await
        .unwrap_or_default();
    // ADD-21: keep the advisor gate's cache current with what Settings shows.
    *state.external_cache.lock().unwrap() = Some(external.clone());
    let installed = tauri::async_runtime::spawn_blocking(ollama_installed_blocking)
        .await
        .unwrap_or(false);
    match ollama::list_models().await {
        Ok(models) => {
            let default_model = explicit.unwrap_or_else(|| best_default(&models));
            Ok(AiStatus {
                running: true,
                // Reachable means installed, regardless of the app-path check.
                installed: true,
                models,
                default_model,
                external,
            })
        }
        Err(_) => Ok(AiStatus {
            running: false,
            installed,
            models: vec![],
            default_model: explicit.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
            external,
        }),
    }
}

/// ADD-22: a model's tool/vision capabilities, so Settings can badge each model
/// and warn when the chosen one can't drive the app. `/api/show` is metadata
/// only (no model load); an unreachable Ollama yields an empty list.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelCaps {
    pub name: String,
    pub tools: bool,
    pub vision: bool,
}

#[tauri::command]
pub async fn model_capabilities() -> Result<Vec<ModelCaps>, String> {
    let models = ollama::list_models().await.unwrap_or_default();
    let mut out = Vec::with_capacity(models.len());
    for m in models {
        let caps = ollama::capabilities(&m).await;
        out.push(ModelCaps {
            tools: caps.iter().any(|c| c == "tools"),
            vision: caps.iter().any(|c| c == "vision"),
            name: m,
        });
    }
    Ok(out)
}

/// ADD-10: launch the Ollama app so a first-time user never touches a terminal.
#[tauri::command]
pub fn open_ollama() -> Result<(), String> {
    std::process::Command::new("open")
        .args(["-a", "Ollama"])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open Ollama: {e}"))
}

#[tauri::command]
pub async fn warm_model(state: State<'_, AppState>) -> Result<(), String> {
    let explicit = {
        let guard = state.room.lock().unwrap();
        guard.as_ref().and_then(|room| model_setting(&room.conn))
    };
    let models = ollama::list_models().await.unwrap_or_default();
    let mut chat_model = explicit.unwrap_or_else(|| best_default(&models));
    // Cloud CLIs need no warm-up; pre-load the local model instead so
    // vision/marking stays fast.
    if is_external_engine(&chat_model) {
        if models.is_empty() {
            return Ok(());
        }
        chat_model = best_default(&models);
    }
    // Warm ONLY one model: keeping two resident overwhelms 16 GB machines
    // and takes Ollama down.
    ollama::warm(&chat_model).await
}

#[tauri::command]
pub fn list_chats(state: State<'_, AppState>) -> Result<Vec<Chat>, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::list_chats(&room.conn)
}

#[tauri::command]
pub fn create_chat(state: State<'_, AppState>) -> Result<Chat, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::create_chat(&room.conn)
}

#[tauri::command]
pub fn delete_chat(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::delete_chat(&room.conn, &id)
}

#[tauri::command]
pub fn get_messages(state: State<'_, AppState>, chat_id: String) -> Result<Vec<Message>, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::list_messages(&room.conn, &chat_id)
}

/// ADD-9: give a chat an explicit title (persists in the room file).
#[tauri::command]
pub fn rename_chat(state: State<'_, AppState>, id: String, title: String) -> Result<(), String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::rename_chat(&room.conn, &id, &title)
}

/// ADD-9: delete one message — regenerate drops the last assistant reply, then
/// re-runs `ask` with the previous user question.
#[tauri::command]
pub fn delete_message(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::delete_message(&room.conn, &id)
}

/// ADD-8: import a pasted screenshot. Base64-decode, then go through the same
/// insert/index path any uploaded file uses (source "upload").
#[tauri::command]
pub fn import_image_bytes(
    state: State<'_, AppState>,
    name: String,
    b64: String,
) -> Result<FileMeta, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("Could not read the pasted image: {e}"))?;
    let mime = mime_guess::from_path(&name)
        .first_or(mime_guess::mime::IMAGE_PNG)
        .essence_str()
        .to_string();
    // Images carry no extractable text; they still index by name like any file.
    db::insert_file(&room.conn, &name, &mime, &bytes, None, "upload")
}

/// ADD-18: store a voice note recorded inside the room, then transcribe it in
/// the background exactly like an imported recording — the room ends up with
/// BOTH the audio file and its searchable timestamped transcript.
#[tauri::command]
pub fn import_audio_bytes(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    name: String,
    b64: String,
) -> Result<FileMeta, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("Could not read the recording: {e}"))?;
    let ext = extraction::extension_of(&name);
    // Store a mime WKWebView will play back: guessers label .m4a "audio/m4a",
    // which <audio> silently refuses — AAC-in-MP4 is audio/mp4.
    let mime = match ext.as_str() {
        "m4a" | "mp4" => "audio/mp4".to_string(),
        "webm" => "audio/webm".to_string(),
        _ => mime_guess::from_path(&name)
            .first_raw()
            .unwrap_or("audio/mp4")
            .to_string(),
    };
    let (meta, room_path) = {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        (
            db::insert_file(&room.conn, &name, &mime, &bytes, None, "upload")?,
            room.path.clone(),
        )
    };
    enqueue_stt(
        &app,
        JobMeta { id: meta.id.clone(), name, mime, ext, room_path },
    );
    Ok(meta)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageBox {
    pub label: String,
    // Normalized 0..1 relative to the image, (0,0) = top-left.
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

fn parse_boxes(raw: &str, img_w: f64, img_h: f64) -> Vec<ImageBox> {
    // CHG-21: drop any <think>…</think> spans some models leak, then scan each
    // '[' as a candidate JSON array (the stream deserializer parses one balanced
    // value and ignores trailing prose), returning the first array that yields
    // at least one box. Robust to leading/trailing prose containing brackets,
    // unlike a single first-'['-to-last-']' slice.
    let cleaned = strip_think_spans(raw);
    let bracket_positions: Vec<usize> = cleaned
        .char_indices()
        .filter(|(_, c)| *c == '[')
        .map(|(i, _)| i)
        .take(8)
        .collect();
    for start in bracket_positions {
        let mut de = serde_json::Deserializer::from_str(&cleaned[start..]).into_iter::<serde_json::Value>();
        let items = match de.next() {
            Some(Ok(serde_json::Value::Array(items))) => items,
            _ => continue,
        };
        let boxes = boxes_from_items(items, img_w, img_h);
        if !boxes.is_empty() {
            return boxes;
        }
    }
    vec![]
}

/// Remove `<think>…</think>` spans (some non-grounding models leak them).
fn strip_think_spans(raw: &str) -> String {
    let mut out = raw.to_string();
    while let Some(start) = out.find("<think>") {
        match out[start..].find("</think>") {
            Some(rel) => {
                let end = start + rel + "</think>".len();
                out.replace_range(start..end, "");
            }
            None => {
                out.truncate(start);
                break;
            }
        }
    }
    out
}

fn boxes_from_items(items: Vec<serde_json::Value>, img_w: f64, img_h: f64) -> Vec<ImageBox> {
    let mut boxes = Vec::new();
    for item in items {
        let label = item["label"]
            .as_str()
            .or_else(|| item["name"].as_str())
            .unwrap_or("match")
            .to_string();
        // Requested "bbox_2d" is absolute pixels (Qwen-VL's native grounding
        // format). "box_2d" is Google-style [ymin, xmin, ymax, xmax] 0-1000.
        let (coords, y_first, pixels) = if item["bbox_2d"].is_array() {
            (item["bbox_2d"].as_array().unwrap(), false, true)
        } else if item["bbox"].is_array() {
            (item["bbox"].as_array().unwrap(), false, true)
        } else if item["box_2d"].is_array() {
            (item["box_2d"].as_array().unwrap(), true, false)
        } else if item["box"].is_array() {
            (item["box"].as_array().unwrap(), false, false)
        } else {
            continue;
        };
        if coords.len() != 4 {
            continue;
        }
        let vals: Vec<f64> = coords.iter().filter_map(|c| c.as_f64()).collect();
        if vals.len() != 4 {
            continue;
        }
        let (mut a, mut b, mut c, mut d) = if y_first {
            (vals[1], vals[0], vals[3], vals[2])
        } else {
            (vals[0], vals[1], vals[2], vals[3])
        };
        // Scale to 0..1. Pixel keys use the image dims — unless the values
        // overshoot them, which means the model answered in its own
        // 0-1000-normalized space (qwen2.5vl does this on small images).
        let max = vals.iter().cloned().fold(0.0, f64::max);
        let out_of_range = a.max(c) > img_w * 1.05 || b.max(d) > img_h * 1.05;
        let (sx, sy) = if max <= 1.0 {
            (1.0, 1.0)
        } else if pixels && !out_of_range {
            (img_w.max(1.0), img_h.max(1.0))
        } else {
            (1000.0, 1000.0)
        };
        a /= sx;
        c /= sx;
        b /= sy;
        d /= sy;
        if a > c {
            std::mem::swap(&mut a, &mut c);
        }
        if b > d {
            std::mem::swap(&mut b, &mut d);
        }
        let clamp = |v: f64| v.clamp(0.0, 1.0);
        let (a, b, c, d) = (clamp(a), clamp(b), clamp(c), clamp(d));
        if c - a < 0.001 || d - b < 0.001 {
            continue;
        }
        boxes.push(ImageBox {
            label,
            x1: a,
            y1: b,
            x2: c,
            y2: d,
        });
    }
    boxes
}

#[tauri::command]
pub async fn locate_in_image(
    state: State<'_, AppState>,
    file_id: String,
    query: String,
    #[allow(unused_variables)] img_width: f64,
    #[allow(unused_variables)] img_height: f64,
) -> Result<Vec<ImageBox>, String> {
    let (explicit, prepared, w, h) = {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        let bytes = db::get_file_bytes(&room.conn, &file_id)?;
        let bytes = bytes.ok_or("File has no stored content.")?;
        let (prepared, w, h) = prepare_image(&bytes);
        (model_setting(&room.conn), prepared, w, h)
    };

    let models = ollama::list_models().await.unwrap_or_default();
    let chat_model = explicit.unwrap_or_else(|| best_default(&models));
    let mut vmodel = vision_model(&models, &chat_model);
    if is_external_engine(&vmodel) {
        if models.is_empty() {
            return Err("Marking images needs a local Ollama vision model.".into());
        }
        vmodel = best_default(&models);
    }

    let messages = vec![ollama::ChatMessage {
        role: "user".into(),
        content: grounding_prompt(&query, w, h),
        images: Some(vec![
            base64::engine::general_purpose::STANDARD.encode(&prepared),
        ]),
        ..Default::default()
    }];
    // HLT-5: release the vision model quickly on low-RAM machines.
    let keep = vision_keep_alive(total_ram_bytes(), &vmodel, &chat_model);
    let raw = ollama::chat_structured(&vmodel, messages, Some(0.0), keep, &boxes_schema()).await?;
    Ok(parse_boxes(&raw, w, h))
}

#[tauri::command]
pub async fn pull_model(window: tauri::Window, name: String) -> Result<(), String> {
    use tauri::Emitter;
    ollama::pull(&name, |status, percent| {
        let _ = window.emit(
            "pull-progress",
            serde_json::json!({ "status": status, "percent": percent }),
        );
    })
    .await
}

#[tauri::command]
pub async fn delete_model(name: String) -> Result<(), String> {
    ollama::delete_model(&name).await
}

/// CHG-18: does the question want boxes drawn on the ATTACHED IMAGE? The trigger
/// is asymmetric because the costs are: a false positive loads a multi-GB vision
/// model (and can evict the chat model on a 16 GB Mac), while a false negative is
/// free — the agent loop still has the mark_image tool to recover. So unambiguous
/// marking verbs fire unconditionally; document/general verbs ("highlight",
/// "show me", "find the") fire only when the question also refers to the image;
/// and a question that names a non-image target (pdf/spreadsheet/doc) is skipped.
/// `image_name` is the attached image's file name, if any.
fn is_locate_intent(question: &str, image_name: Option<&str>) -> bool {
    let q = question.to_lowercase();
    // Names a different, non-image target → this is an annotate_file/open_file
    // job, not image grounding. Skip the vision pass.
    const OTHER_TARGETS: &[&str] = &[
        "pdf", "spreadsheet", "sheet", "workbook", "document", "the doc", "report", "the page",
    ];
    if OTHER_TARGETS.iter().any(|t| q.contains(t)) {
        return false;
    }
    // Unambiguous "mark it on the image" verbs — always trigger.
    const STRONG: &[&str] = &[
        "mark ", "mark the", "locate", "point to", "point out", "circle", "find where",
        "where is", "where are", "where's",
    ];
    if STRONG.iter().any(|k| q.contains(k)) {
        return true;
    }
    // Ambiguous document/general verbs — only when the question refers to the
    // image (an image-referential word, or the image's own file name).
    const WEAK: &[&str] = &["highlight", "show me", "find the", "find all"];
    if WEAK.iter().any(|k| q.contains(k)) {
        const IMG_REFS: &[&str] =
            &["image", "screenshot", "photo", "picture", "png", "jpg", "jpeg", "scan"];
        let refers_to_image = IMG_REFS.iter().any(|r| q.contains(r))
            || image_name
                .map(|n| q.contains(&n.to_lowercase()))
                .unwrap_or(false);
        return refers_to_image;
    }
    false
}

/// Remove fenced UI-markup payloads (```boxes, ```annotation) from message
/// content — they are viewer data, not conversation text.
fn strip_markup_blocks(content: &str) -> String {
    let mut out = content.to_string();
    for tag in ["```boxes", "```annotation"] {
        while let Some(start) = out.find(tag) {
            let after = &out[start + tag.len()..];
            out = match after.find("```") {
                Some(end) => format!("{}{}", &out[..start], &after[end + 3..]),
                None => out[..start].to_string(),
            }
            .trim()
            .to_string();
        }
    }
    out
}

const STOPWORDS: &[&str] = &[
    // CHG-14: include common 2-letter function words so the >=2 length filter
    // can admit high-signal short terms (AI, EU, Q2, IP) without letting these
    // through.
    "is", "to", "of", "in", "on", "at", "it", "be", "as", "by", "an", "or", "if", "we", "do",
    "so", "up", "my", "me", "no", "us", "am", "he",
    "the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was", "one", "our",
    "out", "get", "has", "him", "his", "how", "new", "now", "see", "two", "way", "who", "did",
    "its", "let", "say", "she", "too", "use", "that", "with", "have", "this", "will", "your",
    "from", "they", "know", "want", "been", "good", "much", "some", "time", "what", "when",
    "which", "about", "would", "there", "their", "were", "them", "then", "than", "into", "also",
    "just", "like", "over", "such", "only", "most", "make", "after", "where", "does", "please",
    "could", "should", "tell",
];

fn question_terms(question: &str) -> Vec<String> {
    let mut terms = Vec::new();
    for word in question
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
    {
        // CHG-14: >=2 so short high-signal terms (AI, EU, Q2, IP) survive; the
        // 2-letter function words are filtered by STOPWORDS above.
        if word.len() >= 2 && !STOPWORDS.contains(&word) && !terms.contains(&word.to_string()) {
            terms.push(word.to_string());
        }
        if terms.len() >= 24 {
            break;
        }
    }
    terms
}

struct ScoredChunk {
    rowid: i64,
    file_name: String,
    text: String,
    score: f32,
}

/// ADD-13: embed the question so retrieval can blend meaning with keywords.
/// Returns None on ANY failure (model missing, Ollama down, empty result) so the
/// caller silently falls back to the pure keyword path — the chat never blocks.
/// Keeps the small embed model briefly warm so back-to-back questions are fast.
/// CHG-12: nomic-embed-text expects the `search_query:` task prefix on queries.
async fn embed_question(question: &str) -> Option<Vec<f32>> {
    let prefixed = format!("search_query: {question}");
    match ollama::embed(ollama::EMBED_MODEL, std::slice::from_ref(&prefixed), "5m").await {
        Ok(mut v) if !v.is_empty() && !v[0].is_empty() => Some(v.remove(0)),
        _ => None,
    }
}

/// ADD-13: kick off the lazy background embed pass for the currently open room.
/// Bumps the embed generation (so any older pass exits) and spawns exactly one
/// loop carrying the new stamp. Cheap to call on every unlock; no-op work once
/// every chunk already has a vector.
/// One-shot re-extraction pass for files that were imported before an
/// extractor improvement and so carry no text (e.g. all-numeric .xlsx files
/// stored when the extractor only read shared strings). Runs the current
/// extractor over their stored bytes and re-indexes any that now yield text.
/// OCR/STT candidates are left to their own workers; only the open room is
/// touched, and the room lock is never held across nothing but quick DB work.
fn spawn_reextract_backfill(app: &tauri::AppHandle) {
    use tauri::{Emitter as _, Manager as _};
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let (path, candidates) = {
            let state = app.state::<AppState>();
            let guard = state.room.lock().unwrap();
            let Some(room) = guard.as_ref() else { return };
            let list = db::files_missing_text(&room.conn).unwrap_or_default();
            (room.path.clone(), list)
        };
        let mut fixed = 0usize;
        for (id, name, mime, bytes) in candidates {
            // Skip scans/photos/media — their text arrives via OCR/STT workers.
            let ext = extraction::extension_of(&name);
            if extraction::is_image(&mime)
                || ocr::is_ocr_candidate(&mime, &ext)
                || stt::media_kind(&mime, &ext).is_some()
            {
                continue;
            }
            let Some(text) = extraction::extract_text(&name, &bytes) else {
                continue;
            };
            let state = app.state::<AppState>();
            let guard = state.room.lock().unwrap();
            let Some(room) = guard.as_ref() else { return };
            if room.path != path {
                return;
            }
            if db::update_file_content(&room.conn, &id, &bytes, Some(&text)).is_ok() {
                fixed += 1;
            }
        }
        if fixed > 0 {
            let _ = app.emit("room-files-changed", ());
        }
    });
}

fn spawn_embedding_backfill(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    use tauri::Manager as _;
    let generation = {
        let state = app.state::<AppState>();
        state.embed_generation.fetch_add(1, Ordering::SeqCst) + 1
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        backfill_embeddings(app, generation).await;
    });
}

/// ADD-13: background pass that fills `chunks.embedding` for the open room. It
/// drains NULL-embedding chunks in batches, then idles — picking up chunks that
/// later imports/edits add — until the room closes or a newer room opens (the
/// generation stamp moves). Never holds the room lock across the Ollama call.
/// Any embed error (model missing / server down) just backs off and retries; the
/// keyword path keeps working meanwhile. The short `keep_alive` lets Ollama
/// release the small embed model on its own once indexing goes idle (HLT-5).
async fn backfill_embeddings(app: tauri::AppHandle, generation: u64) {
    use std::sync::atomic::Ordering;
    use tauri::Manager as _;
    const BATCH: usize = 32;
    loop {
        // Collect a batch under the lock; bail if this pass is stale or closed.
        let (path, batch) = {
            let state = app.state::<AppState>();
            if state.embed_generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let guard = state.room.lock().unwrap();
            let Some(room) = guard.as_ref() else { return };
            let batch = db::chunks_missing_embedding(&room.conn, BATCH).unwrap_or_default();
            (room.path.clone(), batch)
        };

        if batch.is_empty() {
            // Fully indexed for now; poll for chunks future imports/edits add.
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            continue;
        }

        // CHG-12: embed documents with the `search_document:` task prefix and
        // prepend the file name for context, matching the `search_query:` side.
        // The augmented string is transient — only the vector is stored, on the
        // unmodified chunk.
        let texts: Vec<String> = batch
            .iter()
            .map(|(_, name, text)| format!("search_document: {name}\n{text}"))
            .collect();
        let vectors = match ollama::embed(ollama::EMBED_MODEL, &texts, "30s").await {
            Ok(v) if v.len() == texts.len() => v,
            _ => {
                // Model missing or Ollama down — back off, then retry. Keyword
                // retrieval stays fully functional in the meantime.
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                continue;
            }
        };

        // Write the vectors back, only if this is still the same open room.
        let state = app.state::<AppState>();
        if state.embed_generation.load(Ordering::SeqCst) != generation {
            return;
        }
        let guard = state.room.lock().unwrap();
        let Some(room) = guard.as_ref() else { return };
        if room.path != path {
            return;
        }
        for ((id, _, _), vec) in batch.iter().zip(vectors.iter()) {
            if vec.is_empty() {
                continue;
            }
            let blob = db::embedding_to_blob(vec);
            let _ = db::set_chunk_embedding(&room.conn, id, &blob);
        }
    }
}

/// Build an FTS5 MATCH expression from search terms: each term is double-quoted
/// (so punctuation or an FTS keyword like "or"/"near" is treated as a literal)
/// and the terms are OR-joined. Returns None when there are no usable terms.
fn fts_match_expr<'a>(terms: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let quoted: Vec<String> = terms
        .into_iter()
        // A quote inside a term would break out of the FTS string literal.
        .map(|t| format!("\"{}\"", t.replace('"', "")))
        .filter(|t| t.len() > 2) // drop the empty `""` a stripped term leaves
        .collect();
    if quoted.is_empty() {
        None
    } else {
        Some(quoted.join(" OR "))
    }
}

/// HLT-3 + ADD-13: retrieve context by blending the FTS5 keyword score with
/// vector (cosine) similarity over stored chunk embeddings, then taking the top
/// MAX_CONTEXT_CHUNKS. `question_embedding` is the question's vector (from
/// `embed_question`); pass None to run the pure keyword path unchanged — when
/// the embed model is absent or no chunks are embedded yet, retrieval degrades
/// cleanly to keywords.
///
/// Returns the chunks plus a `fallback` flag: true when nothing matched and we
/// padded with recent content instead (CHG-10 — such filler must not be credited
/// as a "source"). The `(chunks, fallback)` tuple shape is preserved for callers.
fn retrieve_context(
    conn: &Connection,
    question: &str,
    question_embedding: Option<&[f32]>,
) -> Result<(Vec<ScoredChunk>, bool), String> {
    retrieve_context_excluding(conn, question, question_embedding, &std::collections::HashSet::new())
}

/// CHG-13 + CHG-15 + CHG-16: as `retrieve_context`, but excludes chunk rowids in
/// `exclude` (used by search_room to skip chunks already injected into the
/// prompt). Blends keyword and vector signals with Reciprocal Rank Fusion —
/// scale-free, no min-max degeneracy, no "vec=0 for a good keyword hit". The
/// vector pass scores over (rowid, blob) only (no text copied) and hydrates just
/// the top candidates' text, so a large room no longer allocates every chunk's
/// text per question under the room mutex.
fn retrieve_context_excluding(
    conn: &Connection,
    question: &str,
    question_embedding: Option<&[f32]>,
    exclude: &std::collections::HashSet<i64>,
) -> Result<(Vec<ScoredChunk>, bool), String> {
    /// RRF damping constant; standard value.
    const RRF_K: f32 = 60.0;
    struct Cand {
        file_name: String,
        text: String,
        kw_rank: Option<usize>,
        vec_rank: Option<usize>,
    }
    let mut pool: HashMap<i64, Cand> = HashMap::new();

    // Keyword signal: chunks ranked best-first by bm25 → RRF rank.
    if let Some(expr) = fts_match_expr(question_terms(question).iter().map(String::as_str)) {
        let hits = db::search_chunks_fts_ranked(conn, &expr, RETRIEVE_CANDIDATES)?;
        for (rank, (rowid, name, text, _bm25)) in hits.into_iter().enumerate() {
            let e = pool.entry(rowid).or_insert_with(|| Cand {
                file_name: name,
                text,
                kw_rank: None,
                vec_rank: None,
            });
            e.kw_rank = Some(rank);
        }
    }

    // Vector signal: brute-force cosine over (rowid, blob) — no text shuttled.
    // Pool only positive-cosine chunks, ranked by cosine → RRF rank; hydrate
    // text for the winners not already present from the keyword pass.
    if let Some(q) = question_embedding {
        let mut scored: Vec<(i64, f32)> = db::chunk_embedding_vectors(conn)?
            .into_iter()
            .filter_map(|(rowid, blob)| {
                db::blob_to_embedding(&blob).and_then(|emb| {
                    let cos = db::cosine_similarity(q, &emb);
                    (cos > 0.0).then_some((rowid, cos))
                })
            })
            .collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(RETRIEVE_CANDIDATES);
        let need_text: Vec<i64> = scored
            .iter()
            .map(|(rowid, _)| *rowid)
            .filter(|rowid| !pool.contains_key(rowid))
            .collect();
        let hydrated: HashMap<i64, (String, String)> = db::chunks_by_rowids(conn, &need_text)?
            .into_iter()
            .map(|(rowid, name, text)| (rowid, (name, text)))
            .collect();
        for (rank, (rowid, _cos)) in scored.into_iter().enumerate() {
            if let Some(e) = pool.get_mut(&rowid) {
                e.vec_rank = Some(rank);
            } else if let Some((name, text)) = hydrated.get(&rowid) {
                pool.insert(
                    rowid,
                    Cand {
                        file_name: name.clone(),
                        text: text.clone(),
                        kw_rank: None,
                        vec_rank: Some(rank),
                    },
                );
            }
        }
    }

    // A real match means the pool was populated by keyword or positive-cosine
    // hits — gate the fallback on that (before any exclusion) so no-match
    // questions still fall back and CHG-10 keeps refusing to credit filler.
    if !pool.is_empty() {
        let mut scored: Vec<ScoredChunk> = pool
            .into_iter()
            .filter(|(rowid, _)| !exclude.contains(rowid))
            .map(|(rowid, c)| {
                let rrf = c.kw_rank.map_or(0.0, |r| 1.0 / (RRF_K + r as f32))
                    + c.vec_rank.map_or(0.0, |r| 1.0 / (RRF_K + r as f32));
                ScoredChunk {
                    rowid,
                    file_name: c.file_name,
                    text: c.text,
                    score: rrf,
                }
            })
            .collect();
        scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(MAX_CONTEXT_CHUNKS);
        // Every RRF-pooled chunk scores > 0; empty only when exclusion removed
        // all of them — the caller distinguishes that from a true no-match.
        return Ok((scored, false));
    }

    // Generic questions ("summarize this") match nothing; fall back to the
    // most recently added content so the model still sees the room.
    let scored = db::recent_chunks(conn, MAX_CONTEXT_CHUNKS)?
        .into_iter()
        .map(|(file_name, text)| ScoredChunk {
            rowid: -1,
            file_name,
            text,
            score: 0.0,
        })
        .collect();
    Ok((scored, true))
}

/// ADD-6: extract a short snippet of `haystack` around the first occurrence of
/// `needle` (case-insensitive), with ellipses when clipped. Falls back to the
/// first matching word of `needle`, then to the start of the text. Whitespace
/// is collapsed so multi-line file text reads as one line. Pure and testable.
fn make_snippet(haystack: &str, needle: &str, radius: usize) -> String {
    let normalized: String = haystack.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = normalized.to_lowercase();
    let find = |n: &str| {
        let n = n.trim().to_lowercase();
        if n.is_empty() {
            None
        } else {
            lower.find(&n)
        }
    };
    let chars: Vec<char> = normalized.chars().collect();
    // No match to center on: return a clipped preview from the start.
    let Some(byte) = find(needle).or_else(|| needle.split_whitespace().find_map(find)) else {
        let mut out: String = chars.iter().take(radius * 2).collect();
        if chars.len() > radius * 2 {
            out.push('…');
        }
        return out;
    };
    let char_pos = lower[..byte].chars().count();
    let start = char_pos.saturating_sub(radius);
    let end = (char_pos + radius).min(chars.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(&chars[start..end]);
    if end < chars.len() {
        out.push('…');
    }
    out
}

#[tauri::command]
pub async fn ask(
    window: tauri::Window,
    state: State<'_, AppState>,
    ask_id: String,
    chat_id: String,
    question: String,
    attachments: Vec<String>,
) -> Result<Message, String> {
    use tauri::Emitter;

    // ADD-7: register this ask's cancel flag; the guard removes it on return
    // (success, error, or cancel) so `close_room`'s wait can see us finish.
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .cancels
        .lock()
        .unwrap()
        .insert(ask_id.clone(), cancel.clone());
    let _cancel_guard = CancelGuard {
        state: state.inner(),
        ask_id: ask_id.clone(),
    };

    // ADD-13: embed the question BEFORE taking the room lock (the Ollama call is
    // async; the lock is not held across it). None on any failure → keyword-only.
    let question_embedding = embed_question(&question).await;

    // Phase 1 (locked): gather context, save the user message.
    let (
        explicit_model,
        chat_messages,
        sources,
        first_image,
        temperature,
        web_enabled,
        advisors_on,
        advisor_tools_on,
        injected_rowids,
    ) = {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        let conn = &room.conn;

        let explicit_model = model_setting(conn);
        let temperature: Option<f64> = db::get_setting(conn, "temperature")
            .and_then(|s| s.parse().ok());
        let custom_instructions: Option<String> = db::get_setting(conn, "custom_instructions");

        let memories: Vec<String> = db::list_memories(conn)?
            .into_iter()
            .map(|m| m.content)
            .collect();

        let history: Vec<(String, String)> = {
            let mut rows = db::recent_messages(conn, &chat_id, MAX_HISTORY_MESSAGES as i64)?;
            rows.reverse();
            rows
        };

        let (context_chunks, context_fallback) =
            retrieve_context(conn, &question, question_embedding.as_deref())?;
        // CHG-16: rowids already injected as context, so a search_room repeat
        // of the same question returns the next-best chunks instead of dupes.
        let injected_rowids: HashSet<i64> = if context_fallback {
            HashSet::new()
        } else {
            context_chunks.iter().map(|c| c.rowid).filter(|r| *r >= 0).collect()
        };

        // Attachments: images go to the model as vision input, text files as
        // guaranteed context.
        let mut images: Vec<String> = Vec::new();
        let mut attached_notes: Vec<String> = Vec::new();
        let mut sources: Vec<String> = Vec::new();
        let mut first_image: Option<(String, String, Vec<u8>, f64, f64)> = None;
        // Shared first-come budget so many text attachments can't blow the
        // context window; images are separately capped at MAX_ATTACHED_IMAGES.
        let mut text_budget = MAX_ATTACHED_TEXT_TOTAL;
        let mut skipped_attachments: Vec<String> = Vec::new();
        for file_id in &attachments {
            let (name, mime, bytes, text) = match db::get_file_full(conn, file_id) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let mime = mime.unwrap_or_default();
            if extraction::is_image(&mime) {
                if images.len() < MAX_ATTACHED_IMAGES {
                    if let Some(bytes) = bytes {
                        let (prepared, w, h) = prepare_image(&bytes);
                        if first_image.is_none() {
                            first_image =
                                Some((file_id.clone(), name.clone(), prepared.clone(), w, h));
                        }
                        images.push(base64::engine::general_purpose::STANDARD.encode(&prepared));
                        attached_notes.push(format!("(Attached image: {name})"));
                        sources.push(name);
                    }
                }
            } else if let Some(text) = text {
                // Per-file cap of 6000, further limited by the remaining shared
                // budget. A file that gets too small a slice to be useful is
                // skipped entirely so its source chip stays honest.
                let allow = text_budget.min(6000);
                if allow < 200 && text.len() > allow {
                    skipped_attachments.push(name);
                    continue;
                }
                let truncated = text.len() > allow;
                let mut text = clamp_bytes(text, allow);
                text_budget = text_budget.saturating_sub(text.len());
                if truncated {
                    text.push_str("\n… (truncated)");
                    // UX-4: the AI saw only the beginning — say so, by name.
                    let _ = window.emit(
                        "ask-notice",
                        format!(
                            "Only the beginning of \"{name}\" was included (file is large). \
                             For full coverage, ask about it in sections."
                        ),
                    );
                }
                attached_notes.push(format!("[attached file: {name}]\n{text}"));
                sources.push(name);
            }
        }
        if !skipped_attachments.is_empty() {
            let first = skipped_attachments[0].clone();
            let more = skipped_attachments.len() - 1;
            let tail = if more > 0 {
                format!(" and {more} more attachment(s)")
            } else {
                String::new()
            };
            let _ = window.emit(
                "ask-notice",
                format!(
                    "\"{first}\"{tail} were skipped — too much attached text for one \
                     question; ask about them separately."
                ),
            );
        }

        // Only credit files that genuinely matched the question. On the
        // zero-score fallback the chunks are just "recent content", so they
        // must not appear as source chips (CHG-10). Attachments still count.
        if !context_fallback {
            for chunk in &context_chunks {
                if !sources.contains(&chunk.file_name) {
                    sources.push(chunk.file_name.clone());
                }
            }
        }

        let web_enabled = web_access_enabled(conn);
        // ADD-21: whether the advisor tool may be offered this turn (the final
        // list of installed advisors is resolved after the lock, off-thread),
        // and whether a consulted Claude advisor may reach the room's tools.
        let advisors_on = advisors_enabled(conn);
        let advisor_tools_on = advisors_on && advisor_tools_enabled(conn);

        let mut system = String::from(
            "You are the private AI assistant inside \"Private Room\", a local encrypted \
             workspace. Everything you see stays on this computer. Answer the user's question \
             using the file excerpts provided as context when they are relevant, and mention \
             the file names you drew from. If the room's content does not contain the answer, \
             say so, then answer from general knowledge if you can. Be concise and useful.\n\n\
             You can control the app with your tools: list_room_files, search_room (find \
             content), open_file (show a file to the user in the viewer — it can jump to a \
             page, cell, or text), mark_image (draw boxes on an image), annotate_file \
             (highlight an exact quote or a cell range in a document or spreadsheet so the \
             user sees it), create_file (save a new note/document into the room), edit_file \
             (replace exact text inside an existing file — text, code, csv, or docx), \
             write_file (rewrite a whole text file), set_cells (change a spreadsheet cell by \
             A1 reference like B7), add_memory (remember something permanently). Use them \
             whenever the user asks you to open, show, mark, find, create, change or remember \
             something — then give your answer in plain text. Before editing or annotating, \
             copy text exactly as it appears in the file (search_room shows it verbatim).\n\n\
             CRITICAL — never fabricate an action:\n\
             - To change a file you MUST call edit_file, write_file, or set_cells. NEVER say a \
             file was changed, edited, updated, saved, or fixed unless that tool call returned \
             success in THIS turn. Do not print a diff, a new version, or \"File updated\" from \
             memory — only a real tool result proves a change happened.\n\
             - To highlight or mark a passage you MUST call annotate_file with text copied \
             EXACTLY from the file. If you have not already seen the file's exact text this \
             turn, call open_file or search_room FIRST to read it, then annotate_file with the \
             verbatim quote. Never claim you highlighted, marked, or boxed anything unless \
             annotate_file (or mark_image) returned success this turn — a guessed quote that \
             fails to match is NOT a highlight.\n\
             - If a tool call fails or you cannot find the exact text, say so plainly and stop; \
             do not narrate success you did not achieve.",
        );
        if web_enabled {
            system.push_str(
                "\n\nThe user has turned web access ON for this room. You have two more \
                 tools: web_search (find pages) and fetch_page (read one page). \
                 IMPORTANT: for any question about current or recent things — weather, \
                 news, prices, sports, events, anything after your training data — you \
                 MUST call web_search first. Never answer that you lack real-time data: \
                 search instead. Mention that you searched the web in your answer.",
            );
        }

        let connected_mcp: Vec<String> = {
            let mgr = state.mcp.lock().unwrap();
            mgr.servers
                .iter()
                .filter(|s| s.client.is_some() && !s.tools.is_empty())
                .map(|s| s.name.clone())
                .collect()
        };
        if !connected_mcp.is_empty() {
            system.push_str(&format!(
                "\n\nThe user has also connected external tool servers to this room: {}. \
                 Their tools appear alongside the built-in ones and can reach the internet \
                 or other apps. IMPORTANT: when a question needs current or outside \
                 information (weather, news, prices, events) and no built-in tool covers \
                 it, you MUST use one of these tools instead of answering that you lack \
                 real-time data. Mention when you did.",
                connected_mcp.join(", ")
            ));
        }

        // Give the model an inventory so it can answer questions like
        // "what images do we have here?" without excerpts being retrieved.
        // CHG-9: newest-first with a partial-list marker; CHG-23: each file's
        // cached one-liner rides along under a running budget.
        let mut inventory: Vec<(String, String, Option<String>)> =
            db::list_file_inventory(conn)?;
        let inventory_partial = inventory.len() > 100;
        inventory.truncate(100);
        if !inventory.is_empty() {
            system.push_str("\n\nFiles currently stored in this room:\n");
            let mut liner_budget = 3_000usize;
            for (name, mime, summary) in &inventory {
                match summary {
                    Some(s) if liner_budget > 0 && !s.trim().is_empty() => {
                        let liner = clamp_words(s.trim(), 120);
                        liner_budget = liner_budget.saturating_sub(liner.len());
                        system.push_str(&format!("- {name} ({mime}) — {liner}\n"));
                    }
                    _ => system.push_str(&format!("- {name} ({mime})\n")),
                }
            }
            if inventory_partial {
                system.push_str(
                    "This list is partial (the room has more files) — call list_room_files \
                     for the complete list.\n",
                );
            }
            system.push_str(
                "You can see an image's pixels only when the user attaches it to a question \
                 (paperclip); otherwise you still know it exists by name.",
            );
        }

        if let Some(custom) = &custom_instructions {
            if !custom.trim().is_empty() {
                system.push_str(
                    "\n\nThe user has set these standing preferences for how you respond:\n",
                );
                system.push_str(custom.trim());
            }
        }

        // ADD-22 (KV-cache): keep the system prompt BYTE-STABLE across a
        // conversation so Ollama reuses the cached prefix (measured elsewhere at
        // 40-65% faster first token). Per-question memory selection therefore
        // moves into the always-new user message below, not the system prompt.
        let mut chat_messages = vec![ollama::ChatMessage::new("system", system)];
        // Recency-weighted history: keep whole recent turns under one global
        // budget, dropping the oldest wholesale rather than cutting each turn
        // to a silently-unterminated 4000-char head (char-safe throughout).
        for (role, content) in compact_history(history, MAX_HISTORY_CHARS) {
            chat_messages.push(ollama::ChatMessage::new(&role, content));
        }

        let mut user_content = String::new();
        if !memories.is_empty() {
            // CHG-7 + ADD-22: budget-fitting, question-relevant memories are
            // injected HERE (the always-new user message) rather than the stable
            // system prompt, preserving KV-cache reuse of the system prefix.
            let chosen = select_memories(&memories, &question, MAX_MEMORY_INJECT_CHARS);
            if !chosen.is_empty() {
                user_content.push_str("Notes to remember for this room:\n");
                for m in &chosen {
                    user_content.push_str(&format!("- {m}\n"));
                }
                user_content.push('\n');
            }
        }
        let has_context = !context_chunks.is_empty() || !attached_notes.is_empty();
        if has_context {
            user_content.push_str(if context_fallback && attached_notes.is_empty() {
                "Recently added content (may be unrelated to the question):\n\n"
            } else {
                "Context from files stored in this room:\n\n"
            });
            for note in &attached_notes {
                user_content.push_str(note);
                user_content.push_str("\n\n");
            }
            for chunk in &context_chunks {
                user_content.push_str(&format!("[file: {}]\n{}\n\n", chunk.file_name, chunk.text));
            }
            user_content.push_str("---\n\n");
        }
        user_content.push_str(&format!("Question: {question}"));

        chat_messages.push(ollama::ChatMessage {
            role: "user".into(),
            content: user_content,
            images: if images.is_empty() { None } else { Some(images) },
            ..Default::default()
        });

        db::insert_message(conn, &chat_id, "user", &question, &[])?;

        // First question names the session.
        let mut title: String = question.chars().take(48).collect();
        if question.chars().count() > 48 {
            title.push('…');
        }
        db::set_chat_title_if_new(conn, &chat_id, &title)?;

        (
            explicit_model,
            chat_messages,
            sources,
            first_image,
            temperature,
            web_enabled,
            advisors_on,
            advisor_tools_on,
            injected_rowids,
        )
    };

    let models = ollama::list_models().await.unwrap_or_default();
    let model = explicit_model
        .clone()
        .unwrap_or_else(|| best_default(&models));

    // CHG-19: the "where is X?" grounding pass is deferred to AFTER the answer
    // (nothing in the reply depends on the boxes), so the warm chat model streams
    // the first token immediately instead of waiting on a vision-model load.
    let mut effects = ToolEffects::default();

    // Phase 2 (unlocked): answer — through a cloud CLI if selected, or the
    // local model with full app-control tools. When the user pressed Stop
    // mid-answer, a raised error is expected — swallow it and save the partial.
    let run = if is_external_engine(&model) {
        // CHG-5: a step chip, not fake live text (nothing streams for cloud).
        let _ = window.emit("ask-step", "Asking your cloud AI (content leaves this Mac)");
        // ADD-20: Claude Code gets the room's tools over a per-ask localhost
        // MCP bridge — same exec_tool dispatch as the local agent, decryption
        // stays in-process, and the bridge dies when this ask returns.
        let bridge = if model == "claude-cli" {
            use tauri::Manager;
            crate::room_mcp::start(window.app_handle().clone(), web_enabled, false)
                .await
                .ok()
        } else {
            None
        };
        let res =
            run_external(&model, &chat_messages, Some(cancel.clone()), bridge.as_ref()).await;
        if let Some(b) = &bridge {
            b.stop();
        }
        res
    } else {
        // ADD-21: resolve installed advisors only for a local answer with the
        // setting on — the probe is cached, and it's skipped entirely otherwise.
        let advisors = if advisors_on {
            detected_externals(&state).await
        } else {
            Vec::new()
        };
        // Start the per-ask advisor bridge up front (not inside exec_tool, which
        // would form an async-recursion cycle) when the sub-option is on and a
        // Claude advisor exists. It gives that advisor the room's tools and is
        // torn down when the answer completes, whether or not a consult happens.
        let advisor_bridge = if advisor_tools_on && advisors.iter().any(|a| a == "claude-cli") {
            use tauri::Manager;
            crate::room_mcp::start(window.app_handle().clone(), web_enabled, true)
                .await
                .ok()
        } else {
            None
        };
        let res = agent_loop(
            &window,
            &state,
            &model,
            &question,
            chat_messages,
            temperature,
            &mut effects,
            web_enabled,
            &advisors,
            advisor_bridge.as_ref(),
            cancel.clone(),
            &injected_rowids,
        )
        .await;
        if let Some(b) = &advisor_bridge {
            b.stop();
        }
        res
    };
    let stopped = cancel.load(Ordering::SeqCst);
    let answer = match run {
        Ok(text) => text,
        // ADD-7: the child was killed / stream cut on purpose — keep partial.
        Err(_) if stopped => String::new(),
        Err(e) => return Err(e),
    };

    // CHG-19 + CHG-17: run the image-grounding pass now, AFTER the answer, and
    // ONLY if the model didn't already mark the image via the mark_image tool
    // (effects.boxes set) and the user didn't stop. This gives fast time-to-
    // first-token and structurally eliminates the redundant second vision pass
    // (chat→vision→chat→vision) that the old pre-answer ordering caused on
    // 16 GB Macs. CHG-18: the trigger now also considers the image's file name.
    if effects.boxes.is_none() && !stopped {
        if let Some((img_id, img_name, img_bytes, w, h)) = &first_image {
            if is_locate_intent(&question, Some(img_name)) {
                let mut vmodel = vision_model(&models, &model);
                if is_external_engine(&vmodel) {
                    vmodel = best_default(&models);
                }
                if !models.is_empty() && !is_external_engine(&vmodel) {
                    let messages = vec![ollama::ChatMessage {
                        role: "user".into(),
                        content: grounding_prompt(&question, *w, *h),
                        images: Some(vec![
                            base64::engine::general_purpose::STANDARD.encode(img_bytes),
                        ]),
                        ..Default::default()
                    }];
                    // HLT-5: short keep_alive for this vision pass on low-RAM Macs.
                    let keep = vision_keep_alive(total_ram_bytes(), &vmodel, &model);
                    if let Ok(raw) =
                        ollama::chat_structured(&vmodel, messages, Some(0.0), keep, &boxes_schema())
                            .await
                    {
                        let boxes = parse_boxes(&raw, *w, *h);
                        if !boxes.is_empty() {
                            effects.boxes = Some(serde_json::json!({
                                "fileId": img_id,
                                "name": img_name,
                                "boxes": boxes,
                            }));
                            let _ = window.emit("ask-step", "Marked the image");
                        }
                    }
                }
            }
        }
    }

    let mut content = answer;
    // CHG-10: deterministic anti-fabrication gate. The prompt asks the model
    // never to claim a change it didn't make; here the runtime KNOWS whether a
    // write/highlight actually happened this turn (effects), so append a plain
    // correction when the local answer claims one that didn't. Local path only
    // (cloud has no tool effects) and never over a stopped partial.
    if !is_external_engine(&model) && !stopped {
        let highlighted = effects.annotation.is_some() || effects.boxes.is_some();
        if claims_unbacked_action(&content, effects.wrote, highlighted) {
            content.push_str(
                "\n\n*(Correction: no file was actually changed this turn — the edit tool did \
                 not run or failed.)*",
            );
        }
    }
    // ADD-7: mark the transcript so it matches what the user watched.
    if stopped {
        content.push_str(" *(stopped)*");
    }
    if let Some(payload) = &effects.boxes {
        content.push_str(&format!("\n\n```boxes\n{payload}\n```"));
    }
    if let Some(payload) = &effects.annotation {
        content.push_str(&format!("\n\n```annotation\n{payload}\n```"));
    }

    // Phase 3 (locked): save the assistant reply. HLT-7: if the room was
    // locked mid-answer it is already closed — return quietly with the
    // (unsaved) content instead of surfacing "No room is open" to the UI.
    let guard = state.room.lock().unwrap();
    match guard.as_ref() {
        Some(room) => db::insert_message(&room.conn, &chat_id, "assistant", &content, &sources),
        None => Ok(Message {
            id: String::new(),
            role: "assistant".into(),
            content,
            sources,
            created_at: String::new(),
        }),
    }
}

/// ADD-7: stop a running answer. Sets its cancel flag; a no-op for an unknown
/// id (the ask may have already finished).
#[tauri::command]
pub fn cancel_ask(state: State<'_, AppState>, ask_id: String) {
    if let Some(flag) = state.cancels.lock().unwrap().get(&ask_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

/// Every built-in agent tool name — also the reserved set MCP tools may not
/// shadow. Keep in sync with `tools_catalog` and `exec_tool`.
const BUILTIN_TOOL_NAMES: &[&str] = &[
    "list_room_files",
    "search_room",
    "open_file",
    "mark_image",
    "annotate_file",
    "create_file",
    "edit_file",
    "write_file",
    "set_cells",
    "add_memory",
    "web_search",
    "fetch_page",
];

/// ADD-22: the file-MUTATING built-ins. A small model picks the right tool far
/// more reliably from a short, relevant list (RAG-MCP / tool-filtering research),
/// so these are withheld on a plain informational turn and only offered when the
/// question sounds like it wants a change. Read/show tools (list/search/open/
/// annotate/mark) are always offered.
const WRITE_TOOL_NAMES: &[&str] = &[
    "create_file",
    "edit_file",
    "write_file",
    "set_cells",
    "add_memory",
];

/// Keyword router deciding whether to offer the write tools this turn. Erring
/// toward YES is safe (it just restores the fuller catalog); the win is the
/// large class of pure questions ("what does the contract say about X") that
/// contain none of these and get a 5-tool catalog instead of 11.
fn wants_write_tools(question: &str) -> bool {
    let q = question.to_lowercase();
    const HINTS: &[&str] = &[
        "edit", "change", "replace", "fix", "update", "rewrite", "write ", "add ",
        "create", "make ", "new file", "save", "delete", "remove", "set ", "fill",
        "insert", "append", "rename", "correct", "remember", "note ", "jot", "record",
        "translate", "highlight", "mark ", "annotate", "draft", "generate",
    ];
    HINTS.iter().any(|h| q.contains(h))
}

/// The lane label shown to the user (transparency: they see how the app framed
/// their request, so an odd answer is explainable). Purely cosmetic.
fn lane_label(question: &str, web_enabled: bool) -> &'static str {
    if wants_write_tools(question) {
        "Working on your files"
    } else if web_enabled {
        "Answering (web available)"
    } else {
        "Answering"
    }
}

/// Tools the local model can use to drive the app. The web tools appear
/// only when the user enabled a search provider — a disabled capability is
/// one the model cannot even attempt.
pub(crate) fn tools_catalog(web_enabled: bool) -> serde_json::Value {
    let mut tools = serde_json::json!([
        {"type": "function", "function": {"name": "list_room_files",
            "description": "List every file stored in this room with its type and size.",
            "parameters": {"type": "object", "properties": {}}}},
        {"type": "function", "function": {"name": "search_room",
            "description": "Search all room files for content the excerpts already provided above do not cover. Use 2-4 keywords, not a full sentence. Results are verbatim file text safe to quote in annotate_file.",
            "parameters": {"type": "object", "properties": {
                "query": {"type": "string"}}, "required": ["query"]}}},
        {"type": "function", "function": {"name": "open_file",
            "description": "Open a file in the app's viewer pane so the user sees it. Optionally jump to a spot.",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "File name or a distinctive part of it"},
                "page": {"type": "integer", "description": "PDF page number to show"},
                "cell": {"type": "string", "description": "Spreadsheet cell to show, like B7"},
                "find": {"type": "string", "description": "Exact text from the file to scroll to"}},
                "required": ["name"]}}},
        {"type": "function", "function": {"name": "mark_image",
            "description": "Draw labeled boxes on an image in the room showing where something is.",
            "parameters": {"type": "object", "properties": {
                "image_name": {"type": "string"},
                "find": {"type": "string", "description": "What to locate in the image"}},
                "required": ["image_name", "find"]}}},
        {"type": "function", "function": {"name": "annotate_file",
            "description": "Highlight a spot in a document or spreadsheet so the user sees it marked in the viewer. Quote exact text from the file, or give a cell range for spreadsheets. For images use mark_image instead. Example: {\"name\": \"lease.pdf\", \"text\": \"no pets are allowed\", \"note\": \"pet clause\"}",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "File name or part of it"},
                "text": {"type": "string", "description": "Short exact quote copied from the file (max ~200 chars)"},
                "page": {"type": "integer", "description": "PDF page the text is on, if known"},
                "sheet": {"type": "string", "description": "Sheet name, for spreadsheets"},
                "range": {"type": "string", "description": "Cell or range to highlight, like B7 or B2:D5"},
                "note": {"type": "string", "description": "Short label explaining the highlight"}},
                "required": ["name"]}}},
        {"type": "function", "function": {"name": "create_file",
            "description": "Create a new note/document file saved into the room. For a document without a specific format, write the content as simple HTML body markup (<h2>, <p>, <ul>, <table>) and the app saves it as an .html page. Only use another extension (.md, .csv, .txt) if the user asked for it.",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string"}, "content": {"type": "string"}},
                "required": ["name", "content"]}}},
        {"type": "function", "function": {"name": "edit_file",
            "description": "Change part of an existing file (text, code, notes, csv, or docx) by replacing exact text. Copy old_text exactly as it appears in the file. Example: {\"name\": \"notes.md\", \"old_text\": \"Q3 revenue was $4M\", \"new_text\": \"Q3 revenue was $5M\"}",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "File name or part of it"},
                "old_text": {"type": "string", "description": "Exact text currently in the file"},
                "new_text": {"type": "string", "description": "Text to replace it with"}},
                "required": ["name", "old_text", "new_text"]}}},
        {"type": "function", "function": {"name": "write_file",
            "description": "Replace the entire content of an existing text file. For small changes prefer edit_file.",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "File name or part of it"},
                "content": {"type": "string", "description": "The complete new file content"}},
                "required": ["name", "content"]}}},
        {"type": "function", "function": {"name": "set_cells",
            "description": "Set one or more cells in a spreadsheet (.xlsx or .csv). Pass ALL changes in one call via updates.",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "File name or part of it"},
                "updates": {"type": "array", "description": "The cells to change, e.g. [{\"cell\":\"B2\",\"value\":\"120\"},{\"cell\":\"B3\",\"value\":\"95\"}]",
                    "items": {"type": "object", "properties": {
                        "cell": {"type": "string", "description": "Cell in A1 notation, like B7"},
                        "value": {"type": "string", "description": "New value for the cell"}},
                        "required": ["cell", "value"]}},
                "sheet": {"type": "string", "description": "Sheet name (default: first sheet)"}},
                "required": ["name", "updates"]}}},
        {"type": "function", "function": {"name": "add_memory",
            "description": "Save a permanent memory note that the assistant will always see in this room.",
            "parameters": {"type": "object", "properties": {
                "content": {"type": "string"}}, "required": ["content"]}}}
    ]);
    if web_enabled {
        let arr = tools.as_array_mut().unwrap();
        arr.push(serde_json::json!(
            {"type": "function", "function": {"name": "web_search",
                "description": "Search the public web. Use for current events or information not in the room. Returns titles, URLs and snippets; fetch a URL with fetch_page for details.",
                "parameters": {"type": "object", "properties": {
                    "query": {"type": "string", "description": "Short search query"}},
                    "required": ["query"]}}}
        ));
        arr.push(serde_json::json!(
            {"type": "function", "function": {"name": "fetch_page",
                "description": "Fetch one web page by URL and return its readable text. If the result is truncated, call again with the same url and the start value from the truncation notice to read further.",
                "parameters": {"type": "object", "properties": {
                    "url": {"type": "string", "description": "Full http(s) URL"},
                    "start": {"type": "integer", "description": "Character offset to continue reading a long page; use the value from the truncation notice."}},
                    "required": ["url"]}}}
        ));
    }
    tools
}

/// ADD-21: the `consult_advisor` tool spec, built from the advisors actually
/// installed on this Mac so the `advisor` enum only ever offers a real choice.
///
/// Deliberately NOT part of `tools_catalog`: the room MCP bridge is built from
/// `tools_catalog`, so keeping this tool out of it means a consulted cloud CLI
/// can never be handed a tool that spawns another cloud CLI. The recursion
/// guard is structural, not a runtime filter that could be forgotten.
fn consult_advisor_spec(advisors: &[String]) -> serde_json::Value {
    let mut names: Vec<&str> = Vec::new();
    if advisors.iter().any(|a| a == "claude-cli") {
        names.push("claude");
    }
    if advisors.iter().any(|a| a == "codex-cli") {
        names.push("codex");
    }
    serde_json::json!({"type": "function", "function": {
        "name": "consult_advisor",
        "description": "Delegate ONE hard, self-contained subtask to a powerful cloud AI advisor \
            (Claude or Codex) — deep research, complex reasoning, or difficult code you cannot do \
            well yourself. It is SLOW (up to a few minutes) and the text you send LEAVES this Mac \
            via the user's own cloud account, so use it rarely and only as a genuine last resort, \
            not for things you can answer directly. The advisor sees nothing but your `question` — \
            not the room, not this conversation — so put the FULL task and ALL needed context into \
            it. Returns the advisor's written answer for you to use in your reply.",
        "parameters": {"type": "object", "properties": {
            "question": {"type": "string", "description": "The complete, self-contained task or question, including every piece of context the advisor needs. It cannot see the room or the chat."},
            "advisor": {"type": "string", "enum": names, "description": "Which cloud advisor to ask. Use \"codex\" for heavy coding; \"claude\" otherwise."}
        }, "required": ["question"]}
    }})
}

/// A connected MCP tool exposed to the model this turn: its catalog entry
/// plus the client handle to call it with.
pub(crate) struct McpRoute {
    catalog_name: String,
    tool_name: String,
    /// The connector this tool belongs to — shown in the approval prompt and
    /// used as the "always allow" key.
    server_name: String,
    /// pub(crate) so the room bridge can advertise the same specs to a
    /// consulted advisor (ADD-21).
    pub(crate) spec: serde_json::Value,
    client: Arc<tokio::sync::Mutex<mcp::Client>>,
}

/// CHG-29: strip a third-party JSON Schema down to what the model needs to call
/// the tool, in place. Real MCP servers ship schemas with long descriptions,
/// examples and huge enums that can consume thousands of the 12K-token window.
/// Removes non-load-bearing keys, clamps every description to 100 chars, and
/// caps enum arrays at 16 entries. Recursive over objects/arrays.
fn slim_schema(v: &mut serde_json::Value) {
    match v {
        serde_json::Value::Object(map) => {
            for k in [
                "$schema",
                "title",
                "examples",
                "example",
                "default",
                "additionalProperties",
                "$id",
                "$comment",
            ] {
                map.remove(k);
            }
            map.retain(|k, _| !k.starts_with("x-"));
            if let Some(serde_json::Value::String(d)) = map.get_mut("description") {
                *d = clamp_bytes(std::mem::take(d), 100);
            }
            if let Some(serde_json::Value::Array(en)) = map.get_mut("enum") {
                en.truncate(16);
            }
            for (_, child) in map.iter_mut() {
                slim_schema(child);
            }
        }
        serde_json::Value::Array(arr) => {
            for child in arr.iter_mut() {
                slim_schema(child);
            }
        }
        _ => {}
    }
}

/// Snapshot the connected MCP tools, namespaced `server_tool` and deduped
/// against the built-in tool names and each other. CHG-29: schemas are slimmed
/// and the whole catalog is held under a char budget so a large third-party
/// server can't silently overflow the 4B model's context. Returns the routes
/// plus the names of any tools omitted for budget so the caller can tell the
/// model.
pub(crate) fn mcp_routes(state: &State<'_, AppState>) -> (Vec<McpRoute>, Vec<String>) {
    let mut taken: HashSet<String> = BUILTIN_TOOL_NAMES.iter().map(|s| s.to_string()).collect();
    let mgr = state.mcp.lock().unwrap();
    let mut routes = Vec::new();
    let mut omitted: Vec<String> = Vec::new();
    let mut catalog_chars = 0usize;
    for server in &mgr.servers {
        let Some(client) = &server.client else { continue };
        for tool in &server.tools {
            if routes.len() >= MAX_MCP_TOOLS {
                omitted.push(tool.name.clone());
                continue;
            }
            let base = format!(
                "{}_{}",
                mcp::sanitize_tool_name(&server.name),
                mcp::sanitize_tool_name(&tool.name)
            );
            let mut catalog_name = base.clone();
            let mut n = 2;
            while taken.contains(&catalog_name) {
                catalog_name = format!("{base}_{n}");
                n += 1;
            }
            // Long descriptions eat the context; cut at a char boundary.
            let description: String = tool.description.chars().take(300).collect();
            let mut schema = tool.schema.clone();
            slim_schema(&mut schema);
            let spec = serde_json::json!({"type": "function", "function": {
                "name": catalog_name,
                "description": description,
                "parameters": schema,
            }});
            // Whole-catalog budget: stop admitting once the specs get too large.
            let cost = spec.to_string().len();
            if catalog_chars + cost > MAX_MCP_CATALOG_CHARS && !routes.is_empty() {
                omitted.push(tool.name.clone());
                continue;
            }
            catalog_chars += cost;
            taken.insert(catalog_name.clone());
            routes.push(McpRoute {
                catalog_name,
                tool_name: tool.name.clone(),
                server_name: server.name.clone(),
                spec,
                client: client.clone(),
            });
        }
    }
    (routes, omitted)
}

/// Viewer payloads produced by tools during a turn; appended to the saved
/// assistant message as fenced markup blocks.
#[derive(Default)]
pub(crate) struct ToolEffects {
    boxes: Option<serde_json::Value>,
    annotation: Option<serde_json::Value>,
    /// CHG-10: set true when a write tool (create/edit/write/set_cells) succeeded
    /// this turn — the deterministic ground truth for the anti-fabrication gate.
    wrote: bool,
    /// CHG-33: set when web_search hit a rate-limit/human-check this turn, so
    /// further searches short-circuit instead of deepening the ban.
    web_search_throttled: bool,
    /// ADD-21: cloud-advisor consults spent this turn, capped at
    /// `MAX_ADVISOR_CALLS`.
    advisor_calls: u8,
}

/// CHG-4/CHG-30: keep the running message list within a char budget so many
/// tool rounds can't silently overflow num_ctx (Ollama then drops the user's
/// question and earliest tool results). Stubs the content of older tool-role
/// messages (oldest first), preserving the system message, the user question,
/// every assistant tool_calls message (role pairing), and the most recent
/// results. Pure and testable.
fn trim_messages_to_budget(messages: &mut [ollama::ChatMessage], tools_chars: usize) {
    let msg_len = |m: &ollama::ChatMessage| {
        m.content.len() + m.tool_calls.as_ref().map_or(0, |t| t.to_string().len())
    };
    let total: usize = tools_chars + messages.iter().map(msg_len).sum::<usize>();
    if total <= CTX_CHAR_BUDGET {
        return;
    }
    let mut over = total - CTX_CHAR_BUDGET;
    // Never stub the most recent 4 messages (≈ the last round or two), nor the
    // system message at index 0.
    let keep_from = messages.len().saturating_sub(4);
    for m in messages.iter_mut().take(keep_from).skip(1) {
        if over == 0 {
            break;
        }
        if m.role == "tool" && m.content.len() > 80 {
            let label = m.tool_name.clone().unwrap_or_else(|| "tool".into());
            let stub = format!("[{label} result trimmed to fit context — already used above]");
            let saved = m.content.len().saturating_sub(stub.len());
            m.content = stub;
            over = over.saturating_sub(saved);
        }
    }
}

/// CHG-5: map a tool name to a short human label shown as a step chip while
/// the answer streams (replaces the old inline "⚙ name…" text).
fn tool_step_label(name: &str) -> String {
    match name {
        "list_room_files" => "Listed the room's files",
        "search_room" => "Searched the room",
        "open_file" => "Opened a file",
        "mark_image" => "Marked an image",
        "annotate_file" => "Highlighted a passage",
        "create_file" => "Created a file",
        "edit_file" => "Edited a file",
        "write_file" => "Rewrote a file",
        "set_cells" => "Updated spreadsheet cells",
        "add_memory" => "Saved a memory",
        "web_search" => "Searched the web",
        "fetch_page" => "Fetched a page",
        // ADD-21: name the exfiltration plainly — the local model just chose to
        // send a subtask to the cloud.
        "consult_advisor" => "Consulting a cloud advisor (content leaves this Mac)",
        // Connected MCP tools are namespaced server_tool.
        _ => return format!("Ran the {name} tool"),
    }
    .to_string()
}

#[allow(clippy::too_many_arguments)]
async fn agent_loop(
    window: &tauri::Window,
    state: &State<'_, AppState>,
    model: &str,
    // ADD-22: the raw user question, used by the deterministic tool-subset router
    // (not the model) to decide which built-in tools to offer this turn.
    question: &str,
    mut messages: Vec<ollama::ChatMessage>,
    temperature: Option<f64>,
    effects: &mut ToolEffects,
    web_enabled: bool,
    // ADD-21: cloud CLIs the model may consult as advisors this turn (empty
    // when the advanced setting is off or none are installed). Injected here,
    // never into `tools_catalog`, so it never reaches the room bridge.
    advisors: &[String],
    // ADD-21: per-ask bridge giving a Claude advisor the room's tools (when the
    // sub-option is on); None otherwise.
    advisor_bridge: Option<&crate::room_mcp::Bridge>,
    cancel: Arc<AtomicBool>,
    injected_rowids: &HashSet<i64>,
) -> Result<String, String> {
    use tauri::Emitter;
    // ADD-22: let the user see which lane the deterministic router chose, so an
    // odd answer is explainable ("oh, it thought I wanted an edit").
    let _ = window.emit("ask-lane", lane_label(question, web_enabled));
    let mut tools = tools_catalog(web_enabled);
    // ADD-22: deterministic tool-subset router — withhold the file-mutating
    // tools on a plain informational turn so the small model chooses from a
    // short list. MCP + advisor tools are added afterward and never filtered
    // (the user connected those explicitly).
    if !wants_write_tools(question) {
        if let Some(arr) = tools.as_array_mut() {
            arr.retain(|t| {
                let name = t["function"]["name"].as_str().unwrap_or("");
                !WRITE_TOOL_NAMES.contains(&name)
            });
        }
    }
    let (routes, omitted_mcp) = mcp_routes(state);
    if let Some(arr) = tools.as_array_mut() {
        for r in &routes {
            arr.push(r.spec.clone());
        }
        if !advisors.is_empty() {
            arr.push(consult_advisor_spec(advisors));
        }
    }
    // ADD-21: tell the model the advisor exists and that it is a last resort —
    // the tool description says the same, but the system prompt sets the bar.
    if !advisors.is_empty() {
        if let Some(sys) = messages.first_mut() {
            if sys.role == "system" {
                sys.content.push_str(
                    "\n\nYou also have consult_advisor: a powerful CLOUD AI (Claude or Codex) you \
                     can delegate ONE genuinely hard subtask to — deep research or complex \
                     reasoning/coding beyond your own ability. It is slow and its input leaves this \
                     Mac, so use it only as a last resort, never for something you can answer \
                     yourself, and at most once. Put the whole self-contained task in `question`.",
                );
            }
        }
    }
    // CHG-29: tell the model which connected tools were dropped for space so it
    // doesn't try to call them.
    if !omitted_mcp.is_empty() {
        if let Some(sys) = messages.first_mut() {
            if sys.role == "system" {
                sys.content.push_str(&format!(
                    "\n\nSome connected tools were omitted to save memory: {}.",
                    omitted_mcp.join(", ")
                ));
            }
        }
    }
    // Web flows chain search → fetch → answer; give them more rounds. A consult
    // → synthesize path needs the extra room too.
    let max_rounds = if routes.is_empty() && !web_enabled && advisors.is_empty() {
        4
    } else {
        8
    };
    // CHG-32: an empty catalog keeps num_ctx at 12288 (tools.is_some()) while
    // forbidding further tool calls — forces a grounded text answer on the
    // final round instead of letting side-effect tools run unread.
    let no_tools = serde_json::json!([]);
    let tools_chars = tools.to_string().len();
    // CHG-3: remember (name, args) of successful calls to skip exact repeats.
    let mut seen: HashSet<(String, String)> = HashSet::new();
    // CHG-3/CHG-32: force a tool-less synthesis round after an all-duplicate
    // round (the model is looping) rather than burning the budget on repeats.
    let mut force_synthesis = false;
    let mut final_text = String::new();
    for round in 0..max_rounds {
        // ADD-7: stop between rounds too.
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        // CHG-0/CHG-32: the final round (and any forced synthesis) is tool-less
        // so the loop always ends with a text answer grounded in prior results.
        let last = round + 1 == max_rounds || force_synthesis;
        // CHG-4/CHG-30: keep the running context within budget before sending.
        trim_messages_to_budget(&mut messages, tools_chars);
        // CHG-5: a fresh model round begins — frontend clears its live text so
        // the visible stream always equals only the current round's words.
        let _ = window.emit("ask-round", ());
        let offered = if last { &no_tools } else { &tools };
        let (content, calls) = ollama::chat_stream_tools(
            model,
            messages.clone(),
            Some(offered),
            temperature,
            Some(cancel.clone()),
            // HLT-5: the chat model stays warm throughout the conversation.
            KEEP_ALIVE_WARM,
            |d| {
                let _ = window.emit("ask-delta", d);
            },
        )
        .await?;
        if calls.is_empty() || cancel.load(Ordering::SeqCst) || last {
            final_text = content;
            break;
        }
        let raw_calls: Vec<serde_json::Value> = calls.iter().map(|c| c.raw.clone()).collect();
        messages.push(ollama::ChatMessage {
            role: "assistant".into(),
            content: content.clone(),
            tool_calls: Some(serde_json::json!(raw_calls)),
            ..Default::default()
        });
        // Penultimate round: nudge the small model to wrap up next turn.
        let near_budget = round + 2 >= max_rounds;
        let mut all_dup = true;
        for call in &calls {
            // ADD-7: stop between tool calls.
            if cancel.load(Ordering::SeqCst) {
                break;
            }
            let key = (call.name.clone(), call.arguments.to_string());
            if seen.contains(&key) {
                // CHG-3: don't re-run an identical call or re-flood context.
                messages.push(ollama::ChatMessage {
                    role: "tool".into(),
                    content: format!(
                        "Duplicate call: you already ran {} with these exact arguments this \
                         turn; the result is above. Use it, or call with different arguments.",
                        call.name
                    ),
                    tool_name: Some(call.name.clone()),
                    ..Default::default()
                });
                continue;
            }
            all_dup = false;
            // CHG-5: human step label, not inline "⚙ name…" answer text.
            let _ = window.emit("ask-step", tool_step_label(&call.name));
            let outcome = exec_tool(
                state,
                window,
                call,
                effects,
                &routes,
                injected_rowids,
                Some(cancel.clone()),
                advisor_bridge,
            )
            .await;
            // ADD-22: tell the UI whether this step succeeded, so a failed tool
            // chip reads as failed instead of looking identical to a success.
            let _ = window.emit("ask-step-status", serde_json::json!({ "ok": outcome.is_ok() }));
            // Only remember successful calls, so a failed one may retry once.
            let mut result = match outcome {
                Ok(r) => {
                    seen.insert(key);
                    r
                }
                Err(e) => format!("Tool error: {e}"),
            };
            if near_budget {
                result.push_str(
                    "\n[Note: tool budget nearly exhausted — answer the user in your next reply.]",
                );
            }
            messages.push(ollama::ChatMessage {
                role: "tool".into(),
                content: result,
                tool_name: Some(call.name.clone()),
                ..Default::default()
            });
        }
        // A round of only repeats means the model is stuck; force a tool-less
        // synthesis next round instead of looping to the budget.
        if all_dup {
            force_synthesis = true;
        }
        final_text = content;
    }
    // Don't invent "Done." over a partial answer the user stopped. After the
    // tool-less final round this is a genuine dead-path net, not the outcome.
    if final_text.trim().is_empty() && !cancel.load(Ordering::SeqCst) {
        final_text = "Done.".into();
    }
    Ok(final_text)
}

#[allow(clippy::too_many_arguments)]
/// SEC-1b: prompt the frontend to approve one MCP tool call, tying consent to
/// the moment data actually leaves the room. Returns true when the user allows
/// it — or already chose "always allow" for this connector this session. A
/// timeout or a closed window counts as a decline, never a silent yes.
async fn mcp_call_approved(
    state: &State<'_, AppState>,
    window: &tauri::Window,
    route: &McpRoute,
    args: &serde_json::Value,
) -> bool {
    use tauri::Emitter;
    if state
        .mcp_session_ok
        .lock()
        .unwrap()
        .contains(&route.server_name)
    {
        return true;
    }
    let id = Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel::<McpDecision>();
    state.mcp_pending.lock().unwrap().insert(id.clone(), tx);
    let preview: String = args.to_string().chars().take(400).collect();
    let _ = window.emit(
        "mcp-approve-request",
        serde_json::json!({
            "id": id,
            "server": route.server_name,
            "tool": route.tool_name,
            "args": preview,
        }),
    );
    let decision = match tokio::time::timeout(std::time::Duration::from_secs(180), rx).await {
        Ok(Ok(d)) => d,
        _ => {
            state.mcp_pending.lock().unwrap().remove(&id);
            McpDecision { approved: false, remember: false }
        }
    };
    if decision.approved && decision.remember {
        state
            .mcp_session_ok
            .lock()
            .unwrap()
            .insert(route.server_name.clone());
    }
    decision.approved
}

/// The frontend's answer to an `mcp-approve-request` — "once", "always", or
/// anything else (declined).
#[tauri::command]
pub fn resolve_mcp_call(
    state: State<'_, AppState>,
    id: String,
    decision: String,
) -> Result<(), String> {
    let d = match decision.as_str() {
        "once" => McpDecision { approved: true, remember: false },
        "always" => McpDecision { approved: true, remember: true },
        _ => McpDecision { approved: false, remember: false },
    };
    if let Some(tx) = state.mcp_pending.lock().unwrap().remove(&id) {
        let _ = tx.send(d);
    }
    Ok(())
}

pub(crate) async fn exec_tool(
    state: &State<'_, AppState>,
    window: &tauri::Window,
    call: &ollama::ToolCall,
    effects: &mut ToolEffects,
    routes: &[McpRoute],
    injected_rowids: &HashSet<i64>,
    // ADD-21: the ask's cancel flag, so a long consult_advisor child dies on
    // Stop. `None` from callers with nothing to cancel (e.g. the room bridge).
    cancel: Option<Arc<AtomicBool>>,
    // ADD-21: the per-ask advisor bridge (room tools for a Claude advisor),
    // started in `ask` and passed down. `None` disables the room-tools handoff.
    // Threaded in rather than started here to avoid an async-recursion cycle.
    advisor_bridge: Option<&crate::room_mcp::Bridge>,
) -> Result<String, String> {
    use tauri::Emitter;
    let args = &call.arguments;
    match call.name.as_str() {
        "list_room_files" => {
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().ok_or("No room is open.")?;
            let all = db::list_files_brief(&room.conn)?;
            let total = all.len();
            // CHG-1: this was the one tool result that bypassed clamping; cap the
            // row count and clamp as a backstop so a file-heavy room can't crowd
            // out the system prompt. CHG-23: show each file's cached one-liner.
            let mut rows: Vec<String> = all
                .into_iter()
                .take(100)
                .map(|(name, mime, size, summary)| match summary {
                    Some(s) if !s.trim().is_empty() => {
                        format!("- {name} ({mime}, {size} bytes) — {}", clamp_words(s.trim(), 120))
                    }
                    _ => format!("- {name} ({mime}, {size} bytes)"),
                })
                .collect();
            if total > 100 {
                rows.push(format!(
                    "…and {} more files — use search_room to find content or open_file by name.",
                    total - 100
                ));
            }
            Ok(if rows.is_empty() {
                "The room has no files.".into()
            } else {
                clamp_tool_result(rows.join("\n"))
            })
        }
        "search_room" => {
            let query = args["query"].as_str().unwrap_or_default();
            // ADD-13: embed the query before locking (async Ollama call); None
            // → keyword-only retrieval.
            let query_embedding = embed_question(query).await;
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().ok_or("No room is open.")?;
            // CHG-16: skip chunks already injected into the prompt as context.
            let (chunks, fallback) = retrieve_context_excluding(
                &room.conn,
                query,
                query_embedding.as_deref(),
                injected_rowids,
            )?;
            if fallback {
                return Ok("No matching content found.".into());
            }
            if chunks.is_empty() {
                // Exclusion removed everything → the best matches are the
                // excerpts already shown above.
                return Ok("The best matches are already in the context excerpts above; \
                           try different keywords for anything else."
                    .into());
            }
            Ok(chunks
                .iter()
                .take(4)
                // Char-safe, match-centered excerpt (was a raw byte slice that
                // panicked on multibyte text and poisoned the room mutex).
                .map(|c| format!("[{}]\n{}", c.file_name, excerpt(&c.text, query, 800)))
                .collect::<Vec<_>>()
                .join("\n\n"))
        }
        "open_file" => {
            let name = args["name"].as_str().unwrap_or_default().to_lowercase();
            let page = args["page"].as_u64();
            let cell = args["cell"].as_str().filter(|c| parse_a1(c).is_some());
            let find = args["find"].as_str().filter(|f| !f.trim().is_empty());
            let (id, real_name, text) = {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                db::find_file_like_full(&room.conn, &name)?
            };
            let _ = window.emit(
                "agent-open-file",
                serde_json::json!({ "id": id, "page": page, "cell": cell, "find": find }),
            );
            let target = match (page, cell, find) {
                (Some(p), _, _) => format!(" at page {p}"),
                (_, Some(c), _) => format!(" at cell {c}"),
                (_, _, Some(f)) => format!(" at \"{f}\""),
                _ => String::new(),
            };
            let snippet = text
                // Char-safe prefix (was a raw byte slice that panicked on
                // multibyte text).
                .map(|t| format!("\nIt begins:\n{}", clamp_bytes(t, 1200)))
                .unwrap_or_default();
            Ok(format!("Opened \"{real_name}\" in the viewer{target}.{snippet}"))
        }
        "annotate_file" => {
            let name = args["name"].as_str().unwrap_or_default();
            let quote = args["text"].as_str().unwrap_or_default().trim().to_string();
            let page = args["page"].as_u64();
            let sheet = args["sheet"].as_str().map(str::to_string);
            let range = args["range"].as_str().unwrap_or_default().trim().to_uppercase();
            let note = args["note"].as_str().map(str::to_string);
            let (id, real_name, extracted): (String, String, Option<String>) = {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                let (id, real_name) = db::find_file_like(&room.conn, name)?;
                let extracted = db::get_file_extracted_text(&room.conn, &id);
                (id, real_name, extracted)
            };
            let (payload, described) = build_annotation(
                &id,
                &real_name,
                extracted.as_deref(),
                &quote,
                &range,
                page,
                sheet.as_deref(),
                note.as_deref(),
            )?;
            effects.annotation = Some(payload.clone());
            let _ = window.emit("agent-annotate", &payload);
            Ok(format!(
                "Highlighted {described} in \"{real_name}\" — the user can now see it marked in the viewer."
            ))
        }
        "edit_file" => {
            let name = args["name"].as_str().unwrap_or_default();
            let old_text = args["old_text"].as_str().unwrap_or_default();
            let new_text = args["new_text"].as_str().unwrap_or_default();
            if old_text.is_empty() {
                return Err("old_text is required — copy the exact text to replace.".into());
            }
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().ok_or("No room is open.")?;
            let (id, real_name) = db::find_file_like(&room.conn, name)?;
            let bytes = db::get_file_bytes(&room.conn, &id)?.ok_or("File has no stored content.")?;
            let ext = extraction::extension_of(&real_name);
            let (new_bytes, count) = match ext.as_str() {
                "docx" => extraction::docx_replace_text(&bytes, old_text, new_text)?,
                "xlsx" | "xls" => {
                    return Err(
                        "Spreadsheet cells are edited with set_cells (e.g. cell B7), not edit_file."
                            .into(),
                    )
                }
                "pdf" => {
                    return Err(
                        "PDF text cannot be edited in place. Use annotate_file to highlight, \
                         or create_file to save a corrected copy of its text."
                            .into(),
                    )
                }
                ext if extraction::is_text_extension(ext) => {
                    let content = String::from_utf8_lossy(&bytes).into_owned();
                    let count = content.matches(old_text).count();
                    if count == 0 {
                        // ADD-22: show the closest real passage so the model can
                        // retry with the exact text instead of guessing again.
                        let hint = closest_snippet(&content, old_text)
                            .map(|s| format!(" The closest text in the file is: \"{}\".", clamp_bytes(s, 200)))
                            .unwrap_or_default();
                        return Err(format!(
                            "Could not find that exact text in \"{real_name}\". Copy it exactly, \
                             including spacing and punctuation.{hint}"
                        ));
                    }
                    (content.replace(old_text, new_text).into_bytes(), count)
                }
                _ => {
                    return Err(
                        "This file type cannot be edited in place. Use create_file to save an \
                         edited copy of its text instead."
                            .into(),
                    )
                }
            };
            let text = extraction::extract_text(&real_name, &new_bytes)
                .or_else(|| String::from_utf8(new_bytes.clone()).ok());
            store_file_bytes(&room.conn, &id, &new_bytes, text.as_deref(), "AI edit")?;
            let _ = window.emit("room-files-changed", ());
            let _ = window.emit("file-updated", &id);
            effects.wrote = true;
            Ok(format!(
                "Replaced {count} occurrence(s) in \"{real_name}\". The user sees the updated file."
            ))
        }
        "write_file" => {
            let name = args["name"].as_str().unwrap_or_default();
            let content = args["content"].as_str().unwrap_or_default();
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().ok_or("No room is open.")?;
            let (id, real_name) = db::find_file_like(&room.conn, name)?;
            let ext = extraction::extension_of(&real_name);
            if !extraction::is_text_extension(&ext) {
                return Err(format!(
                    "\"{real_name}\" is not a plain-text file — write_file only rewrites text \
                     files. Use edit_file (docx), set_cells (spreadsheets), or create_file."
                ));
            }
            let text = extraction::extract_text(&real_name, content.as_bytes())
                .unwrap_or_else(|| content.to_string());
            store_file_bytes(&room.conn, &id, content.as_bytes(), Some(&text), "AI rewrite")?;
            let _ = window.emit("room-files-changed", ());
            let _ = window.emit("file-updated", &id);
            effects.wrote = true;
            Ok(format!(
                "Rewrote \"{real_name}\" ({} characters).",
                content.chars().count()
            ))
        }
        "set_cells" => {
            let name = args["name"].as_str().unwrap_or_default();
            let sheet = args["sheet"].as_str();
            // CHG-2: accept a batch of {cell, value} in one call so filling a
            // column doesn't burn one inference round per cell. Fall back to the
            // legacy single top-level cell/value for older prompts.
            let value_of = |v: &serde_json::Value| -> String {
                v.as_str()
                    .map(str::to_string)
                    // Models sometimes send numbers as JSON numbers.
                    .unwrap_or_else(|| v.to_string().trim_matches('"').to_string())
            };
            let mut updates: Vec<(String, String)> = Vec::new();
            if let Some(arr) = args["updates"].as_array() {
                for u in arr {
                    let cell = u["cell"].as_str().unwrap_or_default().trim().to_uppercase();
                    if !cell.is_empty() {
                        updates.push((cell, value_of(&u["value"])));
                    }
                }
            }
            if updates.is_empty() {
                let cell = args["cell"].as_str().unwrap_or_default().trim().to_uppercase();
                if !cell.is_empty() {
                    updates.push((cell, value_of(&args["value"])));
                }
            }
            if updates.is_empty() {
                return Err("No cells given — pass updates: [{cell, value}, …].".into());
            }
            // Validate every cell up front so a bad reference fails before any write.
            for (cell, _) in &updates {
                if parse_a1(cell).is_none() {
                    return Err(format!("\"{cell}\" is not a cell — use A1 notation like B7."));
                }
            }
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().ok_or("No room is open.")?;
            let (id, real_name) = db::find_file_like(&room.conn, name)?;
            let mut bytes =
                db::get_file_bytes(&room.conn, &id)?.ok_or("File has no stored content.")?;
            let mut text = None;
            for (cell, value) in &updates {
                let (nb, t) = set_cell_in_bytes(&real_name, &bytes, sheet, cell, value)?;
                bytes = nb;
                text = t;
            }
            store_file_bytes(&room.conn, &id, &bytes, text.as_deref(), "AI cell change")?;
            let _ = window.emit("room-files-changed", ());
            let _ = window.emit("file-updated", &id);
            effects.wrote = true;
            let summary = updates
                .iter()
                .map(|(c, v)| format!("{c}={v}"))
                .collect::<Vec<_>>()
                .join(", ");
            Ok(format!("Set {summary} in \"{real_name}\"."))
        }
        "web_search" => {
            let query = args["query"].as_str().unwrap_or_default();
            let (provider, _key, endpoint) = {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                (
                    db::get_setting(&room.conn, "web_provider").unwrap_or_default(),
                    db::get_setting(&room.conn, "web_api_key").unwrap_or_default(),
                    db::get_setting(&room.conn, "web_endpoint").unwrap_or_default(),
                )
            };
            if !matches!(provider.as_str(), "duckduckgo" | "brave" | "searxng") {
                return Ok("Web access is turned off in Settings → Online features.".into());
            }
            // CHG-33: serve a recent (<15m) cached result list without touching
            // the network. Catches exact repeats and case/spacing variants — a
            // common small-model failure mode — and avoids deepening any ban.
            let cached = {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                db::get_fresh_web_search(&room.conn, &provider, &endpoint, query)
            };
            if let Some(results) = cached {
                let _ = window.emit(
                    "ask-step",
                    format!("Using recent search results for \"{query}\" (from this Mac's cache)"),
                );
                return Ok(clamp_tool_result(results));
            }
            // CHG-33: once throttled this turn, don't hammer the provider — steer
            // the model to salvage the answer from what it already has.
            if effects.web_search_throttled {
                return Ok("Web search is temporarily rate-limited; answer from what you \
                           already have or from fetched pages — do not search again this turn."
                    .into());
            }
            let _ = window.emit(
                "ask-step",
                format!("Searching the web for \"{query}\" (leaves this Mac)"),
            );
            let result = match provider.as_str() {
                "duckduckgo" | "brave" => web::search_duckduckgo(query).await,
                _ => web::search_searxng(&endpoint, query).await,
            };
            let hits = match result {
                Ok(h) => h,
                Err(e) => {
                    let low = e.to_lowercase();
                    if low.contains("rate-limit") || low.contains("human check") {
                        effects.web_search_throttled = true;
                    }
                    return Err(e);
                }
            };
            if hits.is_empty() {
                return Ok("No results found.".into());
            }
            let results = hits
                .iter()
                .enumerate()
                .map(|(i, h)| format!("{}. {}\n   {}\n   {}", i + 1, h.title, h.url, h.snippet))
                .collect::<Vec<_>>()
                .join("\n");
            {
                let guard = state.room.lock().unwrap();
                if let Some(room) = guard.as_ref() {
                    let _ = db::put_web_search(&room.conn, &provider, &endpoint, query, &results);
                }
            }
            Ok(clamp_tool_result(results))
        }
        "fetch_page" => {
            let url = args["url"].as_str().unwrap_or_default();
            // CHG-5/CHG-28: continue reading a long page from a char offset.
            let start = args["start"].as_u64().unwrap_or(0) as usize;
            let enabled = {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                web_access_enabled(&room.conn)
            };
            if !enabled {
                return Ok("Web access is turned off in Settings → Online features.".into());
            }
            // RM-2: serve a fresh (<24h) cached copy without touching the network.
            let cached = {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                db::get_fresh_web_page(&room.conn, url)
            };
            let (title, text) = if let Some(hit) = cached {
                hit
            } else {
                let _ = window.emit("ask-step", format!("Fetching {url} (leaves this Mac)"));
                let (title, text) = web::fetch_page(url).await?;
                {
                    let guard = state.room.lock().unwrap();
                    let room = guard.as_ref().ok_or("No room is open.")?;
                    let _ = db::save_web_page(&room.conn, url, &title, &text);
                }
                (title, text)
            };
            Ok(fetch_page_window(&title, url, &text, start))
        }
        "mark_image" => {
            let image_name = args["image_name"].as_str().unwrap_or_default().to_lowercase();
            let find = args["find"].as_str().unwrap_or_default();
            let (id, real_name, bytes, explicit) = {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                let (id, real_name, bytes) = db::find_image_like(&room.conn, &image_name)?;
                (id, real_name, bytes, model_setting(&room.conn))
            };
            // CHG-17: if this image was already grounded this turn, don't run a
            // second multi-GB vision pass — reuse the existing boxes.
            if let Some(existing) = &effects.boxes {
                if existing.get("fileId").and_then(|v| v.as_str()) == Some(id.as_str()) {
                    return Ok(format!("The image \"{real_name}\" is already marked."));
                }
            }
            let (prepared, w, h) = prepare_image(&bytes);
            let models = ollama::list_models().await.unwrap_or_default();
            // CHG-20: honor the room's chosen model (like locate_in_image), so
            // vision_keep_alive computes the right keep-alive and grounding uses
            // the user's model when no separate VL model is installed.
            let chat_model = explicit.unwrap_or_else(|| best_default(&models));
            let vmodel = {
                let v = vision_model(&models, &chat_model);
                if is_external_engine(&v) { chat_model.clone() } else { v }
            };
            let messages = vec![ollama::ChatMessage {
                role: "user".into(),
                content: grounding_prompt(find, w, h),
                images: Some(vec![base64::engine::general_purpose::STANDARD.encode(&prepared)]),
                ..Default::default()
            }];
            // HLT-5: short keep_alive on low-RAM machines when vision != chat.
            let keep = vision_keep_alive(total_ram_bytes(), &vmodel, &chat_model);
            let raw =
                ollama::chat_structured(&vmodel, messages, Some(0.0), keep, &boxes_schema()).await?;
            let boxes = parse_boxes(&raw, w, h);
            if boxes.is_empty() {
                return Ok(format!("Could not locate \"{find}\" in {real_name}."));
            }
            effects.boxes = Some(serde_json::json!({
                "fileId": id, "name": real_name, "boxes": boxes,
            }));
            Ok(format!(
                "Marked {} match(es) for \"{find}\" on {real_name}. The marked image will be shown with your reply.",
                boxes.len()
            ))
        }
        "create_file" => {
            let name = args["name"].as_str().unwrap_or("AI note").to_string();
            let content = args["content"].as_str().unwrap_or_default().to_string();
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().ok_or("No room is open.")?;
            // ADD-22 (HTML-first): a document with no explicit extension defaults
            // to HTML; body/plain content is wrapped in a styled standalone page
            // (a no-op when the model already returned a full HTML document).
            let name = if extraction::extension_of(&name).is_empty() {
                format!("{name}.html")
            } else {
                name
            };
            let content = if extraction::extension_of(&name) == "html" {
                html_document(&name, &content)
            } else {
                content
            };
            let mime = mime_guess::from_path(&name)
                .first_or(mime_guess::mime::TEXT_PLAIN)
                .essence_str()
                .to_string();
            let meta = db::insert_file(&room.conn, &name, &mime, content.as_bytes(), Some(&content), "generated")?;
            let _ = window.emit("room-files-changed", ());
            effects.wrote = true;
            Ok(format!("Created \"{}\" in the room.", meta.name))
        }
        "add_memory" => {
            let raw = args["content"].as_str().unwrap_or_default();
            if raw.chars().count() > MAX_MEMORY_CONTENT_CHARS {
                // Let the model self-correct rather than silently truncating.
                return Ok(format!(
                    "Memory too long ({} chars); save a shorter note under {} characters.",
                    raw.chars().count(),
                    MAX_MEMORY_CONTENT_CHARS
                ));
            }
            let content = raw;
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().ok_or("No room is open.")?;
            // UX-5: don't store an exact duplicate; tell the model so it stops.
            if duplicate_memory(&room.conn, content)?.is_some() {
                return Ok("Already remembered.".into());
            }
            db::add_memory(&room.conn, content)?;
            Ok("Memory saved.".into())
        }
        // ADD-21: delegate a hard subtask to a cloud CLI. Gated: the tool is
        // only in the catalog when the advanced setting is on and a CLI exists,
        // but re-check the budget here so the model can't overspend the user's
        // cloud account by looping.
        "consult_advisor" => {
            if effects.advisor_calls >= MAX_ADVISOR_CALLS {
                return Ok("You have already consulted an advisor this turn. Use that answer, or \
                           answer the user yourself — do not consult again.".into());
            }
            let question = args["question"].as_str().unwrap_or_default().trim().to_string();
            if question.is_empty() {
                return Err("consult_advisor needs a non-empty `question` holding the full, \
                            self-contained task and all context the advisor will need.".into());
            }
            let want = args["advisor"].as_str().unwrap_or("claude");
            let engine = if want == "codex" { "codex-cli" } else { "claude-cli" };
            // Spend the budget before the slow call so a mid-flight retry can't
            // double-spend.
            effects.advisor_calls += 1;
            // The per-ask advisor bridge (started in `ask`, giving the room's
            // tools to the advisor) is claude-only; codex gets a plain pipe.
            // Starting the bridge here would create an async-recursion cycle
            // exec_tool → start → bridge → exec_tool, so it is passed in.
            let bridge = if engine == "claude-cli" { advisor_bridge } else { None };
            let msgs = vec![ollama::ChatMessage::new("user", question)];
            let res = run_external(engine, &msgs, cancel.clone(), bridge).await;
            match res {
                Ok(answer) => Ok(format!(
                    "Advisor ({want}) replied:\n\n{}",
                    clamp_tool_result(answer)
                )),
                // Return Ok so the local model recovers by answering itself,
                // instead of surfacing a raw tool error to the user.
                Err(e) => Ok(format!(
                    "The advisor could not be reached ({e}). Answer the user from what you \
                     already have."
                )),
            }
        }
        other => match routes.iter().find(|r| r.catalog_name == other) {
            Some(route) => {
                // SEC-1b: consent is tied to the moment data actually leaves the
                // room. Ask the user before invoking a connector's tool, unless
                // they chose "always allow" for it earlier this session.
                if !mcp_call_approved(state, window, route, args).await {
                    return Ok(format!(
                        "The user declined to run the \"{}\" tool from \"{}\", so it did \
                         not run and nothing left this room. Answer from what you already \
                         have, and tell the user you skipped that connected tool.",
                        route.tool_name, route.server_name
                    ));
                }
                let result = route
                    .client
                    .lock()
                    .await
                    .call_tool(&route.tool_name, args)
                    .await?;
                Ok(clamp_tool_result(result))
            }
            None => Err(format!("Unknown tool: {other}")),
        },
    }
}

/// CHG-5/CHG-28: format one window of a fetched page's readable text starting at
/// char offset `start`. When more text remains, the truncation notice tells the
/// model the exact `start` to pass to keep reading (served from cache — no new
/// network). Char-safe throughout.
fn fetch_page_window(title: &str, url: &str, text: &str, start: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let total = chars.len();
    let start = start.min(total);
    let header = format!("[{title}] {url}\n\n");
    // Leave room for the header within the per-result char budget.
    let window = MAX_TOOL_RESULT_CHARS.saturating_sub(header.chars().count() + 120);
    let end = (start + window).min(total);
    let body: String = chars[start..end].iter().collect();
    let mut out = format!("{header}{body}");
    if end < total {
        out.push_str(&format!(
            "\n… truncated at char {end} of {total}. To keep reading, call fetch_page again \
             with the same url and start={end} (instant, served from cache)."
        ));
    }
    out
}

/// Clamp at a char boundary — external tool output can be multibyte.
fn clamp_tool_result(s: String) -> String {
    if s.chars().count() <= MAX_TOOL_RESULT_CHARS {
        return s;
    }
    let mut cut: String = s.chars().take(MAX_TOOL_RESULT_CHARS).collect();
    cut.push_str("\n… (truncated)");
    cut
}

/// Largest byte index <= `max` that is a char boundary. Stable-Rust stand-in
/// for the nightly `str::floor_char_boundary`. Used everywhere text is clipped
/// by a byte budget, so a multibyte char straddling the limit never panics.
fn floor_boundary(s: &str, max: usize) -> usize {
    if max >= s.len() {
        return s.len();
    }
    let mut cut = max;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    cut
}

/// Truncate a string to at most `max` bytes without ever splitting a char.
/// Returns the (possibly unchanged) string; appends nothing.
fn clamp_bytes(mut s: String, max: usize) -> String {
    if s.len() > max {
        s.truncate(floor_boundary(&s, max));
    }
    s
}

/// Clip a string to `max` chars at a trailing word boundary when possible,
/// for one-line inventory descriptions. Never splits a char.
fn clamp_words(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    if let Some(sp) = out.rfind(char::is_whitespace) {
        if sp > max / 2 {
            out.truncate(sp);
        }
    }
    out.push('…');
    out
}

/// ADD-13 fix: a char-safe, whitespace-preserving excerpt centered on the
/// first case-insensitive match of `query` (falling back to the first query
/// word, then the text start). Unlike `make_snippet` this keeps the original
/// whitespace, so quotes returned by search_room stay verbatim-copyable for
/// edit_file / annotate_file. Never slices a char (fixes the byte-index panic
/// that poisoned the room mutex).
fn excerpt(text: &str, query: &str, max_chars: usize) -> String {
    let lower = text.to_lowercase();
    let find = |n: &str| -> Option<usize> {
        let n = n.trim().to_lowercase();
        if n.is_empty() {
            None
        } else {
            lower.find(&n)
        }
    };
    let chars: Vec<char> = text.chars().collect();
    let Some(byte) = find(query).or_else(|| query.split_whitespace().find_map(find)) else {
        // No match: char-safe prefix.
        let mut out: String = chars.iter().take(max_chars).collect();
        if chars.len() > max_chars {
            out.push('…');
        }
        return out;
    };
    let char_pos = text[..byte].chars().count();
    let radius = max_chars / 2;
    let start = char_pos.saturating_sub(radius);
    let end = (start + max_chars).min(chars.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(&chars[start..end]);
    if end < chars.len() {
        out.push('…');
    }
    out
}

/// CHG-8: compact chat history under a single char budget. `history` is
/// oldest-first. We walk newest-first, keeping whole turns until the budget is
/// spent (recency-weighted), and drop older turns entirely instead of cutting
/// each to a fixed head. A turn that alone exceeds the budget is cut at the
/// last paragraph boundary before the limit with an explicit omitted-marker,
/// so the model never sees a silently unterminated prior turn. Char-safe.
fn compact_history(history: Vec<(String, String)>, budget: usize) -> Vec<(String, String)> {
    let mut kept: Vec<(String, String)> = Vec::new();
    let mut remaining = budget;
    for (role, content) in history.into_iter().rev() {
        // Viewer-markup payloads are UI data, not conversation.
        let content = strip_markup_blocks(&content);
        if content.is_empty() {
            continue;
        }
        if content.len() <= remaining {
            remaining -= content.len();
            kept.push((role, content));
            continue;
        }
        // Doesn't fully fit. If we have room for a useful fragment of the
        // newest such turn, cut it at a paragraph boundary; otherwise stop.
        if remaining < 400 {
            break;
        }
        let cut = floor_boundary(&content, remaining.saturating_sub(40));
        let end = content[..cut].rfind("\n\n").unwrap_or(cut);
        let mut piece = content[..end].to_string();
        piece.push_str("\n… [rest of this message omitted]");
        kept.push((role, piece));
        break;
    }
    kept.reverse();
    kept
}

/// CHG-10: conservative check for a first-person/passive past-tense claim that a
/// file was changed or a passage highlighted, used only to append a correction
/// when the runtime knows no such effect occurred (`wrote`/`highlighted`). Skips
/// negated and conditional phrasings, and ignores fenced code/diff blocks, so a
/// false correction (its own trust failure) is unlikely. Returns true only when
/// there is a claim AND the corresponding effect is missing.
fn claims_unbacked_action(text: &str, wrote: bool, highlighted: bool) -> bool {
    // Drop fenced blocks (diffs, code, viewer markup) before scanning prose.
    let mut prose = String::new();
    let mut in_fence = false;
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if !in_fence {
            prose.push_str(line);
            prose.push('\n');
        }
    }
    let lower = prose.to_lowercase();
    // Verb phrases that assert an action already happened.
    const WRITE_CLAIMS: &[&str] = &[
        "i've updated",
        "i have updated",
        "i've edited",
        "i have edited",
        "i've changed",
        "i have changed",
        "i've saved",
        "i have saved",
        "i've fixed",
        "i have fixed",
        "i've rewritten",
        "i've rewrote",
        "i updated the",
        "i edited the",
        "i changed the",
        "i saved the",
        "i fixed the",
        "i've created",
        "i created the",
        "i set ",
        "file has been updated",
        "file was updated",
        "file has been saved",
        "file was saved",
        "file has been changed",
        "the file is updated",
    ];
    const HL_CLAIMS: &[&str] = &[
        "i've highlighted",
        "i have highlighted",
        "i highlighted the",
        "i've marked",
        "i marked the",
        "i've boxed",
        "i boxed the",
        "i've circled",
    ];
    // A crude negation guard: skip a claim if "not"/"n't"/"unable"/"couldn't"
    // appears in the same line as the matched phrase.
    let has_claim = |claims: &[&str]| -> bool {
        for c in claims {
            let mut from = 0;
            while let Some(pos) = lower[from..].find(c) {
                let abs = from + pos;
                let line_start = lower[..abs].rfind('\n').map(|i| i + 1).unwrap_or(0);
                let line_end = lower[abs..].find('\n').map(|i| abs + i).unwrap_or(lower.len());
                let line = &lower[line_start..line_end];
                let negated = ["not ", "n't", "unable", "cannot", "can't", "could not", "couldn't", "would ", "if "]
                    .iter()
                    .any(|n| line.contains(n));
                if !negated {
                    return true;
                }
                from = line_end;
            }
        }
        false
    };
    (!wrote && has_claim(WRITE_CLAIMS)) || (!highlighted && has_claim(HL_CLAIMS))
}

/// CHG-7: choose which persistent memories to inject under a char budget,
/// preferring ones whose text overlaps the question's keywords, then recency.
/// `memories` is oldest-first (list_memories order); returns the selected
/// memory strings in the order they should be shown.
fn select_memories(memories: &[String], question: &str, budget: usize) -> Vec<String> {
    let terms = question_terms(question);
    // Score = overlapping keyword count; recency breaks ties (tail = newest).
    let mut scored: Vec<(usize, usize, &String)> = memories
        .iter()
        .enumerate()
        .map(|(idx, m)| {
            let lower = m.to_lowercase();
            let hits = terms.iter().filter(|t| lower.contains(t.as_str())).count();
            (hits, idx, m)
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    let mut out = Vec::new();
    let mut used = 0usize;
    for (_, _, m) in scored {
        let cost = m.len() + 3; // "- " + "\n"
        if used + cost > budget {
            continue;
        }
        used += cost;
        out.push(m.clone());
    }
    out
}

// ================================================================= chat commands
// Prebuilt "#name …" workflows. Typing "#" is deterministic routing done by the
// most reliable router available — a human — so the small local model is invoked
// only at the fuzzy nodes (write this text, pick this quote, list these items)
// with a tiny task prompt instead of the full agent loop's tool-selection
// gamble. "@name" pins a file/folder as guaranteed context (handled frontend-
// side by resolving to attachment ids). Every command is a fixed pipeline in
// code; the model never sees the "#"/"@" syntax.

/// One entry in the command catalog, surfaced to the UI for autocomplete/help.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatCommandInfo {
    pub name: &'static str,
    pub summary: &'static str,
    pub usage: &'static str,
    /// True when the command works on @-pinned files.
    pub needs_refs: bool,
}

/// The command catalog. Keep in sync with the `run_command` dispatch below.
pub const CHAT_COMMANDS: &[ChatCommandInfo] = &[
    ChatCommandInfo {
        name: "add-file",
        summary: "Write a new note or document — or one per item with \"for each\"",
        usage: "#add-file <name>: <topic>   ·   #add-file for each <thing>",
        needs_refs: false,
    },
    ChatCommandInfo {
        name: "remember",
        summary: "Save a fact to the room's permanent memory",
        usage: "#remember <fact>",
        needs_refs: false,
    },
    ChatCommandInfo {
        name: "find",
        summary: "Search the room's files for content and list what matches",
        usage: "#find <keywords>",
        needs_refs: false,
    },
    ChatCommandInfo {
        name: "highlight",
        summary: "Mark an exact passage in a file so you can see it in the viewer",
        usage: "#highlight <thing> in @file",
        needs_refs: true,
    },
    ChatCommandInfo {
        name: "extract",
        summary: "Pull the same fields out of several files into a spreadsheet",
        usage: "#extract <field, field…> from @a @b",
        needs_refs: true,
    },
    ChatCommandInfo {
        name: "summarize",
        summary: "Summarize the whole room, or one @file",
        usage: "#summarize   ·   #summarize @file",
        needs_refs: false,
    },
    ChatCommandInfo {
        name: "compare",
        summary: "Compare two or more @files side by side",
        usage: "#compare @a @b",
        needs_refs: true,
    },
    ChatCommandInfo {
        name: "transcribe",
        summary: "Show the transcript of an @recording",
        usage: "#transcribe @recording",
        needs_refs: true,
    },
    ChatCommandInfo {
        name: "to-sheet",
        summary: "Turn the table in the last answer into a spreadsheet",
        usage: "#to-sheet",
        needs_refs: false,
    },
    ChatCommandInfo {
        name: "translate",
        summary: "Translate an @file into another language",
        usage: "#translate @file to <language>",
        needs_refs: true,
    },
];

/// The catalog, for the frontend autocomplete and help.
#[tauri::command]
pub fn list_chat_commands() -> Vec<ChatCommandInfo> {
    CHAT_COMMANDS.to_vec()
}

/// Everything a command workflow needs. Passed by reference to keep signatures
/// small.
struct CmdCtx<'a> {
    window: &'a tauri::Window,
    state: &'a State<'a, AppState>,
    model: &'a str,
    /// @-pinned file ids (resolved in the UI before send).
    refs: &'a [String],
    /// Text after the command word, with @tokens already stripped by the UI.
    args: &'a str,
    /// Prior conversation as plain text (oldest-first), already budget-clamped.
    history: &'a str,
    temperature: Option<f64>,
    cancel: Arc<AtomicBool>,
}

/// What a command produces: a chat message plus optional viewer effects.
#[derive(Default)]
struct CommandResult {
    content: String,
    sources: Vec<String>,
    effects: ToolEffects,
}

impl CmdCtx<'_> {
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// One model call streamed live into the chat (for answers the user reads).
    async fn ask_streaming(&self, system: &str, user: String) -> Result<String, String> {
        use tauri::Emitter;
        let messages = vec![
            ollama::ChatMessage::new("system", system),
            ollama::ChatMessage::new("user", user),
        ];
        let window = self.window;
        let (out, _) = ollama::chat_stream_tools(
            self.model,
            messages,
            None,
            self.temperature,
            Some(self.cancel.clone()),
            KEEP_ALIVE_WARM,
            |d| {
                let _ = window.emit("ask-delta", d);
            },
        )
        .await?;
        Ok(out)
    }

    /// One model call whose output is NOT shown as chat (it becomes a file, a
    /// quote, or a parsed list), so it isn't streamed.
    async fn ask_quiet(&self, system: &str, user: String, temp: Option<f64>) -> Result<String, String> {
        let messages = vec![
            ollama::ChatMessage::new("system", system),
            ollama::ChatMessage::new("user", user),
        ];
        let (out, _) = ollama::chat_stream_tools(
            self.model,
            messages,
            None,
            temp,
            Some(self.cancel.clone()),
            KEEP_ALIVE_WARM,
            |_| {},
        )
        .await?;
        Ok(out)
    }

    /// ADD-22: like `ask_quiet`, but the reply is CONSTRAINED to `schema` via
    /// Ollama `format`. For steps whose output is machine-read (a list, a table
    /// of fields), so the model can't hand back prose to salvage-parse.
    async fn ask_structured(
        &self,
        system: &str,
        user: String,
        temp: Option<f64>,
        schema: &serde_json::Value,
    ) -> Result<String, String> {
        let messages = vec![
            ollama::ChatMessage::new("system", system),
            ollama::ChatMessage::new("user", user),
        ];
        ollama::chat_structured(self.model, messages, temp, KEEP_ALIVE_WARM, schema).await
    }
}

/// Save a generated text file into the room (Markdown by default). Reused by
/// several commands. Emits nothing — the caller decides what to open/announce.
fn create_note(conn: &Connection, name: &str, content: &str) -> Result<FileMeta, String> {
    let name = if extraction::extension_of(name).is_empty() {
        format!("{name}.md")
    } else {
        name.to_string()
    };
    let mime = mime_guess::from_path(&name)
        .first_or(mime_guess::mime::TEXT_PLAIN)
        .essence_str()
        .to_string();
    db::insert_file(conn, &name, &mime, content.as_bytes(), Some(content), "generated")
}

// ---- HTML-first output (the app defaults generated documents to HTML) ----

/// Escape text for safe literal inclusion in HTML.
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// True if the model already returned a whole HTML page, so we don't double-wrap.
fn is_full_html_doc(s: &str) -> bool {
    let low = s.trim_start().to_lowercase();
    low.starts_with("<!doctype") || low.starts_with("<html")
}

/// Wrap body markup in a clean, self-contained HTML document with inline styling.
/// It renders in the app's sandboxed, network-blocked HtmlView, so it is safe to
/// store and open. If `body` is already a full page, it is returned unchanged.
fn html_document(title: &str, body: &str) -> String {
    if is_full_html_doc(body) {
        return body.to_string();
    }
    format!(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <title>{}</title>\n<style>\n\
         :root {{ color-scheme: light dark; }}\n\
         body {{ font: 16px/1.6 -apple-system, system-ui, sans-serif; max-width: 46rem; \
         margin: 2rem auto; padding: 0 1.25rem; }}\n\
         h1,h2,h3 {{ line-height: 1.25; }}\n\
         table {{ border-collapse: collapse; }}\n\
         td,th {{ border: 1px solid #8884; padding: 0.35rem 0.6rem; text-align: left; }}\n\
         code,pre {{ background: #8881; border-radius: 4px; }}\n\
         pre {{ padding: 0.8rem; overflow-x: auto; }}\n\
         </style>\n</head>\n<body>\n{}\n</body>\n</html>\n",
        html_escape(title),
        body.trim()
    )
}

/// Pinned-file text as context, plus the file names, under a shared char budget.
fn refs_context(conn: &Connection, refs: &[String], budget: usize) -> (String, Vec<String>) {
    let mut ctx = String::new();
    let mut names = Vec::new();
    let mut used = 0usize;
    for id in refs {
        if let Ok((name, _mime, _bytes, text)) = db::get_file_full(conn, id) {
            names.push(name.clone());
            if let Some(t) = text {
                let room = budget.saturating_sub(used).min(6000);
                if room < 200 {
                    continue;
                }
                let take = clamp_bytes(t, room);
                used += take.len();
                ctx.push_str(&format!("[file: {name}]\n{take}\n\n"));
            }
        }
    }
    (ctx, names)
}

/// Derive a filename from a topic — first few words, path-safe, .md.
fn name_from_topic(topic: &str) -> String {
    let words: Vec<&str> = topic.split_whitespace().take(8).collect();
    let base: String = words
        .join(" ")
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { ' ' })
        .collect();
    let base = base.split_whitespace().collect::<Vec<_>>().join(" ");
    let base = if base.is_empty() { "Note".to_string() } else { base };
    format!("{base}.md")
}

/// ADD-22: a topic-derived file name with an `.html` extension (generated
/// documents default to HTML).
fn html_note_name(topic: &str) -> String {
    let md = name_from_topic(topic);
    format!("{}.html", md.strip_suffix(".md").unwrap_or(&md))
}

/// Parse a JSON array of strings from a model reply, tolerating leading/trailing
/// prose; falls back to splitting on newlines/commas. Deduped, trimmed, capped.
fn parse_string_list(raw: &str) -> Vec<String> {
    let cleaned = strip_think_spans(raw);
    let mut items: Vec<String> = Vec::new();
    // Try a JSON array first.
    if let Some(start) = cleaned.find('[') {
        let mut de = serde_json::Deserializer::from_str(&cleaned[start..])
            .into_iter::<serde_json::Value>();
        if let Some(Ok(serde_json::Value::Array(arr))) = de.next() {
            for v in arr {
                if let Some(s) = v.as_str() {
                    items.push(s.to_string());
                }
            }
        }
    }
    // Fallback: split lines, stripping list markers.
    if items.is_empty() {
        for line in cleaned.lines() {
            let t = line
                .trim()
                .trim_start_matches(|c: char| c.is_ascii_digit() || matches!(c, '-' | '*' | '.' | ')' | ' '))
                .trim();
            if !t.is_empty() && t.len() < 80 {
                items.push(t.to_string());
            }
        }
    }
    let mut seen = HashSet::new();
    items
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && seen.insert(s.to_lowercase()))
        .take(12)
        .collect()
}

/// Extract the LAST markdown table in `text` as rows of cells (header first).
/// "Last" so #to-sheet, scanning conversation history, picks the most recent
/// answer's table. Returns None when there is no `|`-delimited table with data.
fn extract_md_table(text: &str) -> Option<Vec<Vec<String>>> {
    let mut last: Option<Vec<Vec<String>>> = None;
    let mut cur: Vec<Vec<String>> = Vec::new();
    let flush = |cur: &mut Vec<Vec<String>>, last: &mut Option<Vec<Vec<String>>>| {
        if cur.len() >= 2 {
            *last = Some(std::mem::take(cur));
        } else {
            cur.clear();
        }
    };
    for line in text.lines() {
        let t = line.trim();
        if !t.contains('|') {
            flush(&mut cur, &mut last);
            continue;
        }
        // A separator row like |---|---| carries no data.
        if t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ')) {
            continue;
        }
        let cells: Vec<String> = t
            .trim_matches('|')
            .split('|')
            .map(|c| c.trim().to_string())
            .collect();
        cur.push(cells);
    }
    flush(&mut cur, &mut last);
    last
}

// ADD-22 (HTML-first): generated documents default to HTML. The model writes
// only simple BODY markup; the app wraps it in a styled, sandboxed page.
const DOC_SYS: &str = "You write the body of a single clear, well-structured HTML document \
using simple tags only: <h2>, <h3>, <p>, <ul>/<li>, <ol>/<li>, <strong>, <em>, <a>, \
<table>/<tr>/<td>. Output ONLY the inner HTML — no <html>, <head>, <body> or <style> tags, \
no code fences, no preamble, no \"Here is\".";

// ---- individual commands ----

async fn cmd_remember(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    let fact = ctx.args.trim();
    if fact.is_empty() {
        return Err("Usage: #remember <fact>".into());
    }
    let fact = clamp_bytes(fact.to_string(), MAX_MEMORY_CONTENT_CHARS);
    let guard = ctx.state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    if duplicate_memory(&room.conn, &fact)?.is_some() {
        return Ok(CommandResult {
            content: "That's already in this room's memory.".into(),
            ..Default::default()
        });
    }
    db::add_memory(&room.conn, &fact)?;
    Ok(CommandResult {
        content: format!("Saved to memory:\n\n> {fact}"),
        ..Default::default()
    })
}

async fn cmd_find(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    let query = ctx.args.trim();
    if query.is_empty() {
        return Err("Usage: #find <keywords>".into());
    }
    let emb = embed_question(query).await;
    let guard = ctx.state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let (chunks, fallback) = retrieve_context(&room.conn, query, emb.as_deref())?;
    if fallback || chunks.is_empty() {
        return Ok(CommandResult {
            content: format!("No matches found for **{query}**."),
            ..Default::default()
        });
    }
    let mut body = format!("Matches for **{query}**:\n\n");
    let mut sources: Vec<String> = Vec::new();
    for c in chunks.iter().take(MAX_CONTEXT_CHUNKS) {
        let snippet = make_snippet(&c.text, query, 140);
        body.push_str(&format!("- **{}** — {snippet}\n", c.file_name));
        if !sources.contains(&c.file_name) {
            sources.push(c.file_name.clone());
        }
    }
    body.push_str("\n_Click a file below to open it._");
    Ok(CommandResult { content: body, sources, ..Default::default() })
}

async fn cmd_add_file(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    use tauri::Emitter;
    let a = ctx.args.trim();
    if a.is_empty() {
        return Err("Usage: #add-file <name>: <topic>   (or)   #add-file for each <thing>".into());
    }
    // Fan-out: "#add-file for each <thing>" → enumerate from the conversation,
    // then generate + save one file per item.
    let lower = a.to_lowercase();
    if let Some(pos) = lower.find("for each") {
        let subject = a[pos + "for each".len()..].trim().trim_start_matches(':').trim();
        // Enumerate: the one genuinely fuzzy step gets the model, forced to a
        // list. ADD-22: the array shape is guaranteed by `format`, so the model
        // can only return strings; parse_string_list just dedupes and caps.
        let items = parse_string_list(
            &ctx.ask_structured(
                "You extract a list of short names from a conversation.",
                format!(
                    "From the conversation below, list the {subject} as short names (max 12). \
                     If there are none, return an empty array.\n\nConversation:\n{}",
                    ctx.history
                ),
                Some(0.0),
                &serde_json::json!({"type": "array", "items": {"type": "string"}}),
            )
            .await?,
        );
        if items.is_empty() {
            return Err(
                "Couldn't find a list to iterate over in this chat. Name the items explicitly, \
                 e.g. #add-file for each: AAPL, MSFT, NVDA."
                    .into(),
            );
        }
        let mut created: Vec<String> = Vec::new();
        for (i, item) in items.iter().enumerate() {
            if ctx.cancelled() {
                break;
            }
            let _ = ctx.window.emit(
                "ask-step",
                format!("Creating file for {item} ({}/{})", i + 1, items.len()),
            );
            let body = ctx
                .ask_quiet(
                    DOC_SYS,
                    format!(
                        "Write a concise, useful note about \"{item}\", grounded in this \
                         conversation where relevant:\n\n{}",
                        ctx.history
                    ),
                    Some(0.4),
                )
                .await
                .unwrap_or_default();
            if body.trim().is_empty() {
                continue;
            }
            let name = html_note_name(item);
            let doc = html_document(&name, &body);
            let guard = ctx.state.room.lock().unwrap();
            let Some(room) = guard.as_ref() else { break };
            if let Ok(meta) = create_note(&room.conn, &name, &doc) {
                created.push(meta.name);
            }
        }
        let _ = ctx.window.emit("room-files-changed", ());
        if created.is_empty() {
            return Err("Couldn't create any files — the model returned nothing.".into());
        }
        let list = created.iter().map(|n| format!("- {n}")).collect::<Vec<_>>().join("\n");
        return Ok(CommandResult {
            content: format!(
                "Created {} file(s):\n{list}\n\n_Delete any you don't want from the Files list._",
                created.len()
            ),
            sources: created,
            ..Default::default()
        });
    }

    // Single file: optional "name: topic".
    let (name_hint, topic) = match a.split_once(':') {
        Some((n, t)) if !t.trim().is_empty() && n.split_whitespace().count() <= 8 => {
            (Some(n.trim().to_string()), t.trim().to_string())
        }
        _ => (None, a.to_string()),
    };
    let refctx = {
        let guard = ctx.state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        refs_context(&room.conn, ctx.refs, 8000).0
    };
    let body = ctx
        .ask_quiet(
            DOC_SYS,
            format!("{refctx}Write a well-structured document about: {topic}"),
            Some(0.4),
        )
        .await?;
    if body.trim().is_empty() {
        return Err("The model returned nothing — try rephrasing the topic.".into());
    }
    // ADD-22: default to HTML unless the user named an explicit extension.
    let name = match name_hint {
        Some(h) if !extraction::extension_of(&h).is_empty() => h,
        Some(h) => format!("{h}.html"),
        None => html_note_name(&topic),
    };
    let doc = html_document(&name, &body);
    let meta = {
        let guard = ctx.state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        create_note(&room.conn, &name, &doc)?
    };
    let _ = ctx.window.emit("room-files-changed", ());
    let _ = ctx.window.emit("agent-open-file", serde_json::json!({ "id": meta.id }));
    Ok(CommandResult {
        content: format!("Created **{}** and opened it.", meta.name),
        sources: vec![meta.name],
        ..Default::default()
    })
}

async fn cmd_highlight(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    use tauri::Emitter;
    let file_id = ctx
        .refs
        .first()
        .ok_or("Add a file with @ — e.g. #highlight the total in @invoice.pdf")?;
    let thing = ctx
        .args
        .trim()
        .trim_end_matches(|c: char| c.is_whitespace())
        .trim_end_matches(" in")
        .trim_end_matches(" on")
        .trim();
    if thing.is_empty() {
        return Err("Say what to highlight — e.g. #highlight the signature in @contract.pdf".into());
    }
    let (real_name, extracted) = {
        let guard = ctx.state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        let (name, _mime, _bytes, text) = db::get_file_full(&room.conn, file_id)?;
        (name, text.unwrap_or_default())
    };
    if extracted.trim().is_empty() {
        return Err(format!("\"{real_name}\" has no readable text to highlight."));
    }
    let doc = clamp_bytes(extracted.clone(), 6000);
    let quote = ctx
        .ask_quiet(
            "You locate an exact passage. Output ONLY the shortest verbatim quote from the \
             document that best matches the request — copied character-for-character, with no \
             quotation marks around it and no other words.",
            format!("Request: {thing}\n\nDocument:\n{doc}"),
            Some(0.0),
        )
        .await?;
    let quote = quote.trim().trim_matches('"').trim().to_string();
    if quote.is_empty() {
        return Err(format!("Couldn't find \"{thing}\" in {real_name}."));
    }
    let (payload, described) =
        build_annotation(file_id, &real_name, Some(&extracted), &quote, "", None, None, None)
            .map_err(|_| format!("Couldn't find an exact passage for \"{thing}\" in {real_name}."))?;
    let _ = ctx.window.emit("agent-annotate", &payload);
    let effects = ToolEffects {
        annotation: Some(payload),
        ..Default::default()
    };
    Ok(CommandResult {
        content: format!("Highlighted {described} in **{real_name}**."),
        sources: vec![real_name],
        effects,
    })
}

async fn cmd_extract(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    use tauri::Emitter;
    if ctx.refs.is_empty() {
        return Err("Add files with @ — e.g. #extract revenue, CEO from @a.pdf @b.pdf".into());
    }
    // Strip a trailing "from"/"in"/"of" the UI leaves after removing @tokens.
    let fields_str = ctx
        .args
        .trim()
        .trim_end_matches(|c: char| c.is_whitespace())
        .trim_end_matches("from")
        .trim_end_matches("in")
        .trim_end_matches("of")
        .trim();
    let fields: Vec<String> = fields_str
        .split(',')
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .collect();
    if fields.is_empty() {
        return Err("Say which fields to extract — e.g. #extract revenue, CEO from @a @b".into());
    }
    let files: Vec<(String, String)> = {
        let guard = ctx.state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        ctx.refs
            .iter()
            .filter_map(|id| db::get_file_full(&room.conn, id).ok())
            .map(|(name, _m, _b, text)| (name, text.unwrap_or_default()))
            .collect()
    };
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut header = vec!["File".to_string()];
    header.extend(fields.iter().cloned());
    rows.push(header);
    for (i, (name, text)) in files.iter().enumerate() {
        if ctx.cancelled() {
            break;
        }
        let _ = ctx
            .window
            .emit("ask-step", format!("Reading {name} ({}/{})", i + 1, files.len()));
        let doc = clamp_bytes(text.clone(), 6000);
        let field_lines = fields.join("\n");
        // ADD-22: one string property per requested field, so the reply is a
        // guaranteed JSON object keyed exactly by the field names — no more
        // hoping the model honors a "Field: value" line format.
        let mut props = serde_json::Map::new();
        for f in &fields {
            props.insert(f.clone(), serde_json::json!({"type": "string"}));
        }
        let schema = serde_json::json!({
            "type": "object",
            "properties": props,
            "required": fields,
        });
        let reply = ctx
            .ask_structured(
                "You extract specific fields from a document. Fill each field with its value \
                 copied from the document, or \"(not found)\" if it is absent.",
                format!("Fields:\n{field_lines}\n\nDocument:\n{doc}"),
                Some(0.0),
                &schema,
            )
            .await
            .unwrap_or_default();
        let parsed: serde_json::Value =
            serde_json::from_str(reply.trim()).unwrap_or_else(|_| serde_json::json!({}));
        let mut row = vec![name.clone()];
        for f in &fields {
            let val = parsed
                .get(f)
                .and_then(|v| v.as_str())
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .unwrap_or("(not found)")
                .to_string();
            row.push(val);
        }
        rows.push(row);
    }
    let csv = serialize_delim(&rows, ',');
    let meta = {
        let guard = ctx.state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        create_note(&room.conn, "extract.csv", &csv)?
    };
    let _ = ctx.window.emit("room-files-changed", ());
    let _ = ctx.window.emit("agent-open-file", serde_json::json!({ "id": meta.id }));
    Ok(CommandResult {
        content: format!(
            "Extracted {} field(s) from {} file(s) into **{}**.",
            fields.len(),
            files.len(),
            meta.name
        ),
        sources: vec![meta.name],
        ..Default::default()
    })
}

async fn cmd_summarize(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    if let Some(file_id) = ctx.refs.first() {
        let (name, text) = {
            let guard = ctx.state.room.lock().unwrap();
            let room = guard.as_ref().ok_or("No room is open.")?;
            let (name, _m, _b, text) = db::get_file_full(&room.conn, file_id)?;
            (name, text.unwrap_or_default())
        };
        if text.trim().is_empty() {
            return Err(format!("\"{name}\" has no readable text to summarize."));
        }
        let doc = clamp_bytes(text, 8000);
        let out = ctx
            .ask_streaming(
                "You summarize a document faithfully and concisely.",
                format!(
                    "Summarize this document in 3-4 sentences, then list up to 3 key points as \
                     bullets.\n\n{doc}"
                ),
            )
            .await?;
        return Ok(CommandResult {
            content: out,
            sources: vec![name],
            ..Default::default()
        });
    }
    // Whole-room overview from the file inventory + cached one-liners.
    let inventory = {
        let guard = ctx.state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        db::list_file_inventory(&room.conn)?
    };
    if inventory.is_empty() {
        return Err("This room has no files to summarize yet.".into());
    }
    let mut listing = String::new();
    for (name, mime, summary) in inventory.iter().take(60) {
        match summary {
            Some(s) if !s.trim().is_empty() => {
                listing.push_str(&format!("- {name} — {}\n", s.trim()))
            }
            _ => listing.push_str(&format!("- {name} ({mime})\n")),
        }
    }
    let out = ctx
        .ask_streaming(
            "You describe what a personal document room is for, based only on the file list given.",
            format!(
                "Given these files, describe in 3-4 sentences what this room is about, then \
                 suggest 3 things the user could ask.\n\nFiles:\n{listing}"
            ),
        )
        .await?;
    Ok(CommandResult {
        content: format!(
            "{out}\n\n_Tip: the “Summarize room” button saves this as a file with per-file notes._"
        ),
        ..Default::default()
    })
}

async fn cmd_compare(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    if ctx.refs.len() < 2 {
        return Err("Add at least two files with @ — e.g. #compare @plan-a.md @plan-b.md".into());
    }
    let (refctx, names) = {
        let guard = ctx.state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        refs_context(&room.conn, ctx.refs, 9000)
    };
    if refctx.trim().is_empty() {
        return Err("Those files have no readable text to compare.".into());
    }
    let out = ctx
        .ask_streaming(
            "You compare documents clearly and fairly.",
            format!(
                "Compare the following documents. Give a one-sentence overview, then a short \
                 bullet list of the key similarities and a short bullet list of the key \
                 differences.\n\n{refctx}"
            ),
        )
        .await?;
    Ok(CommandResult { content: out, sources: names, ..Default::default() })
}

async fn cmd_transcribe(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    let file_id = ctx
        .refs
        .first()
        .ok_or("Add a recording with @ — e.g. #transcribe @meeting.m4a")?;
    let (name, mime, text) = {
        let guard = ctx.state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        let (name, mime, _b, text) = db::get_file_full(&room.conn, file_id)?;
        (name, mime.unwrap_or_default(), text.unwrap_or_default())
    };
    let ext = extraction::extension_of(&name);
    let is_media = stt::media_kind(&mime, &ext).is_some();
    if text.trim().is_empty() {
        return if is_media {
            Ok(CommandResult {
                content: format!(
                    "\"{name}\" is still being transcribed in the background — try again in a \
                     moment."
                ),
                ..Default::default()
            })
        } else {
            Err(format!("\"{name}\" isn't an audio or video file."))
        };
    }
    Ok(CommandResult {
        content: format!("Transcript of **{name}**:\n\n{}", text.trim()),
        sources: vec![name],
        ..Default::default()
    })
}

async fn cmd_to_sheet(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    use tauri::Emitter;
    // The most recent table anywhere in the conversation (extract_md_table
    // returns the last one).
    let Some(rows) = extract_md_table(ctx.history) else {
        return Err("No table found in a recent answer to convert.".into());
    };
    let csv = serialize_delim(&rows, ',');
    let meta = {
        let guard = ctx.state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        create_note(&room.conn, "table.csv", &csv)?
    };
    let _ = ctx.window.emit("room-files-changed", ());
    let _ = ctx.window.emit("agent-open-file", serde_json::json!({ "id": meta.id }));
    Ok(CommandResult {
        content: format!(
            "Saved the table as **{}** ({} row(s)).",
            meta.name,
            rows.len().saturating_sub(1)
        ),
        sources: vec![meta.name],
        ..Default::default()
    })
}

async fn cmd_translate(ctx: &CmdCtx<'_>) -> Result<CommandResult, String> {
    use tauri::Emitter;
    let file_id = ctx
        .refs
        .first()
        .ok_or("Add a file with @ — e.g. #translate @notes.md to Spanish")?;
    // Accept "to <lang>" or a bare language name.
    let a = ctx.args.trim();
    let lang = a
        .rsplit_once(" to ")
        .map(|(_, l)| l)
        .or_else(|| a.strip_prefix("to "))
        .unwrap_or(a)
        .trim();
    if lang.is_empty() {
        return Err("Say the target language — e.g. #translate @notes.md to Spanish".into());
    }
    let (name, text) = {
        let guard = ctx.state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        let (name, _m, _b, text) = db::get_file_full(&room.conn, file_id)?;
        (name, text.unwrap_or_default())
    };
    if text.trim().is_empty() {
        return Err(format!("\"{name}\" has no readable text to translate."));
    }
    // Chunk so a long file fits the small context; translate each piece.
    let chars: Vec<char> = text.chars().collect();
    let chunks: Vec<String> = chars.chunks(3000).map(|c| c.iter().collect()).collect();
    let total = chunks.len();
    let mut out = String::new();
    for (i, chunk) in chunks.iter().enumerate() {
        if ctx.cancelled() {
            break;
        }
        let _ = ctx
            .window
            .emit("ask-step", format!("Translating part {}/{}", i + 1, total));
        let piece = ctx
            .ask_quiet(
                &format!(
                    "You translate text into {lang}. Output ONLY the translation, preserving \
                     Markdown structure. Do not add commentary."
                ),
                chunk.clone(),
                Some(0.2),
            )
            .await?;
        out.push_str(piece.trim());
        out.push('\n');
    }
    if out.trim().is_empty() {
        return Err("The model returned nothing to save.".into());
    }
    let base = name.rsplit_once('.').map(|(b, _)| b).unwrap_or(&name);
    let fname = format!("{base} ({lang}).md");
    let meta = {
        let guard = ctx.state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        create_note(&room.conn, &fname, &out)?
    };
    let _ = ctx.window.emit("room-files-changed", ());
    let _ = ctx.window.emit("agent-open-file", serde_json::json!({ "id": meta.id }));
    Ok(CommandResult {
        content: format!("Translated **{name}** into {lang} → **{}**.", meta.name),
        sources: vec![meta.name],
        ..Default::default()
    })
}

/// Format prior conversation as plain text (oldest-first), markup stripped and
/// budget-clamped, for commands that reason over history (#add-file for-each,
/// #to-sheet).
fn format_history(history: &[(String, String)], budget: usize) -> String {
    let mut out = String::new();
    for (role, content) in history {
        let content = strip_markup_blocks(content);
        if content.trim().is_empty() {
            continue;
        }
        out.push_str(&format!("\n[{role}]\n{content}\n"));
    }
    clamp_bytes(out.trim().to_string(), budget)
}

/// Run a prebuilt "#name" workflow. Mirrors `ask`'s cancel/save boilerplate but
/// dispatches to a fixed pipeline instead of the agent loop. Commands always use
/// a LOCAL model (they make several small calls; cloud would leak content and
/// can't stream the pipeline).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn run_command(
    window: tauri::Window,
    state: State<'_, AppState>,
    ask_id: String,
    chat_id: String,
    command: String,
    args: String,
    refs: Vec<String>,
    raw: String,
) -> Result<Message, String> {
    if !CHAT_COMMANDS.iter().any(|c| c.name == command) {
        return Err(format!("Unknown command #{command}."));
    }

    // ADD-7: register a cancel flag so Stop/Lock works, like ask.
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .cancels
        .lock()
        .unwrap()
        .insert(ask_id.clone(), cancel.clone());
    let _cancel_guard = CancelGuard {
        state: state.inner(),
        ask_id: ask_id.clone(),
    };

    // Phase 1 (locked): read history + settings, save the user's typed line.
    let (explicit_model, history, temperature) = {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        let conn = &room.conn;
        let temperature: Option<f64> = db::get_setting(conn, "temperature").and_then(|s| s.parse().ok());
        let history: Vec<(String, String)> = {
            let mut rows = db::recent_messages(conn, &chat_id, MAX_HISTORY_MESSAGES as i64)?;
            rows.reverse();
            rows
        };
        db::insert_message(conn, &chat_id, "user", &raw, &[])?;
        let mut title: String = raw.chars().take(48).collect();
        if raw.chars().count() > 48 {
            title.push('…');
        }
        db::set_chat_title_if_new(conn, &chat_id, &title)?;
        (model_setting(conn), history, temperature)
    };

    let models = ollama::list_models().await.unwrap_or_default();
    if models.is_empty() {
        return Err("No local AI model is installed yet — download one first.".into());
    }
    let mut model = explicit_model.unwrap_or_else(|| best_default(&models));
    if is_external_engine(&model) {
        model = best_default(&models);
    }
    let history_text = format_history(&history, 8000);

    let ctx = CmdCtx {
        window: &window,
        state: &state,
        model: &model,
        refs: &refs,
        args: args.trim(),
        history: &history_text,
        temperature,
        cancel: cancel.clone(),
    };

    let result = match command.as_str() {
        "remember" => cmd_remember(&ctx).await,
        "find" => cmd_find(&ctx).await,
        "add-file" => cmd_add_file(&ctx).await,
        "highlight" => cmd_highlight(&ctx).await,
        "extract" => cmd_extract(&ctx).await,
        "summarize" => cmd_summarize(&ctx).await,
        "compare" => cmd_compare(&ctx).await,
        "transcribe" => cmd_transcribe(&ctx).await,
        "to-sheet" => cmd_to_sheet(&ctx).await,
        "translate" => cmd_translate(&ctx).await,
        _ => Err(format!("Unknown command #{command}.")),
    };

    let stopped = cancel.load(Ordering::SeqCst);
    let res = match result {
        Ok(r) => r,
        Err(_) if stopped => CommandResult::default(),
        Err(e) => return Err(e),
    };

    let mut content = res.content;
    if stopped {
        content.push_str(" *(stopped)*");
    }
    if let Some(payload) = &res.effects.boxes {
        content.push_str(&format!("\n\n```boxes\n{payload}\n```"));
    }
    if let Some(payload) = &res.effects.annotation {
        content.push_str(&format!("\n\n```annotation\n{payload}\n```"));
    }
    if content.trim().is_empty() {
        content = "Done.".into();
    }

    // Phase 3 (locked): save the assistant reply (HLT-7: room may have closed).
    let guard = state.room.lock().unwrap();
    match guard.as_ref() {
        Some(room) => db::insert_message(&room.conn, &chat_id, "assistant", &content, &res.sources),
        None => Ok(Message {
            id: String::new(),
            role: "assistant".into(),
            content,
            sources: res.sources,
            created_at: String::new(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locate_intent_only_fires_on_real_locate_questions() {
        let img = Some("photo.png");
        // Strong marking verbs fire regardless of image context.
        assert!(is_locate_intent("Where is the signature?", img));
        assert!(is_locate_intent("circle the cat", None));
        assert!(is_locate_intent("point to the exit", img));
        // "sign me" was a typo that fired the slow grounding pass on unrelated
        // sentences (RM-3) — it must not match anymore.
        assert!(!is_locate_intent("please sign me up for the newsletter", img));
        assert!(!is_locate_intent("summarize this document", img));
        // CHG-18: ambiguous verbs only fire when the question refers to the image.
        assert!(is_locate_intent("show me the cat in the photo", img));
        assert!(is_locate_intent("show me the cat in photo.png", Some("photo.png")));
        assert!(!is_locate_intent("show me a summary", img));
        // CHG-18: a named non-image target routes to annotate_file, not grounding.
        assert!(!is_locate_intent("highlight the total in the invoice PDF", img));
        assert!(!is_locate_intent("find the average in the spreadsheet", img));
        // "somewhere in this report" no longer matches on a bare "where".
        assert!(!is_locate_intent("somewhere in this report is a total", img));
    }

    #[test]
    fn parse_boxes_survives_prose_and_think_spans() {
        let w = 100.0;
        let h = 100.0;
        // Leading prose containing a bracket, then a real array.
        let raw = "Coordinates are [x1,y1,x2,y2]. Here: [{\"label\":\"cat\",\"bbox\":[10,10,50,50]}]";
        assert_eq!(parse_boxes(raw, w, h).len(), 1);
        // A <think> block preceding the array must not break parsing.
        let raw2 = "<think>let me look</think>[{\"label\":\"dog\",\"bbox\":[0,0,40,40]}]";
        assert_eq!(parse_boxes(raw2, w, h).len(), 1);
        // A genuine empty answer stays empty.
        assert_eq!(parse_boxes("[]", w, h).len(), 0);
    }

    #[test]
    fn fabrication_gate_flags_only_unbacked_claims() {
        assert!(claims_unbacked_action("I've updated the file.", false, false));
        // Backed by a real write → no correction.
        assert!(!claims_unbacked_action("I've updated the file.", true, false));
        // Negated / conditional phrasing must not trigger.
        assert!(!claims_unbacked_action("I have not changed the file.", false, false));
        assert!(!claims_unbacked_action(
            "I could edit the file if you want.",
            false,
            false
        ));
        // Highlight claim needs a highlight effect.
        assert!(claims_unbacked_action("I highlighted the total.", false, false));
        assert!(!claims_unbacked_action("I highlighted the total.", false, true));
    }

    #[test]
    fn excerpt_is_char_safe_and_centered() {
        // Multibyte string longer than the window must not panic and should
        // center on the match.
        let text = "café ".repeat(400); // multibyte, > 800 bytes
        let ex = excerpt(&text, "café", 800);
        assert!(ex.chars().count() <= 802); // window + ellipses
        // A curly-quote string clipped mid-window is fine.
        let s = "“smart quotes” ".repeat(100);
        let _ = excerpt(&s, "missing", 800);
    }

    #[test]
    fn parses_a1_notation() {
        assert_eq!(parse_a1("A1"), Some((0, 0)));
        assert_eq!(parse_a1("b7"), Some((6, 1)));
        assert_eq!(parse_a1("AA10"), Some((9, 26)));
        assert_eq!(parse_a1("7B"), None);
        assert_eq!(parse_a1("B0"), None);
        assert_eq!(parse_a1(""), None);
        assert!(is_a1_range("B2:D5"));
        assert!(is_a1_range("B2"));
        assert!(!is_a1_range("B2:"));
        assert!(!is_a1_range("hello"));
    }

    #[test]
    fn tool_step_labels_are_human_friendly() {
        assert_eq!(tool_step_label("search_room"), "Searched the room");
        assert_eq!(tool_step_label("fetch_page"), "Fetched a page");
        assert_eq!(tool_step_label("open_file"), "Opened a file");
        // Unknown / MCP tools fall back to naming the tool, never panic.
        assert_eq!(tool_step_label("weather_lookup"), "Ran the weather_lookup tool");
    }

    #[test]
    fn csv_round_trip_preserves_quoting() {
        let src = "name,note\nalice,\"hi, there\"\nbob,\"say \"\"hey\"\"\"\n";
        let rows = parse_delim(src, ',');
        assert_eq!(rows[1][1], "hi, there");
        assert_eq!(rows[2][1], "say \"hey\"");
        let out = serialize_delim(&rows, ',');
        assert_eq!(parse_delim(&out, ','), rows);
    }

    #[test]
    fn csv_set_cell_grows_grid() {
        let mut rows = parse_delim("a,b\n1,2\n", ',');
        let (r, c) = parse_a1("D4").unwrap();
        if rows.len() <= r {
            rows.resize(r + 1, Vec::new());
        }
        if rows[r].len() <= c {
            rows[r].resize(c + 1, String::new());
        }
        rows[r][c] = "x".into();
        let out = serialize_delim(&rows, ',');
        assert!(out.lines().nth(3).unwrap().ends_with(",,,x"));
    }

    #[test]
    fn xlsx_set_cell_round_trips() {
        let mut book = umya_spreadsheet::new_file();
        book.sheet_mut(0).unwrap().cell_mut("A1").set_value("hello");
        let mut bytes: Vec<u8> = Vec::new();
        umya_spreadsheet::writer::xlsx::write_writer(&book, &mut bytes).unwrap();

        let edited = xlsx_set_cell(&bytes, None, "B7", "42").expect("edit xlsx");
        let reread =
            umya_spreadsheet::reader::xlsx::read_reader(std::io::Cursor::new(&edited), true)
                .unwrap();
        let sheet = reread.sheet(0).unwrap();
        assert_eq!(sheet.cell_value("B7").value(), "42");
        assert_eq!(sheet.cell_value("A1").value(), "hello");
        assert!(xlsx_set_cell(&bytes, Some("NoSuchSheet"), "B7", "x").is_err());
    }

    #[test]
    fn normalizes_for_quote_matching() {
        let doc = normalize_for_match("The  Fee is\n 5%  of total.");
        assert!(doc.contains(&normalize_for_match("fee is 5%")));
    }

    #[test]
    fn memory_dedup_normalization() {
        // UX-5: dedup keys on normalize_for_match, so case and spacing
        // differences collapse to the same key (an exact duplicate).
        assert_eq!(
            normalize_for_match("The dog is named Rex"),
            normalize_for_match("the   dog  is named rex")
        );
        // A genuinely different fact keeps a distinct key.
        assert_ne!(
            normalize_for_match("The dog is named Rex"),
            normalize_for_match("The cat is named Rex")
        );
    }

    #[test]
    fn snippet_centers_on_the_match() {
        let text = "The quarterly report shows revenue of five million dollars this year.";
        let snip = make_snippet(text, "revenue", 20);
        assert!(snip.to_lowercase().contains("revenue"));
        // Clipped on both sides → ellipses front and back.
        assert!(snip.starts_with('…') && snip.ends_with('…'));
        // Multi-line text collapses to one line in the snippet.
        let multi = make_snippet("alpha\n\n  beta   gamma", "beta", 40);
        assert!(multi.contains("alpha beta gamma"));
        // No match → a preview from the start, never a panic.
        let none = make_snippet("just some words here", "zzzzz", 5);
        assert!(none.starts_with("just"));
    }

    #[test]
    fn fts_match_expr_quotes_and_or_joins() {
        let expr = fts_match_expr(["lease", "rent"]).unwrap();
        assert_eq!(expr, "\"lease\" OR \"rent\"");
        // Empty input yields no query (caller falls back).
        assert!(fts_match_expr(std::iter::empty::<&str>()).is_none());
    }

    #[test]
    fn strips_markup_blocks() {
        let content = "Answer.\n\n```boxes\n{\"a\":1}\n```\n\n```annotation\n{\"b\":2}\n```";
        assert_eq!(strip_markup_blocks(content), "Answer.");
        assert_eq!(strip_markup_blocks("plain"), "plain");
    }

    #[test]
    fn export_name_suffixes_on_clash() {
        use std::collections::HashSet;
        let mut taken: HashSet<String> = HashSet::new();
        // Unclaimed name is used as-is.
        assert_eq!(unique_export_name("fresh.txt", |c| taken.contains(c)), "fresh.txt");
        // Clash inserts the suffix before the extension.
        taken.insert("report.pdf".into());
        assert_eq!(unique_export_name("report.pdf", |c| taken.contains(c)), "report (2).pdf");
        // Keeps counting while suffixed names are also taken.
        taken.insert("report (2).pdf".into());
        assert_eq!(unique_export_name("report.pdf", |c| taken.contains(c)), "report (3).pdf");
        // No extension → suffix goes at the end.
        taken.insert("README".into());
        assert_eq!(unique_export_name("README", |c| taken.contains(c)), "README (2)");
        // A leading dot is not an extension separator.
        taken.insert(".gitignore".into());
        assert_eq!(unique_export_name(".gitignore", |c| taken.contains(c)), ".gitignore (2)");
    }

    #[test]
    fn recent_dedup_and_cap() {
        let mk = |p: &str| RecentRoom { name: p.into(), path: p.into(), opened_at: None };
        let mut list: Vec<RecentRoom> = Vec::new();
        for p in ["a", "b", "c", "d", "e", "f"] {
            list = merge_recent(list, mk(p));
        }
        // Newest first, capped at 5 (the oldest, "a", fell off).
        assert_eq!(list.len(), 5);
        assert_eq!(list[0].path, "f");
        assert_eq!(list.last().unwrap().path, "b");
        // Re-opening an existing path moves it to the front without duplicating.
        list = merge_recent(list, mk("c"));
        assert_eq!(list.len(), 5);
        assert_eq!(list[0].path, "c");
        assert_eq!(list.iter().filter(|r| r.path == "c").count(), 1);
    }

    #[test]
    fn mcp_fingerprint_is_stable_and_config_sensitive() {
        // SEC-1: same text → same fingerprint (approval survives reopening).
        let a = r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg"]}}}"#;
        assert_eq!(mcp_fingerprint(a), mcp_fingerprint(a));
        // A one-character change invalidates the old approval.
        let b = r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg2"]}}}"#;
        assert_ne!(mcp_fingerprint(a), mcp_fingerprint(b));
        // Hex SHA-256 is 64 chars.
        assert_eq!(mcp_fingerprint(a).len(), 64);
    }

    #[test]
    fn mcp_gate_blocks_unapproved_enabled_server() {
        // SEC-1 core invariant: an enabled server whose exact config has NOT been
        // approved on this Mac must NOT start — the gate asks first.
        let cfg = r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg"]}}}"#;
        let none: std::collections::HashSet<String> = std::collections::HashSet::new();
        match mcp_gate(cfg, &none) {
            McpGate::NeedsApproval {
                fingerprint,
                servers,
            } => {
                // The dialog is asked about exactly the enabled server, and the
                // fingerprint it will approve is this config's SHA-256.
                assert_eq!(fingerprint, mcp_fingerprint(cfg));
                assert_eq!(servers.len(), 1);
                assert_eq!(servers[0].0, "web");
            }
            _ => panic!("unapproved enabled server must gate (NeedsApproval), never Start"),
        }
    }

    #[test]
    fn mcp_gate_starts_when_fingerprint_approved() {
        // SEC-1 (b): once this exact config is in the approved set, the same
        // server is allowed to Start.
        let cfg = r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg"]}}}"#;
        let approved: std::collections::HashSet<String> =
            [mcp_fingerprint(cfg)].into_iter().collect();
        match mcp_gate(cfg, &approved) {
            McpGate::Start(servers) => {
                assert_eq!(servers.len(), 1);
                assert_eq!(servers[0].0, "web");
            }
            _ => panic!("approved config must Start"),
        }
    }

    #[test]
    fn mcp_gate_nothing_when_only_disabled_servers() {
        // SEC-1 (c): a config with only disabled servers is Nothing — no dialog,
        // no spawn — even though its fingerprint is not approved.
        let cfg = r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg"],"disabled":true}}}"#;
        let none: std::collections::HashSet<String> = std::collections::HashSet::new();
        assert!(matches!(mcp_gate(cfg, &none), McpGate::Nothing));
        // An empty server map is likewise Nothing.
        assert!(matches!(
            mcp_gate(r#"{"mcpServers":{}}"#, &none),
            McpGate::Nothing
        ));
    }

    #[test]
    fn mcp_gate_edited_config_needs_reapproval() {
        // SEC-1 (d): approve one config, then edit it — the fingerprint changes,
        // so the OLD approval no longer covers it and the gate asks again.
        let original = r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg"]}}}"#;
        let approved: std::collections::HashSet<String> =
            [mcp_fingerprint(original)].into_iter().collect();
        // Same text still starts.
        assert!(matches!(mcp_gate(original, &approved), McpGate::Start(_)));
        // One-character edit → different fingerprint → NeedsApproval again.
        let edited = r#"{"mcpServers":{"web":{"command":"uvx","args":["ddg2"]}}}"#;
        assert!(matches!(
            mcp_gate(edited, &approved),
            McpGate::NeedsApproval { .. }
        ));
    }

    #[test]
    fn renders_full_command_line() {
        let cfg = mcp::ServerConfig {
            command: "uvx".into(),
            args: vec!["duckduckgo-mcp-server".into(), "--verbose".into()],
            env: std::collections::HashMap::new(),
            disabled: false,
        };
        assert_eq!(render_command_line(&cfg), "uvx duckduckgo-mcp-server --verbose");
        let bare = mcp::ServerConfig {
            command: "node".into(),
            args: vec![],
            env: std::collections::HashMap::new(),
            disabled: false,
        };
        assert_eq!(render_command_line(&bare), "node");
    }

    #[test]
    fn vision_keep_alive_by_ram_and_model() {
        let gb = 1024 * 1024 * 1024;
        // Distinct vision model on a 16 GB Mac → released quickly.
        assert_eq!(vision_keep_alive(16 * gb, "qwen2.5vl", "qwen3.5:4b"), "2m");
        // Same 16 GB Mac, but vision == chat model → only one model loaded, warm.
        assert_eq!(vision_keep_alive(16 * gb, "qwen3.5:4b", "qwen3.5:4b"), "30m");
        // 32 GB Mac keeps a distinct vision model warm too.
        assert_eq!(vision_keep_alive(32 * gb, "qwen2.5vl", "qwen3.5:4b"), "30m");
        assert_eq!(vision_keep_alive(64 * gb, "qwen2.5vl", "qwen3.5:4b"), "30m");
    }

    #[test]
    fn summary_file_excludes_only_the_generated_one() {
        // ADD-17: the app's own generated summary is excluded from itself.
        assert!(is_summary_file("Room summary.md", "generated"));
        // A user upload with the same name is NOT the canonical summary.
        assert!(!is_summary_file("Room summary.md", "upload"));
        assert!(!is_summary_file("notes.md", "generated"));
    }

    #[test]
    fn cleans_model_one_liner() {
        assert_eq!(clean_one_liner("- A lease agreement.\nExtra"), "A lease agreement.");
        assert_eq!(clean_one_liner("\n\n  The résumé.  "), "The résumé.");
    }

    #[test]
    fn link_file_name_is_safe_and_falls_back() {
        assert_eq!(link_file_name("Hello World", "https://x.com"), "Hello World.md");
        // Path/reserved characters are folded, whitespace collapsed.
        assert_eq!(link_file_name("A/B: c\td", "https://x.com"), "A B c d.md");
        // Empty title falls back to the URL (reserved chars folded), never empty.
        assert_eq!(link_file_name("   ", "https://ex.com/p"), "https ex.com p.md");
    }

    /// ADD-13: give every chunk a toy 2-D embedding chosen by its text so the
    /// blend is deterministic — "vacation" chunks point one way, others the
    /// orthogonal way.
    fn embed_chunks_by_keyword(conn: &Connection, keyword: &str) {
        for (id, _name, text) in db::chunks_missing_embedding(conn, 1000).unwrap() {
            let v = if text.to_lowercase().contains(keyword) {
                [1.0f32, 0.0]
            } else {
                [0.0f32, 1.0]
            };
            db::set_chunk_embedding(conn, &id, &db::embedding_to_blob(&v)).unwrap();
        }
    }

    #[test]
    fn blend_retrieves_synonym_by_vector() {
        // ADD-13: keyword search cannot connect "time off" to "vacation
        // schedule", but a vector pointing at the vacation chunk can.
        let conn = db::open_in_memory_schema();
        db::insert_file(
            &conn,
            "handbook.txt",
            "text/plain",
            b"x",
            Some("The office holiday party is on Friday."),
            "upload",
        )
        .unwrap();
        db::insert_file(
            &conn,
            "hr.txt",
            "text/plain",
            b"x",
            Some("Our vacation schedule lists everyone's paid time away."),
            "upload",
        )
        .unwrap();
        embed_chunks_by_keyword(&conn, "vacation");

        // Question shares no keyword with either file; its vector points at the
        // vacation chunk ([1,0]).
        let q = [1.0f32, 0.0];
        let (chunks, fallback) =
            retrieve_context(&conn, "how much unpaid absence", Some(&q)).unwrap();
        assert!(!fallback, "vector match must count as a real match");
        assert_eq!(chunks[0].file_name, "hr.txt");

        // Pure keyword path (no embedding) still works for a literal term.
        let (kw_chunks, kw_fallback) = retrieve_context(&conn, "holiday", None).unwrap();
        assert!(!kw_fallback);
        assert_eq!(kw_chunks[0].file_name, "handbook.txt");

        // No keyword hit and no embedding → clean fallback to recent content.
        let (_, generic_fallback) = retrieve_context(&conn, "xyzzy nothing", None).unwrap();
        assert!(generic_fallback);
    }

    #[test]
    fn detects_synced_paths() {
        assert!(is_synced_path(
            "/Users/x/Library/Mobile Documents/com~apple~CloudDocs/room.roomai"
        ));
        assert!(is_synced_path(
            "/Users/x/Library/CloudStorage/Dropbox/room.roomai"
        ));
        assert!(!is_synced_path("/Users/x/Documents/room.roomai"));
    }

    #[test]
    fn parse_string_list_handles_json_and_prose() {
        // JSON array wins even with leading prose.
        let a = parse_string_list("Sure, here they are: [\"AAPL\", \"MSFT\", \"NVDA\"]");
        assert_eq!(a, vec!["AAPL", "MSFT", "NVDA"]);
        // Falls back to line/bullet splitting; dedups case-insensitively.
        let b = parse_string_list("1. Apple\n2. apple\n- Microsoft");
        assert_eq!(b, vec!["Apple", "Microsoft"]);
        // <think> spans are stripped before parsing.
        let c = parse_string_list("<think>hmm</think>[\"x\"]");
        assert_eq!(c, vec!["x"]);
    }

    #[test]
    fn extract_md_table_parses_and_skips_separator() {
        let md = "intro\n\n| Name | Age |\n|------|-----|\n| Ann | 30 |\n| Bob | 25 |\n\nafter";
        let rows = extract_md_table(md).unwrap();
        assert_eq!(rows.len(), 3); // header + 2 data rows (separator dropped)
        assert_eq!(rows[0], vec!["Name", "Age"]);
        assert_eq!(rows[2], vec!["Bob", "25"]);
        // No table → None.
        assert!(extract_md_table("just prose, no pipes").is_none());
        // With two tables, the LAST one wins (most recent answer).
        let two = "| A |\n|---|\n| 1 |\n\ntext\n\n| Z |\n|---|\n| 9 |";
        let last = extract_md_table(two).unwrap();
        assert_eq!(last[0], vec!["Z"]);
    }

    #[test]
    fn name_from_topic_is_path_safe() {
        assert_eq!(name_from_topic("Q3 revenue: AAPL/MSFT!"), "Q3 revenue AAPL MSFT.md");
        assert_eq!(name_from_topic(""), "Note.md");
    }

    #[test]
    fn build_annotation_verifies_quote_verbatim() {
        let text = "The lease permits one cat but no dogs.";
        // A verbatim (normalization-tolerant) quote succeeds.
        let (payload, described) =
            build_annotation("id1", "lease.pdf", Some(text), "one cat", "", None, None, None)
                .unwrap();
        assert_eq!(described, "\"one cat\"");
        assert_eq!(payload["quote"], "one cat");
        // A quote not present is rejected (the anti-fabrication gate).
        assert!(
            build_annotation("id1", "lease.pdf", Some(text), "three cats", "", None, None, None)
                .is_err()
        );
        // A cell range needs no text.
        let (p, d) =
            build_annotation("id2", "budget.xlsx", None, "", "B2:D5", None, None, None).unwrap();
        assert_eq!(d, "cells B2:D5");
        assert_eq!(p["range"], "B2:D5");
    }

    #[test]
    fn wants_write_tools_routes_by_intent() {
        // Edit/create/highlight intents open the write tools…
        assert!(wants_write_tools("please fix the typo in the contract"));
        assert!(wants_write_tools("Create a summary note"));
        assert!(wants_write_tools("highlight the pet clause"));
        assert!(wants_write_tools("translate this to French"));
        // …plain informational questions keep the short read-only catalog.
        assert!(!wants_write_tools("what does the lease say about pets?"));
        assert!(!wants_write_tools("who are the parties in this agreement"));
    }

    #[test]
    fn closest_snippet_anchors_paraphrase_verbatim() {
        let text = "The quarterly revenue was four million dollars this year.";
        // A paraphrased quote still finds the real passage, returned verbatim.
        let snip = closest_snippet(text, "quarterly revenue was five million").unwrap();
        assert!(text.contains(&snip), "must be a real substring: {snip}");
        assert!(snip.to_lowercase().contains("quarterly revenue was"));
        // Unrelated text has no close passage, and short quotes are never guessed.
        assert!(closest_snippet(text, "the weather is sunny today outside").is_none());
        assert!(closest_snippet(text, "big money").is_none());
    }

    #[test]
    fn build_annotation_falls_back_to_closest_passage() {
        let text = "Payment is due within thirty days of receipt of invoice.";
        // A quote that isn't verbatim (drops "is", "thirty"→"30") still anchors,
        // flagged approximate — turning a hard failure into a soft success.
        let (payload, described) = build_annotation(
            "id",
            "terms.txt",
            Some(text),
            "payment due within 30 days",
            "",
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(payload["approx"], true);
        assert!(described.contains("closest match"), "got: {described}");
        let q = payload["quote"].as_str().unwrap();
        assert!(text.contains(q), "highlighted quote must be verbatim: {q}");
    }

    #[test]
    fn html_document_wraps_and_escapes() {
        let doc = html_document("Report", "<h2>Hi</h2>");
        assert!(doc.starts_with("<!doctype html>"));
        assert!(doc.contains("<title>Report</title>"));
        assert!(doc.contains("<h2>Hi</h2>"));
        // A full page passes through unchanged (no double-wrap).
        let full = "<!doctype html><html><body>x</body></html>";
        assert_eq!(html_document("t", full), full);
        assert_eq!(html_escape("a<b>&\"c"), "a&lt;b&gt;&amp;&quot;c");
    }

    #[test]
    fn html_note_name_defaults_to_html() {
        assert_eq!(html_note_name("Q3 report"), "Q3 report.html");
        assert_eq!(html_note_name(""), "Note.html");
    }
}
