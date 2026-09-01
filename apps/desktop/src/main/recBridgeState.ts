/** Cohesive extraction from recBridge.ts; its public API remains on that module. */
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
import * as obs from "./obs.js";
import type { OpenRoom } from "./turnEngine.js";

export type { FileMeta, KnownVoice, SavedVoice };
import { attachHostWs, readSpoolFrame } from "./recBridgeMeta.js";
import { recTranslate } from "./recBridgeSavedVoice.js";
import { learnVoice } from "./recBridgeSession.js";
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

// -----------------------------------------------------------------------------
// ---- the `retranscribing` guard set (recording_cmds.rs:12-15) ---------------
// -----------------------------------------------------------------------------

/**
 * File ids whose transcript is being REBUILT from the audio right now — the
 * port of `RecState.retranscribing`. See this module's §6 for why it is module
 * state rather than a {@link RecBridgeState} field.
 *
 * A rebuild reads the whole file's audio, re-runs the pipeline for minutes and
 * then overwrites both `recordings.meta` and `files.extracted_text` with what
 * it computed. Anything that edits either one MEANWHILE is silently thrown
 * away when the rebuild lands: a studio cut, a retyped phrase, or (worst) a
 * Resume that appends new audio to a file whose transcript is about to be
 * replaced by one written from the OLD audio, putting every timestamp after
 * the join out by the length of the addition. So the three commands Rust gates
 * refuse here too, with Rust's own sentence.
 */
export const retranscribing = new Set<string>();

/**
 * Claim `fileId` for a rebuild. `false` means one is already running for it —
 * `Rust: !rec.retranscribing.lock().unwrap().insert(id)`.
 *
 * The caller MUST pair every `true` with {@link endRetranscribe} in a
 * `finally`: a claim that outlives its job locks the file's transcript editing
 * for the rest of the app run.
 */
export function beginRetranscribe(fileId: string): boolean {
  if (retranscribing.has(fileId)) {
    return false;
  }
  retranscribing.add(fileId);
  return true;
}

/** Release a claim taken by {@link beginRetranscribe}. Idempotent. */
export function endRetranscribe(fileId: string): void {
  retranscribing.delete(fileId);
}

/** Is this file's transcript being rebuilt right now? */
export function isRetranscribing(fileId: string): boolean {
  return retranscribing.has(fileId);
}

/** Rust's refusal sentence, spelled once so the three gated commands cannot
 * drift apart. */
export const RETRANSCRIBING_REFUSAL =
  "This recording is being re-transcribed — wait for it to finish.";

/** The three gated commands' shared guard. */
export function refuseWhileRetranscribing(fileId: string): void {
  if (retranscribing.has(fileId)) {
    throw new Error(RETRANSCRIBING_REFUSAL);
  }
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
  sidecarPost: (
    path: string,
    body: unknown,
  ) => Promise<{ status: number; json: unknown }>;
  /** Open `WS /rec/host?token=&fileId=` for one live session. */
  connectHostWs: (fileId: string) => HostWsLike;
  /** Provision the authenticated renderer-owned `/rec/session` URL. */
  sessionWsUrl: (fileId: string) => Promise<string>;
  /** Read + decrypt one AES-256-GCM spool frame at `range` (byte offsets into
   * the session's spool file) — see {@link readSpoolFrame}. */
  readSpoolFrame: (
    spoolPath: string,
    range: readonly [number, number],
    key: Buffer,
  ) => Promise<Buffer>;
  /** The whisper weights' resolved path — Rust's `stt_effective_model(&app)`.
   * `null` reproduces its `STT_MODEL_MISSING` refusal honestly. */
  resolveSttModel: () => string | null;
  /** Where this session's encrypted spool file should live (`/rec/start`'s own
   * `spoolDir` field). */
  spoolDir: () => string;
  /**
   * The TitaNet speaker-embedding weights' resolved path — the diarize half of
   * what Rust's `install_diarize_model(app)` did before every session.
   *
   * OPTIONAL, WITH A LOUD DEFAULT, because `null` is NOT a neutral answer:
   * `/rec/start` hands it straight to the sidecar, which falls back to a
   * 21-dimension DSP embedding when it is absent. `identityPrint`
   * (`db-host/voices.ts`) requires the 192-dimension neural print, so it
   * returns `null` for every DSP voiceprint, `learnVoice` early-returns on
   * that `null`, and NOTHING is ever enrolled — Settings → Saved voices stays
   * empty and cross-recording recognition never fires. All of that is silent.
   *
   * So the default here is `() => null` written out in {@link createRecBridgeCtx}
   * rather than left implicit: a context that has not been given this is
   * making a real choice (recordings that can never teach the room a voice),
   * and the production wiring must pass
   * `mediaTranscribeJob.ts::diarizeEffectiveModel(userDataDir, resourcesPath)`
   * — which also resolves in a dev tree, where `resourcesPath` is always
   * `null`.
   */
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

export function defaultValue<T>(value: T | undefined, fallback: T): T {
  return value ?? fallback;
}

export async function defaultSessionWsUrl(fileId: string): Promise<string> {
  return recHostWsUrl(await ensureUp(), fileId, authToken()).replace(
    "/rec/host?",
    "/rec/session?",
  );
}

export function missingSttModel(): string | null {
  return null;
}

export function missingDiarizeModel(): string | null {
  return null;
}

export function defaultSpoolDir(): string {
  return os.tmpdir();
}

export function resolvedRecBridgeDeps(
  deps: Partial<RecBridgeDeps> & Pick<RecBridgeDeps, "currentRoom">,
): RecBridgeDeps {
  return {
    ...deps,
    sidecarPost: defaultValue(deps.sidecarPost, defaultSidecarPost),
    connectHostWs: defaultValue(deps.connectHostWs, defaultConnectHostWs),
    sessionWsUrl: defaultValue(deps.sessionWsUrl, defaultSessionWsUrl),
    readSpoolFrame: defaultValue(deps.readSpoolFrame, readSpoolFrame),
    resolveSttModel: defaultValue(deps.resolveSttModel, missingSttModel),
    diarizeModelPath: defaultValue(deps.diarizeModelPath, missingDiarizeModel),
    spoolDir: defaultValue(deps.spoolDir, defaultSpoolDir),
  };
}

/** Build a {@link RecBridgeCtx} with real production defaults, overridable
 * field by field — tests pass fakes for the transport seams and use the real
 * DB-backed logic for everything else. */
export function createRecBridgeCtx(
  deps: Partial<RecBridgeDeps> & Pick<RecBridgeDeps, "currentRoom">,
): RecBridgeCtx {
  return {
    state: new RecBridgeState(),
    deps: resolvedRecBridgeDeps(deps),
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
  body: unknown,
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

export async function defaultSidecarPost(
  path: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
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
export function recHostWsUrl(
  sidecarBaseUrl: string,
  fileId: string,
  token: string,
): string {
  const wsBase = sidecarBaseUrl.replace(/^http/, "ws");
  return `${wsBase}/rec/host?token=${encodeURIComponent(token)}&fileId=${encodeURIComponent(fileId)}`;
}

/** Production `WS /rec/host` connector. Sends issued before the socket is open
 * are queued rather than dropped — an ack lost to a race would strand the
 * sidecar's `persist()` for its whole 15 s timeout. */
export function defaultConnectHostWs(fileId: string): HostWsLike {
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
    ws.addEventListener("message", (ev: MessageEvent) =>
      handle.onMessage?.(String(ev.data)),
    );
    ws.addEventListener("close", () => handle.onClose?.());
  })().catch(() => {
    // The sidecar never came up. Nothing to do here: every persist then fails
    // its ack timeout, which `Engine.flush` retries — the documented behaviour
    // for a host that is not connected (session_ws.py §3).
    handle.onClose?.();
  });
  return handle;
}
