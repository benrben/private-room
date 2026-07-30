use crate::{db, extraction, mcp, ocr, ollama, recording, stt, web};
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
mod browse;
mod external;
mod providers;
mod rooms;
mod recent;
mod safety;
mod room_checkpoints;
mod files;
mod spreadsheet;
mod stt_cmds;
mod library;
mod search;
mod mcp_cmds;
mod mcp_oauth;
mod mcp_registry;
mod models;
mod vision;
mod chat;
mod retrieval;
mod agent;
mod edit_match;
mod edit_gate;
mod chat_commands;
mod docs_html;
mod json;
mod summarize;
mod studios;
mod moonshot;
mod media;
mod agent_ui;
mod ytdlp;
mod recording_cmds;
mod feedback;
mod jobs;
mod privacy;
mod scripts;
mod skills;
mod speech_cmds;

pub use browse::*;
pub use external::*;
pub use providers::*;
pub use rooms::*;
pub use recent::*;
pub use safety::*;
pub use room_checkpoints::*;
pub use files::*;
pub use spreadsheet::*;
pub use stt_cmds::*;
pub use library::*;
pub use search::*;
pub use mcp_cmds::*;
pub use mcp_registry::*;
pub use models::*;
pub use vision::*;
pub use chat::*;
pub(crate) use retrieval::*;
pub use agent::*;
pub(crate) use edit_match::*;
pub use edit_gate::*;
pub use chat_commands::*;
pub(crate) use docs_html::*;
pub(crate) use json::*;
pub(crate) use summarize::*;
pub use studios::*;
pub use moonshot::*;
pub use media::*;
pub use agent_ui::*;
pub use ytdlp::*;
pub use recording_cmds::*;
pub use feedback::*;
pub use jobs::*;
pub use privacy::*;
pub use scripts::*;
pub use skills::*;
pub use speech_cmds::*;

pub(crate) const DEFAULT_MODEL: &str = "qwen3.5:4b";
pub(crate) const MAX_CONTEXT_CHUNKS: usize = 6;
/// CHG-13: retrieval blends the keyword and vector signals with Reciprocal Rank
/// Fusion (scale-free), so no per-signal weight constants are needed.
/// ADD-13: widen the per-signal candidate pool before blending, so a strong
/// vector-only (synonym) chunk can surface above weak keyword hits.
pub(crate) const RETRIEVE_CANDIDATES: usize = MAX_CONTEXT_CHUNKS * 4;
pub(crate) const MAX_ATTACHED_IMAGES: usize = 4;
pub(crate) const MAX_HISTORY_MESSAGES: usize = 12;
/// The AGENT path's fetch bound, deliberately separate from
/// `MAX_HISTORY_MESSAGES`. 12 rows starved it: with the byte budget below, a
/// technical conversation kept only 3-8 messages. This is only a fetch bound —
/// `history_budget_bytes` decides what is actually sent.
///
/// NOT shared with the `#command` path: `format_history` there builds
/// oldest-first and clamps the HEAD, so raising its row count would hand those
/// flows the OLDEST 8 KB and silently drop the recent conversation.
pub(crate) const AGENT_HISTORY_MESSAGES: usize = 200;
/// Upper bound on the hand-off, and now the ONLY one — see
/// `history_budget_bytes` for the measurement that removed the rest.
/// Digesting is cheap but not free, and an unbounded transcript would make the
/// first turn of a years-old room pathological.
///
/// (The flat `MAX_HISTORY_CHARS = 12_000` that used to sit here was the
/// pre-compaction amputation limit. It was measured to cost the model every
/// fact it needed, and there is nothing left for it to be a floor of.)
pub(crate) const HISTORY_HANDOFF_MAX: usize = 200_000;

/// Bytes of conversation history handed to the engine for this model.
///
/// The flat 12,000 this replaces was tuned when the Ollama daemon's default
/// window was ~4,096 tokens (`llama-server -c 4096`), where 12,000 B ≈ 4,000
/// tokens was ~98% of the window — correctly sized for its time. The
/// payload-fitted `num_ctx` fix raised the real local ceiling to 65,536 /
/// 131,072 and the constant was never raised with it, so the engine was being
/// handed ~10% of what it could hold.
///
/// Measured 2026-07-28 (revision-tracking task, n=4 paired): at 12,000 B the
/// engine saw 0 of the 4 facts it needed. Raising the hand-off is only half the
/// fix — the sidecar then COMPACTS what it receives rather than truncating it
/// (`arcelle_sidecar/compaction.py`), which scored the same at 12 KB compacted
/// as at 176 KB raw, on 19x fewer prompt tokens.
///
/// Then measured again, and the intermediate value this replaces (49,152 B for
/// a local model) turned out to be the ceiling on the whole fix. Fraction of
/// the needed facts still present in the payload the model finally saw:
///
/// ```text
///   hand-off 49,152 B   0.56        hand-off whole conversation   1.00
/// ```
///
/// Paired, +0.44, 4 wins / 0 losses / 0 ties. The facts were not being lost by
/// the digest — they were amputated HERE, before the sidecar ever saw them, and
/// no amount of compressing what survives can bring back what was cut. (The
/// same run tested a rewritten digest prompt and it was WORSE, 0 wins / 1 loss
/// / 3 ties, so the prompt was left alone.)
///
/// So this is now simply "hand over the conversation". Truncating on the way
/// out made sense while the receiver would truncate again; it does not once the
/// receiver compresses. Every engine gets the same treatment because compaction
/// now covers all of them — local, `:cloud`, an OpenRouter provider, and a
/// cloud CLI. `HISTORY_HANDOFF_MAX` remains the backstop so the first turn of a
/// years-old room is not pathological.
pub(crate) fn history_budget_bytes(_model: &str) -> usize {
    HISTORY_HANDOFF_MAX
}
/// Injected persistent-memory budget (chars) and per-memory write cap.
pub(crate) const MAX_MEMORY_INJECT_CHARS: usize = 1_500;
pub(crate) const MAX_MEMORY_CONTENT_CHARS: usize = 500;
/// ADD-21: at most this many cloud-advisor consults per `ask`. A consult is a
/// slow, paid cloud call; one per turn keeps the local loop from flailing into
/// repeated exfiltration when it could just answer.
pub(crate) const MAX_ADVISOR_CALLS: u8 = 1;

pub(crate) const MCP_CONFIG_KEY: &str = "mcp_config";
/// Per-connector tool opt-outs: a JSON `{ "<server>": ["<tool>", …] }` of tool
/// names the user has turned OFF. Default (missing/empty) = every tool on, so
/// behavior matches pre-whitelist. Kept SEPARATE from `mcp_config` on purpose —
/// toggling a tool must not change the config fingerprint and re-trigger the
/// SEC-1 approval dialog.
pub(crate) const MCP_TOOL_PREFS_KEY: &str = "mcp_tool_prefs";
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
    /// "Auto mode" for connector tool calls (Connectors → Auto-approve).
    ///
    /// It opens TWO gates, and both belong in this doc because the pair is what
    /// makes it a real choice rather than a convenience:
    ///
    /// 1. `mcp_call_approved` returns true without emitting a consent card, so
    ///    an agent's `run_mcp_tool` calls never stall on a prompt nobody is
    ///    watching (a card left unanswered for 180s counts as a decline, which
    ///    read to the model — and the user — as "the connector tool fails every
    ///    time").
    /// 2. `exec_tool` skips the outbound remote-seam redaction, so a REMOTE
    ///    connector receives the room's real values (`masks_outbound_args`).
    ///    Masking rewrites the values the connector is asked ABOUT, which broke
    ///    the lookups outright; full approval means real arguments.
    ///
    /// Because (2) genuinely weakens what leaves the Mac, this defaults to OFF
    /// (`read_mcp_auto_approve`) and the Connectors copy states both effects.
    /// Loaded from disk at startup (`setup`) and persisted per-Mac like
    /// `mcp_approvals.json`, outside any room.
    pub mcp_auto_approve: Arc<AtomicBool>,
    /// Wave 2 (Idea 6): per-call diff-preview consent, mirroring `mcp_pending`.
    /// Holds the reply channel for each in-flight edit-approval request (keyed by
    /// request id); the frontend answers via `resolve_edit_approval`. Cleared on
    /// room close next to `mcp_pending` so a pending card can never outlive a room.
    pub edit_pending: Mutex<HashMap<String, tokio::sync::oneshot::Sender<EditDecision>>>,
    /// Wave 5 (Idea 13): per-run script consent, mirroring `mcp_pending`. Holds the
    /// reply channel for each in-flight script-run approval card (keyed by request
    /// id); the frontend answers via `resolve_script_run`. Cleared on room close so
    /// a pending card can never outlive a room.
    pub script_pending: Mutex<HashMap<String, tokio::sync::oneshot::Sender<McpDecision>>>,
    /// D9 (the Leash): the room's persistent MCP server, when the user has turned
    /// it on. Unlike the per-`ask` bridge in `run_external`, this one lives for as
    /// long as the room is open so an external CLI/agent can hold a session. It is
    /// stopped and cleared whenever the room locks/closes (see `close_room`) so a
    /// stale endpoint can never outlive a locked room.
    pub room_server: Mutex<Option<crate::room_mcp::Bridge>>,
    /// ADD-30: one cancel flag per in-flight background job, keyed by job id.
    /// `cancel_job` flips a flag; the runner sees it between waves, checkpoints,
    /// and parks the job as 'paused'. The entry is removed when the job ends.
    pub job_cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Wave 4a: the job QUEUE's single running slot. `None` = free; `Some(id)` =
    /// that job holds the one heavy-work slot (one resident local model makes
    /// concurrent heavy jobs strictly slower). `queue::submit`/`pump` reserve it;
    /// each job's terminal epilogue clears it (only when it equals its own id) and
    /// pumps the next queued row. A start-fresh process is empty (Default), and
    /// `quiesce_stale_jobs` reconciles the DB — so a crash never strands the slot.
    pub running_job: Mutex<Option<String>>,
    /// Wave 4a: generation stamp for the workflow scheduler tick loop (the
    /// backfill.rs pattern). Every room open bumps it and spawns one loop; a loop
    /// whose stamp is stale exits, so at most one scheduler is ever live.
    pub sched_generation: Arc<AtomicU64>,
    /// Wave 1b (idea 8): generation stamp for the debounced auto-index
    /// scheduler. Every ingest event bumps it and spawns one waiter carrying
    /// the new stamp; a waiter whose stamp is stale exits silently, so a
    /// multi-file drop coalesces into one indexing decision.
    pub auto_index_generation: Arc<std::sync::atomic::AtomicU64>,
    /// Wave 3 (Idea 9): bumped by `teardown_open_room` on every room close /
    /// rollback swap. Long-lived background writers that pin only by room path
    /// (OCR/STT lanes, summary filler, re-extract backfill, room summarize)
    /// capture this at spawn and re-check it before writing — a rollback leaves
    /// the path UNCHANGED, so the path pin alone would let a straggler land its
    /// write against the reopened, rolled-back DB. Generalizes the
    /// embed_generation pin to every path-pinned writer.
    pub room_epoch: Arc<AtomicU64>,
    /// Wave 3 (Idea 9): true while `rollback_room_checkpoint` is between the
    /// drain and the reopen. New asks/jobs/studios/recordings AND the room
    /// lifecycle commands (open/close/create) refuse while it is set, turning
    /// the drain + re-check from best-effort into real mutual exclusion; the
    /// same flag makes `delete_room_checkpoint` refuse mid-rollback.
    pub rollback_in_flight: Arc<AtomicBool>,
}

/// Wave 3 (Idea 9): the message every command entry point returns when a
/// rollback is in flight — the room is being swapped, so starting new work now
/// would either fail or land against the wrong DB.
pub(crate) const ROLLBACK_BUSY: &str = "The room is rolling back — try again in a moment.";

impl AppState {
    /// Run `f` with the open room held under the room lock, or return the standard
    /// `"No room is open."` error. Replaces the two-line
    /// `let guard = state.room.lock().unwrap(); let room = guard.as_ref().ok_or(...)?;`
    /// prelude that recurs across the command layer.
    ///
    /// The closure is SYNCHRONOUS by design: a `MutexGuard` is not `Send`, so it
    /// must never be held across an `.await`. This signature makes that a compile
    /// error rather than a latent bug — exactly the locked/unlocked discipline the
    /// async `ask`/`summarize`/chat paths already follow by hand. A site that needs
    /// to await must still lock a short sync section, drop it, then await; it keeps
    /// its explicit lock rather than using this helper.
    pub(crate) fn with_room<T>(
        &self,
        f: impl FnOnce(&Room) -> Result<T, String>,
    ) -> Result<T, String> {
        let guard = self.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        f(room)
    }

    /// Wave 3 (Idea 9): the current room epoch. A background writer captures
    /// this at spawn and re-checks `self.room_epoch() == captured` before its
    /// write, alongside the room-path pin.
    pub(crate) fn room_epoch(&self) -> u64 {
        self.room_epoch.load(Ordering::SeqCst)
    }

    /// Wave 3 (Idea 9): true while a checkpoint rollback is between drain and
    /// reopen. Command entry points return `ROLLBACK_BUSY` when set.
    pub(crate) fn rolling_back(&self) -> bool {
        self.rollback_in_flight.load(Ordering::SeqCst)
    }
}

/// The user's answer to a per-call MCP approval prompt.
#[derive(Clone, Copy)]
pub struct McpDecision {
    pub approved: bool,
    pub remember: bool,
}

/// Wave 2 (Idea 6): the user's answer to a diff-preview approval card.
/// `rest_of_turn` maps the "Apply for the rest of this answer" button — honored
/// only on the run-scoped LocalEngine sink (see `ToolEffects::run_scoped`).
#[derive(Clone, Copy)]
pub struct EditDecision {
    pub approved: bool,
    pub rest_of_turn: bool,
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

/// Idea 11: a saved version's extracted text next to the file's CURRENT text,
/// for the read-only side-by-side compare view. Text-only — v1 diffs extracted
/// text, never bytes (per the triage scope guard). Both sides are shaped by the
/// same `content_text` helper so a code/markdown diff isn't dominated by
/// representation noise. Either side is `None` when that kind has no comparable
/// text (image/binary), and the modal shows a "no text" message instead.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VersionContent {
    pub file_name: String,
    pub version_text: Option<String>,
    pub current_text: Option<String>,
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
    /// Marks a non-ordinary row without repurposing `role` — today only
    /// `Some("handoff")` (a context-compaction summary marker). `None` for
    /// every ordinary user/assistant message.
    pub kind: Option<String>,
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
    /// Wave 1b (idea 5): preference | fact | project | instruction, or None =
    /// uncategorized (every pre-category row). Organizational only in v1 —
    /// prompt injection stays content-only.
    pub category: Option<String>,
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

/// Settings → Online features "Test search": exercise the real search path
/// without the model, so a broken pipeline is visible immediately. The query is
/// fixed and dull on purpose — a word the built-in reference engines always have
/// an answer for, so a zero result means the pipeline, not the wording.
#[tauri::command]
pub async fn web_search_test(state: State<'_, AppState>) -> Result<String, String> {
    let enabled = state.with_room(|room| Ok(web_access_enabled(&room.conn)))?;
    if !enabled {
        return Err("Web access is off in this room — turn it on above and press Save \
                    first. (Each room has its own setting.)"
            .into());
    }
    let hits = web::search_web("wikipedia").await?;
    match hits.first() {
        // Individual engines drop out silently when they are blocked, so the
        // count is the honest signal of how much of the fusion answered.
        Some(hit) => Ok(format!(
            "Working ✓ — {} results. Top hit: {} ({})",
            hits.len(),
            hit.title,
            hit.snippet
        )),
        None => Err("Search ran, but every engine came back empty — you may be offline, \
                     or on a network they all block. Try again in a minute."
            .into()),
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

/// The web tools exist for the model only when the room's internet switch is on
/// (Settings → Online features). There is no provider to choose any more — the
/// app has exactly one search engine — so this is a plain on/off read.
///
/// `web_provider` keeps its name and its old values keep working: a room saved
/// when the switch was a provider dropdown holds "duckduckgo", "searxng" or
/// "brave", and every one of those meant "internet on", so they still do. Only
/// "off" (or never having chosen) is off. That IS the migration — there is no
/// rewrite step, and a room downgraded to an older build still reads as on.
pub(crate) fn web_access_enabled(conn: &Connection) -> bool {
    matches!(db::get_setting(conn, "web_provider").as_deref(), Some(v) if !v.is_empty() && v != "off")
}

/// The two web LANES a room may independently switch off (owner decision
/// 2026-07-30). Both ride under [`web_access_enabled`]: with no search provider
/// picked the room is offline and neither lane exists, whatever these say.
///
/// A lane being off removes that agent's tools from the served catalog, and
/// nothing else — which is the whole mechanism. The sidecar's
/// `worker_reachable` already requires a worker's box to intersect the served
/// catalog, so an off lane makes its agent unreachable, drops it out of the
/// `ask_web_agent` domain, and (if BOTH are off) removes the domain from the
/// Main agent's catalog entirely. No new special case anywhere.
///
/// Deliberately does NOT gate the user's own Browser area: `browse_lane` is
/// about the AGENT's access. `browse::require_web_enabled` — which the address
/// bar goes through — stays on the master switch (owner decision 2026-07-30).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct WebLanes {
    /// `web_search` + `fetch_page` — the Web agent (`chat.web`).
    pub search: bool,
    /// The six `browse_*` tools — the Browser agent (`chat.browse`).
    pub browse: bool,
}

impl Default for WebLanes {
    /// Both on — the pre-toggle behaviour. This is the DEFAULT rather than the
    /// derived all-false so that every `StartOpts { ..Default::default() }`
    /// caller keeps serving the full web catalog; a bridge that silently served
    /// no web tools would look exactly like a room that is offline.
    fn default() -> Self {
        Self::ALL
    }
}

impl WebLanes {
    /// Both on: what every room did before the toggles existed, and what an
    /// unset setting still means.
    pub(crate) const ALL: Self = Self { search: true, browse: true };

    /// Is this tool name gated by a lane that is currently off?
    pub(crate) fn blocks(self, name: &str) -> bool {
        if !self.search && matches!(name, "web_search" | "fetch_page") {
            return true;
        }
        if !self.browse && browse::is_browse_tool(name) {
            return true;
        }
        false
    }
}

/// Read this room's two web lanes. ABSENT MEANS ON — every room that existed
/// before the toggles keeps its current behaviour without a migration.
pub(crate) fn web_lanes(conn: &Connection) -> WebLanes {
    let on = |key: &str| db::get_setting(conn, key).as_deref() != Some("off");
    WebLanes {
        search: on("web_agent_search"),
        browse: on("web_agent_browse"),
    }
}

/// [`web_lanes`] for the currently open room. No room open → both on, matching
/// the unset-setting default; the bridge cannot serve room tools then anyway.
pub(crate) fn open_room_web_lanes(state: &AppState) -> WebLanes {
    let guard = state.room.lock().unwrap();
    guard
        .as_ref()
        .map(|room| web_lanes(&room.conn))
        .unwrap_or_default()
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
