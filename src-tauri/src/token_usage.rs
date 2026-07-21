//! Token-budget bar accounting for the external-CLI chat path (claude-cli /
//! codex-cli as the room's primary engine). The Ollama path (local + `:cloud`)
//! never touches this module — that categorization happens sidecar-side, in
//! `usage.py`, since the sidecar is the only thing that sees the messages
//! actually sent per round. `run_external` is one opaque call from Rust's
//! perspective (Claude/Codex run their own internal tool loop), so this
//! module categorizes the whole guarded message list once per turn, not per
//! round — the best available approximation for these engines.
//!
//! Mirrors `sidecar/arcelle_sidecar/usage.py` rule for rule; keep the two in
//! sync (same drift-risk precedent as `routing.py` vs `agent.rs`'s hint lists).

use crate::ollama;
use std::collections::BTreeMap;

//: chars/token — identical to ollama.rs's `job_context_chars` ratio and
//: usage.py's `CHARS_PER_TOKEN`.
pub(crate) const CHARS_PER_TOKEN: u64 = 3;

//: The built-in tools whose results are literal file text/excerpts
//: (agent.rs BUILTIN_TOOL_NAMES / room_mcp.rs).
const FILE_TOOL_NAMES: &[&str] = &["open_file", "search_room"];

//: Agent Skill CRUD/resource tools (routing.py::SKILL_TOOL_NAMES, mirrored).
const SKILL_TOOL_NAMES: &[&str] = &[
    "list_skills",
    "read_skill",
    "read_skill_resource",
    "save_skill",
    "write_skill_resource",
    "delete_skill_resource",
    "delete_skill",
    "run_skill_script",
];

//: The 5 fixed breakdown categories, in the same order the frontend legend
//: and segment stack use. Never reordered.
pub(crate) const CATEGORIES: &[&str] = &["system", "history", "tools", "skills", "files"];

fn msg_len(m: &ollama::ChatMessage) -> usize {
    let mut n = m.content.len();
    if let Some(tc) = &m.tool_calls {
        n += tc.to_string().len();
    }
    n
}

/// Bucket every message's byte length into one of the 5 categories. Unlike
/// the sidecar's per-round version, there is no "tools offered this round"
/// figure to seed `tools` with here (a single `run_external` call hides its
/// own internal tool-calling rounds from Rust) — `tools` only accumulates
/// actual tool-result message bytes.
pub(crate) fn categorize_messages(messages: &[ollama::ChatMessage]) -> BTreeMap<&'static str, u64> {
    let mut totals: BTreeMap<&'static str, u64> =
        CATEGORIES.iter().map(|c| (*c, 0u64)).collect();
    for m in messages {
        let n = msg_len(m) as u64;
        let bucket = match m.role.as_str() {
            "system" => "system",
            "tool" => {
                let name = m.tool_name.as_deref().unwrap_or("");
                if SKILL_TOOL_NAMES.contains(&name) {
                    "skills"
                } else if FILE_TOOL_NAMES.contains(&name) {
                    "files"
                } else {
                    "tools"
                }
            }
            "user" if m.images.as_ref().is_some_and(|v| !v.is_empty()) => "files",
            _ => "history",
        };
        *totals.get_mut(bucket).unwrap() += n;
    }
    totals
}

/// The `AskTokenUsage` JSON value (apiTypes.ts) — snake_case, matching the
/// sidecar-emitted shape exactly (see `sidecar/arcelle_sidecar/usage.py::
/// build_usage_event`, which this mirrors). `real_total` is the engine's own
/// reported prompt-token count for this turn, when available (`None` when
/// the engine reported nothing, e.g. a parse failure) — the char-based
/// per-category estimate is scaled to it when present, else shown as-is.
pub(crate) fn build_usage_value(
    real_total: Option<u64>,
    max_context: u32,
    breakdown_chars: &BTreeMap<&'static str, u64>,
) -> serde_json::Value {
    let est_breakdown: BTreeMap<&str, u64> = breakdown_chars
        .iter()
        .map(|(k, v)| (*k, v / CHARS_PER_TOKEN))
        .collect();
    let est_total: u64 = est_breakdown.values().sum();

    let (breakdown_map, total_tokens, estimated) = match real_total {
        Some(real) if est_total > 0 => {
            let map: serde_json::Map<String, serde_json::Value> = est_breakdown
                .iter()
                .map(|(k, v)| {
                    let scaled = ((*v as f64) * (real as f64) / (est_total as f64)).round() as u64;
                    (
                        (*k).to_string(),
                        serde_json::json!({ "tokens": scaled, "estimated": true }),
                    )
                })
                .collect();
            (map, real, false)
        }
        _ => {
            let map: serde_json::Map<String, serde_json::Value> = est_breakdown
                .iter()
                .map(|(k, v)| {
                    (
                        (*k).to_string(),
                        serde_json::json!({ "tokens": v, "estimated": true }),
                    )
                })
                .collect();
            (map, real_total.unwrap_or(est_total), real_total.is_none())
        }
    };

    serde_json::json!({
        "total_tokens": total_tokens,
        "max_context": max_context,
        "estimated": estimated,
        "breakdown": breakdown_map,
    })
}

/// Same contract as `build_usage_value`, for a turn where `breakdown_chars`
/// is structurally blind to some of the categories — an external-CLI turn's
/// `categorize_messages` never sees a `role: "tool"` message at all (Claude
/// Code/Codex run their own tool-calling loop inside the subprocess, entirely
/// invisible to Rust), so its estimate only ever has `system`/`history`
/// populated. Naively scaling every category proportionally to a real total
/// (as `build_usage_value` does) would then smear ALL of that invisible
/// tool/file activity onto `system`/`history` instead — reported live
/// 2026-07-21 as "shows all system prompt and history, no tools, no
/// anything." Any real total beyond the visible estimate is attributed
/// entirely to `gap_bucket` instead — for these engines that's overwhelmingly
/// the CLI's own tool-calling/file-reading overhead, so `"tools"` is the
/// closest honest label, not a proportional guess across categories that
/// were never actually measured.
pub(crate) fn build_usage_value_opaque_gap(
    real_total: Option<u64>,
    max_context: u32,
    breakdown_chars: &BTreeMap<&'static str, u64>,
    gap_bucket: &'static str,
) -> serde_json::Value {
    let mut est_breakdown: BTreeMap<&str, u64> = breakdown_chars
        .iter()
        .map(|(k, v)| (*k, v / CHARS_PER_TOKEN))
        .collect();
    let est_total: u64 = est_breakdown.values().sum();

    let (total_tokens, estimated) = match real_total {
        Some(real) if real > est_total => {
            *est_breakdown.entry(gap_bucket).or_insert(0) += real - est_total;
            (real, false)
        }
        Some(real) if est_total > 0 => {
            // Real total known but doesn't exceed the visible estimate (rare
            // for an external CLI, but not impossible) — proportional scaling
            // is fine here since there's no gap to misattribute.
            for v in est_breakdown.values_mut() {
                *v = ((*v as f64) * (real as f64) / (est_total as f64)).round() as u64;
            }
            (real, false)
        }
        Some(real) => (real, false),
        None => (est_total, true),
    };

    let breakdown_map: serde_json::Map<String, serde_json::Value> = est_breakdown
        .iter()
        .map(|(k, v)| ((*k).to_string(), serde_json::json!({ "tokens": v, "estimated": true })))
        .collect();

    serde_json::json!({
        "total_tokens": total_tokens,
        "max_context": max_context,
        "estimated": estimated,
        "breakdown": breakdown_map,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool_msg(name: &str, content: &str) -> ollama::ChatMessage {
        let mut m = ollama::ChatMessage::new("tool", content);
        m.tool_name = Some(name.to_string());
        m
    }

    #[test]
    fn categorize_messages_buckets_by_role_and_tool_name() {
        let messages = vec![
            ollama::ChatMessage::new("system", "sys"),        // -> system
            ollama::ChatMessage::new("user", "hello"),        // -> history
            ollama::ChatMessage::new("assistant", "hi"),      // -> history
            tool_msg("search_room", "found stuff"),           // -> files
            tool_msg("open_file", "file text"),                // -> files
            tool_msg("list_skills", "skill catalog"),          // -> skills
            tool_msg("edit_file", "edit result"),              // -> tools (neither file nor skill tool)
        ];
        let totals = categorize_messages(&messages);
        assert_eq!(totals["system"], 3);
        assert_eq!(totals["history"], 5 + 2); // "hello" + "hi"
        assert_eq!(totals["files"], "found stuff".len() as u64 + "file text".len() as u64);
        assert_eq!(totals["skills"], "skill catalog".len() as u64);
        assert_eq!(totals["tools"], "edit result".len() as u64);
    }

    #[test]
    fn categorize_messages_buckets_image_bearing_user_turns_as_files() {
        let mut m = ollama::ChatMessage::new("user", "[capture]");
        m.images = Some(vec!["b64".to_string()]);
        let totals = categorize_messages(&[m]);
        assert_eq!(totals["files"], "[capture]".len() as u64);
        assert_eq!(totals["history"], 0);
    }

    #[test]
    fn build_usage_value_scales_estimate_to_a_real_total() {
        let mut chars: BTreeMap<&'static str, u64> = BTreeMap::new();
        chars.insert("system", 30); // -> 10 est tokens
        chars.insert("history", 60); // -> 20 est tokens
        chars.insert("tools", 0);
        chars.insert("skills", 0);
        chars.insert("files", 0);
        // est_total = 30 tokens; real total is double that -> each category doubles.
        let v = build_usage_value(Some(60), 8192, &chars);
        assert_eq!(v["total_tokens"], 60);
        assert_eq!(v["estimated"], false);
        assert_eq!(v["breakdown"]["system"]["tokens"], 20);
        assert_eq!(v["breakdown"]["history"]["tokens"], 40);
        assert_eq!(v["max_context"], 8192);
    }

    #[test]
    fn build_usage_value_falls_back_to_the_raw_estimate_with_no_real_total() {
        let mut chars: BTreeMap<&'static str, u64> = BTreeMap::new();
        chars.insert("system", 9); // -> 3 est tokens
        for k in ["history", "tools", "skills", "files"] {
            chars.insert(k, 0);
        }
        let v = build_usage_value(None, 8192, &chars);
        assert_eq!(v["estimated"], true);
        assert_eq!(v["total_tokens"], 3);
        assert_eq!(v["breakdown"]["system"]["tokens"], 3);
    }

    #[test]
    fn opaque_gap_attributes_the_surplus_to_the_gap_bucket_not_proportionally() {
        // An external-CLI turn: categorize_messages never sees a role:"tool"
        // message, so only system/history are ever nonzero here.
        let mut chars: BTreeMap<&'static str, u64> = BTreeMap::new();
        chars.insert("system", 300); // -> 100 est tokens
        chars.insert("history", 600); // -> 200 est tokens
        chars.insert("tools", 0);
        chars.insert("skills", 0);
        chars.insert("files", 0);
        // Real total is far larger than the visible estimate (300 tokens) —
        // the CLI did a lot of invisible tool/file work this turn.
        let v = build_usage_value_opaque_gap(Some(5_300), 1_050_000, &chars, "tools");
        assert_eq!(v["total_tokens"], 5300);
        assert_eq!(v["max_context"], 1_050_000);
        assert_eq!(v["estimated"], false);
        // system/history keep their OWN estimated values — not scaled up.
        assert_eq!(v["breakdown"]["system"]["tokens"], 100);
        assert_eq!(v["breakdown"]["history"]["tokens"], 200);
        // The entire gap (5300 - 300 = 5000) lands on the gap bucket, not
        // smeared across every category.
        assert_eq!(v["breakdown"]["tools"]["tokens"], 5000);
        assert_eq!(v["breakdown"]["skills"]["tokens"], 0);
        assert_eq!(v["breakdown"]["files"]["tokens"], 0);
    }

    #[test]
    fn opaque_gap_scales_proportionally_when_real_total_is_not_a_surplus() {
        let mut chars: BTreeMap<&'static str, u64> = BTreeMap::new();
        chars.insert("system", 30); // -> 10 est tokens
        chars.insert("history", 60); // -> 20 est tokens
        chars.insert("tools", 0);
        chars.insert("skills", 0);
        chars.insert("files", 0);
        // Real total (20) is LESS than the visible estimate (30) — no gap to
        // misattribute, so this falls back to proportional scaling.
        let v = build_usage_value_opaque_gap(Some(20), 8192, &chars, "tools");
        assert_eq!(v["total_tokens"], 20);
        assert_eq!(v["breakdown"]["system"]["tokens"], 7); // round(10 * 20/30)
        assert_eq!(v["breakdown"]["history"]["tokens"], 13); // round(20 * 20/30)
        assert_eq!(v["breakdown"]["tools"]["tokens"], 0);
    }

    #[test]
    fn opaque_gap_falls_back_to_the_raw_estimate_with_no_real_total() {
        let mut chars: BTreeMap<&'static str, u64> = BTreeMap::new();
        chars.insert("system", 9); // -> 3 est tokens
        for k in ["history", "tools", "skills", "files"] {
            chars.insert(k, 0);
        }
        let v = build_usage_value_opaque_gap(None, 8192, &chars, "tools");
        assert_eq!(v["estimated"], true);
        assert_eq!(v["total_tokens"], 3);
        assert_eq!(v["breakdown"]["system"]["tokens"], 3);
    }
}
