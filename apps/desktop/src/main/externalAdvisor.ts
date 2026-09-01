/**
 * ADD-21: the real `claude -p` / `codex exec` subprocess behind `execTool.ts`'s
 * `consult_advisor` arm.
 *
 * Ported from `src-tauri/src/commands/external.rs` — specifically
 * `run_external` (lines 643-892), its two output parsers
 * (`parse_claude_json_result` / `parse_codex_json_stream`, lines 932-1013),
 * the shell-safety gate it depends on (`is_cli_slug` / `check_cli_slug`,
 * lines 25-47), `ExternalUsage` (926-930), `CODEX_ARCELLE_FLAGS` (110-112)
 * and `TempWorkDir`'s cleanup-on-every-exit `Drop` (894-918).
 *
 * `execTool.ts`'s own `execConsultAdvisor` already ports everything else
 * about `consult_advisor` for real — the budget cap, the question
 * validation, the claude-vs-codex choice, and the "a failed advisor comes
 * back as Ok so the local model recovers" rule. The one thing it declares as
 * an injected seam, {@link ExecToolDeps.runAdvisorCli} ("actually run the
 * chosen advisor CLI"), is what this module supplies.
 *
 * =====================================================================
 * DELIBERATELY OUT OF SCOPE (a different feature, not a gap in this one)
 * =====================================================================
 * The model-CATALOG half of `external.rs` — `list_engine_models`,
 * `list_codex_models` / `parse_codex_catalog`, `list_claude_models` and its
 * whole `ClaudeCatalogScan` executable-string-table scrape,
 * `claude_fallback_models`, `codex_context_window`, `ExternalModelInfo`,
 * `is_cloud_model`, `detect_external_blocking`, `ollama_installed_blocking`
 * (roughly 700 of the file's 1387 lines). That serves the Cloud model PICKER
 * and onboarding CLI detection; `consult_advisor` never reads any of it (the
 * advisor always gets a BARE `"claude-cli"`/`"codex-cli"`, never a
 * `engine::model::effort` composite a picker chose). It is also the only
 * caller of `commands/providers.rs`'s `list_provider_models` — which is why
 * nothing here needs `providers.ts`, rather than stubbing it. A future batch
 * owns that half whole.
 *
 * =====================================================================
 * RECONCILIATION SEAMS — read before wiring a real subsystem through here
 * =====================================================================
 * - PRIV-1, the privacy door, is REAL and ON BY DEFAULT here: `privacy.ts`'s
 *   `activePolicy()` and `privacyRedact.ts`'s `Redactor` are the committed
 *   ports of `crate::commands::active_policy` and `PolicyState.redactor`, and
 *   {@link runExternalCli} calls them itself rather than waiting to be handed
 *   one — exactly as `run_external` does, and for the reason its own comment
 *   gives: EVERY caller of this function ships content to a cloud CLI, so the
 *   policy engages in the leaf regardless of which feature composed the
 *   messages. {@link RunExternalOptions.activePolicy} exists only to override
 *   that lookup (tests do), and it is a THUNK rather than a policy value
 *   because the app wires {@link realRunAdvisorCli} once at startup: a policy
 *   captured at wiring time would go stale the moment the user changed a
 *   room's privacy settings.
 * - {@link AdvisorBridge} stands in for the three `room_mcp::Bridge` members
 *   `run_external` reads (`mcp_config_json()`, `mcp_url()`, `token`).
 *   {@link adaptMcpBridge} builds a REAL one out of the already-committed
 *   {@link McpBridge} server (its real `.url` getter) plus the token its
 *   constructor was given — `McpBridge` keeps that token private, and the
 *   caller who built the bridge is holding it anyway. What does not exist yet
 *   is the process-lifecycle wiring that would START a per-ask advisor bridge
 *   (`mcpBridge.ts`'s own module doc flags the same gap), so no call site in
 *   this migration passes one yet; the option is real and tested against a
 *   live listening bridge for when one does.
 * - Cancellation is real here ({@link RunExternalOptions.cancel}), matching
 *   `agent.rs`'s own `run_external(engine, &msgs, cancel.clone(), …)`. No
 *   ported chat loop hands `execTool` a run-scoped cancel flag yet, so the
 *   default wiring passes none.
 *
 * TESTING: {@link RunExternalOptions.shell} / `.env` / `.spawnFn` are the
 * seams `externalAdvisor.test.ts` drives. Its subprocess tests are REAL —
 * a genuine `child_process.spawn` of a genuine POSIX shell running the exact
 * command line this module builds, against fake `claude`/`codex` scripts on a
 * scratch `PATH`. Only the shell itself is swapped (`/bin/sh -c` for
 * `zsh -ilc`): an interactive login shell sources the user's whole `.zshrc`,
 * which is slow, can trigger this repo's already-documented macOS TCC prompt
 * loop, and could PREPEND a directory that shadows the fake with a real,
 * account-billed `claude` binary.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { McpBridge } from "./mcpBridge.js";
import { activePolicy as activeRoomPolicy } from "./privacy.js";
import { emptyPrivacyReport, type PrivacyReport, type Redactor } from "./privacyRedact.js";
import type { SidecarChatMessage } from "./sidecar.js";
import { splitExternalModel } from "./turnContext.js";

// ------------------------------------------------------------ shell-safety gate

/**
 * `is_cli_slug` (external.rs lines 25-31), charset for charset: non-empty, at
 * most 64 chars, starts with an ASCII letter or digit, and every character is
 * an ASCII letter/digit or one of `- _ . : /`.
 *
 * Real values are picker slugs (`gpt-5.6-sol`, `opus`, `claude-opus-4-8`) and
 * effort levels (`high`, `xhigh`). This is deliberately narrower than
 * "escape the quotes" because there is no legitimate slug that needs a quote,
 * a space, a `$` or a `;`, and an allowlist cannot be out-thought the way an
 * escaper can.
 *
 * The anchors are safe without the `m` flag: unlike Perl/Python, JavaScript's
 * `$` matches only at the very end of the input, never before a trailing
 * newline — so `"opus\nrm -rf ~"` is rejected rather than read as `"opus"`.
 */
function isCliSlug(s: string): boolean {
  return s.length > 0 && s.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(s);
}

/**
 * `check_cli_slug` (external.rs lines 37-47). Absent/empty passes through as
 * `null` ("no model chosen"); a well-formed slug passes through unchanged;
 * anything else throws an error naming the field.
 *
 * The room's `model` setting travels inside a shareable room file, so this is
 * the boundary where a value stops being data and starts being shell: a
 * `.arcelle` someone sends you can arrive with `claude-cli::x'; curl … | sh; '`
 * already stored, and the very first chat turn would run it under `zsh -ilc`.
 * A value that fails is a HARD error rather than a dropped flag — silently
 * running a different model than the room says is exactly the kind of
 * unevidenced success this app doesn't do.
 */
export function checkCliSlug(v: string | null | undefined, field: string): string | null {
  if (v === null || v === undefined || v === "") {
    return null;
  }
  if (isCliSlug(v)) {
    return v;
  }
  throw new Error(
    `This room's ${field} setting isn't a valid name, so it was not run. ` +
      "Pick the engine again in Settings."
  );
}

// -------------------------------------------------------------- the command line

/**
 * `CODEX_ARCELLE_FLAGS` (external.rs lines 110-112), verbatim. Arcelle owns
 * the workspace and tool boundary for an embedded Codex turn: keep the
 * one-shot CLI ephemeral and read-only, ignore unrelated personal
 * plugins/MCP servers, and disable Codex's own web/shell tools so room access
 * can happen only through the scoped `room` bridge.
 */
export const CODEX_ARCELLE_FLAGS =
  " --ignore-user-config --ephemeral --skip-git-repo-check " +
  "--sandbox read-only -c 'approval_policy=\"never\"' --disable shell_tool " +
  "--disable unified_exec -c 'web_search=\"disabled\"'";

/** The CLI engines this module executes directly. `openrouter` is external
 * too, but runs through the provider-aware Python sidecar. */
export type CliEngine = "claude-cli" | "codex-cli" | "antigravity-cli";

export interface BuildCommandLineOptions {
  /** Already through {@link checkCliSlug} — this function interpolates, it
   * does not validate. */
  submodel: string | null;
  /** Already through {@link checkCliSlug}. */
  effort: string | null;
  /** Claude only: the `--mcp-config` file's path, when a room bridge is
   * attached. */
  mcpConfigPath?: string | null;
  /** Codex only: the `-c mcp_servers.room.*` overrides, when a room bridge is
   * attached. */
  codexMcpFlags?: string;
  /** Claude only: stdin is one stream-JSON user event carrying image content
   * blocks, rather than the ordinary flat-text prompt. */
  streamJsonInput?: boolean;
}

/**
 * The full command line handed to the shell for one cloud-CLI turn, from
 * `run_external`'s own `cmdline` match (external.rs lines 797-807).
 *
 * `--output-format json` / `--json` swap plain-text stdout for the
 * machine-readable envelope {@link parseClaudeJsonResult} /
 * {@link parseCodexJsonStream} read. Both parsers fall back to raw stdout as
 * plain text if the envelope doesn't parse, so a future CLI change can't turn
 * a successful answer into a hard failure — only into a plain-text,
 * usage-less one.
 *
 * The single quotes around the interpolated slugs are NOT what makes this
 * safe; {@link checkCliSlug} is. See its doc.
 */
function commandModelFlag(submodel: string | null): string {
  return submodel === null ? "" : ` --model '${submodel}'`;
}

function commandEffortFlag(engine: CliEngine, effort: string | null): string {
  if (effort === null || engine === "antigravity-cli") return "";
  if (engine === "claude-cli") return ` --effort '${effort}'`;
  return ` -c 'model_reasoning_effort=${effort}'`;
}

function claudeFormatFlags(streamJsonInput: boolean | undefined): string {
  return streamJsonInput === true
    ? "--input-format stream-json --output-format stream-json --verbose"
    : "--output-format json";
}

function claudeCommand(opts: BuildCommandLineOptions, modelFlag: string, effortFlag: string): string {
  const formatFlags = claudeFormatFlags(opts.streamJsonInput);
  if (opts.mcpConfigPath !== undefined && opts.mcpConfigPath !== null) {
    return (
      `claude -p ${formatFlags} --mcp-config '${opts.mcpConfigPath}' ` +
      `--strict-mcp-config --allowedTools 'mcp__room__*'${modelFlag}${effortFlag}`
    );
  }
  return `claude -p ${formatFlags}${modelFlag}${effortFlag}`;
}

export function buildCommandLine(engine: CliEngine, opts: BuildCommandLineOptions): string {
  const modelFlag = commandModelFlag(opts.submodel);
  const effortFlag = commandEffortFlag(engine, opts.effort);
  if (engine === "claude-cli") return claudeCommand(opts, modelFlag, effortFlag);
  if (engine === "antigravity-cli") {
    return `agy --sandbox --mode plan --input-format stream-json --output-format stream-json --print-timeout 5m${modelFlag}`;
  }
  return `codex exec --json${CODEX_ARCELLE_FLAGS}${opts.codexMcpFlags ?? ""}${modelFlag}${effortFlag} -`;
}
import { ExternalUsage, parseAntigravityJsonStream, parseClaudeJsonResult, parseCodexJsonStream } from "./externalAdvisorParsing.js";
export { parseClaudeJsonResult, parseCodexJsonStream, parseAntigravityJsonStream } from "./externalAdvisorParsing.js";
export type { ExternalUsage } from "./externalAdvisorParsing.js";


// -------------------------------------------------------- reconciliation seams

/**
 * The two `Redactor` methods `run_external` calls, as a structural shape:
 * the real {@link Redactor} satisfies it (pinned by {@link REDACTOR_FITS}
 * below), and a test can hand in a scripted stand-in without building a whole
 * rule table.
 */
export interface AdvisorPrivacyPolicy {
  /** Real values → placeholders, on the way OUT to the cloud CLI. */
  redact(text: string, report: PrivacyReport): string;
  /** Placeholders → real values, on the way back IN from the cloud CLI. */
  restore(text: string): string;
}

/** A compile-time check that the seam above is the real `Redactor`'s shape
 * and not a look-alike that has drifted from it. */
const REDACTOR_FITS: Redactor extends AdvisorPrivacyPolicy ? true : never = true;
void REDACTOR_FITS;

/** `commands::active_policy()` — the room's currently active redactor, or
 * `null`/`undefined` when cloud privacy is off or no room is open. Called per
 * turn; see the module doc for why this is a thunk. */
export type ActiveAdvisorPolicy = () => AdvisorPrivacyPolicy | null | undefined;

/** The real door: `privacy.ts`'s process-wide policy cell, which is `null`
 * unless the switch is on. Exactly `crate::commands::active_policy()`. */
const defaultActivePolicy: ActiveAdvisorPolicy = () => activeRoomPolicy()?.redactor ?? null;

/** The three `room_mcp::Bridge` members `run_external` reads. */
export interface AdvisorBridge {
  /** The `--mcp-config` JSON handed to Claude: one HTTP server, loopback,
   * bearer-token header. */
  mcpConfigJson(): string;
  /** The loopback URL Codex's `-c mcp_servers.room.url=…` points at. */
  mcpUrl(): string;
  readonly token: string;
}

/**
 * Adapts a REAL, already-listening {@link McpBridge} — the committed Node port
 * of the room bridge's HTTP server — into the {@link AdvisorBridge} shape
 * `run_external` needs, reproducing `Bridge::mcp_config_json`'s exact JSON
 * (room_mcp.rs lines 349-361).
 *
 * The token is a parameter rather than something read off the bridge because
 * `McpBridge` keeps its constructor options private; whoever built it passed
 * the token in and still holds it.
 */
export function adaptMcpBridge(bridge: McpBridge, token: string): AdvisorBridge {
  return {
    token,
    mcpUrl: () => bridge.url,
    mcpConfigJson: () =>
      JSON.stringify({
        mcpServers: {
          room: {
            type: "http",
            url: bridge.url,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      }),
  };
}

/** Structurally `cancel.ts`'s `CancelFlag` / `mcpBridge.ts`'s
 * `CancelFlagLike` — declared as a shape rather than a hard import, the same
 * choice `mcpBridge.ts` already made and documents. */
export interface CancelFlagLike {
  load(): boolean;
}

// --------------------------------------------------------------- subprocess DI

/**
 * The minimal slice of a spawned child process this module needs. A real Node
 * `ChildProcess` satisfies it structurally; a test supplies a fake or a real
 * one pointed at a scratch shell. Same DI idea `ytdlp.ts`'s `SpawnedProcess`
 * already uses, extended with `stdin` — `run_external` pipes the prompt in
 * rather than passing it as an argument.
 */
export interface AdvisorSpawnedProcess {
  readonly stdin: NodeJS.WritableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (err: Error) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export type AdvisorSpawnFn = (
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
) => AdvisorSpawnedProcess;

const realAdvisorSpawn: AdvisorSpawnFn = (command, args, opts) =>
  spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });

/**
 * Interactive login shell, matching `run_external`'s own `zsh -ilc`
 * (external.rs lines 814-820) and `detect_external_blocking`'s: from a GUI
 * launch the CLI is only on PATH via `.zshrc`, and the CLI also needs the
 * user's full env to reach its own subtools (git, node, …).
 */
const DEFAULT_SHELL: { command: string; args: readonly string[] } = { command: "zsh", args: ["-ilc"] };

/** How often the cancel watcher polls, matching `run_external`'s own
 * `std::thread::sleep(Duration::from_millis(100))` (external.rs line 854). */
const CANCEL_POLL_MS = 100;

/** How many characters of a failing CLI's stderr ride the error message —
 * `String::from_utf8_lossy(&out.stderr).chars().take(400)` (external.rs
 * lines 862-865). Counted in code points, like Rust's `chars()`, so a
 * multi-byte character is never cut in half. */
const STDERR_SNIPPET_CHARS = 400;

interface CliRunResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

type CliRunOutcome = { ok: true; result: CliRunResult } | { ok: false; error: string };

interface RunCliArgs {
  spawnFn: AdvisorSpawnFn;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdinText: string;
  engineName: string;
  cancel: CancelFlagLike | undefined;
}

/**
 * Spawn one shell command, pipe `stdinText` in, capture stdout/stderr as
 * bytes, and resolve once the child closes — the real subprocess half of
 * `run_external` (external.rs lines 814-881): real spawn, real write to
 * stdin, real output drain, and the same watcher-kills-on-cancel shape
 * (lines 841-857), reimplemented as a poll interval since Node has no
 * blocking `AtomicBool::load` loop to spawn a thread for.
 */
function runCli(a: RunCliArgs): Promise<CliRunOutcome> {
  return new Promise((resolve) => {
    let child: AdvisorSpawnedProcess;
    try {
      child = a.spawnFn(a.command, a.args, { cwd: a.cwd, env: a.env });
    } catch (e) {
      // Node's own `spawn` reports "no such file" asynchronously, but an
      // injected spawn function (or a bad `cwd`) can still throw here.
      resolve({ ok: false, error: `Could not start ${a.engineName}: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const asBuffer = (c: Buffer | string): Buffer => (typeof c === "string" ? Buffer.from(c, "utf8") : c);
    child.stdout?.on("data", (c: Buffer | string) => stdoutChunks.push(asBuffer(c)));
    child.stderr?.on("data", (c: Buffer | string) => stderrChunks.push(asBuffer(c)));

    let settled = false;
    let watcher: ReturnType<typeof setInterval> | undefined;
    const stopWatcher = (): void => {
      if (watcher !== undefined) {
        clearInterval(watcher);
        watcher = undefined;
      }
    };

    // A spawn failure emits 'error' and then 'close' (verified: Node reports
    // ENOENT as 'error' followed by close code -2). Settling on whichever
    // arrives first, while still preferring a recorded spawn error over a
    // bare exit code, is correct under either ordering and cannot hang if
    // only one of the two ever fires.
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      stopWatcher();
      resolve({ ok: false, error: `Could not start ${a.engineName}: ${err.message}` });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      stopWatcher();
      resolve({
        ok: true,
        result: { code, stdout: Buffer.concat(stdoutChunks), stderr: Buffer.concat(stderrChunks) },
      });
    });

    if (child.stdin !== null) {
      // A race — the child may exit before or while this write lands (an
      // immediately-failing CLI, or one that errors before reading stdin) —
      // surfaces as EPIPE on the stream, which is otherwise an UNHANDLED
      // 'error' event and takes the whole process down. The real failure is
      // already reported through 'error'/'close' above.
      child.stdin.on("error", () => {});
      try {
        child.stdin.end(a.stdinText, "utf8");
      } catch {
        // Surfaced via 'error'/'close' above.
      }
    }

    // ADD-7: the watcher kills the child on Stop, so a runaway cloud answer
    // ends promptly. Rust's watcher thread tests the flag BEFORE its first
    // sleep, so an already-set flag kills immediately rather than 100ms late.
    const cancel = a.cancel;
    if (cancel !== undefined) {
      const killNow = (): void => {
        if (settled) {
          stopWatcher();
          return;
        }
        if (!cancel.load()) return;
        stopWatcher();
        try {
          // The signal reaches the shell, which for a single command has
          // exec'd into the CLI itself — the same reach `run_external`'s own
          // `kill <pid>` has. A CLI that forked a grandchild would outlive
          // this; neither port claims otherwise.
          child.kill("SIGTERM");
        } catch {
          // Already gone.
        }
      };
      watcher = setInterval(killNow, CANCEL_POLL_MS);
      killNow();
    }
  });
}

// ------------------------------------------------------------------ run_external

/** `TempWorkDir`'s `Drop` (external.rs lines 902-918) — the scratch directory
 * holds DECRYPTED attachment images and, for Claude, the `--mcp-config` file
 * carrying the room bridge's bearer token, so removal runs on EVERY exit path
 * and is CHECKED: a directory that could not be removed says so rather than
 * being swallowed by a bare "best effort". */
async function cleanupScratchDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    return; // nothing was ever written (no images, no bridge config)
  }
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Reported by the existence check below rather than thrown — a stubborn
    // directory must not mask the real result or the real error.
  }
  if (existsSync(dir)) {
    console.error(
      `[externalAdvisor] could NOT remove the cloud-CLI scratch directory ${dir} — it may still ` +
        "hold decrypted attachments and the room bridge token"
    );
  }
}

/** `base64::engine::general_purpose::STANDARD.decode` — strict: standard
 * alphabet, canonical padding, no whitespace or newlines. Node's own
 * `Buffer.from(s, "base64")` is lenient (it skips characters it does not
 * recognise and never throws), which would turn a corrupt attachment into a
 * corrupt PNG written to disk and announced to the CLI as an image to open;
 * Rust's `if let Ok(bytes)` skips it instead. */
function decodeBase64Strict(s: string): Buffer | null {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
    return null;
  }
  return Buffer.from(s, "base64");
}

/** How many attachments per message are staged for the CLI to open —
 * `images.iter().take(3)` (external.rs line 701). */
const MAX_IMAGES_PER_MESSAGE = 3;

/** One Claude Code stream-JSON user event. Image bytes ride the same request
 * as base64 image content blocks, so vision does not depend on a filesystem
 * path or on Claude's Read tool being available. */
export function claudeImageUserEvent(prompt: string, images: readonly string[]): string {
  return `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text: prompt },
        ...images.map((data) => ({
          type: "image",
          source: { type: "base64", media_type: "image/png", data },
        })),
      ],
    },
  })}\n`;
}
export { runExternalCli, runAdvisorCli, makeRunAdvisorCli, realRunAdvisorCli } from "./externalAdvisorRun.js";
export type { RunExternalOptions, ExternalRunResult } from "./externalAdvisorRun.js";


export { CliRunOutcome, CliRunResult, DEFAULT_SHELL, MAX_IMAGES_PER_MESSAGE, RunCliArgs, STDERR_SNIPPET_CHARS, cleanupScratchDir, decodeBase64Strict, defaultActivePolicy, realAdvisorSpawn, runCli };
