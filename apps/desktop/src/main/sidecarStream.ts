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
import { authedHeaders, sleep } from "./sidecarAuth.js";
import { streamRun } from "./sidecarRun.js";
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
export const CANCEL_POLL_MS = 100;

/** Give the sidecar's model loop one polling turn to close its upstream model
 * socket after `/cancel` is acknowledged. Closing our `/run` body immediately
 * races that cleanup and can cancel the ASGI task first, leaving the Ollama
 * connection alive until its long transport timeout. */
export const CANCEL_UPSTREAM_DRAIN_MS = 350;

export async function drainCancelledUpstream(): Promise<void> {
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
export const CANCEL_TIMEOUT_MS = 1_500;

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
  if (!successfulStatus(status)) {
    return { ok: false, error: `the AI service refused the Stop (status ${status})` };
  }
  if (cancelKnown(body) === false) {
    return { ok: false, error: "the AI service did not recognise the run" };
  }
  return { ok: true };
}

export function successfulStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

export function cancelKnown(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  return "known" in record ? record.known : undefined;
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
export async function postCancelOnce(base: string, runId: string): Promise<CancelPostResult> {
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
