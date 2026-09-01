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
import { HEALTH_TIMEOUT_MS, Probe, START_TIMEOUT_MS, authedHeaders, busy, inflightCount, probeOnce, probeRecorded, shouldReplace } from "./sidecarAuth.js";
import { spawnAndWait } from "./sidecarLaunch.js";
// ------------------------------------------------------------- lifecycle state

/** PID of the sidecar child WE spawned, or `null` when not running. */
export let ourPid: number | null = null;
/** The base URL (`http://127.0.0.1:PORT`) of the running sidecar, once known. */
export let recordedBaseUrl: string | null = null;
/** Single-flight guard: two concurrent {@link ensureUp} calls must await the
 * SAME spawn attempt rather than each launching a sidecar. TS equivalent of
 * the Rust `tokio::sync::Mutex` guard — a shared promise instead of a lock,
 * since Node has no threads to serialize. */
export let spawningPromise: Promise<string> | null = null;

export function recordRunningSidecar(pid: number | null | undefined, url: string): void {
  ourPid = pid ?? null;
  recordedBaseUrl = url;
}

export function currentBaseUrl(): string | null {
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
export function stopOurs(): void {
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

/** Injectable lifecycle boundary for {@link ensureUp}. The default preserves
 * the production process and health-probe behavior; fakes make its policy
 * testable without starting a sidecar. */
export interface EnsureUpDeps {
  currentBaseUrl(): string | null;
  probeRecorded(baseUrl: string): Promise<Probe>;
  shouldReplace(verdict: Probe, inflightNow: number): boolean;
  inflightCount(): number;
  stopOurs(): void;
  probeOnce(baseUrl: string, timeoutMs: number): Promise<Probe>;
  spawnAndWait(startTimeoutMs: number): Promise<string>;
}

export const nativeEnsureUpDeps: EnsureUpDeps = {
  currentBaseUrl,
  probeRecorded,
  shouldReplace,
  inflightCount,
  stopOurs,
  probeOnce,
  spawnAndWait,
};

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
export async function ensureUp(deps: EnsureUpDeps = nativeEnsureUpDeps): Promise<string> {
  const recorded = deps.currentBaseUrl();
  if (recorded !== null) {
    const verdict = await deps.probeRecorded(recorded);
    if (verdict === "healthy") {
      return recorded;
    }
    if (!deps.shouldReplace(verdict, deps.inflightCount())) {
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
    deps.stopOurs();
  }

  if (spawningPromise !== null) {
    return spawningPromise;
  }

  spawningPromise = (async (): Promise<string> => {
    try {
      // Re-check the recorded URL once more now that we hold the spawn
      // slot: another caller may have just finished spawning while we were
      // awaiting the probe above.
      const maybeAlreadyUp = deps.currentBaseUrl();
      if (maybeAlreadyUp !== null) {
        const healthy = (await deps.probeOnce(maybeAlreadyUp, HEALTH_TIMEOUT_MS)) === "healthy";
        if (healthy) {
          return maybeAlreadyUp;
        }
      }
      return await deps.spawnAndWait(START_TIMEOUT_MS);
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
export function drainStderr(stderr: NodeJS.ReadableStream): void {
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
export function mirrorStderr(stderr: NodeJS.ReadableStream, tag: string, logPath: string): void {
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
export function defaultDevSidecarDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../../services/agent-sidecar");
}
