use crate::{db, extraction, mcp, ocr, ollama, recording, stt, web};
use base64::Engine;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
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
/// Batch file operations (move / trash / restore / destroy a SET of files).
/// Shared by the Library's multi-selection and the File agent's organize tools
/// so the two can never behave differently — see the module header.
mod bulk;
/// The File agent's organize verbs (`organize_files`, `trash_files`,
/// `merge_files`) — built on `bulk` above, so an AI move and a human move are
/// the same operation with a different actor recorded.
mod organize;
mod spreadsheet;
mod stt_cmds;
mod library;
mod search;
mod mcp_cmds;
mod mcp_oauth;
mod mcp_registry;
// Download-on-first-use runtimes for local connectors (uv / node). Declared
// here is step 1 of the four this module's header lists; the other three are
// lib.rs's invoke_handler, mcp.rs's launcher PATH, and the ConnectorsView prompt.
mod runtimes;
mod models;
mod capabilities;
mod vision;
// The Create page's catalogue: which models can actually make a picture.
mod create;
/// The room's cast and shot lists — the Story tab behind the Create page.
mod story;
/// Cut a long script into a fixed number of shots, in plain code — no model,
/// nothing off the Mac, and no word can go missing.
mod shotsplit;
/// Read a character sheet the room already holds into people — so heroes that
/// are already written down are not typed in a second time. Also modelless.
mod castparse;
/// What each picture/video model will actually accept: legal lengths, sizes,
/// frame slots. Read from the provider, never guessed.
pub(crate) mod media_limits;
mod chat;
mod retrieval;
mod agent;
mod edit_match;
mod edit_gate;
mod chat_commands;
mod artifact;
mod docs_html;
mod json;
mod summarize;
mod studios;
mod moonshot;
mod docx_edit;
mod media;
mod video;
mod office;
mod peaks;
mod preview;
mod agent_ui;
mod ytdlp;
mod recording_cmds;
mod feedback;
mod jobs;
mod privacy;
mod scripts;
mod skills;
mod speech_cmds;
/// The ⌘Q door — the one exit no window close request ever reaches.
mod shell_exit;
/// Where the window was and how big, remembered between launches.
mod window_geometry;

pub use browse::*;
pub use external::*;
pub use providers::*;
pub use rooms::*;
pub use recent::*;
pub use safety::*;
pub use room_checkpoints::*;
pub use files::*;
pub use bulk::*;
pub use spreadsheet::*;
pub use stt_cmds::*;
pub use library::*;
pub use search::*;
pub use mcp_cmds::*;
pub use mcp_registry::*;
pub use runtimes::*;
pub use models::*;
pub use capabilities::*;
pub use vision::*;
pub use create::*;
pub use story::*;
pub use chat::*;
pub(crate) use retrieval::*;
pub use agent::*;
pub(crate) use edit_match::*;
pub use edit_gate::*;
pub use chat_commands::*;
pub(crate) use artifact::*;
pub(crate) use docs_html::*;
pub(crate) use json::*;
pub(crate) use summarize::*;
pub use studios::*;
pub use moonshot::*;
pub use docx_edit::*;
pub use media::*;
pub use video::*;
pub use office::*;
pub use peaks::*;
pub use preview::*;
pub use agent_ui::*;
pub use ytdlp::*;
pub use recording_cmds::*;
pub use feedback::*;
pub use jobs::*;
pub use privacy::*;
pub use scripts::*;
pub use skills::*;
pub use speech_cmds::*;
pub use shell_exit::*;
pub(crate) use window_geometry::{note_geometry, restore_geometry, save_geometry};

pub(crate) const DEFAULT_MODEL: &str = "qwen3.5:4b";
pub(crate) const MAX_CONTEXT_CHUNKS: usize = 6;
/// CHG-13: retrieval blends the keyword and vector signals with Reciprocal Rank
/// Fusion (scale-free), so no per-signal weight constants are needed.
/// ADD-13: widen the per-signal candidate pool before blending, so a strong
/// vector-only (synonym) chunk can surface above weak keyword hits.
pub(crate) const RETRIEVE_CANDIDATES: usize = MAX_CONTEXT_CHUNKS * 4;
pub(crate) const MAX_ATTACHED_IMAGES: usize = 4;
/// The hand-off's fetch bound (`handoff_chat`) — deliberately IDENTICAL to
/// `AGENT_HISTORY_MESSAGES`, not a smaller sibling of it.
///
/// It was 12 while an ordinary turn already read 200, and the marker a hand-off
/// writes is a hard cut-off: `db::recent_messages` starts every later turn at
/// the newest marker. So in a long conversation the recap summarized only the
/// last dozen messages and then made everything before them unreachable — no
/// warning, no undo. A recap has to cover at least as much as the turn it is
/// replacing.
pub(crate) const MAX_HISTORY_MESSAGES: usize = AGENT_HISTORY_MESSAGES;
/// The AGENT path's fetch bound. 12 rows starved it: with the byte budget
/// below, a technical conversation kept only 3-8 messages. This is only a fetch
/// bound — `history_budget_bytes` decides what is actually sent.
///
/// NOT shared with the `#command` path: those read the WHOLE conversation since
/// the last hand-off (`recent_messages(conn, chat, -1)`, SQLite's "no limit")
/// and window it at the point of use, because `#minutes` on a discussion has to
/// see all of it. (The note that used to sit here — that `format_history`
/// clamps the HEAD, so a bigger row count would hand those flows the oldest
/// 8 KB — described the pre-"full ops" behaviour; it clamps nothing now.)
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

/// The HAND-OFF's byte budget, which — unlike the agent path's — has to be
/// sized to the engine's own window.
///
/// The agent path can be engine-blind because the sidecar COMPACTS whatever it
/// receives, on every engine. `handoff_chat` has no such receiver: it flattens
/// the rows into one prompt and calls the one-shot `handoff_summary` gateway.
/// Local Ollama still fits that to `num_ctx` itself; a `:cloud` model, an
/// OpenRouter provider and a cloud CLI trim NOTHING, so once the hand-off's row
/// bound went from 12 to 200 a long technical chat could overflow the window and
/// return an engine error or an empty summary — at the exact moment the user
/// pressed the button to make the conversation smaller.
///
/// Two thirds of the window, converted at `token_usage::CHARS_PER_TOKEN` (3,
/// deliberately LOW, so this overstates tokens — the safe direction). The
/// remaining third carries the digest instruction and the recap the engine has
/// to have room to write. `HISTORY_HANDOFF_MAX` still caps it, so a huge window
/// does not make the first hand-off of a years-old room pathological.
pub(crate) fn handoff_budget_bytes(max_context: u32) -> usize {
    let usable = (max_context as usize / 3) * 2;
    (usable * crate::token_usage::CHARS_PER_TOKEN as usize).min(HISTORY_HANDOFF_MAX)
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
    /// The last unlock's "audio from an interrupted recording could not be
    /// restored" message, waiting for the workspace to collect it
    /// (`take_rec_recovery_error`). Parked rather than only emitted, because
    /// the unlock finishes long before anything is listening for the event —
    /// see `rooms::report_rec_recovery_failure`. `None` means nothing failed.
    pub rec_recovery_error: Mutex<Option<String>>,
    pub mcp: Mutex<mcp::Manager>,
    /// ADD-7: one cancel flag per in-flight `ask`, keyed by its `ask_id`.
    /// The entry is inserted when an ask starts and removed when it returns
    /// (success, error, or cancel). `cancel_ask` and `close_room` flip flags.
    pub cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Owner replacement #3: the same ids, arranged as a TREE (`crate::cancel`).
    /// `cancels` above says WHETHER an id is stopped; this says what that id
    /// STARTED, so cancelling a run reaches the studio build, job and file pass
    /// it spawned instead of leaving them writing artifacts into a room whose
    /// run the user has already stopped. Weak links: a child is owned by
    /// whatever runs it, so finished work prunes itself.
    pub cancel_tree: Mutex<HashMap<String, std::sync::Weak<crate::cancel::Node>>>,
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
    /// Connectors → "Run connector tools without asking".
    ///
    /// `mcp_call_approved` returns true without emitting a consent card, so an
    /// agent's `run_mcp_tool` calls never stall on a prompt nobody is watching
    /// (a card left unanswered for 180s counts as a decline, which read to the
    /// model — and the user — as "the connector tool fails every time").
    ///
    /// This flag decides WHO PRESSES THE BUTTON and nothing else. It used to
    /// carry a second power — unmasking outbound arguments — because the fix for
    /// silently-redacted args (2026-07-24) was folded into the same switch. The
    /// owner split them (2026-08-03): "run this without asking me" and "send
    /// this the user's real data" are different risks, so they are now
    /// `mcp_outbound_unmask` and this, independent and both OFF by default.
    /// Loaded from disk at startup (`setup`) and persisted per-Mac like
    /// `mcp_approvals.json`, outside any room.
    pub mcp_auto_approve: Arc<AtomicBool>,
    /// Connectors → "Send remote connectors real values".
    ///
    /// `exec_tool` skips the outbound remote-seam redaction, so a REMOTE
    /// connector receives the room's real values (`masks_outbound_args`).
    /// Masking rewrites the values the connector is asked ABOUT, which broke
    /// lookups outright — a room whose entity map holds "NVDA" asked the server
    /// about `[Person A]` and got nothing back. Turning this on is the cure, and
    /// it is the half that genuinely weakens what leaves the Mac, which is why
    /// it is its own switch and defaults to OFF (`read_mcp_outbound_unmask`).
    ///
    /// Independent of `mcp_auto_approve` in both directions: unmasked + still
    /// asking shows the user the REAL arguments on the card before they leave;
    /// auto-approved + still masked runs unattended with placeholders.
    pub mcp_outbound_unmask: Arc<AtomicBool>,
    /// Connectors → the per-connector answers that OVERRIDE the two switches
    /// above, keyed by server name (owner's decision, 2026-08-03: "split
    /// connector auto-approve from outbound unmasking; both default off" — per
    /// connector). A connector with no entry, or an entry with no answer for
    /// that power, inherits the Mac-wide switch, so an install upgrading from
    /// the global-only pair keeps exactly the behaviour it had and this map
    /// starts empty. Both seams resolve through `auto_approve_for` /
    /// `outbound_unmask_for`, which are the only places the two levels combine.
    /// Loaded at startup from `mcp_connector_powers.json` and persisted there,
    /// per-Mac and outside any room like the rest of the consent state.
    pub mcp_connector_powers: Mutex<std::collections::BTreeMap<String, ConnectorOverride>>,
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
        let guard = self.room_guard();
        let room = guard.as_ref().ok_or("No room is open.")?;
        // Every room read and write in the app comes through here, which makes
        // it the one place a storage failure can be explained once. See
        // `humanize_storage_error` — it rewrites only what it can evidence.
        f(room).map_err(|e| humanize_storage_error(&e, &room.path))
    }

    /// The open-room lock, surviving a poisoned mutex.
    ///
    /// Every command that touches the room passes through this one gate, and
    /// Rust marks a mutex POISONED for the rest of the process if any thread
    /// panics while holding it. `lock().unwrap()` then panics in turn — so one
    /// internal panic anywhere under the room lock turned every later room
    /// action into a panic, forever: the window stayed up, nothing worked, and
    /// nothing explained why. There is no recovery code and no restart prompt.
    ///
    /// The data behind this lock is an `Option<Room>` — a handle, not a
    /// multi-step invariant that a panic could leave half-updated — so taking
    /// the guard back (`into_inner`) is honest here rather than papering over a
    /// broken state. The panic itself is still a bug; it is just no longer a
    /// dead app.
    pub(crate) fn room_guard(&self) -> std::sync::MutexGuard<'_, Option<Room>> {
        self.room.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
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
        // Owner replacement #3: the tree entry goes with it, so a later run that
        // reuses nothing but the id cannot be handed a finished run's children.
        crate::cancel::forget(self.state, &self.ask_id);
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
    /// ART-1: what produced this version's content — run id, agent/tool, source
    /// file ids. `None` means nobody recorded it (an older room, a person's own
    /// save), which the History strip shows as no attribution at all rather
    /// than crediting the AI for something it may not have written.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<crate::db::Provenance>,
    /// The user asked to KEEP this one: it is outside the rolling window the
    /// room prunes on every save (`db::VERSIONS_KEPT`).
    pub pinned: bool,
    /// Size of this snapshot's stored bytes. Every version is a whole copy of
    /// the file, so the History strip can show what history actually costs
    /// instead of leaving it to be discovered as a bigger room file.
    pub bytes: i64,
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
    /// True when nothing is at `path` any more — the file was moved, deleted,
    /// or sits on a drive that isn't plugged in. Recomputed by `list_recent` on
    /// every read; the copy that lands in recent.json is only ever a stale
    /// cache, never the answer.
    #[serde(default)]
    pub missing: bool,
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
    /// BROWSE-2/BROWSE-3: the address this file arrived from, or None for
    /// anything that came off this Mac. Lets a file row say "from boi.org.il"
    /// instead of leaving provenance buried in the Markdown body.
    pub origin_url: Option<String>,
    /// The cached one-liner from `summarize_one_liner` (files.ai_summary) —
    /// "describe a single file in ONE short, factual sentence", written by the
    /// auto-index filler/job when "Describe new files automatically" is on
    /// (see auto_index.rs), or by a manual Summarize-room run. None until that
    /// has run for this file, or for a file with no extracted text to describe.
    /// This column existed and was populated long before any UI read it —
    /// same shape as `origin_url` above.
    pub ai_summary: Option<String>,
}

/// Trash: one deleted file, as the trash view shows it. Deliberately NOT a
/// `FileMeta` — a trashed file is not a file in the room, and handing the UI the
/// same shape invites it to be rendered in a list that is supposed to be
/// "what's here". Carries no content: name and size are metadata, the bytes
/// stay in the room and are only ever read again by a restore.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrashedFile {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size_bytes: i64,
    /// When it was deleted (room-local ISO-8601, same clock as `created_at`).
    pub trashed_at: String,
    /// WHAT deleted it: `user` | `agent` | `app`. Never blank — an unknown
    /// actor reads as `unknown`, which is a claim we can stand behind, rather
    /// than being quietly attributed to the person.
    pub trashed_by: String,
    /// WHICH one, when the kind alone isn't the answer: the agent/tool name for
    /// an `agent` delete, the command for an `app` one. None = not recorded.
    pub trashed_by_id: Option<String>,
    /// ADD-16: the folder it will go back to on restore, or None for top level.
    pub folder_id: Option<String>,
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
    /// Video only: what the container says it is (duration, display size,
    /// codec, frame rate, audio track), if it has ever been probed. None means
    /// "not probed yet" — the viewer asks for a probe rather than showing
    /// zeros, and every field inside is independently unknown-able.
    pub media_meta: Option<crate::media_probe::MediaMeta>,
    /// Saved web pages only: what the page declared about itself (site, author,
    /// publication date, language) plus where and when the room saved it. None
    /// means this file did not come from a web page — and a field the page
    /// never declared is simply absent, so the viewer's provenance strip can
    /// only ever show what was actually there.
    pub web_meta: Option<crate::extraction::PageMeta>,
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
    /// Is Ollama being reached on ANOTHER computer (the Closet override)? A
    /// model name cannot carry this, and the trust chip is derived from the
    /// name — so a room relaying `qwen3.5:4b` to a LAN box read "Local only —
    /// nothing leaves the device". The UI ORs this into its cloud test.
    pub remote_relay: bool,
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
    let page = web::search_web("wikipedia").await?;
    // A diagnostic that hides which engines are down is not a diagnostic. The
    // fan-out reports them by name, so name them: "Working ✓" while two of seven
    // engines are 403ing is how a degraded search goes unnoticed for weeks.
    let blocked = match page.failed.as_slice() {
        [] => String::new(),
        names => format!(" Blocked right now: {}.", web::join_names(names)),
    };
    match page.hits.first() {
        Some(hit) => Ok(format!(
            "Working ✓ — {} results. Top hit: {} (found by {}).{blocked}",
            page.hits.len(),
            hit.title,
            match hit.engines.len() {
                0 => "no engine".to_string(),
                1 => hit.source().to_string(),
                n => format!("{n} engines"),
            }
        )),
        None if !page.failed.is_empty() => Err(format!(
            "Search did not run — {} could not be reached (blocked, rate limited or too \
             slow). Try again in a minute.",
            web::join_names(&page.failed)
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

/// Folders directly under the home directory that a sync client creates by
/// default. `Library/CloudStorage/` covers the modern File-Provider clients
/// (Dropbox, Google Drive, OneDrive, Box); these are the ones that still sync a
/// plain home folder, including the clients that never used a File Provider at
/// all (Syncthing, Resilio, pCloud, Nextcloud).
pub(crate) const SYNCED_HOME_FOLDERS: &[&str] = &[
    "Dropbox",
    "Google Drive",
    "OneDrive",
    "Box",
    "Box Sync",
    "Sync", // Syncthing's default folder, and Sync.com
    "Resilio Sync",
    "BTSync",
    "pCloud Drive",
    "pCloudDrive",
    "Nextcloud",
    "ownCloud",
    "Seafile",
    "MEGA",
    "MEGAsync",
    "Tresorit",
    "Yandex.Disk",
    "Creative Cloud Files",
];

/// Say what a storage failure MEANS, in words that name a remedy.
///
/// A room lives wherever the user put it: an external disk, a USB stick, a
/// network share, a nearly-full boot volume. When that volume disappears
/// mid-session or fills up, every save and every background job starts failing
/// and what reached the user was the engine's own text — "disk I/O error",
/// "attempt to write a readonly database", "database or disk is full". None of
/// those names a cause, and none of them says what to do about it.
///
/// EVIDENCE, NOT GUESSWORK. The "your drive is gone" wording is used only after
/// checking that the room file really has stopped existing; anything this
/// cannot recognize is passed through completely unchanged, because a confident
/// wrong diagnosis is worse than jargon. The original message is kept in
/// brackets either way — it is what a bug report needs.
///
/// The room's PATH is deliberately not quoted here: an error string can end up
/// as a tool result, and a room's file name is room content.
pub(crate) fn humanize_storage_error(err: &str, room_path: &str) -> String {
    let lower = err.to_lowercase();
    let is_storage = lower.contains("disk i/o error")
        || lower.contains("database or disk is full")
        || lower.contains("readonly database")
        || lower.contains("unable to open database")
        || lower.contains("no space left")
        // std::io::Error always prints these as "… (os error N)", so the
        // closing paren is what makes the number a WHOLE number. Matching the
        // bare "os error 2" also swallowed 20-29 — "Invalid argument (os error
        // 22)" and "Too many open files (os error 24)" would have been reported
        // to the user as a disconnected drive, which is the confident wrong
        // diagnosis the rest of this function exists to avoid.
        || lower.contains("os error 28)") // ENOSPC
        || lower.contains("os error 2)"); // ENOENT — the volume went away
    if !is_storage {
        return err.to_string();
    }
    if !std::path::Path::new(room_path).exists() {
        return format!(
            "This room's file can't be reached any more — the drive or folder holding it has \
             gone away. Reconnect it and try again; nothing else was changed. [{err}]"
        );
    }
    if lower.contains("full") || lower.contains("no space left") || lower.contains("os error 28") {
        return format!(
            "The disk holding this room is full, so nothing could be saved. Free some space \
             and try again. [{err}]"
        );
    }
    format!(
        "This room's file couldn't be read or written just now — the drive holding it may be \
         disconnected, full, or read-only. [{err}]"
    )
}

/// Is `rest` (a path relative to the home directory) inside this sync folder?
///
/// The trailing separator matters: `Dropboxes/room` is not in Dropbox, and the
/// room file is always INSIDE one of these.
///
/// The ` (…)` branch is Dropbox Business and second linked accounts, which name
/// the folder `Dropbox (Personal)` / `Dropbox (Work)` / `Dropbox (Acme Inc)`
/// whenever the install predates the macOS File Provider. An exact-name test
/// left every one of those rooms with no sync warning at all — the layout where
/// the mix of databases and file sync is MOST likely, since it is the older
/// client. (Modern installs land under `Library/CloudStorage/`, checked above.)
fn in_home_sync_folder(rest: &str, folder: &str) -> bool {
    let Some(tail) = rest.strip_prefix(folder) else {
        return false;
    };
    tail.starts_with('/') || (tail.starts_with(" (") && tail.contains(")/"))
}

/// True when the room file lives under a known cloud-sync root — databases and
/// file sync are a dangerous mix, so the UI warns once (HLT-6). Covers iCloud
/// (`Library/Mobile Documents`), modern `Library/CloudStorage/` (Dropbox,
/// Google Drive, OneDrive, Box), and the plain home folders in
/// [`SYNCED_HOME_FOLDERS`] — which used to be `~/Dropbox` alone, so a room in
/// `~/Sync` (Syncthing) or `~/pCloudDrive` was silently unwarned.
pub(crate) fn is_synced_path(path: &str) -> bool {
    if path.contains("Library/Mobile Documents") || path.contains("Library/CloudStorage/") {
        return true;
    }
    if let Ok(home) = std::env::var("HOME") {
        let home = home.trim_end_matches('/');
        if !home.is_empty() {
            if let Some(rest) = path.strip_prefix(&format!("{home}/")) {
                return SYNCED_HOME_FOLDERS
                    .iter()
                    .any(|folder| in_home_sync_folder(rest, folder));
            }
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

/// What the room says when its internet switch is off and something tried to
/// reach the network anyway. One string so every inlet refuses in the same
/// words and the user is told where the switch is.
pub(crate) const WEB_OFF_MESSAGE: &str =
    "This room is offline. Turn on Settings → Online features to fetch from the internet.";

/// [`web_access_enabled`] as a REFUSAL, for the inlets a PERSON drives.
///
/// The model's web tools have always been gated at the served catalog, but the
/// user-facing ones — Add → Web link, the video import, the download job —
/// reached the internet with the switch off. A room whose settings read "Off —
/// room stays offline" that still fetches a page on a click is making a false
/// privacy claim, which is the same reason `browse::require_web_enabled` exists
/// for the address bar. Same posture, applied to the remaining three inlets.
pub(crate) fn require_web_access(state: &AppState) -> Result<(), String> {
    let on = state.with_room(|room| Ok(web_access_enabled(&room.conn)))?;
    if on {
        Ok(())
    } else {
        Err(WEB_OFF_MESSAGE.into())
    }
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
    /// The `browse_*` tools — the Browser agent (`chat.browse`).
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
        // The download verbs ride with search because the Web agent is where
        // they are boxed — see `DOWNLOAD_TOOL_NAMES`. Without them here, "Web
        // agent off" left saving a link, downloading a file and downloading a
        // video all still reachable, and the agent still reachable with them.
        if !self.search
            && (matches!(name, "web_search" | "fetch_page")
                || DOWNLOAD_TOOL_NAMES.contains(&name))
        {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_warning_covers_more_than_dropbox_and_icloud() {
        // HLT-6 warned about iCloud, CloudStorage and ~/Dropbox only, so a room
        // in Syncthing's or pCloud's folder got no warning at all.
        assert!(is_synced_path("/Users/x/Library/Mobile Documents/room.roomai"));
        assert!(is_synced_path("/Users/x/Library/CloudStorage/Dropbox/room.roomai"));
        let home = std::env::var("HOME").expect("HOME is set on macOS");
        for folder in ["Dropbox", "Sync", "pCloudDrive", "Resilio Sync", "Nextcloud"] {
            let path = format!("{home}/{folder}/room.roomai");
            assert!(is_synced_path(&path), "{path} must warn");
        }
        // A folder that merely starts with a sync folder's name does not.
        assert!(!is_synced_path(&format!("{home}/Dropboxes/room.roomai")));
        assert!(!is_synced_path(&format!("{home}/Documents/room.roomai")));
    }

    #[test]
    fn a_storage_failure_says_what_happened_and_what_to_do() {
        // The room file is gone (its drive was unplugged): the message has to
        // name the drive, not the database.
        let missing = "/Volumes/Nope/room.arcelle";
        let gone = humanize_storage_error("disk I/O error", missing);
        assert!(gone.contains("drive or folder holding it has gone away"), "{gone}");
        // The engine's own words survive for a bug report...
        assert!(gone.contains("disk I/O error"), "{gone}");
        // ...and the room's own file name never appears — an error string can
        // become a tool result, and a file name is room content.
        assert!(!gone.contains("room.arcelle"), "{gone}");

        // A full disk is a different remedy, and the file is still there.
        let here = std::env::current_exe().unwrap().to_string_lossy().into_owned();
        let full = humanize_storage_error("database or disk is full", &here);
        assert!(full.contains("full"), "{full}");
        assert!(full.contains("Free some space"), "{full}");
    }

    #[test]
    fn an_ordinary_error_is_passed_through_untouched() {
        // Only what can be evidenced is rewritten: a confident wrong diagnosis
        // is worse than the jargon it replaces.
        for msg in ["No room is open.", "That file is not in this room.", "cancelled"] {
            assert_eq!(humanize_storage_error(msg, "/nonexistent/room.arcelle"), msg);
        }
        // …including the errno neighbours of ENOENT. `os error 2` as a bare
        // SUBSTRING also matched 20-29, so an unrelated failure was announced
        // as an unplugged drive — with the room's file conveniently "gone",
        // since these paths do not exist.
        for msg in [
            "Invalid argument (os error 22)",
            "Too many open files (os error 24)",
            "Is a directory (os error 21)",
        ] {
            assert_eq!(
                humanize_storage_error(msg, "/nonexistent/room.arcelle"),
                msg,
                "an unrelated errno was diagnosed as a storage failure",
            );
        }
        // The two that ARE storage still land, in their full "(os error N)" form.
        for msg in ["No such file or directory (os error 2)", "write failed (os error 28)"] {
            assert_ne!(humanize_storage_error(msg, "/nonexistent/room.arcelle"), msg, "{msg}");
        }
    }

    #[test]
    fn a_legacy_dual_account_dropbox_folder_still_warns() {
        // Dropbox Business / a second linked account names the folder
        // "Dropbox (Personal)" or "Dropbox (Work)" on pre-File-Provider
        // installs. An exact "Dropbox/" test reported synced = false for every
        // room in one — no warning at all, on the OLDER client.
        let home = std::env::var("HOME").expect("HOME is set on macOS");
        for folder in ["Dropbox (Personal)", "Dropbox (Work)", "Dropbox (Acme Inc)"] {
            let path = format!("{home}/{folder}/room.arcelle");
            assert!(is_synced_path(&path), "{path} must warn");
        }
        // Still not a match on the name alone — the room has to be INSIDE it.
        assert!(!is_synced_path(&format!("{home}/Dropbox (Work)")));
        assert!(!is_synced_path(&format!("{home}/Dropbox Notes/room.arcelle")));
    }

    #[test]
    fn the_hand_off_reads_as_much_as_an_ordinary_turn() {
        // A hand-off's marker is a hard cut-off for every later turn, so a
        // recap that saw fewer messages than a turn does silently drops the
        // rest of the conversation for good. It used to read 12 against 200.
        assert!(MAX_HISTORY_MESSAGES >= AGENT_HISTORY_MESSAGES);
        assert!(MAX_HISTORY_MESSAGES > 12);
    }
}
