/** Cohesive extraction from sidecar.ts; its public API remains on that module. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, renameSync, unlinkSync, writeSync, closeSync, openSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Agent as UndiciAgent } from "undici";
import { TurnId, type EventSender } from "./turn.js";
import { HEALTH_POLL_INTERVAL_MS, HEALTH_TIMEOUT_MS, TOKEN_ENV, VISUAL_INDEX_DIR_ENV, authToken, busy, configuredVisualIndexDir, parsePortLine, probeOnce, sleep } from "./sidecarAuth.js";
import { LaunchCommand, drainStderr, launchCommand, mirrorStderr, recordRunningSidecar, stderrLogPath, stopIfOurs } from "./sidecarLifecycle.js";
import { SidecarOutcome, answerSoFar, finalOutcome, processLine } from "./sidecarProtocol.js";
import { RunViaSidecarOptions, streamRun } from "./sidecarRun.js";
import { splitCompleteLines } from "./sidecarStream.js";
// ------------------------------------------------------------- unavailable

/**
 * The sidecar-could-not-start error message. The `SIDECAR_UNAVAILABLE` head
 * is kept because it is the string surfaces above match on; the reason
 * follows it instead of being discarded, so a broken interpreter, a busy
 * port and a crash on import stop reading as the same blank failure.
 */
export function formatUnavailable(reason: string): string {
  return `SIDECAR_UNAVAILABLE: ${reason}`;
}

export function killQuietly(pid: number | null | undefined): void {
  if (pid === null || pid === undefined) {
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

/**
 * Read stdout line by line looking for the `SIDECAR_PORT=` handshake,
 * bounded by `timeoutMs` so a silent/hung child cannot wedge the caller
 * forever. Resolves `null` on timeout or if stdout ends first.
 */
export function readPortLine(stdout: NodeJS.ReadableStream, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    // See the matching comment in mirrorStderr(): an unlistened 'error' on an
    // EventEmitter throws, and this stream lives for the child's lifetime.
    stdout.on("error", () => {
      // Swallowed deliberately -- see comment above.
    });
    const rl = createInterface({ input: stdout });
    const timer = setTimeout(() => finish(null), timeoutMs);
    function finish(value: number | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      resolve(value);
    }
    rl.on("line", (line: string) => {
      const port = parsePortLine(line);
      if (port !== null) {
        finish(port);
      }
    });
    rl.on("close", () => finish(null));
  });
}

/**
 * Spawn the process, read stdout until it prints `SIDECAR_PORT=N`, then
 * confirm `/health`. The port line is how we learn the ephemeral port
 * without a bind-and-release race.
 *
 * On any failure the child is killed (never leaked) and the thrown Error's
 * message is `formatUnavailable(reason)`, i.e. always prefixed
 * `SIDECAR_UNAVAILABLE: `.
 */
export async function spawnAndWait(startTimeoutMs: number): Promise<string> {
  const launch = requiredLaunchCommand();
  const { child, port } = await startSidecar(launch, startTimeoutMs);
  return waitForHealthySidecar(child, port, startTimeoutMs);
}

export function requiredLaunchCommand(): LaunchCommand {
  const launch = launchCommand();
  if (launch !== null) {
    return launch;
  }
  throw new Error(
    formatUnavailable(
      "no sidecar to launch — no bundled binary in Resources/ and no ARCELLE_SIDECAR_PYTHON pointing at a Python with the package"
    )
  );
}

export async function startSidecar(
  launch: LaunchCommand,
  startTimeoutMs: number
): Promise<{ child: ChildProcess; port: number }> {
  const child = spawnSidecar(launch);
  const spawnFailure = sidecarSpawnFailure(child);
  drainSidecarDiagnostics(child);
  const port = await waitForSidecarPort(child, spawnFailure, startTimeoutMs);
  return { child, port };
}

export function spawnSidecar(launch: LaunchCommand): ChildProcess {
  return spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: sidecarEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function sidecarEnvironment(): NodeJS.ProcessEnv {
  const visualIndex =
    configuredVisualIndexDir === null ? {} : { [VISUAL_INDEX_DIR_ENV]: configuredVisualIndexDir };
  return { ...process.env, [TOKEN_ENV]: authToken(), ...visualIndex };
}

export function sidecarSpawnFailure(child: ChildProcess): Promise<never> {
  // Node's spawn() reports a bad executable asynchronously. Race that event
  // against the handshake so it reports the real error without burning the
  // entire start budget. Keep it observed after a successful handshake too:
  // this daemon outlives the race and a later error must not become an
  // unhandled rejection.
  const failure = new Promise<never>((_resolve, reject) => {
    child.once("error", (err) => {
      reject(new Error(formatUnavailable(`could not start the sidecar: ${err.message}`)));
    });
  });
  failure.catch(() => {});
  return failure;
}

export function drainSidecarDiagnostics(child: ChildProcess): void {
  // The diagnostic channel is mandatory to drain: an unread pipe can fill
  // and wedge the Python process before it has announced its port.
  if (child.stderr) {
    drainStderr(child.stderr);
  }
}

export async function waitForSidecarPort(
  child: ChildProcess,
  spawnFailure: Promise<never>,
  startTimeoutMs: number
): Promise<number> {
  if (!child.stdout) {
    killQuietly(child.pid);
    throw new Error(formatUnavailable("the sidecar's stdout could not be captured"));
  }
  try {
    const port = await Promise.race([readPortLine(child.stdout, startTimeoutMs), spawnFailure]);
    return requireSidecarPort(port, startTimeoutMs);
  } catch (err) {
    killQuietly(child.pid);
    throw err;
  }
}

export function requireSidecarPort(port: number | null, startTimeoutMs: number): number {
  if (port !== null) {
    return port;
  }
  throw new Error(
    formatUnavailable(
      `the sidecar printed no SIDECAR_PORT line within ${Math.round(
        startTimeoutMs / 1000
      )}s (see ${stderrLogPath()})`
    )
  );
}

export async function waitForHealthySidecar(
  child: ChildProcess,
  port: number,
  startTimeoutMs: number
): Promise<string> {
  const url = `http://127.0.0.1:${port}`;
  const start = Date.now();
  while (Date.now() - start < startTimeoutMs) {
    if ((await probeOnce(url, HEALTH_TIMEOUT_MS)) === "healthy") {
      return recordHealthySidecar(child, url);
    }
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }
  killQuietly(child.pid);
  throw new Error(
    formatUnavailable(
      `the sidecar announced port ${port} but never passed /health within ${Math.round(
        startTimeoutMs / 1000
      )}s (see ${stderrLogPath()})`
    )
  );
}

export function recordHealthySidecar(child: ChildProcess, url: string): string {
  // Node/libuv reaps the long-lived child automatically; we retain only the
  // PID needed by stopIfOurs() and its loopback URL.
  recordRunningSidecar(child.pid, url);
  return url;
}

// =====================================================================
// `/run` streaming RPC client
// =====================================================================
//
// Ported from the OTHER half of `src-tauri/src/sidecar.rs` (2331 lines) —
// NOT `sidecar_lifecycle.rs`, which everything above already covers. This is
// the POST /run NDJSON client: it posts to the Python sidecar's already-live
// `/run` endpoint, parses the newline-delimited JSON response stream, and
// turns each line into an `ask-*` event via `turn.ts`'s envelope, plus the
// `/cancel` delivery protocol that makes Stop actually stop the run.
//
// Structured the same way `sidecar.rs` itself is, and for the reason its own
// comments give — every exit path in here decides what the user's answer IS,
// and until that was testable the most load-bearing one (the sidecar's own
// terminal `error` event, which is how a long run ends in practice) could be
// reverted with the whole suite still green. So the pure decision logic —
// what does this SEQUENCE of parsed lines produce — lives in
// {@link processLine}/{@link finalOutcome}/{@link answerSoFar}, which take
// already-parsed JSON and know nothing about HTTP; the byte-level
// streaming/parsing/cancellation race lives in {@link streamRun} and
// {@link splitCompleteLines}, and nowhere else.
//
// OUT OF SCOPE for this batch, deliberately (each is a different unported
// Rust module's territory, not an oversight):
//   * The room MCP bridge's own lifecycle. `mcp: {url, token}` is a plain
//     field on {@link RunViaSidecarRequest}, not a live `mcpBridge.ts`
//     instance — nothing wires a real bridge to a live ask yet.
//   * `sticky_lanes`, the conversation-history routing heuristic (`agent.rs`
//     territory). `routing` is never sent on the wire AT ALL — see
//     {@link buildRunRequestBody} for why the key is omitted rather than
//     sent as null.
//   * The privacy door (`commands/privacy.rs`). `privacy` rides through as a
//     plain pass-through value, defaulting to `null` (the door-open state).
//   * Rust's `headless` total-suppression flag, the `EffectsSink`
//     tool-effect machinery, the local-Ollama-daemon wake-up, and
//     `obs::run_start`/`run_end`. A later batch's turn engine (`ask.ts`)
//     owns deciding what to persist from a {@link SidecarOutcome}; this
//     module only produces one. (`headless` has no separate spelling here
//     because `turn: null` already means "emit nothing" — see
//     {@link RunViaSidecarOptions.turn}.)

// ------------------------------------------------------------- wire request

/**
 * One chat-history message, exactly as `arcelle_sidecar.messages.Message`
 * (a `TypedDict`) declares it and as `crate::ollama::ChatMessage` already
 * serializes to on the Rust side. Deliberately snake_case — like
 * `AskTokenUsage` in `apiTypes.ts`, this is a WIRE pass-through shape, not a
 * camelCase-derived TS struct, so there is no field-rename step that could
 * silently drift from the Python model.
 */
export interface SidecarChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** assistant only: the raw Ollama-shaped tool_calls array. */
  tool_calls?: Record<string, unknown>[];
  /** tool only: which tool produced this result. */
  tool_name?: string;
  /** tool only: the id of the call this answers. */
  tool_call_id?: string;
  /** user only: base64 PNGs (Ollama reads images from user turns). */
  images?: string[];
}

/** The per-run room bridge `RunRequest.mcp` (`McpConfig` in `config.py`)
 * expects: a loopback URL plus a fresh bearer token. A plain field for now —
 * see the section banner. */
export interface RunViaSidecarMcp {
  url: string;
  token: string;
  /** Granted only by a run-scoped bridge after rollback baseline completion. */
  workspaceWrite?: boolean;
  /** Must equal this request's runId when workspaceWrite is true. */
  baselineRunId?: string;
}

/**
 * Everything `POST /run` needs, in the TS-idiomatic camelCase this module's
 * callers use. {@link buildRunRequestBody} is the one function that turns
 * this into the exact wire shape `RunRequest` (`config.py`) expects.
 */
export interface RunViaSidecarRequest {
  model: string;
  question: string;
  /** Provider-neutral agent runtime. Classic is the compatibility default. */
  harness?: "classic" | "deep";
  /** Defaults to `[]` on the wire, matching `RunRequest.messages`'s own
   * `Field(default_factory=list)`. */
  messages?: SidecarChatMessage[];
  temperature?: number | null;
  /** Defaults to `RunRequest.ollama_base_url`'s own pydantic default. */
  ollamaBaseUrl?: string;
  mcp: RunViaSidecarMcp;
  /** Host-authoritative routing decisions. Classic callers may omit this and
   * keep using the sidecar's deterministic text router. */
  routing?: {
    write?: boolean;
    ui?: boolean;
    jobs?: boolean;
    skills?: boolean;
    connectors?: boolean;
  };
  webEnabled?: boolean;
  /** Host-authoritative capability boundary. `none` means the empty MCP
   * catalog is intentional and the sidecar must not plan or delegate tools. */
  toolPolicy?: "auto" | "none";
  maxRounds?: number | null;
  /** Whole-ask runaway net across the delegation tree. */
  turnMaxRounds?: number | null;
  /** Consecutive no-progress rounds a loop may spend before it is made
   * tool-less. */
  turnMaxStalls?: number | null;
  /** The `/cancel` handle and the id every NDJSON line is stamped with
   * (`server.py`'s `stamped` helper) — the SAME id `TurnId.runId` carries
   * when this run belongs to a visible chat. */
  runId: string;
  /** PRIV-1 pass-through, out of scope for this batch — see the section
   * banner. `null` means the door is open (the ordinary local-model case). */
  privacy?: Record<string, unknown> | null;
  provider?: Record<string, unknown> | null;
  /** Host-resolved per-model image-input support. `null`/omitted means the
   * catalog was unavailable; an explicit false is authoritative. */
  supportsVision?: boolean | null;
  maxContext?: number | null;
  /** Defaults to `[]` on the wire, matching `RunRequest.advisors`'s own
   * `Field(default_factory=list)`. */
  advisors?: string[];
}

export function wireDefault<T>(value: T | null | undefined, fallback: T): T {
  return value ?? fallback;
}

export function wireMcp(mcp: RunViaSidecarMcp): Record<string, unknown> {
  return {
    url: mcp.url,
    token: mcp.token,
    workspace_write: wireDefault(mcp.workspaceWrite, false),
    baseline_run_id: wireDefault(mcp.baselineRunId, ""),
  };
}

export function wireRouting(routing: RunViaSidecarRequest["routing"]): Record<string, unknown> {
  return routing === undefined ? {} : { routing };
}

/**
 * Build the EXACT `POST /run` body — pure, and the thing to unit-test for
 * wire-shape drift without a live sidecar.
 *
 * Every key below is `RunRequest`'s own snake_case field name. That model
 * declares no pydantic aliasing (no `Field(alias=...)` anywhere on it) and
 * carries `extra="ignore"`, which is exactly what makes this function worth
 * having: a MISNAMED or stray field is a SILENT DROP on the Python side, not
 * a validation error, so "we sent it" and "it was read" are not the same
 * claim. Serializing a caller-shaped object straight to JSON would ship
 * whatever that object happened to hold and never say so.
 *
 * `routing` remains omitted when the caller has no host decision. Deep
 * Harness sends its explicit write permission because that UI decision,
 * protected by a completed rollback baseline, must beat prompt inference.
 */
export function buildRunRequestBody(req: RunViaSidecarRequest): Record<string, unknown> {
  return {
    model: req.model,
    question: req.question,
    harness: wireDefault(req.harness, "classic"),
    messages: wireDefault(req.messages, []),
    temperature: wireDefault(req.temperature, null),
    ollama_base_url: wireDefault(req.ollamaBaseUrl, "http://127.0.0.1:11434"),
    mcp: wireMcp(req.mcp),
    ...wireRouting(req.routing),
    web_enabled: wireDefault(req.webEnabled, false),
    tool_policy: wireDefault(req.toolPolicy, "auto"),
    max_rounds: wireDefault(req.maxRounds, null),
    turn_max_rounds: wireDefault(req.turnMaxRounds, null),
    turn_max_stalls: wireDefault(req.turnMaxStalls, null),
    run_id: req.runId,
    privacy: wireDefault(req.privacy, null),
    provider: wireDefault(req.provider, null),
    supports_vision: wireDefault(req.supportsVision, null),
    max_context: wireDefault(req.maxContext, null),
    advisors: wireDefault(req.advisors, []),
  };
}
