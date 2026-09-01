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
import { RUN_STREAM_DISPATCHER, authedHeaders, busy } from "./sidecarAuth.js";
import { RunViaSidecarRequest, buildRunRequestBody } from "./sidecarLaunch.js";
import { ensureUp } from "./sidecarLifecycle.js";
import { SidecarLineEvent, SidecarOutcome, StreamAccumulator, doneFromCancellation, finalOutcome, freshAccumulator, processLine, transportFailure } from "./sidecarProtocol.js";
import { ChunkReader, ChunkStep, deliverCancel, drainCancelledUpstream, splitCompleteLines, waitForNextChunkOrCancel } from "./sidecarStream.js";
// ------------------------------------------------------- /run status errors

/**
 * Extract only Pydantic's safe `loc`/`msg` pairs from a non-2xx `/run` body —
 * ported from Rust's `safe_validation_detail`. A FastAPI validation body can
 * ALSO carry the rejected `input` value, which for a provider request
 * includes the API key, so this reads `loc`/`msg` and never touches `input`.
 */
export function safeValidationDetail(value: unknown): string | null {
  const errors = validationErrors(value);
  if (errors === null) return null;
  const parts = errors.map(validationPart).filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join("; ") : null;
}

export function validationErrors(value: unknown): unknown[] | null {
  if (typeof value !== "object" || value === null) return null;
  const errors = (value as Record<string, unknown>).detail;
  return Array.isArray(errors) ? errors : null;
}

export function validationPart(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const record = error as Record<string, unknown>;
  if (typeof record.msg !== "string") return null;
  const location = validationLocation(record.loc);
  return location === "" ? record.msg : `${location}: ${record.msg}`;
}

export function validationLocation(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.filter(validationLocationPart).join(".");
}

export function validationLocationPart(value: unknown): value is string {
  return typeof value === "string" && value !== "body";
}

export async function safeErrorDetail(resp: Response): Promise<string | null> {
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
  const mismatch = runIdentityMismatch(req.runId, opts.turn);
  if (mismatch !== null) return mismatch;
  const opened = await openRunStream(base, req);
  if (opened.kind === "failed") return opened.outcome;
  return consumeRunStream(opened.reader, base, req.runId, opts);
}

export interface CancelableChunkReader extends ChunkReader {
  cancel(): Promise<void>;
}

export type OpenRunStream =
  | { readonly kind: "stream"; readonly reader: CancelableChunkReader }
  | { readonly kind: "failed"; readonly outcome: SidecarOutcome };

export interface StreamRunSession {
  readonly base: string;
  readonly runId: string;
  readonly reader: CancelableChunkReader;
  readonly signal: AbortSignal | undefined;
  readonly emit: (event: SidecarLineEvent) => void;
  buffered: Buffer;
  state: StreamAccumulator;
}

export function runIdentityMismatch(runId: string, turn: TurnId | null): SidecarOutcome | null {
  if (turn === null || turn.runId === runId) return null;
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

export async function openRunStream(base: string, req: RunViaSidecarRequest): Promise<OpenRunStream> {
  const response = await postRunRequest(base, req);
  if (response.kind === "failed") return response;
  return streamFromResponse(response.response);
}

export async function postRunRequest(
  base: string,
  req: RunViaSidecarRequest,
): Promise<{ readonly kind: "response"; readonly response: Response } | { readonly kind: "failed"; readonly outcome: SidecarOutcome }> {
  try {
    const response = await fetch(`${base}/run`, {
      method: "POST",
      headers: { ...authedHeaders(), "content-type": "application/json" },
      body: JSON.stringify(buildRunRequestBody(req)),
      dispatcher: RUN_STREAM_DISPATCHER,
    } as unknown as RequestInit);
    return { kind: "response", response };
  } catch (error) {
    return { kind: "failed", outcome: failedStart(`sidecar /run failed: ${errorMessage(error)}`) };
  }
}

export async function streamFromResponse(response: Response): Promise<OpenRunStream> {
  if (!response.ok) return { kind: "failed", outcome: await failedResponse(response) };
  if (response.body === null) return { kind: "failed", outcome: failedStart("sidecar /run returned no body") };
  return { kind: "stream", reader: response.body.getReader() };
}

export function failedStart(error: string): SidecarOutcome {
  return { kind: "failed", text: "", error, toolRan: false, usage: null, plan: null };
}

export async function failedResponse(response: Response): Promise<SidecarOutcome> {
  const detail = await safeErrorDetail(response);
  const error = detail === null ? `sidecar /run status ${response.status}` : `sidecar /run status ${response.status}: ${detail}`;
  return failedStart(error);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function consumeRunStream(
  reader: CancelableChunkReader,
  base: string,
  runId: string,
  opts: RunViaSidecarOptions,
): Promise<SidecarOutcome> {
  const session: StreamRunSession = {
    base,
    runId,
    reader,
    signal: opts.signal,
    emit: streamEmitter(opts.turn, opts.onEvent),
    buffered: Buffer.alloc(0),
    state: freshAccumulator(),
  };
  try {
    return await drainRunStream(session);
  } finally {
    await cancelStreamReader(reader);
  }
}

export function streamEmitter(turn: TurnId | null, onEvent: EventSender): (event: SidecarLineEvent) => void {
  if (turn === null) return () => undefined;
  return (event) => turn.emit(onEvent, event.name, event.payload);
}

export async function cancelStreamReader(reader: CancelableChunkReader): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Already released/consumed by a normal end-of-stream — best effort.
  }
}

export async function drainRunStream(session: StreamRunSession): Promise<SidecarOutcome> {
  for (;;) {
    const outcome = await nextRunStreamOutcome(session);
    if (outcome !== null) return outcome;
  }
}

export async function nextRunStreamOutcome(session: StreamRunSession): Promise<SidecarOutcome | null> {
  const result = await nextChunkResult(session);
  if (result.kind === "transport") return result.outcome;
  if (result.step.kind === "cancelled") return finishCancellation(session);
  if (result.step.kind === "ended") return finalOutcome(session.state);
  return consumeRunChunk(session, result.step.value);
}

export type NextChunkResult =
  | { readonly kind: "step"; readonly step: ChunkStep }
  | { readonly kind: "transport"; readonly outcome: SidecarOutcome };

export async function nextChunkResult(session: StreamRunSession): Promise<NextChunkResult> {
  try {
    return { kind: "step", step: await waitForNextChunkOrCancel(session.reader, session.signal) };
  } catch (error) {
    return { kind: "transport", outcome: transportFailure(session.state, error) };
  }
}

export async function finishCancellation(session: StreamRunSession): Promise<SidecarOutcome> {
  await deliverCancel(session.base, session.runId);
  await drainCancelledUpstream();
  return doneFromCancellation(session.state);
}

export async function consumeRunChunk(session: StreamRunSession, chunk: Uint8Array): Promise<SidecarOutcome | null> {
  const lines = appendRunChunk(session, chunk);
  return processRunLines(session, lines);
}

export function appendRunChunk(session: StreamRunSession, chunk: Uint8Array): string[] {
  session.buffered = Buffer.concat([session.buffered, Buffer.from(chunk)]);
  const split = splitCompleteLines(session.buffered);
  session.buffered = split.rest;
  return split.lines;
}

export async function processRunLines(session: StreamRunSession, lines: readonly string[]): Promise<SidecarOutcome | null> {
  for (const line of lines) {
    const outcome = await processRunLine(session, line);
    if (outcome !== null) return outcome;
  }
  return null;
}

export async function processRunLine(session: StreamRunSession, line: string): Promise<SidecarOutcome | null> {
  if (session.signal?.aborted) return finishCancellation(session);
  const event = parseSidecarLine(line);
  if (event === null) return null;
  const outcome = processLine(event, session.runId, session.state);
  if (outcome.kind === "terminal") return outcome.outcome;
  session.state = outcome.state;
  if (outcome.kind === "event") session.emit(outcome.event);
  return null;
}

export function parseSidecarLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return sidecarEventRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function sidecarEventRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
