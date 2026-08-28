import { describe, expect, it, vi } from "vitest";

import {
  detectExternalWith,
  ollamaInstalledWith,
  parseExternalCliPaths,
  type ShellProbe,
} from "./externalDetection.js";

describe("external AI-tool detection", () => {
  it("maps only exact claude/codex executable paths and de-duplicates them", () => {
    expect(parseExternalCliPaths("/opt/bin/claude\n/usr/bin/codex\n/opt/bin/agy\n/tmp/not-codex\nclaude\n")).toEqual([
      "claude-cli",
      "codex-cli",
      "antigravity-cli",
    ]);
  });

  it("uses the interactive-shell command without incorporating caller input", async () => {
    const probe = vi.fn<ShellProbe>().mockResolvedValue({ ok: true, stdout: "/Users/me/.local/bin/codex\n" });
    await expect(detectExternalWith(probe, () => false, "/Users/me")).resolves.toEqual(["codex-cli"]);
    expect(probe).toHaveBeenCalledWith("command -v claude; command -v codex; command -v agy");
  });

  it("falls back to standard macOS installer paths when a GUI shell probe misses them", async () => {
    const existing = new Set(["/Users/me/.local/bin/claude", "/opt/homebrew/bin/agy"]);
    await expect(
      detectExternalWith(async () => ({ ok: false, stdout: "" }), (candidate) => existing.has(candidate), "/Users/me"),
    ).resolves.toEqual(["claude-cli", "antigravity-cli"]);
  });

  it("recognizes either the Ollama app bundle or a successful CLI probe", async () => {
    const neverProbe = vi.fn<ShellProbe>();
    await expect(ollamaInstalledWith(neverProbe, () => true)).resolves.toBe(true);
    expect(neverProbe).not.toHaveBeenCalled();

    await expect(
      ollamaInstalledWith(async () => ({ ok: true, stdout: "/usr/local/bin/ollama\n" }), () => false),
    ).resolves.toBe(true);
    await expect(
      ollamaInstalledWith(async () => ({ ok: false, stdout: "" }), () => false),
    ).resolves.toBe(false);
  });
});
