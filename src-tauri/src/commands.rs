use crate::{db, extraction, mcp, ollama, web};
use base64::Engine;
use rusqlite::Connection;
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::State;
use uuid::Uuid;

const DEFAULT_MODEL: &str = "qwen3.5:4b";
const MAX_CONTEXT_CHUNKS: usize = 6;
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
}

pub struct Room {
    pub conn: Connection,
    pub path: String,
    pub name: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RoomInfo {
    pub name: String,
    pub path: String,
    pub file_count: i64,
    pub message_count: i64,
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

/// Run one prompt through a cloud CLI (Claude Code / Codex). The content
/// leaves the machine via the user's own account — surfaced in the UI.
///
/// These CLIs are agents with file access, so attached images are written to
/// a private temp folder for the CLI to open itself, then deleted.
async fn run_external(engine: &str, messages: &[ollama::ChatMessage]) -> Result<String, String> {
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
        child
            .stdin
            .take()
            .ok_or("no stdin")?
            .write_all(prompt.as_bytes())
            .map_err(|e| e.to_string())?;
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
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

fn room_name_from_path(path: &str) -> String {
    std::path::Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Room".into())
}

fn info_of(room: &Room) -> Result<RoomInfo, String> {
    let (file_count, message_count) = db::room_counts(&room.conn)?;
    Ok(RoomInfo {
        name: room.name.clone(),
        path: room.path.clone(),
        file_count,
        message_count,
    })
}

/// The web tools exist for the model only when the user picked a provider
/// in Settings → Online features.
fn web_access_enabled(conn: &Connection) -> bool {
    matches!(
        db::get_setting(conn, "web_provider").as_deref(),
        Some("brave") | Some("searxng")
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
    let room = Room { conn, path, name };
    let info = info_of(&room)?;
    *state.room.lock().unwrap() = Some(room);
    refresh_mcp(&app);
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
    let room = Room { conn, path, name };
    let info = info_of(&room)?;
    *state.room.lock().unwrap() = Some(room);
    refresh_mcp(&app);
    Ok(info)
}

#[tauri::command]
pub fn close_room(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    use tauri::Emitter;
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
pub fn room_info(state: State<'_, AppState>) -> Result<Option<RoomInfo>, String> {
    let guard = state.room.lock().unwrap();
    match guard.as_ref() {
        Some(room) => Ok(Some(info_of(room)?)),
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
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<ImportReport, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let mut imported = Vec::new();
    let mut errors = Vec::new();
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
                match db::insert_file(&room.conn, &file_name, &mime, &bytes, text.as_deref(), "upload")
                {
                    Ok(meta) => imported.push(meta),
                    Err(e) => errors.push(format!("{file_name}: {e}")),
                }
            }
            Err(e) => errors.push(format!("{file_name}: {e}")),
        }
    }
    Ok(ImportReport { imported, errors })
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
    db::update_file_content(&room.conn, &id, bytes, Some(&text))?;
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
    db::update_file_content(&room.conn, &id, &new_bytes, text.as_deref())?;
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

// ---------------------------------------------------------------- memory

#[tauri::command]
pub fn add_memory(state: State<'_, AppState>, content: String) -> Result<Memory, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::add_memory(&room.conn, &content)
}

#[tauri::command]
pub fn list_memories(state: State<'_, AppState>) -> Result<Vec<Memory>, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::list_memories(&room.conn)
}

#[tauri::command]
pub fn delete_memory(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::delete_memory(&room.conn, &id)
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
    start_mcp_connections(app, servers);
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
    match ollama::list_models().await {
        Ok(models) => {
            let default_model = explicit.unwrap_or_else(|| best_default(&models));
            Ok(AiStatus {
                running: true,
                models,
                default_model,
                external,
            })
        }
        Err(_) => Ok(AiStatus {
            running: false,
            models: vec![],
            default_model: explicit.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
            external,
        }),
    }
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
    let (raw, _) = ollama::chat_stream_tools(&vmodel, messages, None, Some(0.0), |_| {}).await?;
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

/// Returns the scored chunks plus a `fallback` flag: true when nothing matched
/// the question and we padded with recent content instead (CHG-10 — such
/// filler must not be credited as a "source").
fn retrieve_context(conn: &Connection, question: &str) -> Result<(Vec<ScoredChunk>, bool), String> {
    let terms = question_terms(question);
    let rows = db::list_chunks_with_file_names(conn)?;

    let mut scored: Vec<ScoredChunk> = rows
        .iter()
        .map(|(name, text)| {
            let lower = text.to_lowercase();
            let score: f32 = terms
                .iter()
                .map(|t| {
                    let c = lower.matches(t.as_str()).count();
                    if c > 0 {
                        1.0 + (c as f32).ln()
                    } else {
                        0.0
                    }
                })
                .sum();
            ScoredChunk {
                file_name: name.clone(),
                text: text.clone(),
                score,
            }
        })
        .filter(|c| c.score > 0.0)
        .collect();
    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(MAX_CONTEXT_CHUNKS);

    // Generic questions ("summarize this") match nothing; fall back to the
    // most recently added content so the model still sees the room.
    if scored.is_empty() {
        scored = rows
            .into_iter()
            .take(MAX_CONTEXT_CHUNKS)
            .map(|(name, text)| ScoredChunk {
                file_name: name,
                text,
                score: 0.0,
            })
            .collect();
        return Ok((scored, true));
    }
    Ok((scored, false))
}

#[tauri::command]
pub async fn ask(
    window: tauri::Window,
    state: State<'_, AppState>,
    chat_id: String,
    question: String,
    attachments: Vec<String>,
) -> Result<Message, String> {
    use tauri::Emitter;
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

        let (context_chunks, context_fallback) = retrieve_context(conn, &question)?;

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
                 Their tools appear alongside the built-in ones. Unlike the room itself, \
                 calling them can reach the internet or other apps — use them when a question \
                 needs current or outside information, and mention when you did.",
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
                if let Ok((raw, _)) =
                    ollama::chat_stream_tools(&vmodel, messages, None, Some(0.0), |_| {}).await
                {
                    let boxes = parse_boxes(&raw, *w, *h);
                    if !boxes.is_empty() {
                        effects.boxes = Some(serde_json::json!({
                            "fileId": img_id,
                            "name": img_name,
                            "boxes": boxes,
                        }));
                        let _ = window.emit("ask-delta", "📍 Marked on the image.\n\n");
                    }
                }
            }
        }
    }

    // Phase 2 (unlocked): answer — through a cloud CLI if selected, or the
    // local model with full app-control tools.
    let answer = if is_external_engine(&model) {
        let _ = window.emit(
            "ask-delta",
            "☁ Asking via your cloud CLI (content leaves this Mac)…\n\n",
        );
        run_external(&model, &chat_messages).await?
    } else {
        agent_loop(
            &window,
            &state,
            &model,
            chat_messages,
            temperature,
            &mut effects,
            web_enabled,
        )
        .await?
    };

    let mut content = answer;
    if let Some(payload) = &effects.boxes {
        content.push_str(&format!("\n\n```boxes\n{payload}\n```"));
    }
    if let Some(payload) = &effects.annotation {
        content.push_str(&format!("\n\n```annotation\n{payload}\n```"));
    }

    // Phase 3 (locked): save the assistant reply.
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::insert_message(&room.conn, &chat_id, "assistant", &content, &sources)
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

async fn agent_loop(
    window: &tauri::Window,
    state: &State<'_, AppState>,
    model: &str,
    mut messages: Vec<ollama::ChatMessage>,
    temperature: Option<f64>,
    effects: &mut ToolEffects,
    web_enabled: bool,
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
        let (content, calls) =
            ollama::chat_stream_tools(model, messages.clone(), Some(&tools), temperature, |d| {
                let _ = window.emit("ask-delta", d);
            })
            .await?;
        if calls.is_empty() {
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
            let _ = window.emit("ask-delta", format!("\n⚙ {}…\n", call.name));
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
    if final_text.trim().is_empty() {
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
            let guard = state.room.lock().unwrap();
            let room = guard.as_ref().ok_or("No room is open.")?;
            let (chunks, fallback) = retrieve_context(&room.conn, query)?;
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
            db::update_file_content(&room.conn, &id, &new_bytes, text.as_deref())?;
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
            db::update_file_content(&room.conn, &id, content.as_bytes(), Some(&text))?;
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
            db::update_file_content(&room.conn, &id, &new_bytes, text.as_deref())?;
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
                "ask-delta",
                format!("🌐 Searching the web for \"{query}\" (leaves this Mac)…\n"),
            );
            let hits = match provider.as_str() {
                "duckduckgo" => web::search_duckduckgo(query).await?,
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
            let _ = window.emit("ask-delta", format!("🌐 Fetching {url} (leaves this Mac)…\n"));
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
            let vmodel = {
                let v = vision_model(&models, &best_default(&models));
                if is_external_engine(&v) { best_default(&models) } else { v }
            };
            let messages = vec![ollama::ChatMessage {
                role: "user".into(),
                content: grounding_prompt(find, w, h),
                images: Some(vec![base64::engine::general_purpose::STANDARD.encode(&prepared)]),
                ..Default::default()
            }];
            let (raw, _) =
                ollama::chat_stream_tools(&vmodel, messages, None, Some(0.0), |_| {}).await?;
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
    fn strips_markup_blocks() {
        let content = "Answer.\n\n```boxes\n{\"a\":1}\n```\n\n```annotation\n{\"b\":2}\n```";
        assert_eq!(strip_markup_blocks(content), "Answer.");
        assert_eq!(strip_markup_blocks("plain"), "plain");
    }
}
