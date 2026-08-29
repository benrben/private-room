/**
 * Unit tests for `sidecar.ts`'s `/run` NDJSON streaming client — the half
 * ported from `src-tauri/src/sidecar.rs`'s `stream_run`/`run_via_sidecar`
 * pair, not from `sidecar_lifecycle.rs`.
 *
 * WHY A SEPARATE FILE FROM `sidecar.test.ts`, which covers the same module:
 * `sidecar.test.ts` calls `vi.mock("node:child_process", ...)` at module
 * scope, because its single-flight test has to prove "exactly one spawn" for
 * two concurrent `ensureUp()` calls without a real Python interpreter. That
 * mock is file-wide and inescapable. Nothing here spawns anything, but the
 * WIRE-COMPAT sibling of this file (`sidecarRun.wire.test.ts`) spawns a real
 * Python sidecar via `node:child_process` — so the run-client tests cannot
 * live in a file where `spawn` is a stub, and splitting only the wire half
 * out would leave the unit tests separated from the wire tests they pair
 * with. Both halves of the run client are therefore here and in
 * `sidecarRun.wire.test.ts`; `sidecar.test.ts` keeps the process lifecycle.
 *
 * Six groups:
 *   1. `buildRunRequestBody` — the wire shape, checkable without a server.
 *   2. `processLine`/`finalOutcome`/`answerSoFar` — the pure line-kind
 *      switch, fed already-parsed JSON objects.
 *   3. `splitCompleteLines` — the byte-level parser, including a line split
 *      across chunk boundaries and a multi-byte character split mid-sequence.
 *   4. `waitForNextChunkOrCancel` + `cancelVerdict` + `deliverCancel` — the
 *      cancellation protocol, against fakes.
 *   5. `streamRun` end to end against a fake `fetch`.
 *   6. An ADVERSARIAL re-verification pass (2026-08-22) covering branches
 *      groups 1–5 left with no discriminating test: a foreign run's TERMINAL
 *      lines (`error`/`final`/`step`/`usage`, not just `delta`), the
 *      turn-vs-wire run identity guard, what Stop actually POSTs and how many
 *      times, the INNER per-line cancel check, and a multi-byte character cut
 *      across a chunk boundary end to end. Each was verified to fail against a
 *      mutant of the line it covers.
 * The REAL cross-language proof — a live, unmodified Python sidecar, nothing
 * mocked at the language boundary — is in `sidecarRun.wire.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AskEnvelope } from "../shared/events.js";
import { TurnId } from "./turn.js";
import {
  CANCEL_RETRY_DELAY_MS,
  answerSoFar,
  buildRunRequestBody,
  cancelVerdict,
  deliverCancel,
  finalOutcome,
  freshAccumulator,
  processLine,
  safeValidationDetail,
  splitCompleteLines,
  streamRun,
  waitForNextChunkOrCancel,
  type CancelPostResult,
  type ChunkReader,
  type RunViaSidecarRequest,
  type StreamAccumulator,
} from "./sidecar.js";

// ------------------------------------------------------------ 1. wire shape

describe("buildRunRequestBody", () => {
  const base: RunViaSidecarRequest = {
    model: "qwen3.5:9b",
    question: "what does the lease say",
    runId: "run-1",
    mcp: { url: "http://127.0.0.1:1/mcp", token: "tok" },
  };

  it("omits routing when the host has no decision", () => {
    // RunRequest.routing is nullable, but omitting the KEY entirely is what
    // keeps "we have no routing decision" and "routing is off" from being
    // spelled the same on the wire.
    expect(Object.prototype.hasOwnProperty.call(buildRunRequestBody(base), "routing")).toBe(false);
  });

  it("defaults every optional field the way RunRequest's own pydantic defaults do", () => {
    expect(buildRunRequestBody(base)).toEqual({
      model: "qwen3.5:9b",
      question: "what does the lease say",
      harness: "classic",
      messages: [],
      temperature: null,
      ollama_base_url: "http://127.0.0.1:11434",
      mcp: {
        url: "http://127.0.0.1:1/mcp",
        token: "tok",
        workspace_write: false,
        baseline_run_id: "",
      },
      web_enabled: false,
      tool_policy: "auto",
      max_rounds: null,
      turn_max_rounds: null,
      turn_max_stalls: null,
      run_id: "run-1",
      privacy: null,
      provider: null,
      supports_vision: null,
      max_context: null,
      advisors: [],
    });
  });

  it("carries every explicit value through under its exact snake_case wire name", () => {
    const body = buildRunRequestBody({
      ...base,
      harness: "deep",
      mcp: {
        ...base.mcp,
        workspaceWrite: true,
        baselineRunId: "run-1",
      },
      routing: { write: true },
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.4,
      ollamaBaseUrl: "http://127.0.0.1:9999",
      webEnabled: true,
      toolPolicy: "none",
      maxRounds: 5,
      turnMaxRounds: 10,
      turnMaxStalls: 2,
      maxContext: 8192,
      advisors: ["memory"],
      privacy: { active: true },
      provider: { id: "openrouter" },
      supportsVision: false,
    });
    expect(body).toEqual({
      model: "qwen3.5:9b",
      question: "what does the lease say",
      harness: "deep",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.4,
      ollama_base_url: "http://127.0.0.1:9999",
      mcp: {
        url: "http://127.0.0.1:1/mcp",
        token: "tok",
        workspace_write: true,
        baseline_run_id: "run-1",
      },
      routing: { write: true },
      web_enabled: true,
      tool_policy: "none",
      max_rounds: 5,
      turn_max_rounds: 10,
      turn_max_stalls: 2,
      run_id: "run-1",
      privacy: { active: true },
      provider: { id: "openrouter" },
      supports_vision: false,
      max_context: 8192,
      advisors: ["memory"],
    });
  });

  it("passes only the declared mcp capability fields, never caller extras", () => {
    // RunRequest carries extra="ignore", so a stray field is a SILENT drop on
    // the Python side rather than an error -- which is exactly why this
    // function names every key instead of serializing the caller's object.
    const req = { ...base, mcp: { url: "http://x/mcp", token: "t", extra: "nope" } } as RunViaSidecarRequest;
    expect(buildRunRequestBody(req).mcp).toEqual({
      url: "http://x/mcp",
      token: "t",
      workspace_write: false,
      baseline_run_id: "",
    });
  });
});

// -------------------------------------------------------- 2. the line switch

describe("processLine -- every line kind", () => {
  const runId = "ask-77";

  it("plan: records the roster and forwards it as-is", () => {
    const roster = [{ agent: "chat.answer", label: "Main agent", key: "main" }];
    const outcome = processLine({ t: "plan", v: roster, run_id: runId }, runId, freshAccumulator());
    if (outcome.kind !== "event") throw new Error("expected event");
    expect(outcome.event).toEqual({ name: "ask-plan", payload: roster });
    expect(outcome.state.lastPlan).toEqual(roster);
  });

  it("agent: forwards the active-agent payload as-is", () => {
    const active = { id: "chat.answer", label: "Main agent", step: 1, total: 1 };
    const outcome = processLine({ t: "agent", v: active, run_id: runId }, runId, freshAccumulator());
    if (outcome.kind !== "event") throw new Error("expected event");
    expect(outcome.event).toEqual({ name: "ask-agent", payload: active });
  });

  it("lane: emits the lane string", () => {
    const outcome = processLine({ t: "lane", v: "Working on your files", run_id: runId }, runId, freshAccumulator());
    if (outcome.kind !== "event") throw new Error("expected event");
    expect(outcome.event).toEqual({ name: "ask-lane", payload: "Working on your files" });
  });

  it("round: clears the streamed mirror (the UI drops its live text here too) and emits null", () => {
    const state: StreamAccumulator = { ...freshAccumulator(), streamed: "leftover from last round" };
    const outcome = processLine({ t: "round", run_id: runId }, runId, state);
    if (outcome.kind !== "event") throw new Error("expected event");
    expect(outcome.event).toEqual({ name: "ask-round", payload: null });
    expect(outcome.state.streamed).toBe("");
  });

  it("delta: appends to the mirror across multiple deltas and emits each chunk", () => {
    const first = processLine({ t: "delta", v: "hello ", run_id: runId }, runId, freshAccumulator());
    if (first.kind !== "event") throw new Error("expected event");
    expect(first.event).toEqual({ name: "ask-delta", payload: "hello " });
    const second = processLine({ t: "delta", v: "world", run_id: runId }, runId, first.state);
    if (second.kind !== "event") throw new Error("expected event");
    expect(second.state.streamed).toBe("hello world");
  });

  it("step: marks a tool ran and carries {label, node}", () => {
    const outcome = processLine(
      { t: "step", v: "Searched the room", node: "files.read#0", run_id: runId },
      runId,
      freshAccumulator()
    );
    if (outcome.kind !== "event") throw new Error("expected event");
    expect(outcome.event).toEqual({
      name: "ask-step",
      payload: { label: "Searched the room", node: "files.read#0" },
    });
    expect(outcome.state.toolRan).toBe(true);
  });

  it("step: node defaults to null when absent (an older sidecar's line)", () => {
    const outcome = processLine({ t: "step", v: "Searched the room", run_id: runId }, runId, freshAccumulator());
    if (outcome.kind !== "event") throw new Error("expected event");
    expect(outcome.event.payload).toEqual({ label: "Searched the room", node: null });
  });

  it("report: ok defaults to TRUE when absent", () => {
    const outcome = processLine(
      { t: "report", v: "Report from the File agent: found it", node: "files.read#0", run_id: runId },
      runId,
      freshAccumulator()
    );
    if (outcome.kind !== "event") throw new Error("expected event");
    expect(outcome.event).toEqual({
      name: "ask-report",
      payload: { node: "files.read#0", text: "Report from the File agent: found it", ok: true },
    });
  });

  it("report: an explicit ok:false survives", () => {
    const outcome = processLine(
      { t: "report", v: "could not reach that domain", node: "web#0", ok: false, run_id: runId },
      runId,
      freshAccumulator()
    );
    if (outcome.kind !== "event") throw new Error("expected event");
    expect(outcome.event.payload).toEqual({ node: "web#0", text: "could not reach that domain", ok: false });
  });

  it("step_status: ok defaults to FALSE when absent -- the OPPOSITE default from report", () => {
    // Both defaults are pinned deliberately: they differ, and matching Rust's
    // unwrap_or(false)/unwrap_or(true) is the only reason either is right.
    const outcome = processLine({ t: "step_status", node: "main", run_id: runId }, runId, freshAccumulator());
    if (outcome.kind !== "event") throw new Error("expected event");
    expect(outcome.event).toEqual({
      name: "ask-step-status",
      payload: { ok: false, node: "main", tool: null },
    });
  });

  it("step_status preserves the exact completed room-tool name", () => {
    const outcome = processLine(
      { t: "step_status", ok: true, node: "files.read#0", tool: "workspace_rename", run_id: runId },
      runId,
      freshAccumulator(),
    );
    if (outcome.kind !== "event") throw new Error("expected event");
    expect(outcome.event).toEqual({
      name: "ask-step-status",
      payload: { ok: true, node: "files.read#0", tool: "workspace_rename" },
    });
  });

  it("final: records the text and the seen flag, but emits NOTHING", () => {
    const outcome = processLine({ t: "final", v: "The rent is 1200.", run_id: runId }, runId, freshAccumulator());
    if (outcome.kind !== "silent") throw new Error("expected silent");
    expect(outcome.state.finalText).toBe("The rent is 1200.");
    expect(outcome.state.finalSeen).toBe(true);
  });

  it("privacy: forwards the door's receipt as-is", () => {
    const receipt = { entities_hidden: 2, replacements: 2 };
    const outcome = processLine({ t: "privacy", v: receipt, run_id: runId }, runId, freshAccumulator());
    if (outcome.kind !== "event") throw new Error("expected event");
    expect(outcome.event).toEqual({ name: "ask-privacy", payload: receipt });
  });

  it("usage: strips t AND run_id but keeps every other field, and records the snapshot", () => {
    const outcome = processLine(
      { t: "usage", total_tokens: 42, max_context: 8192, estimated: false, node: "main", run_id: runId },
      runId,
      freshAccumulator()
    );
    if (outcome.kind !== "event") throw new Error("expected event");
    const expected = { total_tokens: 42, max_context: 8192, estimated: false, node: "main" };
    expect(outcome.event).toEqual({ name: "ask-token-usage", payload: expected });
    expect(outcome.state.lastUsage).toEqual(expected);
    // This payload is persisted into the room's message row -- the run stamp
    // and the NDJSON discriminator must not ride along into it.
    expect(outcome.event.payload).not.toHaveProperty("t");
    expect(outcome.event.payload).not.toHaveProperty("run_id");
  });

  it("error: TERMINAL -- carries the partial answer, the error text, toolRan, usage and plan", () => {
    const state: StreamAccumulator = {
      finalText: "",
      finalSeen: false,
      streamed: "half an answer",
      lastUsage: { total_tokens: 1 },
      lastPlan: [{ agent: "main" }],
      toolRan: true,
    };
    const outcome = processLine({ t: "error", v: "the run was torn down", run_id: runId }, runId, state);
    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.outcome).toEqual({
      kind: "failed",
      text: "half an answer",
      error: "the run was torn down",
      toolRan: true,
      usage: { total_tokens: 1 },
      plan: [{ agent: "main" }],
    });
  });

  it("a line stamped for a DIFFERENT run is dropped, not painted -- state unchanged", () => {
    const state = freshAccumulator();
    const outcome = processLine({ t: "delta", v: "SOMEONE ELSE'S", run_id: "ask-99" }, runId, state);
    expect(outcome).toEqual({ kind: "dropped", state });
    if (outcome.kind !== "dropped") throw new Error("expected dropped");
    expect(outcome.state).toBe(state); // the same object -- nothing happened
  });

  it("an UNSTAMPED line is read as ours -- an older sidecar, not a foreign run", () => {
    expect(processLine({ t: "delta", v: "mine" }, runId, freshAccumulator()).kind).toBe("event");
  });

  it("a run_id that is present but NOT a string is treated as unstamped, matching Rust's as_str()", () => {
    // Rust: ev.get("run_id").and_then(|r| r.as_str()) -- a non-string yields
    // None, i.e. "no stamp", never "a foreign run".
    expect(processLine({ t: "delta", v: "mine", run_id: 42 }, runId, freshAccumulator()).kind).toBe("event");
  });

  it("an unknown line kind, and a line with no t at all, are dropped silently", () => {
    const state = freshAccumulator();
    expect(processLine({ t: "something_future_versions_might_add", run_id: runId }, runId, state)).toEqual({
      kind: "dropped",
      state,
    });
    expect(processLine({ run_id: runId }, runId, state)).toEqual({ kind: "dropped", state });
  });
});

describe("finalOutcome / answerSoFar -- the load-bearing invariant", () => {
  it("a stream that never sent final is a LOST answer, not an empty one", () => {
    // SPEC §4: exactly one `final` per run, and the graph floors an empty
    // answer to "Done." before it reaches the wire. Reporting a stream with
    // no `final` as a successful empty done("") is how a torn-down run saved a
    // zero-byte assistant message with no error at all.
    const state: StreamAccumulator = { ...freshAccumulator(), toolRan: true };
    const outcome = finalOutcome(state);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("expected failed");
    expect(outcome.error).toBe("the agent sidecar ended the run without an answer");
    // toolRan must survive so the caller keeps the partial and never retries.
    expect(outcome.toolRan).toBe(true);
  });

  it("a real final -- including a floored 'Done.' -- passes through as done", () => {
    const state: StreamAccumulator = { ...freshAccumulator(), finalText: "Done.", finalSeen: true };
    expect(finalOutcome(state)).toEqual({ kind: "done", text: "Done.", usage: null, plan: null });
  });

  it("a torn-down run keeps the text the user watched arrive, not final_text alone", () => {
    const state: StreamAccumulator = { ...freshAccumulator(), streamed: "half an answer" };
    const outcome = finalOutcome(state);
    expect(outcome.kind).toBe("failed");
    expect(outcome.text).toBe("half an answer");
  });

  it("a final carrying only whitespace is not an answer -- the mirror still wins", () => {
    const state: StreamAccumulator = {
      ...freshAccumulator(),
      finalSeen: true,
      finalText: "  \n",
      streamed: "half an answer",
    };
    expect(finalOutcome(state)).toEqual({ kind: "done", text: "half an answer", usage: null, plan: null });
  });

  it("nothing streamed and nothing finalized stays genuinely empty -- and still failed", () => {
    expect(finalOutcome(freshAccumulator())).toEqual({
      kind: "failed",
      text: "",
      error: "the agent sidecar ended the run without an answer",
      toolRan: false,
      usage: null,
      plan: null,
    });
  });

  it("answerSoFar: a real final beats the mirror, but a blank one defers to it", () => {
    expect(answerSoFar("the whole answer", "partial")).toBe("the whole answer");
    expect(answerSoFar("", "partial")).toBe("partial");
    expect(answerSoFar("\t \n", "partial")).toBe("partial");
    expect(answerSoFar("", "")).toBe("");
  });
});

// ------------------------------------------------------- 3. the byte parser

describe("splitCompleteLines (the byte-level NDJSON parser)", () => {
  it("holds a line split across two chunks until its newline arrives", () => {
    const first = Buffer.from('{"t":"delta","v":"partial');
    const r1 = splitCompleteLines(first);
    expect(r1.lines).toEqual([]);
    expect(r1.rest.equals(first)).toBe(true);

    const r2 = splitCompleteLines(Buffer.concat([r1.rest, Buffer.from('"}\n{"t":"final","v":"done"}\n')]));
    expect(r2.lines).toEqual(['{"t":"delta","v":"partial"}', '{"t":"final","v":"done"}']);
    expect(r2.rest.length).toBe(0);
  });

  it("returns every complete line when several arrive in one chunk", () => {
    const { lines, rest } = splitCompleteLines(Buffer.from('{"t":"a"}\n{"t":"b"}\n{"t":"c"}\n'));
    expect(lines).toEqual(['{"t":"a"}', '{"t":"b"}', '{"t":"c"}']);
    expect(rest.length).toBe(0);
  });

  it("splits lines AND keeps a trailing partial from the same chunk", () => {
    const { lines, rest } = splitCompleteLines(Buffer.from('{"t":"a"}\n{"t":"b"}\n{"t":"c"'));
    expect(lines).toEqual(['{"t":"a"}', '{"t":"b"}']);
    expect(rest.toString("utf8")).toBe('{"t":"c"');
  });

  it("a split landing exactly ON the newline still works", () => {
    const r1 = splitCompleteLines(Buffer.from('{"t":"round"}'));
    expect(r1.lines).toEqual([]);
    expect(splitCompleteLines(Buffer.concat([r1.rest, Buffer.from("\n")])).lines).toEqual(['{"t":"round"}']);
  });

  it("drops a blank line silently, matching Rust's `if line.is_empty() { continue; }`", () => {
    expect(splitCompleteLines(Buffer.from('{"t":"a"}\n\n{"t":"b"}\n')).lines).toEqual(['{"t":"a"}', '{"t":"b"}']);
  });

  it("tolerates a stray \\r\\n even though the sidecar never sends one", () => {
    expect(splitCompleteLines(Buffer.from('{"t":"a"}\r\n')).lines).toEqual(['{"t":"a"}']);
  });

  it("decodes a multi-byte UTF-8 character split exactly across a chunk boundary", () => {
    const whole = Buffer.from('{"t":"delta","v":"עברית"}\n', "utf8");
    // Cut ONE BYTE into the multi-byte Hebrew run -- a naive per-chunk decode
    // (rather than buffering raw bytes until a full line exists) corrupts
    // this character into a replacement char.
    const splitAt = whole.indexOf(Buffer.from("עברית", "utf8")) + 1;
    const r1 = splitCompleteLines(whole.subarray(0, splitAt));
    expect(r1.lines).toEqual([]);
    const r2 = splitCompleteLines(Buffer.concat([r1.rest, whole.subarray(splitAt)]));
    expect(r2.lines).toHaveLength(1);
    expect(JSON.parse(r2.lines[0]!).v).toBe("עברית");
  });
});

// ------------------------------------------------------- 4. the stop protocol

describe("waitForNextChunkOrCancel", () => {
  it("passes an already-available chunk straight through", async () => {
    const reader: ChunkReader = { read: vi.fn().mockResolvedValue({ done: false, value: new Uint8Array([1, 2, 3]) }) };
    expect(await waitForNextChunkOrCancel(reader, undefined)).toEqual({ kind: "chunk", value: new Uint8Array([1, 2, 3]) });
  });

  it("reports the stream ending", async () => {
    expect(await waitForNextChunkOrCancel({ read: async () => ({ done: true }) }, undefined)).toEqual({ kind: "ended" });
  });

  it("notices cancellation while the reader is saying nothing at all", async () => {
    // The wedged-engine shape: a tool runs on a separate connection for ~90s
    // and this stream produces not one byte the whole time.
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const step = await waitForNextChunkOrCancel({ read: () => new Promise(() => {}) }, controller.signal);
    expect(step).toEqual({ kind: "cancelled" });
  }, 5_000);

  it("an already-aborted signal is noticed on the FIRST poll, not a full cadence tick later", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const step = await waitForNextChunkOrCancel({ read: () => new Promise(() => {}) }, controller.signal);
    expect(step).toEqual({ kind: "cancelled" });
    expect(Date.now() - started).toBeLessThan(90);
  });

  it("prefers a chunk that is already available over an ALREADY-aborted signal (Rust's `biased`)", async () => {
    // Data that has arrived must win: the cancel arm may only take the
    // stream when it is genuinely idle, or a Stop pressed at the same instant
    // would silently discard a line the sidecar had already delivered.
    const controller = new AbortController();
    controller.abort();
    const reader: ChunkReader = { read: async () => ({ done: false, value: new Uint8Array([7]) }) };
    expect(await waitForNextChunkOrCancel(reader, controller.signal)).toEqual({
      kind: "chunk",
      value: new Uint8Array([7]),
    });
  });

  it("a rejected read propagates, so the caller can turn it into a Failed outcome", async () => {
    await expect(
      waitForNextChunkOrCancel({ read: async () => Promise.reject(new Error("terminated")) }, undefined)
    ).rejects.toThrow("terminated");
  });

  it("an abandoned read that later REJECTS does not become an unhandled rejection", async () => {
    // On cancellation the pending read is deliberately left unobserved (it
    // must never be abandoned mid-request and re-issued). If it then rejects
    // with nobody awaiting it, Node's default --unhandled-rejections=throw
    // would take the whole app down over a socket we had already given up on.
    const controller = new AbortController();
    controller.abort();
    let rejectRead!: (err: Error) => void;
    const reader: ChunkReader = { read: () => new Promise((_r, reject) => (rejectRead = reject)) };

    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => void unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
      expect(await waitForNextChunkOrCancel(reader, controller.signal)).toEqual({ kind: "cancelled" });
      rejectRead(new Error("socket destroyed after we gave up"));
      // Two macrotask turns is plenty for Node to have reported it.
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("cancelVerdict", () => {
  it("known:true on a 2xx is accepted", () => {
    expect(cancelVerdict(200, { ok: true, known: true })).toEqual({ ok: true });
  });

  it("known:false is NOT an accepted stop, even on a 200", () => {
    const result = cancelVerdict(200, { ok: true, known: false });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("did not recognise");
  });

  it("a non-2xx is a failed delivery whatever the body says", () => {
    const result = cancelVerdict(503, { ok: true, known: true });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("503");
  });

  it("an absent known field is treated as ACCEPTED -- forward-compat, not a phantom failure", () => {
    expect(cancelVerdict(200, { ok: true }).ok).toBe(true);
    expect(cancelVerdict(200, null).ok).toBe(true);
    expect(cancelVerdict(204, "done").ok).toBe(true);
  });
});

describe("deliverCancel: retry exactly once on known:false", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries EXACTLY once when the first reply is known:false, and only after the documented delay", async () => {
    vi.useFakeTimers();
    const post = vi.fn<(base: string, runId: string) => Promise<CancelPostResult>>();
    post.mockResolvedValueOnce({ ok: false, error: "the AI service did not recognise the run" });
    post.mockResolvedValueOnce({ ok: true });

    const pending = deliverCancel("http://sidecar", "run-1", post);
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CANCEL_RETRY_DELAY_MS - 1);
    expect(post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toEqual({ ok: true });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("does not retry at all when the first attempt already succeeded", async () => {
    const post = vi.fn<(base: string, runId: string) => Promise<CancelPostResult>>().mockResolvedValue({ ok: true });
    expect(await deliverCancel("http://sidecar", "run-1", post)).toEqual({ ok: true });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("known:false on BOTH attempts stops after exactly one retry, and SAYS SO on stderr", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const post = vi
      .fn<(base: string, runId: string) => Promise<CancelPostResult>>()
      .mockResolvedValue({ ok: false, error: "the AI service did not recognise the run" });

    const pending = deliverCancel("http://sidecar", "run-2", post);
    await vi.advanceTimersByTimeAsync(CANCEL_RETRY_DELAY_MS);
    const result = await pending;

    expect(post).toHaveBeenCalledTimes(2); // exactly one retry, never more
    expect(result.ok).toBe(false);
    // The run may genuinely still be going -- swallowing that is the one
    // thing this must not do.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain("run-2");
    errorSpy.mockRestore();
  });
});

describe("safeValidationDetail", () => {
  it("reads loc/msg and NEVER the rejected input, which can be an API key", () => {
    const detail = safeValidationDetail({
      detail: [{ loc: ["body", "provider", "api_key"], msg: "Field required", input: { apiKey: "sk-do-not-leak" } }],
    });
    expect(detail).toBe("provider.api_key: Field required");
    expect(detail).not.toContain("sk-do-not-leak");
  });

  it("returns null for a body that is not a pydantic validation error at all", () => {
    expect(safeValidationDetail({ error: "nope" })).toBeNull();
    expect(safeValidationDetail("plain text")).toBeNull();
    expect(safeValidationDetail(null)).toBeNull();
  });
});

// --------------------------------------------------------- 5. streamRun e2e

/** One NDJSON response, a line per chunk. Module-level so section 6's
 * adversarial blocks can reuse it rather than keep a second copy. */
function ndjson(lines: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const line of lines) {
          controller.enqueue(encoder.encode(`${line}\n`));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "application/x-ndjson" } }
  );
}

describe("streamRun (fake fetch, no network)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const ndjsonResponse = ndjson;

  const req: RunViaSidecarRequest = {
    model: "qwen3.5:9b",
    question: "what is the rent",
    runId: "ask-77",
    mcp: { url: "http://127.0.0.1:1/mcp", token: "tok" },
  };

  it("every emitted event carries the turn's envelope, and the wire payload passes through as v", async () => {
    const seen: Array<{ event: string; payload: AskEnvelope<unknown> }> = [];
    globalThis.fetch = vi.fn(async () =>
      ndjsonResponse([
        JSON.stringify({ t: "delta", v: "looking it up", run_id: "ask-77" }),
        JSON.stringify({ t: "final", v: "the answer", run_id: "ask-77" }),
      ])
    ) as unknown as typeof fetch;

    const outcome = await streamRun("http://sidecar", req, {
      turn: new TurnId("ask-77", "chat-a"),
      onEvent: (event, payload) => seen.push({ event, payload: payload as AskEnvelope<unknown> }),
    });

    expect(outcome).toEqual({ kind: "done", text: "the answer", usage: null, plan: null });
    // `final` emits nothing of its own -- the delta already painted the text.
    expect(seen).toEqual([{ event: "ask-delta", payload: { runId: "ask-77", chatId: "chat-a", v: "looking it up" } }]);
  });

  it("a turn of null suppresses every emit but still returns the real outcome", async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async () =>
      ndjsonResponse([
        JSON.stringify({ t: "delta", v: "The rent is 1200.", run_id: "ask-77" }),
        JSON.stringify({ t: "final", v: "The rent is 1200.", run_id: "ask-77" }),
      ])
    ) as unknown as typeof fetch;

    const outcome = await streamRun("http://sidecar", req, {
      turn: null,
      onEvent: (event) => seen.push(event),
    });
    expect(seen).toEqual([]);
    expect(outcome).toEqual({ kind: "done", text: "The rent is 1200.", usage: null, plan: null });
  });

  it("an event sender that THROWS never fails the run -- a closed window is not an error", async () => {
    // turn.ts's own contract (Rust: `let _ = to.emit(...)`). Emitting through
    // TurnId.emit rather than calling the sender directly is what buys this;
    // a bare call would abort the whole answer on the first dead window.
    globalThis.fetch = vi.fn(async () =>
      ndjsonResponse([
        JSON.stringify({ t: "delta", v: "still streaming", run_id: "ask-77" }),
        JSON.stringify({ t: "final", v: "the answer", run_id: "ask-77" }),
      ])
    ) as unknown as typeof fetch;

    const outcome = await streamRun("http://sidecar", req, {
      turn: new TurnId("ask-77", "chat-a"),
      onEvent: () => {
        throw new Error("window is gone");
      },
    });
    expect(outcome).toEqual({ kind: "done", text: "the answer", usage: null, plan: null });
  });

  it("a line stamped for a different run is dropped even when a turn is listening", async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async () =>
      ndjsonResponse([
        JSON.stringify({ t: "delta", v: "mine", run_id: "ask-77" }),
        JSON.stringify({ t: "delta", v: "SOMEONE ELSE'S", run_id: "ask-99" }),
        JSON.stringify({ t: "final", v: "mine", run_id: "ask-77" }),
      ])
    ) as unknown as typeof fetch;

    const outcome = await streamRun("http://sidecar", req, {
      turn: new TurnId("ask-77", "chat-a"),
      onEvent: (_event, payload) => seen.push((payload as AskEnvelope<string>).v),
    });
    expect(seen).toEqual(["mine"]);
    // ...and the foreign delta never reached the answer text either.
    expect(outcome).toEqual({ kind: "done", text: "mine", usage: null, plan: null });
  });

  it("a stream that ends with no final and no error is a failure, not an empty success", async () => {
    globalThis.fetch = vi.fn(async () =>
      ndjsonResponse([JSON.stringify({ t: "delta", v: "as far as it got", run_id: "ask-77" })])
    ) as unknown as typeof fetch;

    const outcome = await streamRun("http://sidecar", req, { turn: null, onEvent: () => undefined });
    if (outcome.kind !== "failed") throw new Error("expected failed");
    expect(outcome.text).toBe("as far as it got");
    expect(outcome.error).toBe("the agent sidecar ended the run without an answer");
  });

  it("a stream that REJECTS mid-flight returns Failed with the partial -- it never throws", async () => {
    // A severed connection: uvicorn closes without the terminating chunk and
    // Node's reader rejects. Rust's own `Some(Err(e)) => Failed { text:
    // answer_so_far(..) }`. Throwing here would lose the partial AND hand the
    // caller an exception where every other exit hands it an outcome.
    // Delivered on the FIRST read, severed on the second -- the real
    // sequence. (Enqueue-then-error in `start` would not model it: erroring a
    // ReadableStream discards whatever is still queued, so the delta would
    // never reach the client and the test would pass for the wrong reason.)
    let reads = 0;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (reads++ === 0) {
                controller.enqueue(
                  new TextEncoder().encode(JSON.stringify({ t: "delta", v: "half an answer", run_id: "ask-77" }) + "\n")
                );
                return;
              }
              controller.error(new Error("terminated"));
            },
          }),
          { status: 200 }
        )
    ) as unknown as typeof fetch;

    const outcome = await streamRun("http://sidecar", req, { turn: null, onEvent: () => undefined });
    if (outcome.kind !== "failed") throw new Error("expected failed");
    expect(outcome.text).toBe("half an answer");
    expect(outcome.error).toContain("terminated");
  });

  it("a malformed line is skipped rather than aborting the run", async () => {
    globalThis.fetch = vi.fn(async () =>
      ndjsonResponse([
        "{not json at all",
        JSON.stringify({ t: "delta", v: "still fine", run_id: "ask-77" }),
        JSON.stringify({ t: "final", v: "still fine", run_id: "ask-77" }),
      ])
    ) as unknown as typeof fetch;

    expect(await streamRun("http://sidecar", req, { turn: null, onEvent: () => undefined })).toEqual({
      kind: "done",
      text: "still fine",
      usage: null,
      plan: null,
    });
  });

  it("a JSON line split across two stream chunks is reassembled, not dropped", async () => {
    const line = JSON.stringify({ t: "final", v: "reassembled", run_id: "ask-77" }) + "\n";
    const bytes = new TextEncoder().encode(line);
    const cut = Math.floor(bytes.length / 2);
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes.slice(0, cut));
              controller.enqueue(bytes.slice(cut));
              controller.close();
            },
          }),
          { status: 200 }
        )
    ) as unknown as typeof fetch;

    expect(await streamRun("http://sidecar", req, { turn: null, onEvent: () => undefined })).toEqual({
      kind: "done",
      text: "reassembled",
      usage: null,
      plan: null,
    });
  });

  it("a non-2xx /run response becomes a failed outcome with the safe detail, never the raw input", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            detail: [{ loc: ["body", "provider", "api_key"], msg: "Field required", input: { apiKey: "do-not-leak" } }],
          }),
          { status: 422 }
        )
    ) as unknown as typeof fetch;

    const outcome = await streamRun("http://sidecar", req, { turn: null, onEvent: () => undefined });
    if (outcome.kind !== "failed") throw new Error("expected failed");
    expect(outcome.error).toContain("provider.api_key: Field required");
    expect(outcome.error).not.toContain("do-not-leak");
  });

  it("a network failure on the initial POST becomes a failed outcome", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const outcome = await streamRun("http://sidecar", req, { turn: null, onEvent: () => undefined });
    if (outcome.kind !== "failed") throw new Error("expected failed");
    expect(outcome.error).toContain("sidecar /run failed");
    expect(outcome.error).toContain("ECONNREFUSED");
  });

  it("a `round` clears the mirror, so a stopped multi-round turn hands back only the last round", async () => {
    globalThis.fetch = vi.fn(async () =>
      ndjsonResponse([
        JSON.stringify({ t: "delta", v: "first round deliberation", run_id: "ask-77" }),
        JSON.stringify({ t: "round", run_id: "ask-77" }),
        JSON.stringify({ t: "delta", v: "the real answer", run_id: "ask-77" }),
      ])
    ) as unknown as typeof fetch;

    const outcome = await streamRun("http://sidecar", req, { turn: null, onEvent: () => undefined });
    expect(outcome.text).toBe("the real answer");
  });
});

// ============================================================================
// 6. ADVERSARIAL REGRESSION PASS (2026-08-22)
// ============================================================================
//
// Added by an adversarial re-verification of the merged `/run` client. Each
// block below covers a branch the original batch left with NO discriminating
// test — i.e. one that could be deleted outright with the suite still green.
// The comment on each says what it kills.

describe("a FOREIGN run's line can never end OUR run", () => {
  const runId = "ask-77";

  it("a foreign `error` line is DROPPED, not treated as our terminal outcome", () => {
    // The original batch only proved the run-stamp guard on a `delta`. `error`
    // is the one kind whose misattribution is unrecoverable: it is TERMINAL,
    // so another run's failure would end ours -- reporting a failed answer to
    // a user whose own run was still streaming happily.
    const state: StreamAccumulator = { ...freshAccumulator(), streamed: "our own partial" };
    const outcome = processLine(
      { t: "error", v: "SOMEONE ELSE'S RUN DIED", run_id: "ask-99" },
      runId,
      state
    );
    expect(outcome.kind).toBe("dropped");
    if (outcome.kind !== "dropped") throw new Error("expected dropped");
    expect(outcome.state).toBe(state);
  });

  it("a foreign `final` line neither ends the run nor becomes our answer", () => {
    // The mirror hazard of the above: a foreign `final` would set finalSeen
    // and turn a run that LOST its answer into a confident `done` carrying
    // another conversation's text.
    const outcome = processLine({ t: "final", v: "SOMEONE ELSE'S ANSWER", run_id: "ask-99" }, runId, freshAccumulator());
    expect(outcome.kind).toBe("dropped");
    if (outcome.kind !== "dropped") throw new Error("expected dropped");
    expect(outcome.state.finalSeen).toBe(false);
    expect(outcome.state.finalText).toBe("");
  });

  it("a foreign `step` line does not set toolRan, which gates whether a turn may be retried", () => {
    // `toolRan` is the flag a caller reads to decide "a side effect already
    // committed, never re-run this turn". Another run's tool must not be able
    // to set it -- nor to clear the way for a double write by being missed.
    const outcome = processLine({ t: "step", v: "Wrote a file", run_id: "ask-99" }, runId, freshAccumulator());
    expect(outcome.kind).toBe("dropped");
    if (outcome.kind !== "dropped") throw new Error("expected dropped");
    expect(outcome.state.toolRan).toBe(false);
  });

  it("a foreign `usage` line does not become the snapshot persisted on OUR message row", () => {
    const outcome = processLine({ t: "usage", total_tokens: 999_999, run_id: "ask-99" }, runId, freshAccumulator());
    expect(outcome.kind).toBe("dropped");
    if (outcome.kind !== "dropped") throw new Error("expected dropped");
    expect(outcome.state.lastUsage).toBeNull();
  });
});

describe("streamRun: the run identity it emits under must be the run identity on the wire", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const req: RunViaSidecarRequest = {
    model: "qwen3.5:9b",
    question: "what is the rent",
    runId: "ask-77",
    mcp: { url: "http://127.0.0.1:1/mcp", token: "tok" },
  };

  it("REFUSES a run whose TurnId names a different run than the one being started", async () => {
    // `req.runId` and `opts.turn.runId` are two independent parameters of a
    // PUBLIC function, and the whole module only works when they are equal:
    // the wire is stamped with `req.runId` (so `processLine` accepts those
    // lines) while every event goes out stamped `turn.runId`, and `/cancel`
    // is delivered for `req.runId`.
    //
    // A mismatch is therefore SILENT and total. `runIdentity.ts`'s
    // `applyEvent` drops any event whose envelope runId is not the one the
    // chat registered -- so the user watches a turn that emits a full stream
    // of events and paints NOTHING, with no error anywhere, while Stop
    // cancels an id the chat never registered. That is precisely the class of
    // defect `turn.ts` exists to delete, so it must not be startable.
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const seen: string[] = [];
    const outcome = await streamRun("http://sidecar", req, {
      turn: new TurnId("a-completely-different-run", "chat-a"),
      onEvent: (event) => seen.push(event),
    });

    if (outcome.kind !== "failed") throw new Error("expected failed");
    expect(outcome.error).toContain("ask-77");
    expect(outcome.error).toContain("a-completely-different-run");
    // Refused BEFORE anything was started: no run to cancel, no tool that
    // could have committed a side effect, nothing emitted under a foreign id.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outcome.toolRan).toBe(false);
    expect(seen).toEqual([]);
  });

  it("a MATCHING TurnId is the ordinary case and is untouched by the guard", async () => {
    globalThis.fetch = vi.fn(async () =>
      ndjson([
        JSON.stringify({ t: "delta", v: "the answer", run_id: "ask-77" }),
        JSON.stringify({ t: "final", v: "the answer", run_id: "ask-77" }),
      ])
    ) as unknown as typeof fetch;

    const seen: AskEnvelope<unknown>[] = [];
    const outcome = await streamRun("http://sidecar", req, {
      turn: new TurnId("ask-77", "chat-a"),
      onEvent: (_event, payload) => seen.push(payload as AskEnvelope<unknown>),
    });
    expect(outcome.kind).toBe("done");
    expect(seen.map((s) => s.runId)).toEqual(["ask-77"]);
  });

  it("a null turn is NOT a mismatch -- a headless run has no identity to disagree with", async () => {
    globalThis.fetch = vi.fn(async () =>
      ndjson([JSON.stringify({ t: "final", v: "quietly done", run_id: "ask-77" })])
    ) as unknown as typeof fetch;

    expect(await streamRun("http://sidecar", req, { turn: null, onEvent: () => undefined })).toEqual({
      kind: "done",
      text: "quietly done",
      usage: null,
      plan: null,
    });
  });
});

describe("streamRun: what Stop actually does over the wire", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const req: RunViaSidecarRequest = {
    model: "qwen3.5:9b",
    question: "what is the rent",
    runId: "ask-77",
    mcp: { url: "http://127.0.0.1:1/mcp", token: "tok" },
  };

  /** A fake sidecar that answers `/run` with `runBody` and `/cancel` with
   * `cancelBody`, recording every `/cancel` it is asked for. */
  function fakeSidecar(runBody: () => ReadableStream<Uint8Array>, cancelBody: unknown): { cancels: unknown[] } {
    const cancels: unknown[] = [];
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String((input as { url: string }).url);
      if (url.endsWith("/cancel")) {
        cancels.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(cancelBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(runBody(), { status: 200 });
    }) as unknown as typeof fetch;
    return { cancels };
  }

  /** One delta, then silence forever -- the shape of a tool executing on a
   * SEPARATE connection while this stream produces not one byte. Stop has to
   * be observed here or it waits out the whole tool call. */
  function oneDeltaThenSilence(lines: string[]): ReadableStream<Uint8Array> {
    let sent = false;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return new Promise<void>(() => {}); // never settles: idle
        sent = true;
        controller.enqueue(new TextEncoder().encode(lines.map((l) => `${l}\n`).join("")));
        return undefined;
      },
    });
  }

  it("POSTs /cancel for THIS run and returns the partial as done -- one POST when the sidecar knows the run", async () => {
    const controller = new AbortController();
    const { cancels } = fakeSidecar(
      () => oneDeltaThenSilence([JSON.stringify({ t: "delta", v: "half an answer", run_id: "ask-77" })]),
      { ok: true, known: true, stopped: ["ask-77"] }
    );

    const outcome = await streamRun("http://sidecar", req, {
      turn: new TurnId("ask-77", "chat-a"),
      signal: controller.signal,
      onEvent: (event) => {
        if (event === "ask-delta") controller.abort();
      },
    });

    // A clean Stop is a successful PARTIAL answer, not a failure.
    expect(outcome).toEqual({ kind: "done", text: "half an answer", usage: null, plan: null });
    // Load-bearing: tearing the local connection down does NOT stop the Python
    // run. The POST is the only thing that does, and it names THIS run.
    expect(cancels).toEqual([{ run_id: "ask-77" }]);
  }, 10_000);

  it("retries the Stop EXACTLY once when the sidecar answers known:false -- never zero, never more", async () => {
    // `known:false` is also what a Stop that RACED the run's own registration
    // looks like, so one retry is right. A second retry would delay Stop past
    // the point the UI has already said "stopped"; zero would leave a genuine
    // race unrecovered.
    const controller = new AbortController();
    const { cancels } = fakeSidecar(
      () => oneDeltaThenSilence([JSON.stringify({ t: "delta", v: "half an answer", run_id: "ask-77" })]),
      { ok: true, known: false, stopped: [] }
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const outcome = await streamRun("http://sidecar", req, {
        turn: new TurnId("ask-77", "chat-a"),
        signal: controller.signal,
        onEvent: (event) => {
          if (event === "ask-delta") controller.abort();
        },
      });
      expect(outcome.kind).toBe("done");
      expect(cancels).toEqual([{ run_id: "ask-77" }, { run_id: "ask-77" }]);
      // An unconfirmed Stop is SAID, not swallowed: the run may still be
      // finishing this step, and nothing else in the app would ever notice.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain("ask-77");
    } finally {
      errorSpy.mockRestore();
    }
  }, 10_000);

  it("a Stop landing while several lines sit ALREADY BUFFERED takes effect on the next line, not the next network read", async () => {
    // The INNER per-line cancel check (Rust's own `if cancel.load(..)` inside
    // its per-line loop). Delete it and this run keeps applying every line the
    // chunk happened to carry: `text` becomes "firstsecond" and the user is
    // handed deliberation that arrived AFTER they pressed Stop.
    const controller = new AbortController();
    const { cancels } = fakeSidecar(
      () =>
        oneDeltaThenSilence([
          JSON.stringify({ t: "delta", v: "first", run_id: "ask-77" }),
          JSON.stringify({ t: "delta", v: "second", run_id: "ask-77" }),
          JSON.stringify({ t: "final", v: "WHOLE ANSWER FROM AFTER THE STOP", run_id: "ask-77" }),
        ]),
      { ok: true, known: true, stopped: ["ask-77"] }
    );

    const deltas: string[] = [];
    const outcome = await streamRun("http://sidecar", req, {
      turn: new TurnId("ask-77", "chat-a"),
      signal: controller.signal,
      onEvent: (event, payload) => {
        if (event !== "ask-delta") return;
        deltas.push((payload as AskEnvelope<string>).v);
        controller.abort(); // pressed while lines 2 and 3 are already in hand
      },
    });

    expect(deltas).toEqual(["first"]);
    expect(outcome).toEqual({ kind: "done", text: "first", usage: null, plan: null });
    expect(cancels).toEqual([{ run_id: "ask-77" }]);
  }, 10_000);

  it("Stop is delivered BEFORE the outcome is returned, so the caller never reports 'stopped' ahead of the sidecar", async () => {
    // Rust awaits `deliver_cancel` before returning, deliberately: a fire-and-
    // forget POST let the UI say "stopped" while the graph kept spending the
    // single local-model slot.
    const controller = new AbortController();
    let cancelResolved = false;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = typeof input === "string" ? input : String((input as { url: string }).url);
      if (url.endsWith("/cancel")) {
        await new Promise((r) => setTimeout(r, 60));
        cancelResolved = true;
        return new Response(JSON.stringify({ ok: true, known: true, stopped: [] }), { status: 200 });
      }
      return new Response(
        oneDeltaThenSilence([JSON.stringify({ t: "delta", v: "partial", run_id: "ask-77" })]),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    await streamRun("http://sidecar", req, {
      turn: new TurnId("ask-77", "chat-a"),
      signal: controller.signal,
      onEvent: (event) => {
        if (event === "ask-delta") controller.abort();
      },
    });
    expect(cancelResolved).toBe(true);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// FIXED (2026-08-22): the 300s silent-stream ceiling
// ---------------------------------------------------------------------------
//
// Rust builds its `/run` client with `reqwest::Client::builder().build()` and
// sets NO timeout, so `stream_run` waits indefinitely between NDJSON lines.
// Node's global `fetch` did not: undici applies a default `bodyTimeout` of
// 300_000ms measured as INACTIVITY BETWEEN BODY CHUNKS. A `/run` stream that
// goes 5 minutes without emitting a single line — one long silent tool call
// over the bridge, a sectioned full-pass compose (~30min/book on a local 4B),
// a slow local round — was torn down by the transport. `streamRun` then
// reported `failed` with only the partial, AND did not POST `/cancel` on that
// path (only the cancellation path does), so the Python run kept spending the
// single local-model slot with nothing left listening.
//
// Confirmed empirically before the fix: the read rejected at ~301s with
// `TypeError: terminated` / `cause.code === "UND_ERR_BODY_TIMEOUT"`.
// Fixed with `RUN_STREAM_DISPATCHER = new Agent({ bodyTimeout: 0,
// headersTimeout: 0 })` (the `undici` package, already a dependency of this
// workspace) passed as the `/run` fetch's `dispatcher`, restoring Rust's
// wait-forever semantics.
//
// Opt-in because it costs five real minutes:
//   ARCELLE_TEST_LONG_STREAM_GAP=1 npx vitest run src/main/sidecarRun.test.ts
const LONG_GAP = process.env.ARCELLE_TEST_LONG_STREAM_GAP === "1";

describe.runIf(LONG_GAP)("streamRun: a stream that says nothing for longer than 5 minutes", () => {
  it("keeps waiting like Rust does instead of being torn down by undici's 300s default", async () => {
    const http = await import("node:http");
    const GAP_MS = 305_000;

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ t: "delta", v: "starting the long tool call", run_id: "ask-77" })}\n`);
      // The silence a long bridge tool call actually produces: the graph emits
      // nothing at all until the tool returns.
      setTimeout(() => {
        res.write(`${JSON.stringify({ t: "final", v: "the whole answer", run_id: "ask-77" })}\n`);
        res.end();
      }, GAP_MS);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const outcome = await streamRun(
        `http://127.0.0.1:${port}`,
        {
          model: "qwen3.5:9b",
          question: "read the whole book",
          runId: "ask-77",
          mcp: { url: "http://127.0.0.1:1/mcp", token: "tok" },
        },
        { turn: null, onEvent: () => undefined }
      );
      // What Rust does, and what this SHOULD do: the answer arrives.
      expect(outcome).toEqual({ kind: "done", text: "the whole answer", usage: null, plan: null });
    } finally {
      server.close();
    }
  }, 420_000);
});

describe("streamRun: a multi-byte character split exactly across two stream chunks", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const req: RunViaSidecarRequest = {
    model: "qwen3.5:9b",
    question: "מה כתוב בחוזה",
    runId: "ask-77",
    mcp: { url: "http://127.0.0.1:1/mcp", token: "tok" },
  };

  it.each([
    ["Hebrew (2-byte sequences)", "שלום, מה שלומך?"],
    ["an emoji (a 4-byte sequence + a variation selector)", "done ✅ 🎉"],
  ])("delivers %s intact when the cut lands INSIDE the character, with no replacement char", async (_name, text) => {
    const line = `${JSON.stringify({ t: "delta", v: text, run_id: "ask-77" })}\n`;
    const bytes = new TextEncoder().encode(line);

    // Cut ONE BYTE into the first multi-byte sequence. Asserted, not assumed:
    // if the halves each decoded cleanly the test would be about nothing.
    const firstMultiByte = bytes.findIndex((b) => b >= 0x80);
    expect(firstMultiByte).toBeGreaterThan(0);
    const cut = firstMultiByte + 1;
    expect(Buffer.from(bytes.slice(0, cut)).toString("utf8")).toContain("�");

    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes.slice(0, cut));
              controller.enqueue(bytes.slice(cut));
              controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ t: "final", v: text, run_id: "ask-77" })}\n`));
              controller.close();
            },
          }),
          { status: 200 }
        )
    ) as unknown as typeof fetch;

    const deltas: string[] = [];
    const outcome = await streamRun("http://sidecar", req, {
      turn: new TurnId("ask-77", "chat-a"),
      onEvent: (event, payload) => {
        if (event === "ask-delta") deltas.push((payload as AskEnvelope<string>).v);
      },
    });

    // Exactly one delta, byte-exact -- not two halves, not a dropped line, and
    // not a U+FFFD where the character was cut.
    expect(deltas).toEqual([text]);
    expect(deltas.join("")).not.toContain("�");
    expect(outcome).toEqual({ kind: "done", text, usage: null, plan: null });
  });
});
