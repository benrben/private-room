/** Cohesive extraction from chatCommandsKnowledge.ts; its public API remains on that module. */
import { CancelFlag } from "./cancel.js";
import { Artifact, type Written } from "./artifactBuilder.js";
import {
  htmlNoteName,
  htmlTitledDoc,
  noteMime,
  refsContext,
  refsFiles,
  titleFromName,
} from "./docsHtml.js";
import { getFileFull } from "./db-host/files.js";
import { addMemory } from "./db-host/memories.js";
import {
  makeSnippet,
  retrieveContextLimited,
  type ScoredChunk,
} from "./db-host/retrieval.js";
import { resolvedBaseUrl, stripThinkSpans } from "./engineRouting.js";
import { extensionOf } from "./editMatchExtraction.js";
import { parseDelim, serializeDelim } from "./editMatchCells.js";
import { byteLength, partitionWindows, sliceUtf8 } from "./extractionWindow.js";
import { createToolEffects, type ToolEffects } from "./execTool.js";
import { buildAnnotation } from "./fileTools.js";
import { valueStr } from "./jsonTools.js";
import type { RoomHandle, RoomSource } from "./jobs.js";
import { duplicateMemory } from "./libraryTools.js";
import {
  generate as generateReal,
  type GenerateOpts,
} from "./ollamaGenerate.js";
import { embedQuestion } from "./retrievalBackfill.js";
import type { SidecarChatMessage } from "./sidecar.js";
import {
  sidecarErrorSentinel,
  sidecarJsonCancellable,
} from "./sidecarJsonCancellable.js";
import { TurnId, type EventSender } from "./turn.js";

export type { ScoredChunk };
// ============================================================================
// room access + best-effort emit — following this port's established RoomSource
// (`jobs.ts`) / EmitFn (`filePass.ts`) conventions rather than inventing a
// third shape.
// ============================================================================

export const NO_ROOM_OPEN = "No room is open.";

export function requireRoom(rooms: RoomSource): RoomHandle {
  const room = rooms.current();
  if (room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return room;
}

/** `filePass.ts`'s own `EmitFn` shape, re-declared locally (that file does not
 * export it) — a best-effort UI notification, matching Rust's `let _ =
 * window.emit(...)`. */
export type EmitFn = (event: string, payload: unknown) => void;

export function emitSafely(
  emit: EmitFn | undefined,
  event: string,
  payload: unknown,
): void {
  try {
    emit?.(event, payload);
  } catch {
    // Swallowed deliberately, matching Rust's `let _ = w.emit(...)`.
  }
}

/**
 * `docs_html.rs`'s `save_and_open`: commit a fresh artifact, then tell the
 * Files list to reload and the viewer to open it. Both events fire — the file
 * appears in the sidebar AND jumps into the viewer. Ported verbatim; see this
 * module's own doc for why it lives here rather than in `docsHtml.ts`.
 */
export async function commitArtifact(
  room: RoomHandle,
  art: Artifact,
): Promise<Written> {
  return room.workspace === undefined
    ? art.commit(room.db)
    : art.commitToWorkspace(room.workspace);
}

export async function saveAndOpen(
  rooms: RoomSource,
  emit: EmitFn | undefined,
  art: Artifact,
): Promise<Written> {
  const room = requireRoom(rooms);
  const written = await commitArtifact(room, art);
  emitSafely(emit, "room-files-changed", undefined);
  emitSafely(emit, "agent-open-file", { id: written.meta.id });
  return written;
}

// ============================================================================
// CmdCtx — the shared #command scaffolding `knowledge.rs`'s five commands use.
// See this module's own doc for scope/placement.
// ============================================================================

/** `AtomicUsize`'s stand-in: how many windows of a source this command's
 * model calls could not read (an error, a timeout, or an empty reply). Rust's
 * `run_command` dispatcher reads `ctx.unread` AFTER awaiting a command to
 * append the "N part(s) couldn't be read" trailer — that dispatcher is out of
 * this batch's scope (see the module doc), so nothing here reads `count`
 * itself; a future `run_command` port reads it off the SAME {@link CmdCtx} it
 * passed in, exactly as `ctx.unread.load(..)` does in Rust. */
export interface UnreadCounter {
  count: number;
}

/**
 * Everything a `#command` workflow needs. Ported from `chat_commands.rs`'s
 * `CmdCtx<'a>` — `window`/`state` become `rooms`/`send`/`emit` (this port's
 * established seams; `turnEngine.ts`'s own module doc explains why there is
 * no `AppState` here yet), everything else is field-for-field.
 *
 * `temperature` is NOT carried: every `knowledge.rs` command hardcodes its
 * own model-call temperature (0.0 for extraction/lookup passes, 0.2 for
 * note-folding, 0.4 for document generation) rather than reading the room's
 * `ctx.temperature` setting — verified by reading every call site in the
 * source file, not assumed. A future `generate.rs` port that DOES need it
 * should add the field rather than this file inventing an unused one.
 */
export interface CmdCtx {
  rooms: RoomSource;
  send: EventSender;
  /** Best-effort raw (non-turn-enveloped) events — `room-files-changed`,
   * `agent-open-file`, `agent-annotate` — matching Rust's bare `window.emit`
   * calls, which never carry the turn/chat envelope `ask-*` events do. */
  emit?: EmitFn;
  turn: TurnId;
  model: string;
  /** @-pinned file ids (resolved in the UI before send). */
  refs: readonly string[];
  /** Text after the command word, with @tokens already stripped by the UI. */
  args: string;
  /** Prior conversation as plain text (oldest-first) — already formatted by
   * `run_command`'s (unported) `format_history`; the caller supplies it. */
  history: string;
  cancel: CancelFlag;
  unread: UnreadCounter;
  /** Test-only seam for {@link askQuiet}'s underlying model call — defaults
   * to the real `ollamaGenerate.ts` `generate`. */
  generate?: typeof generateReal;
  /** Test-only seam for {@link askQuiet}'s per-step wall-clock ceiling —
   * defaults to {@link COMMAND_STEP_TIMEOUT_MS} (`chat_commands.rs`'s
   * `COMMAND_STEP_TIMEOUT_SECS`, 300s). */
  stepTimeoutMs?: number;
}

/** One step chip, stamped with this command's run and chat. */
export function step(ctx: CmdCtx, label: string): void {
  ctx.turn.step(ctx.send, label);
}

/** Record that one window of the source could not be read. */
export function noteUnread(ctx: CmdCtx): void {
  ctx.unread.count += 1;
}

/** `chat_commands.rs::quiet_step_text` — a thinking model's private
 * `<think>…</think>` preamble must never reach a #command's output (it isn't
 * read before it is used — `#translate` saves it straight into a new FILE,
 * `#extract` folds it into a table). Ported verbatim. */
export function quietStepText(raw: string): string {
  return stripThinkSpans(raw).trim();
}

/** `chat_commands.rs::COMMAND_STEP_TIMEOUT_SECS` (300s), as milliseconds. */
export const COMMAND_STEP_TIMEOUT_MS = 300_000;

/** `chat_commands.rs::KEEP_ALIVE_WARM` — a plain literal, not a re-port of
 * `models.rs` (unported), matching `filePass.ts`/`storyTools.ts`'s own
 * established precedent for this exact constant. */
export const KEEP_ALIVE_WARM = "30m";

/** Thrown internally by {@link withTimeout} on expiry; never escapes
 * {@link askQuiet}, which turns it into the same actionable message
 * `chat_commands.rs`'s `tokio::time::timeout` branch returns. */
export class StepTimedOut extends Error {}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new StepTimedOut()), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export function quietGenerator(ctx: CmdCtx): NonNullable<CmdCtx["generate"]> {
  return ctx.generate === undefined ? generateReal : ctx.generate;
}

export function quietTimeout(ctx: CmdCtx): number {
  return ctx.stepTimeoutMs === undefined ? COMMAND_STEP_TIMEOUT_MS : ctx.stepTimeoutMs;
}

export function throwQuietError(err: unknown): never {
  if (err instanceof StepTimedOut) {
    throw new Error(
      "The model took too long to respond. Try a shorter selection, or switch to a faster model in Settings.",
    );
  }
  throw err;
}

/**
 * `chat_commands.rs::CmdCtx::ask_quiet` — one model call whose output is NOT
 * shown as chat (it becomes a file, a quote, or a parsed list): non-streamed,
 * `<think>`-stripped, capped at {@link COMMAND_STEP_TIMEOUT_MS} so a stalled
 * model fails fast with a clear message instead of freezing the command's
 * step chip for the shared multi-hour sidecar ceiling. Ported verbatim.
 */
export async function askQuiet(
  ctx: CmdCtx,
  system: string,
  user: string,
  temp: number | null,
): Promise<string> {
  const gen = quietGenerator(ctx);
  const timeoutMs = quietTimeout(ctx);
  const messages: SidecarChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const opts: GenerateOpts = { cancel: ctx.cancel };
  let text: string;
  try {
    text = await withTimeout(
      gen(ctx.model, messages, temp, KEEP_ALIVE_WARM, opts),
      timeoutMs,
    );
  } catch (err) {
    throwQuietError(err);
  }
  return quietStepText(text);
}

/** `chat_commands.rs::CMD_WINDOW_CHARS`/`CMD_WINDOW_OVERLAP` — see this
 * module's own doc: byte counts despite the name. */
export const CMD_WINDOW_CHARS = 16_000;
export const CMD_WINDOW_OVERLAP = 400;

/**
 * `chat_commands.rs::cmd_windows` — every window of `text`, in order,
 * exhaustive. A text that already fits is one window, so the single-call path
 * is unchanged. Ported verbatim, on {@link byteLength}/`partitionWindows`/
 * `sliceUtf8` rather than string indices — see this module's own doc.
 */
export function cmdWindows(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === "") {
    return [];
  }
  if (byteLength(trimmed) <= CMD_WINDOW_CHARS) {
    return [trimmed];
  }
  return partitionWindows(trimmed, CMD_WINDOW_CHARS, CMD_WINDOW_OVERLAP).map(
    ([s, e]) => {
      // `partitionWindows` only ever returns spans it computed against
      // `trimmed` itself, so an out-of-range slice cannot happen here — matches
      // Rust's infallible `text[s..e]` indexing.
      return sliceUtf8(trimmed, s, e)!;
    },
  );
}

/** `chat_commands.rs::FOLD_MAX_ROUNDS` — a guard against a fold that never
 * shrinks, not a coverage cap: every round already saw the whole source. */
export const FOLD_MAX_ROUNDS = 6;

/** `chat_commands.rs::NOTE_SYS` — verbatim. */
export const NOTE_SYS =
  "You take faithful, dense notes on ONE part of a longer source. Keep every " +
  "fact, name, number, date, decision, commitment and telling quote a reader " +
  "of the whole source would need — these notes will REPLACE this part later, " +
  "so anything you leave out is lost. No preamble, no commentary.";

/**
 * `chat_commands.rs::CmdCtx::map_windows` — the MAP half of a full pass: one
 * quiet call per window of `source`, in order. A Stop between windows ends the
 * pass with what it already has; a window whose call fails (or answers empty)
 * contributes nothing and is counted in {@link CmdCtx.unread} instead of
 * aborting the whole run. Ported verbatim.
 */
export async function mapWindows(
  ctx: CmdCtx,
  source: string,
  label: string,
  system: string,
  userFor: (w: string) => string,
  temp: number | null,
): Promise<string[]> {
  const windows = cmdWindows(source);
  const total = windows.length;
  const out: string[] = [];
  for (let i = 0; i < windows.length; i++) {
    if (ctx.cancel.load()) break;
    announceWindowStep(ctx, label, i, total);
    const piece = await mappedWindow(ctx, system, userFor(windows[i] as string), temp);
    if (piece !== null) {
      out.push(piece);
    } else {
      noteUnread(ctx);
    }
  }
  return out;
}

export function announceWindowStep(ctx: CmdCtx, label: string, index: number, total: number): void {
  if (total > 1) step(ctx, `${label} (${index + 1}/${total})`);
}

export async function mappedWindow(
  ctx: CmdCtx,
  system: string,
  user: string,
  temp: number | null,
): Promise<string | null> {
  try {
    const output = (await askQuiet(ctx, system, user, temp)).trim();
    return output === "" ? null : output;
  } catch {
    return null;
  }
}

/**
 * `chat_commands.rs::CmdCtx::fold_notes` — the REDUCE half: fold notes down to
 * something one call can hold, by re-folding while they are still too big.
 * Every round has already seen the whole source, so this loses detail, never
 * coverage. Ported verbatim.
 */
export async function foldNotes(
  ctx: CmdCtx,
  notes: readonly string[],
  label: string,
): Promise<string> {
  let text = notes.join("\n\n");
  for (let round = 0; round < FOLD_MAX_ROUNDS; round++) {
    if (byteLength(text) <= CMD_WINDOW_CHARS || ctx.cancel.load()) {
      break;
    }
    const before = byteLength(text);
    const roundOut = await mapWindows(
      ctx,
      text,
      label,
      NOTE_SYS,
      (w) => `Notes:\n${w}`,
      0.2,
    );
    if (roundOut.length === 0) {
      break;
    }
    const joined = roundOut.join("\n\n");
    // A round that didn't shrink won't shrink next time either.
    if (byteLength(joined) >= before) {
      break;
    }
    text = joined;
  }
  return text;
}

/**
 * `chat_commands.rs::CmdCtx::digest` — the whole of `text`, reduced to what
 * one call can hold WITHOUT dropping any of it: returned unchanged when it
 * already fits, otherwise notes over every window, folded. The "full ops"
 * replacement for a byte-clamp. Ported verbatim.
 */
export async function digest(
  ctx: CmdCtx,
  text: string,
  label: string,
): Promise<string> {
  if (byteLength(text) <= CMD_WINDOW_CHARS) {
    return text;
  }
  const notes = await mapWindows(
    ctx,
    text,
    label,
    NOTE_SYS,
    (w) => `Part of the source:\n${w}`,
    0.2,
  );
  return foldNotes(ctx, notes, label);
}
