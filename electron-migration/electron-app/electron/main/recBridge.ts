/**
 * ADD-27 recording feature: Electron main's "session broker" — the DB writes
 * plus the WS client for the sidecar's persistence channel
 * (`pm-request/electron-python-migration-plan-2026-08-22.md:343`).
 *
 * The live recording ENGINE (VAD, the decoder thread, ScreenCaptureKit,
 * diarization) already shipped, unchanged, as
 * `sidecar/arcelle_sidecar/rec/session_ws.py` + `rec/engine.py` — nothing here
 * reimplements it. This file ports the business logic ABOVE it:
 * `src-tauri/src/commands/recording_cmds.rs` (its `#[cfg(test)]` tail, lines
 * 1663-2330, is fixtures rather than portable logic and is not ported; several
 * of its cases are reproduced in this module's own test file instead).
 *
 * ============================================================================
 * WHAT ELECTRON MAIN DOES, AND WHAT IT DELIBERATELY DOES NOT
 * ============================================================================
 *
 * 1. CONTROL-POST ISSUER. The 7 routes `session_ws.py::register_rec_routes`
 *    mounts (`/rec/start|pause|resume|set_live_stt|set_live_translate|
 *    edit_meta|stop`), through the single injected {@link RecBridgeDeps.
 *    sidecarPost} seam. A non-2xx becomes a {@link RecControlError} carrying
 *    the sidecar's own `code` (`REC_ALREADY_LIVE`, `REC_SPOOL_EXISTS`,
 *    `REC_NOT_LIVE`, `REC_EDIT_META_TIMEOUT`, `REC_SAVE_FAILED`, …), so a
 *    caller can branch on it without parsing English.
 *
 * 2. WS /rec/host CLIENT. The sidecar pushes `{reqId, kind, fromSample,
 *    toSample, spoolRange, metaJson, text}` down this socket as it flushes;
 *    this module decrypts the referenced spool range, executes the matching DB
 *    write, and acks `{reqId, ok:true}` or `{reqId, ok:false, reason,
 *    message}` — see {@link handlePersistRequest}.
 *
 *    THE DISPATCH TABLE is read off `recording.rs::Engine::flush`'s own
 *    `match save { … }` (lines 2355-2410), NOT reverse-engineered from
 *    `recordings.rs`, which supplies the primitives without saying which fires
 *    for which `Save` kind or in what transactional grouping:
 *      - `full`        -> `finalizeRecAudio` (itself one transaction: write the
 *                         WAV, drop the checkpoints) and THEN `setRecMeta` as a
 *                         SEPARATE statement — matching Rust's
 *                         `finalize_rec_audio(..).and_then(|()| set_rec_meta(..))`
 *                         chain exactly: two commits, so a WAV that lands and a
 *                         meta write that then fails leaves the audio durable.
 *      - `checkpoint`  -> ONE transaction: append the spool-decrypted PCM (only
 *                         when `spoolRange` is present — "a checkpoint with
 *                         nothing new to append"), then ALWAYS
 *                         `setFileExtractedText` + `setRecMeta`.
 *                         `appendRecChunk` is not idempotent, and the retry this
 *                         failure path promises re-appends the whole dirty tail:
 *                         a partial commit means crash recovery concatenates the
 *                         same samples twice.
 *      - `transcript`  -> the same two meta writes, one transaction, no spool
 *                         touch at all: the engine is paused, so the audio is
 *                         already durable and cannot have grown.
 *
 *    THE `"closed"` VS `"failed"` DISTINCTION is load-bearing and not
 *    interchangeable (`session_ws.py` §3: `RoomClosed` makes `Engine.flush` end
 *    the session QUIETLY and abandon the un-flushed tail; `PersistFailed` is
 *    retried). Rust's own answer is the `match guard.as_ref()` around the write:
 *    `Some(room) if room.path == self.cfg.room_path => {write}` / `_ =>
 *    Err(None)`. So `"closed"` is exactly "no room is open, or a DIFFERENT room
 *    is open than the one this session belongs to" — a fact this module reads
 *    FRESH from {@link RecBridgeDeps.currentRoom} before touching the database
 *    at all, exactly like Rust re-reads the room lock on every flush. A thrown
 *    exception from the write itself is ALWAYS `"failed"` and never `"closed"`:
 *    answering a full disk with `"closed"` throws the recording away.
 *
 * 3. LIVE-EDIT ROUTING ({@link routeEdit}). Rust's `edit_rec_meta` branches on
 *    its own in-process `RecState.session` mutex to decide "hand this to the
 *    engine thread, or write the room directly". That mutex has MOVED to the
 *    sidecar's `RecSessionManager`, so this port needs only its own much
 *    smaller fact — "is `fileId` the recording I started and have not stopped"
 *    ({@link RecBridgeState.liveFileId}). When it matches, the edit is POSTed to
 *    `/rec/edit_meta`, whose `_build_apply` is itself a faithful port of the
 *    same Rust ops (same refusal strings, same `at_time` horizon); otherwise it
 *    is applied and written here, exactly like Rust's non-live branch.
 *
 *    Rust's take-exactly-once race between "the engine applies the edit" and
 *    "the 20 s wait gives up on it" (`take_edit_claim`/`REC_EDIT_BUSY`/
 *    `REC_EDIT_LANDED`) has NO analogue here and is not reproduced: both sides
 *    of that race lived in one process, over one `mpsc` reply channel. Here it
 *    is `session_ws.py`'s problem alone (its `EDIT_META_TIMEOUT` plus the
 *    engine's future); Electron sees exactly one HTTP response.
 *
 * 4. SAVED-VOICE LEARNING ({@link learnVoice}). `session_ws.py` says this in as
 *    many words: the enrolment `rec_set_speaker_name` also performs is a real
 *    DB write and therefore Electron's job. Offline that is exact and
 *    race-free. LIVE, the rename POST returns the ALREADY-mutated meta, which
 *    can no longer say what a label used to be called — and there is no "read
 *    the live meta" endpoint — so the last meta this process saw for the
 *    session ({@link RecBridgeState.lastMeta}, refreshed by every routed edit)
 *    is the "before" snapshot. Best-effort, matching `learn_voice`'s own Rust
 *    doc: a stale snapshot costs a missed correction, never a wrong rename.
 *
 * 5. `recPushAudio` IS DEAD CODE HERE, deliberately, not by omission. Its only
 *    caller, `src/workspace/liveRec.ts:255,304`, fed WebView-captured mic PCM
 *    through Tauri IPC into the SAME in-process engine `rec_start` had just
 *    created — precisely the hop the plan (line 349) replaces with a direct
 *    renderer -> `WS /rec/session` connection. Routing audio through an IPC hop
 *    into Electron and back out to the sidecar would be strictly worse than
 *    that socket, not a faithful port of anything. It is kept as an exported,
 *    IPC-wired stub matching `src/api.ts:1264`'s call shape that THROWS with
 *    the explanation, so a stale renderer bundle fails with an instruction
 *    rather than with "no handler registered".
 *
 * 6. NOT PORTED, disclosed rather than guessed at:
 *    - `rec_read_start` (and `rec_stop`'s best-effort kickoff of the same job)
 *      needs the room's background JOB system — a separate, unported subsystem.
 *    - `rec_retranscribe` reruns the whole Whisper+diarization pipeline, and
 *      `session_ws.py` mounts no `/rec/retranscribe` route to ask for it.
 *      Whoever adds it must also restore `RecState.retranscribing`
 *      (`recording_cmds.rs:12-15`): `rec_start`, `rec_delete_range` and
 *      `rec_correct_range` all refuse against that set, and it is omitted here
 *      only because nothing can populate it while the command throws.
 *    - `caffeinate -i` for a live session's lifetime, and the
 *      `rolling_back`/`ROLLBACK_BUSY` room-checkpoint guard: room-lifecycle
 *      concerns with no Electron equivalent yet.
 *    - STT model resolution (`stt_effective_model`) is a Settings/STT concern,
 *      taken as {@link RecBridgeDeps.resolveSttModel} rather than guessed at;
 *      its `null` reproduces Rust's `STT_MODEL_MISSING` refusal honestly.
 */

import { randomUUID, createDecipheriv } from "node:crypto";
import { open as openFile, unlink } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { Readable } from "node:stream";

import { authToken, authedHeaders, busy, ensureUp } from "./sidecar.js";
import {
  deleteFile,
  getFileBytes,
  getFileFull,
  getFileMeta,
  getFileName,
  inTransaction,
  insertFile,
  setDerivedFrom,
  setFileExtractedText,
  updateFileContent,
  type FileMeta,
} from "./db-host/files.js";
import { snapshotFileVersion } from "./db-host/versions.js";
import {
  appendRecChunk,
  finalizeRecAudio,
  finalizeRecAudioHybrid,
  getRecMeta,
  recoverRecChunks,
  recoverRecChunksHybrid,
  setRecMeta,
} from "./db-host/recordings.js";
import {
  enrollVoice,
  forgetVoice,
  identityPrint,
  knownVoices,
  rejectVoice,
  savedVoices,
  type KnownVoice,
  type SavedVoice,
} from "./db-host/voices.js";
import {
  addCut,
  csOfSamples,
  cutShiftBefore,
  decodeWav,
  defaultRecMeta,
  displaySpeaker,
  encodeWav,
  formatStamp,
  insideCut,
  noteKindOf,
  segmentVisibleText,
  spliceOut,
  transcriptText,
  type RecCut,
  type RecMeta,
  type RecSegment,
  type RecWord,
  type VoicePrint,
} from "./recFormat.js";
import { stripThinkSpans } from "./engineRouting.js";
import type { OpenRoom } from "./turnEngine.js";

export type { FileMeta, KnownVoice, SavedVoice };

// =============================================================================
// ---- return shapes (recording_cmds.rs:93-118, all camelCase) ---------------
// =============================================================================

export interface RecStart {
  fileId: string;
  name: string;
  meta: RecMeta;
  sessionUrl: string;
}

export interface RecFile {
  name: string;
  meta: RecMeta;
}

/**
 * What Electron main can honestly answer for `rec_live_status`.
 *
 * Rust's `RecLive` also carries `durationCs` and per-source `mic`/`sys` health,
 * read straight off the in-process engine's `RecShared`. In this architecture
 * those numbers are emitted on `WS /rec/session`, and the RENDERER — not
 * Electron main — is the socket attached to it, so this process cannot see
 * them. Reporting `durationCs: 0` and a fabricated source health would put a
 * live recording's clock at 0:00 on screen, which is worse than not answering:
 * the renderer already has the real numbers on its own socket. So the control
 * plane answers only what the control plane knows.
 */
export interface RecLiveControl {
  fileId: string;
  status: RecLiveStatus;
  /** Fresh renderer-owned socket URL so a reloaded renderer can reattach. */
  sessionUrl: string;
}

export type RecLiveStatus = "recording" | "paused" | "saving";

// =============================================================================
// ---- session state + injected dependencies ---------------------------------
// =============================================================================

/**
 * Electron main's bookkeeping for the (at most one) live recording session —
 * the control-plane mirror of Rust's `Mutex<Option<LiveSession>>`. One instance
 * per app run, threaded through every call rather than held in a module global,
 * matching `quitDoor.ts`/`turnEngine.ts`'s own convention (and keeping the test
 * suite free of cross-test bleed).
 */
export class RecBridgeState {
  liveFileId: string | null = null;
  liveStatus: RecLiveStatus | null = null;
  /** The room path this session belongs to, captured at `/rec/start`. A
   * persist request that arrives while a DIFFERENT room is open is `"closed"`,
   * exactly as `Engine::flush`'s `room.path == self.cfg.room_path` guard
   * decides. */
  sessionRoomPath: string | null = null;
  spoolPath: string | null = null;
  spoolKey: Buffer | null = null;
  hostWs: HostWsLike | null = null;
  /** The most recent meta this process has seen for the live session — the
   * "before" snapshot {@link learnVoice} needs on the live path (see §4). */
  lastMeta: RecMeta | null = null;
}

/** The minimal socket shape {@link attachHostWs} needs. The real Node
 * `WebSocket` is adapted to it by {@link defaultConnectHostWs}; a test passes a
 * plain object. */
export interface HostWsLike {
  send(data: string): void;
  close(): void;
  onMessage: ((data: string) => void) | null;
  onClose: (() => void) | null;
}

export interface RecBridgeDeps {
  /**
   * The room open RIGHT NOW, or `null` between rooms — read FRESH on every
   * persist request, never captured once, because that read IS Rust's
   * `state.room.lock()` inside `Engine::flush` and the whole `"closed"` answer
   * hangs off it. Same `OpenRoom` shape `turnEngine.ts` already defines, so a
   * future host-state batch implements one thing, not two.
   */
  currentRoom: () => OpenRoom | null;
  /** POST `path` (e.g. `"/rec/start"`) with a JSON body to the sidecar's
   * control surface; returns the raw status plus the parsed JSON body so
   * callers can see the sidecar's own error codes. */
  sidecarPost: (path: string, body: unknown) => Promise<{ status: number; json: unknown }>;
  /** Open `WS /rec/host?token=&fileId=` for one live session. */
  connectHostWs: (fileId: string) => HostWsLike;
  /** Provision the authenticated renderer-owned `/rec/session` URL. */
  sessionWsUrl: (fileId: string) => Promise<string>;
  /** Read + decrypt one AES-256-GCM spool frame at `range` (byte offsets into
   * the session's spool file) — see {@link readSpoolFrame}. */
  readSpoolFrame: (spoolPath: string, range: readonly [number, number], key: Buffer) => Promise<Buffer>;
  /** The whisper weights' resolved path — Rust's `stt_effective_model(&app)`.
   * `null` reproduces its `STT_MODEL_MISSING` refusal honestly. */
  resolveSttModel: () => string | null;
  /** Where this session's encrypted spool file should live (`/rec/start`'s own
   * `spoolDir` field). */
  spoolDir: () => string;
  diarizeModelPath?: () => string | null;
  defaultTranslationModel?: () => string | null;
  /** The Ollama endpoint the sidecar should use for live translation. */
  ollamaBaseUrl?: () => string | null;
  /** One non-streamed completion on the room's local model — Rust's
   * `resolve_structured_model` + `ollama::generate`, which are the same
   * engine-routing seam `engineRouting.ts` documents. Absent means
   * {@link recTranslate} refuses rather than fabricating a model. */
  generate?: (prompt: string) => Promise<string>;
  /** `rec-translate-progress` (`{fileId, done, total}` in Rust). */
  onTranslateProgress?: (fileId: string, done: number, total: number) => void;
  /** The Stop flag Rust registers in `AppState::cancels` under the recording's
   * own file id, so `cancel_ask(fileId)` — and closing the room — ends a long
   * translation between batches. */
  isStopped?: (fileId: string) => boolean;
  /** Best-effort `"room-files-changed"` broadcast, at each of the four sites
   * Rust emits it. Failures swallowed, matching Rust's `let _ = app.emit(..)`;
   * same seam name `turnEngine.ts`'s `AskDeps` already uses. */
  notifyFilesChanged?: () => void;
  /** Best-effort `"agent-open-file"` (`{id}`) — Rust's
   * `recording_cmds.rs:1659`, the ONE place in this module that emits it: a
   * translation is a document the user asked for and then has to go find, so
   * `rec_translate` shows it. Same optional-and-swallowed seam
   * `fileTools.ts::execOpenFile` already threads the identical event through. */
  onOpenFile?: (fileId: string) => void;
}

export interface RecBridgeCtx {
  state: RecBridgeState;
  deps: RecBridgeDeps;
}

/** Build a {@link RecBridgeCtx} with real production defaults, overridable
 * field by field — tests pass fakes for the transport seams and use the real
 * DB-backed logic for everything else. */
export function createRecBridgeCtx(
  deps: Partial<RecBridgeDeps> & Pick<RecBridgeDeps, "currentRoom">
): RecBridgeCtx {
  return {
    state: new RecBridgeState(),
    deps: {
      ...deps,
      sidecarPost: deps.sidecarPost ?? defaultSidecarPost,
      connectHostWs: deps.connectHostWs ?? defaultConnectHostWs,
      sessionWsUrl:
        deps.sessionWsUrl ??
        (async (fileId: string) =>
          recHostWsUrl(await ensureUp(), fileId, authToken()).replace("/rec/host?", "/rec/session?")),
      readSpoolFrame: deps.readSpoolFrame ?? readSpoolFrame,
      resolveSttModel: deps.resolveSttModel ?? ((): string | null => null),
      spoolDir: deps.spoolDir ?? ((): string => os.tmpdir()),
    },
  };
}

/** A plain JSON POST to one of `session_ws.py`'s control routes, against an
 * explicit base URL — split out so the wire bodies are testable against a real
 * HTTP server with no sidecar process involved (this repo's `xxxAt(base, …)`
 * convention). Every request and response field is already camelCase on the
 * wire (every `session_ws.py` request model derives from `_CamelModel`), so —
 * unlike `sidecar.ts`'s `/run` body — nothing is translated here. */
export async function sidecarPostAt(
  base: string,
  path: string,
  body: unknown
): Promise<{ status: number; json: unknown }> {
  const resp = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...authedHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await resp.json();
  } catch {
    json = null;
  }
  return { status: resp.status, json };
}

async function defaultSidecarPost(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const guard = busy();
  try {
    return await sidecarPostAt(await ensureUp(), path, body);
  } finally {
    guard.release();
  }
}

/** Build the `ws://…/rec/host?token=…&fileId=…` URL from a sidecar HTTP base —
 * split out so the URL construction is testable with no network at all.
 * `?token=` rather than a header for the reason `session_ws.py` §6 gives: the
 * standard `WebSocket` API cannot set request headers on the handshake. */
export function recHostWsUrl(sidecarBaseUrl: string, fileId: string, token: string): string {
  const wsBase = sidecarBaseUrl.replace(/^http/, "ws");
  return `${wsBase}/rec/host?token=${encodeURIComponent(token)}&fileId=${encodeURIComponent(fileId)}`;
}

/** Production `WS /rec/host` connector. Sends issued before the socket is open
 * are queued rather than dropped — an ack lost to a race would strand the
 * sidecar's `persist()` for its whole 15 s timeout. */
function defaultConnectHostWs(fileId: string): HostWsLike {
  let socket: WebSocket | null = null;
  let closed = false;
  const pending: string[] = [];
  const handle: HostWsLike = {
    onMessage: null,
    onClose: null,
    send: (data: string) => {
      if (socket !== null && socket.readyState === socket.OPEN) {
        socket.send(data);
      } else {
        pending.push(data);
      }
    },
    close: () => {
      closed = true;
      socket?.close();
    },
  };
  void (async () => {
    const url = recHostWsUrl(await ensureUp(), fileId, authToken());
    if (closed) {
      return; // closed before we ever got a socket — do not open one now
    }
    const ws = new WebSocket(url);
    socket = ws;
    ws.addEventListener("open", () => {
      for (const line of pending.splice(0)) {
        ws.send(line);
      }
    });
    ws.addEventListener("message", (ev: MessageEvent) => handle.onMessage?.(String(ev.data)));
    ws.addEventListener("close", () => handle.onClose?.());
  })().catch(() => {
    // The sidecar never came up. Nothing to do here: every persist then fails
    // its ack timeout, which `Engine.flush` retries — the documented behaviour
    // for a host that is not connected (session_ws.py §3).
    handle.onClose?.();
  });
  return handle;
}

// =============================================================================
// ---- the spool file (session_ws.py §5) --------------------------------------
// =============================================================================

const GCM_NONCE_LEN = 12;
const GCM_TAG_LEN = 16;

/**
 * Decrypt one on-disk spool frame — the mirror of `SpoolWriter.append`'s shape:
 *
 *     4 bytes   little-endian uint32: length of everything that follows
 *     12 bytes  this frame's own random nonce
 *     N bytes   AES-256-GCM ciphertext + its 16-byte tag
 *
 * (Python's `AESGCM.encrypt` appends the tag; Node's `crypto` wants it split out
 * via `setAuthTag`, so it is sliced off the end here.)
 *
 * The declared length is cross-checked against what was actually read: a
 * `spoolRange` that is off by even one byte then fails loudly here instead of
 * feeding GCM a shifted window, and a short read (a truncated spool from a
 * hard-killed sidecar) cannot be decrypted as though it were whole.
 */
export function decryptSpoolFrame(frame: Buffer, key: Buffer): Buffer {
  if (frame.length < 4) {
    throw new Error("Spool frame is shorter than its own length prefix.");
  }
  const declared = frame.readUInt32LE(0);
  const rest = frame.subarray(4);
  if (rest.length !== declared) {
    throw new Error(`Spool frame length mismatch: declared ${declared}, read ${rest.length}.`);
  }
  if (rest.length < GCM_NONCE_LEN + GCM_TAG_LEN) {
    throw new Error("Spool frame is too short to contain a nonce and an auth tag.");
  }
  const nonce = rest.subarray(0, GCM_NONCE_LEN);
  const body = rest.subarray(GCM_NONCE_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(body.subarray(body.length - GCM_TAG_LEN));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - GCM_TAG_LEN)), decipher.final()]);
}

/** Read `[start, end)` out of the session's spool file and decrypt it. Opened
 * and closed per call: a persist happens every few seconds at most, so this is
 * nowhere near a hot path, and holding a descriptor over a whole meeting only
 * makes a crash messier. */
export async function readSpoolFrame(
  spoolPath: string,
  range: readonly [number, number],
  key: Buffer
): Promise<Buffer> {
  const [start, end] = range;
  const length = end - start;
  if (length <= 0) {
    throw new Error(`Spool range is empty: [${start}, ${end}).`);
  }
  const fh = await openFile(spoolPath, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    if (bytesRead !== length) {
      throw new Error(`Spool file is short: wanted ${length} bytes at ${start}, got ${bytesRead}.`);
    }
    return decryptSpoolFrame(buf, key);
  } finally {
    await fh.close();
  }
}

function decodeF32LE(buf: Buffer): Float32Array {
  const n = Math.trunc(buf.length / 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = buf.readFloatLE(i * 4);
  }
  return out;
}

function encodeF32Base64(samples: Float32Array): string {
  const buf = Buffer.alloc(samples.length * 4);
  for (let i = 0; i < samples.length; i++) {
    buf.writeFloatLE(samples[i] as number, i * 4);
  }
  return buf.toString("base64");
}

// =============================================================================
// ---- WS /rec/host: the persist request/ack protocol -------------------------
// =============================================================================

export interface PersistRequest {
  reqId: string;
  kind: "checkpoint" | "full" | "transcript";
  fromSample: number | null;
  toSample: number | null;
  spoolRange: [number, number] | null;
  metaJson: string;
  text: string;
}

export type PersistAck =
  | { reqId: string; ok: true }
  | { reqId: string; ok: false; reason: "failed" | "closed"; message: string };

/** Rust's own words on the `Err(None)` arm, so the message the user sees is the
 * one the shipped app shows. */
const ROOM_CLOSED = "The room closed — recording stopped.";

async function applyPersistWrite(
  room: OpenRoom,
  ctx: RecBridgeCtx,
  fileId: string,
  msg: PersistRequest
): Promise<void> {
  const db = room.db;
  const readFrame = async (range: [number, number]): Promise<Buffer> => {
    const { spoolPath, spoolKey } = ctx.state;
    if (spoolPath === null || spoolKey === null) {
      throw new Error("No spool file is open for this recording session.");
    }
    return ctx.deps.readSpoolFrame(spoolPath, range, spoolKey);
  };
  switch (msg.kind) {
    case "full": {
      if (msg.spoolRange === null) {
        // `WsEnginePorts.persist`'s own contract guarantees a spool range for
        // every FULL save. A violated invariant is reported as a save failure,
        // never thrown past this boundary — the sidecar's whole reason for
        // catching its own equivalent is that an escape kills the run loop.
        throw new Error("A full save arrived with no spool range to read the WAV from.");
      }
      const wav = await readFrame(msg.spoolRange);
      // TWO statements, deliberately — `finalize_rec_audio(..).and_then(..)`.
      if (room.workspace === undefined) {
        finalizeRecAudio(db, fileId, wav, msg.text);
      } else {
        await finalizeRecAudioHybrid(db, room.workspace, fileId, wav, msg.text);
      }
      setRecMeta(db, fileId, msg.metaJson);
      return;
    }
    case "checkpoint": {
      const samples = msg.spoolRange === null ? null : decodeF32LE(await readFrame(msg.spoolRange));
      inTransaction(db, () => {
        if (samples !== null) {
          appendRecChunk(db, fileId, samples);
        }
        setFileExtractedText(db, fileId, msg.text);
        setRecMeta(db, fileId, msg.metaJson);
      });
      return;
    }
    case "transcript": {
      inTransaction(db, () => {
        setFileExtractedText(db, fileId, msg.text);
        setRecMeta(db, fileId, msg.metaJson);
      });
      return;
    }
    default: {
      throw new Error(`Unknown persist kind ${JSON.stringify((msg as { kind: unknown }).kind)}.`);
    }
  }
}

/**
 * One incoming `WS /rec/host` persist request -> one ack. Never throws: every
 * failure becomes a `{ok:false}` ack, which is the whole point — the sidecar's
 * `_HostLink.call` awaits exactly this shape back over the socket, and an
 * exception here would leave it waiting out its 15 s timeout instead.
 *
 * The target file id is {@link RecBridgeState.liveFileId} — `WS /rec/host` is
 * already scoped to one session by its `?fileId=` query param, so the message
 * itself carries none.
 */
export async function handlePersistRequest(ctx: RecBridgeCtx, msg: PersistRequest): Promise<PersistAck> {
  const { liveFileId, sessionRoomPath } = ctx.state;
  const room = ctx.deps.currentRoom();
  // THE ONLY SOURCE OF "closed", checked BEFORE any DB write is attempted and
  // never derived from a caught exception — see §2. Rust's `Err(None)` arm is
  // exactly "no room open, or a different room than this session's".
  if (liveFileId === null || sessionRoomPath === null || room === null || room.path !== sessionRoomPath) {
    return { reqId: msg.reqId, ok: false, reason: "closed", message: ROOM_CLOSED };
  }
  try {
    await applyPersistWrite(room, ctx, liveFileId, msg);
    return { reqId: msg.reqId, ok: true };
  } catch (err) {
    // Disk full, a deleted row, a bad decrypt — the audio is NOT durable, and
    // the sidecar's `Engine.flush` retries on this answer. Never "closed" for a
    // write failure: that would end a recording over a transient error.
    return {
      reqId: msg.reqId,
      ok: false,
      reason: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Wire a connected socket up to {@link handlePersistRequest}: parse each
 * incoming text frame, dispatch it, ack on the same socket.
 *
 * A frame that is not JSON, or carries no string `reqId`, is dropped — there is
 * nothing to ack it with, and a bad frame must never kill the socket
 * (`session_ws.py`'s own tolerance, mirrored). A frame that HAS a `reqId` but a
 * kind nobody knows is acked `failed` rather than dropped: the sidecar can
 * retry a failure immediately, whereas silence costs it the full ack timeout.
 *
 * Requests are serialized through one promise chain. `Engine` only ever awaits
 * one `persist()` at a time, so this changes nothing today — but it means two
 * frames arriving back to back can never interleave two DB transactions or ack
 * out of order if that ever stops being true.
 */
export function attachHostWs(ctx: RecBridgeCtx, ws: HostWsLike): void {
  let chain: Promise<void> = Promise.resolve();
  ws.onMessage = (data: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return;
    }
    const msg = parsed as PersistRequest;
    if (typeof msg.reqId !== "string") {
      return;
    }
    chain = chain
      .then(async () => {
        const ack = await handlePersistRequest(ctx, msg);
        ws.send(JSON.stringify(ack));
      })
      // `handlePersistRequest` never throws, but `send` on a socket that died
      // mid-dispatch does — and a rejected link would skip every request queued
      // behind it, silently. The sidecar's own ack timeout covers the frame we
      // could not answer; the next one still gets dispatched.
      .catch(() => undefined);
  };
  ws.onClose = () => {
    // A dropped host socket is NOT a stopped recording — `session_ws.py` §3 is
    // explicit that "Electron reconnecting is not the room closing", and the
    // sidecar keeps the session alive and retries. So the session slot stays;
    // only the dead handle is released, so nothing sends into it. The real
    // "this session is over" signal is the engine's own terminal state, which
    // arrives on `WS /rec/session` (the renderer's socket) — Phase 2 forwards
    // it here via {@link noteLiveSessionEnded}.
    if (ctx.state.hostWs === ws) {
      ctx.state.hostWs = null;
    }
  };
}

function closeLiveSession(ctx: RecBridgeCtx): void {
  ctx.state.hostWs?.close();
  ctx.state.hostWs = null;
  ctx.state.liveFileId = null;
  ctx.state.liveStatus = null;
  ctx.state.sessionRoomPath = null;
  ctx.state.spoolPath = null;
  ctx.state.spoolKey = null;
  ctx.state.lastMeta = null;
}

/**
 * The sidecar ended this session without a `/rec/stop` from us — the 3-hour
 * ceiling, a room that closed under it, an engine error. Idempotent, and a
 * no-op for any file id other than the one currently tracked, so a stale
 * notification racing a newer session can never clear it.
 */
export function noteLiveSessionEnded(ctx: RecBridgeCtx, fileId: string): void {
  if (ctx.state.liveFileId === fileId) {
    closeLiveSession(ctx);
  }
}

// =============================================================================
// ---- control-POST helper ----------------------------------------------------
// =============================================================================

/** A non-2xx control response, carrying the sidecar's own `code` so a caller
 * can branch on it without parsing English. */
export class RecControlError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "RecControlError";
    this.code = code;
  }
}

async function postControl(
  ctx: RecBridgeCtx,
  path: string,
  body: unknown
): Promise<Record<string, unknown>> {
  const { status, json } = await ctx.deps.sidecarPost(path, body);
  const obj = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : null;
  if (status >= 200 && status < 300) {
    return obj ?? {};
  }
  throw new RecControlError(
    obj !== null && typeof obj.error === "string"
      ? obj.error
      : `The room's engine could not complete this request (HTTP ${status}).`,
    obj !== null && typeof obj.code === "string" ? obj.code : "REC_CONTROL_FAILED"
  );
}

function requireLive(ctx: RecBridgeCtx): string {
  if (ctx.state.liveFileId === null) {
    throw new Error("No live recording.");
  }
  return ctx.state.liveFileId;
}

// =============================================================================
// ---- meta parsing (recording_cmds.rs:125-136) -------------------------------
// =============================================================================

function unreadableMeta(detail: string): Error {
  return new Error(
    `This recording's transcript data can't be read (${detail}). ` +
      "Its audio is intact — use History to restore an earlier version, " +
      "or rebuild the transcript from the audio."
  );
}

/**
 * A file's recording metadata. No row at all is a plain audio file (or a
 * brand-new recording) — an empty meta is the honest answer. A row that cannot
 * be READ is something else entirely, and used to look identical: callers saw
 * an empty transcript, and Resume then wrote that emptiness over the stored one
 * with no version snapshot to undo it. So it is an error.
 */
export function parseRecMeta(json: string | null): RecMeta {
  if (json === null) {
    return defaultRecMeta();
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    throw unreadableMeta(err instanceof Error ? err.message : String(err));
  }
  try {
    return coerceRecMeta(value);
  } catch (err) {
    throw unreadableMeta(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Shape-check a parsed JSON value into a `RecMeta`.
 *
 * `durationCs`/`segments`/`cuts` are REQUIRED and type-checked because Rust's
 * struct carries no `#[serde(default)]` on those three — `serde_json::from_str`
 * fails outright without them, which is exactly the failure `parse_meta` exists
 * to surface. Every other field IS `#[serde(default)]` there and is defaulted
 * the same way here. `JSON.parse(…) as RecMeta` would instead accept `123` or
 * `{"foo":1}` and hand back an object whose `.segments` is `undefined`, turning
 * a readable error into a TypeError three call frames later.
 *
 * Also the shape `/rec/edit_meta` and `/rec/stop` return `meta` in (an
 * already-parsed object rather than a JSON string).
 */
export function coerceRecMeta(value: unknown): RecMeta {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  const o = value as Record<string, unknown>;
  if (typeof o.durationCs !== "number") {
    throw new Error('"durationCs" must be a number');
  }
  if (!Array.isArray(o.segments)) {
    throw new Error('"segments" must be an array');
  }
  if (!Array.isArray(o.cuts)) {
    throw new Error('"cuts" must be an array');
  }
  const named = o.speakerNames;
  return {
    durationCs: o.durationCs,
    segments: o.segments as RecSegment[],
    cuts: o.cuts as RecCut[],
    maxSpeakers: typeof o.maxSpeakers === "number" ? o.maxSpeakers : 0,
    speakerNames:
      typeof named === "object" && named !== null && !Array.isArray(named)
        ? (named as Record<string, string>)
        : {},
    recognized: Array.isArray(o.recognized) ? (o.recognized as string[]) : [],
    chapters: Array.isArray(o.chapters) ? (o.chapters as RecMeta["chapters"]) : [],
    highlights: Array.isArray(o.highlights) ? (o.highlights as RecMeta["highlights"]) : [],
    notes: Array.isArray(o.notes) ? (o.notes as RecMeta["notes"]) : [],
    readOf:
      typeof o.readOf === "object" && o.readOf !== null ? (o.readOf as RecMeta["readOf"]) : null,
  };
}

// =============================================================================
// ---- rec_start / pause / resume / stop / live_stt / live_translate ---------
// =============================================================================

/** Rust names a fresh recording from SQLite's own
 * `strftime('%Y-%m-%d %H.%M','now','localtime')`. Same local wall clock, same
 * format, as a pure function — so nothing outside `db-host/` reaches for a raw
 * `db.prepare`, and the name is testable without a room. */
export function recordingStamp(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}.${pad(now.getMinutes())}`
  );
}

/**
 * Start recording — a brand-new recording file, or resuming an existing one
 * (its audio continues seamlessly; wall-clock gaps are not recorded).
 *
 * Nothing about the participants is asked or configured: the meeting's speakers
 * are discovered from their voices as they talk.
 *
 * The "a recording is already running" gate exists on BOTH sides on purpose.
 * The sidecar's `RecSessionManager` is the authority and answers 409
 * `REC_ALREADY_LIVE`; the local check in front of it is what preserves Rust's
 * two distinct sentences — a session that is SAVING cannot be "stopped first",
 * so telling the user to would be an instruction nobody can follow.
 */
export async function recStart(
  db: Database.Database,
  ctx: RecBridgeCtx,
  opts: { fileId?: string | null; systemAudio: boolean; liveTranslate?: string | null }
): Promise<RecStart> {
  const model = ctx.deps.resolveSttModel();
  if (model === null) {
    throw new Error("STT_MODEL_MISSING");
  }
  if (ctx.state.liveFileId !== null) {
    if (ctx.state.liveStatus === "saving") {
      throw new Error(
        `The last recording (file ${ctx.state.liveFileId}) is still being saved. ` +
          "It finishes on its own — start the next one in a moment."
      );
    }
    throw new Error(`A recording is already running (file ${ctx.state.liveFileId}). Stop it first.`);
  }
  const room = ctx.deps.currentRoom();
  if (room === null) {
    throw new Error("No room is open.");
  }
  const liveTranslate =
    opts.liveTranslate != null && opts.liveTranslate.trim() !== "" ? opts.liveTranslate : null;

  let fileId: string;
  let name: string;
  let meta: RecMeta;
  let baseSamples: Float32Array;
  let freshFileId: string | null = null;

  if (opts.fileId != null && opts.fileId !== "") {
    fileId = opts.fileId;
    // A session whose final write failed leaves its audio in `rec_chunks`.
    // Splice those checkpoints in BEFORE reading the stored WAV: this session's
    // first flush calls `finalizeRecAudio`, which drops the chunk rows, so
    // resuming without the rescue records over that stretch of the meeting —
    // and a crash instead would splice the old tail in afterwards, offsetting
    // every timestamp in the new transcript. Refusing is the only safe answer
    // when the rescue itself cannot run.
    try {
      if (room.workspace === undefined) {
        recoverRecChunks(db);
      } else {
        await recoverRecChunksHybrid(db, room.workspace);
      }
    } catch (err) {
      throw new Error(
        `This recording can't be continued yet. ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const [existingName, , storedBytes] = getFileFull(db, fileId);
    name = existingName;
    meta = parseRecMeta(getRecMeta(db, fileId));
    try {
      const bytes = room.workspace === undefined
        ? storedBytes
        : await room.workspace.readBuffer(fileId);
      baseSamples = bytes !== null && bytes.length > 0 ? decodeWav(bytes) : new Float32Array(0);
    } catch (err) {
      throw new Error(
        `This file can't be continued: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    name = `Recording ${recordingStamp()}.wav`;
    meta = defaultRecMeta(); // maxSpeakers = 0 -> discovered
    const emptyWav = encodeWav(new Float32Array(0));
    const file = room.workspace === undefined
      ? insertFile(db, name, "audio/wav", emptyWav, "(live recording)\n", "recording")
      : await room.workspace.createFile(name, Readable.from([emptyWav]), "recording").then((entry) => {
          setFileExtractedText(db, entry.fileId, "(live recording)\n");
          db.prepare("UPDATE files SET mime_type = 'audio/wav' WHERE id = ?").run(entry.fileId);
          return getFileMeta(db, entry.fileId);
        });
    fileId = file.id;
    freshFileId = file.id;
    setRecMeta(db, fileId, JSON.stringify(meta));
    baseSamples = new Float32Array(0);
  }

  // The voices this room already knows, read once — a returning speaker is
  // recognised from the first re-cluster instead of being numbered afresh.
  // Best-effort: a failed read means this recording names nobody automatically,
  // which is exactly how it behaved before there was a table
  // (Rust: `known_voices(..).unwrap_or_default()`).
  let known: KnownVoice[];
  try {
    known = knownVoices(db);
  } catch {
    known = [];
  }

  const ollama = ctx.deps.ollamaBaseUrl?.() ?? null;
  const body: Record<string, unknown> = {
    fileId,
    modelPath: model,
    baseSamples: baseSamples.length > 0 ? encodeF32Base64(baseSamples) : null,
    meta,
    systemAudio: opts.systemAudio,
    liveTranslate,
    knownVoices: known,
    diarizeModelPath: ctx.deps.diarizeModelPath?.() ?? null,
    defaultTranslationModel: ctx.deps.defaultTranslationModel?.() ?? null,
    spoolDir: ctx.deps.spoolDir(),
  };
  if (ollama !== null) {
    body.baseUrl = ollama;
  }

  let resp: Record<string, unknown>;
  try {
    try {
      resp = await postControl(ctx, "/rec/start", body);
    } catch (err) {
      if (!(err instanceof RecControlError) || err.code !== "REC_SPOOL_EXISTS") throw err;

      // A spool is encrypted under a random key that existed only in the
      // terminated app process. After restart it is intentionally
      // undecryptable; the recoverable audio is the acknowledged `rec_chunks`
      // already spliced above. Remove exactly this validated file-id's stale
      // spool and retry once, otherwise one crash blocks Resume forever.
      if (fileId === "." || fileId === ".." || path.basename(fileId) !== fileId) {
        throw new Error("This recording has an invalid file id.");
      }
      const staleSpool = path.join(ctx.deps.spoolDir(), `${fileId}.spool`);
      try {
        await unlink(staleSpool);
      } catch (unlinkError) {
        const code = (unlinkError as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          throw new Error(
            `The previous recording session's temporary spool could not be cleared: ${
              unlinkError instanceof Error ? unlinkError.message : String(unlinkError)
            }`,
          );
        }
      }
      resp = await postControl(ctx, "/rec/start", body);
    }
  } catch (err) {
    // THE FRESH ROW MUST NOT OUTLIVE A START THAT FAILED — the same reasoning
    // `session_ws.py` gives for unlinking its own spool file on every way out
    // that leaves no live session. Rust never had this path (its `start_engine`
    // cannot fail), but here a 409/500 would leave an empty "Recording ….wav"
    // in the room that nothing will ever write to. Resumes are never deleted:
    // that file is the user's recording.
    if (freshFileId !== null) {
      try {
        deleteFile(db, freshFileId);
      } catch {
        // best-effort; an orphan row is better than losing the real error
      }
    }
    throw err;
  }

  ctx.state.liveFileId = fileId;
  ctx.state.liveStatus = "recording";
  ctx.state.sessionRoomPath = room.path;
  ctx.state.spoolPath = typeof resp.spoolPath === "string" ? resp.spoolPath : null;
  ctx.state.spoolKey =
    typeof resp.spoolKey === "string" ? Buffer.from(resp.spoolKey, "base64") : null;
  ctx.state.lastMeta = meta;
  ctx.state.hostWs = ctx.deps.connectHostWs(fileId);
  attachHostWs(ctx, ctx.state.hostWs);

  ctx.deps.notifyFilesChanged?.();
  const sessionUrl = await ctx.deps.sessionWsUrl(fileId);
  return { fileId, name, meta, sessionUrl };
}

/**
 * Retired: mic audio no longer reaches the recording through Electron. Kept
 * exported and IPC-wired, matching `src/api.ts:1264`'s call shape, so a stale
 * caller fails with an instruction rather than with "no handler registered" —
 * see §5.
 */
export async function recPushAudio(_rate: number, _dataB64: string): Promise<never> {
  throw new Error(
    'Mic audio no longer reaches the recording through Electron: the renderer connects directly to "WS /rec/session" ' +
      "(electron-python-migration-plan-2026-08-22.md line 349). This IPC handler is retired and exists only so a " +
      "stale caller fails loudly instead of silently recording nothing."
  );
}

export async function recPause(ctx: RecBridgeCtx): Promise<void> {
  const fileId = requireLive(ctx);
  await postControl(ctx, "/rec/pause", { fileId });
  ctx.state.liveStatus = "paused";
}

export async function recResume(ctx: RecBridgeCtx): Promise<void> {
  const fileId = requireLive(ctx);
  await postControl(ctx, "/rec/resume", { fileId });
  ctx.state.liveStatus = "recording";
}

/** Toggle live translation mid-recording (`null` turns it off). */
export async function recSetLiveTranslate(ctx: RecBridgeCtx, language: string | null): Promise<void> {
  const fileId = requireLive(ctx);
  const lang = language != null && language.trim() !== "" ? language : null;
  await postControl(ctx, "/rec/set_live_translate", { fileId, lang });
}

/** Toggle live transcription mid-recording. Off: the audio keeps recording but
 * no text is decoded. Session-scoped — nothing persists; every start begins ON. */
export async function recSetLiveStt(ctx: RecBridgeCtx, on: boolean): Promise<void> {
  const fileId = requireLive(ctx);
  await postControl(ctx, "/rec/set_live_stt", { fileId, on });
}

/**
 * Stop and save. There is deliberately NO deadline: the work at the end of a
 * stop grows with the recording's length (a long meeting's speaker pass alone
 * runs for minutes), and the sidecar's own `/rec/stop` has none either for the
 * same reason.
 *
 * The session is released whatever the answer — the sidecar finalizes the
 * session before it replies, success or failure (`session_ws.py` §1), so the
 * slot is provably free either way and Electron must not keep believing a
 * recording is live once the sidecar has torn it down.
 */
export async function recStop(ctx: RecBridgeCtx): Promise<RecMeta> {
  const fileId = requireLive(ctx);
  ctx.state.liveStatus = "saving";
  let resp: Record<string, unknown>;
  try {
    resp = await postControl(ctx, "/rec/stop", { fileId });
  } finally {
    closeLiveSession(ctx);
  }
  return coerceRecMeta(resp.meta);
}

/** The live session, if any — lets a reopened view re-attach to a recording
 * that kept running while the user looked at other files. See
 * {@link RecLiveControl} for what this can and cannot honestly report. */
export async function recLiveStatus(ctx: RecBridgeCtx): Promise<RecLiveControl | null> {
  if (ctx.state.liveFileId === null) {
    return null;
  }
  const fileId = ctx.state.liveFileId;
  return {
    fileId,
    status: ctx.state.liveStatus ?? "recording",
    sessionUrl: await ctx.deps.sessionWsUrl(fileId),
  };
}

// =============================================================================
// ---- recGet / voicesList / voiceForget --------------------------------------
// =============================================================================

/** A recording file's editor payload: name + full meta (segments, words,
 * speakers, cuts). */
export function recGet(db: Database.Database, id: string): RecFile {
  return { name: getFileName(db, id), meta: parseRecMeta(getRecMeta(db, id)) };
}

/** The voices this room can recognise, for Settings. */
export function voicesList(db: Database.Database): SavedVoice[] {
  return savedVoices(db);
}

/** Forget a saved voice. Transcripts already written keep the names they show —
 * this is the room forgetting how to recognise someone, not a retraction of
 * what was said. */
export function voiceForget(db: Database.Database, name: string): SavedVoice[] {
  forgetVoice(db, name.trim());
  return savedVoices(db);
}

// =============================================================================
// ---- edit ops: notes / chapters / highlights / item delete / speaker name ---
// =============================================================================

/** Rust's `clean`: trim, then cap the CHARACTERS — a paste accident must not
 * blow out the transcript prefix. Spread-then-slice counts Unicode code points,
 * which is what Rust's `.chars()` counts; `String.slice` would count UTF-16
 * code units and cut an emoji in half at the boundary. */
function clean(text: string, cap: number): string {
  return [...text.trim()].slice(0, cap).join("");
}

/** Rust's `at_time`: where in the recording an item may sit. A time past the
 * end is a bug in the caller, not something to store — an item nobody can ever
 * reach is worse than a refusal.
 *
 * This is the OFFLINE copy. The live path's own `at_time` (`session_ws.py`)
 * additionally measures against the engine's in-memory head, because the meta's
 * `durationCs` is only stamped on a flush and would refuse a mark plainly
 * inside the recording; nothing here is live, so there is no head to consult. */
function atTime(meta: RecMeta, t0: number): number {
  if (t0 < 0 || (meta.durationCs > 0 && t0 > meta.durationCs)) {
    throw new Error("That moment is outside this recording.");
  }
  return t0;
}

/** The explicit op set `session_ws.py::_build_apply` accepts — one per live-safe
 * Rust command. Nothing crosses that boundary as executable code. */
export type RecEditOp =
  | { op: "rename_speaker"; label: string; name: string }
  | { op: "add_note"; t0: number; kind: string; text: string; who: string | null }
  | { op: "set_note"; noteId: string; text: string }
  | { op: "add_chapter"; t0: number; title: string }
  | { op: "set_chapter"; chapterId: string; title: string }
  | { op: "add_highlight"; t0: number; t1: number }
  | { op: "delete_item"; itemKind: "note" | "chapter" | "highlight"; itemId: string };

/**
 * THE one way to change a recording's metadata (`edit_rec_meta`), split for the
 * Electron/sidecar boundary.
 *
 * The bug this exists for: `Engine::flush` writes the engine's OWN copy of the
 * meta over the room's row every few phrases, so a command that wrote to that
 * row while a recording was running was erased seconds later, in silence —
 * which is exactly the moment you know who is talking. So a LIVE recording's
 * meta is edited where the authoritative copy lives; anything else is edited in
 * the room directly. Both paths refresh the searchable transcript, so what
 * search and the AI read can never drift from what the screen shows.
 *
 * Annotating is NOT a new file version (Rust's own comment: "the audio is
 * untouched… versioning every note would bury the real edits"), so this writes
 * `setFileExtractedText` + `setRecMeta` and never snapshots.
 */
async function routeEdit(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  op: RecEditOp,
  applyLocally: (meta: RecMeta) => void
): Promise<RecMeta> {
  if (ctx.state.liveFileId === id) {
    const resp = await postControl(ctx, "/rec/edit_meta", { fileId: id, ...op });
    const meta = coerceRecMeta(resp.meta);
    if (ctx.state.liveFileId === id) {
      ctx.state.lastMeta = meta;
    }
    return meta;
  }
  const meta = parseRecMeta(getRecMeta(db, id));
  applyLocally(meta);
  setFileExtractedText(db, id, transcriptText(meta));
  setRecMeta(db, id, JSON.stringify(meta));
  return meta;
}

/** Write your own note at a moment. `kind` is decision | action | question |
 * point; anything else is a plain point. Works while a recording is running. */
export async function recNoteAdd(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  t0: number,
  kind: string,
  text: string,
  who?: string | null
): Promise<RecMeta> {
  const cleaned = clean(text, 400);
  if (cleaned === "") {
    throw new Error("A note needs some words.");
  }
  const noteKind = noteKindOf(kind);
  const author = who != null && clean(who, 60) !== "" ? clean(who, 60) : null;
  return routeEdit(
    db,
    ctx,
    id,
    { op: "add_note", t0, kind: noteKind, text: cleaned, who: author },
    (meta) => {
      const at = atTime(meta, t0);
      meta.notes.push({ id: randomUUID(), t0: at, kind: noteKind, text: cleaned, who: author, by: "you" });
      meta.notes.sort((a, b) => a.t0 - b.t0);
    }
  );
}

/** Retype a note. Correcting one the ROOM wrote makes it yours, so the next
 * reading leaves it alone — the same rule as confirming a recognised speaker. */
export async function recNoteSet(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  noteId: string,
  text: string
): Promise<RecMeta> {
  const cleaned = clean(text, 400);
  if (cleaned === "") {
    throw new Error("A note needs some words.");
  }
  return routeEdit(db, ctx, id, { op: "set_note", noteId, text: cleaned }, (meta) => {
    const note = meta.notes.find((n) => n.id === noteId);
    if (note === undefined) {
      throw new Error("That note is no longer in this recording.");
    }
    note.text = cleaned;
    note.by = "you";
  });
}

/** Name a section, starting at `t0`. */
export async function recChapterAdd(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  t0: number,
  title: string
): Promise<RecMeta> {
  const cleaned = clean(title, 80);
  if (cleaned === "") {
    throw new Error("A chapter needs a name.");
  }
  return routeEdit(db, ctx, id, { op: "add_chapter", t0, title: cleaned }, (meta) => {
    const at = atTime(meta, t0);
    meta.chapters.push({ id: randomUUID(), t0: at, title: cleaned, by: "you" });
    meta.chapters.sort((a, b) => a.t0 - b.t0);
  });
}

/** Rename a chapter — and make it yours. */
export async function recChapterSet(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  chapterId: string,
  title: string
): Promise<RecMeta> {
  const cleaned = clean(title, 80);
  if (cleaned === "") {
    throw new Error("A chapter needs a name.");
  }
  return routeEdit(db, ctx, id, { op: "set_chapter", chapterId, title: cleaned }, (meta) => {
    const chapter = meta.chapters.find((c) => c.id === chapterId);
    if (chapter === undefined) {
      throw new Error("That chapter is no longer in this recording.");
    }
    chapter.title = cleaned;
    chapter.by = "you";
  });
}

/** Mark a span worth coming back to. `t1` before `t0` marks the instant. */
export async function recHighlightAdd(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  t0: number,
  t1: number
): Promise<RecMeta> {
  return routeEdit(db, ctx, id, { op: "add_highlight", t0, t1 }, (meta) => {
    const at = atTime(meta, t0);
    meta.highlights.push({ id: randomUUID(), t0: at, t1: Math.max(t1, at), by: "you" });
    meta.highlights.sort((a, b) => a.t0 - b.t0);
  });
}

/** Remove one item ("note" | "chapter" | "highlight").
 *
 * Deleting one the ROOM wrote is a real removal, not a correction, so the next
 * reading may find it again — which is right: you removed this reading's claim,
 * not the fact that the words are there. */
export async function recItemDelete(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  kind: "note" | "chapter" | "highlight",
  itemId: string
): Promise<RecMeta> {
  return routeEdit(db, ctx, id, { op: "delete_item", itemKind: kind, itemId }, (meta) => {
    const before = meta.notes.length + meta.chapters.length + meta.highlights.length;
    if (kind === "note") {
      meta.notes = meta.notes.filter((n) => n.id !== itemId);
    } else if (kind === "chapter") {
      meta.chapters = meta.chapters.filter((c) => c.id !== itemId);
    } else if (kind === "highlight") {
      meta.highlights = meta.highlights.filter((h) => h.id !== itemId);
    } else {
      // Unreachable through the typed API, reachable through IPC, where the
      // argument is whatever the renderer sent. Rust names the kind back.
      throw new Error(`Unknown item kind "${String(kind)}".`);
    }
    if (before === meta.notes.length + meta.chapters.length + meta.highlights.length) {
      throw new Error("That item is no longer in this recording.");
    }
  });
}

/**
 * Teach the room this voice, so the NEXT recording knows who it is.
 *
 * `label` is the machine label just named, `name` what the user called them
 * (empty clears the name), and `wrong` the name the app had GUESSED here and
 * has just been corrected on, if any.
 *
 * Best-effort by design: this is an enhancement to a rename, and a rename that
 * refused to save because a voice could not be learned would be strictly worse
 * than one that quietly learns nothing. Nothing is learned when the voice has
 * too little speech behind it, or came from the DSP fallback — see
 * `identityPrint`, which is the one place that rule lives.
 */
function learnVoice(
  db: Database.Database,
  meta: RecMeta,
  label: string,
  name: string,
  wrong: string | null
): void {
  const prints: VoicePrint[] = [];
  for (const seg of meta.segments) {
    if (seg.speaker === label && seg.voice != null) {
      prints.push(seg.voice);
    }
  }
  const print = identityPrint(prints);
  if (print === null) {
    return;
  }
  // The correction first: whatever the user renamed this to, the name they
  // renamed it FROM is now known to be somebody else.
  if (wrong !== null && wrong !== name) {
    rejectVoice(db, wrong, print);
  }
  if (name !== "") {
    enrollVoice(db, name, print);
  }
}

/**
 * GH #5: name a speaker after the fact ("Speaker 2" -> "Dana").
 *
 * Stores an OVERLAY keyed by the machine label rather than rewriting the
 * segments, so re-clustering — which renames labels as a meeting grows — cannot
 * destroy the name, and one write renames every line that speaker said. An
 * empty (or whitespace-only) name clears it back to the machine label.
 *
 * This is also where the room LEARNS a voice. Correcting a name the app guessed
 * teaches both halves of the correction: the right person gains this voice, the
 * wrong one is told it is not theirs. See §4 for where the "what was this label
 * called before" fact comes from on each path.
 */
export async function recSetSpeakerName(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  speaker: string,
  name: string
): Promise<RecMeta> {
  const label = speaker.trim();
  if (label === "") {
    throw new Error("No speaker selected.");
  }
  // A name long enough to blow out the transcript prefix is a paste accident.
  const called = clean(name, 60);

  // What the app had GUESSED here and has just been corrected on. Offline this
  // is read out of the edit itself; live, out of the last meta this process saw
  // (the rename POST answers with the already-mutated one). Live is best-effort
  // by construction — a stale snapshot costs a missed correction, never a wrong
  // rename.
  const priorMeta = ctx.state.liveFileId === id ? ctx.state.lastMeta : null;
  let wrong: string | null = null;
  if (priorMeta !== null) {
    const was = priorMeta.speakerNames[label] ?? null;
    wrong = was !== null && priorMeta.recognized.includes(was) ? was : null;
  }

  const meta = await routeEdit(db, ctx, id, { op: "rename_speaker", label, name: called }, (m) => {
    if (m.segments.length === 0) {
      throw new Error("That recording has no transcript yet.");
    }
    if (!m.segments.some((s) => s.speaker === label)) {
      throw new Error(`Nobody in this recording is labelled "${label}".`);
    }
    // What this voice was called a moment ago, and whether the APP is the one
    // that said so — the difference between "you are correcting my guess" and
    // "you are changing your own mind", which teach the room opposite things.
    const was = m.speakerNames[label] ?? null;
    wrong = was !== null && m.recognized.includes(was) ? was : null;
    // Naming someone back to their machine label is a removal, not an entry
    // that shadows itself.
    if (called === "" || called === label) {
      delete m.speakerNames[label];
    } else {
      m.speakerNames[label] = called;
    }
    // Either way the name on this voice is now the user's own, so it is no
    // longer a guess — and must stop being re-decided by the next pass.
    if (was !== null) {
      m.recognized = m.recognized.filter((n) => n !== was);
    }
    m.recognized = m.recognized.filter((n) => n !== called);
  });

  try {
    learnVoice(db, meta, label, called, wrong);
  } catch {
    // Best-effort by design — see learnVoice's own doc. A malformed voiceprint
    // blob in an old room must not fail the rename it was attached to.
  }
  return meta;
}

// =============================================================================
// ---- post-stop transcript editing (recording_cmds.rs:1218-1449) ------------
// =============================================================================

/** `commands/files.rs::store_file_bytes`: snapshot the file's CURRENT state
 * into History, then overwrite it — one transaction, so a snapshot can never
 * survive a write that did not land (or the other way round). What makes a
 * studio-style transcript edit undoable. */
function storeFileBytes(
  db: Database.Database,
  id: string,
  bytes: Uint8Array,
  text: string,
  cause: string
): void {
  inTransaction(db, () => {
    snapshotFileVersion(db, id, cause);
    updateFileContent(db, id, bytes, text);
  });
}

function storeTranscriptEdit(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  text: string,
  cause: string,
): void {
  const open = ctx.deps.currentRoom();
  if (open?.db === db && open.workspace !== undefined) {
    // snapshotVersion captures the outgoing transcript before its first await.
    // Audio bytes remain in the normal file; a failed history snapshot must
    // never move a copy back into original_bytes.
    void open.workspace.snapshotVersion(id, cause).catch(() => undefined);
    setFileExtractedText(db, id, text);
    return;
  }
  const bytes = getFileBytes(db, id) ?? Buffer.alloc(0);
  storeFileBytes(db, id, bytes, text, cause);
}

/** Rust's `str::trim_end_matches` for one repeated suffix. */
function trimEndMatches(s: string, suffix: string): string {
  let out = s;
  while (out.endsWith(suffix)) {
    out = out.slice(0, out.length - suffix.length);
  }
  return out;
}

/**
 * Studio-style transcript editing: delete a time span. The words inside it
 * disappear from the transcript, playback skips it, and "export edited copy"
 * cuts it from the audio for real. Non-destructive (a cut list + word marks);
 * the file version snapshot makes it undoable.
 *
 * Never routed to the live engine — unlike the annotation commands, this
 * refuses while the file is live, exactly as Rust's own `rec_delete_range` does.
 */
export function recDeleteRange(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  t0: number,
  t1: number
): RecMeta {
  if (t1 <= t0) {
    throw new Error("Nothing selected.");
  }
  if (ctx.state.liveFileId === id) {
    throw new Error("Pause the recording before editing the transcript.");
  }
  const meta = parseRecMeta(getRecMeta(db, id));
  for (const seg of meta.segments) {
    for (const w of seg.words) {
      if (w.t0 < t1 && w.t1 > t0) {
        w.del = true;
      }
    }
    // A segment without word timings (legacy) is dropped wholesale when the cut
    // swallows it.
    if (seg.words.length === 0 && seg.t0 >= t0 && seg.t1 <= t1) {
      seg.text = "";
    }
  }
  meta.cuts = addCut(meta.cuts, { t0, t1 });
  storeTranscriptEdit(db, ctx, id, transcriptText(meta), "Edited transcript");
  setRecMeta(db, id, JSON.stringify(meta));
  return meta;
}

/**
 * Retype the words a selection covers, keeping their place in time.
 *
 * The transcript could be EDITED only by deleting — so a misheard name was a
 * choice between leaving it wrong and losing the sentence, and the recording's
 * text is what search, the AI and every export read. Correcting is not
 * deleting: the audio is untouched, no cut is added, and `del` is never set.
 *
 * Timings are spread evenly across the span the old words occupied. It is an
 * approximation and it is stated as one; what it must NOT do is invent a time
 * outside the words that were really said, because playback, the subtitle
 * export and the audio cut all read these numbers.
 */
export function correctWords(seg: RecSegment, t0: number, t1: number, text: string): number {
  const hit: number[] = [];
  seg.words.forEach((w, i) => {
    if (w.del !== true && w.t0 < t1 && w.t1 > t0) {
      hit.push(i);
    }
  });
  if (hit.length === 0) {
    return 0;
  }
  const first = hit[0] as number;
  const last = hit[hit.length - 1] as number;
  const spanT0 = (seg.words[first] as RecWord).t0;
  const spanT1 = (seg.words[last] as RecWord).t1;
  const tokens = text.split(/\s+/).filter((t) => t !== "");
  const span = Math.max(spanT1 - spanT0, 1);
  const n = Math.max(tokens.length, 1);
  const replacement: RecWord[] = tokens.map((w, i) => ({
    w,
    t0: spanT0 + Math.trunc((span * i) / n),
    t1: spanT0 + Math.trunc((span * (i + 1)) / n),
    del: false,
  }));
  // Splice in place: the words BEFORE and AFTER the selection keep their own
  // timings, including any already marked deleted inside the range's gaps.
  const tail = seg.words.slice(last + 1);
  seg.words.length = first;
  seg.words.push(...replacement, ...tail);
  return hit.length;
}

/**
 * Studio-style transcript editing: retype what a selection says.
 *
 * Deliberately confined to ONE phrase. A correction spread across a speaker
 * change has no honest place to put the new words — whose line are they? — and
 * guessing there would put words in somebody's mouth.
 */
export function recCorrectRange(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  t0: number,
  t1: number,
  rawText: string
): RecMeta {
  if (t1 <= t0) {
    throw new Error("Nothing selected.");
  }
  // An empty correction is a DELETE, and delete is a different button with a
  // different consequence (it cuts the audio). Never guess which was meant.
  const text = rawText.trim();
  if (text === "") {
    throw new Error('Type the corrected words, or use "Delete from recording" to remove them.');
  }
  if (ctx.state.liveFileId === id) {
    throw new Error("Pause the recording before editing the transcript.");
  }
  const meta = parseRecMeta(getRecMeta(db, id));
  const touched: number[] = [];
  meta.segments.forEach((s, i) => {
    if (s.words.some((w) => w.del !== true && w.t0 < t1 && w.t1 > t0)) {
      touched.push(i);
    }
  });
  if (touched.length === 0) {
    throw new Error(
      "Nothing to correct there — that selection has no word timings. Re-transcribe the recording to get them."
    );
  }
  if (touched.length > 1) {
    throw new Error(
      "That selection crosses more than one phrase. Correct one phrase at a time — otherwise there is no honest way to say who said the new words."
    );
  }
  const n = correctWords(meta.segments[touched[0] as number] as RecSegment, t0, t1, text);
  if (n === 0) {
    throw new Error("Nothing to correct there.");
  }
  storeTranscriptEdit(db, ctx, id, transcriptText(meta), "Corrected transcript");
  setRecMeta(db, id, JSON.stringify(meta));
  return meta;
}

/**
 * The surviving transcript, re-flowed onto the timeline the cuts leave behind:
 * deleted words gone, every remaining timestamp pulled back by the length of
 * the cuts before it, empty segments dropped.
 *
 * Annotations move onto the shortened timeline with the words they point at,
 * and anything that pointed INTO a cut is dropped — the copy no longer contains
 * what it was about. The original keeps everything: cuts are undoable, so
 * un-deleting a span has to bring its notes back with it.
 */
export function reflowAfterCuts(meta: RecMeta, splicedLen: number): RecMeta {
  const shift = (t: number): number => t - cutShiftBefore(meta.cuts, t);
  const kept = (t: number): boolean => !insideCut(meta.cuts, t);
  const newMeta: RecMeta = {
    ...defaultRecMeta(),
    maxSpeakers: meta.maxSpeakers,
    durationCs: csOfSamples(splicedLen),
    // The edited copy keeps the same speaker labels, so it keeps their names
    // too (GH #5) — otherwise "Dana" silently reverts to "Speaker 2".
    speakerNames: { ...meta.speakerNames },
    recognized: [...meta.recognized],
    readOf: meta.readOf ?? null,
    chapters: meta.chapters.filter((c) => kept(c.t0)).map((c) => ({ ...c, t0: shift(c.t0) })),
    highlights: meta.highlights
      .filter((h) => kept(h.t0))
      .map((h) => ({ ...h, t0: shift(h.t0), t1: shift(h.t1) })),
    notes: meta.notes.filter((n) => kept(n.t0)).map((n) => ({ ...n, t0: shift(n.t0) })),
  };
  for (const seg of meta.segments) {
    const words: RecWord[] = seg.words
      .filter((w) => w.del !== true)
      .map((w) => ({
        w: w.w,
        t0: w.t0 - cutShiftBefore(meta.cuts, w.t0),
        t1: w.t1 - cutShiftBefore(meta.cuts, w.t1),
        del: false,
      }));
    const text = segmentVisibleText(seg);
    if (text === "") {
      continue;
    }
    const firstWord = words[0];
    const lastWord = words[words.length - 1];
    newMeta.segments.push({
      id: randomUUID(),
      source: seg.source,
      speaker: seg.speaker,
      t0: firstWord !== undefined ? firstWord.t0 : seg.t0 - cutShiftBefore(meta.cuts, seg.t0),
      t1: lastWord !== undefined ? lastWord.t1 : seg.t1 - cutShiftBefore(meta.cuts, seg.t1),
      text,
      words,
      lang: seg.lang ?? null,
      // Carry the voiceprint over so the exported copy keeps its speakers (and
      // can still be re-clustered if it is resumed).
      voice: seg.voice ?? null,
    });
  }
  return newMeta;
}

/**
 * Render the edits into a new file: cut spans removed from the audio,
 * timestamps re-flowed, deleted words gone. The original stays untouched.
 *
 * Rust holds the room lock only to READ and again to WRITE, doing the
 * decode/splice/re-encode off the thread that paints the window. Node's main
 * thread has no window to paint and better-sqlite3 is synchronous either way,
 * so there is no equivalent split to make — the work is the same work.
 */
export function recExportClean(db: Database.Database, ctx: RecBridgeCtx, id: string): FileMeta {
  const [name, , bytes] = getFileFull(db, id);
  const meta = parseRecMeta(getRecMeta(db, id));
  if (meta.cuts.length === 0 && meta.segments.every((s) => s.words.every((w) => w.del !== true))) {
    throw new Error("No edits to apply — delete something from the transcript first.");
  }
  const spliced = spliceOut(decodeWav(bytes ?? Buffer.alloc(0)), meta.cuts);
  const newMeta = reflowAfterCuts(meta, spliced.length);
  const stem = trimEndMatches(name, ".wav");
  const file = insertFile(
    db,
    `${stem} (edited).wav`,
    "audio/wav",
    encodeWav(spliced),
    transcriptText(newMeta),
    "recording"
  );
  setRecMeta(db, file.id, JSON.stringify(newMeta));
  ctx.deps.notifyFilesChanged?.();
  return file;
}

/** Workspace-aware edited-copy export used by the live IPC surface. */
export async function recExportCleanHybrid(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
): Promise<FileMeta> {
  const open = ctx.deps.currentRoom();
  if (open?.db !== db || open.workspace === undefined) return recExportClean(db, ctx, id);
  const [name] = getFileFull(db, id);
  const bytes = await open.workspace.readBuffer(id);
  const meta = parseRecMeta(getRecMeta(db, id));
  if (meta.cuts.length === 0 && meta.segments.every((s) => s.words.every((w) => w.del !== true))) {
    throw new Error("No edits to apply — delete something from the transcript first.");
  }
  const spliced = spliceOut(decodeWav(bytes), meta.cuts);
  const newMeta = reflowAfterCuts(meta, spliced.length);
  const stem = trimEndMatches(name, ".wav");
  const source = db.prepare("SELECT relative_path FROM files WHERE id = ?")
    .get(id) as { relative_path: string | null };
  const parent = source.relative_path === null ? "." : path.posix.dirname(source.relative_path);
  const destination = parent === "."
    ? `${stem} (edited).wav`
    : path.posix.join(parent, `${stem} (edited).wav`);
  const entry = await open.workspace.createFile(
    destination,
    Readable.from([encodeWav(spliced)]),
    "recording",
  );
  const text = transcriptText(newMeta);
  setFileExtractedText(db, entry.fileId, text);
  db.prepare("UPDATE files SET mime_type = 'audio/wav' WHERE id = ?").run(entry.fileId);
  setRecMeta(db, entry.fileId, JSON.stringify(newMeta));
  ctx.deps.notifyFilesChanged?.();
  return getFileMeta(db, entry.fileId);
}

// =============================================================================
// ---- translate (recording_cmds.rs:1541-1661) --------------------------------
// =============================================================================

/** Rust's own `const BATCH: usize = 12`. */
export const TRANSLATE_BATCH_SIZE = 12;

/** One line per spoken (non-empty) segment, in the shape the translation prompt
 * and the exported document both use — the user's own name for a speaker when
 * they set one (GH #5). */
export function translatableLines(meta: RecMeta): string[] {
  const lines: string[] = [];
  for (const seg of meta.segments) {
    const text = segmentVisibleText(seg);
    if (text === "") {
      continue;
    }
    lines.push(`${formatStamp(seg.t0)} ${displaySpeaker(meta, seg.speaker)}: ${text}`);
  }
  return lines;
}

export function buildTranslatePrompt(language: string, batch: readonly string[]): string {
  return (
    `Translate the following transcript lines into ${language}. Each line starts with a ` +
    `[m:ss] timestamp and a speaker name — copy that prefix EXACTLY as it is, and ` +
    `translate only the words after the colon. Output exactly ${batch.length} lines, one per input ` +
    `line, with no numbering, preamble, or explanations.\n\n${batch.join("\n")}`
  );
}

export interface ReconciledBatch {
  translated: string[];
  untranslated: number;
}

/** Reconcile a batch's raw model output against what was asked for. The model
 * broke the one-line-per-line contract by coming up short: whatever it did not
 * translate keeps its ORIGINAL line, because a turn that silently disappears
 * from the translated document is worse than one that appears untranslated —
 * and nothing warned about it before. */
export function reconcileTranslatedBatch(batch: readonly string[], rawOutput: string): ReconciledBatch {
  const got = rawOutput
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const translated = [...got];
  let untranslated = 0;
  if (got.length < batch.length) {
    untranslated = batch.length - got.length;
    translated.push(...batch.slice(got.length));
  }
  return { translated, untranslated };
}

export function buildTranslatedDocument(
  stem: string,
  language: string,
  translated: readonly string[],
  untranslated: number
): string {
  const note =
    untranslated > 0
      ? ` ${untranslated} line(s) came back untranslated and are kept in the original ` +
        `language — translate the file again to retry them._`
      : "_";
  return (
    `# ${stem} — ${language}\n\n_Translated on this Mac from the recording's transcript.${note}\n\n` +
    `${translated.join("\n\n")}\n`
  );
}

/**
 * Translate the whole transcript into any language on the LOCAL model, saved as
 * a sibling Markdown file with the timestamps and speakers kept (Whisper
 * *-turbo cannot translate, so the LLM does, batch by batch).
 *
 * Stoppable between batches, like Rust's: the Stop flag is keyed by the
 * recording's own file id, so `cancel_ask(fileId)` — and closing the room —
 * ends a translation that would otherwise hold the local model for many
 * minutes. The document is written only at the end, so stopping leaves no half
 * file behind.
 */
export async function recTranslate(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  language: string
): Promise<FileMeta> {
  const lang = language.trim();
  if (lang === "") {
    throw new Error("Pick a language first.");
  }
  const generate = ctx.deps.generate;
  if (generate === undefined) {
    throw new Error("The local AI (Ollama) isn't running — start it and try again.");
  }
  const name = getFileName(db, id);
  const lines = translatableLines(parseRecMeta(getRecMeta(db, id)));
  if (lines.length === 0) {
    throw new Error("No transcript to translate yet — record something first.");
  }
  const total = Math.ceil(lines.length / TRANSLATE_BATCH_SIZE);
  const translated: string[] = [];
  // Lines the model failed to return a translation for — kept in the original
  // language rather than dropped, and counted so the document can say so
  // instead of quietly being short.
  let untranslated = 0;
  for (let i = 0; i < total; i++) {
    if (ctx.deps.isStopped?.(id) === true) {
      throw new Error("Stopped — no translated file was saved.");
    }
    ctx.deps.onTranslateProgress?.(id, i, total);
    const batch = lines.slice(i * TRANSLATE_BATCH_SIZE, (i + 1) * TRANSLATE_BATCH_SIZE);
    const raw = stripThinkSpans(await generate(buildTranslatePrompt(lang, batch)));
    const reconciled = reconcileTranslatedBatch(batch, raw);
    translated.push(...reconciled.translated);
    untranslated += reconciled.untranslated;
  }
  ctx.deps.onTranslateProgress?.(id, total, total);

  const stem = trimEndMatches(name, ".wav");
  const content = buildTranslatedDocument(stem, lang, translated, untranslated);
  const open = ctx.deps.currentRoom();
  const file = open?.db === db && open.workspace !== undefined
    ? await open.workspace.createFile(
        `${stem} — ${lang}.md`,
        Readable.from([Buffer.from(content, "utf8")]),
        "generated",
      ).then((entry) => {
        setFileExtractedText(db, entry.fileId, content);
        db.prepare("UPDATE files SET mime_type = 'text/markdown' WHERE id = ?").run(entry.fileId);
        return getFileMeta(db, entry.fileId);
      })
    : insertFile(
        db,
        `${stem} — ${lang}.md`,
        "text/markdown",
        Buffer.from(content, "utf8"),
        content,
        "generated",
      );
  // Room map: this translation was made from THIS recording. The name says so
  // too, but a name is not evidence — renaming either file would leave the map
  // asserting a link it can no longer check.
  setDerivedFrom(db, file.id, id);
  ctx.deps.notifyFilesChanged?.();
  // …and OPEN it. A translation runs for minutes on the local model, so by the
  // time it lands the user is looking at something else; Rust ends this command
  // with `agent-open-file` for exactly that reason, and dropping it would turn
  // a finished job into a file nobody is told about.
  try {
    ctx.deps.onOpenFile?.(file.id);
  } catch {
    // Swallowed, matching Rust's `let _ = window.emit(..)` — a viewer that
    // could not be told must not fail the translation it was told about.
  }
  return file;
}

// =============================================================================
// ---- out of scope for this batch — see §6 ----------------------------------
// =============================================================================

/** `rec_retranscribe` (recording_cmds.rs:383-517). */
export async function recRetranscribe(
  _db: Database.Database,
  _ctx: RecBridgeCtx,
  _id: string
): Promise<RecMeta> {
  throw new Error(
    "Re-transcribing is not available yet in this migration: it reruns the whisper/diarization pipeline, " +
      "which lives entirely in the sidecar's Engine and has no HTTP route mounted in session_ws.py yet " +
      "(only start/pause/resume/set_live_stt/set_live_translate/edit_meta/stop are). Whoever adds that " +
      "route must also restore recording_cmds.rs's `retranscribing` guard set — rec_start, rec_delete_range " +
      "and rec_correct_range all refuse against it."
  );
}

/** `rec_read_start` (recording_cmds.rs:908-916), and the same job `rec_stop`
 * kicks off best-effort once a recording is durable. */
export async function recReadStart(
  _db: Database.Database,
  _ctx: RecBridgeCtx,
  _id: string
): Promise<string> {
  throw new Error(
    '"Read this recording" is not available yet in this migration: it queues a background AI job ' +
      "(chapters/highlights/notes), and the `jobs` table's runner is a separate, unported subsystem."
  );
}
