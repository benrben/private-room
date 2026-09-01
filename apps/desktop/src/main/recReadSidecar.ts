/** Cohesive extraction from recRead.ts; its public API remains on that module. */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";

import { CancelFlag } from "./cancel.js";
import { getFileName, setFileExtractedText } from "./db-host/files.js";
import {
  checkpointJob,
  createJob,
  getJobArtifact,
  listJobs,
  putJobArtifact,
  setJobStatus,
  type Job,
} from "./db-host/jobs.js";
import { getRecMeta, setRecMeta } from "./db-host/recordings.js";
import { resolvedBaseUrl } from "./engineRouting.js";
import {
  atCapacity,
  QUEUE_FULL,
  runnerDepsFrom,
  tryReserve,
  UNREADABLE_PLAN,
  type JobQueueDeps,
  type RowStarter,
  type RowStartResult,
} from "./jobQueue.js";
import {
  densePrefix,
  emitProgress,
  pinnedDb,
  runPlan,
  spawnJobRunner,
  type CancelSignal,
  type JobProgressPayload,
  type JobRunnerDeps,
  type Lane,
  type ProgressSink,
  type RoomHandle,
  type RoomSource,
  type RunOutcome,
  type Step,
  type StepResult,
} from "./jobs.js";
import * as obs from "./obs.js";
import { parseRecMeta } from "./recBridge.js";
import {
  displaySpeaker,
  formatStamp,
  readStampOf,
  segmentVisibleText,
  transcriptText,
  type By,
  type NoteKind,
  type ReadStamp,
  type RecChapter,
  type RecHighlight,
  type RecMeta,
  type RecNote,
} from "./recFormat.js";
import { authedHeaders, busy, ensureUp } from "./sidecar.js";

export type { JobProgressPayload, ProgressSink, RoomSource };
import { asRecord } from "./recReadMerge.js";
import { executeReadStep } from "./recReadSteps.js";
// =============================================================================
// the cancellable sidecar JSON POST — see the module header
// =============================================================================

/** A classified failure from a sidecar feature endpoint: the `{code,error}`
 * envelope every non-2xx response carries, plus the HTTP status. Rust's
 * `SidecarError`. */
export interface SidecarJsonError {
  code: string;
  error: string;
  status: number;
}

/** What one `/rec_read_map` call produced — Rust's collapsed
 * `Result<Option<Value>, SidecarError>`. */
export type SidecarJsonOutcome =
  | { kind: "value"; value: unknown }
  | { kind: "cancelled" }
  | { kind: "error"; error: SidecarJsonError };

export type RecReadSidecarCall = (
  path: string,
  body: Record<string, unknown>,
  cancel: CancelSignal
) => Promise<SidecarJsonOutcome>;

export const SIDECAR_DOWN_CODE = "SIDECAR_DOWN";

/** The phrases that actually mean "the provider refused this because of your
 * allowance" — `sidecar.rs`'s `EMPTY_GENERATION_HINTS`, verbatim. */
export const EMPTY_GENERATION_HINTS: readonly string[] = [
  "usage limit",
  "reached your",
  "no generation chunks",
  "quota exceeded",
  "quota exhausted",
  "out of quota",
  "insufficient_quota",
  "insufficient quota",
];

/** Port of `sidecar::humanize_empty_generation`. */
export function humanizeEmptyGeneration(msg: string): string | null {
  const lower = msg.toLowerCase();
  return EMPTY_GENERATION_HINTS.some((hint) => lower.includes(hint))
    ? "The AI model returned nothing. If this room uses a cloud model, it may " +
        "have hit its usage limit — switch to an on-device model in Settings → " +
        "Model, or try again later."
    : null;
}

export function missingModelSentinel(model: string | null): string {
  return model === null ? "MODEL_MISSING" : `MODEL_MISSING:${model}`;
}

export function localAiError(e: SidecarJsonError): string {
  const human = humanizeEmptyGeneration(e.error);
  if (human !== null) return human;
  return `Local AI error (${e.status}): ${e.error}`;
}

/** Port of `SidecarError::sentinel` (`sidecar.rs:73-94`). `SIDECAR_DOWN`
 * deliberately does NOT collapse into `OLLAMA_DOWN`: that token is the
 * frontend's trigger for an "Open Ollama" button, and offering it to a
 * cloud-model room whose AI HELPER failed to start is the exact confusion the
 * split exists to end. */
export function sidecarErrorSentinel(e: SidecarJsonError, model: string | null): string {
  switch (e.code) {
    case "OLLAMA_DOWN":
      return "OLLAMA_DOWN";
    case SIDECAR_DOWN_CODE:
      return `Arcelle's AI helper could not start, so nothing could run: ${e.error}`;
    case "MODEL_MISSING":
      return missingModelSentinel(model);
    default:
      return localAiError(e);
  }
}

/** The same 100 ms cadence `sidecar_json_cancellable`'s `tokio::select!` polls
 * the flag at. */
export const CANCEL_POLL_MS = 100;

export interface CancelRace {
  readonly cancelled: Promise<"cancelled">;
  clear(): void;
}

export function startCancelRace(cancel: CancelSignal, controller: AbortController): CancelRace {
  let poll: ReturnType<typeof setInterval> | undefined;
  const cancelled = new Promise<"cancelled">((resolve) => {
    poll = setInterval(() => {
      if (cancel.load()) {
        controller.abort();
        resolve("cancelled");
      }
    }, CANCEL_POLL_MS);
  });
  return { cancelled, clear: () => clearInterval(poll) };
}

export function networkRequestOutcome(err: unknown, cancel: CancelSignal): SidecarJsonOutcome {
  if (cancel.load()) return { kind: "cancelled" };
  return {
    kind: "error",
    error: {
      code: isConnectFailure(err) ? "OLLAMA_DOWN" : "ENGINE_ERROR",
      error: err instanceof Error ? err.message : String(err),
      status: 0,
    },
  };
}

export async function responseJson(resp: Response): Promise<unknown> {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

export function sidecarResponseOutcome(resp: Response, json: unknown): SidecarJsonOutcome {
  if (resp.ok) return { kind: "value", value: json };
  const obj = asRecord(json) ?? {};
  return {
    kind: "error",
    error: {
      code: typeof obj.code === "string" ? obj.code : "ENGINE_ERROR",
      error: typeof obj.error === "string" ? obj.error : "unknown error",
      status: resp.status,
    },
  };
}

export async function cancellableSidecarRequest(
  base: string,
  path: string,
  body: Record<string, unknown>,
  cancel: CancelSignal,
  controller: AbortController,
): Promise<SidecarJsonOutcome> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { ...authedHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    return networkRequestOutcome(err, cancel);
  }
  return sidecarResponseOutcome(response, await responseJson(response));
}

/** Walk an error's `.cause` chain looking for a POSIX `ECONNREFUSED` — the same
 * check `sidecar.ts`'s own (non-exported) `isConnectionRefused` makes for the
 * `/run` client, duplicated locally rather than exporting a private helper out
 * of a file this port must not touch. This is the TS stand-in for reqwest's
 * `e.is_connect()`, and the distinction is load-bearing: a refused connection
 * is `OLLAMA_DOWN` (fatal — the job parks for Resume), while a socket that dies
 * mid-body is a plain engine error (non-fatal — this one window is marked
 * skipped and the read carries on), exactly as `sidecar_json_timeout` splits
 * them. */
export function isConnectFailure(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 8 && cur != null; i++) {
    if ((cur as { code?: unknown }).code === "ECONNREFUSED") {
      return true;
    }
    // A host that resolves to several addresses (`localhost` → ::1 AND
    // 127.0.0.1) fails as an `AggregateError` whose own `.code` is undefined
    // and whose per-address `ECONNREFUSED`s hang off `.errors`. Without this
    // the SAME dead sidecar would be classified fatal on one machine and
    // survivable on another, purely by how its base URL is spelled.
    const nested: unknown = (cur as { errors?: unknown }).errors;
    if (
      Array.isArray(nested) &&
      nested.some((e) => (e as { code?: unknown }).code === "ECONNREFUSED")
    ) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * POST a JSON body to a sidecar FEATURE endpoint at an EXPLICIT base, racing it
 * against a caller-owned cancel flag — split out from
 * {@link sidecarJsonCancellable} so the wire behaviour is testable against a
 * real `http.Server` with no sidecar process involved, matching this repo's
 * `xxxAt(base, …)` convention (`sidecar.ts`'s `streamRun`, `engineRouting.ts`'s
 * `listModelsAt`).
 *
 * Like Rust's `sidecar_json_cancellable`, an ALREADY-set flag short-circuits
 * before any network call. Unlike Rust — which drops the in-flight `Future` and
 * relies on the sidecar's `until_hangup` to notice the severed connection —
 * this aborts the `fetch` through an `AbortController`, which has the same
 * effect without depending on a JS engine ever dropping an unawaited promise's
 * underlying request.
 *
 * The poll is one `setInterval`, cleared in a `finally`: a response that
 * arrives in 3 ms returns in 3 ms, and nothing is left holding a timer open.
 *
 * Never throws: every failure — a non-2xx status, a malformed body, a network
 * error — comes back as a value.
 */
export async function sidecarJsonCancellableAt(
  base: string,
  path: string,
  body: Record<string, unknown>,
  cancel: CancelSignal
): Promise<SidecarJsonOutcome> {
  if (cancel.load()) {
    return { kind: "cancelled" };
  }
  const controller = new AbortController();
  const race = startCancelRace(cancel, controller);
  const request = cancellableSidecarRequest(base, path, body, cancel, controller);

  try {
    const winner = await Promise.race([request, race.cancelled]);
    return winner === "cancelled" ? { kind: "cancelled" } : winner;
  } finally {
    race.clear();
  }
}

/**
 * Ensure the sidecar is up, hold a {@link busy} guard for the POST, and drive
 * {@link sidecarJsonCancellableAt} against it — the production call
 * {@link executeReadStep} makes. The guard is taken AFTER `ensureUp` and
 * released in a `finally`, exactly where `sidecar_json_timeout` places its own
 * `let _busy = sidecar_lifecycle::busy();`, so a health probe on another task
 * cannot replace the sidecar that is answering this window.
 */
export async function sidecarJsonCancellable(
  path: string,
  body: Record<string, unknown>,
  cancel: CancelSignal
): Promise<SidecarJsonOutcome> {
  if (cancel.load()) {
    return { kind: "cancelled" };
  }
  let base: string;
  try {
    base = await ensureUp();
  } catch (err) {
    return {
      kind: "error",
      error: {
        code: SIDECAR_DOWN_CODE,
        error: err instanceof Error ? err.message : String(err),
        status: 503,
      },
    };
  }
  const guard = busy();
  try {
    return await sidecarJsonCancellableAt(base, path, body, cancel);
  } finally {
    guard.release();
  }
}
