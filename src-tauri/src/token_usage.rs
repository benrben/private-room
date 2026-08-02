//! Token-budget bar accounting for the ONE thing the host still computes: the
//! placeholder snapshot shown immediately after a context handoff.
//!
//! Every real turn's usage is categorized SIDECAR-side, in `usage.py` — it is
//! the only thing that sees the messages actually sent per round, and it scales
//! its char estimate to the engine's own reported totals. This module used to
//! carry a full Rust twin of that categorization (five buckets keyed off a
//! hand-copied list of file/skill tool names someone had to keep in step with
//! `usage.py`, plus a real-total scaling branch) from the era when a
//! command-line cloud tool ran the room directly. That path is gone: the only
//! caller left is `handoff_chat`, which has exactly one message and no engine
//! usage at all, so all of it was unreachable.
//!
//! A handoff runs no LLM "ask" turn, so no `ask-token-usage` event fires on its
//! own and the bar would keep showing the PRE-handoff numbers until the user
//! asks something. This builds the interim snapshot out of the only thing
//! actually known — the recap the next turn starts from — and flags it
//! estimated, which the bar renders as "~".

/// chars/token — the cold-start floor, identical to `usage.py`'s
/// `CHARS_PER_TOKEN`. Deliberately low (undercounting bytes-per-token
/// overstates tokens, the safe direction): the app's MEASURED ratio lives in
/// the sidecar's process-global calibration (`model_limits.bytes_per_token`),
/// which the host cannot read.
pub(crate) const CHARS_PER_TOKEN: u64 = 3;

/// The 5 fixed breakdown categories, in the same order the frontend legend and
/// segment stack use. Never reordered.
pub(crate) const CATEGORIES: &[&str] = &["system", "history", "tools", "skills", "files"];

/// The post-handoff `AskTokenUsage` value (apiTypes.ts) — snake_case, matching
/// the sidecar-emitted shape exactly (see `usage.py::build_usage_event`).
///
/// The recap IS the whole conversation the next turn will start from, so it is
/// the `history` category. Everything else that turn will carry (system prompt,
/// skills preamble, memories, tool results) does not exist yet, so those
/// categories are honestly zero and the snapshot is `estimated` end to end —
/// the next real turn replaces it with the sidecar's measured numbers.
pub(crate) fn handoff_usage_value(recap: &str, max_context: u32) -> serde_json::Value {
    let history = recap.len() as u64 / CHARS_PER_TOKEN;
    let breakdown: serde_json::Map<String, serde_json::Value> = CATEGORIES
        .iter()
        .map(|c| {
            let tokens = if *c == "history" { history } else { 0 };
            (
                (*c).to_string(),
                serde_json::json!({ "tokens": tokens, "estimated": true }),
            )
        })
        .collect();
    serde_json::json!({
        "total_tokens": history,
        "max_context": max_context,
        "estimated": true,
        "breakdown": breakdown,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handoff_snapshot_charges_the_recap_to_history_only() {
        let v = handoff_usage_value("123456789", 8192);
        assert_eq!(v["total_tokens"], 3); // 9 bytes / 3
        assert_eq!(v["max_context"], 8192);
        assert_eq!(v["estimated"], true);
        assert_eq!(v["breakdown"]["history"]["tokens"], 3);
        // Nothing else exists yet — those categories must not be invented.
        for c in ["system", "tools", "skills", "files"] {
            assert_eq!(v["breakdown"][c]["tokens"], 0, "{c}");
            assert_eq!(v["breakdown"][c]["estimated"], true, "{c}");
        }
    }

    #[test]
    fn handoff_snapshot_keeps_every_legend_category() {
        // The frontend stacks segments in CATEGORY_ORDER; a missing key would
        // silently drop a segment, so the shape is pinned.
        let v = handoff_usage_value("", 1);
        let map = v["breakdown"].as_object().unwrap();
        assert_eq!(map.len(), CATEGORIES.len());
        for c in CATEGORIES {
            assert!(map.contains_key(*c), "missing {c}");
        }
        assert_eq!(v["total_tokens"], 0);
    }
}
