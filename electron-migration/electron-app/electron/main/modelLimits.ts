/**
 * Max-context sizing for the external-CLI engines (claude-cli / codex-cli).
 *
 * Ported from `src-tauri/src/model_limits.rs` (37 lines, read in full). That
 * source carries no `#[cfg(test)]` module, so `modelLimits.test.ts` is fresh
 * coverage of the ported branch rather than a port of existing fixtures.
 *
 * Ollama (local + `:cloud`) needs no registry here — the sidecar reads each
 * model's advertised context length from Ollama's own catalog (see
 * `sidecar/arcelle_sidecar/chat.py` / `model_limits.py`), which this migration
 * does not touch.
 *
 * Confirmed live 2026-07-21 (smoke calls, not just `--help`):
 * `claude -p --output-format json` carries a real
 * `modelUsage.<model>.contextWindow` in its own response — read live per turn
 * (the Rust source's `external.rs::parse_claude_json_result`, not yet ported),
 * which is more accurate than any constant here, so
 * {@link CLAUDE_FALLBACK_MAX_CONTEXT} is used only when that field is absent
 * or unparseable.
 *
 * `codex exec --json`'s per-turn JSONL reports no window at all, but
 * `codex debug models`'s catalog carries a real `context_window` PER SLUG —
 * and different Codex models vary wildly (one live catalog entry reported
 * 1,050,000, another 272,000, so a single constant for "codex-cli" regardless
 * of which model is selected badly misrepresents the bar; confirmed by a live
 * user report 2026-07-21). The Rust source's `external.rs::codex_context_window`
 * reads that catalog (cached for the process lifetime) and is the PRIMARY
 * source for Codex; {@link CODEX_MAX_CONTEXT} below is only the last-resort
 * fallback for when that lookup fails — catalog unreachable, or a bare
 * "codex-cli" selection with no specific model/slug chosen at all.
 */

/** A conservative fallback for Claude Code, used only when the live per-turn
 * `modelUsage.<model>.contextWindow` field is absent or unparseable. */
export const CLAUDE_FALLBACK_MAX_CONTEXT = 200_000;

/** A conservative floor for when the live Codex catalog can't be read at all. */
export const CODEX_MAX_CONTEXT = 272_000;

/** Antigravity's current catalog contains one-million-token-class models. */
export const ANTIGRAVITY_MAX_CONTEXT = 1_048_576;

/**
 * The best-known max context for an external-CLI engine, absent a live hint
 * (see the module doc — for Codex, prefer the live catalog lookup first; this
 * is the fallback for when that returns nothing).
 *
 * Ported branch-for-branch from `model_limits.rs::external_max_context`: any
 * engine other than the exact string `"codex-cli"` — including `"claude-cli"`
 * and anything unrecognised — falls to the Claude constant, matching the Rust
 * `match`'s `_ =>` arm.
 */
export function externalMaxContext(engine: string): number {
  switch (engine) {
    case "codex-cli":
      return CODEX_MAX_CONTEXT;
    case "antigravity-cli":
      return ANTIGRAVITY_MAX_CONTEXT;
    default:
      return CLAUDE_FALLBACK_MAX_CONTEXT;
  }
}
