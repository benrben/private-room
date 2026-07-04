use crate::{db, extraction, mcp, ocr, ollama, web};
use base64::Engine;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::State;
use uuid::Uuid;

const DEFAULT_MODEL: &str = "qwen3.5:4b";
const MAX_CONTEXT_CHUNKS: usize = 6;
/// ADD-13: retrieval blend weights (simple weighted sum of a per-chunk keyword
/// score and vector cosine, both normalized to ~[0,1]).
const KEYWORD_WEIGHT: f32 = 0.5;
const VECTOR_WEIGHT: f32 = 0.5;
/// ADD-13: widen the per-signal candidate pool before blending, so a strong
/// vector-only (synonym) chunk can surface above weak keyword hits.
const RETRIEVE_CANDIDATES: usize = MAX_CONTEXT_CHUNKS * 4;
const MAX_IMPORT_BYTES: u64 = 200 * 1024 * 1024;
const MAX_ATTACHED_IMAGES: usize = 4;
const MAX_HISTORY_MESSAGES: usize = 12;
/// External tool results (web pages, search results) can be huge; clamp
/// them so a few rounds still fit the context window.
const MAX_TOOL_RESULT_CHARS: usize = 4000;
/// Keep the tool catalog small enough for an 8-12K context and a 4B model.
const MAX_MCP_TOOLS: usize = 24;

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

/// Find cloud coding CLIs on this Mac. GUI apps get a bare PATH, so ask a
/// login shell, which has the user's real environment.
fn detect_external_blocking() -> Vec<String> {
    let mut found = Vec::new();
    if let Ok(out) = std::process::Command::new("zsh")
        .args(["-lc", "command -v claude; command -v codex"])
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

/// ADD-10: is Ollama installed on this Mac at all? Distinct from "running".
/// Matches the login-shell PATH trick used for the cloud CLIs.
fn ollama_installed_blocking() -> bool {
    if std::path::Path::new("/Applications/Ollama.app").exists() {
        return true;
    }
    std::process::Command::new("zsh")
        .args(["-lc", "command -v ollama"])
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
    prompt.push_str("Respond to the last user message. Reply with the answer only.");

    let cmdline = match engine {
        "claude-cli" => "claude -p",
        "codex-cli" => "codex exec -",
        _ => return Err("Unknown engine".into()),
    };
    let engine_name = engine.to_string();
    let work_dir = if image_paths.is_empty() {
        std::env::temp_dir()
    } else {
        tmp_dir.clone()
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut child = std::process::Command::new("zsh")
            .args(["-lc", cmdline])
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
    spawn_embedding_backfill(&app);
    Ok(info)
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

/// ADD-14: a queued background OCR pass for one just-imported file.
struct OcrJob {
    id: String,
    name: String,
    mime: String,
    ext: String,
    bytes: Vec<u8>,
}

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
    let mut ocr_jobs: Vec<OcrJob> = Vec::new();
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
                let needs_ocr = text.as_deref().map_or(true, |t| t.trim().is_empty())
                    && ocr::is_ocr_candidate(&mime, &ext);
                match db::insert_file(&room.conn, &file_name, &mime, &bytes, text.as_deref(), "upload")
                {
                    Ok(meta) => {
                        if needs_ocr {
                            ocr_jobs.push(OcrJob {
                                id: meta.id.clone(),
                                name: file_name.clone(),
                                mime: mime.clone(),
                                ext,
                                bytes,
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
    // Release the room lock before kicking off background OCR — the workers
    // re-acquire it once, briefly, only when they have text to store.
    drop(guard);
    for job in ocr_jobs {
        spawn_ocr(app.clone(), room_path.clone(), job);
    }
    Ok(ImportReport { imported, errors })
}

/// ADD-14: run on-device OCR for one file on a background thread. On success,
/// store the recognized text (prefixed so the AI can flag OCR uncertainty),
/// re-index it, and tell the UI the file list changed. Any failure is silent —
/// the file simply keeps having no text, exactly like before this feature.
fn spawn_ocr(app: tauri::AppHandle, room_path: String, job: OcrJob) {
    use tauri::{Emitter, Manager};
    std::thread::spawn(move || {
        let _ = app.emit("ocr-progress", (&job.name, "started"));
        let recognized = ocr::recognize(&job.mime, &job.ext, &job.bytes);
        let Some(text) = recognized else {
            let _ = app.emit("ocr-progress", (&job.name, "none"));
            return;
        };
        let full_text = format!("(text recognized from scan)\n{text}");
        {
            let state = app.state::<AppState>();
            let guard = state.room.lock().unwrap();
            // The room may have been closed or switched while OCR ran; only
            // write back into the same room this file was imported into.
            match guard.as_ref() {
                Some(room) if room.path == room_path => {
                    let _ = db::update_file_content(&room.conn, &job.id, &job.bytes, Some(&full_text));
                }
                _ => return,
            }
        }
        let _ = app.emit("room-files-changed", ());
        let _ = app.emit("ocr-progress", (&job.name, "done"));
    });
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
    let (title, text) = web::fetch_page(&url).await?;
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let saved = db::current_date(&room.conn);
    let name = link_file_name(&title, &url);
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

/// The one canonical, overwrite-in-place summary file (ADD-17).
const SUMMARY_FILE_NAME: &str = "Room summary.md";
/// Cap per run so a huge room stays within the small local context; the rest are
/// listed by name with a note.
const MAX_SUMMARY_FILES: usize = 50;

/// True for the app's own generated "Room summary.md" — excluded from its own
/// summary. A user-uploaded file that happens to share the name is NOT excluded.
fn is_summary_file(name: &str, source: &str) -> bool {
    name == SUMMARY_FILE_NAME && source == "generated"
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
async fn summarize_one_file(
    model: &str,
    name: &str,
    mime: &str,
    text: &str,
) -> Result<String, String> {
    let messages = vec![
        ollama::ChatMessage::new(
            "system",
            "You describe a single file in ONE short, factual sentence based only on what is \
             given. No preamble, no quotes, just the sentence.",
        ),
        ollama::ChatMessage::new(
            "user",
            format!(
                "File name: {name}\nType: {mime}\n\nBeginning of its text:\n{text}\n\n\
                 In one sentence, what is this file about?"
            ),
        ),
    ];
    let (out, _) =
        ollama::chat_stream_tools(model, messages, None, Some(0.2), None, KEEP_ALIVE_WARM, |_| {})
            .await?;
    Ok(clean_one_liner(&out))
}

/// ADD-17 reduce step: one call producing the "What this room is for" paragraph
/// and three suggested questions, given the per-file one-liners for context. The
/// deterministic file list is assembled by the caller (never invented here).
async fn combine_summary(
    model: &str,
    room_name: &str,
    memories: &[String],
    file_lines: &str,
) -> Result<String, String> {
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
            "You summarize a personal document room. Output Markdown with EXACTLY these two \
             sections and nothing else:\n\
             ## What this room is for\n\
             <one short paragraph, 2-4 sentences>\n\n\
             ## Try asking\n\
             1. <a question the files could answer>\n\
             2. <another>\n\
             3. <another>\n\
             Base everything only on the information given. Do not list the files.",
        ),
        ollama::ChatMessage::new("user", context),
    ];
    let (out, _) =
        ollama::chat_stream_tools(model, messages, None, Some(0.4), None, KEEP_ALIVE_WARM, |_| {})
            .await?;
    Ok(out.trim().to_string())
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
        let existing_id = all
            .iter()
            .find(|f| is_summary_file(&f.name, &f.source))
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
    let mut file_lines = String::new();
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
            let liner = summarize_one_file(&model, &f.name, &f.mime, snippet).await?;
            if !liner.is_empty() {
                if let Some(room) = state.room.lock().unwrap().as_ref() {
                    let _ = db::set_file_ai_summary(&room.conn, &f.id, &liner);
                }
            }
            liner
        };
        if one_liner.is_empty() {
            file_lines.push_str(&format!("- {display} ({})\n", f.mime));
        } else {
            file_lines.push_str(&format!("- {display} — {one_liner}\n"));
        }
    }
    if capped {
        for f in files.iter().skip(MAX_SUMMARY_FILES) {
            let display = match &f.folder {
                Some(folder) => format!("{folder}/{}", f.name),
                None => f.name.clone(),
            };
            file_lines.push_str(&format!("- {display}\n"));
        }
    }

    // Reduce: purpose paragraph + suggested questions.
    let _ = window.emit("summarize-progress", "Writing the summary…");
    let combined = combine_summary(&model, &room_name, &memories, &file_lines).await?;

    // Assemble the final Markdown. The file list is placed deterministically
    // between the model's purpose paragraph and its suggested questions.
    let (purpose_part, questions_part) = match combined.find("## Try asking") {
        Some(i) => (combined[..i].trim().to_string(), combined[i..].trim().to_string()),
        None => (combined.trim().to_string(), String::new()),
    };
    let saved_date = {
        let guard = state.room.lock().unwrap();
        guard
            .as_ref()
            .map(|room| db::current_date(&room.conn))
            .unwrap_or_default()
    };
    let mut content = format!("_Generated on {saved_date}_\n\n");
    if purpose_part.is_empty() {
        content.push_str("## What this room is for\n\n");
    } else {
        content.push_str(&purpose_part);
        content.push_str("\n\n");
    }
    content.push_str("## Files\n\n");
    content.push_str(file_lines.trim_end());
    if capped {
        content.push_str(&format!(
            "\n\n_Only the first {MAX_SUMMARY_FILES} files were summarized; the rest are listed by name._"
        ));
    }
    if !questions_part.is_empty() {
        content.push_str("\n\n");
        content.push_str(&questions_part);
    }
    content.push('\n');

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
            "text/markdown",
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
    let list = merge_recent(
        read_recent(app),
        RecentRoom {
            name: name.to_string(),
            path: path.to_string(),
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

fn is_mcp_approved(app: &tauri::AppHandle, fingerprint: &str) -> bool {
    read_mcp_approvals(app).iter().any(|f| f == fingerprint)
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

/// SEC-1: if the open room's config has ENABLED servers whose fingerprint isn't
/// approved on this Mac, describe them for the approval dialog. None otherwise
/// (no enabled servers, or already approved).
fn pending_mcp_for(app: &tauri::AppHandle, conn: &Connection) -> Option<McpApproval> {
    let config = db::get_setting(conn, MCP_CONFIG_KEY)?;
    let servers = mcp::parse_config(&config).ok()?;
    let enabled: Vec<&(String, mcp::ServerConfig)> =
        servers.iter().filter(|(_, c)| !c.disabled).collect();
    if enabled.is_empty() {
        return None;
    }
    let fingerprint = mcp_fingerprint(&config);
    if is_mcp_approved(app, &fingerprint) {
        return None;
    }
    let briefs = enabled
        .iter()
        .map(|(name, cfg)| McpServerBrief {
            name: name.clone(),
            command: render_command_line(cfg),
        })
        .collect();
    Some(McpApproval {
        fingerprint,
        servers: briefs,
    })
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
    let servers = config_json
        .as_deref()
        .and_then(|j| mcp::parse_config(j).ok())
        .unwrap_or_default();
    // SEC-1: never auto-spawn a room's plug-ins without a per-Mac approval of
    // this exact config. If any server is enabled and the config's fingerprint
    // is not approved, start NOTHING — the UI surfaces the approval dialog via
    // RoomInfo.pendingMcp and calls approve_mcp on "Allow".
    if servers.iter().any(|(_, c)| !c.disabled) {
        if let Some(json) = &config_json {
            if !is_mcp_approved(app, &mcp_fingerprint(json)) {
                return;
            }
        }
    }
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
    let start = match raw.find('[') {
        Some(i) => i,
        None => return vec![],
    };
    let end = match raw.rfind(']') {
        Some(i) if i > start => i,
        _ => return vec![],
    };
    let items: Vec<serde_json::Value> = match serde_json::from_str(&raw[start..=end]) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
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
    let (raw, _) =
        ollama::chat_stream_tools(&vmodel, messages, None, Some(0.0), None, keep, |_| {}).await?;
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

fn is_locate_intent(question: &str) -> bool {
    let q = question.to_lowercase();
    [
        "where",
        "mark ",
        "mark the",
        "locate",
        "point to",
        "point out",
        "circle",
        "highlight",
        "show me",
        "find the",
        "find all",
        "find where",
    ]
    .iter()
    .any(|k| q.contains(k))
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
        if word.len() >= 3 && !STOPWORDS.contains(&word) && !terms.contains(&word.to_string()) {
            terms.push(word.to_string());
        }
        if terms.len() >= 24 {
            break;
        }
    }
    terms
}

struct ScoredChunk {
    file_name: String,
    text: String,
    score: f32,
}

/// ADD-13: embed the question so retrieval can blend meaning with keywords.
/// Returns None on ANY failure (model missing, Ollama down, empty result) so the
/// caller silently falls back to the pure keyword path — the chat never blocks.
/// Keeps the small embed model briefly warm so back-to-back questions are fast.
async fn embed_question(question: &str) -> Option<Vec<f32>> {
    match ollama::embed(ollama::EMBED_MODEL, std::slice::from_ref(&question.to_string()), "5m").await {
        Ok(mut v) if !v.is_empty() && !v[0].is_empty() => Some(v.remove(0)),
        _ => None,
    }
}

/// ADD-13: kick off the lazy background embed pass for the currently open room.
/// Bumps the embed generation (so any older pass exits) and spawns exactly one
/// loop carrying the new stamp. Cheap to call on every unlock; no-op work once
/// every chunk already has a vector.
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

        let texts: Vec<String> = batch.iter().map(|(_, t)| t.clone()).collect();
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
        for ((id, _), vec) in batch.iter().zip(vectors.iter()) {
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
    // One candidate per chunk rowid, so keyword and vector scores line up.
    struct Cand {
        file_name: String,
        text: String,
        kw: f32,
        vec: f32,
    }
    let mut pool: HashMap<i64, Cand> = HashMap::new();

    // Keyword signal: bm25 (lower-is-better) → higher-is-better, min-max
    // normalized across the hit set to ~[0,1] so it blends with cosine.
    if let Some(expr) = fts_match_expr(question_terms(question).iter().map(String::as_str)) {
        let hits = db::search_chunks_fts_ranked(conn, &expr, RETRIEVE_CANDIDATES)?;
        if !hits.is_empty() {
            let raws: Vec<f32> = hits.iter().map(|(_, _, _, bm25)| -*bm25 as f32).collect();
            let max = raws.iter().cloned().fold(f32::MIN, f32::max);
            let min = raws.iter().cloned().fold(f32::MAX, f32::min);
            let span = max - min;
            for ((rowid, name, text, _), raw) in hits.into_iter().zip(raws) {
                let kw = if span > 0.0 { (raw - min) / span } else { 1.0 };
                let e = pool.entry(rowid).or_insert_with(|| Cand {
                    file_name: name,
                    text,
                    kw: 0.0,
                    vec: 0.0,
                });
                e.kw = kw;
            }
        }
    }

    // Vector signal: cosine of the question against every stored chunk vector
    // (brute force), clamped to [0,1]; keep the strongest as candidates.
    if let Some(q) = question_embedding {
        let mut scored: Vec<(i64, String, String, f32)> = db::chunk_embeddings(conn)?
            .into_iter()
            .filter_map(|(rowid, name, text, blob)| {
                db::blob_to_embedding(&blob)
                    .map(|emb| (rowid, name, text, db::cosine_similarity(q, &emb).max(0.0)))
            })
            .collect();
        scored.sort_by(|a, b| b.3.partial_cmp(&a.3).unwrap_or(std::cmp::Ordering::Equal));
        for (rowid, name, text, cos) in scored.into_iter().take(RETRIEVE_CANDIDATES) {
            let e = pool.entry(rowid).or_insert_with(|| Cand {
                file_name: name,
                text,
                kw: 0.0,
                vec: 0.0,
            });
            e.vec = cos;
        }
    }

    if !pool.is_empty() {
        let mut scored: Vec<ScoredChunk> = pool
            .into_values()
            .map(|c| ScoredChunk {
                file_name: c.file_name,
                text: c.text,
                score: KEYWORD_WEIGHT * c.kw + VECTOR_WEIGHT * c.vec,
            })
            .collect();
        scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(MAX_CONTEXT_CHUNKS);
        // A real match means at least one chunk scored above zero.
        if scored.iter().any(|s| s.score > 0.0) {
            return Ok((scored, false));
        }
    }

    // Generic questions ("summarize this") match nothing; fall back to the
    // most recently added content so the model still sees the room.
    let scored = db::recent_chunks(conn, MAX_CONTEXT_CHUNKS)?
        .into_iter()
        .map(|(file_name, text)| ScoredChunk {
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
    let (explicit_model, chat_messages, sources, first_image, temperature, web_enabled) = {
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

        // Attachments: images go to the model as vision input, text files as
        // guaranteed context.
        let mut images: Vec<String> = Vec::new();
        let mut attached_notes: Vec<String> = Vec::new();
        let mut sources: Vec<String> = Vec::new();
        let mut first_image: Option<(String, String, Vec<u8>, f64, f64)> = None;
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
            } else if let Some(mut text) = text {
                if text.len() > 6000 {
                    text.truncate(6000);
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
             copy text exactly as it appears in the file (search_room shows it verbatim).",
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
        let inventory: Vec<(String, String)> = db::list_file_inventory(conn)?;
        if !inventory.is_empty() {
            system.push_str("\n\nFiles currently stored in this room:\n");
            for (name, mime) in &inventory {
                system.push_str(&format!("- {name} ({mime})\n"));
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

        if !memories.is_empty() {
            system.push_str("\n\nPersistent memory notes for this room:\n");
            for m in &memories {
                system.push_str(&format!("- {m}\n"));
            }
        }

        let mut chat_messages = vec![ollama::ChatMessage::new("system", system)];
        for (role, content) in history {
            // Viewer-markup payloads are UI data, not conversation.
            let mut content = strip_markup_blocks(&content);
            if content.len() > 4000 {
                content.truncate(4000);
            }
            chat_messages.push(ollama::ChatMessage::new(&role, content));
        }

        let mut user_content = String::new();
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

        (explicit_model, chat_messages, sources, first_image, temperature, web_enabled)
    };

    let models = ollama::list_models().await.unwrap_or_default();
    let model = explicit_model
        .clone()
        .unwrap_or_else(|| best_default(&models));

    // "Where is X?" with an image attached → run a grounding pass so the
    // reply carries box markup — in ADDITION to the normal answer, not
    // instead of it.
    let mut effects = ToolEffects::default();
    if let Some((img_id, img_name, img_bytes, w, h)) = &first_image {
        if is_locate_intent(&question) {
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
                if let Ok((raw, _)) =
                    ollama::chat_stream_tools(&vmodel, messages, None, Some(0.0), None, keep, |_| {})
                        .await
                {
                    let boxes = parse_boxes(&raw, *w, *h);
                    if !boxes.is_empty() {
                        effects.boxes = Some(serde_json::json!({
                            "fileId": img_id,
                            "name": img_name,
                            "boxes": boxes,
                        }));
                        // CHG-5: a step, not fake answer text (ask-delta is
                        // reserved for the model's own words now).
                        let _ = window.emit("ask-step", "Marked the image");
                    }
                }
            }
        }
    }

    // Phase 2 (unlocked): answer — through a cloud CLI if selected, or the
    // local model with full app-control tools. When the user pressed Stop
    // mid-answer, a raised error is expected — swallow it and save the partial.
    let run = if is_external_engine(&model) {
        // CHG-5: a step chip, not fake live text (nothing streams for cloud).
        let _ = window.emit("ask-step", "Asking your cloud AI (content leaves this Mac)");
        run_external(&model, &chat_messages, Some(cancel.clone())).await
    } else {
        agent_loop(
            &window,
            &state,
            &model,
            chat_messages,
            temperature,
            &mut effects,
            web_enabled,
            cancel.clone(),
        )
        .await
    };
    let stopped = cancel.load(Ordering::SeqCst);
    let answer = match run {
        Ok(text) => text,
        // ADD-7: the child was killed / stream cut on purpose — keep partial.
        Err(_) if stopped => String::new(),
        Err(e) => return Err(e),
    };

    let mut content = answer;
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

/// Tools the local model can use to drive the app. The web tools appear
/// only when the user enabled a search provider — a disabled capability is
/// one the model cannot even attempt.
fn tools_catalog(web_enabled: bool) -> serde_json::Value {
    let mut tools = serde_json::json!([
        {"type": "function", "function": {"name": "list_room_files",
            "description": "List every file stored in this room with its type and size.",
            "parameters": {"type": "object", "properties": {}}}},
        {"type": "function", "function": {"name": "search_room",
            "description": "Search the extracted text of all files in the room.",
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
            "description": "Highlight a spot in a document or spreadsheet so the user sees it marked in the viewer. Quote exact text from the file, or give a cell range for spreadsheets. For images use mark_image instead.",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "File name or part of it"},
                "text": {"type": "string", "description": "Short exact quote copied from the file (max ~200 chars)"},
                "page": {"type": "integer", "description": "PDF page the text is on, if known"},
                "sheet": {"type": "string", "description": "Sheet name, for spreadsheets"},
                "range": {"type": "string", "description": "Cell or range to highlight, like B7 or B2:D5"},
                "note": {"type": "string", "description": "Short label explaining the highlight"}},
                "required": ["name"]}}},
        {"type": "function", "function": {"name": "create_file",
            "description": "Create a new note/document file saved into the room.",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string"}, "content": {"type": "string"}},
                "required": ["name", "content"]}}},
        {"type": "function", "function": {"name": "edit_file",
            "description": "Change part of an existing file (text, code, notes, csv, or docx) by replacing exact text. Copy old_text exactly as it appears in the file.",
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
            "description": "Set the value of one cell in a spreadsheet (.xlsx or .csv). Call it once per cell to change.",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "File name or part of it"},
                "cell": {"type": "string", "description": "Cell in A1 notation, like B7"},
                "value": {"type": "string", "description": "New value for the cell"},
                "sheet": {"type": "string", "description": "Sheet name (default: first sheet)"}},
                "required": ["name", "cell", "value"]}}},
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
                "description": "Fetch one web page by URL and return its readable text.",
                "parameters": {"type": "object", "properties": {
                    "url": {"type": "string", "description": "Full http(s) URL"}},
                    "required": ["url"]}}}
        ));
    }
    tools
}

/// A connected MCP tool exposed to the model this turn: its catalog entry
/// plus the client handle to call it with.
struct McpRoute {
    catalog_name: String,
    tool_name: String,
    spec: serde_json::Value,
    client: Arc<tokio::sync::Mutex<mcp::Client>>,
}

/// Snapshot the connected MCP tools, namespaced `server_tool` and deduped
/// against the built-in tool names and each other.
fn mcp_routes(state: &State<'_, AppState>) -> Vec<McpRoute> {
    let mut taken: std::collections::HashSet<String> = BUILTIN_TOOL_NAMES
        .iter()
        .map(|s| s.to_string())
        .collect();
    let mgr = state.mcp.lock().unwrap();
    let mut routes = Vec::new();
    for server in &mgr.servers {
        let Some(client) = &server.client else { continue };
        for tool in &server.tools {
            if routes.len() >= MAX_MCP_TOOLS {
                return routes;
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
            taken.insert(catalog_name.clone());
            // Long descriptions eat the context; cut at a char boundary.
            let description: String = tool.description.chars().take(300).collect();
            routes.push(McpRoute {
                catalog_name: catalog_name.clone(),
                tool_name: tool.name.clone(),
                spec: serde_json::json!({"type": "function", "function": {
                    "name": catalog_name,
                    "description": description,
                    "parameters": tool.schema.clone(),
                }}),
                client: client.clone(),
            });
        }
    }
    routes
}

/// Viewer payloads produced by tools during a turn; appended to the saved
/// assistant message as fenced markup blocks.
#[derive(Default)]
struct ToolEffects {
    boxes: Option<serde_json::Value>,
    annotation: Option<serde_json::Value>,
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
        "set_cells" => "Updated a spreadsheet cell",
        "add_memory" => "Saved a memory",
        "web_search" => "Searched the web",
        "fetch_page" => "Fetched a page",
        // Connected MCP tools are namespaced server_tool.
        _ => return format!("Ran the {name} tool"),
    }
    .to_string()
}

async fn agent_loop(
    window: &tauri::Window,
    state: &State<'_, AppState>,
    model: &str,
    mut messages: Vec<ollama::ChatMessage>,
    temperature: Option<f64>,
    effects: &mut ToolEffects,
    web_enabled: bool,
    cancel: Arc<AtomicBool>,
) -> Result<String, String> {
    use tauri::Emitter;
    let mut tools = tools_catalog(web_enabled);
    let routes = mcp_routes(state);
    if let Some(arr) = tools.as_array_mut() {
        for r in &routes {
            arr.push(r.spec.clone());
        }
    }
    // Web flows chain search → fetch → answer; give them more rounds.
    let max_rounds = if routes.is_empty() && !web_enabled { 4 } else { 8 };
    let mut final_text = String::new();
    for _round in 0..max_rounds {
        // ADD-7: stop between rounds too.
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        // CHG-5: a fresh model round begins — frontend clears its live text so
        // the visible stream always equals only the current round's words.
        let _ = window.emit("ask-round", ());
        let (content, calls) = ollama::chat_stream_tools(
            model,
            messages.clone(),
            Some(&tools),
            temperature,
            Some(cancel.clone()),
            // HLT-5: the chat model stays warm throughout the conversation.
            KEEP_ALIVE_WARM,
            |d| {
                let _ = window.emit("ask-delta", d);
            },
        )
        .await?;
        if calls.is_empty() || cancel.load(Ordering::SeqCst) {
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
        for call in &calls {
            // ADD-7: stop between tool calls.
            if cancel.load(Ordering::SeqCst) {
                break;
            }
            // CHG-5: human step label, not inline "⚙ name…" answer text.
            let _ = window.emit("ask-step", tool_step_label(&call.name));
            let result = exec_tool(state, window, call, effects, &routes)
                .await
                .unwrap_or_else(|e| format!("Tool error: {e}"));
            messages.push(ollama::ChatMessage {
                role: "tool".into(),
                content: result,
                tool_name: Some(call.name.clone()),
                ..Default::default()
            });
        }
        final_text = content;
    }
    // Don't invent "Done." over a partial answer the user stopped.
    if final_text.trim().is_empty() && !cancel.load(Ordering::SeqCst) {
        final_text = "Done.".into();
    }
    Ok(final_text)
}

async fn exec_tool(
    state: &State<'_, AppState>,
    window: &tauri::Window,
    call: &ollama::ToolCall,
    effects: &mut ToolEffects,
    routes: &[McpRoute],
) -> Result<String, String> {
    use tauri::Emitter;
    let args = &call.arguments;
    match call.name.as_str() {
        "list_room_files" => {
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().ok_or("No room is open.")?;
            let rows: Vec<String> = db::list_files_brief(&room.conn)?
                .into_iter()
                .map(|(name, mime, size)| format!("- {name} ({mime}, {size} bytes)"))
                .collect();
            Ok(if rows.is_empty() {
                "The room has no files.".into()
            } else {
                rows.join("\n")
            })
        }
        "search_room" => {
            let query = args["query"].as_str().unwrap_or_default();
            // ADD-13: embed the query before locking (async Ollama call); None
            // → keyword-only retrieval.
            let query_embedding = embed_question(query).await;
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().ok_or("No room is open.")?;
            let (chunks, fallback) =
                retrieve_context(&room.conn, query, query_embedding.as_deref())?;
            if chunks.is_empty() || fallback {
                return Ok("No matching content found.".into());
            }
            Ok(chunks
                .iter()
                .take(4)
                .map(|c| format!("[{}]\n{}", c.file_name, &c.text[..c.text.len().min(800)]))
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
                .map(|t| format!("\nIt begins:\n{}", &t[..t.len().min(1200)]))
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
            let payload;
            let described;
            if !range.is_empty() {
                if !is_a1_range(&range) {
                    return Err(format!(
                        "\"{range}\" is not a cell range — use A1 notation like B7 or B2:D5."
                    ));
                }
                described = format!("cells {range}");
                payload = serde_json::json!({
                    "fileId": id, "name": real_name, "sheet": sheet,
                    "range": range, "note": note,
                });
            } else if !quote.is_empty() {
                let haystack = normalize_for_match(&extracted.unwrap_or_default());
                let needle = normalize_for_match(&quote);
                // PDF extraction breaks words unpredictably; fall back to a
                // space-free comparison before rejecting the quote.
                let found = haystack.contains(&needle)
                    || haystack.replace(' ', "").contains(&needle.replace(' ', ""));
                if !found {
                    return Err(format!(
                        "Could not find that text in \"{real_name}\". Copy a short snippet \
                         exactly as it appears in the file (use search_room or open_file to \
                         see its text first)."
                    ));
                }
                described = format!("\"{quote}\"");
                payload = serde_json::json!({
                    "fileId": id, "name": real_name, "quote": quote,
                    "page": page, "note": note,
                });
            } else {
                return Err(
                    "Provide either exact text to highlight, or a cell range for spreadsheets."
                        .into(),
                );
            }
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
                        return Err(format!(
                            "Could not find that exact text in \"{real_name}\". Copy it exactly, \
                             including spacing and punctuation."
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
            Ok(format!(
                "Rewrote \"{real_name}\" ({} characters).",
                content.chars().count()
            ))
        }
        "set_cells" => {
            let name = args["name"].as_str().unwrap_or_default();
            let cell = args["cell"].as_str().unwrap_or_default().trim().to_uppercase();
            let value = args["value"].as_str().map(str::to_string).unwrap_or_else(|| {
                // Models sometimes send numbers as JSON numbers.
                args["value"].to_string().trim_matches('"').to_string()
            });
            let sheet = args["sheet"].as_str();
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().ok_or("No room is open.")?;
            let (id, real_name) = db::find_file_like(&room.conn, name)?;
            let bytes = db::get_file_bytes(&room.conn, &id)?.ok_or("File has no stored content.")?;
            let (new_bytes, text) = set_cell_in_bytes(&real_name, &bytes, sheet, &cell, &value)?;
            store_file_bytes(&room.conn, &id, &new_bytes, text.as_deref(), "AI cell change")?;
            let _ = window.emit("room-files-changed", ());
            let _ = window.emit("file-updated", &id);
            Ok(format!("Set {cell} = \"{value}\" in \"{real_name}\"."))
        }
        "web_search" => {
            let query = args["query"].as_str().unwrap_or_default();
            let (provider, key, endpoint) = {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                (
                    db::get_setting(&room.conn, "web_provider").unwrap_or_default(),
                    db::get_setting(&room.conn, "web_api_key").unwrap_or_default(),
                    db::get_setting(&room.conn, "web_endpoint").unwrap_or_default(),
                )
            };
            let _ = window.emit(
                "ask-step",
                format!("Searching the web for \"{query}\" (leaves this Mac)"),
            );
            let hits = match provider.as_str() {
                "duckduckgo" | "brave" => web::search_duckduckgo(query).await?,
                "searxng" => web::search_searxng(&endpoint, query).await?,
                _ => return Ok("Web access is turned off in Settings → Online features.".into()),
            };
            if hits.is_empty() {
                return Ok("No results found.".into());
            }
            Ok(clamp_tool_result(
                hits.iter()
                    .enumerate()
                    .map(|(i, h)| {
                        format!("{}. {}\n   {}\n   {}", i + 1, h.title, h.url, h.snippet)
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            ))
        }
        "fetch_page" => {
            let url = args["url"].as_str().unwrap_or_default();
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
            if let Some((title, text)) = cached {
                return Ok(clamp_tool_result(format!("[{title}] {url}\n\n{text}")));
            }
            let _ = window.emit("ask-step", format!("Fetching {url} (leaves this Mac)"));
            let (title, text) = web::fetch_page(url).await?;
            {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                let _ = db::save_web_page(&room.conn, url, &title, &text);
            }
            Ok(clamp_tool_result(format!("[{title}] {url}\n\n{text}")))
        }
        "mark_image" => {
            let image_name = args["image_name"].as_str().unwrap_or_default().to_lowercase();
            let find = args["find"].as_str().unwrap_or_default();
            let (id, real_name, bytes) = {
                let guard = state.room.lock().unwrap();
                let room = guard.as_ref().ok_or("No room is open.")?;
                db::find_image_like(&room.conn, &image_name)?
            };
            let (prepared, w, h) = prepare_image(&bytes);
            let models = ollama::list_models().await.unwrap_or_default();
            let chat_model = best_default(&models);
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
            let (raw, _) =
                ollama::chat_stream_tools(&vmodel, messages, None, Some(0.0), None, keep, |_| {})
                    .await?;
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
            let name = args["name"].as_str().unwrap_or("AI note.md").to_string();
            let content = args["content"].as_str().unwrap_or_default().to_string();
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
            let meta = db::insert_file(&room.conn, &name, &mime, content.as_bytes(), Some(&content), "generated")?;
            let _ = window.emit("room-files-changed", ());
            Ok(format!("Created \"{}\" in the room.", meta.name))
        }
        "add_memory" => {
            let content = args["content"].as_str().unwrap_or_default();
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().ok_or("No room is open.")?;
            // UX-5: don't store an exact duplicate; tell the model so it stops.
            if duplicate_memory(&room.conn, content)?.is_some() {
                return Ok("Already remembered.".into());
            }
            db::add_memory(&room.conn, content)?;
            Ok("Memory saved.".into())
        }
        other => match routes.iter().find(|r| r.catalog_name == other) {
            Some(route) => {
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

/// Clamp at a char boundary — external tool output can be multibyte.
fn clamp_tool_result(s: String) -> String {
    if s.chars().count() <= MAX_TOOL_RESULT_CHARS {
        return s;
    }
    let mut cut: String = s.chars().take(MAX_TOOL_RESULT_CHARS).collect();
    cut.push_str("\n… (truncated)");
    cut
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locate_intent_only_fires_on_real_locate_questions() {
        assert!(is_locate_intent("show me the cat"));
        assert!(is_locate_intent("Where is the signature?"));
        assert!(is_locate_intent("highlight the total"));
        // "sign me" was a typo that fired the slow grounding pass on unrelated
        // sentences (RM-3) — it must not match anymore.
        assert!(!is_locate_intent("please sign me up for the newsletter"));
        assert!(!is_locate_intent("summarize this document"));
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
        let mk = |p: &str| RecentRoom { name: p.into(), path: p.into() };
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
        for (id, text) in db::chunks_missing_embedding(conn, 1000).unwrap() {
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
}
