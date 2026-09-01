/** Cohesive extraction from chatCommandsGenerate.ts; its public API remains on that module. */
import { Agent as UndiciAgent } from "undici";
import { CancelFlag } from "./cancel.js";
import { Artifact, type Written } from "./artifactBuilder.js";
import {
  askQuiet,
  cmdWindows,
  digest,
  type CmdCtx as KnowledgeCmdCtx,
  type CommandResult,
  type EmitFn,
} from "./chatCommandsKnowledge.js";
import { htmlDocument, htmlEscape, htmlNoteName, refsContext, refsFiles } from "./docsHtml.js";
import {
  availableName,
  currentDate,
  getFileFull,
  listFileInventory,
  setFileExtractedText,
} from "./db-host/files.js";
import { serializeDelim } from "./editMatchCells.js";
import { extensionOf } from "./editMatchExtraction.js";
import { createToolEffects } from "./execTool.js";
import { chatStructured, plainGenerateBody } from "./ollamaGenerate.js";
import { isCliEngine } from "./turnContext.js";
import { webAccessEnabled } from "./gatherContext.js";
import { blockedNote, fetchReadable, joinNames, searchWeb } from "./web.js";
import { linkFileName } from "./browser/saved.js";
import type { RoomHandle, RoomSource } from "./jobs.js";
import { createRoomFile, readRoomFile } from "./workspace/roomContent.js";
import { SIDECAR_DOWN, sidecarErrorSentinel, type SidecarError } from "./sidecarJsonCancellable.js";
import {
  authedHeaders,
  busy,
  ensureUp,
  splitCompleteLines,
  waitForNextChunkOrCancel,
  type ChunkReader,
  type ChunkStep,
} from "./sidecar.js";
import type { SidecarChatMessage } from "./sidecar.js";
import { injectPolicy } from "./privacy.js";
import { defaultProviderDeps, ensureProviderCatalog, injectProviderRuntime, type ProviderDeps } from "./providers.js";
import type { WebHit } from "../shared/apiTypes.js";

export type { CommandResult };
import { safeFileStem } from "./chatGenerateData.js";
import { askStreaming, askStructured, watchStream } from "./chatGenerateDocuments.js";
// ============================================================================
// small shared bits
// ============================================================================

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function ownValue(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/** Rust's `char::is_alphanumeric()` — `\p{Alphabetic}\p{N}`, not `\p{L}`.
 * This port's established equivalent (see `extractionWindow.ts`'s own
 * `WORDISH_CHAR` doc for the gap between the two and why it matters). Used
 * only by {@link safeFileStem} below — `nameFromTopic` (`docsHtml.ts`) has
 * its own identical local copy for the same reason. */
export const ALNUM_CHAR = /[\p{Alphabetic}\p{N}]/u;

/** Rust's `str::split_whitespace()` — splits on runs of Unicode whitespace,
 * yields no empty tokens. Used only by {@link safeFileStem}. */
export function splitWhitespaceUnicode(s: string): string[] {
  return s.split(/\p{White_Space}+/u).filter((t) => t !== "");
}

export function emitSafely(emit: EmitFn | undefined, event: string, payload: unknown): void {
  try {
    emit?.(event, payload);
  } catch {
    // Swallowed deliberately, matching Rust's `let _ = w.emit(...)`.
  }
}

export const NO_ROOM_OPEN = "No room is open.";

/** `chatCommandsKnowledge.ts`'s own private `requireRoom`, duplicated here —
 * unexported there, and every one of this file's eight commands needs it at
 * least once. */
export function requireRoom(rooms: RoomSource): RoomHandle {
  const room = rooms.current();
  if (room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return room;
}

/** `commands::models::KEEP_ALIVE_WARM` — a plain literal, not a re-port of
 * `models.rs` (unported), matching every other ported call site's own local
 * copy (`filePass.ts`, `recRead.ts`, `storyTools.ts`, `workflowEngine.ts`,
 * and `chatCommandsKnowledge.ts`'s own private copy). Needed here for
 * {@link askStructured}/{@link askStreaming} — `askQuiet` carries its own. */
export const KEEP_ALIVE_WARM = "30m";

export function commandResult(content: string, sources: string[]): CommandResult {
  return { content, sources, effects: createToolEffects() };
}

// ============================================================================
// CmdCtx — extends chatCommandsKnowledge.ts's shared shape with exactly what
// generate.rs's eight commands need beyond it (see this file's module doc).
// ============================================================================

/** `stt::MediaKind`. */
export type MediaKind = "audio" | "video";

/** `stt::decode_bytes_to_pcm` + `stt::transcribe`, folded into one seam (the
 * bundled/downloaded-model lookup `stt_effective_model` collapses into the
 * same refusal — neither has an Electron port). Returns the RAW transcript,
 * before the caller's own trim/caching. */
export type TranscribeAudioFn = (bytes: Buffer, ext: string, kind: MediaKind) => Promise<string>;

export const TRANSCRIBE_AUDIO_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: on-device transcription (stt::decode_bytes_to_pcm / stt::transcribe, and " +
  "the bundled/downloaded Whisper model lookup stt_effective_model) has no Electron port yet, " +
  "so #transcribe cannot transcribe new audio. A recording that already has a cached transcript " +
  "still works.";

export const transcribeAudioNotImplemented: TranscribeAudioFn = () =>
  Promise.reject(new Error(TRANSCRIBE_AUDIO_NOT_IMPLEMENTED));

/** `commands::sketchdoc::{GraphNode, GraphEdge}` — plain data, declared
 * locally (no `sketchdoc.ts` exists for either side to import). */
export interface GraphNode {
  id: string;
  label: string;
  note?: string;
  kind?: string;
}
export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
}

/** What `commands::sketchdoc::layout_graph` returns — scoped to exactly the
 * two methods `#sketch` calls (`.to_json()`/`.extracted_text()`). */
export interface SketchDoc {
  toJson(): string;
  extractedText(): string;
}

/** `commands::sketchdoc::layout_graph` (2811 lines — node/edge geometry,
 * arrow routing, the `.sketch` JSON format). No Electron port anywhere in
 * this tree. Synchronous, matching the Rust call (no `.await`). */
export type LayoutGraphFn = (nodes: readonly GraphNode[], edges: readonly GraphEdge[]) => SketchDoc;

export const LAYOUT_GRAPH_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: the sketch layout engine (commands::sketchdoc::layout_graph — node/edge " +
  "geometry, arrow routing, the .sketch JSON format) has no Electron port yet, so #sketch found " +
  "something to draw but cannot render it.";

export const layoutGraphNotImplemented: LayoutGraphFn = () => {
  throw new Error(LAYOUT_GRAPH_NOT_IMPLEMENTED);
};

/**
 * `chat_commands.rs`'s `CmdCtx<'a>`, as generate.rs's eight commands actually
 * need it: `chatCommandsKnowledge.ts`'s already-real {@link KnowledgeCmdCtx}
 * PLUS `temperature` (read only by {@link askStreaming} — Rust's
 * `ask_streaming` reads `self.temperature`; every other CmdCtx-consuming
 * function here, like `askQuiet`/{@link askStructured}, takes its own
 * explicit `temp` parameter instead) and the two genuinely-unported seams.
 */
export interface CmdCtx extends KnowledgeCmdCtx {
  temperature: number | null;
  /** Defaults to {@link transcribeAudioNotImplemented}. */
  transcribeAudio?: TranscribeAudioFn;
  /** Defaults to {@link layoutGraphNotImplemented}. */
  layoutGraph?: LayoutGraphFn;
  /** Test-only seam for {@link askStructured}'s underlying model call —
   * defaults to the real `chatStructured` (`ollamaGenerate.ts`), the same
   * "test-only seam, real by default" convention {@link KnowledgeCmdCtx.
   * generate} already establishes for `askQuiet`. */
  chatStructured?: typeof chatStructured;
  /** Test-only seam for {@link askStreaming}'s underlying NDJSON stream —
   * defaults to the real {@link generateStream}. */
  generateStream?: typeof generateStream;
}

// ============================================================================
// generate_stream — the NDJSON `/generate_stream` reader `askStreaming` needs
// ============================================================================

/** Same long-streaming-POST reasoning as `sidecar.ts`'s own
 * `RUN_STREAM_DISPATCHER` — see this file's module doc. */
export const GENERATE_STREAM_DISPATCHER = new UndiciAgent({ bodyTimeout: 0, headersTimeout: 0 });

/** How often the cancel flag is polled while the POST/stream is in flight —
 * the same 100ms cadence `sidecarJsonCancellable.ts`/`sidecar.rs` use. */
export const GENERATE_STREAM_CANCEL_POLL_MS = 100;

/** Walk an error's `.cause` chain for a POSIX `ECONNREFUSED` — local copy of
 * `sidecarJsonCancellable.ts`'s own private predicate (not exported there);
 * see this file's module doc on why small predicates are duplicated rather
 * than reached for across a file boundary. */
export function isConnectionRefused(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 8 && cur != null; i++) {
    if ((cur as { code?: unknown }).code === "ECONNREFUSED") {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** `{code, error}` off an NDJSON error line or an HTTP error body — the same
 * shape both `generate_stream`'s in-body `{"t":"error",...}` line and its
 * non-200 fallback use. */
export function parseCodeError(v: unknown): { code: string; error: string } {
  const o = isRecord(v) ? v : {};
  const code = typeof o.code === "string" ? o.code : "ENGINE_ERROR";
  const error = typeof o.error === "string" ? o.error : "unknown error";
  return { code, error };
}

export type StreamSentinel = (code: string, error: string) => string;

export type StreamReader = ChunkReader & { cancel(): Promise<void> };

export type StreamState = {
  buffered: Buffer;
  full: string;
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function streamSentinel(model: string | null): StreamSentinel {
  return (code: string, error: string): string =>
    sidecarErrorSentinel({ code, error, status: 200 } as SidecarError, model);
}

export function streamModel(body: Record<string, unknown>): string | null {
  return typeof body.model === "string" ? body.model : null;
}

export async function prepareStreamRequest(
  body: Record<string, unknown>,
  model: string | null,
  providerDeps: ProviderDeps,
  sentinel: StreamSentinel,
): Promise<unknown> {
  try {
    const withPolicy = injectPolicy(body) ?? body;
    if (model === null) return withPolicy;
    await ensureProviderCatalog(model, providerDeps);
    return injectProviderRuntime(withPolicy, model, providerDeps);
  } catch (err) {
    throw new Error(sentinel("ENGINE_ERROR", errorMessage(err)));
  }
}

export async function streamBase(sentinel: StreamSentinel): Promise<string> {
  try {
    return await ensureUp();
  } catch (err) {
    throw new Error(sentinel(SIDECAR_DOWN, errorMessage(err)));
  }
}

export function startCancellationPoll(cancel: CancelFlag, controller: AbortController): {
  poll: ReturnType<typeof setInterval>;
  wasCancelled: () => boolean;
} {
  let cancelledByFlag = false;
  const poll = setInterval(() => {
    if (!cancel.load()) return;
    cancelledByFlag = true;
    controller.abort();
  }, GENERATE_STREAM_CANCEL_POLL_MS);
  return { poll, wasCancelled: () => cancelledByFlag || controller.signal.aborted };
}

export function streamRequestInit(requestBody: unknown, controller: AbortController): RequestInit {
  return {
    method: "POST",
    headers: { ...authedHeaders(), "content-type": "application/json" },
    body: JSON.stringify(requestBody),
    signal: controller.signal,
    dispatcher: GENERATE_STREAM_DISPATCHER,
    // Same real-at-runtime/false-mismatch-at-the-type-level cast
    // `sidecar.ts`'s own `/run` call already documents.
  } as unknown as RequestInit;
}

export async function postStream(
  base: string,
  path: string,
  requestBody: unknown,
  controller: AbortController,
  wasCancelled: () => boolean,
  sentinel: StreamSentinel,
): Promise<Response | null> {
  try {
    return await fetch(`${base}${path}`, streamRequestInit(requestBody, controller));
  } catch (err) {
    if (wasCancelled()) return null;
    const code = isConnectionRefused(err) ? "OLLAMA_DOWN" : "ENGINE_ERROR";
    throw new Error(sentinel(code, errorMessage(err)));
  }
}

export async function errorResponseDetail(resp: Response): Promise<{ code: string; error: string }> {
  try {
    return parseCodeError(await resp.json());
  } catch {
    return parseCodeError(null);
  }
}

export async function streamReader(
  resp: Response,
  path: string,
  sentinel: StreamSentinel,
): Promise<StreamReader> {
  if (!resp.ok) {
    const { code, error } = await errorResponseDetail(resp);
    throw new Error(sentinel(code, error));
  }
  if (resp.body === null) {
    throw new Error(sentinel("ENGINE_ERROR", `sidecar ${path} returned no body`));
  }
  return resp.body.getReader();
}

export async function nextStreamStep(
  reader: StreamReader,
  signal: AbortSignal,
  sentinel: StreamSentinel,
): Promise<ChunkStep> {
  try {
    return await waitForNextChunkOrCancel(reader, signal);
  } catch (err) {
    throw new Error(sentinel("ENGINE_ERROR", `Local AI stream failed: ${errorMessage(err)}`));
  }
}

export function parseStreamEvent(line: string): Record<string, unknown> | null {
  try {
    const event: unknown = JSON.parse(line);
    return isRecord(event) ? event : null;
  } catch {
    return null;
  }
}

export function appendStreamDelta(
  state: StreamState,
  event: Record<string, unknown>,
  onDelta: (d: string) => void,
): void {
  const delta = typeof event.v === "string" ? event.v : "";
  if (delta === "") return;
  state.full += delta;
  onDelta(delta);
}

export function processStreamEvent(
  state: StreamState,
  event: Record<string, unknown>,
  onDelta: (d: string) => void,
  sentinel: StreamSentinel,
): boolean {
  const type = typeof event.t === "string" ? event.t : null;
  if (type === "delta") {
    appendStreamDelta(state, event, onDelta);
    return false;
  }
  if (type === "done") return true;
  if (type === "error") {
    const { code, error } = parseCodeError(event);
    throw new Error(sentinel(code, error));
  }
  return false;
}

export function consumeStreamChunk(
  state: StreamState,
  value: Uint8Array,
  onDelta: (d: string) => void,
  sentinel: StreamSentinel,
): boolean {
  const split = splitCompleteLines(Buffer.concat([state.buffered, Buffer.from(value)]));
  state.buffered = split.rest;
  for (const line of split.lines) {
    const event = parseStreamEvent(line);
    if (event !== null && processStreamEvent(state, event, onDelta, sentinel)) return true;
  }
  return false;
}

export function streamChunkValue(step: ChunkStep): Uint8Array | null {
  return step.kind === "chunk" ? step.value : null;
}

export async function cancelReader(reader: StreamReader): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Best-effort, matching Rust's own "already released" tolerance.
  }
}

export async function readStream(
  reader: StreamReader,
  controller: AbortController,
  onDelta: (d: string) => void,
  sentinel: StreamSentinel,
): Promise<string> {
  const state: StreamState = { buffered: Buffer.alloc(0), full: "" };
  try {
    for (;;) {
      const step = await nextStreamStep(reader, controller.signal, sentinel);
      const value = streamChunkValue(step);
      if (value === null) return state.full;
      if (consumeStreamChunk(state, value, onDelta, sentinel)) return state.full;
    }
  } finally {
    await cancelReader(reader);
  }
}

/**
 * Streaming plain-text generation through the sidecar `POST /generate_stream`
 * (NDJSON) — invokes `onDelta` once per token as it arrives and resolves the
 * full accumulated text. Ported from `sidecar::generate_stream`; see this
 * file's module doc for what is reused vs. newly composed, and the ONE
 * documented idle-timeout deviation.
 *
 * `controller` is the caller's own `AbortController`: this function polls
 * `cancel` itself (mirroring `sidecarJsonCancellable.ts`'s cadence) and calls
 * `controller.abort()` on trip, but a caller ({@link watchStream}, on its own
 * idle-timeout) may ALSO abort it directly — both paths are just "the
 * connection closes", which is exactly what dropping the pinned future in
 * Rust does.
 *
 * Resolves `""` on an abort that lands before any response starts (a
 * strengthening over Rust, which only starts checking `cancel` once the
 * stream begins — see the module doc's own note on why this is safe).
 * Resolves the accumulated partial on Stop/end-of-stream once headers have
 * arrived; throws the classified sentinel on a genuine engine failure.
 */
export async function generateStream(
  path: string,
  body: Record<string, unknown>,
  cancel: CancelFlag,
  controller: AbortController,
  onDelta: (d: string) => void,
  providerDeps: ProviderDeps = defaultProviderDeps
): Promise<string> {
  const model = streamModel(body);
  const sentinel = streamSentinel(model);
  const requestBody = await prepareStreamRequest(body, model, providerDeps, sentinel);
  const base = await streamBase(sentinel);
  const guard = busy();
  const { poll, wasCancelled } = startCancellationPoll(cancel, controller);

  try {
    const response = await postStream(base, path, requestBody, controller, wasCancelled, sentinel);
    if (response === null) return "";
    const reader = await streamReader(response, path, sentinel);
    return readStream(reader, controller, onDelta, sentinel);
  } finally {
    clearInterval(poll);
    guard.release();
  }
}
