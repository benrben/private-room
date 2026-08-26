/**
 * The generative `#commands`. Ported from
 * `src-tauri/src/commands/chat_commands/generate.rs` (989 lines, read in
 * full, including its `#[cfg(test)] mod chunked_pass_tests`): `#summarize`,
 * `#compare`, `#transcribe`, `#minutes`, `#sketch`, `#to-sheet`,
 * `#translate`, `#research`.
 *
 * NOT AN `exec_tool` ARM. Verified against the real dispatcher, not assumed:
 * `chat_commands.rs`'s `run_command` is its OWN `#[tauri::command]`, invoked
 * by the frontend when the user TYPES a `#command` — a completely separate
 * entry point from the model's tool-calling loop (`execTool.ts`/
 * `toolRouting.ts`). Nothing in `toolSpecs.ts` advertises any of these names
 * to a model, and nothing here should be wired into `execTool.ts`.
 * `run_command` itself (the catalog, the cancel-registration boilerplate,
 * `#checkpoint`'s short-circuit, the local-model fallback, the dispatch
 * `match`, and the trailing "N part(s) couldn't be read" / "*(stopped)*"
 * bookkeeping) is `chat_commands.rs`'s OWN top-level dispatcher — a sibling
 * file, out of this batch's scope — and is not re-hosted here.
 *
 * `chatCommandsKnowledge.ts` LANDED CONCURRENTLY with this batch (its own
 * module doc: "A future port of `chat_commands/generate.rs`... should IMPORT
 * these exports rather than re-declaring them") and already rebuilt the slice
 * of `chat_commands.rs`'s shared `CmdCtx` scaffolding its five commands use:
 * {@link CmdCtx} (imported and EXTENDED here, not re-declared — see below),
 * `cmdWindows`/`CMD_WINDOW_CHARS`/`CMD_WINDOW_OVERLAP`, `quietStepText`,
 * `askQuiet`, `digest` (which owns the private `mapWindows`/`foldNotes` this
 * file therefore does not need its own copy of), and `CommandResult`. All are
 * imported and reused verbatim. Also reused: `docsHtml.ts`'s `refsFiles`/
 * `refsContext`/`nameFromTopic`/`htmlNoteName` (extended by that same
 * concurrent batch, per its own module doc — "this is that other command"
 * language it left for whoever needed them next), `editMatchCells.ts`'s
 * `serializeDelim`, and `editMatchExtraction.ts`'s `extensionOf`.
 *
 * WHAT THIS FILE ADDS on top of the reused `CmdCtx` shape — the two things
 * `knowledge.rs`'s five commands never needed: {@link askStreaming} (`ask_
 * streaming`, needs `ctx.temperature` — the ONE field `chatCommandsKnowledge
 * .ts`'s own module doc predicted a `generate.rs` port would have to add)
 * and {@link askStructured} (`ask_structured`, ADD-22's schema-constrained
 * call). Neither is a new client: `askStructured` is a thin wrapper over the
 * already-real `chatStructured` (`ollamaGenerate.ts`); `askStreaming` needs
 * `sidecar::generate_stream`'s `/generate_stream` NDJSON reader, which
 * nothing in this tree has ported (`sidecarJsonCancellable.ts`'s own doc
 * draws its line at the non-streaming `sidecar_json*` family), so it is
 * composed from already-committed pieces rather than a fresh low-level
 * client: `sidecar.ts`'s own `splitCompleteLines`/`waitForNextChunkOrCancel`/
 * `authedHeaders`/`busy`/`ensureUp` (the exact NDJSON-reading idiom
 * `streamRun` already uses for `/run`), plus `privacy.ts`'s `injectPolicy`
 * and `providers.ts`'s `ensureProviderCatalog`/`injectProviderRuntime` (the
 * same policy/provider wiring `ollamaGenerate.ts`'s `postGenerateCancellable`
 * already does for `/generate`). `chat_commands.rs::watch_stream` — the outer
 * per-command watchdog that races the whole stream against Stop-grace and an
 * idle ceiling — is ported alongside it as {@link watchStream}, with its own
 * two Rust unit tests carried over verbatim.
 *
 * ONE DELIBERATE STRUCTURAL DEVIATION in {@link generateStream}: Rust's
 * `next_stream_chunk` also enforces its OWN loose 1200s idle backstop
 * (`sidecar::STREAM_IDLE_TIMEOUT`) independent of `watch_stream`'s tighter
 * one (300s / 960s). `waitForNextChunkOrCancel` — the reused, unmodified
 * primitive — has no idle timeout of its own, and re-implementing a second,
 * always-looser one on top of it would be pure duplication: the outer
 * {@link watchStream} ceiling always fires first. Skipped, not silently
 * dropped — this note is that documentation. A genuine stall is still caught
 * and still aborts the request (`watchStream` calls back into `abort()`).
 *
 * GENUINELY UNPORTED DEPENDENCIES, refused honestly rather than faked (see
 * each seam's own doc below): on-device Whisper transcription
 * (`stt::decode_bytes_to_pcm`/`stt::transcribe`, plus the bundled/downloaded-
 * model lookup `stt_effective_model` folds into the same seam) for
 * `#transcribe`'s ON-DEMAND branch — a file that already has a cached
 * transcript still works in full; and the `.sketch` layout/geometry engine
 * (`commands::sketchdoc::layout_graph`, 2811 lines) for `#sketch`'s final
 * render — everything upstream of it (windowed structured calls, merging,
 * the schema, the title-safing) is real and tested, only drawing the result
 * throws. Both seams are injectable on {@link CmdCtx} (via {@link CmdCtx.
 * transcribeAudio}/{@link CmdCtx.layoutGraph}), defaulting to a clearly-
 * labeled `NOT_IMPLEMENTED:` rejection — the same "stub, don't fake"
 * convention `recRead.ts`'s `resolveReadEngineNotImplemented` and
 * `workflowCompose.ts`'s `generateOllama` default already establish, and the
 * same shape `chatCommandsKnowledge.ts`'s own `CmdCtx.generate` test seam
 * uses for `askQuiet`'s underlying call.
 *
 * SMALL PURE HELPERS PORTED LOCALLY, because nothing else in this port has
 * them yet — `docHero`/`minutesSchema`/`mergeMinutes`/`renderMinutesHtml`
 * (`docs_html/minutes.rs`, entirely `#minutes`' own territory), `extractMd
 * Table` (`docs_html.rs` — not among the four functions the knowledge.rs
 * batch already claimed), and `mediaKind` (a slice of `stt.rs`). Duplicating
 * a small, already-tested pure function locally rather than reaching into a
 * sibling file mid-edit is this port's established convention
 * (`sidecarJsonCancellable.ts`'s local `isConnectionRefused`, `ollamaGenerate
 * .ts`'s local `recoverJson`).
 *
 * `artifactBuilder.ts` IS extended (not duplicated) — its own module doc
 * explicitly invited exactly this: `Artifact.note` (the extension-defaulting
 * Markdown constructor) and `Artifact.indexedAs` (index a drawing's derived
 * text instead of its raw JSON) are genuinely part of the ONE write funnel,
 * reused by four of these eight commands (and now by `knowledge.rs`'s
 * `cmd_add_file`/`cmd_highlight` too, via its own `saveAndOpen`).
 *
 * `GENERATE_STREAM_DISPATCHER`: `/generate_stream` is exactly the kind of
 * long-lived streaming POST `sidecar.ts`'s own `RUN_STREAM_DISPATCHER`
 * exists for (undici's default 300s body/headers timeout would otherwise
 * tear down a legitimately slow local model's answer out from under
 * `watchStream`'s own, more informative ceiling). A separate local instance
 * rather than importing the un-exported one — `sidecar.ts` draws its own
 * scope at the `/run` client and this batch does not touch it.
 */

import { Agent as UndiciAgent } from "undici";
import { CancelFlag } from "./cancel.js";
import { Artifact } from "./artifactBuilder.js";
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
import { declaredFor } from "./capabilities.js";
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
  type ChunkStep,
} from "./sidecar.js";
import type { SidecarChatMessage } from "./sidecar.js";
import { injectPolicy } from "./privacy.js";
import { defaultProviderDeps, ensureProviderCatalog, injectProviderRuntime, type ProviderDeps } from "./providers.js";

export type { CommandResult };

// ============================================================================
// small shared bits
// ============================================================================

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Rust's `char::is_alphanumeric()` — `\p{Alphabetic}\p{N}`, not `\p{L}`.
 * This port's established equivalent (see `extractionWindow.ts`'s own
 * `WORDISH_CHAR` doc for the gap between the two and why it matters). Used
 * only by {@link safeFileStem} below — `nameFromTopic` (`docsHtml.ts`) has
 * its own identical local copy for the same reason. */
const ALNUM_CHAR = /[\p{Alphabetic}\p{N}]/u;

/** Rust's `str::split_whitespace()` — splits on runs of Unicode whitespace,
 * yields no empty tokens. Used only by {@link safeFileStem}. */
function splitWhitespaceUnicode(s: string): string[] {
  return s.split(/\p{White_Space}+/u).filter((t) => t !== "");
}

function emitSafely(emit: EmitFn | undefined, event: string, payload: unknown): void {
  try {
    emit?.(event, payload);
  } catch {
    // Swallowed deliberately, matching Rust's `let _ = w.emit(...)`.
  }
}

const NO_ROOM_OPEN = "No room is open.";

/** `chatCommandsKnowledge.ts`'s own private `requireRoom`, duplicated here —
 * unexported there, and every one of this file's eight commands needs it at
 * least once. */
function requireRoom(rooms: RoomSource): RoomHandle {
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
const KEEP_ALIVE_WARM = "30m";

function commandResult(content: string, sources: string[]): CommandResult {
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
const GENERATE_STREAM_DISPATCHER = new UndiciAgent({ bodyTimeout: 0, headersTimeout: 0 });

/** How often the cancel flag is polled while the POST/stream is in flight —
 * the same 100ms cadence `sidecarJsonCancellable.ts`/`sidecar.rs` use. */
const GENERATE_STREAM_CANCEL_POLL_MS = 100;

/** Walk an error's `.cause` chain for a POSIX `ECONNREFUSED` — local copy of
 * `sidecarJsonCancellable.ts`'s own private predicate (not exported there);
 * see this file's module doc on why small predicates are duplicated rather
 * than reached for across a file boundary. */
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

/** `{code, error}` off an NDJSON error line or an HTTP error body — the same
 * shape both `generate_stream`'s in-body `{"t":"error",...}` line and its
 * non-200 fallback use. */
function parseCodeError(v: unknown): { code: string; error: string } {
  const o = isRecord(v) ? v : {};
  const code = typeof o.code === "string" ? o.code : "ENGINE_ERROR";
  const error = typeof o.error === "string" ? o.error : "unknown error";
  return { code, error };
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
  const model = typeof body.model === "string" ? body.model : null;
  const sentinel = (code: string, error: string): string =>
    sidecarErrorSentinel({ code, error, status: 200 } as SidecarError, model);

  let requestBody: unknown;
  try {
    const withPolicy = injectPolicy(body) ?? body;
    if (model !== null) {
      await ensureProviderCatalog(model, providerDeps);
      requestBody = injectProviderRuntime(withPolicy, model, providerDeps);
    } else {
      requestBody = withPolicy;
    }
  } catch (err) {
    throw new Error(sentinel("ENGINE_ERROR", err instanceof Error ? err.message : String(err)));
  }

  let base: string;
  try {
    base = await ensureUp();
  } catch (err) {
    throw new Error(sentinel(SIDECAR_DOWN, err instanceof Error ? err.message : String(err)));
  }

  const guard = busy();
  let cancelledByFlag = false;
  const poll = setInterval(() => {
    if (cancel.load()) {
      cancelledByFlag = true;
      controller.abort();
    }
  }, GENERATE_STREAM_CANCEL_POLL_MS);

  try {
    let resp: Response;
    try {
      resp = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { ...authedHeaders(), "content-type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
        dispatcher: GENERATE_STREAM_DISPATCHER,
        // Same real-at-runtime/false-mismatch-at-the-type-level cast
        // `sidecar.ts`'s own `/run` call already documents.
      } as unknown as RequestInit);
    } catch (err) {
      if (cancelledByFlag || controller.signal.aborted) {
        return "";
      }
      throw new Error(
        sentinel(
          isConnectionRefused(err) ? "OLLAMA_DOWN" : "ENGINE_ERROR",
          err instanceof Error ? err.message : String(err)
        )
      );
    }

    if (!resp.ok) {
      let parsed: unknown = null;
      try {
        parsed = await resp.json();
      } catch {
        // no body to classify with — parseCodeError's defaults apply
      }
      const { code, error } = parseCodeError(parsed);
      throw new Error(sentinel(code, error));
    }
    if (resp.body === null) {
      throw new Error(sentinel("ENGINE_ERROR", `sidecar ${path} returned no body`));
    }

    const reader = resp.body.getReader();
    let buffered = Buffer.alloc(0);
    let full = "";
    try {
      for (;;) {
        let step: ChunkStep;
        try {
          step = await waitForNextChunkOrCancel(reader, controller.signal);
        } catch (err) {
          throw new Error(
            sentinel("ENGINE_ERROR", `Local AI stream failed: ${err instanceof Error ? err.message : String(err)}`)
          );
        }
        if (step.kind === "cancelled" || step.kind === "ended") {
          break;
        }
        buffered = Buffer.concat([buffered, Buffer.from(step.value)]);
        const split = splitCompleteLines(buffered);
        buffered = split.rest;
        for (const line of split.lines) {
          let ev: unknown;
          try {
            ev = JSON.parse(line);
          } catch {
            continue; // skip a malformed line rather than abort, matching Rust
          }
          if (!isRecord(ev)) {
            continue;
          }
          const t = typeof ev.t === "string" ? ev.t : null;
          if (t === "delta") {
            const d = typeof ev.v === "string" ? ev.v : "";
            if (d !== "") {
              full += d;
              onDelta(d);
            }
          } else if (t === "done") {
            return full;
          } else if (t === "error") {
            const { code, error } = parseCodeError(ev);
            throw new Error(sentinel(code, error));
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // best-effort, matching Rust's own "already released" tolerance
      }
    }
    return full;
  } finally {
    clearInterval(poll);
    guard.release();
  }
}

// ============================================================================
// watch_stream — the per-command watchdog
// ============================================================================

/** Longest gap with no token before a STREAMED step counts as stalled.
 * Ported verbatim from `COMMAND_STREAM_IDLE_SECS`. */
export const COMMAND_STREAM_IDLE_SECS = 300;

/** The cloud-CLI twin — a harness engine hands back its whole reply as ONE
 * delta at the very end, so the silence clock spans the whole answer. Ported
 * verbatim from `COMMAND_STREAM_IDLE_CLI_SECS`. */
export const COMMAND_STREAM_IDLE_CLI_SECS = 960;

/** How long Stop waits for the stream to notice the flag by itself before
 * hanging up on its behalf. Ported verbatim from `COMMAND_STOP_GRACE_MS`. */
export const COMMAND_STOP_GRACE_MS = 1_500;

/** Reads the DECLARED transport property rather than the model's name.
 * Ported verbatim from `stream_idle_secs`, using the already-real
 * `declaredFor` (`capabilities.ts`). */
export function streamIdleSecs(model: string): number {
  return declaredFor(model).streaming === "no" ? COMMAND_STREAM_IDLE_CLI_SECS : COMMAND_STREAM_IDLE_SECS;
}

/**
 * Race `fut` against Stop-grace and an idle ceiling. Ported from
 * `watch_stream`, adapted for JS's lack of Rust's "dropping a future cancels
 * its work": on either give-up path this calls `abort()` (the caller's hook
 * into {@link generateStream}'s `AbortController`) before returning/throwing,
 * which is what actually closes the connection here — see this file's module
 * doc.
 *
 * `lastToken`/`partial` are caller-owned mutable boxes (`{current: T}`, this
 * port's idiom for "the same cell several closures write to") updated by the
 * stream's own delta callback; `fut` itself is raced repeatedly against a
 * fresh ~200ms timer each loop, the same "re-race the SAME pending promise"
 * idiom `sidecar.ts`'s `waitForNextChunkOrCancel` already establishes, so a
 * result that becomes ready mid-tick is picked up on the very next microtask
 * rather than waiting out a whole poll interval.
 */
export async function watchStream(
  fut: Promise<string>,
  abort: () => void,
  cancel: CancelFlag,
  lastToken: { readonly current: number },
  partial: { readonly current: string },
  idleSecs: number,
  graceMs: number
): Promise<string> {
  const settled: Promise<{ tag: "value"; value: string } | { tag: "error"; error: unknown }> = fut.then(
    (value) => ({ tag: "value", value }),
    (error: unknown) => ({ tag: "error", error })
  );
  let stopSeenAt: number | null = null;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = new Promise<{ tag: "tick" }>((resolve) => {
      timer = setTimeout(() => resolve({ tag: "tick" }), 200);
    });
    let winner: { tag: "value"; value: string } | { tag: "error"; error: unknown } | { tag: "tick" };
    try {
      winner = await Promise.race([settled, tick]);
    } finally {
      clearTimeout(timer);
    }
    if (winner.tag === "value") {
      return winner.value;
    }
    if (winner.tag === "error") {
      throw winner.error;
    }
    if (cancel.load()) {
      const since = stopSeenAt ?? (stopSeenAt = Date.now());
      if (Date.now() - since >= graceMs) {
        abort();
        return partial.current;
      }
    }
    if (Date.now() - lastToken.current >= idleSecs * 1000) {
      abort();
      throw new Error(
        "The model stopped responding. Try a shorter selection, or switch to a faster model in Settings."
      );
    }
  }
}

// ============================================================================
// ask_streaming / ask_structured — the two CmdCtx methods knowledge.rs never
// needed (see this file's module doc)
// ============================================================================

/** One model call streamed live into the chat. Ported from `ask_streaming`. */
export async function askStreaming(ctx: CmdCtx, system: string, user: string): Promise<string> {
  const messages: SidecarChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const body = plainGenerateBody(ctx.model, messages, ctx.temperature, KEEP_ALIVE_WARM);
  const controller = new AbortController();
  const lastToken = { current: Date.now() };
  const partial = { current: "" };
  const turn = ctx.turn;
  const send = ctx.send;
  const streamFn = ctx.generateStream ?? generateStream;
  const fut = streamFn("/generate_stream", body, ctx.cancel, controller, (d) => {
    lastToken.current = Date.now();
    partial.current += d;
    turn.emit(send, "ask-delta", d);
  });
  return watchStream(
    fut,
    () => controller.abort(),
    ctx.cancel,
    lastToken,
    partial,
    streamIdleSecs(ctx.model),
    COMMAND_STOP_GRACE_MS
  );
}

/** ADD-22: like `askQuiet`, but the reply is constrained to `schema`. Ported
 * from `ask_structured` (no timeout wrapper in Rust either). */
export async function askStructured(
  ctx: CmdCtx,
  system: string,
  user: string,
  temp: number | null,
  schema: unknown
): Promise<string> {
  const fn = ctx.chatStructured ?? chatStructured;
  const messages: SidecarChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  return fn(ctx.model, messages, temp, KEEP_ALIVE_WARM, schema, { cancel: ctx.cancel });
}

// ============================================================================
// genuinely unported dependencies — mediaKind (stt.rs slice; the two seams'
// types/defaults are declared earlier, alongside CmdCtx)
// ============================================================================

/** `stt::media_kind` — ported verbatim (pure, no decoding). */
export function mediaKind(mime: string, ext: string): MediaKind | null {
  if (mime.startsWith("audio/")) {
    return "audio";
  }
  if (mime.startsWith("video/")) {
    return "video";
  }
  switch (ext) {
    case "m4a":
    case "mp3":
    case "wav":
    case "aac":
    case "flac":
    case "aiff":
    case "aif":
    case "caf":
    case "ogg":
    case "opus":
      return "audio";
    case "mp4":
    case "mov":
    case "m4v":
      return "video";
    default:
      return null;
  }
}

// ============================================================================
// docs_html/minutes.rs — doc_hero / minutes_schema / merge_minutes /
// render_minutes_html (local ports — see module doc)
// ============================================================================

/** Ported verbatim from `docs_html.rs`'s `doc_hero`. */
function docHero(eyebrow: string, title: string, subHtml: string): string {
  let h = '<header class="hero">\n';
  if (eyebrow !== "") {
    h += `<div class="eyebrow">${htmlEscape(eyebrow)}</div>\n`;
  }
  h += `<h1>${htmlEscape(title)}</h1>\n`;
  if (subHtml.trim() !== "") {
    h += `<p class="sub">${subHtml}</p>\n`;
  }
  h += '<div class="rule"></div>\n</header>\n';
  return h;
}

/** Extract the LAST markdown table in `text` as rows of cells (header
 * first). Ported verbatim from `docs_html.rs`'s `extract_md_table`. */
export function extractMdTable(text: string): string[][] | null {
  let last: string[][] | null = null;
  let cur: string[][] = [];
  const flush = (): void => {
    if (cur.length >= 2) {
      last = cur;
    }
    cur = [];
  };
  for (const line of text.split(/\r\n|\n/)) {
    const t = line.trim();
    if (!t.includes("|")) {
      flush();
      continue;
    }
    if (Array.from(t).every((c) => c === "|" || c === "-" || c === ":" || c === " ")) {
      continue; // a separator row like |---|---| carries no data
    }
    const trimmed = t.replace(/^\|+/, "").replace(/\|+$/, "");
    cur.push(trimmed.split("|").map((c) => c.trim()));
  }
  flush();
  return last;
}

/** Ported verbatim from `minutes_schema`. */
export function minutesSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      title: { type: "string" },
      date: { type: "string" },
      attendees: { type: "array", items: { type: "string" } },
      timeline: {
        type: "array",
        items: {
          type: "object",
          properties: {
            time: { type: "string" },
            topic: { type: "string" },
            summary: { type: "string" },
          },
          required: ["topic", "summary"],
        },
      },
      decisions: { type: "array", items: { type: "string" } },
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: { owner: { type: "string" }, task: { type: "string" } },
          required: ["task"],
        },
      },
    },
    required: ["title", "timeline"],
  };
}

export interface MinutesDoc {
  title: string;
  date: string;
  attendees: string[];
  timeline: Array<Record<string, unknown>>;
  decisions: string[];
  actions: Array<Record<string, unknown>>;
}

function minutesField(v: unknown, k: string): string {
  const r = isRecord(v) ? v[k] : undefined;
  return typeof r === "string" ? r.trim() : "";
}

/** Merge per-window minutes into one document's worth of structured fields —
 * deterministic, so a long meeting cannot lose its second half to a model
 * that only had room for the first. Ported verbatim from `merge_minutes`. */
export function mergeMinutes(parts: readonly unknown[]): MinutesDoc {
  const firstStr = (key: string): string => {
    for (const raw of parts) {
      const p = isRecord(raw) ? raw : {};
      const v = p[key];
      if (typeof v === "string") {
        const t = v.trim();
        if (t !== "") {
          return t;
        }
      }
    }
    return "";
  };
  const seenStr = new Set<string>();
  const attendees: string[] = [];
  const decisionsSeen = new Set<string>();
  const decisions: string[] = [];
  const timelineSeen = new Set<string>();
  const timeline: Array<Record<string, unknown>> = [];
  const actionsSeen = new Set<string>();
  const actions: Array<Record<string, unknown>> = [];
  const keyOf = (s: string): string => s.trim().toLowerCase();

  for (const raw of parts) {
    const p = isRecord(raw) ? raw : {};
    for (const a of Array.isArray(p.attendees) ? p.attendees : []) {
      if (typeof a === "string") {
        const s = a.trim();
        const k = keyOf(s);
        if (s !== "" && !seenStr.has(k)) {
          seenStr.add(k);
          attendees.push(s);
        }
      }
    }
    for (const d of Array.isArray(p.decisions) ? p.decisions : []) {
      if (typeof d === "string") {
        const s = d.trim();
        const k = keyOf(s);
        if (s !== "" && !decisionsSeen.has(k)) {
          decisionsSeen.add(k);
          decisions.push(s);
        }
      }
    }
    for (const it of Array.isArray(p.timeline) ? p.timeline : []) {
      const topic = minutesField(it, "topic");
      const summary = minutesField(it, "summary");
      if (topic === "" && summary === "") {
        continue;
      }
      const k = `${keyOf(topic)}|${keyOf(summary)}`;
      if (timelineSeen.has(k)) {
        continue;
      }
      timelineSeen.add(k);
      timeline.push(isRecord(it) ? it : {});
    }
    for (const a of Array.isArray(p.actions) ? p.actions : []) {
      const owner = minutesField(a, "owner");
      const task = minutesField(a, "task");
      if (task === "") {
        continue;
      }
      const k = `${keyOf(owner)}|${keyOf(task)}`;
      if (actionsSeen.has(k)) {
        continue;
      }
      actionsSeen.add(k);
      actions.push(isRecord(a) ? a : {});
    }
  }
  return { title: firstStr("title"), date: firstStr("date"), attendees, timeline, decisions, actions };
}

/** Render structured minutes into a timeline-styled HTML body. Ported
 * verbatim from `render_minutes_html`. */
export function renderMinutesHtml(p: MinutesDoc, title: string): string {
  const arrStrings = (arr: readonly string[]): string[] => arr.map((s) => s.trim()).filter((s) => s !== "");

  const date = p.date.trim();
  const attendees = arrStrings(p.attendees);
  const meta: string[] = [];
  if (date !== "") {
    meta.push(htmlEscape(date));
  }
  if (attendees.length > 0) {
    meta.push(`${attendees.length} attendee${attendees.length === 1 ? "" : "s"}`);
  }
  let body = docHero("Meeting minutes", title, meta.join(" · "));
  if (attendees.length > 0) {
    body += '<div class="chips">';
    for (const a of attendees) {
      body += `<span class="chip">${htmlEscape(a)}</span>`;
    }
    body += "</div>\n";
  }

  const items = p.timeline.filter((it) => minutesField(it, "topic") !== "" || minutesField(it, "summary") !== "");
  if (items.length > 0) {
    body += '<h2>Timeline</h2>\n<ul class="tl">\n';
    for (const it of items) {
      body += "<li>";
      const time = minutesField(it, "time");
      if (time !== "") {
        body += `<div class="time">${htmlEscape(time)}</div>`;
      }
      const topic = minutesField(it, "topic");
      if (topic !== "") {
        body += `<div class="topic">${htmlEscape(topic)}</div>`;
      }
      const summary = minutesField(it, "summary");
      if (summary !== "") {
        body += `<p class="summary">${htmlEscape(summary)}</p>`;
      }
      body += "</li>\n";
    }
    body += "</ul>\n";
  }

  const decisions = arrStrings(p.decisions);
  if (decisions.length > 0) {
    body += '<h2>Decisions</h2>\n<ul class="checks">\n';
    for (const d of decisions) {
      body += `<li>${htmlEscape(d)}</li>\n`;
    }
    body += "</ul>\n";
  }

  const rows: Array<[string, string]> = [];
  for (const a of p.actions) {
    const task = minutesField(a, "task");
    if (task === "") {
      continue;
    }
    rows.push([minutesField(a, "owner"), task]);
  }
  if (rows.length > 0) {
    body += '<h2>Action items</h2>\n<table class="actions">\n<tr><th>Owner</th><th>Task</th></tr>\n';
    for (const [owner, task] of rows) {
      const ownerHtml = owner === "" ? "—" : htmlEscape(owner);
      body += `<tr><td>${ownerHtml}</td><td>${htmlEscape(task)}</td></tr>\n`;
    }
    body += "</table>\n";
  }
  return body;
}

// ============================================================================
// #sketch — schema, merge, safe title (real + tested); layout is the seam
// ============================================================================

const SKETCH_SYS =
  "You turn a document into a DIAGRAM. Identify the handful of things it describes and " +
  "how they connect. Return nodes — each with a short id, a LABEL of at most four words, " +
  "and a `note` of one short sentence explaining it — and edges between those ids, each " +
  "with a two or three word label saying what the connection IS. Mark an obvious " +
  'beginning or ending with kind "start" or "end". Aim for 4 to 9 nodes: a diagram is ' +
  "a picture of the shape of something, not a copy of it. Use ONLY what the source says. " +
  "Also give a `title` for the diagram and a short `explanation` of what it shows.";

/** What the model is asked for: meaning, never geometry. Ported verbatim
 * from `sketch_schema`. */
export function sketchSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      title: { type: "string" },
      explanation: { type: "string" },
      nodes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            note: { type: "string" },
            kind: { type: "string", enum: ["start", "step", "end"] },
          },
          required: ["id", "label"],
        },
      },
      edges: {
        type: "array",
        items: {
          type: "object",
          properties: {
            from: { type: "string" },
            to: { type: "string" },
            label: { type: "string" },
          },
          required: ["from", "to"],
        },
      },
    },
    required: ["title", "nodes"],
  };
}

/** A title a file can be called. Ported verbatim from `safe_file_stem`. */
export function safeFileStem(title: string): string {
  const cleaned = Array.from(title)
    .map((c) => (ALNUM_CHAR.test(c) || " -_&+()".includes(c) ? c : " "))
    .join("");
  const squashed = splitWhitespaceUnicode(cleaned).join(" ");
  const out = squashed.trim().replace(/^-+|-+$/g, "").trim();
  if (out === "") {
    return "Sketch";
  }
  return Array.from(out).slice(0, 60).join("");
}

/** Fold the per-window descriptions into one diagram. Ported verbatim from
 * `merge_sketch`. */
export function mergeSketch(
  parts: readonly unknown[]
): { title: string; explanation: string; nodes: GraphNode[]; edges: GraphEdge[] } {
  let title = "";
  let explanation = "";
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const have = new Set<string>();
  const wired = new Set<string>();

  for (const raw of parts) {
    const p = isRecord(raw) ? raw : {};
    if (title === "") {
      title = (typeof p.title === "string" ? p.title : "").trim();
    }
    const e = typeof p.explanation === "string" ? p.explanation.trim() : "";
    if (e !== "") {
      if (explanation !== "") {
        explanation += " ";
      }
      explanation += e;
    }
    for (const n of Array.isArray(p.nodes) ? p.nodes : []) {
      if (!isRecord(n)) {
        continue;
      }
      const idRaw = typeof n.id === "string" ? n.id.trim() : "";
      if (idRaw === "") {
        continue;
      }
      const label = (typeof n.label === "string" ? n.label : idRaw).trim();
      if (label === "") {
        continue;
      }
      if (have.has(idRaw)) {
        continue;
      }
      have.add(idRaw);
      const note = typeof n.note === "string" ? n.note.trim() : "";
      const kind = typeof n.kind === "string" ? n.kind : undefined;
      const node: GraphNode = { id: idRaw, label };
      if (note !== "") {
        node.note = note;
      }
      if (kind !== undefined) {
        node.kind = kind;
      }
      nodes.push(node);
    }
    for (const e2 of Array.isArray(p.edges) ? p.edges : []) {
      if (!isRecord(e2)) {
        continue;
      }
      const from = typeof e2.from === "string" ? e2.from : null;
      const to = typeof e2.to === "string" ? e2.to : null;
      if (from === null || to === null) {
        continue;
      }
      // Rust dedupes on a `HashSet<(String, String)>` — a TUPLE, which cannot
      // confuse two different pairs. Joining the two ids with a separator can:
      // `"a b" -> "c"` and `"a" -> "b c"` produce the same string, and the
      // second, genuinely different connection is then dropped from the
      // diagram. `JSON.stringify` of the pair is unambiguous for any pair of
      // strings, which is what the tuple key actually promises.
      const key = JSON.stringify([from, to]);
      if (wired.has(key)) {
        continue;
      }
      wired.add(key);
      const label = typeof e2.label === "string" ? e2.label.trim() : "";
      const edge: GraphEdge = { from, to };
      if (label !== "") {
        edge.label = label;
      }
      edges.push(edge);
    }
  }
  const finalTitle = title === "" ? "Sketch" : safeFileStem(title);
  return { title: finalTitle, explanation, nodes, edges };
}

// ============================================================================
// #summarize
// ============================================================================

export async function cmdSummarize(ctx: CmdCtx): Promise<CommandResult> {
  const db = requireRoom(ctx.rooms).db;
  const fileId = ctx.refs[0];
  if (fileId !== undefined) {
    const [name, , , textRaw] = getFileFull(db, fileId);
    const text = textRaw ?? "";
    if (text.trim() === "") {
      throw new Error(`"${name}" has no readable text to summarize.`);
    }
    const doc = await digest(ctx, text, `Reading ${name}`);
    if (doc.trim() === "") {
      throw new Error(`Couldn't read "${name}" — the model returned nothing.`);
    }
    const out = await askStreaming(
      ctx,
      "You summarize a document faithfully and concisely.",
      `Summarize this document in 3-4 sentences, then list up to 3 key points as bullets.\n\n${doc}`
    );
    return commandResult(out, [name]);
  }

  const inventory = listFileInventory(db);
  if (inventory.length === 0) {
    throw new Error("This room has no files to summarize yet.");
  }
  let listing = "";
  for (const [name, mime, summary] of inventory) {
    if (summary !== null && summary.trim() !== "") {
      listing += `- ${name} — ${summary.trim()}\n`;
    } else {
      listing += `- ${name} (${mime})\n`;
    }
  }
  const digested = await digest(ctx, listing, "Reading the file list");
  const out = await askStreaming(
    ctx,
    "You describe what a personal document room is for, based only on the file list given.",
    `Given these files, describe in 3-4 sentences what this room is about, then suggest 3 things the user could ask.\n\nFiles:\n${digested}`
  );
  return commandResult(
    `${out}\n\n_Tip: the “Summarize room” button saves this as a file with per-file notes._`,
    []
  );
}

// ============================================================================
// #compare
// ============================================================================

export async function cmdCompare(ctx: CmdCtx): Promise<CommandResult> {
  if (ctx.refs.length < 2) {
    throw new Error("Add at least two files with @ — e.g. #compare @plan-a.md @plan-b.md");
  }
  const db = requireRoom(ctx.rooms).db;
  const files = refsFiles(db, ctx.refs);
  const names = files.map(([n]) => n);
  let refctx = "";
  for (const [name, text] of files) {
    if (text.trim() === "") {
      continue;
    }
    const d = await digest(ctx, text, `Reading ${name}`);
    if (d.trim() !== "") {
      refctx += `[file: ${name}]\n${d}\n\n`;
    }
  }
  const folded = await digest(ctx, refctx, "Lining the documents up");
  if (folded.trim() === "") {
    throw new Error("Those files have no readable text to compare.");
  }
  const out = await askStreaming(
    ctx,
    "You compare documents clearly and fairly.",
    "Compare the following documents. Give a one-sentence overview, then a short bullet list of the key " +
      `similarities and a short bullet list of the key differences.\n\n${folded}`
  );
  return commandResult(out, names);
}

// ============================================================================
// #transcribe
// ============================================================================

export async function cmdTranscribe(ctx: CmdCtx): Promise<CommandResult> {
  const fileId = ctx.refs[0];
  if (fileId === undefined) {
    throw new Error("Add a recording with @ — e.g. #transcribe @meeting.m4a");
  }
  const room = requireRoom(ctx.rooms);
  const [name, mimeRaw, , textRaw] = getFileFull(room.db, fileId);
  const mime = mimeRaw ?? "";
  const text = textRaw ?? "";
  const ext = extensionOf(name);
  const kind = mediaKind(mime, ext);

  if (text.trim() === "") {
    if (kind === null) {
      throw new Error(`"${name}" isn't an audio or video file.`);
    }
    ctx.turn.step(ctx.send, `Transcribing ${name} (long recordings take a while)…`);
    const bytes = (await readRoomFile(room, fileId)).bytes;
    if (bytes === null) {
      throw new Error("This recording has no stored audio.");
    }
    const transcribeAudio = ctx.transcribeAudio ?? transcribeAudioNotImplemented;
    const transcript = (await transcribeAudio(bytes, ext, kind)).trim();
    if (transcript === "") {
      throw new Error(
        `Couldn't get any speech from "${name}" — it may be silent, music-only, or an unreadable format.`
      );
    }
    // Cache it so a re-run is instant and the one-liner filler picks it up.
    const fullText = `(transcribed from recording)\n${transcript}`;
    try {
      setFileExtractedText(room.db, fileId, fullText);
    } catch {
      // best-effort, matching Rust's `let _ = db::update_file_content(...)`
    }
    emitSafely(ctx.emit, "room-files-changed", undefined);
    return commandResult(`Transcript of **${name}**:\n\n${transcript}`, [name]);
  }
  return commandResult(`Transcript of **${name}**:\n\n${text.trim()}`, [name]);
}

// ============================================================================
// #minutes
// ============================================================================

const MINUTES_SYS =
  "You turn a meeting transcript or notes into structured minutes. Produce a short " +
  "title; the date if stated; attendees if named; a TIMELINE of the discussion as an " +
  "ordered list of items, each with an optional time or phase label, a short topic, and " +
  "a 1-2 sentence summary; the key decisions; and action items with an owner when known. " +
  "Base everything ONLY on the source — leave a field empty rather than inventing it.";

export async function cmdMinutes(ctx: CmdCtx): Promise<CommandResult> {
  const room = requireRoom(ctx.rooms);
  const [refctx, refNames] = refsContext(room.db, ctx.refs);
  if (ctx.refs.length > 0 && refctx.trim() === "") {
    throw new Error(
      "That file has no readable text yet — if it's a recording, run #transcribe on it first, then #minutes."
    );
  }
  let source: string;
  if (refctx.trim() !== "") {
    source = refctx;
  } else if (ctx.history.trim() !== "") {
    source = `Conversation:\n${ctx.history}`;
  } else {
    throw new Error(
      "Give me something to turn into minutes — e.g. #minutes @meeting.m4a (a transcript or notes), " +
        "or run it after a discussion in this chat."
    );
  }

  const windows = cmdWindows(source);
  const total = windows.length;
  const parts: unknown[] = [];
  for (let i = 0; i < windows.length; i++) {
    if (ctx.cancel.load()) {
      break;
    }
    ctx.turn.step(
      ctx.send,
      total > 1 ? `Building the meeting minutes — part ${i + 1}/${total}…` : "Building the meeting minutes…"
    );
    const w = windows[i]!;
    const user =
      total > 1
        ? `This is part ${i + 1} of ${total} of one meeting, in order. Minute THIS part only; earlier and ` +
          `later parts are handled separately.\n\nSource:\n${w}`
        : `Source:\n${w}`;
    let raw: string;
    try {
      raw = await askStructured(ctx, MINUTES_SYS, user, 0.3, minutesSchema());
    } catch {
      ctx.unread.count += 1;
      continue;
    }
    try {
      parts.push(JSON.parse(raw.trim()));
    } catch {
      ctx.unread.count += 1;
    }
  }

  const parsed = mergeMinutes(parts);
  if (parsed.timeline.length === 0) {
    throw new Error(
      "Couldn't find a meeting to summarize in that source. Point #minutes at a transcript or notes " +
        "with @, e.g. #minutes @meeting.m4a."
    );
  }
  const title = parsed.title.trim() !== "" ? parsed.title.trim() : "Meeting minutes";
  const body = renderMinutesHtml(parsed, title);
  const doc = htmlDocument(title, body);
  const name = htmlNoteName(title);
  const written = Artifact.note(name, doc)
    .by("#minutes")
    .duringRun(ctx.turn.runId)
    .fromFiles(ctx.refs)
    .cancelWith(ctx.cancel)
    .commit(room.db);
  emitSafely(ctx.emit, "room-files-changed", undefined);
  emitSafely(ctx.emit, "agent-open-file", { id: written.meta.id });
  const items = parsed.timeline.length;
  const coverage =
    total > 1
      ? ` — a ${items}-point timeline, read in ${total} passes over the whole source`
      : " — a timeline of the meeting";
  return commandResult(`Created **${written.meta.name}**${coverage}.`, refNames);
}

// ============================================================================
// #sketch
// ============================================================================

export async function cmdSketch(ctx: CmdCtx): Promise<CommandResult> {
  const room = requireRoom(ctx.rooms);
  const [refctx, refNames] = refsContext(room.db, ctx.refs);
  let source: string;
  if (refctx.trim() !== "") {
    source = refctx;
  } else if (ctx.history.trim() !== "") {
    source = `Conversation:\n${ctx.history}`;
  } else if (ctx.args.trim() !== "") {
    source = `Topic: ${ctx.args}`;
  } else {
    throw new Error("Give me something to draw — e.g. #sketch @plan.md, or #sketch how our login flow works.");
  }

  const windows = cmdWindows(source);
  const total = windows.length;
  const parts: unknown[] = [];
  for (let i = 0; i < windows.length; i++) {
    if (ctx.cancel.load()) {
      break;
    }
    ctx.turn.step(ctx.send, total > 1 ? `Working out what to draw — part ${i + 1}/${total}…` : "Working out what to draw…");
    const w = windows[i]!;
    const user =
      total > 1
        ? `This is part ${i + 1} of ${total} of ONE source, in order. Describe the diagram for THIS part; ` +
          `the other parts are handled separately and merged.\n\nSource:\n${w}`
        : `Source:\n${w}`;
    let raw: string;
    try {
      raw = await askStructured(ctx, SKETCH_SYS, user, 0.2, sketchSchema());
    } catch {
      ctx.unread.count += 1;
      continue;
    }
    try {
      parts.push(JSON.parse(raw.trim()));
    } catch {
      ctx.unread.count += 1;
    }
  }

  const { title, explanation, nodes, edges } = mergeSketch(parts);
  if (nodes.length === 0) {
    throw new Error(
      "Couldn't find anything to draw in that source. Point #sketch at a document with some structure " +
        "to it — a plan, a process, a design — or describe what to draw."
    );
  }
  ctx.turn.step(ctx.send, "Drawing it…");
  const layoutGraph = ctx.layoutGraph ?? layoutGraphNotImplemented;
  const doc = layoutGraph(nodes, edges);

  const name = `${title}.sketch`;
  const written = Artifact.note(name, doc.toJson())
    .indexedAs(doc.extractedText())
    .by("#sketch")
    .duringRun(ctx.turn.runId)
    .fromFiles(ctx.refs)
    .cancelWith(ctx.cancel)
    .commit(room.db);
  emitSafely(ctx.emit, "room-files-changed", undefined);
  emitSafely(ctx.emit, "agent-open-file", { id: written.meta.id });

  const boxes = nodes.length;
  const arrows = edges.length;
  const coverage = total > 1 ? `, read in ${total} passes over the whole source` : "";
  let content = `Drew **${written.meta.name}** — ${boxes} box(es) and ${arrows} connection(s)${coverage}.`;
  if (explanation.trim() !== "") {
    content += `\n\n${explanation.trim()}`;
  }
  content +=
    '\n\nAsk for changes in your own words — "add a box for the retry path", "mark the payment step red", ' +
    '"drop the last two" — and I will redraw it.';
  return commandResult(content, refNames);
}

// ============================================================================
// #to-sheet
// ============================================================================

export async function cmdToSheet(ctx: CmdCtx): Promise<CommandResult> {
  const rows = extractMdTable(ctx.history);
  if (rows === null) {
    throw new Error("No table found in a recent answer to convert.");
  }
  const csv = serializeDelim(rows, ",");
  const db = requireRoom(ctx.rooms).db;
  const written = Artifact.note("table.csv", csv).by("#to-sheet").duringRun(ctx.turn.runId).commit(db);
  emitSafely(ctx.emit, "room-files-changed", undefined);
  emitSafely(ctx.emit, "agent-open-file", { id: written.meta.id });
  return commandResult(
    `Saved the table as **${written.meta.name}** (${Math.max(rows.length - 1, 0)} row(s)).`,
    [written.meta.name]
  );
}

// ============================================================================
// #translate
// ============================================================================

/** How many chunks in a row may fail before a chunked pass stops trying.
 * Ported verbatim from `CHUNK_GIVE_UP_AFTER`. */
export const CHUNK_GIVE_UP_AFTER = 3;

/** Best-effort bookkeeping for a chunked pass. Ported verbatim from
 * `ChunkFailures`. */
export class ChunkFailures {
  private first: string | null = null;
  private run = 0;

  /** Record a failed chunk. `true` means the run is long enough that the
   * engine, not the slice, is the problem. */
  note(err: string): boolean {
    if (this.first === null) {
      this.first = err;
    }
    this.run += 1;
    return this.run >= CHUNK_GIVE_UP_AFTER;
  }

  /** A chunk came back fine, so the failures so far were local ones. */
  ok(): void {
    this.run = 0;
  }

  /** What to say when the pass produced nothing at all. */
  nothingSaved(): string {
    return this.first ?? "The model returned nothing to save.";
  }
}

export async function cmdTranslate(ctx: CmdCtx): Promise<CommandResult> {
  const fileId = ctx.refs[0];
  if (fileId === undefined) {
    throw new Error("Add a file with @ — e.g. #translate @notes.md to Spanish");
  }
  const a = ctx.args.trim();
  let lang: string;
  const toIdx = a.lastIndexOf(" to ");
  if (toIdx !== -1) {
    lang = a.slice(toIdx + 4);
  } else if (a.startsWith("to ")) {
    lang = a.slice(3);
  } else {
    lang = a;
  }
  lang = lang.trim();
  if (lang === "") {
    throw new Error("Say the target language — e.g. #translate @notes.md to Spanish");
  }

  const room = requireRoom(ctx.rooms);
  const [name, , , textRaw] = getFileFull(room.db, fileId);
  const text = textRaw ?? "";
  if (text.trim() === "") {
    throw new Error(`"${name}" has no readable text to translate.`);
  }

  const chars = Array.from(text);
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += 3000) {
    chunks.push(chars.slice(i, i + 3000).join(""));
  }
  const total = chunks.length;
  let out = "";
  let done = 0;
  const failures = new ChunkFailures();
  for (let i = 0; i < chunks.length; i++) {
    if (ctx.cancel.load()) {
      break;
    }
    ctx.turn.step(ctx.send, `Translating part ${i + 1}/${total}`);
    let piece: string;
    try {
      piece = await askQuiet(
        ctx,
        `You translate text into ${lang}. Output ONLY the translation, preserving Markdown structure. ` +
          "Do not add commentary.",
        chunks[i]!,
        0.2
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (failures.note(message)) {
        break;
      }
      continue;
    }
    failures.ok();
    out += piece.trim();
    out += "\n";
    done = i + 1;
  }
  if (out.trim() === "") {
    throw new Error(failures.nothingSaved());
  }
  if (done < total) {
    const why = ctx.cancel.load()
      ? `Stopped after part ${done} of ${total}`
      : `The model stopped working after part ${done} of ${total}`;
    out += `\n\n---\n\n_${why} — the rest of "${name}" is not translated._\n`;
  }
  const dotIdx = name.lastIndexOf(".");
  const base = dotIdx !== -1 ? name.slice(0, dotIdx) : name;
  const fname = `${base} (${lang}).md`;
  // ART-1: no cancel flag here on purpose — a Stop mid-translation keeps the
  // parts already translated (the partial note above says so), so the write
  // is the honest record of what was done, not work that should be thrown
  // away.
  const written = Artifact.note(fname, out)
    .by("#translate")
    .duringRun(ctx.turn.runId)
    .fromFiles(ctx.refs)
    .commit(room.db);
  emitSafely(ctx.emit, "room-files-changed", undefined);
  emitSafely(ctx.emit, "agent-open-file", { id: written.meta.id });
  return commandResult(`Translated **${name}** into ${lang} → **${written.meta.name}**.`, [written.meta.name]);
}

// ============================================================================
// #research — D8, the Airlock
// ============================================================================

export async function cmdResearch(ctx: CmdCtx): Promise<CommandResult> {
  const question = ctx.args.trim();
  if (question === "") {
    throw new Error("Usage: #research <question>");
  }
  const room = requireRoom(ctx.rooms);

  const enabled = webAccessEnabled(room.db);
  if (!enabled) {
    return commandResult(
      "Web access is off in this room. Turn it on in **Settings → Online features**, then try " +
        "#research again.",
      []
    );
  }

  ctx.turn.step(ctx.send, `Searching the web for "${question}" (leaves this Mac)`);
  const page = await searchWeb(question);
  const hits = page.hits;
  if (hits.length === 0) {
    const blocked = blockedNote(page);
    return commandResult(
      blocked !== null
        ? `The web search for **${question}** did not run — ${joinNames(page.failed)} could not be ` +
          "reached (blocked, rate limited or too slow). This does not mean there is nothing to find; " +
          "try again in a few minutes."
        : `No web results found for **${question}**.`,
      []
    );
  }

  const imported: Array<[string, string]> = [];
  const sourceNames: string[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (seen.has(hit.url)) {
      continue;
    }
    seen.add(hit.url);
    if (ctx.cancel.load()) {
      break;
    }
    ctx.turn.step(ctx.send, `Saving source: ${hit.title} (leaves this Mac)`);
    let fetched: { title: string; text: string };
    try {
      fetched = await fetchReadable(hit.url);
    } catch {
      continue; // one bad page must not abort the whole run
    }
    if (fetched.text.trim() === "") {
      continue;
    }
    const title = fetched.title.trim() === "" ? hit.title : fetched.title;
    const name = availableName(room.db, linkFileName(title, hit.url));
    let metaName: string;
    try {
      const saved = currentDate(room.db);
      const content = `# ${title}\n\nSource: ${hit.url}\nSaved: ${saved}\n\n${fetched.text}`;
      const meta = await createRoomFile(
        room,
        name,
        "text/markdown",
        Buffer.from(content, "utf8"),
        content,
        "web",
      );
      room.db.prepare("UPDATE files SET origin_url = ? WHERE id = ?").run(hit.url, meta.id);
      metaName = meta.name;
    } catch {
      continue;
    }
    imported.push([metaName, fetched.text]);
    sourceNames.push(metaName);
  }
  emitSafely(ctx.emit, "room-files-changed", undefined);

  if (imported.length === 0) {
    return commandResult(
      `Found results for **${question}** but couldn't save any readable copies — the pages may be ` +
        "blocked or empty. Try a different question.",
      []
    );
  }

  let context = "";
  for (const [name, text] of imported) {
    const d = await digest(ctx, text, `Reading ${name}`);
    context += `## Source: ${name}\n${d}\n\n`;
  }
  const folded = await digest(ctx, context, "Reading the saved sources");
  ctx.turn.step(ctx.send, "Answering from the saved sources");
  let answer: string;
  try {
    answer = await askStreaming(
      ctx,
      "You answer the user's question using ONLY the provided sources, which were just saved into their " +
        "workspace. Cite the source file names inline where relevant. If the sources don't cover it, say " +
        "so plainly.",
      `Question: ${question}\n\nSources:\n${folded}`
    );
  } catch {
    answer = "";
  }
  const body =
    answer.trim() === ""
      ? `Saved ${sourceNames.length} source(s) into the room:\n${sourceNames.map((n) => `- ${n}`).join("\n")}`
      : answer;
  return commandResult(body, sourceNames);
}
