import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import {
  detectExternalWith,
  detectedExternal,
  ollamaInstalled,
  ollamaInstalledWith,
  parseExternalCliPaths,
  runInteractiveZsh,
  type ShellProbe,
} from "./externalDetection.js";

function spawnedChild(): EventEmitter & { stdout: PassThrough; kill: ReturnType<typeof vi.fn> } {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn() });
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe("external AI-tool detection", () => {
  it("maps only exact claude/codex executable paths and de-duplicates them", () => {
    expect(parseExternalCliPaths("/opt/bin/claude\n/usr/bin/codex\n/opt/bin/agy\n/tmp/not-codex\nclaude\n")).toEqual([
      "claude-cli",
      "codex-cli",
      "antigravity-cli",
    ]);
  });

  it("keeps the first valid line's engine order and rejects near-miss basenames", () => {
    expect(parseExternalCliPaths(" /tmp/codexx\n/usr/bin/agy\nclaude-cli\n/opt/bin/claude\ncodex\n")).toEqual([
      "antigravity-cli",
      "claude-cli",
      "codex-cli",
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

describe("interactive probe lifecycle", () => {
  it("collects both Buffer and string stdout chunks, and settles on close", async () => {
    const child = spawnedChild();
    spawnMock.mockReturnValueOnce(child);
    const outcome = runInteractiveZsh("command -v codex");
    expect(spawnMock).toHaveBeenCalledWith("zsh", ["-ilc", "command -v codex"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout.emit("data", Buffer.from("/usr/bin/"));
    child.stdout.emit("data", "codex\n");
    child.emit("close", 0);
    await expect(outcome).resolves.toEqual({ ok: true, stdout: "/usr/bin/codex\n" });
  });

  it("settles on child errors and timeout kills", async () => {
    const failed = spawnedChild();
    spawnMock.mockReturnValueOnce(failed);
    const errorResult = runInteractiveZsh("command -v claude");
    failed.emit("error", new Error("spawn failed"));
    await expect(errorResult).resolves.toEqual({ ok: false, stdout: "" });

    vi.useFakeTimers();
    try {
      const timedOut = spawnedChild();
      spawnMock.mockReturnValueOnce(timedOut);
      const timeoutResult = runInteractiveZsh("command -v agy");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(timedOut.kill).toHaveBeenCalledWith("SIGKILL");
      await expect(timeoutResult).resolves.toEqual({ ok: false, stdout: "" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches successful default probes but clears a rejected probe for the next call", async () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error("probe failed");
    });
    await expect(detectedExternal()).rejects.toThrow("probe failed");

    const succeeded = spawnedChild();
    spawnMock.mockReturnValueOnce(succeeded);
    const second = detectedExternal();
    expect(detectedExternal()).toBe(second);
    succeeded.stdout.emit("data", "/usr/bin/codex\n");
    succeeded.emit("close", 0);
    await expect(second).resolves.toContain("codex-cli");
    await expect(detectedExternal()).resolves.toContain("codex-cli");
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("runs the default Ollama detector through the interactive probe when no app bundle exists", async () => {
    const child = spawnedChild();
    spawnMock.mockReturnValueOnce(child);
    const installed = ollamaInstalled();
    child.stdout.emit("data", "/usr/bin/ollama\n");
    child.emit("close", 0);
    await expect(installed).resolves.toBe(true);
  });
});
