use crate::{db, extraction, mcp, ocr, ollama, stt, web};
use base64::Engine;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::State;
use uuid::Uuid;

// Split into submodules (behavior-preserving relocation). Each submodule is
// re-exported below so existing paths (commands::foo) keep resolving unchanged.
mod external;
mod rooms;
mod recent;
mod safety;
mod files;
mod spreadsheet;
mod stt_cmds;
mod library;
mod search;
mod mcp_cmds;
mod models;
mod vision;
mod chat;
mod retrieval;
mod agent;
mod chat_commands;
mod docs_html;
mod summarize;
mod studios;
mod moonshot;
mod media;
mod agent_ui;
mod ytdlp;

pub use external::*;
pub use rooms::*;
pub use recent::*;
pub use safety::*;
pub use files::*;
pub use spreadsheet::*;
pub use stt_cmds::*;
pub use library::*;
pub use search::*;
pub use mcp_cmds::*;
pub use models::*;
pub use vision::*;
pub use chat::*;
pub(crate) use retrieval::*;
pub use agent::*;
pub use chat_commands::*;
pub(crate) use docs_html::*;
pub use summarize::*;
pub use studios::*;
pub use moonshot::*;
pub use media::*;
pub use agent_ui::*;
pub use ytdlp::*;

pub(crate) const DEFAULT_MODEL: &str = "qwen3.5:4b";
pub(crate) const MAX_CONTEXT_CHUNKS: usize = 6;
/// CHG-13: retrieval blends the keyword and vector signals with Reciprocal Rank
/// Fusion (scale-free), so no per-signal weight constants are needed.
/// ADD-13: widen the per-signal candidate pool before blending, so a strong
/// vector-only (synonym) chunk can surface above weak keyword hits.
pub(crate) const RETRIEVE_CANDIDATES: usize = MAX_CONTEXT_CHUNKS * 4;
pub(crate) const MAX_ATTACHED_IMAGES: usize = 4;
/// Shared character budget for all text attachments in one question — a
/// first-come cap so N attached files can never blow the 8K window.
pub(crate) const MAX_ATTACHED_TEXT_TOTAL: usize = 12_000;
pub(crate) const MAX_HISTORY_MESSAGES: usize = 12;
/// Whole-conversation history budget (chars), applied newest-first so recent
/// turns survive and ancient ones drop wholesale instead of each being cut.
pub(crate) const MAX_HISTORY_CHARS: usize = 12_000;
/// Injected persistent-memory budget (chars) and per-memory write cap.
pub(crate) const MAX_MEMORY_INJECT_CHARS: usize = 1_500;
pub(crate) const MAX_MEMORY_CONTENT_CHARS: usize = 500;
/// External tool results (web pages, search results) can be huge; clamp
/// them so a few rounds still fit the context window.
pub(crate) const MAX_TOOL_RESULT_CHARS: usize = 4000;
/// Cumulative context budget for the agent loop (chars): ~9K tokens of the
/// 12,288-token num_ctx, leaving room for the tool catalog and generation.
pub(crate) const CTX_CHAR_BUDGET: usize = 36_000;
/// Keep the tool catalog small enough for an 8-12K context and a 4B model.
/// A 4B model cannot reliably choose among more than ~12 tools.
pub(crate) const MAX_MCP_TOOLS: usize = 12;
/// Whole-catalog character budget for connected MCP tool specs.
pub(crate) const MAX_MCP_CATALOG_CHARS: usize = 8_000;
/// ADD-21: at most this many cloud-advisor consults per `ask`. A consult is a
/// slow, paid cloud call; one per turn keeps the local loop from flailing into
/// repeated exfiltration when it could just answer.
pub(crate) const MAX_ADVISOR_CALLS: u8 = 1;

pub(crate) const MCP_CONFIG_KEY: &str = "mcp_config";
/// Shown as the starting config. The web-search entry ships disabled so a
/// room never reaches the internet without the user flipping it on.
// Ship an empty scaffold, not a search example: web search has one clear home
// (Settings → Online features). MCP is the advanced "connect external tool
// programs" path — see CHG-2 / RM-5. Rooms that already saved a config keep it.
pub(crate) const DEFAULT_MCP_CONFIG: &str = r#"{
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
    /// D9 (the Leash): the room's persistent MCP server, when the user has turned
    /// it on. Unlike the per-`ask` bridge in `run_external`, this one lives for as
    /// long as the room is open so an external CLI/agent can hold a session. It is
    /// stopped and cleared whenever the room locks/closes (see `close_room`) so a
    /// stale endpoint can never outlive a locked room.
    pub room_server: Mutex<Option<crate::room_mcp::Bridge>>,
}

/// The user's answer to a per-call MCP approval prompt.
#[derive(Clone, Copy)]
pub struct McpDecision {
    pub approved: bool,
    pub remember: bool,
}

/// Removes an ask's cancel flag from the registry when the ask returns, on
/// every path (`?` early-return, error, success, or cancel).
pub(crate) struct CancelGuard<'a> {
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
    /// Structured viewer effects (boxes/annotation) produced by tools during
    /// this turn. Persisted as their own column so the message `content`
    /// stays plain prose — the UI renders these from data, never by parsing
    /// fenced blocks back out of the text.
    pub effects: Option<serde_json::Value>,
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
    /// Audio/video only: token for the roommedia:// streaming protocol. The
    /// viewer plays `roommedia://localhost/<token>` (seekable, any size)
    /// instead of a base64 data URL, so large recordings stream instead of
    /// riding through IPC.
    pub media_token: Option<String>,
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

pub(crate) fn room_name_from_path(path: &str) -> String {
    std::path::Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Room".into())
}

pub(crate) fn info_of(app: &tauri::AppHandle, room: &Room) -> Result<RoomInfo, String> {
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
pub(crate) fn is_synced_path(path: &str) -> bool {
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
pub(crate) fn web_access_enabled(conn: &Connection) -> bool {
    matches!(
        db::get_setting(conn, "web_provider").as_deref(),
        Some("duckduckgo") | Some("searxng") | Some("brave")
    )
}

/// ADD-21: the "AI advisors" advanced tool is enabled for this room. Off by
/// default — while off, `consult_advisor` is not even offered to the model, so
/// the local model can never send a subtask off this Mac on its own.
pub(crate) fn advisors_enabled(conn: &Connection) -> bool {
    db::get_setting(conn, "advisors_enabled").as_deref() == Some("on")
}

/// ADD-21: sub-option — when the local model consults a Claude advisor, also
/// give that advisor the room's connected MCP tools over the room bridge. A
/// second, separate "content leaves this Mac" decision, so it has its own key.
pub(crate) fn advisor_tools_enabled(conn: &Connection) -> bool {
    db::get_setting(conn, "advisor_tools_enabled").as_deref() == Some("on")
}

/// D10 (the Closet): point Ollama at this room's saved remote base URL, or clear
/// any override when the room has none. Each room owns its own `remote_ollama_url`
/// setting, so switching rooms never carries the previous room's endpoint over.
pub(crate) fn apply_ollama_override(conn: &Connection) {
    let url = db::get_setting(conn, "remote_ollama_url").unwrap_or_default();
    let url = url.trim().to_string();
    ollama::set_base_url_override(if url.is_empty() { None } else { Some(url) });
}

/// Self-contained HTML pages staged for the in-app preview. The `roomdoc://`
/// custom protocol (registered in lib.rs) serves them so an interactive page
/// runs its own JS/CSS at an isolated origin, while a strict per-response CSP
/// blocks every network request — a real, offline "browser" for one document.
#[derive(Default)]
pub struct HtmlPreviews {
    pub map: Mutex<HashMap<String, String>>,
    pub next: AtomicU64,
}


#[cfg(test)]
/// ADD-13: give every chunk a toy 2-D embedding chosen by its text so the
/// blend is deterministic — "vacation" chunks point one way, others the
/// orthogonal way.
pub(crate) fn embed_chunks_by_keyword(conn: &Connection, keyword: &str) {
    for (id, _name, text) in db::chunks_missing_embedding(conn, 1000).unwrap() {
        let v = if text.to_lowercase().contains(keyword) {
            [1.0f32, 0.0]
        } else {
            [0.0f32, 1.0]
        };
        db::set_chunk_embedding(conn, &id, &db::embedding_to_blob(&v)).unwrap();
    }
}
