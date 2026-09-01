/**
 * A cancellable `POST` to one of the sidecar's FEATURE endpoints
 * (`/file_pass_map`, `/file_pass_section`, `/summarize`, …). Ported from the
 * relevant slice of `src-tauri/src/sidecar.rs` (2331 lines): `SidecarError`,
 * `SIDECAR_DOWN`, `SidecarError::sentinel`, `humanize_empty_generation`,
 * `sidecar_json`/`sidecar_json_timeout`, and `sidecar_json_cancellable` —
 * NOT the `/run` NDJSON streaming client, which `sidecar.ts` already ports in
 * full (its own module doc names the split: "PROCESS LIFECYCLE" +
 * "the `/run` streaming RPC client").
 *
 * WHY A NEW FILE RATHER THAN AN ADDITION TO `sidecar.ts`: `sidecar.ts` is
 * already committed by an earlier batch and its own module doc draws the line
 * at "PROCESS LIFECYCLE + the `/run` streaming RPC client". This is the "small
 * cancellable JSON-POST helper... following that pattern" — it reuses
 * `sidecar.ts`'s already-ported `ensureUp`/`authedHeaders`/`busy` rather than
 * re-inventing sidecar process lifecycle or the auth header, and its
 * cancellation shape (poll the flag every 100ms, abort the in-flight request
 * the instant it flips) mirrors `waitForNextChunkOrCancel`'s same 100ms
 * cadence for the same reason: a caller must be able to Stop without waiting
 * for the current network operation to finish on its own.
 *
 * OUT OF SCOPE, deliberately, matching `sidecar.ts`'s own documented
 * deviations for the `/run` client: PRIV-1's `inject_policy` (the privacy
 * door's model-swap injection) and `ensure_provider_catalog`/
 * `inject_provider_runtime` (the cloud-provider catalog/runtime lookup) both
 * run inside Rust's `sidecar_json_timeout` before the POST, and neither has
 * an Electron port yet. A body is sent here EXACTLY as the caller built it —
 * this is a plain pass-through, the same choice `sidecar.ts`'s `RunViaSidecarRequest.privacy`
 * documents making for the same reason.
 */

import type { CancelFlag } from "./cancel.js";
import { authedHeaders, busy, ensureUp } from "./sidecar.js";

// ------------------------------------------------------------- SidecarError

/** A classified failure from a sidecar feature endpoint: the sidecar's
 * `{code,error}` envelope plus the HTTP status. Mirrors Rust's `SidecarError`
 * (`pub struct SidecarError { pub code, pub error, pub status }`). */
export interface SidecarError {
  code: string;
  error: string;
  status: number;
}

/** The sidecar itself would not start — a different failure from Ollama
 * being closed (see {@link sidecarErrorSentinel}'s own comment). */
export const SIDECAR_DOWN = "SIDECAR_DOWN";

/** The phrases that mean "the provider refused this because of your
 * allowance" — ported verbatim from `EMPTY_GENERATION_HINTS`. A bare "quota"
 * is deliberately NOT one of them (see the Rust source's own comment: it used
 * to catch a disk quota, a file named `quota.xlsx`, or a connector's own
 * wording, and sent the user chasing a billing problem that did not exist). */
const EMPTY_GENERATION_HINTS = [
  "usage limit",
  "reached your",
  "no generation chunks",
  "quota exceeded",
  "quota exhausted",
  "out of quota",
  "insufficient_quota",
  "insufficient quota",
] as const;

/**
 * When an engine error means "the model gave us nothing usable" — a cloud
 * model out of quota, or an empty generation the non-streamed path masks as
 * "No generation chunks were returned" — one actionable line; otherwise
 * `null`. Ported verbatim from `humanize_empty_generation`.
 */
export function humanizeEmptyGeneration(msg: string): string | null {
  const lower = msg.toLowerCase();
  if (EMPTY_GENERATION_HINTS.some((hint) => lower.includes(hint))) {
    return (
      "The AI model returned nothing. If this room uses a cloud model, it may " +
      "have hit its usage limit — switch to an on-device model in Settings → " +
      "Model, or try again later."
    );
  }
  return null;
}

/**
 * Rebuild the pre-migration engine sentinel: `OLLAMA_DOWN` straight through,
 * `MODEL_MISSING` re-tagged with the model name (the sidecar doesn't echo
 * it), anything else a plain `Local AI error (<status>): <msg>` — so
 * `filePass.ts` matches exactly what Rust returned when it called Ollama
 * directly. Ported verbatim from `SidecarError::sentinel`.
 */
export function sidecarErrorSentinel(e: SidecarError, model: string | null): string {
  switch (e.code) {
    case "OLLAMA_DOWN":
      return "OLLAMA_DOWN";
    // The AI HELPER failed to start — deliberately NOT the `OLLAMA_DOWN`
    // token, which is the frontend's trigger for an "Open Ollama" button that
    // could not help a cloud-model room where Ollama may not even be
    // installed.
    case SIDECAR_DOWN:
      return `Arcelle's AI helper could not start, so nothing could run: ${e.error}`;
    case "MODEL_MISSING":
      return model !== null ? `MODEL_MISSING:${model}` : "MODEL_MISSING";
    default:
      return humanizeEmptyGeneration(e.error) ?? `Local AI error (${e.status}): ${e.error}`;
  }
}

// ------------------------------------------------------------- the POST

/** The per-request budget for a single gateway POST — Rust's
 * `SIDECAR_TIMEOUT` (3600s). Sized as an outer backstop against a sidecar
 * that stops answering altogether, not the primary guard (the sidecar bounds
 * its own work by liveness); the user's own escape hatch is Stop. */
export const SIDECAR_TIMEOUT_MS = 3_600_000;

/** How often the cancel flag is polled while a request is in flight — Rust's
 * `sidecar_json_cancellable`'s own `sleep(Duration::from_millis(100))`. */
const CANCEL_POLL_MS = 100;

/** The result of one cancellable POST — Rust's `Result<Option<Value>,
 * SidecarError>`, spelled as a discriminated union (this port's established
 * convention — see `cancel.ts`'s `GuardResult`, `jobs.ts`'s `StepResult`)
 * rather than reusing `null` for "stopped", which would be indistinguishable
 * from a value that genuinely parsed to JSON `null`. */
export type SidecarPostOutcome =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "stopped" }
  | { readonly kind: "error"; readonly error: SidecarError };

/** Walk an error's `.cause` chain looking for a POSIX `ECONNREFUSED` — the
 * same check `sidecar.ts`'s `isConnectionRefused` makes for the `/run`
 * client, duplicated locally rather than importing a non-exported helper
 * (this port's established convention for a small shared predicate — see
 * `organizeTools.ts`'s local `extensionOf`). */
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

function parseErrorBody(v: unknown): { code: string; error: string } {
  const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const code = typeof o.code === "string" ? o.code : "ENGINE_ERROR";
  const error = typeof o.error === "string" ? o.error : "unknown error";
  return { code, error };
}

function stopped(): SidecarPostOutcome {
  return { kind: "stopped" };
}

function errorOutcome(code: string, error: string, status: number): SidecarPostOutcome {
  return { kind: "error", error: { code, error, status } };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function startedSidecar(): Promise<string | SidecarPostOutcome> {
  try {
    return await ensureUp();
  } catch (err) {
    return errorOutcome(SIDECAR_DOWN, errorMessage(err), 503);
  }
}

interface RequestState {
  cancelledByFlag: boolean;
  timedOut: boolean;
}

interface RequestGuard {
  readonly signal: AbortSignal;
  wasCancelled(): boolean;
  timedOut(): boolean;
  release(): void;
}

function cancelRequestWhenRequested(cancel: CancelFlag, state: RequestState, controller: AbortController): void {
  if (cancel.load()) {
    state.cancelledByFlag = true;
    controller.abort();
  }
}

function cancelRequestForTimeout(state: RequestState, controller: AbortController): void {
  state.timedOut = true;
  controller.abort();
}

function cancellableRequestGuard(cancel: CancelFlag, timeoutMs: number): RequestGuard {
  const controller = new AbortController();
  const state: RequestState = { cancelledByFlag: false, timedOut: false };
  const poll = setInterval(() => cancelRequestWhenRequested(cancel, state, controller), CANCEL_POLL_MS);
  const budget = setTimeout(() => cancelRequestForTimeout(state, controller), timeoutMs);
  return {
    signal: controller.signal,
    wasCancelled: () => state.cancelledByFlag,
    timedOut: () => state.timedOut,
    release: () => {
      clearInterval(poll);
      clearTimeout(budget);
    },
  };
}

function postJson(base: string, path: string, body: unknown, signal: AbortSignal): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...authedHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

function timeoutOutcome(timeoutMs: number): SidecarPostOutcome {
  return errorOutcome(
    "ENGINE_ERROR",
    `The AI engine did not answer within ${Math.round(timeoutMs / 1000)}s. Try a shorter request, or a faster model in Settings → Model.`,
    0
  );
}

function failedRequestOutcome(err: unknown): SidecarPostOutcome {
  const code = isConnectionRefused(err) ? "OLLAMA_DOWN" : "ENGINE_ERROR";
  return errorOutcome(code, errorMessage(err), 0);
}

function failedFetchOutcome(err: unknown, guard: RequestGuard, timeoutMs: number): SidecarPostOutcome {
  if (guard.wasCancelled()) {
    return stopped();
  }
  if (guard.timedOut()) {
    return timeoutOutcome(timeoutMs);
  }
  return failedRequestOutcome(err);
}

function failedJsonBodyOutcome(err: unknown, status: number, guard: RequestGuard): SidecarPostOutcome {
  if (guard.wasCancelled()) {
    return stopped();
  }
  return errorOutcome("ENGINE_ERROR", errorMessage(err), status);
}

async function successfulResponseOutcome(response: Response, guard: RequestGuard): Promise<SidecarPostOutcome> {
  try {
    return { kind: "value", value: await response.json() };
  } catch (err) {
    return failedJsonBodyOutcome(err, response.status, guard);
  }
}

async function responseJsonOrNull(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function failedResponseOutcome(response: Response, guard: RequestGuard): Promise<SidecarPostOutcome> {
  const body = await responseJsonOrNull(response);
  if (guard.wasCancelled()) {
    return stopped();
  }
  const { code, error } = parseErrorBody(body);
  return errorOutcome(code, error, response.status);
}

/**
 * POST a JSON body to a sidecar feature endpoint, cancellable.
 *
 * Ported from `sidecar_json_cancellable`, itself a thin cancellation wrapper
 * around `sidecar_json`/`sidecar_json_timeout`; both Rust functions are
 * collapsed into this one, since nothing else in this port needs the
 * non-cancellable variant.
 *
 * Checked for cancellation BEFORE anything else (mirrors Rust's `if
 * cancel.load(..) { return Ok(None); }` at the top): a pass step that starts
 * already-cancelled never touches the network at all. While the request is
 * in flight, `cancel` is polled every {@link CANCEL_POLL_MS}; the instant it
 * flips, the request is ABORTED (Rust: dropping the future "aborts the
 * in-flight request") and this resolves `{kind: "stopped"}` rather than
 * surfacing whatever the abort turned into.
 */
export async function sidecarJsonCancellable(
  path: string,
  body: unknown,
  cancel: CancelFlag,
  timeoutMs: number = SIDECAR_TIMEOUT_MS
): Promise<SidecarPostOutcome> {
  if (cancel.load()) {
    return stopped();
  }

  const base = await startedSidecar();
  if (typeof base !== "string") {
    return base;
  }

  const guard = busy();
  const request = cancellableRequestGuard(cancel, timeoutMs);

  try {
    let resp: Response;
    try {
      resp = await postJson(base, path, body, request.signal);
    } catch (err) {
      return failedFetchOutcome(err, request, timeoutMs);
    }

    if (resp.ok) {
      return await successfulResponseOutcome(resp, request);
    }
    return await failedResponseOutcome(resp, request);
  } finally {
    request.release();
    guard.release();
  }
}
