/**
 * Tests for `recSessionClient.ts`: byte-exact binary frame encoding against
 * `_AUDIO_HEADER_STRUCT = struct.Struct("<BBHII")`, event parsing for every
 * wire type `session_ws.py` §2's table maps to, the sys-tap-request round trip,
 * and tolerance of a malformed or unexpected server message — all against a
 * fake `WebSocket` and fake taps, no live Electron bootstrap.
 */

import { describe, expect, it, vi } from "vitest";
import {
  AUDIO_HEADER_BYTES,
  KNOWN_WIRE_EVENT_TYPES,
  LANE_MIC,
  LANE_SYS,
  createRecSessionClient,
  encodeAudioFrame,
  encodeSysTapResult,
  parseServerMessage,
  recSessionWsUrl,
  startMicLane,
  wireLoopbackTap,
  type Lane,
  type WebSocketLike,
} from "./recSessionClient.js";

// --------------------------------------------------------------- helpers

function fakeWebSocket(): WebSocketLike & { sent: (string | ArrayBuffer)[]; closeCalls: number } {
  const handle: WebSocketLike & { sent: (string | ArrayBuffer)[]; closeCalls: number } = {
    sent: [],
    closeCalls: 0,
    onOpen: null,
    onMessage: null,
    onClose: null,
    send(data) {
      handle.sent.push(data);
    },
    close() {
      handle.closeCalls++;
      handle.onClose?.();
    },
  };
  return handle;
}

/** Decode a frame independently of `encodeAudioFrame` — a test that decoded
 * with the function it is testing could never catch a shared bug. */
function decodeFrame(buf: ArrayBuffer): {
  lane: number;
  pad: number;
  seq: number;
  rate: number;
  n: number;
  samples: number[];
} {
  const view = new DataView(buf);
  const n = view.getUint32(8, true);
  const samples: number[] = [];
  for (let i = 0; i < n; i++) samples.push(view.getFloat32(12 + i * 4, true));
  return {
    lane: view.getUint8(0),
    pad: view.getUint8(1),
    seq: view.getUint16(2, true),
    rate: view.getUint32(4, true),
    n,
    samples,
  };
}

function textFrames(sent: (string | ArrayBuffer)[]): unknown[] {
  return sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d));
}

function binaryFrames(sent: (string | ArrayBuffer)[]): ArrayBuffer[] {
  return sent.filter((d): d is ArrayBuffer => d instanceof ArrayBuffer);
}

// =============================================================================
// ---- encodeAudioFrame --------------------------------------------------------
// =============================================================================

describe("encodeAudioFrame", () => {
  it("is byte-exact against <BBHII> + n little-endian f32 samples", () => {
    const samples = new Float32Array([1, -1, 0.5, -0.25, 0]);
    const buf = encodeAudioFrame("mic", 7, 48000, samples);
    expect(buf.byteLength).toBe(AUDIO_HEADER_BYTES + 5 * 4);
    expect(decodeFrame(buf)).toEqual({
      lane: LANE_MIC,
      pad: 0,
      seq: 7,
      rate: 48000,
      n: 5,
      samples: [1, -1, 0.5, -0.25, 0],
    });
  });

  it("writes every multi-byte field little-endian, distinguishably from big-endian", () => {
    const buf = encodeAudioFrame("mic", 0x0102, 0x03040506, new Float32Array(0));
    const bytes = new Uint8Array(buf);
    expect(Array.from(bytes)).toEqual([
      LANE_MIC,
      0, // pad
      0x02,
      0x01, // seq, LSB first
      0x06,
      0x05,
      0x04,
      0x03, // rate, LSB first
      0,
      0,
      0,
      0, // n = 0
    ]);
  });

  it("tags the system lane 1 and the mic lane 0, matching rec/lanes.py's Source", () => {
    expect(decodeFrame(encodeAudioFrame("sys", 0, 16000, new Float32Array(0))).lane).toBe(LANE_SYS);
    expect(decodeFrame(encodeAudioFrame("mic", 0, 16000, new Float32Array(0))).lane).toBe(LANE_MIC);
    expect(LANE_MIC).toBe(0);
    expect(LANE_SYS).toBe(1);
  });

  it("an empty sample array is a bare 12-byte header with n = 0", () => {
    const buf = encodeAudioFrame("mic", 0, 16000, new Float32Array(0));
    expect(buf.byteLength).toBe(AUDIO_HEADER_BYTES);
    expect(decodeFrame(buf).n).toBe(0);
  });

  it("the declared n always matches the bytes that follow — what _decode_audio_frame checks", () => {
    for (const n of [0, 1, 3, 400]) {
      const buf = encodeAudioFrame("sys", 0, 16000, new Float32Array(n));
      expect(buf.byteLength).toBe(AUDIO_HEADER_BYTES + decodeFrame(buf).n * 4);
    }
  });

  it("wraps seq into the header's u16 field, including at the boundary", () => {
    expect(decodeFrame(encodeAudioFrame("mic", 65535, 16000, new Float32Array(0))).seq).toBe(65535);
    expect(decodeFrame(encodeAudioFrame("mic", 0x10007, 16000, new Float32Array(0))).seq).toBe(7);
  });

  it("round-trips negative and fractional samples exactly at f32 precision", () => {
    const raw = [0.1, -0.1, 3.14159, -123.456, 1e-5];
    const expected = Array.from(new Float32Array(raw)); // what f32 rounding actually produces
    expect(decodeFrame(encodeAudioFrame("mic", 0, 16000, new Float32Array(raw))).samples).toEqual(expected);
  });

  it("refuses a lane the wire has no byte for, rather than filing it under sys", () => {
    expect(() => encodeAudioFrame("meeting" as Lane, 0, 16000, new Float32Array(0))).toThrow(
      /Unknown recording lane/
    );
  });
});

// =============================================================================
// ---- encodeSysTapResult ------------------------------------------------------
// =============================================================================

describe("encodeSysTapResult", () => {
  it("encodes a success with a null error", () => {
    expect(JSON.parse(encodeSysTapResult(true, null))).toEqual({ type: "sys-tap-result", ok: true, error: null });
  });

  it("nulls the error on success even if one was passed — MsgSysTapResult reads it only on the failure arm", () => {
    expect(JSON.parse(encodeSysTapResult(true, "ignored"))).toEqual({
      type: "sys-tap-result",
      ok: true,
      error: null,
    });
  });

  it("encodes a failure with its message", () => {
    expect(JSON.parse(encodeSysTapResult(false, "permission denied"))).toEqual({
      type: "sys-tap-result",
      ok: false,
      error: "permission denied",
    });
  });
});

// =============================================================================
// ---- parseServerMessage: every wire type in session_ws.py §2's table -------
// =============================================================================

describe("parseServerMessage — every mapped and derived wire type", () => {
  it.each(KNOWN_WIRE_EVENT_TYPES)("parses the %s event, payload verbatim", (type) => {
    const raw = JSON.stringify({ type, fileId: "f1", value: 42, nested: { a: 1 } });
    expect(parseServerMessage(raw)).toEqual({
      kind: "event",
      event: { type, payload: { type, fileId: "f1", value: 42, nested: { a: 1 } } },
    });
  });

  it("covers every value of session_ws.py's _EVENT_MAP plus its two derived events", () => {
    expect([...KNOWN_WIRE_EVENT_TYPES].sort()).toEqual(
      [
        // _EVENT_MAP's nine values
        "level",
        "partial",
        "final",
        "segment-drop",
        "relabel",
        "save-status",
        "source-health",
        "error",
        "live-translation",
        // rec-state splits into two by payload["status"]
        "state",
        "stopped",
        // derived, with no emit() behind it
        "lang-locked",
      ].sort()
    );
  });

  it("an event name this file doesn't know is still forwarded, never dropped by omission", () => {
    const parsed = parseServerMessage(JSON.stringify({ type: "rec-a-future-engine-event", note: "untaught" }));
    expect(parsed).toEqual({
      kind: "event",
      event: { type: "rec-a-future-engine-event", payload: { type: "rec-a-future-engine-event", note: "untaught" } },
    });
  });
});

describe("parseServerMessage — sys-tap-request", () => {
  it.each(["start", "stop"] as const)("parses a well-formed %s request", (action) => {
    expect(parseServerMessage(JSON.stringify({ type: "sys-tap-request", fileId: "f1", action }))).toEqual({
      kind: "sys-tap-request",
      request: { fileId: "f1", action },
    });
  });

  it.each([
    ['{"type":"sys-tap-request","action":"start"}', "missing fileId"],
    ['{"type":"sys-tap-request","fileId":"","action":"start"}', "an empty fileId"],
    ['{"type":"sys-tap-request","fileId":123,"action":"start"}', "a non-string fileId"],
    ['{"type":"sys-tap-request","fileId":"f1"}', "missing action"],
    ['{"type":"sys-tap-request","fileId":"f1","action":"pause"}', "an action nobody defined"],
    ['{"type":"sys-tap-request","fileId":"f1","action":null}', "a null action"],
  ])("drops a malformed request (%s: %s)", (raw) => {
    expect(parseServerMessage(raw)).toBeNull();
  });
});

describe("parseServerMessage — malformed and unexpected frames never throw", () => {
  it.each([
    ["not json at all {{{", "invalid JSON"],
    ["", "an empty frame"],
    ["[1,2,3]", "a JSON array"],
    ["42", "a bare JSON number"],
    ['"level"', "a bare JSON string"],
    ["null", "JSON null"],
    ['{"fileId":"f1"}', "an object with no type field"],
    ['{"type":123}', "a non-string type"],
    ['{"type":null}', "a null type"],
    ['{"type":""}', "an empty-string type"],
  ])("returns null for %s (%s)", (raw) => {
    expect(() => parseServerMessage(raw)).not.toThrow();
    expect(parseServerMessage(raw)).toBeNull();
  });

  it('a JSON body with an own "__proto__" key copies as inert data, leaving the payload\'s own prototype alone', () => {
    const parsed = parseServerMessage('{"type":"level","__proto__":{"polluted":true}}');
    expect(parsed?.kind).toBe("event");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");

    // THE ASSERTIONS THAT ACTUALLY PIN THE SPREAD. The three above hold just as
    // well for `Object.assign({}, obj)`, which is the mistake this guards
    // against — `Object.assign` writes through `[[Set]]`, finds
    // `Object.prototype`'s inherited `__proto__` accessor, and calls its setter,
    // which swaps THIS PAYLOAD's prototype for the attacker's object. The
    // global `Object.prototype` is untouched either way, so a test that only
    // watches the global cannot tell the two apart and silently permits the
    // swap. What breaks then is downstream: `payload.anything` starts reading
    // values off a body the sidecar's peer supplied.
    const payload = parsed && parsed.kind === "event" ? parsed.event.payload : {};
    expect(Object.getPrototypeOf(payload)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(payload, "__proto__")).toBe(true);
    expect("polluted" in payload).toBe(false);
    expect((payload as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('a sys-tap-request carrying "__proto__" is still judged on its own fields alone', () => {
    const parsed = parseServerMessage(
      '{"type":"sys-tap-request","fileId":"f1","action":"start","__proto__":{"action":"stop"}}'
    );
    expect(parsed).toEqual({ kind: "sys-tap-request", request: { fileId: "f1", action: "start" } });
    expect(({} as Record<string, unknown>).action).toBeUndefined();
  });

  it('a payload key named "constructor" or "toString" is copied as inert data', () => {
    const parsed = parseServerMessage('{"type":"final","constructor":"x","toString":"y"}');
    expect(parsed?.kind).toBe("event");
    const payload = parsed && parsed.kind === "event" ? parsed.event.payload : {};
    expect(Object.prototype.hasOwnProperty.call(payload, "constructor")).toBe(true);
    expect(String({})).toBe("[object Object]"); // an untouched Object.prototype.toString
  });
});

// =============================================================================
// ---- createRecSessionClient --------------------------------------------------
// =============================================================================

describe("createRecSessionClient", () => {
  it("fires onOpen/onClose through to the handlers", () => {
    const ws = fakeWebSocket();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    createRecSessionClient("ws://x/rec/session", "f1", { onOpen, onClose }, { connect: () => ws });
    ws.onOpen?.();
    ws.onClose?.();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("sendAudio sends exactly the bytes encodeAudioFrame produces", () => {
    const ws = fakeWebSocket();
    const client = createRecSessionClient("ws://x", "f1", {}, { connect: () => ws });
    const samples = new Float32Array([0.5, -0.5]);
    client.sendAudio("sys", 24000, samples);
    expect(ws.sent[0]).toEqual(encodeAudioFrame("sys", 0, 24000, samples));
  });

  it("keeps an independent seq counter per lane", () => {
    const ws = fakeWebSocket();
    const client = createRecSessionClient("ws://x", "f1", {}, { connect: () => ws });
    client.sendAudio("mic", 16000, new Float32Array([0.1]));
    client.sendAudio("sys", 48000, new Float32Array([0.2]));
    client.sendAudio("mic", 16000, new Float32Array([0.3]));
    client.sendAudio("sys", 48000, new Float32Array([0.4]));

    const frames = binaryFrames(ws.sent).map(decodeFrame);
    expect(frames.map((f) => [f.lane, f.seq])).toEqual([
      [LANE_MIC, 0],
      [LANE_SYS, 0],
      [LANE_MIC, 1],
      [LANE_SYS, 1],
    ]);
  });

  it("does not index its seq bookkeeping by a caller-supplied key", () => {
    const ws = fakeWebSocket();
    const client = createRecSessionClient("ws://x", "f1", {}, { connect: () => ws });
    expect(() => client.sendAudio("__proto__" as Lane, 16000, new Float32Array(1))).toThrow(
      /Unknown recording lane/
    );
    expect(ws.sent).toHaveLength(0);
    expect(({} as Record<string, unknown>)[0]).toBeUndefined();
    // The rejected call must not have consumed a real lane's seq either.
    client.sendAudio("mic", 16000, new Float32Array(1));
    expect(decodeFrame(binaryFrames(ws.sent)[0] as ArrayBuffer).seq).toBe(0);
  });

  it("sendSysTapResult sends the exact wire shape", () => {
    const ws = fakeWebSocket();
    const client = createRecSessionClient("ws://x", "f1", {}, { connect: () => ws });
    client.sendSysTapResult(true, null);
    client.sendSysTapResult(false, "boom");
    expect(textFrames(ws.sent)).toEqual([
      { type: "sys-tap-result", ok: true, error: null },
      { type: "sys-tap-result", ok: false, error: "boom" },
    ]);
  });

  it("close() closes the underlying socket", () => {
    const ws = fakeWebSocket();
    const client = createRecSessionClient("ws://x", "f1", {}, { connect: () => ws });
    client.close();
    expect(ws.closeCalls).toBe(1);
  });

  it("dispatches a parsed event to onEvent", () => {
    const ws = fakeWebSocket();
    const onEvent = vi.fn();
    createRecSessionClient("ws://x", "f1", { onEvent }, { connect: () => ws });
    ws.onMessage?.(JSON.stringify({ type: "partial", fileId: "f1", text: "hello" }));
    expect(onEvent).toHaveBeenCalledWith({
      type: "partial",
      payload: { type: "partial", fileId: "f1", text: "hello" },
    });
  });

  it("dispatches a sys-tap-request whose fileId matches this session", () => {
    const ws = fakeWebSocket();
    const onSysTapRequest = vi.fn();
    createRecSessionClient("ws://x", "f1", { onSysTapRequest }, { connect: () => ws });
    ws.onMessage?.(JSON.stringify({ type: "sys-tap-request", fileId: "f1", action: "start" }));
    expect(onSysTapRequest).toHaveBeenCalledWith({ fileId: "f1", action: "start" });
  });

  it("drops a sys-tap-request for a DIFFERENT fileId — a stale or misdirected message", () => {
    const ws = fakeWebSocket();
    const onSysTapRequest = vi.fn();
    createRecSessionClient("ws://x", "f1", { onSysTapRequest }, { connect: () => ws });
    ws.onMessage?.(JSON.stringify({ type: "sys-tap-request", fileId: "someone-else", action: "start" }));
    expect(onSysTapRequest).not.toHaveBeenCalled();
  });

  it("a malformed message is dropped without crashing the session — later valid ones still work", () => {
    const ws = fakeWebSocket();
    const onEvent = vi.fn();
    const onSysTapRequest = vi.fn();
    createRecSessionClient("ws://x", "f1", { onEvent, onSysTapRequest }, { connect: () => ws });
    for (const bad of ["not json {{{", "[1,2,3]", "null", '{"type":5}', ""]) {
      expect(() => ws.onMessage?.(bad)).not.toThrow();
    }
    expect(onEvent).not.toHaveBeenCalled();
    expect(onSysTapRequest).not.toHaveBeenCalled();
    ws.onMessage?.(JSON.stringify({ type: "level", fileId: "f1", db: -20 }));
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("handlers left unset are simply not called — an event with nothing listening is not an error", () => {
    const ws = fakeWebSocket();
    createRecSessionClient("ws://x", "f1", {}, { connect: () => ws });
    expect(() => ws.onMessage?.(JSON.stringify({ type: "level", db: -3 }))).not.toThrow();
    expect(() => ws.onOpen?.()).not.toThrow();
    expect(() => ws.onClose?.()).not.toThrow();
  });
});

// =============================================================================
// ---- recSessionWsUrl ----------------------------------------------------------
// =============================================================================

describe("recSessionWsUrl", () => {
  it("builds ws://…/rec/session?token=&fileId=, encoding both", () => {
    expect(recSessionWsUrl("http://127.0.0.1:8420", "file/with space", "tok&en")).toBe(
      "ws://127.0.0.1:8420/rec/session?token=tok%26en&fileId=file%2Fwith%20space"
    );
  });

  it("https becomes wss", () => {
    expect(recSessionWsUrl("https://example.test", "f1", "t")).toBe(
      "wss://example.test/rec/session?token=t&fileId=f1"
    );
  });
});

// =============================================================================
// ---- startMicLane ------------------------------------------------------------
// =============================================================================

describe("startMicLane", () => {
  it("acquires the mic and streams its batches as lane 'mic'", async () => {
    const ws = fakeWebSocket();
    const client = createRecSessionClient("ws://x", "f1", {}, { connect: () => ws });
    const mic = { id: "the-mic" };
    let onFrame: ((rate: number, frame: Float32Array) => void) | undefined;
    const tap = {
      acquireMic: vi.fn().mockResolvedValue(mic),
      attach: vi.fn(async (_mic: typeof mic, cb: (rate: number, frame: Float32Array) => void) => {
        onFrame = cb;
      }),
    };

    await startMicLane(client, tap);

    expect(tap.attach).toHaveBeenCalledWith(mic, expect.any(Function));
    const samples = new Float32Array([0.2, -0.2]);
    onFrame?.(16000, samples);
    expect(ws.sent[0]).toEqual(encodeAudioFrame("mic", 0, 16000, samples));
  });

  it("rejects on a mic failure rather than answering it with a sys-tap-result", async () => {
    const ws = fakeWebSocket();
    const client = createRecSessionClient("ws://x", "f1", {}, { connect: () => ws });
    const tap = {
      acquireMic: vi.fn().mockRejectedValue(new Error("Microphone blocked — allow Arcelle…")),
      attach: vi.fn(),
    };

    await expect(startMicLane(client, tap)).rejects.toThrow(/Microphone blocked/);
    expect(tap.attach).not.toHaveBeenCalled();
    // sys-tap-result is the SYSTEM lane's control frame: reporting a mic
    // failure through it would tell the engine a meeting tap it never asked
    // for had died.
    expect(ws.sent).toHaveLength(0);
  });
});

// =============================================================================
// ---- wireLoopbackTap: the sys-tap-request round trip -----------------------
// =============================================================================

describe("wireLoopbackTap", () => {
  function fakeTap(): { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } {
    return { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn() };
  }

  function wired(): {
    ws: ReturnType<typeof fakeWebSocket>;
    tap: ReturnType<typeof fakeTap>;
    handle: (request: { fileId: string; action: "start" | "stop" }) => void;
  } {
    const ws = fakeWebSocket();
    const client = createRecSessionClient("ws://x", "f1", {}, { connect: () => ws });
    const tap = fakeTap();
    return { ws, tap, handle: wireLoopbackTap(client, tap) };
  }

  it("start: brings the tap up, then answers ok:true once it resolves", async () => {
    const { ws, tap, handle } = wired();
    handle({ fileId: "f1", action: "start" });
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));
    expect(tap.start).toHaveBeenCalledTimes(1);
    expect(textFrames(ws.sent)).toEqual([{ type: "sys-tap-result", ok: true, error: null }]);
  });

  it("start failure: answers ok:false with the failure's message", async () => {
    const { ws, tap, handle } = wired();
    tap.start.mockRejectedValue(new Error("no loopback source"));
    handle({ fileId: "f1", action: "start" });
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));
    expect(textFrames(ws.sent)).toEqual([{ type: "sys-tap-result", ok: false, error: "no loopback source" }]);
  });

  it("start failure with a non-Error rejection still reports something readable", async () => {
    const { ws, tap, handle } = wired();
    tap.start.mockRejectedValue("just a string");
    handle({ fileId: "f1", action: "start" });
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));
    expect(textFrames(ws.sent)).toEqual([{ type: "sys-tap-result", ok: false, error: "just a string" }]);
  });

  it("STOP IS NEVER ACKED — a sys-tap-result answers a start request and nothing else", async () => {
    // MsgSysTapResult is "the async RESULT of a request_sys_tap() call", and
    // Engine.handle's arm treats every one that way: an ok:true arriving while
    // the engine is neither paused nor stopping sets sys_tap_up = True and
    // emits source-health "sys on". Acking a STOP therefore tells the engine a
    // tap came up at the moment the renderer tore one down. Pause→resume makes
    // that reachable: the stop-ack lands after MsgResume cleared `paused`, the
    // engine marks the dead tap up and clears sys_tap_starting, and the REAL
    // tap's ok:true then arrives with sys_tap_up already true and is answered
    // with a stop_sys_tap() that kills the capture the user just granted.
    // start_sys_tap is a one-shot, so nothing ever asks again: the meeting
    // records nothing for the rest of the session while the UI shows it live.
    const { ws, tap, handle } = wired();
    handle({ fileId: "f1", action: "stop" });
    expect(tap.stop).toHaveBeenCalledTimes(1);
    expect(ws.sent).toHaveLength(0);
    await vi.waitFor(() => expect(ws.sent).toHaveLength(0));
  });

  it("a tap that ends on its own answers ok:false, via the onEnded callback start() was given", async () => {
    const { ws, tap, handle } = wired();
    let capturedOnEnded: (() => void) | undefined;
    tap.start.mockImplementation((_onFrame, onEnded) => {
      capturedOnEnded = onEnded;
      return new Promise(() => {}); // never resolves on its own — the tap is "up" until it ends
    });
    handle({ fileId: "f1", action: "start" });
    await vi.waitFor(() => expect(capturedOnEnded).toBeDefined());

    capturedOnEnded?.();

    expect(textFrames(ws.sent)).toEqual([
      { type: "sys-tap-result", ok: false, error: "The system-audio tap ended." },
    ]);
  });

  it("audio frames the tap produces are sent on lane 'sys'", async () => {
    const { ws, tap, handle } = wired();
    let capturedOnFrame: ((rate: number, frame: Float32Array) => void) | undefined;
    tap.start.mockImplementation((onFrame) => {
      capturedOnFrame = onFrame;
      return Promise.resolve();
    });
    handle({ fileId: "f1", action: "start" });
    await vi.waitFor(() => expect(capturedOnFrame).toBeDefined());

    const samples = new Float32Array([0.4]);
    capturedOnFrame?.(48000, samples);

    const frames = binaryFrames(ws.sent).map(decodeFrame);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ lane: LANE_SYS, rate: 48000, n: 1 });
  });

  it("end to end: an incoming sys-tap-request text frame drives the tap and answers on the SAME socket", async () => {
    const ws = fakeWebSocket();
    const tap = fakeTap();
    const client = createRecSessionClient(
      "ws://x",
      "f1",
      { onSysTapRequest: (req) => wireLoopbackTap(client, tap)(req) },
      { connect: () => ws }
    );

    ws.onMessage?.(JSON.stringify({ type: "sys-tap-request", fileId: "f1", action: "start" }));
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));

    expect(tap.start).toHaveBeenCalledTimes(1);
    expect(textFrames(ws.sent)).toEqual([{ type: "sys-tap-result", ok: true, error: null }]);
  });

  it("a request re-sent on (re)attach is handled like any other start, answered ok:true again", async () => {
    // session_ws.py §2's ONE buffered message: an outstanding tap request is
    // re-sent the instant a socket attaches. The tap's own start() is a
    // resolving no-op when it is already up, so the engine gets its answer.
    const { ws, tap, handle } = wired();
    handle({ fileId: "f1", action: "start" });
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));
    handle({ fileId: "f1", action: "start" });
    await vi.waitFor(() => expect(ws.sent).toHaveLength(2));
    expect(tap.start).toHaveBeenCalledTimes(2);
    expect(textFrames(ws.sent)).toEqual([
      { type: "sys-tap-result", ok: true, error: null },
      { type: "sys-tap-result", ok: true, error: null },
    ]);
  });
});

// =============================================================================
// ---- the real default connector ---------------------------------------------
// =============================================================================

describe("the default WebSocket connector", () => {
  class FakeRawWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    OPEN = FakeRawWebSocket.OPEN;
    readyState: number = FakeRawWebSocket.CONNECTING;
    listeners: Record<string, ((ev: unknown) => void)[]> = Object.create(null);
    sent: unknown[] = [];
    closeCalls = 0;
    constructor(public url: string) {}
    addEventListener(type: string, listener: (ev: unknown) => void): void {
      (this.listeners[type] ??= []).push(listener);
    }
    send(data: unknown): void {
      this.sent.push(data);
    }
    close(): void {
      this.closeCalls++;
      this.listeners.close?.forEach((fn) => fn({}));
    }
    emitOpen(): void {
      this.readyState = FakeRawWebSocket.OPEN;
      this.listeners.open?.forEach((fn) => fn({}));
    }
    emitMessage(data: unknown): void {
      this.listeners.message?.forEach((fn) => fn({ data }));
    }
  }

  function withStubbedSocket<T>(body: (constructed: () => FakeRawWebSocket) => T): T {
    let made: FakeRawWebSocket | undefined;
    class Tracked extends FakeRawWebSocket {
      constructor(url: string) {
        super(url);
        made = this;
      }
    }
    vi.stubGlobal("WebSocket", Tracked as unknown as typeof WebSocket);
    try {
      return body(() => made as FakeRawWebSocket);
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("connects to the url it was given and forwards message/close into the handlers", () => {
    withStubbedSocket((constructed) => {
      const onEvent = vi.fn();
      const onOpen = vi.fn();
      const onClose = vi.fn();
      createRecSessionClient("ws://x/rec/session?token=t&fileId=f1", "f1", { onEvent, onOpen, onClose });
      expect(constructed().url).toBe("ws://x/rec/session?token=t&fileId=f1");
      constructed().emitOpen();
      expect(onOpen).toHaveBeenCalledTimes(1);
      constructed().emitMessage(JSON.stringify({ type: "level", fileId: "f1", db: -10 }));
      expect(onEvent).toHaveBeenCalledWith({ type: "level", payload: { type: "level", fileId: "f1", db: -10 } });
      constructed().close();
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it("queues sends issued before open and flushes them, in order, once the socket opens", () => {
    withStubbedSocket((constructed) => {
      const client = createRecSessionClient("ws://x", "f1", {});
      client.sendSysTapResult(true, null);
      client.sendAudio("mic", 16000, new Float32Array([0.5]));
      expect(constructed().sent).toHaveLength(0); // nothing sent yet — the socket never opened
      constructed().emitOpen();
      expect(constructed().sent).toEqual([
        JSON.stringify({ type: "sys-tap-result", ok: true, error: null }),
        encodeAudioFrame("mic", 0, 16000, new Float32Array([0.5])),
      ]);
      client.sendSysTapResult(false, "after open");
      expect(constructed().sent).toHaveLength(3); // straight through once open
    });
  });

  it("ignores a binary server message rather than crashing on a wire-format mismatch", () => {
    withStubbedSocket((constructed) => {
      const onEvent = vi.fn();
      createRecSessionClient("ws://x", "f1", { onEvent });
      constructed().emitOpen();
      expect(() => constructed().emitMessage(new ArrayBuffer(8))).not.toThrow();
      expect(onEvent).not.toHaveBeenCalled();
    });
  });

  it("close() reaches the real socket", () => {
    withStubbedSocket((constructed) => {
      createRecSessionClient("ws://x", "f1", {}).close();
      expect(constructed().closeCalls).toBe(1);
    });
  });
});
