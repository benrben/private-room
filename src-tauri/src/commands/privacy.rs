//! PRIV-1/PRIV-2: the privacy gatekeeper — Rust half.
//!
//! The principle (mirrored in the sidecar's `privacy.py`): the moment content
//! leaves for a NON-LOCAL model it passes a MECHANICAL door — protected strings
//! are replaced by stable placeholders, answers are restored on the way back —
//! and the AI judgment about *what* is private happens ahead of time (the local
//! import-time scanner), where its findings are stored, visible, and fixable.
//!
//! This module owns:
//! * the room's resolved policy, cached so every sidecar request body and the
//!   external-CLI path can consult it without re-reading the DB;
//! * the mechanical redact/restore engine (aho-corasick, ASCII-case-insensitive
//!   — Hebrew has no case, so exact matching there is already right);
//! * the tauri commands behind the Settings section, the reader's cloud view,
//!   and the chat valve;
//! * the background scan runner that keeps per-file scan state fresh.

use super::*;
use aho_corasick::{AhoCorasick, AhoCorasickBuilder, MatchKind};
use sha2::Digest;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};

/// Room settings keys.
const KEY_SWITCH: &str = "cloud_privacy"; // "on" | "off"; absent = global default
const KEY_CONCEPTS: &str = "cloud_privacy_concepts"; // JSON array of strings

/// Bump when the scanner's behavior changes enough that old scans are stale.
const SCANNER_VERSION: &str = "v1";

// ---------------------------------------------------------------------------
// Mechanics
// ---------------------------------------------------------------------------

/// What the door did on one turn — feeds the chat indicator.
#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyReport {
    pub entities_hidden: usize,
    pub replacements: usize,
    pub images_blocked: usize,
}

/// The compiled redact/restore engine over the room's entity map.
pub(crate) struct Redactor {
    /// (real, placeholder), longest real first (index-aligned with `ac`).
    rules: Vec<(String, String)>,
    ac: Option<AhoCorasick>,
    /// placeholder -> real (index-aligned with `restore_ac`).
    restore: Vec<(String, String)>,
    restore_ac: Option<AhoCorasick>,
}

fn build_ac(patterns: &[String]) -> Option<AhoCorasick> {
    if patterns.is_empty() {
        return None;
    }
    AhoCorasickBuilder::new()
        .ascii_case_insensitive(true)
        .match_kind(MatchKind::LeftmostLongest)
        .build(patterns)
        .ok()
}

impl Redactor {
    pub(crate) fn new(mut rules: Vec<(String, String)>) -> Self {
        rules.retain(|(r, p)| r.trim().len() >= 2 && !p.trim().is_empty());
        rules.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
        let ac = build_ac(&rules.iter().map(|(r, _)| r.clone()).collect::<Vec<_>>());
        let mut restore: Vec<(String, String)> =
            rules.iter().map(|(r, p)| (p.clone(), r.clone())).collect();
        restore.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
        let restore_ac = build_ac(&restore.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>());
        Redactor { rules, ac, restore, restore_ac }
    }

    fn sub(
        ac: &Option<AhoCorasick>,
        table: &[(String, String)],
        text: &str,
        report: Option<&mut PrivacyReport>,
    ) -> String {
        let Some(ac) = ac else { return text.to_string() };
        let mut out = String::with_capacity(text.len());
        let mut last = 0;
        let mut seen: std::collections::HashSet<usize> = std::collections::HashSet::new();
        let mut replacements = 0usize;
        for m in ac.find_iter(text) {
            out.push_str(&text[last..m.start()]);
            out.push_str(&table[m.pattern().as_usize()].1);
            last = m.end();
            replacements += 1;
            seen.insert(m.pattern().as_usize());
        }
        out.push_str(&text[last..]);
        if let Some(r) = report {
            r.replacements += replacements;
            r.entities_hidden += seen.len();
        }
        out
    }

    /// real → placeholder (counted).
    pub(crate) fn redact(&self, text: &str, report: &mut PrivacyReport) -> String {
        Self::sub(&self.ac, &self.rules, text, Some(report))
    }

    /// placeholder → real.
    pub(crate) fn restore(&self, text: &str) -> String {
        Self::sub(&self.restore_ac, &self.restore, text, None)
    }

    /// Restore placeholders anywhere in a JSON value (cloud tool-call args:
    /// the CLI asks to search "[Person A]", the room tool must see the name).
    pub(crate) fn restore_value(&self, v: &serde_json::Value) -> serde_json::Value {
        match v {
            serde_json::Value::String(s) => serde_json::Value::String(self.restore(s)),
            serde_json::Value::Array(a) => {
                serde_json::Value::Array(a.iter().map(|x| self.restore_value(x)).collect())
            }
            serde_json::Value::Object(o) => serde_json::Value::Object(
                o.iter().map(|(k, x)| (k.clone(), self.restore_value(x))).collect(),
            ),
            other => other.clone(),
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }
}

// ---------------------------------------------------------------------------
// The cached room policy
// ---------------------------------------------------------------------------

pub(crate) struct PolicyState {
    /// The switch, fully resolved (room override, else global default).
    pub(crate) active: bool,
    pub(crate) rules: Vec<(String, String)>,
    pub(crate) concepts: Vec<String>,
    /// A LOCAL model for the sidecar's live guard + the scanner.
    pub(crate) guard_model: String,
    pub(crate) redactor: Redactor,
}

impl PolicyState {
    /// The wire payload the sidecar's `policy_from_payload` parses.
    pub(crate) fn payload(&self) -> serde_json::Value {
        serde_json::json!({
            "active": self.active,
            "rules": self.rules.iter().map(|(r, p)| serde_json::json!({
                "real": r, "placeholder": p
            })).collect::<Vec<_>>(),
            "concepts": self.concepts,
            "guard_model": self.guard_model,
        })
    }
}

fn policy_cell() -> &'static StdMutex<Option<Arc<PolicyState>>> {
    static CELL: OnceLock<StdMutex<Option<Arc<PolicyState>>>> = OnceLock::new();
    CELL.get_or_init(|| StdMutex::new(None))
}

/// The current policy when it is ACTIVE (switch on) — the enforcement getter.
pub(crate) fn active_policy() -> Option<Arc<PolicyState>> {
    policy_cell()
        .lock()
        .unwrap()
        .clone()
        .filter(|p| p.active && !p.redactor.is_empty())
}

/// Room closed: no policy may outlive the room (teardown invariant).
pub(crate) fn clear_policy() {
    *policy_cell().lock().unwrap() = None;
}

fn parse_concepts(raw: Option<String>) -> Vec<String> {
    raw.and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect()
}

/// Global default for rooms with no explicit switch: a tiny JSON in the app
/// data dir (outside any room — it must exist before a room is open). Absent
/// file = ON: privacy is the default, turning it off is the explicit act.
fn global_default_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path().app_data_dir().ok().map(|d| d.join("privacy.json"))
}

pub(crate) fn global_default_on(app: &tauri::AppHandle) -> bool {
    let Some(p) = global_default_path(app) else { return true };
    match std::fs::read_to_string(p) {
        Ok(s) => serde_json::from_str::<serde_json::Value>(&s)
            .ok()
            .and_then(|v| v.get("defaultOn").and_then(|b| b.as_bool()))
            .unwrap_or(true),
        Err(_) => true,
    }
}

fn set_global_default(app: &tauri::AppHandle, on: bool) -> Result<(), String> {
    let p = global_default_path(app).ok_or("no app data dir")?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, serde_json::json!({ "defaultOn": on }).to_string())
        .map_err(|e| e.to_string())
}

/// Recompute the cached policy from the open room + the global default. Call
/// after room open, any privacy-settings change, and any entity-map change.
pub(crate) fn refresh_policy(app: &tauri::AppHandle, state: &AppState) {
    let computed = compute_policy(app, state);
    *policy_cell().lock().unwrap() = computed.map(Arc::new);
}

fn compute_policy(app: &tauri::AppHandle, state: &AppState) -> Option<PolicyState> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref()?;
    let switch = db::get_setting(&room.conn, KEY_SWITCH);
    let active = match switch.as_deref() {
        Some("off") => false,
        Some("on") => true,
        _ => global_default_on(app),
    };
    let entities = db::list_privacy_entities(&room.conn).ok()?;
    let rules: Vec<(String, String)> = entities
        .iter()
        .filter(|e| e.source != "dismissed")
        .map(|e| (e.real_text.clone(), e.placeholder.clone()))
        .collect();
    let concepts = parse_concepts(db::get_setting(&room.conn, KEY_CONCEPTS));
    // The live guard + scanner need a model that runs ON THIS MAC. The room's
    // chosen model qualifies only when local; otherwise the tuned default.
    let room_model = model_setting(&room.conn).unwrap_or_default();
    let guard_model = if !room_model.is_empty()
        && !is_external_engine(&room_model)
        && !is_cloud_model(&room_model)
        && !is_embedding_model(&room_model)
    {
        room_model
    } else {
        DEFAULT_MODEL.to_string()
    };
    Some(PolicyState {
        active,
        redactor: Redactor::new(rules.clone()),
        rules,
        concepts,
        guard_model,
    })
}

/// Attach the room policy to a sidecar request body when its `model` is
/// non-local and the door is on. The ONE Rust-side injection point — every
/// sidecar POST passes through here (see `sidecar.rs`).
pub(crate) fn inject_policy(body: &serde_json::Value) -> Option<serde_json::Value> {
    let model = body.get("model").and_then(|m| m.as_str())?;
    if !(is_cloud_model(model) || is_external_engine(model)) {
        return None;
    }
    if body.get("privacy").is_some() {
        return None; // caller already decided (e.g. an explicit bypass)
    }
    let policy = active_policy()?;
    let mut out = body.clone();
    out.as_object_mut()?
        .insert("privacy".to_string(), policy.payload());
    Some(out)
}

/// sha256 hex of the scan-relevant rule state: concepts + scanner version.
/// Entity-map changes deliberately do NOT stale scans — new block-list items
/// enforce mechanically without re-reading any document.
fn rules_sha(concepts: &[String]) -> String {
    let mut sorted: Vec<&String> = concepts.iter().collect();
    sorted.sort();
    let joined = format!(
        "{SCANNER_VERSION}|{}",
        sorted.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\u{1f}")
    );
    hex_sha(joined.as_bytes())
}

fn hex_sha(bytes: &[u8]) -> String {
    let mut h = sha2::Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyStatus {
    pub global_default_on: bool,
    /// The room's explicit override: "on" | "off" | null (= follow global).
    pub room_setting: Option<String>,
    pub effective_on: bool,
    pub entities: Vec<db::PrivacyEntity>,
    pub concepts: Vec<String>,
    /// Files whose scan is missing or stale under the current rules.
    pub pending_files: usize,
    pub scanning: bool,
}

#[tauri::command]
pub async fn privacy_status(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<PrivacyStatus, String> {
    let global_on = global_default_on(&app);
    state.with_room(|room| {
        let switch = db::get_setting(&room.conn, KEY_SWITCH);
        let effective = match switch.as_deref() {
            Some("off") => false,
            Some("on") => true,
            _ => global_on,
        };
        let concepts = parse_concepts(db::get_setting(&room.conn, KEY_CONCEPTS));
        let entities: Vec<db::PrivacyEntity> = db::list_privacy_entities(&room.conn)?
            .into_iter()
            .filter(|e| e.source != "dismissed")
            .collect();
        let pending = db::files_needing_privacy_scan(&room.conn, &rules_sha(&concepts))?.len();
        Ok(PrivacyStatus {
            global_default_on: global_on,
            room_setting: switch,
            effective_on: effective,
            entities,
            concepts,
            pending_files: pending,
            scanning: scan_running(),
        })
    })
}

/// The room switch: "on" | "off" | "default" (drop the override).
#[tauri::command]
pub async fn set_privacy_room(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    mode: String,
) -> Result<(), String> {
    state.with_room(|room| match mode.as_str() {
        "on" | "off" => db::set_setting(&room.conn, KEY_SWITCH, &mode),
        "default" => {
            let _ = room
                .conn
                .execute("DELETE FROM settings WHERE key = ?1", [KEY_SWITCH]);
            Ok(())
        }
        other => Err(format!("unknown privacy mode: {other}")),
    })?;
    refresh_policy(&app, &state);
    if active_policy().is_some() || policy_cell().lock().unwrap().as_ref().map_or(false, |p| p.active)
    {
        schedule_privacy_scan(app);
    }
    Ok(())
}

#[tauri::command]
pub async fn set_privacy_global(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    on: bool,
) -> Result<(), String> {
    set_global_default(&app, on)?;
    refresh_policy(&app, &state);
    if on {
        schedule_privacy_scan(app);
    }
    Ok(())
}

/// Add one explicit block-list item (source 'user' — iron-clad, enforced
/// mechanically on every outbound request from now on; no re-scan needed).
#[tauri::command]
pub async fn add_privacy_block(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    text: String,
    category: String,
) -> Result<db::PrivacyEntity, String> {
    let cat = match category.as_str() {
        "person" | "address" | "phone" | "email" | "id" | "org" => category.as_str(),
        _ => "concept",
    };
    let entity = state.with_room(|room| db::add_privacy_entity(&room.conn, &text, cat, "user"))?;
    refresh_policy(&app, &state);
    Ok(entity)
}

/// Remove an entity. A user block-list row is deleted outright; a scan finding
/// becomes a tombstone so the next re-scan can't quietly resurrect it.
#[tauri::command]
pub async fn remove_privacy_entity(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.with_room(|room| {
        let source: String = room
            .conn
            .query_row(
                "SELECT source FROM privacy_entities WHERE id = ?1",
                [&id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if source == "user" {
            db::delete_privacy_entity(&room.conn, &id)
        } else {
            db::dismiss_privacy_entity(&room.conn, &id)
        }
    })?;
    refresh_policy(&app, &state);
    Ok(())
}

/// Replace the concept list ("my health", "my kids"). Changes the scan rules,
/// so stale files re-scan in the background.
#[tauri::command]
pub async fn set_privacy_concepts(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    concepts: Vec<String>,
) -> Result<(), String> {
    let cleaned: Vec<String> = concepts
        .into_iter()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .take(20)
        .collect();
    state.with_room(|room| {
        db::set_setting(
            &room.conn,
            KEY_CONCEPTS,
            &serde_json::to_string(&cleaned).unwrap_or_else(|_| "[]".into()),
        )
    })?;
    bump_scan_generation();
    refresh_policy(&app, &state);
    schedule_privacy_scan(app);
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyPreview {
    /// The file's text exactly as a non-local model would receive it.
    pub text: String,
    pub entities_hidden: usize,
    pub replacements: usize,
    /// Which placeholders occur in this file (for the reader's legend).
    pub present: Vec<String>,
}

/// The reader's "cloud view": this file's extracted text through the door.
/// Uses the room's rules regardless of the switch — the preview answers "what
/// WOULD the cloud see", which is exactly what the user is checking.
#[tauri::command]
pub async fn privacy_preview(
    state: State<'_, AppState>,
    file_id: String,
) -> Result<PrivacyPreview, String> {
    state.with_room(|room| {
        let text: Option<String> = room
            .conn
            .query_row(
                "SELECT extracted_text FROM files WHERE id = ?1",
                [&file_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let text = text.unwrap_or_default();
        let entities = db::list_privacy_entities(&room.conn)?;
        let rules: Vec<(String, String)> = entities
            .iter()
            .filter(|e| e.source != "dismissed")
            .map(|e| (e.real_text.clone(), e.placeholder.clone()))
            .collect();
        let redactor = Redactor::new(rules);
        let mut report = PrivacyReport::default();
        let redacted = redactor.redact(&text, &mut report);
        let present: Vec<String> = entities
            .iter()
            .filter(|e| e.source != "dismissed")
            .filter(|e| redacted.contains(&e.placeholder))
            .map(|e| e.placeholder.clone())
            .collect();
        Ok(PrivacyPreview {
            text: redacted,
            entities_hidden: report.entities_hidden,
            replacements: report.replacements,
            present,
        })
    })
}

#[tauri::command]
pub async fn start_privacy_scan(app: tauri::AppHandle) -> Result<(), String> {
    schedule_privacy_scan(app);
    Ok(())
}

// ---------------------------------------------------------------------------
// The background scanner
// ---------------------------------------------------------------------------

fn scan_flag() -> &'static AtomicBool {
    static F: OnceLock<AtomicBool> = OnceLock::new();
    F.get_or_init(|| AtomicBool::new(false))
}

fn scan_generation() -> &'static AtomicU64 {
    static G: OnceLock<AtomicU64> = OnceLock::new();
    G.get_or_init(|| AtomicU64::new(0))
}

pub(crate) fn scan_running() -> bool {
    scan_flag().load(Ordering::SeqCst)
}

fn bump_scan_generation() {
    scan_generation().fetch_add(1, Ordering::SeqCst);
}

/// Kick the background scanner if the door is on for this room. Idempotent:
/// a second call while one runs is a no-op (the runner re-checks for stale
/// files before exiting, so nothing is missed).
pub(crate) fn schedule_privacy_scan(app: tauri::AppHandle) {
    use tauri::Manager;
    {
        let state = app.state::<AppState>();
        // Scan only when the switch is effectively ON — scanning is the half
        // that costs compute; with the door off it can wait for the flip.
        refresh_policy(&app, &state);
        let on = policy_cell().lock().unwrap().as_ref().map(|p| p.active) == Some(true);
        if !on {
            return;
        }
    }
    if scan_flag().swap(true, Ordering::SeqCst) {
        return; // already running
    }
    tauri::async_runtime::spawn(async move {
        let error = run_privacy_scan(app.clone()).await;
        scan_flag().store(false, Ordering::SeqCst);
        use tauri::Manager;
        let state = app.state::<AppState>();
        refresh_policy(&app, &state);
        emit_scan_done(&app, error);
    });
}

fn emit_scan_done(app: &tauri::AppHandle, error: Option<String>) {
    use tauri::Emitter;
    let _ = app.emit(
        "privacy-scan",
        serde_json::json!({
            "running": false, "done": 0, "total": 0, "error": error,
        }),
    );
}

/// Returns the user-facing error when the scan could not run (the caller
/// emits exactly ONE terminal event, so an error is never overwritten).
async fn run_privacy_scan(app: tauri::AppHandle) -> Option<String> {
    use tauri::{Emitter, Manager};

    // Show life immediately — waking the daemon below can take seconds, and a
    // button that does nothing for that long reads as broken.
    let _ = app.emit(
        "privacy-scan",
        serde_json::json!({ "running": true, "done": 0, "total": 0, "label": "Starting…" }),
    );
    // The scanner runs on the LOCAL model, so the local Ollama daemon must be
    // up — same wake-and-hold as run_via_sidecar, or an idle (slept) daemon
    // makes the very first scan call fail. The guard keeps the idle watcher
    // from sleeping it again mid-scan.
    let _daemon = match crate::ollama::wake_daemon().await {
        Ok(g) => g,
        Err(e) => {
            return Some(format!("The local AI engine isn't available: {e}"));
        }
    };

    loop {
        let generation = scan_generation().load(Ordering::SeqCst);
        // Snapshot the work list + scan config under the room lock.
        let state = app.state::<AppState>();
        let snapshot = {
            let guard = state.room.lock().unwrap();
            let Some(room) = guard.as_ref() else { return None };
            let concepts = parse_concepts(db::get_setting(&room.conn, KEY_CONCEPTS));
            let sha = rules_sha(&concepts);
            let work = match db::files_needing_privacy_scan(&room.conn, &sha) {
                Ok(w) => w,
                Err(e) => return Some(e),
            };
            let known: Vec<String> = db::list_privacy_entities(&room.conn)
                .unwrap_or_default()
                .into_iter()
                .map(|e| e.real_text)
                .collect();
            let guard_model = policy_cell()
                .lock()
                .unwrap()
                .as_ref()
                .map(|p| p.guard_model.clone())
                .unwrap_or_else(|| DEFAULT_MODEL.to_string());
            (concepts, sha, work, known, guard_model)
        };
        let (concepts, sha, work, mut known, guard_model) = snapshot;
        if work.is_empty() {
            return None;
        }
        let total = work.len();
        for (i, (file_id, name, text)) in work.into_iter().enumerate() {
            if scan_generation().load(Ordering::SeqCst) != generation {
                break; // rules changed mid-run — restart with a fresh list
            }
            let _ = app.emit(
                "privacy-scan",
                serde_json::json!({
                    "running": true, "done": i, "total": total, "label": name
                }),
            );
            let body = serde_json::json!({
                "model": guard_model,
                "base_url": crate::ollama::resolved_base_url(),
                "text": text,
                "concepts": concepts,
                "known": known,
            });
            match crate::sidecar::sidecar_json("/privacy_scan", &body).await {
                Ok(v) => {
                    let findings = v
                        .get("entities")
                        .and_then(|e| e.as_array())
                        .cloned()
                        .unwrap_or_default();
                    let state = app.state::<AppState>();
                    let guard = state.room.lock().unwrap();
                    let Some(room) = guard.as_ref() else { return None };
                    for f in findings {
                        let real = f.get("text").and_then(|t| t.as_str()).unwrap_or("");
                        let cat = f.get("category").and_then(|c| c.as_str()).unwrap_or("concept");
                        if let Ok(e) = db::add_privacy_entity(&room.conn, real, cat, "scan") {
                            known.push(e.real_text);
                        }
                    }
                    let _ = db::set_privacy_scan(&room.conn, &file_id, &hex_sha(text.as_bytes()), &sha);
                }
                Err(e) if e.code == "OLLAMA_DOWN" || e.code == "MODEL_MISSING" => {
                    // No engine to scan with — stop and SAY SO (a silent stop
                    // reads as a dead button). The next schedule retries.
                    let msg = if e.code == "MODEL_MISSING" {
                        format!(
                            "The scan model \"{guard_model}\" isn't downloaded — \
                             get it in Settings → Model, then scan again."
                        )
                    } else {
                        "The local AI engine isn't reachable — the scan will \
                         retry on the next import or when you press Scan now."
                            .to_string()
                    };
                    return Some(msg);
                }
                Err(_) => {
                    // Transient failure on this file: leave it stale (no scan
                    // row) so the next run retries it; keep going.
                    continue;
                }
            }
        }
        // Loop: if the generation changed we rebuild the work list; if not,
        // files_needing_privacy_scan comes back empty and we return.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn redactor() -> Redactor {
        Redactor::new(vec![
            ("Ben Reich".into(), "[Person A]".into()),
            ("Ben".into(), "[Person B]".into()),
            ("12 Herzl St".into(), "[Address A]".into()),
        ])
    }

    #[test]
    fn redact_longest_first_case_insensitive_counted() {
        let r = redactor();
        let mut report = PrivacyReport::default();
        let out = r.redact("BEN REICH lives at 12 herzl st. Ben was here.", &mut report);
        assert_eq!(out, "[Person A] lives at [Address A]. [Person B] was here.");
        assert_eq!(report.replacements, 3);
        assert_eq!(report.entities_hidden, 3);
    }

    #[test]
    fn restore_roundtrip_with_case_drift() {
        let r = redactor();
        assert_eq!(r.restore("[person a] met [Person B]"), "Ben Reich met Ben");
    }

    #[test]
    fn hebrew_exact_match_redacts() {
        let r = Redactor::new(vec![("בן רייך".into(), "[Person A]".into())]);
        let mut report = PrivacyReport::default();
        assert_eq!(r.redact("החוזה של בן רייך", &mut report), "החוזה של [Person A]");
    }

    #[test]
    fn restore_value_walks_json() {
        let r = redactor();
        let v = serde_json::json!({"q": "[Person A]", "n": 3, "list": ["[Address A]"]});
        let restored = r.restore_value(&v);
        assert_eq!(restored["q"], "Ben Reich");
        assert_eq!(restored["list"][0], "12 Herzl St");
        assert_eq!(restored["n"], 3);
    }

    #[test]
    fn rules_sha_changes_with_concepts_only() {
        let a = rules_sha(&["my health".into()]);
        let b = rules_sha(&["my health".into(), "my kids".into()]);
        let c = rules_sha(&["my kids".into(), "my health".into()]);
        assert_ne!(a, b);
        assert_eq!(b, c); // order-independent
    }

    #[test]
    fn inject_policy_needs_nonlocal_model_and_active_policy() {
        clear_policy();
        let body = serde_json::json!({"model": "m:cloud", "text": "x"});
        assert!(inject_policy(&body).is_none()); // no policy cached
        *policy_cell().lock().unwrap() = Some(Arc::new(PolicyState {
            active: true,
            rules: vec![("Ben Reich".into(), "[Person A]".into())],
            concepts: vec![],
            guard_model: "qwen3.5:4b".into(),
            redactor: Redactor::new(vec![("Ben Reich".into(), "[Person A]".into())]),
        }));
        let injected = inject_policy(&body).expect("cloud model gets the policy");
        assert_eq!(injected["privacy"]["active"], true);
        assert_eq!(injected["privacy"]["rules"][0]["real"], "Ben Reich");
        let local = serde_json::json!({"model": "qwen3.5:4b"});
        assert!(inject_policy(&local).is_none());
        let no_model = serde_json::json!({"base_url": "http://127.0.0.1:11434"});
        assert!(inject_policy(&no_model).is_none());
        clear_policy();
    }
}
