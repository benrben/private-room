/**
 * ADD-27 renderer `WS /rec/session` client — the socket `micTap.ts` and
 * `loopbackTap.ts` feed, and the sole place this migration's renderer code
 * speaks the wire protocol `sidecar/arcelle_sidecar/rec/session_ws.py` §2
 * defines (that module's own doc comment is this file's spec, read in full
 * before touching either side of it).
 *
 * ============================================================================
 * THE WIRE, ONE FOR ONE
 * ============================================================================
 * - Connect: `/rec/session?token=…&fileId=…` ({@link recSessionWsUrl}). A query
 *   token rather than a header for the reason `session_ws.py` §6 gives: a
 *   renderer `WebSocket` cannot set `Authorization` on the handshake.
 * - Binary, client→server: a 12-byte header — `u8 lane (0=mic, 1=sys), u8 pad,
 *   u16 seq (LE, informational only — the server never uses it to reject a
 *   gap), u32 rate (LE), u32 n (LE)` — followed by exactly `n` little-endian
 *   f32 samples ({@link encodeAudioFrame}, byte-for-byte
 *   `_AUDIO_HEADER_STRUCT = struct.Struct("<BBHII")`).
 * - Text, client→server: `{"type":"sys-tap-result","ok":bool,"error":str|null}`
 *   ({@link RecSessionClient.sendSysTapResult}).
 * - Text, server→client: JSON events already shaped `{"type": <wire type>,
 *   ...payload}` — the engine→wire NAME mapping (`rec-level`→`level` etc.) is
 *   `session_ws.py`'s own job (`_map_event`), already applied server-side, so
 *   this client does no renaming; it parses and dispatches
 *   ({@link parseServerMessage}). An event name this file doesn't specifically
 *   know is still forwarded under its own `type` string — never silently
 *   dropped, mirroring `_map_event`'s own "forwarded under its own name"
 *   fallback for a future engine event neither side has been taught yet.
 * - `{"type":"sys-tap-request","fileId","action":"start"|"stop"}`,
 *   server→client: {@link wireLoopbackTap} is the production answer.
 *
 * ============================================================================
 * TOLERANCE, BOTH DIRECTIONS
 * ============================================================================
 * `session_ws.py` §2 is explicit that a malformed frame — short, wrong `n`, an
 * unknown lane, bad JSON, an unknown control `type` — is "logged and DROPPED:
 * it never kills the socket or the recording behind it." This client mirrors
 * that discipline on ITS receive side: {@link parseServerMessage} returns
 * `null` for anything that doesn't read as `{type: string, ...}` (or as a
 * well-formed `sys-tap-request`), and the message handler drops a `null` rather
 * than throwing.
 *
 * A `"type"`/`"fileId"`/`"action"` read off server JSON is NEVER used as a
 * dynamic property key into anything (no `obj[key]` on externally-controlled
 * data) — the discriminant is checked with `===`/`typeof`, and the one place a
 * whole parsed object is copied forward uses object SPREAD, never
 * `Object.assign`, so a JSON body carrying an own `"__proto__"` key copies as
 * an inert data property (`CopyDataProperties` defines own properties) rather
 * than being written through `[[Set]]`, which finds `Object.prototype`'s
 * inherited `__proto__` accessor and calls its setter.
 *
 * PRECISELY WHAT THAT SETTER WOULD COST, since the loose phrase "prototype
 * pollution" oversells it and the overselling is what makes the mistake easy to
 * re-introduce: neither form mutates the GLOBAL `Object.prototype` here — the
 * target is a fresh object literal — so a test watching the global cannot tell
 * them apart. `Object.assign` would instead swap THIS PAYLOAD's own prototype
 * for the attacker-supplied object, after which every `payload.someField` a
 * consumer reads can resolve to a value the socket's peer chose. That is the
 * behaviour `parseServerMessage`'s own test pins, and why it asserts on the
 * payload's prototype and not just on `Object.prototype`.
 */

export interface WebSocketLike {
  send(data: string | ArrayBuffer): void;
  close(): void;
  onOpen: (() => void) | null;
  onMessage: ((data: string) => void) | null;
  onClose: (() => void) | null;
}

export type ConnectSessionWs = (url: string) => WebSocketLike;

/** Build the `ws://…/rec/session?token=…&fileId=…` URL from a sidecar HTTP
 * base — the same construction `recBridge.ts`'s `recHostWsUrl` uses for the
 * OTHER `/rec/*` socket, split out the same way so it's testable with no
 * network at all. */
export function recSessionWsUrl(sidecarBaseUrl: string, fileId: string, token: string): string {
  const wsBase = sidecarBaseUrl.replace(/^http/, "ws");
  return `${wsBase}/rec/session?token=${encodeURIComponent(token)}&fileId=${encodeURIComponent(fileId)}`;
}

/** Real production connector. Sends issued before the socket is open are queued
 * rather than dropped — the same convention `recBridge.ts`'s
 * `defaultConnectHostWs` uses for `WS /rec/host`, for the same reason: an audio
 * batch or a `sys-tap-result` lost to an open-vs-send race is gone for good,
 * there being no ack to retry it against. */
function defaultConnectSessionWs(url: string): WebSocketLike {
  const ws = new WebSocket(url);
  const pending: (string | ArrayBuffer)[] = [];
  const handle: WebSocketLike = {
    onOpen: null,
    onMessage: null,
    onClose: null,
    send: (data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      } else {
        pending.push(data);
      }
    },
    close: () => ws.close(),
  };
  ws.addEventListener("open", () => {
    for (const item of pending.splice(0)) {
      ws.send(item);
    }
    handle.onOpen?.();
  });
  ws.addEventListener("message", (ev: MessageEvent) => {
    // The server→client half is text-only (module doc) — a binary message here
    // would be a server bug or a wire-format mismatch, not something to crash
    // over.
    if (typeof ev.data === "string") handle.onMessage?.(ev.data);
  });
  ws.addEventListener("close", () => handle.onClose?.());
  return handle;
}

// =============================================================================
// ---- binary audio frames (session_ws.py §2, `_AUDIO_HEADER_STRUCT`) --------
// =============================================================================

export const AUDIO_HEADER_BYTES = 12;

/** `Source.MIC = 0` / `Source.SYS = 1` in `rec/lanes.py`, and the `lane` byte
 * `_decode_audio_frame` rejects any other value for. */
export const LANE_MIC = 0;
export const LANE_SYS = 1;

/** The lane names `session_ws.py` itself uses on the wire in the other
 * direction (`Source.as_str()`, in `lang-locked` and `source-health`), so one
 * vocabulary covers both. */
export type Lane = "mic" | "sys";

function laneIndex(lane: Lane): 0 | 1 {
  if (lane === "mic") return LANE_MIC;
  if (lane === "sys") return LANE_SYS;
  // A caller reaching this passed something the type system already forbids;
  // silently folding it into the sys lane would file a microphone's audio as
  // the meeting's, which the transcript then attributes to the wrong speaker.
  throw new Error(`Unknown recording lane ${JSON.stringify(lane)} — the wire has only "mic" (0) and "sys" (1).`);
}

/**
 * Encode one `/rec/session` binary audio frame — byte-for-byte
 * `_AUDIO_HEADER_STRUCT`'s `"<BBHII"` (little-endian `u8 lane, u8 pad, u16 seq,
 * u32 rate, u32 n`) followed by `n` little-endian f32 samples.
 *
 * Written with explicit `DataView.set*(…, true)` calls rather than a raw
 * `Float32Array` view over the tail of the buffer, matching `recBridge.ts`'s
 * own `encodeF32Base64`/`decodeF32LE` convention on the other `/rec/*` socket:
 * correctness must not depend on the host's native endianness, even though
 * every real deployment target is little-endian in practice.
 */
export function encodeAudioFrame(lane: Lane, seq: number, rate: number, samples: Float32Array): ArrayBuffer {
  const laneByte = laneIndex(lane);
  const buf = new ArrayBuffer(AUDIO_HEADER_BYTES + samples.length * 4);
  const view = new DataView(buf);
  view.setUint8(0, laneByte);
  view.setUint8(1, 0); // pad
  view.setUint16(2, seq & 0xffff, true);
  view.setUint32(4, rate >>> 0, true);
  view.setUint32(8, samples.length >>> 0, true);
  for (let i = 0; i < samples.length; i++) {
    view.setFloat32(AUDIO_HEADER_BYTES + i * 4, samples[i] as number, true);
  }
  return buf;
}

/** `{"type":"sys-tap-result","ok":bool,"error":str|null}`. A success carries no
 * error text even when a caller had one to hand: `MsgSysTapResult` reads
 * `error` only on the failure arm, so a populated one on an `ok` is a message
 * nobody will ever show. */
export function encodeSysTapResult(ok: boolean, error: string | null): string {
  return JSON.stringify({ type: "sys-tap-result", ok, error: ok ? null : error });
}

// =============================================================================
// ---- server -> client parsing -----------------------------------------------
// =============================================================================

/**
 * Every wire `type` `session_ws.py`'s `_EVENT_MAP` (plus the two events it
 * derives — `state`/`stopped` from `rec-state`'s status, and `lang-locked`,
 * which has no `emit()` behind it at all) can produce. Exported so a test can
 * iterate "one of each" without hand-copying the list, and so a caller has the
 * closed set on hand even though {@link parseServerMessage} deliberately does
 * NOT enforce it — see the module doc on forwarding the unknown.
 */
export const KNOWN_WIRE_EVENT_TYPES = [
  "level",
  "partial",
  "final",
  "segment-drop",
  "relabel",
  "save-status",
  "source-health",
  "error",
  "live-translation",
  "state",
  "stopped",
  "lang-locked",
] as const;
export type KnownWireEventType = (typeof KNOWN_WIRE_EVENT_TYPES)[number];

export interface RecSessionEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export interface SysTapRequest {
  readonly fileId: string;
  readonly action: "start" | "stop";
}

export type ParsedServerMessage =
  | { kind: "event"; event: RecSessionEvent }
  | { kind: "sys-tap-request"; request: SysTapRequest };

/**
 * Parse one server→client text frame. `null` for anything that doesn't read as
 * a JSON object with a non-empty string `"type"` (bad JSON, an array, a bare
 * primitive, a missing/non-string `type`) or as a well-formed
 * `sys-tap-request` — tolerated, never thrown, mirroring `session_ws.py`'s own
 * `_handle_control_text` discipline on the opposite side of this socket.
 *
 * An unrecognized `action` is deliberately folded into that `null` rather than
 * passed through as some third case: there is nothing a caller could safely do
 * with an action that is neither "start" nor "stop", and `_handle_control_text`
 * drops what it does not recognize the same way.
 */
export function parseServerMessage(raw: string): ParsedServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== "string" || type === "") {
    return null;
  }
  if (type === "sys-tap-request") {
    const fileId = obj.fileId;
    const action = obj.action;
    if (typeof fileId !== "string" || fileId === "") return null;
    if (action !== "start" && action !== "stop") return null;
    return { kind: "sys-tap-request", request: { fileId, action } };
  }
  // Spread, not Object.assign — see the module doc's prototype-pollution note.
  return { kind: "event", event: { type, payload: { ...obj } } };
}

// =============================================================================
// ---- the client --------------------------------------------------------------
// =============================================================================

export interface RecSessionClientDeps {
  connect: ConnectSessionWs;
}

export interface RecSessionHandlers {
  onEvent?: (event: RecSessionEvent) => void;
  onSysTapRequest?: (request: SysTapRequest) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

export interface RecSessionClient {
  sendAudio(lane: Lane, rate: number, samples: Float32Array): void;
  sendSysTapResult(ok: boolean, error: string | null): void;
  close(): void;
}

/**
 * Connect to `url` and wire `handlers` up to the parsed wire events.
 *
 * `fileId` scopes `sys-tap-request` handling: a request whose `fileId` doesn't
 * match this client's own session is dropped rather than acted on — defensive
 * against a stale or misdirected message, applying this port's
 * "never act on an externally-controlled value without a guard" standard to a
 * value rather than a key.
 */
export function createRecSessionClient(
  url: string,
  fileId: string,
  handlers: RecSessionHandlers,
  deps: Partial<RecSessionClientDeps> = {}
): RecSessionClient {
  const connect = deps.connect ?? defaultConnectSessionWs;
  // Indexed by `laneIndex`, never by a caller-supplied string: a plain object
  // keyed `obj[lane]` would take `"__proto__"` from a JS caller and write
  // through to the prototype chain.
  const seqs: [number, number] = [0, 0];
  const ws = connect(url);

  ws.onOpen = () => handlers.onOpen?.();
  ws.onClose = () => handlers.onClose?.();
  ws.onMessage = (raw) => {
    const parsed = parseServerMessage(raw);
    if (parsed === null) return;
    if (parsed.kind === "sys-tap-request") {
      if (parsed.request.fileId !== fileId) return;
      handlers.onSysTapRequest?.(parsed.request);
    } else {
      handlers.onEvent?.(parsed.event);
    }
  };

  return {
    sendAudio(lane, rate, samples) {
      const at = laneIndex(lane);
      const seq = seqs[at];
      seqs[at] = (seq + 1) & 0xffff;
      ws.send(encodeAudioFrame(lane, seq, rate, samples));
    },
    sendSysTapResult(ok, error) {
      ws.send(encodeSysTapResult(ok, error));
    },
    close() {
      ws.close();
    },
  };
}

// =============================================================================
// ---- wiring the two capture lanes onto the socket ---------------------------
// =============================================================================

/** The slice of `MicTap` {@link startMicLane} needs — declared locally rather
 * than imported from `micTap.ts` so this file has no compile-time dependency on
 * that module's own dependency stack (a test fakes this shape directly, with no
 * `createMicTap` involved at all). A real `MicTap` satisfies it structurally. */
export interface MicTapLike<TStream = unknown> {
  acquireMic(): Promise<TStream>;
  attach(mic: TStream, onFrame: (rate: number, frame: Float32Array) => void): Promise<void>;
}

/** The same, for `LoopbackTap`. */
export interface LoopbackTapLike {
  start(onFrame: (rate: number, frame: Float32Array) => void, onEnded?: () => void): Promise<void>;
  stop(): void;
}

/**
 * Open the microphone and stream it into the session as lane `"mic"`.
 *
 * The mic lane is never gated behind a server request — only the system lane is
 * (`session_ws.py` §2: "the renderer owns the tap") — so a caller starts this
 * itself, in the click handler that began the recording. REJECTS on failure
 * rather than reporting one over the socket: `sys-tap-result` is the SYSTEM
 * lane's control frame only, and answering a mic failure with it would tell the
 * engine a meeting tap it never asked for had died. A recording with no mic is
 * the caller's to surface in its own UI.
 */
export async function startMicLane<TStream>(
  client: RecSessionClient,
  tap: MicTapLike<TStream>
): Promise<void> {
  const mic = await tap.acquireMic();
  await tap.attach(mic, (rate, frame) => client.sendAudio("mic", rate, frame));
}

/**
 * The renderer's whole job on the receiving end of `sys-tap-request`
 * (`session_ws.py` §2): bring the loopback tap up or down. Returns a handler
 * meant to be passed straight into {@link RecSessionHandlers.onSysTapRequest} —
 * split out (rather than built into {@link createRecSessionClient}) so a caller
 * that wants a different loopback source, or none yet mid-migration, can supply
 * its own handler instead.
 *
 * ONLY A "start" IS ANSWERED. `MsgSysTapResult` is documented as "the async
 * RESULT of a `request_sys_tap()` call" and `Engine.handle`'s arm treats every
 * one that way: an `ok: true` arriving while the engine is neither paused nor
 * stopping sets `sys_tap_up = True` and emits `source-health: sys on`. Acking a
 * STOP with `ok: true` therefore tells the engine a tap came up at the exact
 * moment the renderer tore one down. Pause→resume makes that reachable and
 * unrecoverable: the stop-ack lands after `MsgResume` cleared `paused`, so the
 * engine marks the (dead) tap up and clears `sys_tap_starting`; the real tap's
 * own `ok: true` then arrives with `sys_tap_up` already true and is answered
 * with a `stop_sys_tap()` that kills the capture the user just granted. Nothing
 * asks again — `start_sys_tap` is a one-shot — so the meeting records nothing
 * but the microphone for the rest of the session, silently, while the UI shows
 * the meeting lane as healthy.
 *
 * A tap that ends on ITS own (the user stopped sharing from outside this app)
 * IS reported, as `ok: false`: `sys-tap-result` is the only tap-health signal
 * this wire protocol defines, its failure arm only emits a user-facing
 * `source-health` error, and a pause/resume still recovers the lane afterwards.
 * That is the most honest answer available rather than an unspecified new wire
 * message.
 */
export function wireLoopbackTap(
  client: RecSessionClient,
  tap: LoopbackTapLike
): (request: SysTapRequest) => void {
  return (request) => {
    if (request.action === "stop") {
      tap.stop();
      return;
    }
    void tap
      .start(
        (rate, frame) => client.sendAudio("sys", rate, frame),
        () => client.sendSysTapResult(false, "The system-audio tap ended.")
      )
      .then(() => client.sendSysTapResult(true, null))
      .catch((err: unknown) => {
        client.sendSysTapResult(false, err instanceof Error ? err.message : String(err));
      });
  };
}
