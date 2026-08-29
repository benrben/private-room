/**
 * Manage the local Python/LangGraph agent sidecar, AND drive one answer
 * through it. Two halves, ported from two different Rust files:
 *
 * 1. PROCESS LIFECYCLE — ported from `src-tauri/src/sidecar_lifecycle.rs`
 *    (617 lines). Everything from here down to {@link spawnAndWait}.
 * 2. THE `/run` NDJSON STREAMING CLIENT — ported from the OTHER half of
 *    `src-tauri/src/sidecar.rs` (2331 lines), specifically its
 *    `stream_run`/`run_via_sidecar` pair. Everything below the
 *    "`/run` streaming RPC client" banner near the end of this file.
 *
 * The two live together because half of what the second one does is call the
 * first: {@link runViaSidecar} resolves a base URL through {@link ensureUp}
 * and holds a {@link busy} guard for the whole streaming answer, which is the
 * one thing that stops another task's health probe SIGTERMing the process
 * mid-reply.
 *
 * The sidecar is the app's SOLE AI engine — not an option and not a
 * preference. If this module cannot start the process the app cannot
 * answer at all; there is nothing to fall back to. This module owns the
 * process — spawn it on demand, learn the loopback port it chose, hand out
 * its base URL, and SIGTERM it on app exit.
 *
 * Same safety rule as the Rust source's `ollama_lifecycle` sibling: we only
 * ever stop a process WE spawned, and it is bound to `127.0.0.1` only. The
 * sidecar never sees the room key — it reaches the room's tools solely
 * through the token-guarded loopback MCP bridge.
 *
 * TEMPORARY LOCATION: this file currently lives in the migration workspace
 * (`apps/desktop/src/main/sidecar.ts`) so it can be
 * built and tested standalone against the shared contract before cutover.
 * Once the migration lands this moves to `src/main/sidecar.ts` at the
 * repo root, replacing `src-tauri` entirely — see {@link defaultDevSidecarDir}
 * for the one path computation that has to change along with it.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, renameSync, unlinkSync, writeSync, closeSync, openSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Agent as UndiciAgent } from "undici";
import { TurnId, type EventSender } from "./turn.js";

// Node's global fetch (undici) applies a 300s default `bodyTimeout` measured as
// inactivity *between* body chunks. Rust's `stream_run` builds its client with
// `reqwest::Client::builder().build()` -- no timeout, so it waits indefinitely
// between NDJSON lines. A `/run` stream can legitimately go quiet for minutes
// (a long bridge tool call, a sectioned full-pass compose at ~30min/book on a
// local 4B) with the sidecar still alive and working; without this, that
// stream is torn down mid-run with only the partial answer, and `/cancel` is
// never sent for it since the transport-failure path doesn't call it -- the
// Python run keeps burning the single local-model slot with nothing listening.
const RUN_STREAM_DISPATCHER = new UndiciAgent({ bodyTimeout: 0, headersTimeout: 0 });

// --------------------------------------------------------------- token

/** The environment variable the sidecar reads its shared secret from. */
export const TOKEN_ENV = "ARCELLE_SIDECAR_TOKEN";
export const VISUAL_INDEX_DIR_ENV = "ARCELLE_VISUAL_INDEX_DIR";

let cachedToken: string | null = null;
let configuredVisualIndexDir: string | null = null;

/** Pin the derived visual cache under Electron's trusted app-data root. The
 * sidecar API deliberately accepts no caller-selected cache path; only this
 * launch-time environment value can choose it. */
export function configureVisualIndexDir(userDataDir: string): void {
  configuredVisualIndexDir = path.join(path.resolve(userDataDir), "visual-index-v1");
}

/**
 * The shared secret every sidecar this app process spawns is given, and
 * that every request of ours carries.
 *
 * The port is loopback-only, but on a Mac loopback is not a boundary:
 * without this, any other program running as the user could drive the
 * agent — start runs, generate text, search the web, delete downloaded
 * models. Minted once per app process (two v4 UUIDs = 244 random bits),
 * handed over in the child's ENVIRONMENT so it never reaches stdout, the
 * stderr log or disk, and never logged here either.
 */
export function authToken(): string {
  if (cachedToken === null) {
    cachedToken = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  }
  return cachedToken;
}

/**
 * Stamp our token on a sidecar request. EVERY request to the sidecar goes
 * through here — a call site that forgets it gets a 401 instead of an
 * answer, so this is the one place the header is spelled. Node's `fetch`
 * takes a headers object rather than reqwest's request-builder pattern, so
 * this is the idiomatic TS shape of the Rust `authed()` helper rather than
 * a literal port of its signature.
 */
export function authedHeaders(): Record<string, string> {
  return { authorization: `Bearer ${authToken()}` };
}

// ------------------------------------------------------------- busy guard

let inflight = 0;

/**
 * RAII marker for ONE request we have in flight on the sidecar, mirroring
 * the Rust `Busy` guard. Every caller of {@link ensureUp} takes one and
 * holds it for the whole duration of its HTTP call — a streaming answer, a
 * ten-hour file pass — so {@link ensureUp} on another task cannot SIGTERM
 * the process that is serving it.
 *
 * TypeScript has no `Drop`, so callers MUST release it themselves —
 * always in a `finally` block:
 *
 * ```ts
 * const guard = busy();
 * try {
 *   await doSidecarRequest();
 * } finally {
 *   guard.release();
 * }
 * ```
 *
 * (A `Symbol.dispose`-based "using" declaration would read closer to the
 * Rust RAII shape, but is skipped deliberately: it needs `esnext.disposable`
 * lib support this tsconfig does not opt into, and plain try/finally is
 * unambiguous everywhere Node >=22 runs.)
 */
export function busy(): { release: () => void } {
  inflight += 1;
  let released = false;
  return {
    release: () => {
      // Idempotent: a caller calling release() twice (e.g. a bug in a
      // retry path) must not double-decrement and desync the counter from
      // reality. The Rust Drop impl is inherently single-fire; this guard
      // is the TS equivalent safety net.
      if (released) return;
      released = true;
      inflight -= 1;
    },
  };
}

/** Exported for testing only. */
export function inflightCount(): number {
  return inflight;
}

// ------------------------------------------------------------- port line

/** Parse the `SIDECAR_PORT=NNNN` handshake line the sidecar prints on startup. */
export function parsePortLine(line: string): number | null {
  const prefix = "SIDECAR_PORT=";
  const trimmed = line.trim();
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  const rest = trimmed.slice(prefix.length).trim();
  if (!/^\d+$/.test(rest)) {
    return null;
  }
  const port = Number(rest);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return null;
  }
  return port;
}

// ------------------------------------------------------------- probing

/** What one `/health` probe of a recorded sidecar found. */
export type Probe = "healthy" | "busy" | "gone";

/** How long one probe waits for `/health`. */
const HEALTH_TIMEOUT_MS = 1500;
/** How many probes a recorded sidecar gets before we act on the answer, and
 * the gap between them. One missed probe is not evidence of anything; only
 * the healthy path is hot, and it returns on the first attempt. */
const PROBE_ATTEMPTS = 3;
const PROBE_GAP_MS = 300;
/** How long to wait for a freshly spawned sidecar to announce its port and
 * pass a health check before giving up (Python import of langgraph is not
 * instant). */
const START_TIMEOUT_MS = 30_000;
/** How often to poll `/health` while waiting for a freshly spawned sidecar. */
const HEALTH_POLL_INTERVAL_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Walk an error's `.cause` chain looking for a POSIX `ECONNREFUSED`. Node's
 * `fetch` (undici) wraps a refused loopback connection as
 * `TypeError: fetch failed` with `.cause` set to the underlying
 * `Error: connect ECONNREFUSED ...`; this is the TS equivalent of reqwest's
 * `Error::is_connect()`.
 */
function isConnectionRefused(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 8 && cur != null; i++) {
    if ((cur as { code?: unknown }).code === "ECONNREFUSED") {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Should a recorded sidecar be SIGTERMed and replaced? Pure, so the policy
 * is testable without a process: a live-but-busy sidecar is replaced only
 * when nothing of ours is riding on it (otherwise the kill takes down a
 * streaming answer or a running job), while one that is gone has nothing
 * to protect.
 */
export function shouldReplace(verdict: Probe, inflightNow: number): boolean {
  switch (verdict) {
    case "healthy":
      return false;
    case "busy":
      return inflightNow === 0;
    case "gone":
      return true;
  }
}

/**
 * One `/health` probe, classified. Anything that is NOT a refused
 * connection counts as ALIVE: an answer we could not parse, a non-2xx
 * status and a timeout all came from a process that is still there.
 */
export async function probeOnce(baseUrl: string, timeoutMs: number): Promise<Probe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let resp: Response;
    try {
      resp = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    } catch (err) {
      return isConnectionRefused(err) ? "gone" : "busy";
    }
    if (!resp.ok) {
      return "busy";
    }
    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      return "busy";
    }
    const ok =
      typeof body === "object" &&
      body !== null &&
      (body as Record<string, unknown>).ok === true;
    return ok ? "healthy" : "busy";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe a recorded sidecar up to {@link PROBE_ATTEMPTS} times. Any healthy
 * answer wins immediately. Otherwise the result is a FOLD, not a majority
 * vote: the verdict starts at "gone" and is raised to "busy" the moment any
 * attempt sees a live-but-unconfirmed answer, and nothing brings it back
 * down — a single accepted-but-silent attempt is enough to rule out "the
 * process is gone" for good, because a dead port refuses instantly and
 * would never have produced that "busy" reading in the first place.
 */
export async function probeRecorded(baseUrl: string): Promise<Probe> {
  let verdict: Probe = "gone";
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
    const result = await probeOnce(baseUrl, HEALTH_TIMEOUT_MS);
    if (result === "healthy") {
      return "healthy";
    }
    if (result === "busy") {
      verdict = "busy";
    }
    if (attempt + 1 < PROBE_ATTEMPTS) {
      await sleep(PROBE_GAP_MS);
    }
  }
  return verdict;
}

// ------------------------------------------------------------- lifecycle state

/** PID of the sidecar child WE spawned, or `null` when not running. */
let ourPid: number | null = null;
/** The base URL (`http://127.0.0.1:PORT`) of the running sidecar, once known. */
let recordedBaseUrl: string | null = null;
/** Single-flight guard: two concurrent {@link ensureUp} calls must await the
 * SAME spawn attempt rather than each launching a sidecar. TS equivalent of
 * the Rust `tokio::sync::Mutex` guard — a shared promise instead of a lock,
 * since Node has no threads to serialize. */
let spawningPromise: Promise<string> | null = null;

function currentBaseUrl(): string | null {
  return recordedBaseUrl;
}

/**
 * The recorded sidecar's base URL, WITHOUT starting one. Ported from
 * `sidecar_lifecycle::base_url_if_running` — the one function of that Rust
 * file this port had not yet carried over (everything else in it lives
 * above, as this file's own module doc explains).
 *
 * {@link ensureUp} is the wrong door for teardown work: locking a room must
 * never spawn the AI service just to tell it to forget something, and
 * "there is no sidecar" is the same outcome as "it forgot". This is the
 * accessor a fire-and-forget caller like `sidecar::forget_room_memory`
 * (Rust) reaches for instead — read-only, no spawn, no probe.
 */
export function baseUrlIfRunning(): string | null {
  return currentBaseUrl();
}

/** Best-effort room-teardown purge; never starts a sidecar merely to forget. */
export function forgetRoomMemory(): void {
  const base = currentBaseUrl();
  if (base === null) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  timer.unref?.();
  void fetch(`${base}/forget`, {
    method: "POST",
    headers: { ...authedHeaders(), "content-type": "application/json" },
    body: "{}",
    signal: controller.signal,
  }).then((response) => {
    if (!response.ok) console.error(`[sidecar] /forget refused (status ${response.status})`);
  }).catch((error: unknown) => {
    console.error("[sidecar] /forget did not reach the AI service:", error instanceof Error ? error.message : String(error));
  }).finally(() => clearTimeout(timer));
}

/**
 * Stop the sidecar WE spawned (if any) and forget what we knew about it.
 * Used both by {@link ensureUp}'s replace path and by {@link stopIfOurs}.
 */
function stopOurs(): void {
  const pid = ourPid;
  ourPid = null;
  recordedBaseUrl = null;
  if (pid !== null) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone — nothing to do.
    }
  }
}

/**
 * Ensure a sidecar is up and return its base URL. If one we started is
 * already running, reuse it. Otherwise spawn it, read the `SIDECAR_PORT=`
 * line it prints on stdout, and health-check it. Throws when the sidecar
 * could not start, and there is nothing behind it — the caller surfaces an
 * error to the user.
 *
 * Callers must take a {@link busy} guard for the lifetime of the request
 * they then make, so a concurrent `ensureUp` can see that the sidecar is
 * serving something before it decides to replace it.
 */
export async function ensureUp(): Promise<string> {
  const recorded = currentBaseUrl();
  if (recorded !== null) {
    const verdict = await probeRecorded(recorded);
    if (verdict === "healthy") {
      return recorded;
    }
    if (!shouldReplace(verdict, inflightCount())) {
      // It accepted the connection, so the process is alive — it is merely
      // busy — and requests of ours are riding on it. Ride on it too: the
      // caller's own budget decides, rather than this probe killing an
      // answer that is mid-stream.
      return recorded;
    }
    // A recorded sidecar that is genuinely gone, or wedged with nothing of
    // ours riding on it: STOP it, then respawn. Merely forgetting it left a
    // wedged Python process holding its port, its resident memory and its
    // Ollama connection until the Mac was restarted.
    stopOurs();
  }

  if (spawningPromise !== null) {
    return spawningPromise;
  }

  spawningPromise = (async (): Promise<string> => {
    try {
      // Re-check the recorded URL once more now that we hold the spawn
      // slot: another caller may have just finished spawning while we were
      // awaiting the probe above.
      const maybeAlreadyUp = currentBaseUrl();
      if (maybeAlreadyUp !== null) {
        const healthy = (await probeOnce(maybeAlreadyUp, HEALTH_TIMEOUT_MS)) === "healthy";
        if (healthy) {
          return maybeAlreadyUp;
        }
      }
      return await spawnAndWait(START_TIMEOUT_MS);
    } finally {
      spawningPromise = null;
    }
  })();

  return spawningPromise;
}

/**
 * Stop a sidecar we started — used on app shutdown so we never leak a
 * background Python process we spawned. A no-op if none is running.
 *
 * Also removes the stderr mirrors. They are plain, unencrypted files in the
 * Mac's shared temp folder holding whatever the engine printed, they are
 * only useful while the session that produced them is being diagnosed, and
 * nothing in the app ever offered to open them — so leaving them behind
 * after a clean quit is only a leak.
 */
export function stopIfOurs(): void {
  stopOurs();
  for (const p of [stderrLogPath(), previousStderrLogPath()]) {
    try {
      unlinkSync(p);
    } catch (err) {
      // Best-effort, same as the Rust `let _ = std::fs::remove_file(...)`:
      // ENOENT (never existed) and any other removal failure are both
      // ignored — this is cleanup, not a step the caller depends on.
      void err;
    }
  }
}

// ------------------------------------------------------------- stderr mirror

/** Where the sidecar's stderr is mirrored. A released app launched from
 * Finder has no usable stderr of its own, so "run it from a terminal" is
 * not a diagnosis path for a user — the traceback has to land in a file. */
export function stderrLogPath(): string {
  return path.join(os.tmpdir(), "arcelle-sidecar.log");
}

/** The PREVIOUS run's log. The app restarts the sidecar automatically the
 * moment it stops answering, so truncating on every spawn wiped the
 * traceback that explained the crash before anyone could read it — exactly
 * the one-off failure that is hardest to reproduce. One generation is kept
 * here instead. */
export function previousStderrLogPath(): string {
  return path.join(os.tmpdir(), "arcelle-sidecar.prev.log");
}

/** How much of a child's stderr is kept on disk per run. Exported for testing only. */
export const STDERR_LOG_BUDGET = 2 * 1024 * 1024;

/**
 * Drain the child's stderr, mirroring each line to this process's own
 * stderr (useful in dev) and appending it to {@link stderrLogPath} (the
 * only copy a bundled app keeps). Draining is MANDATORY, not a nicety: a
 * piped stream with nobody reading fills the OS pipe buffer and blocks the
 * sidecar mid-write.
 */
function drainStderr(stderr: NodeJS.ReadableStream): void {
  // Rotate rather than truncate: the run that just died is usually the one
  // worth reading, and it is the run the auto-restart replaced.
  try {
    renameSync(stderrLogPath(), previousStderrLogPath());
  } catch {
    // No previous log yet (first run this boot) — fine.
  }
  mirrorStderr(stderr, "sidecar", stderrLogPath());
}

/**
 * Drain a child's piped stderr, mirroring each line to this process's own
 * stderr and appending it to `logPath`, capped at {@link STDERR_LOG_BUDGET}
 * bytes. Past the cap we STOP GROWING THE FILE but keep draining/discarding
 * further lines — an unread pipe still wedges the child even once we no
 * longer care what it says.
 */
function mirrorStderr(stderr: NodeJS.ReadableStream, tag: string, logPath: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(logPath, "w");
  } catch {
    fd = null;
  }
  let written = 0;
  // Defensive: readline does not itself guarantee an 'error' listener on
  // `input`, and an EventEmitter that emits 'error' with nobody listening
  // throws and can crash the whole app. The Rust source cannot have this
  // failure mode (`BufReader::lines()` turns a read error into a quiet end
  // of iteration via `map_while(Result::ok)`), so this is belt-and-suspenders
  // for a stream that is expected to live for the sidecar's whole lifetime.
  stderr.on("error", () => {
    // Swallowed deliberately -- see comment above.
  });
  const rl = createInterface({ input: stderr });
  rl.on("line", (line: string) => {
    process.stderr.write(`[${tag}] ${line}\n`);
    // Mirrors the Rust loop exactly: the check-then-write-then-recheck order
    // matters. The line that CROSSES the budget is still written (the check
    // below only bails on lines that arrive AFTER we were already over), and
    // the budget notice is appended in the SAME pass as that crossing line --
    // not deferred to whenever the next line happens to arrive. A child
    // whose stderr closes immediately after the crossing line (e.g. it dies
    // mid-traceback) would otherwise never get a next line to trigger the
    // notice on, silently dropping it.
    if (written >= STDERR_LOG_BUDGET) {
      return;
    }
    if (fd !== null) {
      try {
        writeSync(fd, `${line}\n`);
      } catch {
        // Best-effort.
      }
      written += line.length + 1;
      if (written >= STDERR_LOG_BUDGET) {
        try {
          writeSync(fd, "[arcelle] log budget reached — further output dropped\n");
        } catch {
          // Best-effort.
        }
      }
    }
  });
  rl.on("close", () => {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    }
  });
}

// ------------------------------------------------------------- launch command

/** How to launch the sidecar. */
export interface LaunchCommand {
  command: string;
  args: string[];
  cwd?: string;
}

/**
 * How to launch the sidecar. In a bundled app this is the PyInstaller
 * onedir binary shipped in `Resources/`; in dev it's the project venv's
 * Python running the package as a module. The bundled binary is preferred
 * so a released app needs no Python on the user's machine.
 */
export function launchCommand(): LaunchCommand | null {
  // 1) Bundled PyInstaller onedir binary next to the app resources. The
  //    extra `arcelle-sidecar/` level is the onedir folder; the executable
  //    of the same name sits inside it beside its _internal/ dylibs.
  //    .../Arcelle.app/Contents/MacOS/<exe>  ->  ../Resources/
  const macosDir = path.dirname(process.execPath);
  const bundled = path.resolve(
    macosDir,
    "../Resources/sidecar/arcelle-sidecar/arcelle-sidecar"
  );
  if (existsSync(bundled)) {
    return { command: bundled, args: [] };
  }

  // 2) Dev fallback: an explicit interpreter + the source package.
  //    ARCELLE_SIDECAR_PYTHON lets a developer point at the venv that has
  //    langgraph installed; ARCELLE_SIDECAR_DIR is the package parent.
  const python = process.env.ARCELLE_SIDECAR_PYTHON;
  if (!python || !existsSync(python)) {
    return null;
  }
  const dir = process.env.ARCELLE_SIDECAR_DIR ?? defaultDevSidecarDir();
  return { command: python, args: ["-m", "arcelle_sidecar"], cwd: dir };
}

/**
 * The in-repo sidecar package dir, only used in dev when
 * `ARCELLE_SIDECAR_DIR` is unset.
 *
 * This file lives four directories below the repository root; the service is
 * the canonical `services/agent-sidecar/` workspace. Keep this relative walk
 * covered when either workspace moves.
 */
function defaultDevSidecarDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../../services/agent-sidecar");
}

// ------------------------------------------------------------- unavailable

/**
 * The sidecar-could-not-start error message. The `SIDECAR_UNAVAILABLE` head
 * is kept because it is the string surfaces above match on; the reason
 * follows it instead of being discarded, so a broken interpreter, a busy
 * port and a crash on import stop reading as the same blank failure.
 */
function formatUnavailable(reason: string): string {
  return `SIDECAR_UNAVAILABLE: ${reason}`;
}

function killQuietly(pid: number | null | undefined): void {
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
function readPortLine(stdout: NodeJS.ReadableStream, timeoutMs: number): Promise<number | null> {
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
  const launch = launchCommand();
  if (launch === null) {
    throw new Error(
      formatUnavailable(
        "no sidecar to launch — no bundled binary in Resources/ and no ARCELLE_SIDECAR_PYTHON pointing at a Python with the package"
      )
    );
  }

  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: {
      ...process.env,
      [TOKEN_ENV]: authToken(),
      ...(configuredVisualIndexDir === null
        ? {}
        : { [VISUAL_INDEX_DIR_ENV]: configuredVisualIndexDir }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Node's spawn() does not throw synchronously the way Rust's
  // `Command::spawn()` does for e.g. "no such file" — that surfaces
  // asynchronously as an 'error' event on the ChildProcess. Race it against
  // the port-line read below so a bad interpreter fails fast with a real
  // reason instead of silently burning the whole startTimeoutMs.
  const spawnFailure = new Promise<never>((_resolve, reject) => {
    child.once("error", (err) => {
      reject(new Error(formatUnavailable(`could not start the sidecar: ${err.message}`)));
    });
  });
  // `child` is a long-lived daemon handle that outlives the `Promise.race`
  // below (the health-poll loop further down still holds a reference), so
  // the 'error' listener above can still fire — and this promise still
  // reject — long after the race has already settled via the port-line
  // path, with nobody left awaiting it. An unhandled rejection on a Promise
  // with zero observers is fatal under Node's default `--unhandled-rejections`
  // mode, i.e. an unrelated late child error could crash the app. Attaching
  // a permanent no-op handler marks the rejection "observed" without
  // affecting what `Promise.race` below sees (every subscriber to a promise
  // is notified independently).
  spawnFailure.catch(() => {});

  // NOT discarded. The sidecar's ENTIRE diagnostic channel is stderr:
  // Python logging installs a root StreamHandler there, uvicorn writes
  // "Exception in ASGI application" + traceback there, and asyncio writes
  // "Task exception was never retrieved" there. Piped here and drained
  // below; an undrained pipe would fill and wedge the child, so the reader
  // is not optional.
  if (child.stderr) {
    drainStderr(child.stderr);
  }

  if (!child.stdout) {
    killQuietly(child.pid);
    throw new Error(formatUnavailable("the sidecar's stdout could not be captured"));
  }

  let port: number | null;
  try {
    port = await Promise.race([readPortLine(child.stdout, startTimeoutMs), spawnFailure]);
  } catch (err) {
    killQuietly(child.pid);
    throw err;
  }

  if (port === null) {
    // Never announced a port (crash on import, bad interpreter, the
    // timeout elapsed): kill it so we don't leak the child, and say WHICH
    // of those it was — the traceback itself is already in stderrLogPath().
    killQuietly(child.pid);
    throw new Error(
      formatUnavailable(
        `the sidecar printed no SIDECAR_PORT line within ${Math.round(
          startTimeoutMs / 1000
        )}s (see ${stderrLogPath()})`
      )
    );
  }

  // The sidecar is a long-lived daemon we manage by PID (like `ollama
  // serve`), stopped via stopIfOurs() on exit. Unlike the Rust version we
  // do not need a dedicated reaper thread here: Node/libuv always reaps its
  // own spawned children internally (there is no `<defunct>` entry risk
  // equivalent to a bare Unix fork+exec), so there is nothing to park a
  // thread on.
  const url = `http://127.0.0.1:${port}`;
  const start = Date.now();
  while (Date.now() - start < startTimeoutMs) {
    if ((await probeOnce(url, HEALTH_TIMEOUT_MS)) === "healthy") {
      ourPid = child.pid ?? null;
      recordedBaseUrl = url;
      return url;
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
    harness: req.harness ?? "classic",
    messages: req.messages ?? [],
    temperature: req.temperature ?? null,
    ollama_base_url: req.ollamaBaseUrl ?? "http://127.0.0.1:11434",
    mcp: {
      url: req.mcp.url,
      token: req.mcp.token,
      workspace_write: req.mcp.workspaceWrite ?? false,
      baseline_run_id: req.mcp.baselineRunId ?? "",
    },
    ...(req.routing === undefined ? {} : { routing: req.routing }),
    web_enabled: req.webEnabled ?? false,
    tool_policy: req.toolPolicy ?? "auto",
    max_rounds: req.maxRounds ?? null,
    turn_max_rounds: req.turnMaxRounds ?? null,
    turn_max_stalls: req.turnMaxStalls ?? null,
    run_id: req.runId,
    privacy: req.privacy ?? null,
    provider: req.provider ?? null,
    supports_vision: req.supportsVision ?? null,
    max_context: req.maxContext ?? null,
    advisors: req.advisors ?? [],
  };
}

// ------------------------------------------------------------- outcome

/**
 * The result of driving one answer through the sidecar. Mirrors Rust's
 * `SidecarOutcome`/`StreamResult` pair, collapsed to the two variants a
 * caller here can actually act on:
 *
 * - `done`: completed, OR was cleanly Stopped. Rust's `run_via_sidecar`
 *   folds `StreamResult::Cancelled` into `SidecarOutcome::Done` for the same
 *   reason — a clean Stop is a successful PARTIAL answer, and the caller
 *   layers its own "(stopped)" marker on top of `text`.
 * - `failed`: the sidecar accepted the run but it ended badly — a terminal
 *   `error` line, a transport failure mid-stream, or a stream that ended
 *   without ever sending `final` (see {@link finalOutcome}). `toolRan` says
 *   whether a side-effect already committed, so a caller must never re-run
 *   this turn to "recover" — that would double the write.
 *
 * Rust's `Unavailable`/`EngineError` variants are NOT reproduced: both are
 * failures BEFORE the stream starts (the sidecar would not start; a
 * misconfigured provider), and they belong to the later batch that owns
 * waking the daemon and starting the bridge.
 *
 * `usage`/`plan` ride on BOTH variants rather than through a mutable
 * out-parameter (Rust's `effects: &mut ToolEffects`, unported): the turn
 * engine needs the latest token-usage snapshot and agent roster to decide
 * what to persist whether the run finished cleanly or not.
 */
export type SidecarOutcome =
  | { kind: "done"; text: string; usage: Record<string, unknown> | null; plan: unknown | null }
  | {
      kind: "failed";
      text: string;
      error: string;
      toolRan: boolean;
      usage: Record<string, unknown> | null;
      plan: unknown | null;
    };

// ------------------------------------------------------------- line decoding

/** The `ask-*` event names this client ever emits — the exact subset of
 * `shared/events.ts`'s `EventPayloads` keys a `/run` stream can produce. */
export type SidecarEventName =
  | "ask-plan"
  | "ask-agent"
  | "ask-lane"
  | "ask-round"
  | "ask-delta"
  | "ask-step"
  | "ask-report"
  | "ask-step-status"
  | "ask-privacy"
  | "ask-token-usage";

/** One translated event, pre-envelope: the name it is emitted under, and the
 * payload that becomes the envelope's `v` (see `turn.ts`'s `envelope`). */
export interface SidecarLineEvent {
  name: SidecarEventName;
  payload: unknown;
}

/**
 * What the line-kind switch has accumulated so far — the pure, in-memory
 * half of `stream_run`'s local variables (`final_text`, `final_seen`,
 * `streamed`, `last_usage`, `last_plan`, `tool_ran`), carried as one
 * immutable value so {@link processLine} can be a pure
 * (line, state) -> (state, verdict) function, unit-testable with no network.
 */
export interface StreamAccumulator {
  /** Written by the `final` event ALONE. */
  readonly finalText: string;
  /** Whether a `final` line has genuinely been seen — the load-bearing flag:
   * a stream that ends without ever setting this LOST the answer, and must
   * never be read back as a completed empty one. */
  readonly finalSeen: boolean;
  /** What the user has WATCHED ARRIVE this round — the delta mirror. Cleared
   * on `round`, exactly as the UI clears its own live text then, so a stopped
   * multi-round turn hands back what is still on screen rather than a
   * transcript of every round. */
  readonly streamed: string;
  readonly lastUsage: Record<string, unknown> | null;
  readonly lastPlan: unknown | null;
  /** A `step` line means a tool executed over the bridge — once true, a
   * side-effect has (or is about to have) happened, so no path may treat this
   * run as safe to silently retry. */
  readonly toolRan: boolean;
}

/** A fresh accumulator for the start of one run. */
export function freshAccumulator(): StreamAccumulator {
  return { finalText: "", finalSeen: false, streamed: "", lastUsage: null, lastPlan: null, toolRan: false };
}

/**
 * The result of feeding one parsed NDJSON line to the reducer:
 * - `event`: adopt `state` and emit `event`.
 * - `silent`: adopt `state`; nothing to emit (`final` alone).
 * - `dropped`: the line is not ours to attribute (a different `run_id`) or
 *   not a kind this client understands — `state` is unchanged, and is
 *   returned as the SAME object so a caller can tell "nothing happened"
 *   without a deep comparison. Never throws.
 * - `terminal`: the sidecar's own terminal `error` line — the run's outcome,
 *   full stop; the byte-level loop returns `outcome` immediately.
 */
export type LineOutcome =
  | { kind: "event"; state: StreamAccumulator; event: SidecarLineEvent }
  | { kind: "silent"; state: StreamAccumulator }
  | { kind: "dropped"; state: StreamAccumulator }
  | { kind: "terminal"; outcome: SidecarOutcome };

function stringField(ev: Record<string, unknown>, key: string): string {
  const v = ev[key];
  return typeof v === "string" ? v : "";
}

function optionalStringField(ev: Record<string, unknown>, key: string): string | null {
  const v = ev[key];
  return typeof v === "string" ? v : null;
}

/**
 * The honest answer text at any moment: the real `final` if one arrived,
 * otherwise the mirror of what the user has watched stream by.
 *
 * Ported verbatim from Rust's free function of the same name. Its own doc
 * explains why this had to stop being a `stream_run`-local closure: the two
 * exit paths that could not see the closure — the in-stream `error` event and
 * the end-of-stream verdict — were exactly the two that threw the streamed
 * partial away (live QA 2026-07-30, the Yahoo/ETF task). Whitespace counts as
 * empty: a `final` carrying only a newline is not an answer, and preferring
 * it over real streamed text would blank the reply.
 */
export function answerSoFar(finalText: string, streamed: string): string {
  return finalText.trim() === "" ? streamed : finalText;
}

/**
 * Feed one parsed NDJSON line through the decision logic. Pure: no network,
 * no emitting — {@link streamRun} is the only thing that ever calls the
 * sender, from the `event` verdict this returns. Ported from the
 * `match ev.get("t")...` block inside `stream_run`'s per-line loop.
 *
 * Owner replacement #4 (`turn.ts`'s doc): the sidecar stamps every line with
 * the run it belongs to (`server.py`'s `stamped` helper), INCLUDING the ones
 * a delegated sub-agent produces, which travel on this same stream. A line
 * naming a DIFFERENT run is dropped before its `t` is even read — it is not
 * ours to attribute, and painting it would stream one chat's answer into
 * another. An UNSTAMPED line (`run_id` absent, or present but not a string)
 * is an OLDER SIDECAR, not a foreign run, and is read exactly as before.
 */
export function processLine(
  ev: Record<string, unknown>,
  runId: string,
  state: StreamAccumulator
): LineOutcome {
  const theirs = typeof ev.run_id === "string" ? ev.run_id : null;
  if (theirs !== null && theirs !== runId) {
    return { kind: "dropped", state };
  }
  const t = typeof ev.t === "string" ? ev.t : null;
  switch (t) {
    // `plan` is the full roster of domain agents handling this ask (emitted
    // once per dispatch, before work starts); `agent` marks which one is
    // active as steps advance. Payloads are forwarded as-is — the shapes are
    // the sidecar's own plan/agent event bodies (graph.py `run_agent`).
    case "plan": {
      const v = "v" in ev ? ev.v : null;
      return { kind: "event", state: { ...state, lastPlan: v }, event: { name: "ask-plan", payload: v } };
    }
    case "agent": {
      const v = "v" in ev ? ev.v : null;
      return { kind: "event", state, event: { name: "ask-agent", payload: v } };
    }
    case "lane":
      return { kind: "event", state, event: { name: "ask-lane", payload: stringField(ev, "v") } };
    case "round": {
      // The UI drops the previous round's text here, so the mirror must too —
      // otherwise a stopped multi-round turn hands back deliberation the user
      // never saw, stitched to what they did.
      return { kind: "event", state: { ...state, streamed: "" }, event: { name: "ask-round", payload: null } };
    }
    case "delta": {
      const d = stringField(ev, "v");
      // Kept even when nothing is listening: a stopped background run's
      // partial is just as much the honest answer as a visible one's.
      return {
        kind: "event",
        state: { ...state, streamed: state.streamed + d },
        event: { name: "ask-delta", payload: d },
      };
    }
    // `step`, `report` and `step_status` all carry `node`: the agent-graph
    // slot of the loop that emitted them ("main", or "<agent id>#<slot>").
    // Parallel children interleave their events, so ARRIVAL ORDER ATTRIBUTES
    // NOTHING — the stamp is the only way the UI files a step under the right
    // node. Absent on an older sidecar; forwarded as null, which the frontend
    // reads as "the active agent" (the old behaviour).
    case "step": {
      const payload = { label: stringField(ev, "v"), node: optionalStringField(ev, "node") };
      return { kind: "event", state: { ...state, toolRan: true }, event: { name: "ask-step", payload } };
    }
    // What a specialist handed back to the Main agent. The child's words also
    // stream as `delta`s while it holds the live-text lease and are wiped by
    // the next `round` — so without this the report flashed up and vanished,
    // and a FAILED child's reason never reached the screen at all.
    case "report": {
      const payload = {
        node: optionalStringField(ev, "node"),
        text: stringField(ev, "v"),
        ok: typeof ev.ok === "boolean" ? ev.ok : true,
      };
      return { kind: "event", state, event: { name: "ask-report", payload } };
    }
    case "step_status": {
      // `ok` defaults to FALSE here and TRUE on `report` — deliberately
      // opposite, matching Rust's `unwrap_or(false)`/`unwrap_or(true)`.
      // `tool` is present only for a real room-tool completion. Delegation
      // status deliberately leaves it null because `report` is that child's
      // normalized completion and emitting both would count the work twice.
      const payload = {
        ok: typeof ev.ok === "boolean" ? ev.ok : false,
        node: optionalStringField(ev, "node"),
        tool: optionalStringField(ev, "tool"),
      };
      return { kind: "event", state, event: { name: "ask-step-status", payload } };
    }
    case "final": {
      // Emits NOTHING of its own — the delta stream already painted this text
      // as it arrived.
      return { kind: "silent", state: { ...state, finalText: stringField(ev, "v"), finalSeen: true } };
    }
    // PRIV-1: what the door did this turn ("N details hidden") — arrives
    // after `final`, rendered on the finished message.
    case "privacy": {
      const v = "v" in ev ? ev.v : null;
      return { kind: "event", state, event: { name: "ask-privacy", payload: v } };
    }
    case "usage": {
      // The ONE event whose whole NDJSON line becomes the payload, so both
      // the discriminator AND the per-line run stamp have to come off first:
      // the payload shape is `AskTokenUsage` (apiTypes.ts), which carries
      // neither, and this same value is later persisted into the room's
      // message row via `effects.token_usage`. The identity belongs on the
      // envelope, not inside the reading.
      const usage: Record<string, unknown> = { ...ev };
      delete usage.t;
      delete usage.run_id;
      return {
        kind: "event",
        state: { ...state, lastUsage: usage },
        event: { name: "ask-token-usage", payload: usage },
      };
    }
    // The sidecar's own terminal event — a torn-down run, a stalled provider
    // stream, any exception the driver caught (graph.py `stream_events`).
    // This is how a LONG run ends in practice, and reading `finalText` here
    // (always "" — no `final` arrived) instead of the mirror is what dropped
    // the whole partial answer and reported "the reply was lost".
    case "error": {
      const outcome: SidecarOutcome = {
        kind: "failed",
        text: answerSoFar(state.finalText, state.streamed),
        error: stringField(ev, "v"),
        toolRan: state.toolRan,
        usage: state.lastUsage,
        plan: state.lastPlan,
      };
      return { kind: "terminal", outcome };
    }
    default:
      return { kind: "dropped", state };
  }
}

/**
 * The end-of-stream verdict — ported from Rust's `stream_outcome`, split out
 * for the exact reason its own doc gives: unit-testable without a live
 * sidecar, and in particular the `false` arm, which used to be spelled
 * `Done("")`.
 *
 * THE LOAD-BEARING INVARIANT THIS WHOLE SECTION EXISTS TO PROTECT: SPEC §4
 * promises exactly one `final` per run, and the graph floors an empty answer
 * to "Done." before it reaches the wire — so a stream that ends WITHOUT a
 * `final` did not answer, it LOST the answer. Returning `done` with empty
 * text for that made a torn-down run byte-identical to a completed one: an
 * empty assistant row, no `stopped` marker, no error, the turn reporting
 * itself finished. Live QA 2026-07-30 (the Yahoo/ETF task) hit exactly that
 * and produced zero bytes with no diagnostics.
 */
export function finalOutcome(state: StreamAccumulator): SidecarOutcome {
  const text = answerSoFar(state.finalText, state.streamed);
  if (state.finalSeen) {
    return { kind: "done", text, usage: state.lastUsage, plan: state.lastPlan };
  }
  return {
    kind: "failed",
    text,
    error: "the agent sidecar ended the run without an answer",
    toolRan: state.toolRan,
    usage: state.lastUsage,
    plan: state.lastPlan,
  };
}

/** What a mid-stream Stop resolves to — Rust's `run_via_sidecar` turns its
 * own `StreamResult::Cancelled` into `SidecarOutcome::Done` too. */
function doneFromCancellation(state: StreamAccumulator): SidecarOutcome {
  return {
    kind: "done",
    text: answerSoFar(state.finalText, state.streamed),
    usage: state.lastUsage,
    plan: state.lastPlan,
  };
}

/** A transport failure mid-stream — Rust's
 * `Some(Err(e)) => StreamResult::Failed { text: answer_so_far(..), .. }`.
 *
 * NOT a rethrow, and this distinction is the whole point: a severed
 * connection is how a torn-down run actually reaches this client (uvicorn
 * closes without the terminating chunk and Node's fetch reader REJECTS with a
 * bare `terminated`). Letting that propagate would throw away the partial the
 * user watched arrive AND hand the caller an exception where every other exit
 * hands it an outcome — so the one path that most needs to keep the partial
 * would be the one that lost it. The message is the underlying error's own,
 * unembellished, exactly as Rust passes `e.to_string()` through. */
function transportFailure(state: StreamAccumulator, err: unknown): SidecarOutcome {
  return {
    kind: "failed",
    text: answerSoFar(state.finalText, state.streamed),
    error: err instanceof Error ? err.message : String(err),
    toolRan: state.toolRan,
    usage: state.lastUsage,
    plan: state.lastPlan,
  };
}

// -------------------------------------------------- byte-level NDJSON parsing

/**
 * Split every COMPLETE (newline-terminated) line off the front of `buf`,
 * returning them decoded as UTF-8 strings plus whatever partial bytes are
 * left over (to be prepended to the next chunk).
 *
 * No line is decoded until its trailing `\n` has actually arrived, which is
 * the same reason Rust buffers a `Vec<u8>` here rather than decoding per
 * chunk: a multi-byte UTF-8 character (Hebrew text, an emoji) split exactly
 * across a TCP/HTTP chunk boundary decodes correctly instead of
 * mid-character. A JSON line split across two chunks is likewise held until
 * the chunk carrying its newline arrives.
 *
 * A blank line (a bare `\n`, or a leftover `\r\n` — the sidecar emits
 * neither, but a byte-level parser should not choke on one) is dropped
 * silently, matching Rust's `if line.is_empty() { continue; }`.
 */
export function splitCompleteLines(buf: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const nl = buf.indexOf(0x0a, start);
    if (nl === -1) break;
    let end = nl;
    if (end > start && buf[end - 1] === 0x0d) {
      end -= 1; // tolerate a trailing \r, though the sidecar never sends one
    }
    const line = buf.subarray(start, end).toString("utf8");
    if (line.length > 0) {
      lines.push(line);
    }
    start = nl + 1;
  }
  return { lines, rest: buf.subarray(start) };
}

/** The minimal shape {@link streamRun} needs from a stream reader — satisfied
 * structurally by `ReadableStreamDefaultReader<Uint8Array>` (what
 * `resp.body.getReader()` returns) and by a plain fake in tests. */
export interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

/** What waiting for the next chunk produced. */
export type ChunkStep =
  | { kind: "chunk"; value: Uint8Array }
  | { kind: "ended" }
  | { kind: "cancelled" };

/** How often {@link waitForNextChunkOrCancel} re-checks `signal.aborted` once
 * no chunk has arrived yet — the same 100ms cadence `sidecar.rs`'s own
 * `wait_for_cancel` polls at. */
const CANCEL_POLL_MS = 100;

/** Give the sidecar's model loop one polling turn to close its upstream model
 * socket after `/cancel` is acknowledged. Closing our `/run` body immediately
 * races that cleanup and can cancel the ASGI task first, leaving the Ollama
 * connection alive until its long transport timeout. */
const CANCEL_UPSTREAM_DRAIN_MS = 350;

async function drainCancelledUpstream(): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, CANCEL_UPSTREAM_DRAIN_MS);
    timer.unref?.();
  });
}

/**
 * Wait for the next stream chunk while staying answerable to Stop.
 *
 * Rust's shape is `tokio::select! { biased; next = stream.next() => ...,
 * _ = wait_for_cancel(cancel) => ... }` — biased so a chunk that is ALREADY
 * available beats a cancellation arriving the same instant, and a cancel only
 * wins once the stream is genuinely idle. That matters because a tool
 * executes over a SEPARATE connection and streams no NDJSON while it runs, so
 * waiting only on the next chunk would leave Stop unobserved for the whole
 * tool call (up to ~90s) — the exact "stop after the next tool" lag the loop
 * exists to avoid.
 *
 * A single `Promise.race` is not an equivalent: it has no bias, and a poll
 * that lost one race would never be re-armed, so every cancellation landing
 * while the stream stayed idle for more than one tick would be missed.
 *
 * So this RE-RACES THE SAME pending `read()` promise against a fresh poll
 * timer on every iteration the poll wins — the read is never abandoned or
 * re-issued, only re-awaited alongside a new timer. Re-issuing would be the
 * actual hazard: `read()` is one logical read request, and abandoning an
 * unresolved one to start another either throws or silently reorders
 * delivery, which is precisely how a partially-read line gets corrupted.
 * That gives both properties `select!` gives:
 *   * a chunk that resolves while we wait wins on the very next microtask
 *     tick over ANY timer-based poll (a `setTimeout` callback is a macrotask,
 *     so it only runs once pending microtasks have drained) — biased toward
 *     draining data;
 *   * the FIRST poll fires at ~0ms rather than a full {@link CANCEL_POLL_MS},
 *     so an ALREADY-aborted signal is detected almost immediately when the
 *     stream is idle (mirroring `wait_for_cancel`'s own
 *     `while !cancel.load() { sleep }`, which returns on its first poll with
 *     no sleep at all when the flag is already set).
 *
 * Never calls `reader.cancel()`/`releaseLock()` itself — cleanup is the
 * caller's job, exactly as Rust's `next_stream_chunk` never touches the
 * stream beyond `.next()`.
 */
export async function waitForNextChunkOrCancel(
  reader: ChunkReader,
  signal: AbortSignal | undefined
): Promise<ChunkStep> {
  const readPromise = reader.read();
  let pollDelayMs = 0;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pollPromise = new Promise<{ tag: "poll" }>((resolve) => {
      timer = setTimeout(() => resolve({ tag: "poll" }), pollDelayMs);
    });
    pollDelayMs = CANCEL_POLL_MS;
    try {
      const winner = await Promise.race([
        readPromise.then((r) => ({ tag: "read" as const, r })),
        pollPromise,
      ]);
      if (winner.tag === "read") {
        return winner.r.done ? { kind: "ended" } : { kind: "chunk", value: winner.r.value ?? new Uint8Array() };
      }
    } finally {
      // Always cleared, including on the read-wins and throw paths: an
      // uncleared 100ms timer per chunk keeps the event loop alive past the
      // end of a finished run for no reason.
      clearTimeout(timer);
    }
    if (signal?.aborted) {
      // The read is left PENDING and unobserved on purpose (see above — it
      // must not be abandoned mid-request). The caller's `reader.cancel()`
      // settles it, but if it settles by REJECTING instead, nobody is
      // awaiting it and Node's default `--unhandled-rejections=throw` would
      // take the whole app down over a socket we had already given up on.
      readPromise.catch(() => {});
      return { kind: "cancelled" };
    }
    // Neither settled yet: loop back and re-race the SAME read against a
    // fresh ~100ms timer.
  }
}

// ------------------------------------------------------------- /cancel

/** Verdict of one `/cancel` POST — ported from Rust's `cancel_verdict`. */
export interface CancelPostResult {
  ok: boolean;
  error?: string;
}

/** How long one `/cancel` POST is given to answer — Rust's `cancel_run`
 * builds its client with exactly this timeout. Short and deliberate: a Stop
 * must read as accepted or refused quickly, never inherit the run's own long
 * budget, and a wedged sidecar must not be able to park Stop forever. */
const CANCEL_TIMEOUT_MS = 1_500;

/** How long to wait before the one retry — Rust's `deliver_cancel`'s own
 * `tokio::time::sleep(Duration::from_millis(150))`. */
export const CANCEL_RETRY_DELAY_MS = 150;

/**
 * Did the sidecar accept the Stop? Its contract is
 * `{"ok": true, "known": <bool>, "stopped": [...]}`, where `known` is false
 * for a `run_id` the run registry never had — the Stop reached the service
 * but stopped nothing. A non-2xx means it never reached the registry at all.
 *
 * An absent `known` is treated as ACCEPTED on purpose: a 2xx IS the
 * contract's success marker, and inventing a failure for a body shape this
 * client merely does not recognise would make every Stop report a phantom
 * problem.
 */
export function cancelVerdict(status: number, body: unknown): CancelPostResult {
  if (!(status >= 200 && status < 300)) {
    return { ok: false, error: `the AI service refused the Stop (status ${status})` };
  }
  const known =
    body !== null && typeof body === "object" && "known" in (body as Record<string, unknown>)
      ? (body as Record<string, unknown>).known
      : undefined;
  if (known === false) {
    return { ok: false, error: "the AI service did not recognise the run" };
  }
  return { ok: true };
}

/**
 * POST one `/cancel` and READ THE ANSWER — never just send it and assume it
 * landed. Rust's `cancel_run` doc: reading only the transport made an
 * unheard or unrecognised Stop indistinguishable from one that worked, so a
 * multi-step run kept spending the single local-model slot behind a UI that
 * already said "stopped".
 *
 * Matches `CancelRequest` (`config.py`): just `run_id`. Reuses
 * {@link authedHeaders} — no second place the token is spelled.
 */
async function postCancelOnce(base: string, runId: string): Promise<CancelPostResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CANCEL_TIMEOUT_MS);
  try {
    const resp = await fetch(`${base}/cancel`, {
      method: "POST",
      headers: { ...authedHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ run_id: runId }),
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await resp.json();
    } catch {
      body = null;
    }
    return cancelVerdict(resp.status, body);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deliver Stop and confirm it was accepted, retrying ONCE — ported from
 * Rust's `deliver_cancel`.
 *
 * One retry, not none and not several: `known == false` is also exactly what
 * a Stop that RACED the run's own registration looks like (this client can
 * POST `/cancel` while the sidecar is still entering the handler that
 * registers the run), and that one is genuinely retryable. If the second
 * attempt still is not confirmed the run really may keep going, so say so on
 * stderr rather than swallowing it — {@link streamRun} tears its side down
 * either way, because the user asked to stop and the answer is already
 * abandoned.
 *
 * `post` is overridable for tests only; production callers never pass it.
 */
export async function deliverCancel(
  base: string,
  runId: string,
  post: (base: string, runId: string) => Promise<CancelPostResult> = postCancelOnce
): Promise<CancelPostResult> {
  const first = await post(base, runId);
  if (first.ok) {
    return first;
  }
  await sleep(CANCEL_RETRY_DELAY_MS);
  const second = await post(base, runId);
  if (!second.ok) {
    console.error(
      `[arcelle] Stop was not accepted for run ${runId} (${first.error}; then ${second.error}) ` +
        "— the AI service may still be finishing this step."
    );
  }
  return second;
}

// ------------------------------------------------------- /run status errors

/**
 * Extract only Pydantic's safe `loc`/`msg` pairs from a non-2xx `/run` body —
 * ported from Rust's `safe_validation_detail`. A FastAPI validation body can
 * ALSO carry the rejected `input` value, which for a provider request
 * includes the API key, so this reads `loc`/`msg` and never touches `input`.
 */
export function safeValidationDetail(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const errors = (value as Record<string, unknown>).detail;
  if (!Array.isArray(errors)) {
    return null;
  }
  const parts: string[] = [];
  for (const error of errors) {
    if (typeof error !== "object" || error === null) {
      continue;
    }
    const msg = (error as Record<string, unknown>).msg;
    if (typeof msg !== "string") {
      continue;
    }
    const loc = (error as Record<string, unknown>).loc;
    const location = Array.isArray(loc)
      ? loc.filter((item): item is string => typeof item === "string" && item !== "body").join(".")
      : "";
    parts.push(location.length > 0 ? `${location}: ${msg}` : msg);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

async function safeErrorDetail(resp: Response): Promise<string | null> {
  let value: unknown;
  try {
    value = await resp.json();
  } catch {
    return null;
  }
  return safeValidationDetail(value);
}

// ------------------------------------------------------------- the driver

/** Owner-replacement #4 identity for one {@link streamRun} call, plus the
 * caller's stop request. */
export interface RunViaSidecarOptions {
  /**
   * Who owns every event this stream emits. When `null`, NOTHING is emitted
   * at all — mirroring `stream_run`'s own
   * `if let Some(turn) = turn { turn.emit(...) }`, which is also how Rust
   * spells `headless`: a background/scheduled turn owns no conversation, and
   * a silent run is the point, not a side effect.
   *
   * Deliberately NOT `turn.ts`'s `emitUnowned`: that exists for a caller that
   * has no turn but still wants the event SEEN (the AI-actions menu command),
   * and using it here would stream a headless workflow step's deltas into
   * whatever chat happens to be mounted — the exact behaviour `turn.ts`
   * exists to delete.
   */
  turn: TurnId | null;
  /**
   * Whatever delivers an event to the renderer — `webContents.send` bound to
   * a window, or a test spy. Never called when `turn` is `null`.
   *
   * Events go out through `TurnId.emit`, so this may THROW freely: a closed
   * window must never fail a running turn (Rust: `let _ = to.emit(...)`), and
   * that swallow lives in `turn.ts` rather than being re-spelled here.
   */
  onEvent: EventSender;
  /**
   * The caller's request to stop. Polled (see
   * {@link waitForNextChunkOrCancel}) rather than handed to `fetch()` as the
   * request's own abort signal, for two reasons: tearing the HTTP connection
   * down does NOT stop the Python run — uvicorn keeps executing for several
   * seconds regardless, which is why the real `/cancel` POST below is
   * load-bearing rather than a courtesy — and it would make `read()` REJECT
   * where Rust treats dropping the stream on our own terms as a clean return.
   */
  signal?: AbortSignal;
}

/**
 * `POST /run` and translate the NDJSON event stream into `ask-*` events.
 *
 * Ported from Rust's `stream_run`. Takes `base` explicitly — exactly as the
 * Rust function does, and for the same reason — so it can be driven against
 * ANY sidecar-shaped server (a fake NDJSON responder in a unit test, the real
 * Python sidecar in the wire-compat suite) without going through
 * {@link ensureUp}'s process-spawning lifecycle. {@link runViaSidecar} is the
 * wrapper that adds that lifecycle.
 *
 * CANCELLATION happens in two places, mirroring Rust exactly:
 *   1. the OUTER read — {@link waitForNextChunkOrCancel} races the pending
 *      `read()` against a 100ms poll of `signal`;
 *   2. an INNER per-line check before processing EACH line of an
 *      already-buffered chunk (Rust's own `if cancel.load(..)` inside its
 *      per-line loop), so a Stop landing while several lines sit buffered
 *      takes effect now rather than on the next network read.
 * Either way the real `/cancel` is POSTed and AWAITED (retried once) BEFORE
 * this returns and before the connection is released, and the outcome is
 * `done` carrying whatever streamed — a clean Stop is a successful partial
 * answer, not a failure.
 *
 * REFUSES, before starting anything, a call whose `opts.turn` names a
 * different run than `req.runId` — see the guard's own comment below.
 */
export async function streamRun(
  base: string,
  req: RunViaSidecarRequest,
  opts: RunViaSidecarOptions
): Promise<SidecarOutcome> {
  const { turn, onEvent, signal } = opts;
  const runId = req.runId;

  // ONE run, ONE identity. `req.runId` and `opts.turn.runId` arrive as two
  // independent arguments, and everything below silently assumes they are the
  // same string: the wire is stamped with `req.runId` (which is what
  // {@link processLine} matches lines against), every event goes out stamped
  // `turn.runId`, and `/cancel` is delivered for `req.runId`.
  //
  // A mismatch is therefore total AND silent. `runIdentity.ts`'s `applyEvent`
  // drops any event whose envelope names a run the chat did not register, so
  // the turn would stream a full set of events and paint NOTHING — no error,
  // no empty message, no diagnostic anywhere — while Stop cancelled an id the
  // chat never knew. That is exactly the misattribution `turn.ts` exists to
  // delete, so it is refused rather than started.
  //
  // Refused BEFORE the POST on purpose: no run exists yet, so there is nothing
  // to cancel and no tool that could already have committed a side effect.
  // Reported as an outcome rather than thrown because every other exit from
  // this function hands the caller an outcome (see {@link transportFailure}).
  // `turn: null` is not a mismatch — a headless run owns no conversation and
  // has no identity to disagree with.
  if (turn !== null && turn.runId !== runId) {
    return {
      kind: "failed",
      text: "",
      error:
        `sidecar /run refused: the run id on the wire (${runId}) is not the one its ` +
        `events would be emitted under (${turn.runId})`,
      toolRan: false,
      usage: null,
      plan: null,
    };
  }

  let resp: Response;
  try {
    resp = await fetch(`${base}/run`, {
      method: "POST",
      headers: { ...authedHeaders(), "content-type": "application/json" },
      body: JSON.stringify(buildRunRequestBody(req)),
      dispatcher: RUN_STREAM_DISPATCHER,
      // The standalone `undici` package's `Dispatcher` type and the
      // `undici-types` bundled into @types/node (which is what global
      // `fetch`'s `RequestInit` is structurally checked against) are two
      // separately-versioned copies of the same shape -- real at runtime
      // (Node's fetch is undici), a false mismatch at the type level.
    } as unknown as RequestInit);
  } catch (err) {
    return {
      kind: "failed",
      text: "",
      error: `sidecar /run failed: ${err instanceof Error ? err.message : String(err)}`,
      toolRan: false,
      usage: null,
      plan: null,
    };
  }

  if (!resp.ok) {
    const detail = await safeErrorDetail(resp);
    return {
      kind: "failed",
      text: "",
      error:
        detail !== null
          ? `sidecar /run status ${resp.status}: ${detail}`
          : `sidecar /run status ${resp.status}`,
      toolRan: false,
      usage: null,
      plan: null,
    };
  }

  if (resp.body === null) {
    return { kind: "failed", text: "", error: "sidecar /run returned no body", toolRan: false, usage: null, plan: null };
  }

  const reader = resp.body.getReader();
  let buffered = Buffer.alloc(0);
  let state = freshAccumulator();

  const emit = (event: SidecarLineEvent): void => {
    if (turn === null) {
      return;
    }
    // Through TurnId.emit, not a bare call: it builds owner-replacement #4's
    // envelope AND swallows a failing sender, so a window that closed
    // mid-answer cannot take the run down with it.
    turn.emit(onEvent, event.name, event.payload);
  };

  try {
    for (;;) {
      let step: ChunkStep;
      try {
        step = await waitForNextChunkOrCancel(reader, signal);
      } catch (err) {
        // The read itself rejected — a severed connection, which is how a
        // torn-down run reaches this client. Keep the partial; never throw.
        return transportFailure(state, err);
      }
      if (step.kind === "cancelled") {
        await deliverCancel(base, runId);
        await drainCancelledUpstream();
        return doneFromCancellation(state);
      }
      if (step.kind === "ended") {
        break;
      }
      buffered = Buffer.concat([buffered, Buffer.from(step.value)]);
      const split = splitCompleteLines(buffered);
      buffered = split.rest;
      for (const line of split.lines) {
        // Checked per LINE, not just per chunk — see this function's doc.
        if (signal?.aborted) {
          await deliverCancel(base, runId);
          await drainCancelledUpstream();
          return doneFromCancellation(state);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // skip a malformed line rather than abort, matching Rust
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          continue;
        }
        const outcome = processLine(parsed as Record<string, unknown>, runId, state);
        if (outcome.kind === "terminal") {
          return outcome.outcome;
        }
        state = outcome.state;
        if (outcome.kind === "event") {
          emit(outcome.event);
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already released/consumed by a normal end-of-stream — best effort.
    }
  }

  return finalOutcome(state);
}

/**
 * Ensure the sidecar is up, hold a {@link busy} guard for the whole call, and
 * drive {@link streamRun} against it. The public entry point a real caller (a
 * future `ask.ts`) uses.
 *
 * The guard is not optional bookkeeping: this is exactly the long-lived
 * streaming request a missed health probe on another task used to SIGTERM
 * mid-answer, and every tool call the run makes re-enters {@link ensureUp}.
 * Released in a `finally`, per {@link busy}'s own contract.
 *
 * A caller that already has — or is faking — a base URL should call
 * {@link streamRun} directly, which is exactly why the two are split:
 * mirrors Rust's `run_via_sidecar` wrapping `stream_run` for the same reason.
 */
export async function runViaSidecar(
  req: RunViaSidecarRequest,
  opts: RunViaSidecarOptions
): Promise<SidecarOutcome> {
  const base = await ensureUp();
  const guard = busy();
  try {
    return await streamRun(base, req, opts);
  } finally {
    guard.release();
  }
}
