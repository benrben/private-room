//! Max-context sizing for the external-CLI engines (claude-cli / codex-cli).
//!
//! Ollama (local + `:cloud`) needs no registry here — the sidecar self-reports
//! its own configured `num_ctx` as `max_context` on every usage event (see
//! `sidecar/arcelle_sidecar/chat.py`/`model_limits.py`), since only it knows
//! the RAM-adaptive window it actually requested.
//!
//! Confirmed live 2026-07-21 (smoke calls, not just `--help`):
//! `claude -p --output-format json` carries a real `modelUsage.<model>.
//! contextWindow` in its own response — read live per turn in
//! `external.rs::parse_claude_json_result`, which is more accurate than any
//! constant here, so `CLAUDE_FALLBACK_MAX_CONTEXT` is used only when that
//! field is absent/unparseable.
//!
//! `codex exec --json`'s per-turn JSONL reports no window at all, but
//! `codex debug models`'s catalog carries a real `context_window` PER SLUG —
//! and different Codex models vary wildly (one live catalog entry reported
//! 1,050,000, another 272,000 — a single constant for "codex-cli" regardless
//! of which model is selected badly misrepresents the bar, confirmed by a
//! live user report 2026-07-21). `external.rs::codex_context_window` reads
//! this catalog (cached for the process lifetime) and is the PRIMARY source
//! for Codex; `CODEX_MAX_CONTEXT` below is only the last-resort fallback when
//! that lookup fails (catalog unreachable, or a bare "codex-cli" selection
//! with no specific model/slug chosen at all).

pub(crate) const CLAUDE_FALLBACK_MAX_CONTEXT: u32 = 200_000;
//: A conservative floor for when the live Codex catalog can't be read at all.
pub(crate) const CODEX_MAX_CONTEXT: u32 = 272_000;

/// The best-known max context for an external-CLI engine, absent a live hint
/// (see the module doc — for Codex, prefer `external::codex_context_window`
/// first; this is the fallback when that returns `None`).
pub(crate) fn external_max_context(engine: &str) -> u32 {
    match engine {
        "codex-cli" => CODEX_MAX_CONTEXT,
        _ => CLAUDE_FALLBACK_MAX_CONTEXT,
    }
}
