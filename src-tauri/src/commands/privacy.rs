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
//!   plus explicit case spellings for every non-ASCII rule, so this half folds
//!   case for the same scripts the sidecar's `re.I` does);
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

/// How many private topics one room may hold. Every one of them is sent to the
/// live guard on each cloud turn, so the list is a prompt as well as a setting.
const MAX_PRIVACY_CONCEPTS: usize = 20;

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

/// The shortest a protected item may be, in characters.
///
/// Anything shorter is dropped by the redactor: a one-character rule matches
/// somewhere in almost every sentence and would turn the whole payload into
/// placeholders. Settings used to accept one anyway, so the panel listed an
/// item as protected that the door silently ignored — and if it was the ONLY
/// item, the room's whole shield (including holding images back) switched off.
/// The floor is enforced where an item is ADDED as well as where it is used.
pub(crate) const MIN_PROTECTED_CHARS: usize = 2;

/// Can this text be enforced mechanically? The one definition, shared by the
/// block-list command, the scanner's ingest, and the redactor's own filter.
pub(crate) fn is_protectable(text: &str) -> bool {
    text.trim().chars().count() >= MIN_PROTECTED_CHARS
}

/// The compiled redact/restore engine over the room's entity map.
///
/// KNOWN, DELIBERATE over-redaction (AUDIT, left as-is pending an owner call).
/// Matching is plain substring, not whole-word, so a room protecting "Ben"
/// turns "benchmark" into "[Person B]chmark" in what the cloud model reads. It
/// is real and it can make an answer worse. The obvious fix — word boundaries —
/// was tried and rejected because it does not only tidy text, it HIDES LESS:
/// a protected phone number "5551234" stops matching inside "+9725551234", and
/// an unspaced "BenReich" stops matching either rule. Trading a guaranteed leak
/// for tidier prompts is the wrong direction for this component, so the failure
/// is left pointing the safe way. `substring_matching_over_redacts_but_never_leaks`
/// pins the two properties any future fix must keep.
pub(crate) struct Redactor {
    /// (real, placeholder), longest real first — the room's rules as stored.
    rules: Vec<(String, String)>,
    /// What `ac` actually matches: every rule PLUS, for any rule containing
    /// non-ASCII letters, its lower- and upper-cased spellings mapped to the
    /// same placeholder (index-aligned with `ac`).
    ///
    /// `AhoCorasick`'s `ascii_case_insensitive` folds A–Z and nothing else, so
    /// "José" was matched only in the exact capitalisation the room stored it
    /// in — while the sidecar half of the same door uses Python's `re.I`, which
    /// folds every script. The two halves therefore disagreed about the same
    /// name, and the disagreement fell on the Mac side: the "what the cloud
    /// sees" preview and the outbound remote-connector masking (both Rust) let
    /// the real spelling through. Widening the pattern set here rather than
    /// dropping to a slower engine keeps the match semantics identical.
    redact_patterns: Vec<(String, String)>,
    ac: Option<AhoCorasick>,
    /// placeholder -> real (index-aligned with `restore_ac`).
    restore: Vec<(String, String)>,
    restore_ac: Option<AhoCorasick>,
}

/// A rule's extra spellings for the matcher: nothing for plain ASCII (the
/// matcher already folds that itself), and the lower/upper forms otherwise.
fn case_variants(real: &str) -> Vec<String> {
    if real.is_ascii() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for variant in [real.to_lowercase(), real.to_uppercase()] {
        if variant != real && !out.contains(&variant) {
            out.push(variant);
        }
    }
    out
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
        rules.retain(|(r, p)| is_protectable(r) && !p.trim().is_empty());
        rules.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
        // The matcher's table is the rules PLUS their non-ASCII case spellings
        // (see `redact_patterns`). Longest-first here too, so LeftmostLongest
        // still prefers "Ben Reich" over "Ben" whichever spelling matched.
        let mut redact_patterns: Vec<(String, String)> = rules.clone();
        for (real, placeholder) in &rules {
            for variant in case_variants(real) {
                redact_patterns.push((variant, placeholder.clone()));
            }
        }
        redact_patterns.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
        let ac = build_ac(
            &redact_patterns.iter().map(|(r, _)| r.clone()).collect::<Vec<_>>(),
        );
        // Restore is built from the CANONICAL rules only: a placeholder must
        // come back as the room's own spelling, not a case variant of it.
        let mut restore: Vec<(String, String)> =
            rules.iter().map(|(r, p)| (p.clone(), r.clone())).collect();
        restore.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
        let restore_ac = build_ac(&restore.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>());
        Redactor { rules, redact_patterns, ac, restore, restore_ac }
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
        // Distinct ENTITIES, keyed by what they were replaced with — not by
        // pattern index. One entity can now own several patterns (its non-ASCII
        // case spellings), and a name hidden in two capitalisations is still
        // one name hidden.
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        let mut replacements = 0usize;
        for m in ac.find_iter(text) {
            let replacement = &table[m.pattern().as_usize()].1;
            out.push_str(&text[last..m.start()]);
            out.push_str(replacement);
            last = m.end();
            replacements += 1;
            seen.insert(replacement.as_str());
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
        Self::sub(&self.ac, &self.redact_patterns, text, Some(report))
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

    /// Redact real strings anywhere in a JSON value (real → placeholder). The
    /// mirror of `restore_value`, used to mask a tool call's arguments before
    /// they leave the Mac to a REMOTE connector.
    pub(crate) fn redact_value(
        &self,
        v: &serde_json::Value,
        report: &mut PrivacyReport,
    ) -> serde_json::Value {
        match v {
            serde_json::Value::String(s) => serde_json::Value::String(self.redact(s, report)),
            serde_json::Value::Array(a) => serde_json::Value::Array(
                a.iter().map(|x| self.redact_value(x, report)).collect(),
            ),
            serde_json::Value::Object(o) => serde_json::Value::Object(
                o.iter().map(|(k, x)| (k.clone(), self.redact_value(x, report))).collect(),
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
        // While the background document scan is grinding through the library
        // it monopolizes the local model — a live-guard call would queue
        // behind it and make cloud chat feel stuck. Withholding the guard
        // model skips the live guard for those turns; the exact rules (the
        // real protection) are enforced mechanically regardless.
        let guard_model = if scan_running() {
            None
        } else {
            Some(self.guard_model.clone())
        };
        serde_json::json!({
            "active": self.active,
            "rules": self.rules.iter().map(|(r, p)| serde_json::json!({
                "real": r, "placeholder": p
            })).collect::<Vec<_>>(),
            "concepts": self.concepts,
            "guard_model": guard_model,
            // Only this side can see where the Ollama transport points, and the
            // model name cannot: the Closet aims an ordinary `qwen3.5:4b` at
            // another computer. Told, never guessed.
            "relayed": !super::capabilities::ollama_runs_here(),
        })
    }
}

fn policy_cell() -> &'static StdMutex<Option<Arc<PolicyState>>> {
    static CELL: OnceLock<StdMutex<Option<Arc<PolicyState>>>> = OnceLock::new();
    CELL.get_or_init(|| StdMutex::new(None))
}

/// The current policy when it is ACTIVE (switch on) — the enforcement getter.
///
/// The switch is the WHOLE condition. It used to also require a non-empty
/// entity map, on the reasonable-sounding logic that with nothing to replace
/// there is nothing to do — but the entity map is only ONE of the three things
/// this policy carries, and the other two need no entities at all:
///
///   * `concepts` — the topic rules the user typed ("my health", "my kids").
///     They are enforced by the sidecar's live guard, which never runs if the
///     policy is not attached.
///   * images — the door strips every attached image out of a non-local
///     request. Pixels cannot be redacted, so this is the only protection a
///     photograph or a scan gets.
///
/// So in a brand-new room — no scan has finished, nothing on the block list —
/// the panel said the door was ON while topic rules were never applied and
/// photographs went to the cloud in full. That is the badge promising something
/// the code did not do, which is the one thing this app does not get to do.
///
/// A policy with an empty entity map still redacts nothing, exactly as before;
/// what changes is that it is now ATTACHED, so the other two protections
/// engage. See `remote_seam_redactor` for the one getter that is genuinely
/// about the entity map and still tests it.
pub(crate) fn active_policy() -> Option<Arc<PolicyState>> {
    policy_cell().lock().unwrap().clone().filter(|p| p.active)
}

/// The room's redactor for the OUTBOUND remote-connector seam. Unlike
/// [`active_policy`], this IGNORES the on/off switch: a remote connector is a
/// hard non-local destination, so the room's known entities are masked before a
/// tool call's arguments leave, even when the chat-model door is off. `None`
/// when the entity map is empty — there is then nothing to mask mechanically,
/// and the SEC-1b per-call consent (which shows the user the exact args) is the
/// floor. Whatever the local scanner has found for this room is enforced here.
///
/// ONE caller-side exception (`exec_tool`): Connectors → "Send remote
/// connectors real values" (`mcp_outbound_unmask`) skips this seam entirely, so
/// the connector receives real arguments. Masking rewrites the values being
/// asked ABOUT, which silently broke lookups. That is the ONLY flag with this
/// power — until the 2026-08-03 split it was the same switch as "run connector
/// tools without asking", which meant needing a working lookup also cost you
/// the consent card. This function stays switch-blind — the exception lives at
/// the call site, where the unmasking flag is known.
pub(crate) fn remote_seam_redactor() -> Option<Arc<PolicyState>> {
    policy_cell()
        .lock()
        .unwrap()
        .clone()
        .filter(|p| !p.redactor.is_empty())
}

/// Are remote-connector arguments being masked RIGHT NOW? The one fact the
/// Cloud-privacy panel cannot derive from its own switch.
///
/// Every other seam this module guards is governed by `active`, so the panel
/// could describe them all from `effective_on`: door off ⇒ real values leave.
/// The connector seam is the exception ([`remote_seam_redactor`] is
/// switch-blind, deliberately), and the panel's off-state warning therefore
/// used to state the opposite of what happens — "questions, documents and tool
/// results go to cloud models with real names", full stop, while a remote
/// connector was still being asked about `[Person A]`. That is the exact shape
/// of the 2026-07-24 misdiagnosis: silent outbound masking read as a broken
/// connector, and the panel a user checks first said masking was impossible.
///
/// Reported rather than changed. Masking here is not weakened by the switch —
/// it is made visible, so both switches can be believed.
pub(crate) fn connector_args_masked(unmask_outbound: bool) -> bool {
    remote_seam_redactor().is_some() && super::masks_outbound_args(true, unmask_outbound)
}

/// The panel's version of the question, asked once per REMOTE connector this
/// room has connected.
///
/// The unmasking flag became per-connector on 2026-08-03 and this note did not
/// follow it: reading the Mac-wide switch alone, the panel printed "a remote
/// connector is still sent placeholders" while a connector whose own override
/// says otherwise received the real names — and printed the leak warning for
/// seams that were masked. `exec_tool` decides per connector
/// ([`super::outbound_unmask_for`]), so the honest summary is the weakest
/// answer among them: the note may only claim masking when EVERY remote
/// connector is masked. A DISABLED connector cannot be called at all, so its
/// override says nothing about what leaves this room; with no remote connector
/// in the list there is no seam to describe and the Mac-wide switch is the
/// room-wide answer, as before.
fn every_connector_masked(state: &AppState) -> bool {
    let remote: Vec<String> = state
        .mcp
        .lock()
        .unwrap()
        .statuses()
        .into_iter()
        .filter(|s| s.remote && s.status != mcp::Status::Disabled)
        .map(|s| s.name)
        .collect();
    if remote.is_empty() {
        return connector_args_masked(
            state
                .mcp_outbound_unmask
                .load(std::sync::atomic::Ordering::SeqCst),
        );
    }
    remote
        .iter()
        .all(|name| connector_args_masked(outbound_unmask_for(state, name)))
}

/// PRIV-4 — the WEB seam. Mask the room's protected entities out of a string
/// the AGENT is about to send to a public web service (a `web_search` query, a
/// `fetch_page` URL).
///
/// Why this seam exists at all: the door redacts on the way to a cloud model,
/// then RESTORES placeholders in the tool-call arguments coming back, because a
/// room tool must see the real name to find anything (`Redactor::restore_value`,
/// and its sidecar twin `PrivacyPolicy.restore_value`). That restore is right
/// for a tool that reads the room's own database and wrong for a tool whose
/// argument leaves the Mac: a cloud model asking to search "[Person A]" had the
/// real name put back and handed to seven search engines. The whole point of the
/// entity map is that those names do not leave.
///
/// Governed by the SWITCH (`active_policy`), unlike the remote-connector seam.
/// A remote connector is a hard non-local destination whatever the user thinks;
/// the web is a destination the user chose by turning web access on, and with
/// the door off real names already flow to cloud models, so masking here would
/// be protecting against a threat the user has already accepted — while quietly
/// breaking every search for a name on the block list.
///
/// Returns `None` when nothing changed, so a caller can stay silent unless it
/// actually has something to disclose. Never silent when it DID change: every
/// caller says so in the tool result (anti-fabrication — the model must not
/// report a search it believes was about the real name).
pub(crate) fn mask_outbound_web(text: &str) -> Option<(String, usize)> {
    let policy = active_policy()?;
    let mut report = PrivacyReport::default();
    let masked = policy.redactor.redact(text, &mut report);
    (masked != text).then_some((masked, report.entities_hidden))
}

/// Percent-decode, permissively: a malformed `%` sequence is left alone rather
/// than dropped. Only used to LOOK at a URL, never to rebuild one, so being
/// generous costs nothing and being strict would open the hole below.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        // `+` is a space in a query string, and "Ben+Reich" is the single most
        // likely spelling of a name a model puts in a search URL.
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Does this URL carry any of the room's protected names? Returns how many.
///
/// Separate from [`mask_outbound_web`] because a URL is ENCODED: a cloud model
/// writing `https://example.com/?q=Ben%20Reich` (or `Ben+Reich`) hands over the
/// real name while the raw string contains no entity the redactor can see. The
/// callers refuse rather than mask — a URL with a placeholder in its path or
/// query only 404s — so this answers the question a refusal needs and nothing
/// more. Governed by the switch, exactly like `mask_outbound_web`.
pub(crate) fn outbound_url_hides(url: &str) -> Option<usize> {
    let policy = active_policy()?;
    let mut report = PrivacyReport::default();
    let hits = |text: &str, report: &mut PrivacyReport| {
        policy.redactor.redact(text, report) != text
    };
    let decoded = percent_decode(url);
    let leaks = hits(url, &mut report) || hits(&decoded, &mut report);
    leaks.then(|| report.entities_hidden.max(1))
}

/// The disclosure line that goes with [`mask_outbound_web`]. Says what was done
/// and how to undo it, so a masked search cannot read as a failed one.
pub(crate) fn web_mask_note(hidden: usize) -> String {
    format!(
        "\n\nNote: {hidden} protected name(s) in this request were replaced with placeholders \
         before it left this Mac (Settings → Cloud privacy). The results are for the masked \
         wording, NOT the real name — say so rather than presenting them as results for the \
         real name."
    )
}

/// Room closed: no policy may outlive the room (teardown invariant).
pub(crate) fn clear_policy() {
    *policy_cell().lock().unwrap() = None;
}

/// The policy cell is process-global, so any two tests that write it would race
/// under cargo's parallel runner. Every such test holds this first.
#[cfg(test)]
pub(crate) fn policy_test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: StdMutex<()> = StdMutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Cache a minimal ACTIVE policy so sibling modules can test what the door
/// changes about their own behaviour. The cell stays private outside tests —
/// only `set_policy` (room open) fills it in a real run.
#[cfg(test)]
pub(crate) fn set_active_policy_for_test() {
    set_policy_for_test(true);
}

/// Same, with the switch chosen by the caller — the door being OFF is a state
/// with its own documented behaviour at the connector seam, so it needs a
/// fixture too.
#[cfg(test)]
pub(crate) fn set_policy_for_test(active: bool) {
    set_policy_rules_for_test(
        active,
        vec![("Ben Reich".to_string(), "[Person A]".to_string())],
    );
}

/// …and with the entity map chosen by the caller, for the doors whose behaviour
/// turns on WHICH entities a room happens to hold (the browser's outbound
/// typing door and its non-ASCII case folding).
#[cfg(test)]
pub(crate) fn set_policy_rules_for_test(active: bool, rules: Vec<(String, String)>) {
    *policy_cell().lock().unwrap() = Some(Arc::new(PolicyState {
        active,
        redactor: Redactor::new(rules.clone()),
        rules,
        concepts: vec![],
        guard_model: DEFAULT_MODEL.to_string(),
    }));
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

/// What a recomputation could establish about the room's policy.
enum Computed {
    /// No room is open — the teardown invariant: no policy outlives a room.
    NoRoom,
    Policy(PolicyState),
    /// The room is open but its ENTITY MAP could not be read. Everything else
    /// (the switch, the topic rules, the guard model) is known; only the
    /// mechanical rules are missing.
    Partial(PolicyState),
}

/// Recompute the cached policy from the open room + the global default. Call
/// after room open, any privacy-settings change, and any entity-map change.
///
/// A failed entity-map read used to land here as `None`, which cleared the cell
/// — and a cleared cell is the door wide open: no policy on the sidecar request
/// (so nothing redacted and images no longer stripped), no outbound masking of
/// remote-connector arguments, no masking of web queries, and the scanner
/// silently declining to run. All of that from one transient read, with the
/// panel still reading "On for this room". So a read failure keeps the rules
/// already in force and applies THIS room's switch and topics to them: the
/// switch is what decides whether the model seams engage, so it may never come
/// from a stale reading, while rules only ever hide more.
pub(crate) fn refresh_policy(app: &tauri::AppHandle, state: &AppState) {
    install_policy(compute_policy(app, state));
}

/// Put a recomputation into the cell — the one place the cell is written in a
/// real run, and the whole of the fail-closed rule above.
fn install_policy(computed: Computed) {
    match computed {
        Computed::NoRoom => *policy_cell().lock().unwrap() = None,
        Computed::Policy(p) => *policy_cell().lock().unwrap() = Some(Arc::new(p)),
        Computed::Partial(mut p) => {
            let mut cell = policy_cell().lock().unwrap();
            if let Some(previous) = cell.as_ref() {
                p.rules = previous.rules.clone();
                p.redactor = Redactor::new(p.rules.clone());
            }
            *cell = Some(Arc::new(p));
        }
    }
}

fn compute_policy(app: &tauri::AppHandle, state: &AppState) -> Computed {
    let guard = state.room.lock().unwrap();
    let Some(room) = guard.as_ref() else {
        return Computed::NoRoom;
    };
    let switch = db::get_setting(&room.conn, KEY_SWITCH);
    let active = match switch.as_deref() {
        Some("off") => false,
        Some("on") => true,
        _ => global_default_on(app),
    };
    let entities = db::list_privacy_entities(&room.conn);
    let rules: Vec<(String, String)> = entities
        .as_ref()
        .map(|list| {
            list.iter()
                .filter(|e| e.source != "dismissed")
                .map(|e| (e.real_text.clone(), e.placeholder.clone()))
                .collect()
        })
        .unwrap_or_default();
    let concepts = parse_concepts(db::get_setting(&room.conn, KEY_CONCEPTS));
    // The live guard + scanner need a model that runs ON THIS MAC. The room's
    // chosen model qualifies only when local; otherwise the tuned default.
    let room_model = model_setting(&room.conn).unwrap_or_default();
    // `runs_on_this_mac` — the ONE definition of "runs here" — rather than the
    // pair of name tests, which missed Ollama's `<size>-cloud` spelling and so
    // would have made a HOSTED model the guard for the privacy door itself.
    let guard_model = if !room_model.is_empty()
        && runs_on_this_mac(&room_model)
        && !is_embedding_model(&room_model)
    {
        room_model
    } else {
        DEFAULT_MODEL.to_string()
    };
    let policy = PolicyState {
        active,
        redactor: Redactor::new(rules.clone()),
        rules,
        concepts,
        guard_model,
    };
    match entities {
        Ok(_) => Computed::Policy(policy),
        Err(_) => Computed::Partial(policy),
    }
}

/// Attach the room policy to a sidecar request body when its `model` is
/// non-local and the door is on. The Rust-side injection point: BOTH sidecar
/// gateways call it — `sidecar.rs::sidecar_json` (agent/feature endpoints) and
/// `ollama.rs::sidecar_post` (the generate/embed gateway). Adding a third
/// gateway without calling this re-opens the leak the latter had until
/// 2026-07-25, where cloud engines received raw room content because
/// `privacy.guard_outbound` no-ops on a missing policy.
pub(crate) fn inject_policy(body: &serde_json::Value) -> Option<serde_json::Value> {
    let model = body.get("model").and_then(|m| m.as_str())?;
    // EXTENDS the door, never narrows it: `runs_on_this_mac` is strictly more
    // conservative than the pair it replaces — it also catches Ollama's
    // `<size>-cloud` spelling (`gpt-oss:120b-cloud`), which used to reach the
    // sidecar with NO policy attached at all because neither name test matched.
    if runs_on_this_mac(model) {
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
    /// Why the last scan stopped without finishing, if it did. The terminal
    /// event says the same thing, once; this survives for a reader who was not
    /// listening yet — the app's own window, at mount.
    pub last_scan_error: Option<String>,
    /// Whether remote-connector arguments are masked right now — see
    /// [`connector_args_masked`]. Independent of `effective_on`, which is why
    /// the panel has to be told rather than infer it.
    pub connector_args_masked: bool,
}

#[tauri::command]
pub async fn privacy_status(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<PrivacyStatus, String> {
    let global_on = global_default_on(&app);
    let connector_masked = every_connector_masked(&state);
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
            last_scan_error: last_scan_error().lock().unwrap().clone(),
            connector_args_masked: connector_masked,
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
        // "Follow the app default instead" is a write like any other: a DELETE
        // that failed used to return Ok, so the panel reloaded with the
        // override still in place and nothing said why.
        "default" => room
            .conn
            .execute("DELETE FROM settings WHERE key = ?1", [KEY_SWITCH])
            .map(|_| ())
            .map_err(|e| e.to_string()),
        other => Err(format!("unknown privacy mode: {other}")),
    })?;
    refresh_policy(&app, &state);
    if active_policy().is_some() {
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
    // The door's own floor, enforced at the door's own entrance. Settings used
    // to accept a single character, list it as protected, and then have the
    // redactor drop it — so the panel showed protection that was not happening,
    // and a room whose ONLY item was that one character had no active policy at
    // all (images included). Refusing it here is the honest half of that fix.
    if !is_protectable(&text) {
        return Err(format!(
            "A protected item needs at least {MIN_PROTECTED_CHARS} characters — \
             anything shorter would match almost every word."
        ));
    }
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

/// Trim the topic list, drop the blank lines, and REFUSE one over the cap.
///
/// It used to `take(20)`: the extra topics were dropped, the panel's reload
/// rewrote the box from the twenty that were stored, and the rest of what the
/// user had typed vanished with nothing said — while they had every reason to
/// believe those topics were protected. Same doctrine as `add_privacy_block`'s
/// two-character floor: the door states its limits at its own entrance, and
/// stores all of what it accepts. Pure — unit-tested.
fn clean_concepts(concepts: Vec<String>) -> Result<Vec<String>, String> {
    let cleaned: Vec<String> = concepts
        .into_iter()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();
    if cleaned.len() > MAX_PRIVACY_CONCEPTS {
        return Err(format!(
            "That is {} private topics — this room holds at most {MAX_PRIVACY_CONCEPTS}. \
             Nothing was saved: shorten the list and save again, or add the rest as \
             protected items below.",
            cleaned.len()
        ));
    }
    Ok(cleaned)
}

/// Replace the concept list ("my health", "my kids"). Changes the scan rules,
/// so stale files re-scan in the background.
#[tauri::command]
pub async fn set_privacy_concepts(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    concepts: Vec<String>,
) -> Result<(), String> {
    let cleaned = clean_concepts(concepts)?;
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
                // Trash: same rule as every other by-id content read — a
                // deleted file is not previewable, or a stale id in an open
                // blackout view would keep rendering its text.
                "SELECT extracted_text FROM files WHERE id = ?1 AND trashed_at IS NULL",
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

/// The one sentence every refusal to scan uses. It is one situation — Home's
/// brief and the Settings panel both offer the button — so it must not read as
/// two different problems.
pub(crate) const SCAN_DOOR_OFF: &str =
    "Scanning is off while this room's cloud-privacy door is off. Turn the door on and the \
     scan starts by itself.";

/// The USER pressing "Scan now". Unlike [`schedule_privacy_scan`], which is an
/// internal trigger and is right to be silent, this one answers a person — so a
/// door-off room gets a reason instead of an `Ok(())` that starts nothing.
///
/// Both callers showed a button that did nothing and then went quiet; Settings
/// additionally painted "Starting the scan…" that no event ever cleared. Fixing
/// it here rather than in each caller keeps one answer to one question.
#[tauri::command]
pub async fn start_privacy_scan(app: tauri::AppHandle) -> Result<(), String> {
    if !door_is_active(&app) {
        return Err(SCAN_DOOR_OFF.into());
    }
    schedule_privacy_scan(app);
    Ok(())
}

/// Is the cloud-privacy door effectively ON for the open room? Refreshes the
/// cached policy first, so the answer reflects a switch flipped a moment ago.
fn door_is_active(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    let state = app.state::<AppState>();
    refresh_policy(app, &state);
    policy_cell().lock().unwrap().as_ref().map(|p| p.active) == Some(true)
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

/// Why the LAST scan could not finish, until something reports it.
///
/// The terminal `privacy-scan` event is emitted once and then gone, and a scan
/// scheduled at room-open can finish before the workspace has mounted its
/// listener — so the one failure this app most owes the user an explanation for
/// could vanish with nobody told. Parked here, it is still there for the
/// mount-time `privacy_status` read. Cleared when the next scan starts, so it
/// only ever describes the most recent attempt.
fn last_scan_error() -> &'static StdMutex<Option<String>> {
    static E: OnceLock<StdMutex<Option<String>>> = OnceLock::new();
    E.get_or_init(|| StdMutex::new(None))
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
    // Scan only when the switch is effectively ON — scanning is the half that
    // costs compute; with the door off it can wait for the flip. Silent here on
    // purpose: this is the automatic trigger (an import, a rules change), and
    // nobody asked it a question. `start_privacy_scan` is the one that answers.
    if !door_is_active(&app) {
        return;
    }
    if scan_flag().swap(true, Ordering::SeqCst) {
        return; // already running
    }
    // A new attempt supersedes whatever the last one had to say.
    *last_scan_error().lock().unwrap() = None;
    tauri::async_runtime::spawn(async move {
        let ScanEnd { error, room_changed } = run_privacy_scan(app.clone()).await;
        scan_flag().store(false, Ordering::SeqCst);
        *last_scan_error().lock().unwrap() = error.clone();
        use tauri::Manager;
        let state = app.state::<AppState>();
        refresh_policy(&app, &state);
        emit_scan_done(&app, error);
        // The room this run belonged to was replaced. Whatever room is open now
        // asked for its own scan while this one still held the flag and was
        // turned away by the idempotence check above, so it is started here —
        // once, and only after the flag is clear. A run that ends normally
        // never lands here, so this cannot loop.
        if room_changed {
            schedule_privacy_scan(app);
        }
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

/// How a scan run ended.
struct ScanEnd {
    /// The user-facing error when the scan could not run (the caller emits
    /// exactly ONE terminal event, so an error is never overwritten).
    error: Option<String>,
    /// The run was ABANDONED because the room it was scanning was replaced.
    room_changed: bool,
}

impl ScanEnd {
    fn finished(error: Option<String>) -> Self {
        ScanEnd { error, room_changed: false }
    }

    /// The room moved under the run. Not an error the user should read: the
    /// room they were in is closed, and its findings are simply not this room's
    /// business.
    fn abandoned() -> Self {
        ScanEnd { error: None, room_changed: true }
    }
}

async fn run_privacy_scan(app: tauri::AppHandle) -> ScanEnd {
    use tauri::{Emitter, Manager};

    // The room these findings belong to. Every write below re-checks it: the
    // scan is a long loop around a sidecar call, so locking this room and
    // opening another mid-chunk used to file the names, addresses and phone
    // numbers read out of THIS room's documents into the next room's
    // `privacy_entities` table, where they showed up as its protected items.
    // Same room-path + epoch pin `AppState::room_epoch` documents.
    let (room_path, epoch) = {
        let state = app.state::<AppState>();
        let guard = state.room.lock().unwrap();
        let Some(room) = guard.as_ref() else {
            return ScanEnd::finished(None);
        };
        (room.path.clone(), state.room_epoch())
    };

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
            return ScanEnd::finished(Some(format!("The local AI engine isn't available: {e}")));
        }
    };

    // Files this RUN could not scan. A transient failure leaves no scan row, so
    // the file comes straight back in the next work list — and with nothing
    // remembering that it just failed, one document that always fails made this
    // outer loop spin forever: the machine stayed busy, Settings said
    // "scanning" for good, and (because `payload` withholds the guard model
    // while a scan is running) the live guard stayed off for every cloud chat
    // in the meantime. Remembering them ends the run honestly instead.
    // Cleared whenever the rules change, since a new generation is a new run.
    let mut failed: HashSet<String> = HashSet::new();
    let mut failed_generation = scan_generation().load(Ordering::SeqCst);
    loop {
        let generation = scan_generation().load(Ordering::SeqCst);
        if generation != failed_generation {
            failed.clear();
            failed_generation = generation;
        }
        // Snapshot the work list + scan config under the room lock.
        let state = app.state::<AppState>();
        let snapshot = {
            let guard = state.room.lock().unwrap();
            let Some(room) = guard.as_ref() else {
                return ScanEnd::finished(None);
            };
            // A different room (or the same path reopened) is not this run's to
            // read or write. Checked before the work list as well as before the
            // findings, so nothing from room A is even looked up in room B.
            if room.path != room_path || state.room_epoch() != epoch {
                return ScanEnd::abandoned();
            }
            let concepts = parse_concepts(db::get_setting(&room.conn, KEY_CONCEPTS));
            let sha = rules_sha(&concepts);
            let work = match db::files_needing_privacy_scan(&room.conn, &sha) {
                Ok(w) => w,
                Err(e) => return ScanEnd::finished(Some(e)),
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
            return ScanEnd::finished(None);
        }
        // Anything that already failed this run is not retried in it.
        let work: Vec<_> = work.into_iter().filter(|(id, _, _)| !failed.contains(id)).collect();
        if work.is_empty() {
            // Everything left is something we just failed on. Say so — counts
            // only, never a file name (a name is room content) — and stop, so
            // the next import or "Scan now" is what retries.
            return ScanEnd::finished(Some(format!(
                "{} file{} couldn't be scanned all the way through this time — \
                 anything found so far is protected, the rest is not yet. They'll \
                 be retried on the next import, or when you press Scan now.",
                failed.len(),
                if failed.len() == 1 { "" } else { "s" }
            )));
        }
        let total = work.len();
        for (i, (file_id, name, text)) in work.into_iter().enumerate() {
            if scan_generation().load(Ordering::SeqCst) != generation {
                break; // rules changed mid-run — restart with a fresh list
            }
            // Step aside while the user is chatting: an interactive ask shares
            // the local model with the scanner, and the answer always matters
            // more than the scan. (`cancels` holds one entry per in-flight
            // ask, cleaned on every exit path by CancelGuard.)
            loop {
                let chatting = {
                    let state = app.state::<AppState>();
                    let busy = !state.cancels.lock().unwrap().is_empty();
                    busy
                };
                if !chatting || scan_generation().load(Ordering::SeqCst) != generation {
                    break;
                }
                let _ = app.emit(
                    "privacy-scan",
                    serde_json::json!({
                        "running": true, "done": i, "total": total,
                        "label": "Paused while you chat"
                    }),
                );
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
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
                    let Some(room) = guard.as_ref() else {
                        return ScanEnd::finished(None);
                    };
                    // These findings came out of the PINNED room's document. If
                    // the room was locked and another opened while the sidecar
                    // was working, they are dropped rather than filed in
                    // whichever room happens to be open now.
                    if room.path != room_path || state.room_epoch() != epoch {
                        return ScanEnd::abandoned();
                    }
                    for f in findings {
                        let real = f.get("text").and_then(|t| t.as_str()).unwrap_or("");
                        let cat = f.get("category").and_then(|c| c.as_str()).unwrap_or("concept");
                        // Same floor as the block list: a one-character finding
                        // would be listed as protected and then ignored.
                        if !is_protectable(real) {
                            continue;
                        }
                        if let Ok(e) = db::add_privacy_entity(&room.conn, real, cat, "scan") {
                            known.push(e.real_text);
                        }
                    }
                    // A scan that stopped short (a chunk's model call failed, or
                    // the 300-finding cap cut it off) never read the tail of the
                    // document. Its findings are kept — every one of them is a
                    // real protection — but the scan ROW is not written, because
                    // that row is the claim "this file is protected" and the
                    // unread remainder would still go to a cloud model in full.
                    // Absent the flag (older sidecar) we assume complete, which
                    // is the pre-existing behaviour rather than a new silence.
                    let complete = v.get("complete").and_then(|c| c.as_bool()).unwrap_or(true);
                    if complete {
                        // The digest goes through db::privacy_text_sha because
                        // the staleness reader recomputes it the same way — a
                        // second spelling here would either re-scan the library
                        // forever or never re-scan an edited file again.
                        let _ = db::set_privacy_scan(
                            &room.conn,
                            &file_id,
                            &db::privacy_text_sha(&text),
                            &sha,
                        );
                    } else {
                        // Not marked done, so a later run continues it; remembered
                        // here so THIS run doesn't come straight back to it and
                        // spin. The run-end message says how many were partial.
                        failed.insert(file_id);
                        continue;
                    }
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
                    return ScanEnd::finished(Some(msg));
                }
                Err(_) => {
                    // Transient failure on this file: leave it stale (no scan
                    // row) so a LATER run retries it, but remember it so THIS
                    // run does not come straight back to it forever.
                    failed.insert(file_id);
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

    /// AUDIT (medium, deliberately NOT "fixed"): substring matching over-redacts
    /// — "benchmark" comes out mangled when "Ben" is protected. That is ugly and
    /// it is recorded here so nobody rediscovers it as news. What this test
    /// actually guards is the other half: the two cases a word-boundary fix
    /// would silently start LEAKING. If someone makes the first assertion pass,
    /// the last two must still pass.
    #[test]
    fn substring_matching_over_redacts_but_never_leaks() {
        let r = Redactor::new(vec![
            ("Ben Reich".into(), "[Person A]".into()),
            ("Ben".into(), "[Person B]".into()),
            ("5551234".into(), "[Phone A]".into()),
        ]);
        let mut report = PrivacyReport::default();
        // Known cost, stated plainly.
        assert_eq!(r.redact("the benchmark ran", &mut report), "the [Person B]chmark ran");

        // Non-negotiable: a protected number inside a longer number still goes.
        let mut report = PrivacyReport::default();
        let out = r.redact("call +9725551234 now", &mut report);
        assert!(!out.contains("5551234"), "a protected number leaked: {out}");

        // Non-negotiable: an unspaced spelling of a protected name still goes.
        let mut report = PrivacyReport::default();
        let out = r.redact("from BenReich@example.com", &mut report);
        assert!(
            !out.to_lowercase().contains("ben"),
            "a protected name leaked unspaced: {out}"
        );
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
    fn redact_value_masks_outbound_connector_args() {
        // PRIV: the outbound remote-connector seam masks real entities in a tool
        // call's args (real → placeholder) before they leave, walking nested
        // JSON and leaving non-strings untouched. Round-trips with restore_value.
        let r = redactor();
        let args = serde_json::json!({
            "query": "email from Ben Reich about 12 Herzl St",
            "limit": 5,
            "tags": ["Ben", "urgent"],
        });
        let mut report = PrivacyReport::default();
        let sent = r.redact_value(&args, &mut report);
        assert_eq!(sent["query"], "email from [Person A] about [Address A]");
        assert_eq!(sent["tags"][0], "[Person B]");
        assert_eq!(sent["tags"][1], "urgent");
        assert_eq!(sent["limit"], 5);
        assert!(report.replacements >= 3);
        // What leaves carries no real name/address.
        let leaving = sent.to_string();
        assert!(!leaving.contains("Ben Reich"));
        assert!(!leaving.contains("12 Herzl St"));
        // And the placeholders restore on the way back.
        assert_eq!(r.restore_value(&sent)["query"], "email from Ben Reich about 12 Herzl St");
    }

    #[test]
    fn remote_seam_survives_the_switch_but_active_policy_does_not() {
        // The documented asymmetry, pinned: the model seams follow `active`,
        // the outbound connector seam does not. A change to either getter that
        // silently aligned them would land here — one direction weakens the
        // door, the other re-opens the model leak.
        let _guard = policy_test_lock();
        clear_policy();
        assert!(remote_seam_redactor().is_none()); // no room open: nothing to mask
        set_policy_for_test(false);
        assert!(
            active_policy().is_none(),
            "switch off: cloud models must get the raw text the panel promises"
        );
        let seam = remote_seam_redactor().expect("connector seam ignores the switch");
        assert!(!seam.active);
        let mut report = PrivacyReport::default();
        let sent = seam
            .redactor
            .redact_value(&serde_json::json!({"q": "mail from Ben Reich"}), &mut report);
        assert_eq!(sent["q"], "mail from [Person A]");
        assert_eq!(report.entities_hidden, 1);
        clear_policy();
    }

    #[test]
    fn web_seam_masks_a_restored_name_before_it_reaches_a_search_engine() {
        // PRIV-4. The leak this closes: the door hands a cloud model
        // "[Person A]", the model asks to search for it, `restore_value` puts
        // the real name back for the room tools — and `web_search` is not a room
        // tool. Before the fix the query left the Mac as "Ben Reich".
        let _guard = policy_test_lock();
        clear_policy();
        assert!(
            mask_outbound_web("Ben Reich CV").is_none(),
            "no room open: nothing to mask, and no note to invent"
        );
        set_policy_for_test(true);
        let (masked, hidden) =
            mask_outbound_web("Ben Reich CV").expect("a protected name must not leave");
        assert_eq!(masked, "[Person A] CV");
        assert_eq!(hidden, 1);
        // Silence is only allowed when nothing changed.
        assert!(mask_outbound_web("weather in Haifa").is_none());
        // And the disclosure names the count, so a masked search cannot be
        // reported to the user as a search for the real name.
        assert!(web_mask_note(hidden).contains('1'));
        // Switch OFF: real names already go to cloud models, so masking here
        // would break lookups while protecting nothing the user has not already
        // accepted. This is the documented asymmetry with the connector seam.
        set_policy_for_test(false);
        assert!(mask_outbound_web("Ben Reich CV").is_none());
        clear_policy();
    }

    /// The refusing half of PRIV-4's web seam, and the hole a raw-string check
    /// leaves: a URL is ENCODED. `fetch_page`/`browse_open` were checked with
    /// `mask_outbound_web`, which reads the literal characters — so a cloud
    /// model writing "?q=Ben%20Reich" or "?q=Ben+Reich" handed the real name
    /// straight out, which is exactly the exfiltration shape the refusal exists
    /// to stop.
    #[test]
    fn an_encoded_name_in_a_url_is_still_caught() {
        let _guard = policy_test_lock();
        clear_policy();
        assert_eq!(outbound_url_hides("https://x.test/?q=Ben%20Reich"), None);

        set_policy_for_test(true);
        // Plain, percent-encoded, and the query-string "+ is a space" spelling.
        for url in [
            "https://x.test/?q=Ben Reich",
            "https://x.test/?q=Ben%20Reich",
            "https://x.test/?q=Ben+Reich",
            "https://x.test/Ben%20Reich/cv",
        ] {
            assert!(outbound_url_hides(url).is_some(), "leaked: {url}");
        }
        // A URL with nothing protected in it is not refused — the door must not
        // break ordinary browsing.
        assert_eq!(outbound_url_hides("https://x.test/weather?q=Haifa"), None);
        // A malformed escape is left alone rather than mangled into a match.
        assert_eq!(outbound_url_hides("https://x.test/?q=100%ZZ"), None);

        // Switch OFF: same asymmetry the masking half documents.
        set_policy_for_test(false);
        assert_eq!(outbound_url_hides("https://x.test/?q=Ben%20Reich"), None);
        clear_policy();
    }

    #[test]
    fn connector_args_masked_reports_what_the_seam_actually_does() {
        // The user-visible signal must equal the behaviour in every state,
        // INCLUDING switch-off — that combination is exactly the one the
        // Cloud-privacy panel used to describe as "real names and details".
        let _guard = policy_test_lock();
        clear_policy();
        assert!(!connector_args_masked(false)); // no entity map: nothing masked
        for active in [true, false] {
            set_policy_for_test(active);
            assert!(
                connector_args_masked(false),
                "door {active}: args are masked, so the panel must say so"
            );
            assert!(
                !connector_args_masked(true),
                "door {active}: unmasked connector sends real values, panel must say so"
            );
        }
        clear_policy();
    }

    #[test]
    fn topics_past_the_cap_are_refused_rather_than_dropped() {
        // The box took 25 lines, the backend kept 20, and the panel's reload
        // rewrote the box from what was stored — so five topics the user
        // believed were protected disappeared with no error and no mention of a
        // cap anywhere in the copy.
        let lines = |n: usize| (0..n).map(|i| format!("topic {i}")).collect::<Vec<_>>();
        assert_eq!(clean_concepts(vec![]).unwrap().len(), 0);
        assert_eq!(clean_concepts(lines(1)).unwrap().len(), 1);
        assert_eq!(
            clean_concepts(lines(MAX_PRIVACY_CONCEPTS)).unwrap().len(),
            MAX_PRIVACY_CONCEPTS,
            "the cap itself must still save"
        );
        let err = clean_concepts(lines(MAX_PRIVACY_CONCEPTS + 1))
            .expect_err("one past the cap was silently truncated");
        assert!(err.contains(&MAX_PRIVACY_CONCEPTS.to_string()), "{err}");
        assert!(err.contains("Nothing was saved"), "{err}");
        // Blank and whitespace-only lines are not topics, so a list that only
        // exceeds the cap by way of them is still saved whole.
        let mut padded = lines(MAX_PRIVACY_CONCEPTS);
        padded.extend(["".to_string(), "   ".to_string()]);
        assert_eq!(
            clean_concepts(padded).unwrap().len(),
            MAX_PRIVACY_CONCEPTS,
            "empty lines must not spend the room's allowance"
        );
    }

    #[test]
    fn an_unreadable_entity_map_never_opens_the_door() {
        // The reported failure: `list_privacy_entities` returning Err made
        // `compute_policy` answer None, which CLEARED the cell — and a cleared
        // cell is every seam open at once (no policy on the request, no image
        // stripping, no outbound masking, no scan) while Settings kept saying
        // "On for this room".
        let _guard = policy_test_lock();
        clear_policy();
        let partial = || PolicyState {
            active: true,
            rules: vec![],
            concepts: vec!["my health".into()],
            guard_model: DEFAULT_MODEL.to_string(),
            redactor: Redactor::new(vec![]),
        };
        // Nothing cached yet: the room's switch and topics are still known, so
        // the door stays armed with no rules rather than vanishing.
        install_policy(Computed::Partial(partial()));
        let policy = active_policy().expect("a read failure must not disarm the door");
        assert_eq!(policy.concepts, vec!["my health".to_string()]);

        // With rules already in force, they stay in force — they are the only
        // copy of the entity map this Mac has until a read succeeds.
        install_policy(Computed::Policy(PolicyState {
            active: true,
            rules: vec![("Ben Reich".into(), "[Person A]".into())],
            concepts: vec![],
            guard_model: DEFAULT_MODEL.to_string(),
            redactor: Redactor::new(vec![("Ben Reich".into(), "[Person A]".into())]),
        }));
        install_policy(Computed::Partial(partial()));
        let kept = active_policy().expect("still armed");
        assert_eq!(kept.rules.len(), 1, "the known entities must survive a failed read");
        let mut report = PrivacyReport::default();
        assert_eq!(kept.redactor.redact("from Ben Reich", &mut report), "from [Person A]");

        // A closed room is the one case that empties the cell (teardown).
        install_policy(Computed::NoRoom);
        assert!(policy_cell().lock().unwrap().is_none());
        clear_policy();
    }

    /// A connector row as the manager holds one — only its name and whether it
    /// is remote matter to the seam under test.
    fn connector(name: &str, remote: bool) -> crate::mcp::Server {
        crate::mcp::Server {
            name: name.to_string(),
            status: crate::mcp::Status::Connected,
            error: None,
            tools: Vec::new(),
            remote,
            client: None,
            config_key: String::new(),
        }
    }

    fn unmask_override(state: &AppState, server: &str, value: Option<bool>) {
        let mut powers = state.mcp_connector_powers.lock().unwrap();
        powers.clear();
        if let Some(v) = value {
            powers.insert(
                server.to_string(),
                super::super::ConnectorOverride {
                    auto_approve: None,
                    outbound_unmask: Some(v),
                },
            );
        }
    }

    #[test]
    fn the_masking_note_follows_the_connectors_not_the_mac_wide_switch() {
        // Unmasking became per-connector on 2026-08-03 and this note did not:
        // reading only the Mac-wide switch, Cloud privacy printed "a remote
        // connector is still sent placeholders" while a connector whose own
        // override says otherwise received the real names — and printed the
        // leak warning for a seam that was masked.
        use std::sync::atomic::Ordering::SeqCst;
        let _guard = policy_test_lock();
        clear_policy();
        set_policy_for_test(false); // the seam is switch-blind; the map is what counts
        let state = AppState::default();
        {
            let mut mgr = state.mcp.lock().unwrap();
            mgr.servers = vec![connector("fetch", true), connector("files", false)];
        }
        assert!(
            every_connector_masked(&state),
            "both follow the Mac-wide switch, which is off: everything is masked"
        );

        unmask_override(&state, "fetch", Some(true));
        assert!(
            !every_connector_masked(&state),
            "one remote connector is sent real values — the note may not claim otherwise"
        );

        // The mirror case: the switch says real values, one connector says no.
        state.mcp_outbound_unmask.store(true, SeqCst);
        unmask_override(&state, "fetch", None);
        assert!(!every_connector_masked(&state));
        unmask_override(&state, "fetch", Some(false));
        assert!(
            every_connector_masked(&state),
            "the only remote connector is masked, so the leak warning would be wrong"
        );

        // A LOCAL connector's override is about a seam that does not leave the
        // Mac, so it may not decide this note either way.
        state.mcp_outbound_unmask.store(false, SeqCst);
        unmask_override(&state, "files", Some(true));
        assert!(every_connector_masked(&state));

        // Nor may a connector that is switched off: nothing can be sent to it.
        {
            let mut mgr = state.mcp.lock().unwrap();
            mgr.servers[0].status = crate::mcp::Status::Disabled;
        }
        unmask_override(&state, "fetch", Some(true));
        assert!(
            every_connector_masked(&state),
            "a disabled connector receives nothing, so it cannot be the exception"
        );
        clear_policy();
    }

    #[test]
    fn rules_sha_changes_with_concepts_only() {
        let a = rules_sha(&["my health".into()]);
        let b = rules_sha(&["my health".into(), "my kids".into()]);
        let c = rules_sha(&["my kids".into(), "my health".into()]);
        assert_ne!(a, b);
        assert_eq!(b, c); // order-independent
    }

    /// The sidecar cannot see where the Ollama transport points, so the answer
    /// travels with the policy. Without it the Closet — a local-NAMED model
    /// aimed at another computer — reached the door reading "local" and nothing
    /// was redacted.
    #[test]
    fn the_payload_tells_the_sidecar_whether_the_transport_is_relayed() {
        let _guard = policy_test_lock();
        let state = PolicyState {
            active: true,
            rules: vec![],
            concepts: vec![],
            guard_model: "qwen3.5:4b".into(),
            redactor: Redactor::new(vec![]),
        };
        let sent = state.payload();
        assert_eq!(
            sent.get("relayed").and_then(|v| v.as_bool()),
            Some(!super::super::capabilities::ollama_runs_here()),
            "the wire must carry the transport verdict, not leave it to the name"
        );
    }

    #[test]
    fn inject_policy_needs_nonlocal_model_and_active_policy() {
        let _guard = policy_test_lock();
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

    /// THE CLOSET HOLE: the door asked the model NAME whether content was
    /// leaving. Point the room at another computer's Ollama (`set_ollama_url`)
    /// and the same `qwen3.5:4b` still read as local, so NO policy rode along —
    /// real names, whole documents and transcripts went to that box in the
    /// clear, while the trust chip said "Local only".
    #[test]
    fn a_relayed_ollama_gets_the_policy_even_with_a_local_model_name() {
        let _guard = policy_test_lock();
        let _base = crate::ollama::base_url_test_lock();
        crate::ollama::set_base_url_override(None);
        *policy_cell().lock().unwrap() = Some(Arc::new(PolicyState {
            active: true,
            rules: vec![("Ben Reich".into(), "[Person A]".into())],
            concepts: vec![],
            guard_model: "qwen3.5:4b".into(),
            redactor: Redactor::new(vec![("Ben Reich".into(), "[Person A]".into())]),
        }));
        let body = serde_json::json!({"model": "qwen3.5:4b", "text": "x"});
        assert!(inject_policy(&body).is_none(), "on this Mac: no door needed");

        crate::ollama::set_base_url_override(Some("http://192.168.1.20:11434".into()));
        let injected = inject_policy(&body).expect("a relayed request must carry the rules");
        assert_eq!(injected["privacy"]["rules"][0]["real"], "Ben Reich");

        crate::ollama::set_base_url_override(None);
        clear_policy();
    }

    #[test]
    fn an_empty_entity_map_still_arms_the_door() {
        // THE FRESH-ROOM HOLE: the door used to need at least one known entity
        // before it engaged at all. In a new room — nothing scanned, nothing on
        // the block list — the panel said "on" while the user's own topic rules
        // were never sent and photographs went to a cloud model in full.
        let _guard = policy_test_lock();
        clear_policy();
        set_policy_rules_for_test(true, vec![]);
        let policy = active_policy().expect("switch on: the door is armed with no entities");
        assert!(policy.redactor.is_empty());

        // The concepts + guard model reach the sidecar, which is what enforces
        // topic rules and strips images.
        let body = serde_json::json!({"model": "m:cloud", "text": "x"});
        let injected = inject_policy(&body).expect("a cloud call carries the policy");
        assert_eq!(injected["privacy"]["active"], true);
        assert!(injected["privacy"]["guard_model"].is_string());

        // And the vision picker stops offering a cloud model whose pixels the
        // door would silently drop — the false "The AI could not locate that in
        // this image" that `image_reaches_model` exists to prevent.
        assert!(!image_reaches_model("gpt-oss:120b-cloud"));
        assert!(image_reaches_model("qwen2.5vl:7b"));

        // The connector seam is the documented exception: with no entity map
        // there is genuinely nothing to mask, so it stays None.
        assert!(remote_seam_redactor().is_none());
        clear_policy();
    }

    #[test]
    fn accented_names_are_hidden_whatever_the_capitalisation() {
        // The two halves of the door folded case differently: aho-corasick's
        // `ascii_case_insensitive` folds A–Z only, while the sidecar's `re.I`
        // folds every script — so the Mac side (the "what the cloud sees"
        // preview and the outbound connector masking) let a differently-cased
        // accented or Hebrew name through in the real spelling.
        let r = Redactor::new(vec![
            ("José Muñoz".into(), "[Person A]".into()),
            ("Ürün".into(), "[Org A]".into()),
        ]);
        let mut report = PrivacyReport::default();
        let out = r.redact("JOSÉ MUÑOZ and josé muñoz both work at ÜRÜN", &mut report);
        assert!(!out.contains("MUÑOZ"), "{out}");
        assert!(!out.contains("muñoz"), "{out}");
        assert!(!out.contains("ÜRÜN"), "{out}");
        assert_eq!(out, "[Person A] and [Person A] both work at [Org A]");
        // Two distinct entities hidden, not four patterns.
        assert_eq!(report.entities_hidden, 2);
        assert_eq!(report.replacements, 3);
        // A placeholder still restores to the room's OWN spelling, not a variant.
        assert_eq!(r.restore("[Person A]"), "José Muñoz");
    }

    #[test]
    fn a_one_character_block_item_is_refused_not_silently_dropped() {
        // Settings accepted any text while the redactor dropped anything under
        // two characters — so the panel listed an item as protected that was
        // never hidden, and if it was the only one the whole door went quiet.
        assert!(!is_protectable("B"));
        assert!(!is_protectable("  x "));
        assert!(is_protectable("Ben"));
        // …and the redactor's own floor is the same rule, not a second one.
        let r = Redactor::new(vec![("B".into(), "[Person A]".into())]);
        assert!(r.is_empty());
    }
}
