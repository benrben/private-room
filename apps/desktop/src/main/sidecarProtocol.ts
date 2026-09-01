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
import { streamRun } from "./sidecarRun.js";
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

export function stringField(ev: Record<string, unknown>, key: string): string {
  const v = ev[key];
  return typeof v === "string" ? v : "";
}

export function optionalStringField(ev: Record<string, unknown>, key: string): string | null {
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
export type LineHandler = (ev: Record<string, unknown>, state: StreamAccumulator) => LineOutcome;

export function lineValue(ev: Record<string, unknown>): unknown {
  return "v" in ev ? ev.v : null;
}

// `plan` is the full roster of domain agents handling this ask (emitted once
// per dispatch, before work starts); `agent` marks which one is active as
// steps advance. Payloads are forwarded as-is — the shapes are the sidecar's
// own plan/agent event bodies (graph.py `run_agent`).
export function planLine(ev: Record<string, unknown>, state: StreamAccumulator): LineOutcome {
  const payload = lineValue(ev);
  return { kind: "event", state: { ...state, lastPlan: payload }, event: { name: "ask-plan", payload } };
}

export function agentLine(ev: Record<string, unknown>, state: StreamAccumulator): LineOutcome {
  return { kind: "event", state, event: { name: "ask-agent", payload: lineValue(ev) } };
}

export function laneLine(ev: Record<string, unknown>, state: StreamAccumulator): LineOutcome {
  return { kind: "event", state, event: { name: "ask-lane", payload: stringField(ev, "v") } };
}

export function roundLine(_ev: Record<string, unknown>, state: StreamAccumulator): LineOutcome {
  // The UI drops the previous round's text here, so the mirror must too —
  // otherwise a stopped multi-round turn hands back deliberation the user
  // never saw, stitched to what they did.
  return { kind: "event", state: { ...state, streamed: "" }, event: { name: "ask-round", payload: null } };
}

export function deltaLine(ev: Record<string, unknown>, state: StreamAccumulator): LineOutcome {
  const payload = stringField(ev, "v");
  // Kept even when nothing is listening: a stopped background run's partial
  // is just as much the honest answer as a visible one's.
  return {
    kind: "event",
    state: { ...state, streamed: state.streamed + payload },
    event: { name: "ask-delta", payload },
  };
}

// `step`, `report` and `step_status` all carry `node`: the agent-graph slot
// of the loop that emitted them ("main", or "<agent id>#<slot>"). Parallel
// children interleave their events, so arrival order attributes nothing — the
// stamp is the only way the UI files a step under the right node. Absent on an
// older sidecar; forwarded as null, which the frontend reads as the active
// agent (the old behaviour).
export function stepLine(ev: Record<string, unknown>, state: StreamAccumulator): LineOutcome {
  const payload = { label: stringField(ev, "v"), node: optionalStringField(ev, "node") };
  return { kind: "event", state: { ...state, toolRan: true }, event: { name: "ask-step", payload } };
}

// What a specialist handed back to the Main agent. The child's words also
// stream as deltas while it holds the live-text lease and are wiped by the
// next round — so without this the report flashed up and vanished, and a
// failed child's reason never reached the screen at all.
export function reportLine(ev: Record<string, unknown>, state: StreamAccumulator): LineOutcome {
  const payload = {
    node: optionalStringField(ev, "node"),
    text: stringField(ev, "v"),
    ok: typeof ev.ok === "boolean" ? ev.ok : true,
  };
  return { kind: "event", state, event: { name: "ask-report", payload } };
}

export function stepStatusLine(ev: Record<string, unknown>, state: StreamAccumulator): LineOutcome {
  // `ok` defaults to FALSE here and TRUE on `report` — deliberately opposite,
  // matching Rust's `unwrap_or(false)`/`unwrap_or(true)`. `tool` is present
  // only for a real room-tool completion; delegation status leaves it null so
  // `report` remains the child's single normalized completion.
  const payload = {
    ok: typeof ev.ok === "boolean" ? ev.ok : false,
    node: optionalStringField(ev, "node"),
    tool: optionalStringField(ev, "tool"),
  };
  return { kind: "event", state, event: { name: "ask-step-status", payload } };
}

export function finalLine(ev: Record<string, unknown>, state: StreamAccumulator): LineOutcome {
  // Emits nothing of its own — the delta stream already painted this text.
  return { kind: "silent", state: { ...state, finalText: stringField(ev, "v"), finalSeen: true } };
}

// PRIV-1: what the door did this turn ("N details hidden") arrives after
// `final`, and is rendered on the finished message.
export function privacyLine(ev: Record<string, unknown>, state: StreamAccumulator): LineOutcome {
  return { kind: "event", state, event: { name: "ask-privacy", payload: lineValue(ev) } };
}

export function usageLine(ev: Record<string, unknown>, state: StreamAccumulator): LineOutcome {
  // The one event whose whole NDJSON line becomes the payload, so the
  // discriminator and per-line run stamp must come off first. The identity
  // belongs on the envelope, not inside the persisted token-usage reading.
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
// stream, or any exception graph.py's driver caught. This must use the live
// mirror when no final arrived, otherwise it loses the partial reply.
export function errorLine(ev: Record<string, unknown>, state: StreamAccumulator): LineOutcome {
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

export const LINE_HANDLERS: Record<string, LineHandler> = {
  plan: planLine,
  agent: agentLine,
  lane: laneLine,
  round: roundLine,
  delta: deltaLine,
  step: stepLine,
  report: reportLine,
  step_status: stepStatusLine,
  final: finalLine,
  privacy: privacyLine,
  usage: usageLine,
  error: errorLine,
};

export function lineHandler(ev: Record<string, unknown>): LineHandler | undefined {
  return typeof ev.t === "string" ? LINE_HANDLERS[ev.t] : undefined;
}

export function isCurrentRun(ev: Record<string, unknown>, runId: string): boolean {
  const theirs = typeof ev.run_id === "string" ? ev.run_id : null;
  return theirs === null || theirs === runId;
}

export function processLine(
  ev: Record<string, unknown>,
  runId: string,
  state: StreamAccumulator
): LineOutcome {
  if (!isCurrentRun(ev, runId)) {
    return { kind: "dropped", state };
  }
  const handler = lineHandler(ev);
  return handler === undefined ? { kind: "dropped", state } : handler(ev, state);
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
export function doneFromCancellation(state: StreamAccumulator): SidecarOutcome {
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
export function transportFailure(state: StreamAccumulator, err: unknown): SidecarOutcome {
  return {
    kind: "failed",
    text: answerSoFar(state.finalText, state.streamed),
    error: err instanceof Error ? err.message : String(err),
    toolRan: state.toolRan,
    usage: state.lastUsage,
    plan: state.lastPlan,
  };
}
