/**
 * Manage the local Python/LangGraph agent sidecar. Ported from
 * `src-tauri/src/sidecar_lifecycle.rs` (617 lines).
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
 * (`electron-migration/electron-app/electron/main/sidecar.ts`) so it can be
 * built and tested standalone against the shared contract before cutover.
 * Once the migration lands this moves to `electron/main/sidecar.ts` at the
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

// --------------------------------------------------------------- token

/** The environment variable the sidecar reads its shared secret from. */
export const TOKEN_ENV = "ARCELLE_SIDECAR_TOKEN";

let cachedToken: string | null = null;

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
 * TEMPORARY: this file currently lives at
 * `electron-migration/electron-app/electron/main/sidecar.ts`, four
 * directories below the repo root, which is where the real `sidecar/`
 * package lives (the same one the Rust build's `CARGO_MANIFEST_DIR/../sidecar`
 * pointed at). Once this module moves to its final post-cutover location
 * (`electron/main/sidecar.ts` at the repo root) this relative walk
 * collapses to a single `../sidecar`, matching the Rust version exactly —
 * whoever moves this file must update this walk in the same commit.
 */
function defaultDevSidecarDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../../sidecar");
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
    env: { ...process.env, [TOKEN_ENV]: authToken() },
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
