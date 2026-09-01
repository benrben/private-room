import { spawn } from "node:child_process";
import { totalmem } from "node:os";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

import type { AiStatus, ModelCaps } from "../shared/apiTypes.js";
import {
  imageReachesModel,
  isYes,
  ollamaRunsHere,
  runsOnThisMac,
  servedByOllamaEngine,
  visionSupport,
  type VisionSupportDeps,
} from "./capabilities.js";
import { CancelFlag, forget, type CancelState } from "./cancel.js";
import { listModels as listInstalledModels, resolvedBaseUrl } from "./engineRouting.js";
import { activePolicy } from "./privacy.js";
import { ensureProviderCatalog, providerConnected, providerModelVision } from "./providers.js";
import { authedHeaders, busy, ensureUp, splitCompleteLines, type ChunkReader } from "./sidecar.js";
import { sidecarErrorSentinel, sidecarJsonCancellable, type SidecarPostOutcome } from "./sidecarJsonCancellable.js";
import { clampChars } from "./textClamp.js";
import { bestDefault, DEFAULT_MODEL, isEmbeddingModel, isExternalEngine } from "./turnContext.js";
import { isRecord } from "./ollamaModelsCore.js";

// ============================================================================
// ollama.rs + models.rs — pull_model (cancellable, throttled progress)
// ============================================================================

/** `models.rs::PULL_PROGRESS_STEP` — the smallest change in a download's
 * percentage worth repainting the bar for. */
export const PULL_PROGRESS_STEP = 0.5;

/** `ollama::PULL_CANCELLED` — what a pull the user stopped reports. A sentence,
 * not a sentinel: shown as-is. Nothing in THIS module branches on it
 * ({@link PullOutcome} carries the classification), but the IPC boundary
 * rejects with it so the existing renderer contract is unchanged. */
export const PULL_CANCELLED = "The download was cancelled.";

/** `ollama::PULL_STALL_TIMEOUT` (300s) — how long a download may go without
 * receiving a single byte before it is abandoned. NOT a cap on the transfer:
 * pulls are multi-gigabyte and can legitimately run for an hour on a slow line;
 * only the GAP between chunks is bounded. */
export const PULL_STALL_TIMEOUT_MS = 300_000;

/** `ollama::pull_cancellable`'s own `sleep(Duration::from_millis(150))` — the
 * cadence at which a quiet stream is re-checked for a Stop or a stall. */
export const PULL_POLL_MS = 150;

/**
 * `models.rs::pull_cancel_key` — the cancel-registry key a running download is
 * filed under, so Stop reaches it. One download per model, keyed by the model's
 * own AS-TYPED name (not the normalised registry name): the frontend rebuilds
 * this string as `cancelAsk('pull:' + <the name it asked for>)`, and a key it
 * cannot reproduce is a Stop button that does nothing.
 */
export function pullCancelKey(name: string): string {
  return `pull:${name}`;
}

/**
 * `models.rs::registry_name` — what Ollama will actually be asked for, from
 * what the user typed.
 *
 * Ollama files a pulled model under the EXACT string it was given, and only its
 * own library is case-insensitive about finding one. For a local model a stray
 * capital is cosmetic; for a hosted one it is fatal — `/api/chat` strips the
 * `-cloud` suffix and proxies the rest verbatim, so `Gpt-oss:120b-cloud`
 * answers `model 'Gpt-oss:120b' not found` on every request, forever, for a
 * model Settings lists as installed. A name carrying a host or namespace
 * (`hf.co/Owner/Repo`, `someone/Model`) belongs to THAT registry's own casing
 * and must not be touched — lowercasing it 404s, the same bug pointed the other
 * way.
 */
export function registryName(typed: string): string {
  const trimmed = typed.trim();
  return trimmed.includes("/") ? trimmed : trimmed.toLowerCase();
}

/** Rust's `Result<(), String>` reshaped as a discriminated union — see the
 * module doc's "ONE DELIBERATE IMPROVEMENT". */
export type PullOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "error"; readonly message: string };

export type PullProgressListener = (status: string, percent: number | null) => void;

/** Walk an error's `.cause` chain for a POSIX `ECONNREFUSED` — the same check
 * `sidecar.ts`'s and `sidecarJsonCancellable.ts`'s own local copies make,
 * duplicated for the same reason theirs is: this port's established convention
 * for a small predicate a neighbouring module does not export. */
export function isConnectionRefused(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 8 && cur != null; i++) {
    if ((cur as { code?: unknown }).code === "ECONNREFUSED") {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** `ollama::map_send_err`, narrowed to the branches reachable for a pull's
 * initial POST — which, matching the Rust source's own bare
 * `reqwest::Client::builder().build()`, carries no whole-request timeout, so
 * the `is_timeout()` branch cannot fire here and is not reproduced. */
export function classifyPullSendError(err: unknown): string {
  if (isConnectionRefused(err)) {
    return "OLLAMA_DOWN";
  }
  return `Local AI request failed: ${err instanceof Error ? err.message : String(err)}`;
}

export type PullChunkStep =
  | { kind: "chunk"; value: Uint8Array }
  | { kind: "ended" }
  | { kind: "cancelled" }
  | { kind: "stalled" };

export type PullReadWinner =
  | { tag: "read"; result: { done: boolean; value?: Uint8Array } }
  | { tag: "poll" };

export function pullChunkFromRead(result: { done: boolean; value?: Uint8Array }): PullChunkStep {
  if (result.done) return { kind: "ended" };
  return { kind: "chunk", value: result.value ?? new Uint8Array() };
}

export function abandonPullRead(readPromise: Promise<unknown>, kind: "cancelled" | "stalled"): PullChunkStep {
  readPromise.catch(() => {});
  return { kind };
}

export function pullWaitStop(
  cancel: CancelFlag,
  started: number,
  stallTimeoutMs: number,
  readPromise: Promise<unknown>,
): PullChunkStep | null {
  if (cancel.load()) return abandonPullRead(readPromise, "cancelled");
  if (Date.now() - started >= stallTimeoutMs) return abandonPullRead(readPromise, "stalled");
  return null;
}

export async function racePullReadAndPoll(
  readPromise: Promise<{ done: boolean; value?: Uint8Array }>,
  delayMs: number,
): Promise<PullReadWinner> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pollPromise = new Promise<{ tag: "poll" }>((resolve) => {
    timer = setTimeout(() => resolve({ tag: "poll" }), delayMs);
  });
  try {
    return await Promise.race([
      readPromise.then((result) => ({ tag: "read" as const, result })),
      pollPromise,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wait for the next `/pull` chunk while staying answerable to BOTH a Stop and a
 * stalled connection — the two independent reasons `ollama::pull_cancellable`
 * ends a wait early, checked every {@link PULL_POLL_MS} by the same
 * re-race-the-same-pending-read technique `sidecar.ts`'s
 * `waitForNextChunkOrCancel` uses (see that function's doc for why a single
 * `Promise.race` is not equivalent: the read must never be abandoned or
 * re-issued, only re-awaited alongside a fresh timer).
 *
 * A DISTINCT function rather than a reuse of that one, mirroring the Rust
 * source itself — `ollama.rs`'s `tokio::select!` loop is not shared with
 * `sidecar.rs`'s either — because this one polls a {@link CancelFlag} rather
 * than an `AbortSignal` AND additionally tracks elapsed time since the wait
 * BEGAN (Rust's `let waited = Instant::now();`, declared fresh inside the outer
 * per-chunk loop, hence read here and not by the caller).
 */
export async function waitForPullChunk(
  reader: ChunkReader,
  cancel: CancelFlag,
  stallTimeoutMs: number
): Promise<PullChunkStep> {
  const started = Date.now();
  const readPromise = reader.read();
  let pollDelayMs = 0;
  for (;;) {
    const winner = await racePullReadAndPoll(readPromise, pollDelayMs);
    pollDelayMs = PULL_POLL_MS;
    if (winner.tag === "read") return pullChunkFromRead(winner.result);
    const stopped = pullWaitStop(cancel, started, stallTimeoutMs, readPromise);
    if (stopped !== null) return stopped;
    // Neither settled: loop back and re-race the SAME read against a fresh timer.
  }
}

/**
 * `ollama::pull_cancellable` against an EXPLICIT sidecar base URL — the
 * testable core, the same `…At` split `engineRouting.ts`'s `listModelsAt` and
 * `sidecar.ts`'s `streamRun` already establish, so a real `node:http` stand-in
 * can drive the whole stream without going through {@link ensureUp}'s
 * process-spawning lifecycle.
 *
 * Cancellation is checked BEFORE anything else (Rust returns `PULL_CANCELLED`
 * without opening a connection), then between chunks and once more the instant
 * a chunk lands — the per-chunk placement is Rust's, so a buffer holding
 * several complete lines is drained rather than half-processed.
 *
 * Every NDJSON line goes through `sidecar.ts`'s already-ported
 * {@link splitCompleteLines} (a line is not decoded until its trailing `\n` has
 * actually arrived); a malformed line is skipped rather than fatal; a line
 * carrying `{"error": …}` is classified exactly as Rust's own per-line match
 * does (`OLLAMA_DOWN` straight through, `MODEL_MISSING` re-tagged with the
 * model name, anything else verbatim).
 *
 * `stallTimeoutMs` defaults to the real {@link PULL_STALL_TIMEOUT_MS} and is
 * overridable ONLY so a test can exercise the stall branch in well under five
 * minutes; production callers never pass it.
 */
export interface PullReader extends ChunkReader {
  cancel(): Promise<void>;
}

export type PullStart = { reader: PullReader } | { outcome: PullOutcome };
export type PullRead = { step: PullChunkStep } | { outcome: PullOutcome };
export type PullStreamAction =
  | { kind: "chunk"; value: Uint8Array }
  | { kind: "ended" }
  | { kind: "outcome"; outcome: PullOutcome };

export function pullSendErrorOutcome(error: unknown): PullOutcome {
  return { kind: "error", message: classifyPullSendError(error) };
}

export async function startPull(base: string, model: string): Promise<PullStart> {
  let response: Response;
  try {
    response = await fetch(`${base}/pull`, {
      method: "POST",
      headers: { ...authedHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ model, base_url: resolvedBaseUrl() }),
    });
  } catch (error) {
    return { outcome: pullSendErrorOutcome(error) };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return { outcome: { kind: "error", message: `Download failed: ${text}` } };
  }
  if (response.body === null) {
    return { outcome: { kind: "error", message: "Download failed: the sidecar returned no body" } };
  }
  return { reader: response.body.getReader() };
}

export function interruptedPullOutcome(error: unknown): PullOutcome {
  return {
    kind: "error",
    message: `Download interrupted: ${error instanceof Error ? error.message : String(error)}`,
  };
}

export async function nextPullRead(
  reader: ChunkReader,
  cancel: CancelFlag,
  stallTimeoutMs: number,
): Promise<PullRead> {
  try {
    return { step: await waitForPullChunk(reader, cancel, stallTimeoutMs) };
  } catch (error) {
    return { outcome: interruptedPullOutcome(error) };
  }
}

export function stalledPullOutcome(stallTimeoutMs: number): PullOutcome {
  return {
    kind: "error",
    message:
      `The download stopped receiving data for ${Math.floor(stallTimeoutMs / 60_000)} minutes and was ` +
      "cancelled. Check your connection and try again.",
  };
}

export function pullStreamAction(step: PullChunkStep, cancel: CancelFlag, stallTimeoutMs: number): PullStreamAction {
  if (step.kind === "cancelled") return { kind: "outcome", outcome: { kind: "cancelled" } };
  if (step.kind === "stalled") return { kind: "outcome", outcome: stalledPullOutcome(stallTimeoutMs) };
  if (step.kind === "ended") return { kind: "ended" };
  if (cancel.load()) return { kind: "outcome", outcome: { kind: "cancelled" } };
  return { kind: "chunk", value: step.value };
}

export function pullLineErrorMessage(error: string, code: string | undefined, model: string): string {
  if (code === "OLLAMA_DOWN") return "OLLAMA_DOWN";
  if (code === "MODEL_MISSING") return `MODEL_MISSING:${model}`;
  return error;
}

export function pullProgressPercent(record: Record<string, unknown>): number | null {
  const completed = typeof record.completed === "number" ? record.completed : null;
  const total = typeof record.total === "number" ? record.total : null;
  if (completed === null || total === null || total <= 0) return null;
  return (completed / total) * 100;
}

export function processPullLine(line: string, model: string, onProgress: PullProgressListener): PullOutcome | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (typeof parsed.error === "string") {
    const code = typeof parsed.code === "string" ? parsed.code : undefined;
    return { kind: "error", message: pullLineErrorMessage(parsed.error, code, model) };
  }
  onProgress(typeof parsed.status === "string" ? parsed.status : "", pullProgressPercent(parsed));
  return null;
}

export function drainPullLines(
  buffered: Buffer,
  model: string,
  onProgress: PullProgressListener,
): { buffered: Buffer; outcome: PullOutcome | null } {
  const split = splitCompleteLines(buffered);
  for (const line of split.lines) {
    const outcome = processPullLine(line, model, onProgress);
    if (outcome !== null) return { buffered: split.rest, outcome };
  }
  return { buffered: split.rest, outcome: null };
}

export async function cancelPullReader(reader: PullReader): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Already released/consumed by a normal end-of-stream — best effort,
    // same as `sidecar.ts`'s `streamRun`.
  }
}

export async function readPullStream(
  reader: PullReader,
  model: string,
  cancel: CancelFlag,
  onProgress: PullProgressListener,
  stallTimeoutMs: number,
): Promise<PullOutcome> {
  let buffered = Buffer.alloc(0);
  try {
    for (;;) {
      const next = await nextPullRead(reader, cancel, stallTimeoutMs);
      if ("outcome" in next) return next.outcome;
      const action = pullStreamAction(next.step, cancel, stallTimeoutMs);
      if (action.kind === "outcome") return action.outcome;
      if (action.kind === "ended") return { kind: "ok" };
      const drained = drainPullLines(Buffer.concat([buffered, Buffer.from(action.value)]), model, onProgress);
      buffered = drained.buffered;
      if (drained.outcome !== null) return drained.outcome;
    }
  } finally {
    await cancelPullReader(reader);
  }
}

export async function pullCancellableAt(
  base: string,
  model: string,
  cancel: CancelFlag,
  onProgress: PullProgressListener,
  stallTimeoutMs: number = PULL_STALL_TIMEOUT_MS
): Promise<PullOutcome> {
  if (cancel.load()) return { kind: "cancelled" };
  const started = await startPull(base, model);
  if ("outcome" in started) return started.outcome;
  return readPullStream(started.reader, model, cancel, onProgress, stallTimeoutMs);
}

/**
 * {@link pullCancellableAt} against the real, ensured-up sidecar — the
 * production entry point. The already-cancelled check comes FIRST, before
 * `ensureUp`, exactly as Rust checks the flag before `wake_daemon`/`ensure_up`:
 * a pull the user already stopped must not start a sidecar to do nothing.
 *
 * A multi-gigabyte pull is exactly the long-running request a missed health
 * probe must not kill, hence the {@link busy} guard for the whole transfer.
 */
export async function pullCancellable(
  model: string,
  cancel: CancelFlag,
  onProgress: PullProgressListener,
  stallTimeoutMs: number = PULL_STALL_TIMEOUT_MS
): Promise<PullOutcome> {
  if (cancel.load()) {
    return { kind: "cancelled" };
  }
  let base: string;
  try {
    base = await ensureUp();
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
  const guard = busy();
  try {
    return await pullCancellableAt(base, model, cancel, onProgress, stallTimeoutMs);
  } finally {
    guard.release();
  }
}

/**
 * `models.rs::pull_model`'s own progress throttle, factored out pure.
 *
 * A multi-gigabyte pull emits a progress line per chunk — hundreds a second,
 * each one a separate IPC message and a React render, for a bar that cannot
 * show more than about 200 distinct positions. Forward only what actually
 * changes something the user can see: a new phase, half a percent of progress,
 * or the final 100%.
 *
 * Ported branch-for-branch from the Rust `match (percent, last_percent)`: a
 * FIRST percentage value always counts as moved (there was nothing to compare
 * it to); a later one moves only past {@link PULL_PROGRESS_STEP} or at/after
 * 100; the absence of a percentage never counts as movement on its own, so a
 * status-only line repaints only when the phase itself changed.
 */
export function pullProgressShouldEmit(
  status: string,
  percent: number | null,
  lastStatus: string,
  lastPercent: number | null
): boolean {
  const phaseChanged = status !== lastStatus;
  const moved =
    percent !== null &&
    (lastPercent === null || Math.abs(percent - lastPercent) >= PULL_PROGRESS_STEP || percent >= 100);
  return phaseChanged || moved;
}

export interface PullModelDeps {
  pullCancellable(model: string, cancel: CancelFlag, onProgress: PullProgressListener): Promise<PullOutcome>;
}

export const defaultPullModelDeps: PullModelDeps = {
  pullCancellable: (model, cancel, onProgress) => pullCancellable(model, cancel, onProgress),
};

/**
 * `models.rs::pull_model` — download a model, reporting THROTTLED progress
 * through `onProgress` (Rust's `window.emit("pull-progress", …)`; a plain
 * callback here so the window layer is the caller's concern).
 *
 * Cancellable FROM HERE DOWN: the flag is registered in `state.cancels` under
 * {@link pullCancelKey} — the SAME flat registry chat's Stop uses — so
 * `cancelId(state, "pull:<name>")` abandons a running download. The key is
 * built from what the CALLER typed, never the normalised registry name, because
 * the Stop button rebuilds it from the name it asked with.
 *
 * The registry entry is removed on EVERY return path (success, cancel, error),
 * mirroring `commands.rs::CancelGuard`'s `Drop`, which also forgets the (here
 * unused, but harmless-to-clear) cancel-tree entry.
 */
export async function pullModel(
  state: CancelState,
  name: string,
  onProgress: PullProgressListener,
  deps: PullModelDeps = defaultPullModelDeps
): Promise<PullOutcome> {
  const flag = new CancelFlag();
  const key = pullCancelKey(name);
  state.cancels.set(key, flag);
  try {
    let lastStatus = "";
    let lastPercent: number | null = null;
    return await deps.pullCancellable(registryName(name), flag, (status, percent) => {
      if (!pullProgressShouldEmit(status, percent, lastStatus, lastPercent)) {
        return;
      }
      lastStatus = status;
      // `last_percent` moves only when this update carried one, so a
      // phase-only line does not blank a percentage the bar already shows.
      if (percent !== null) {
        lastPercent = percent;
      }
      onProgress(status, percent);
    });
  } finally {
    state.cancels.delete(key);
    forget(state, key);
  }
}
