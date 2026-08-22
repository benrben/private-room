/**
 * Tests for `modelLimits.ts`, ported from `src-tauri/src/model_limits.rs`.
 *
 * The Rust source has no `#[cfg(test)]` fixtures of its own (it is a
 * two-constant, one-branch file), so this suite is written fresh against the
 * contract its module doc states.
 */
import { describe, expect, it } from "vitest";
import { CLAUDE_FALLBACK_MAX_CONTEXT, CODEX_MAX_CONTEXT, externalMaxContext } from "./modelLimits.js";

describe("CLAUDE_FALLBACK_MAX_CONTEXT / CODEX_MAX_CONTEXT", () => {
  it("match the values recorded live in the Rust source", () => {
    // Pinned as literals, not against the exports themselves: an assertion
    // that reads the constant it is checking can never fail.
    expect(CLAUDE_FALLBACK_MAX_CONTEXT).toBe(200_000);
    expect(CODEX_MAX_CONTEXT).toBe(272_000);
  });
});

describe("externalMaxContext", () => {
  it("returns the Codex constant for codex-cli", () => {
    expect(externalMaxContext("codex-cli")).toBe(272_000);
  });

  it("returns the Claude fallback for claude-cli", () => {
    expect(externalMaxContext("claude-cli")).toBe(200_000);
  });

  it("falls through to the Claude fallback for any other engine id, matching the Rust `_` arm", () => {
    expect(externalMaxContext("openrouter")).toBe(200_000);
    expect(externalMaxContext("qwen3.5:4b")).toBe(200_000);
    expect(externalMaxContext("")).toBe(200_000);
  });

  it("is case-sensitive: 'Codex-CLI' is not 'codex-cli'", () => {
    expect(externalMaxContext("Codex-CLI")).toBe(200_000);
  });
});
