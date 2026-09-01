/** Cohesive extraction from scriptRun.ts; its public API remains on that module. */
import { spawn, spawnSync, type ChildProcess, type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";

import type { CancelFlag } from "./cancel.js";
import { extractText } from "./editMatch.js";
import { extensionOf } from "./editMatchExtraction.js";
import {
  fileByExactName,
  findFileLike,
  getFileBytes,
  getFileBytesNamed,
  getFileMeta,
  inTransaction,
  insertFile,
  listFiles,
  updateFileContent,
  type FileMeta,
} from "./db-host/files.js";
import { snapshotFileVersion } from "./db-host/versions.js";
import { pinnedDb, type RoomSource } from "./jobs.js";
import { clampBytesMarked } from "./textClamp.js";
import type { ScriptManifest } from "../shared/apiTypes.js";
import { createRoomFile, readRoomFile, writeRoomFile } from "./workspace/roomContent.js";

export type { ScriptManifest };
import { CANCEL_POLL_MS, KILL_GRACE_MS, READER_FLUSH_GRACE_MS, RING_BYTES, SPAWN_PATH, STOPPED } from "./scriptRunManifest.js";
import { Runner, home } from "./scriptRunWorkspace.js";
// ============================================================================
// Execution
// ============================================================================

/** One process run's raw result. */
export interface ExecOut {
  readonly exitCode: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

/**
 * The last {@link RING_BYTES} of a stream, plus how many bytes fell out of the
 * FRONT of it. Without the counter a chatty script's output was silently cut
 * at the beginning and then labelled "(output truncated)" at the end, so the
 * assistant — told to quote the output as the answer — could not tell that the
 * figure it was looking for had been dropped.
 */
export class RingTail {
  private buf: Buffer = Buffer.alloc(0);
  private droppedBytes = 0;

  /** Append a chunk, evicting from the front once past {@link RING_BYTES}. */
  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
    if (this.buf.length > RING_BYTES) {
      const drop = this.buf.length - RING_BYTES;
      this.droppedBytes += drop;
      // Copy rather than retain a view onto the larger concatenation.
      this.buf = Buffer.from(this.buf.subarray(drop));
    }
  }

  get dropped(): number {
    return this.droppedBytes;
  }

  /** What survived the ring, with the missing beginning named when there is
   * one. Ported from `tail_string`. */
  tailString(): string {
    if (this.droppedBytes === 0) {
      return this.buf.toString("utf8");
    }
    // The ring cuts on a byte, so what survives can begin mid-character. Drop
    // the orphaned continuation bytes rather than emit a stray U+FFFD.
    let start = this.buf.length;
    for (let i = 0; i < this.buf.length; i += 1) {
      if ((this.buf[i]! & 0xc0) !== 0x80) {
        start = i;
        break;
      }
    }
    return `[earlier output omitted — ${this.droppedBytes} bytes]\n${this.buf.subarray(start).toString("utf8")}`;
  }
}

/**
 * Attach what the script printed to a message that ends the run without an
 * exit code. A timeout used to be a single sentence: a script that printed its
 * progress and then hung left the user and the assistant nothing to diagnose
 * with, while an ordinary non-zero exit surfaces its stderr tail.
 */
export function withPrintedOutput(msg: string, out: RingTail, err: RingTail): string {
  let printed = "";
  for (const raw of [out.tailString(), err.tailString()]) {
    // Rust's `str::trim_end` strips ALL Unicode whitespace, not just ASCII.
    const trimmed = raw.replace(/\s+$/u, "");
    if (trimmed.trim() === "") continue;
    if (printed !== "") printed += "\n";
    printed += trimmed;
  }
  if (printed !== "") {
    msg += "\n\nOutput before it was stopped:\n";
    // Marked, not silently clamped: two 32 KB tails do not fit in 4 KB, and an
    // unmarked cut reads to the model — and the user — as the whole of what
    // the script printed before it hung.
    msg += clampBytesMarked(printed, 4_000, "\n… (the rest of what it printed is not shown)");
  }
  return msg;
}

/** Whether the OS has reported this child as finished (Node sets one of these
 * before it emits `'exit'`). The analogue of a successful `try_wait()`. */
export function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Resolve when the child exits, or after `ms` — whichever comes first, with
 * the timer cleared either way so a finished run never holds the event loop
 * open. Returns whether the child had exited. */
export function exitedWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const onExit = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
    timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, ms);
  });
}

/** Test seam for deterministic process-exit timing without launching a child. */
export function exitedWithinForTests(child: ChildProcess, ms: number): Promise<boolean> {
  return exitedWithin(child, ms);
}

/** Await `promise`, giving up after `ms` — with the timer cleared on the fast
 * path. */
export function within(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * `kill -SIG -- -<pgid>`: signal the WHOLE process group (a negative pid to
 * `process.kill`, exactly as to the POSIX `kill(2)` Rust shells out to).
 *
 * The `pid > 1` guard is not decoration: `process.kill(-0, sig)` signals the
 * CALLER's own process group — this whole app — and `child.pid` is `undefined`
 * whenever a spawn failed. Best-effort otherwise: a group that has already
 * exited raises ESRCH, swallowed like Rust's `let _ = Command::new("kill")…`.
 */
export function killGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // already dead, or no permission — best-effort
  }
}

/** Test seam for the best-effort OS signalling boundary. */
export function killGroupForTests(pid: number, signal: NodeJS.Signals): void {
  killGroup(pid, signal);
}

/**
 * Whether the process GROUP led by `pid` still has any member. Signal `0`
 * performs `kill(2)`'s existence/permission check without delivering anything.
 * Only `ESRCH` — "no such process group" — proves the group is empty; `EPERM`
 * means it exists but is not ours, which cannot happen for our own descendants
 * and is reported as "still there" rather than assumed away.
 */
export function groupAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Wait until POSIX reports that the whole process group is gone. Signal
 * delivery is asynchronous: immediately returning after `kill(-pgid,
 * SIGKILL)` leaves a small but real window where a cancelled grandchild still
 * exists. Keep the wait bounded so a process wedged in uninterruptible I/O
 * can never pin Arcelle's single script slot forever. */
export async function groupGoneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (groupAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

/**
 * SIGTERM the group, wait a grace period, then SIGKILL and confirm — the
 * `ollama_lifecycle` kill pattern, applied to the whole group so `uv`'s python
 * child, and anything THAT spawned, dies with it.
 *
 * The post-SIGKILL wait is BOUNDED (merge fix 9): SIGKILL cannot be caught, so
 * it settles immediately in every real case, but a process wedged in
 * uninterruptible I/O must not hold the single background job slot forever.
 *
 * The group is swept even when the DIRECT CHILD died on the SIGTERM (merge fix
 * 10): "the child exited" is not "the tree is gone", and a descendant that
 * ignores SIGTERM outlives its parent by definition.
 */
export async function terminateGroup(
  child: ChildProcess,
  pid: number,
  deps: TerminateGroupTestDeps = DEFAULT_TERMINATE_GROUP_DEPS,
): Promise<void> {
  deps.signal(pid, "SIGTERM");
  if (!(await deps.exited(child, KILL_GRACE_MS))) {
    deps.signal(pid, "SIGKILL");
    await deps.exited(child, KILL_GRACE_MS);
    await deps.gone(pid, KILL_GRACE_MS);
    return;
  }
  // The direct child is gone — the GROUP may not be. `uv` exits on SIGTERM
  // while the python it spawned is free to have installed a handler that
  // ignores it (`signal.SIG_IGN`, `trap "" TERM`); returning here left that
  // grandchild running FOREVER as an orphan — burning CPU, holding this run's
  // stdio pipes open in the main process, and outliving the timeout that was
  // supposed to end it. SIGKILL cannot be ignored.
  if (groupAlive(pid)) {
    deps.signal(pid, "SIGKILL");
    await deps.gone(pid, KILL_GRACE_MS);
  }
}

export interface TerminateGroupTestDeps {
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  readonly exited: (child: ChildProcess, ms: number) => Promise<boolean>;
  readonly gone: (pid: number, ms: number) => Promise<boolean>;
}

export const DEFAULT_TERMINATE_GROUP_DEPS: TerminateGroupTestDeps = {
  signal: killGroup,
  exited: exitedWithin,
  gone: groupGoneWithin,
};

/** Test seam for the escalation branch: real processes normally honor
 * SIGTERM, so tests inject a child that deterministically does not exit. */
export async function terminateGroupForTests(
  child: ChildProcess,
  pid: number,
  deps: TerminateGroupTestDeps,
): Promise<void> {
  return terminateGroup(child, pid, deps);
}

/**
 * Spawn the script in its own process group and drive it to completion,
 * honoring cancel + timeout via SIGTERM→SIGKILL of the whole group. App-free
 * (only `Runner`/`CancelFlag`), so it is directly unit-testable.
 *
 * Rejects with `Error("STOPPED")` on cancel — the sentinel callers compare
 * against by message, exactly like Rust's `Err("STOPPED".into())` — or with
 * the timeout message plus whatever the script had printed on timeout. A
 * non-zero exit is NOT a rejection: it comes back as {@link ExecOut} so the
 * heal loop can read the stderr tail.
 */
export async function executeScriptInWorkspace(
  ws: string,
  runner: Runner,
  scriptName: string,
  timeoutSecs: number,
  cancel: CancelFlag,
  stdin: Uint8Array | null = null
): Promise<ExecOut> {
  const outRing = new RingTail();
  const errRing = new RingTail();
  const child = spawnScript(ws, runner, scriptName, stdin);
  const watched = watchScript(child, outRing, errRing);
  writeScriptInput(child, stdin);

  let outcome = await executionOutcome(child, watched, timeoutSecs, cancel);
  if (outcome === "spawn-failed") {
    throw watched.spawnFailure.error ?? new Error("Could not start the script.");
  }
  outcome = completedOutcome(child, outcome);
  if (outcome === "cancelled" || outcome === "timedout") {
    return stopScript(child, outcome, outRing, errRing, timeoutSecs);
  }
  await within(watched.closed, READER_FLUSH_GRACE_MS);
  return executionResult(child, outRing, errRing);
}

export type Outcome = "exited" | "cancelled" | "timedout" | "spawn-failed";

export interface WatchedScript {
  readonly spawnFailure: { error: Error | null };
  readonly spawnFailed: Promise<void>;
  readonly exited: Promise<void>;
  readonly closed: Promise<void>;
}

export function spawnScript(
  ws: string,
  runner: Runner,
  scriptName: string,
  stdin: Uint8Array | null,
): ChildProcess {
  try {
    return spawn(runner.program, [...runner.argvPrefix, scriptName], {
      cwd: ws,
      // Minimal env — NEVER the room path or key. `env` REPLACES the child's
      // environment (this is `env_clear()`), and a workspace-local TMPDIR
      // keeps any scratch the script writes inside the sweepable folder.
      env: {
        PATH: SPAWN_PATH,
        HOME: home(),
        TMPDIR: path.join(ws, "tmp"),
      },
      // A `transform`-mode workflow node feeds the upstream {{input}} on
      // stdin; otherwise stdin is /dev/null (a script never blocks on a tty).
      stdio: [stdin !== null ? "pipe" : "ignore", "pipe", "pipe"],
      // Its own process group so `kill -- -<pgid>` reaches every descendant.
      detached: true,
    });
  } catch (e) {
    // `spawn` throws synchronously for an invalid program/arguments; a missing
    // binary surfaces asynchronously as an 'error' event, handled below.
    throw new Error(`Could not start the script: ${(e as Error).message}`);
  }
}

export function watchScript(child: ChildProcess, outRing: RingTail, errRing: RingTail): WatchedScript {
  // Every listener is registered UP FRONT, before anything can fire: an
  // 'error'/'exit'/'close' that arrives before we race it must not be missed.
  const spawnFailure: { error: Error | null } = { error: null };
  const spawnFailed = new Promise<void>((resolve) => {
    child.once("error", (err: Error) => {
      spawnFailure.error = new Error(`Could not start the script: ${err.message}`);
      resolve();
    });
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  // `'close'` is "every stdio stream has ended" — Node's own equivalent of
  // joining Rust's two reader threads.
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });

  child.stdout?.on("data", (chunk: Buffer) => outRing.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => errRing.push(chunk));
  return { spawnFailure, spawnFailed, exited, closed };
}

export function writeScriptInput(child: ChildProcess, stdin: Uint8Array | null): void {
  if (stdin !== null && child.stdin !== null) {
    // Best-effort, mirroring Rust's ignored `write_all`: a script that exits
    // before reading its stdin closes the pipe under us, and an EPIPE on a
    // stream with no 'error' listener is an unhandled event — i.e. a crash of
    // the whole main process over a script ignoring its input.
    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.from(stdin));
  }
}

export function executionOutcome(
  child: ChildProcess,
  watched: WatchedScript,
  timeoutSecs: number,
  cancel: CancelFlag,
): Promise<Outcome> {
  let cancelPoll: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  return Promise.race<Outcome>([
      watched.exited.then((): Outcome => "exited"),
      watched.spawnFailed.then((): Outcome => "spawn-failed"),
      new Promise<Outcome>((resolve) => {
        cancelPoll = setInterval(() => {
          if (cancel.load()) resolve("cancelled");
        }, CANCEL_POLL_MS);
      }),
      new Promise<Outcome>((resolve) => {
        timeoutTimer = setTimeout(() => resolve("timedout"), timeoutSecs * 1000);
      }),
    ]).finally(() => clearExecutionTimers(cancelPoll, timeoutTimer));
}

export function clearExecutionTimers(
  cancelPoll: NodeJS.Timeout | undefined,
  timeoutTimer: NodeJS.Timeout | undefined,
): void {
  if (cancelPoll !== undefined) clearInterval(cancelPoll);
  if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
}

export function completedOutcome(child: ChildProcess, outcome: Outcome): Outcome {
  // Rust's loop checks `try_wait()` FIRST on every iteration, so a process that
  // had in fact already finished always beats a cancel/timeout that fired in
  // the same tick. Node's events are ordinary macrotasks, so re-check here.
  return outcome !== "exited" && hasExited(child) ? "exited" : outcome;
}

export async function stopScript(
  child: ChildProcess,
  outcome: Outcome,
  outRing: RingTail,
  errRing: RingTail,
  timeoutSecs: number,
): Promise<never> {
  if (child.pid !== undefined) await terminateGroup(child, child.pid);
  if (outcome === "cancelled") throw new Error(STOPPED);
  throw new Error(withPrintedOutput(`This script timed out after ${timeoutSecs}s.`, outRing, errRing));
}

export function executionResult(child: ChildProcess, outRing: RingTail, errRing: RingTail): ExecOut {
  // Exited on its own. WAIT for the stdio to finish draining rather than
  // guessing at a delay: the assistant is told to quote a script's output as
  // the answer, so a last line lost on a loaded machine is a wrong answer.
  // Bounded, because a lingering grandchild can hold the pipe open after the
  // script itself exited — then the tail we already have is what there is.
  return {
    exitCode: child.exitCode ?? -1,
    stdoutTail: outRing.tailString(),
    stderrTail: errRing.tailString(),
  };
}
