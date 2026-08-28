/**
 * The knowledge/retrieval-flavored `#commands`: `#remember`, `#find`,
 * `#add-file` (single + the `for each …` fan-out), `#highlight`, `#extract`.
 * Ported from `src-tauri/src/commands/chat_commands/knowledge.rs` (642
 * lines, read in full, including its `#[cfg(test)] mod tests`).
 *
 * NOT MODEL-INVOCABLE. Verified against the real Rust source, not assumed:
 * `#commands` are dispatched by `chat_commands.rs`'s `run_command` — a plain
 * `#[tauri::command]` the FRONTEND calls when a human types `#name …` and
 * presses send (`lib.rs`'s `tauri::generate_handler!` registers it next to
 * `list_chat_commands`, both invoked only from `src/api.ts`). `exec_tool`'s
 * whole match-arm list (`agent.rs`, read for this batch) has no
 * `"remember"`/`"find"`/`"add_file"`/`"highlight"`/`"extract"` arm, and
 * `toolSpecs.ts`'s `BUILTIN_TOOL_NAMES` has no such names either — the model
 * never calls any of these. So this file adds nothing to `execTool.ts`.
 *
 * WHAT THIS FILE PORTS, and what it deliberately does NOT:
 *
 *   - The five `cmd_*` functions themselves — `cmdRemember`/`cmdFind`/
 *     `cmdAddFile`/`cmdHighlight`/`cmdExtract` — plus their own private
 *     helpers (`capFanOut`, `findBody`, `tabularFieldRows`,
 *     `stripTrailingPreposition`), all ported verbatim.
 *   - The slice of `chat_commands.rs`'s shared `CmdCtx` scaffolding these five
 *     commands actually call: {@link CmdCtx} itself, {@link cmdWindows},
 *     {@link quietStepText}, {@link askQuiet}, and the private `mapWindows`/
 *     `foldNotes`/{@link digest}. `chat_commands.rs` (the `run_command`
 *     dispatcher, `ask_streaming`, `ask_structured`, `format_history`, the
 *     watchdog) is NOT ported — nothing in `knowledge.rs` calls any of it.
 *     `ask_quiet`/`digest`/`map_windows`/`fold_notes`/`cmd_windows` live here,
 *     ported alongside the first command file that needs them, because no
 *     `chatCommands.ts` base module exists yet in this migration. A future
 *     port of `chat_commands/generate.rs` (`#summarize`/`#compare`/
 *     `#transcribe`/`#minutes`/`#sketch`/`#to-sheet`/`#translate`/
 *     `#research`, all of which also use this scaffolding) should IMPORT
 *     these exports rather than re-declaring them; a future port of
 *     `chat_commands.rs`'s own `run_command` should do the same for
 *     {@link CmdCtx} and read {@link CmdCtx.unread} the way Rust's dispatcher
 *     reads `ctx.unread` — see that field's own doc.
 *
 * DEPENDENCIES ALREADY REAL, verified by reading each target file, not
 * assumed from its name:
 *   - `retrieve_context_limited`/`make_snippet` -> `db-host/retrieval.ts`
 *     (`retrieveContextLimited`/`makeSnippet`).
 *   - `embed_question` -> `retrievalBackfill.ts` (`embedQuestion`), which
 *     that file's own doc built specifically as the "producer" of
 *     `retrieveContext*`'s question-embedding input.
 *   - `duplicate_memory` -> `libraryTools.ts` (`duplicateMemory`); `db::
 *     add_memory` -> `db-host/memories.ts` (`addMemory`). `cmd_remember`
 *     calls the DB layer directly, bypassing `commands::library::add_memory`'s
 *     cap check — a deliberate Rust choice this port preserves (see
 *     `cmdRemember`'s own doc).
 *   - `db::get_file_full` -> `db-host/files.ts` (`getFileFull`);
 *     `build_annotation` -> `fileTools.ts` (`buildAnnotation`), EXPORTED by
 *     this batch (it was `agent.rs`-private in the Rust source's own module
 *     but is called from BOTH `agent.rs::annotate_file` and
 *     `chat_commands/knowledge.rs::cmd_highlight` there — one Rust function,
 *     two callers — so exporting the existing TS port is the one-function
 *     answer, not a second copy).
 *   - `parse_delim`/`serialize_delim` -> `editMatchCells.ts` (verbatim ports
 *     of the same `spreadsheet.rs` functions). `value_str` -> `jsonTools.ts`
 *     (`valueStr`).
 *   - `Artifact::new`/`note`/`by`/`during_run`/`from_files`/`cancel_with`/
 *     `commit` -> `artifactBuilder.ts`. `note_mime`/`html_note_name`/
 *     `title_from_name`/`html_titled_doc`/`refs_files`/`refs_context` ->
 *     `docsHtml.ts`, EXTENDED by this batch (see that file's own module doc)
 *     — `docs_html.rs`'s own prior port had scoped these five out by name as
 *     "other commands' territory"; this is that command.
 *   - `sidecar::sidecar_json_cancellable`/`SidecarError::sentinel` ->
 *     `sidecarJsonCancellable.ts`. `ollama::generate` -> `ollamaGenerate.ts`
 *     (`generate`) — that file's own module doc names
 *     `commands/chat_commands.rs:310,356` (i.e. `ask_quiet`/`ask_structured`)
 *     as a real, currently-unwired caller; {@link askQuiet} is that wiring.
 *   - `extraction::partition_windows`/`extraction::extension_of` ->
 *     `extractionWindow.ts` (`partitionWindows`/`byteLength`/`sliceUtf8`) /
 *     `editMatchExtraction.ts` (`extensionOf`).
 *
 * ONE ACCEPTED SIMPLIFICATION, not a fidelity gap: `knowledge.rs` calls the
 * NON-cancellable `sidecar::sidecar_json` at two sites (`#add-file`'s list
 * enumeration, `#extract`'s per-window field pass) and the cancellable
 * `sidecar_json_cancellable` at two others (`#add-file`'s per-item and
 * single-file document generation). `sidecarJsonCancellable.ts`'s own module
 * doc already made the call, for the whole migration, that the plain variant
 * is not worth a second HTTP client: "both Rust functions are collapsed into
 * this one, since nothing else in this port needs the non-cancellable
 * variant." Followed here exactly as `storyTools.ts` already follows it for
 * its own non-cancellable Rust call site — a FRESH, NEVER-SET `CancelFlag` at
 * the two non-cancellable sites (so a real Stop cannot abort that particular
 * network call, matching Rust's own behavior there), `ctx.cancel` itself at
 * the two cancellable sites.
 *
 * TWO NAMES THAT ARE BYTE COUNTS DESPITE THEIR NAME: `CMD_WINDOW_CHARS`/
 * `CMD_WINDOW_OVERLAP` are `chat_commands.rs`'s own constant names, but
 * `extraction::partition_windows` slices on `str::len()` — UTF-8 BYTES — so
 * {@link cmdWindows} is built on {@link byteLength}/`partitionWindows`/
 * `sliceUtf8`, never `.length`/`.slice()` (see `extractionWindow.ts`'s own
 * module doc on why: a JS string index is a UTF-16 code unit, not a byte, and
 * would produce different windows for any file with so much as one accented
 * or Hebrew character).
 *
 * `save_and_open` (`docs_html.rs`) is ported HERE, not added to `docsHtml.ts`
 * alongside its other four siblings: `artifactBuilder.ts` already imports
 * `docsHtml.ts` for `noteMime` (added by the concurrent
 * `chat_commands/generate.rs` batch), so `docsHtml.ts` importing
 * `Artifact`/`Written` the other way would make the two files a cycle. This
 * file may safely depend on both, so it is the natural home instead.
 */

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
import { makeSnippet, retrieveContextLimited, type ScoredChunk } from "./db-host/retrieval.js";
import { resolvedBaseUrl, stripThinkSpans } from "./engineRouting.js";
import { extensionOf } from "./editMatchExtraction.js";
import { parseDelim, serializeDelim } from "./editMatchCells.js";
import { byteLength, partitionWindows, sliceUtf8 } from "./extractionWindow.js";
import { createToolEffects, type ToolEffects } from "./execTool.js";
import { buildAnnotation } from "./fileTools.js";
import { valueStr } from "./jsonTools.js";
import type { RoomHandle, RoomSource } from "./jobs.js";
import { duplicateMemory } from "./libraryTools.js";
import { generate as generateReal, type GenerateOpts } from "./ollamaGenerate.js";
import { embedQuestion } from "./retrievalBackfill.js";
import type { SidecarChatMessage } from "./sidecar.js";
import { sidecarErrorSentinel, sidecarJsonCancellable } from "./sidecarJsonCancellable.js";
import { TurnId, type EventSender } from "./turn.js";

export type { ScoredChunk };

// ============================================================================
// room access + best-effort emit — following this port's established RoomSource
// (`jobs.ts`) / EmitFn (`filePass.ts`) conventions rather than inventing a
// third shape.
// ============================================================================

const NO_ROOM_OPEN = "No room is open.";

function requireRoom(rooms: RoomSource): RoomHandle {
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

function emitSafely(emit: EmitFn | undefined, event: string, payload: unknown): void {
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
async function commitArtifact(room: RoomHandle, art: Artifact): Promise<Written> {
  return room.workspace === undefined ? art.commit(room.db) : art.commitToWorkspace(room.workspace);
}

async function saveAndOpen(
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
function step(ctx: CmdCtx, label: string): void {
  ctx.turn.step(ctx.send, label);
}

/** Record that one window of the source could not be read. */
function noteUnread(ctx: CmdCtx): void {
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
const KEEP_ALIVE_WARM = "30m";

/** Thrown internally by {@link withTimeout} on expiry; never escapes
 * {@link askQuiet}, which turns it into the same actionable message
 * `chat_commands.rs`'s `tokio::time::timeout` branch returns. */
class StepTimedOut extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
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
      }
    );
  });
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
  temp: number | null
): Promise<string> {
  const gen = ctx.generate ?? generateReal;
  const timeoutMs = ctx.stepTimeoutMs ?? COMMAND_STEP_TIMEOUT_MS;
  const messages: SidecarChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const opts: GenerateOpts = { cancel: ctx.cancel };
  let text: string;
  try {
    text = await withTimeout(gen(ctx.model, messages, temp, KEEP_ALIVE_WARM, opts), timeoutMs);
  } catch (err) {
    if (err instanceof StepTimedOut) {
      throw new Error(
        "The model took too long to respond. Try a shorter selection, or switch to a faster model in Settings."
      );
    }
    throw err;
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
  return partitionWindows(trimmed, CMD_WINDOW_CHARS, CMD_WINDOW_OVERLAP).map(([s, e]) => {
    const piece = sliceUtf8(trimmed, s, e);
    // `partitionWindows` only ever returns spans it computed against
    // `trimmed` itself, so an out-of-range slice cannot happen here — matches
    // Rust's infallible `text[s..e]` indexing.
    if (piece === null) {
      throw new Error("cmdWindows: window span out of range");
    }
    return piece;
  });
}

/** `chat_commands.rs::FOLD_MAX_ROUNDS` — a guard against a fold that never
 * shrinks, not a coverage cap: every round already saw the whole source. */
const FOLD_MAX_ROUNDS = 6;

/** `chat_commands.rs::NOTE_SYS` — verbatim. */
const NOTE_SYS =
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
async function mapWindows(
  ctx: CmdCtx,
  source: string,
  label: string,
  system: string,
  userFor: (w: string) => string,
  temp: number | null
): Promise<string[]> {
  const windows = cmdWindows(source);
  const total = windows.length;
  const out: string[] = [];
  for (let i = 0; i < windows.length; i++) {
    if (ctx.cancel.load()) {
      break;
    }
    if (total > 1) {
      step(ctx, `${label} (${i + 1}/${total})`);
    }
    let piece: string | null = null;
    try {
      const got = await askQuiet(ctx, system, userFor(windows[i] as string), temp);
      if (got.trim() !== "") {
        piece = got.trim();
      }
    } catch {
      piece = null;
    }
    if (piece !== null) {
      out.push(piece);
    } else {
      noteUnread(ctx);
    }
  }
  return out;
}

/**
 * `chat_commands.rs::CmdCtx::fold_notes` — the REDUCE half: fold notes down to
 * something one call can hold, by re-folding while they are still too big.
 * Every round has already seen the whole source, so this loses detail, never
 * coverage. Ported verbatim.
 */
async function foldNotes(ctx: CmdCtx, notes: readonly string[], label: string): Promise<string> {
  let text = notes.join("\n\n");
  for (let round = 0; round < FOLD_MAX_ROUNDS; round++) {
    if (byteLength(text) <= CMD_WINDOW_CHARS || ctx.cancel.load()) {
      break;
    }
    const before = byteLength(text);
    const roundOut = await mapWindows(ctx, text, label, NOTE_SYS, (w) => `Notes:\n${w}`, 0.2);
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
export async function digest(ctx: CmdCtx, text: string, label: string): Promise<string> {
  if (byteLength(text) <= CMD_WINDOW_CHARS) {
    return text;
  }
  const notes = await mapWindows(ctx, text, label, NOTE_SYS, (w) => `Part of the source:\n${w}`, 0.2);
  return foldNotes(ctx, notes, label);
}

// ============================================================================
// JSON-response helpers — own-property reads only (rule 2: never index a
// parsed, model-influenced JSON value with a bare `[key]`).
// ============================================================================

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function ownValue(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/** `v["text"].as_str().unwrap_or_default()` — the `/generate_doc` response
 * body, or `""` for a missing/non-string field. */
function textFromGenerateDoc(v: unknown): string {
  if (!isRecord(v)) {
    return "";
  }
  const t = ownValue(v, "text");
  return typeof t === "string" ? t : "";
}

/** `v["items"].as_array().map(|a| a.iter().filter_map(as_str))
 * .unwrap_or_default()` — the `/knowledge_extract` mode:list response. */
function itemsFromKnowledgeExtract(v: unknown): string[] {
  if (!isRecord(v)) {
    return [];
  }
  const arr = ownValue(v, "items");
  if (!Array.isArray(arr)) {
    return [];
  }
  return arr.filter((x): x is string => typeof x === "string");
}

/** `v["values"].clone()` — the `/knowledge_extract` mode:fields response's
 * `values` object, or `null` when absent/malformed (which {@link valueStr}
 * already reads as "every field missing"). */
function valuesFromKnowledgeExtract(v: unknown): unknown {
  if (!isRecord(v)) {
    return null;
  }
  const values = ownValue(v, "values");
  return values === undefined ? null : values;
}

// ============================================================================
// #remember
// ============================================================================

/** What a command produces: a chat message plus optional viewer effects.
 * Ported from `chat_commands.rs::CommandResult` — `effects` is never
 * `Option`, matching Rust's `#[derive(Default)]` struct field (always a real,
 * all-empty {@link ToolEffects} when a command sets nothing). */
export interface CommandResult {
  content: string;
  sources: string[];
  effects: ToolEffects;
}

/**
 * `#remember <fact>` — save a fact to the room's permanent memory. Ported
 * verbatim from `cmd_remember`.
 *
 * Calls the DB layer's {@link addMemory} directly, NOT `library.ts`'s UI/tool
 * wrapper — Rust's own `cmd_remember` calls `db::add_memory` directly too,
 * bypassing `commands::library::add_memory`'s length cap. Deliberate, per the
 * Rust source's own comment: "a fact worth remembering isn't worth silently
 * cutting at 500 characters. (Settings -> Memory still applies its own editor
 * limit.)" `duplicateMemory` (the UX-5 exact-duplicate check) still applies —
 * only the CAP is skipped.
 */
export async function cmdRemember(ctx: CmdCtx): Promise<CommandResult> {
  const fact = ctx.args.trim();
  if (fact === "") {
    throw new Error("Usage: #remember <fact>");
  }
  const room = requireRoom(ctx.rooms);
  if (duplicateMemory(room.db, fact) !== null) {
    return { content: "That's already in this room's memory.", sources: [], effects: createToolEffects() };
  }
  addMemory(room.db, fact, null);
  return { content: `Saved to memory:\n\n> ${fact}`, sources: [], effects: createToolEffects() };
}

// ============================================================================
// #find
// ============================================================================

/** `chat_commands/knowledge.rs::MAX_FIND_MATCHES` — see that file's own doc:
 * `#find` asks for EVERY match on purpose (it is a result list, not prompt
 * context), but an embedded room can answer a common word with hundreds of
 * chunks, each copied whole into one chat message. The rest is COUNTED, not
 * silently dropped. */
export const MAX_FIND_MATCHES = 50;

/** `find_body` — the match list `#find` prints, and what it says about the
 * matches it left out. Ported verbatim. Exported for direct testing — see
 * {@link capFanOut}'s own note on why. */
export function findBody(query: string, chunks: readonly ScoredChunk[]): string {
  let body = `Matches for **${query}** (${chunks.length}):\n\n`;
  for (const c of chunks.slice(0, MAX_FIND_MATCHES)) {
    const snippet = makeSnippet(c.text, query, 140);
    body += `- **${c.fileName}** — ${snippet}\n`;
  }
  const rest = chunks.length - MAX_FIND_MATCHES;
  if (rest > 0) {
    body += `\n…and ${rest} more — narrow the search to see them.\n`;
  }
  body += "\n_Click a file below to open it._";
  return body;
}

/**
 * `#find <keywords>` — search the room's files for content and list every
 * match (not the six chunks a prompt call could afford). Ported verbatim from
 * `cmd_find`.
 */
export async function cmdFind(ctx: CmdCtx): Promise<CommandResult> {
  const query = ctx.args.trim();
  if (query === "") {
    throw new Error("Usage: #find <keywords>");
  }
  const emb = await embedQuestion(query);
  const room = requireRoom(ctx.rooms);
  const [chunks, fallback] = retrieveContextLimited(room.db, query, emb, new Set<number>(), null);
  if (fallback || chunks.length === 0) {
    return { content: `No matches found for **${query}**.`, sources: [], effects: createToolEffects() };
  }
  // The chips name the files whose matches are actually ON SCREEN: a chip for
  // a match the list didn't print is an invitation to look for something that
  // isn't there.
  const sources: string[] = [];
  for (const c of chunks.slice(0, MAX_FIND_MATCHES)) {
    if (!sources.includes(c.fileName)) {
      sources.push(c.fileName);
    }
  }
  return { content: findBody(query, chunks), sources, effects: createToolEffects() };
}

// ============================================================================
// #add-file
// ============================================================================

/** `chat_commands/knowledge.rs::MAX_FAN_OUT_FILES` — see that file's own doc:
 * `#add-file for each …` has no preview and no undo, so an unbounded list (a
 * pasted table, a CSV) filled the room. */
export const MAX_FAN_OUT_FILES = 25;

/** `cap_fan_out` — the fan-out list, cut to {@link MAX_FAN_OUT_FILES}, plus
 * HOW MANY were left out. Ported verbatim. Exported (unlike Rust's private
 * `cap_fan_out`) purely so this module's own test suite can exercise the cut
 * directly, the same access Rust's `#[cfg(test)] mod tests { use super::*; }`
 * gets for free — see `filePass.ts`'s `loadArtifact`/`storeArtifact` for the
 * identical, already-established convention. */
export function capFanOut(items: readonly string[]): [string[], number] {
  const over = Math.max(0, items.length - MAX_FAN_OUT_FILES);
  return [items.slice(0, MAX_FAN_OUT_FILES), over];
}

/**
 * `#add-file <name>: <topic>` or `#add-file for each <thing>` — write a new
 * note/document, or one per item enumerated from the conversation. Ported
 * verbatim from `cmd_add_file`.
 */
export async function cmdAddFile(ctx: CmdCtx): Promise<CommandResult> {
  const a = ctx.args.trim();
  if (a === "") {
    throw new Error("Usage: #add-file <name>: <topic>   (or)   #add-file for each <thing>");
  }

  // Fan-out: "#add-file for each <thing>" -> enumerate from the conversation,
  // then generate + save one file per item.
  //
  // `.toLowerCase()` on `a` is searched for "for each", then the ORIGINAL `a`
  // is sliced at that same index — safe as long as case-folding does not
  // change string length ahead of the match, which it does not for any
  // realistic command line (this mirrors the Rust source's own `lower.find`
  // + `a[pos..]` byte-offset reuse, which carries the identical assumption).
  const lower = a.toLowerCase();
  const pos = lower.indexOf("for each");
  if (pos !== -1) {
    const subject = a
      .slice(pos + "for each".length)
      .trim()
      .replace(/^:+/, "")
      .trim();
    // Full ops: reduce the conversation ONCE, up front, rather than attaching
    // it whole to the enumeration call and then again to every per-file call.
    const history = await digest(ctx, ctx.history, "Reading the conversation");
    // MIGRATION Phase 3: the prompt, schema and list-parsing live in the
    // sidecar's `/knowledge_extract` mode:list. A FRESH, never-set CancelFlag
    // — this call site is Rust's non-cancellable `sidecar_json`; see this
    // module's own doc.
    const listReq = {
      model: ctx.model,
      base_url: resolvedBaseUrl(),
      mode: "list",
      subject,
      conversation: history,
      temperature: 0.0,
      keep_alive: KEEP_ALIVE_WARM,
    };
    const listOutcome = await sidecarJsonCancellable("/knowledge_extract", listReq, new CancelFlag());
    if (listOutcome.kind === "error") {
      throw new Error(sidecarErrorSentinel(listOutcome.error, ctx.model));
    }
    const items = listOutcome.kind === "value" ? itemsFromKnowledgeExtract(listOutcome.value) : [];
    if (items.length === 0) {
      throw new Error(
        "Couldn't find a list to iterate over in this chat. Name the items explicitly, " +
          "e.g. #add-file for each: AAPL, MSFT, NVDA."
      );
    }
    const [capped, over] = capFanOut(items);
    const created: string[] = [];
    for (let i = 0; i < capped.length; i++) {
      if (ctx.cancel.load()) {
        break;
      }
      const item = capped[i] as string;
      step(ctx, `Creating file for ${item} (${i + 1}/${capped.length})`);
      // MIGRATION Phase 3: the DOC_SYS body generation lives in the
      // sidecar's `/generate_doc` mode:each. Cancellation is Rust-side: an
      // error/stop -> empty -> skip, matching the old
      // `ask_quiet(...).unwrap_or_default()`.
      const eachReq = {
        model: ctx.model,
        base_url: resolvedBaseUrl(),
        mode: "each",
        item,
        history,
        temperature: 0.4,
        keep_alive: KEEP_ALIVE_WARM,
      };
      const outcome = await sidecarJsonCancellable("/generate_doc", eachReq, ctx.cancel);
      const body = outcome.kind === "value" ? textFromGenerateDoc(outcome.value) : "";
      if (body.trim() === "") {
        continue;
      }
      const name = htmlNoteName(item);
      const doc = htmlTitledDoc(name, item, body);
      const room = ctx.rooms.current();
      if (room === null) {
        break;
      }
      // ART-1: `created` only ever names files that really landed — a staged
      // write that failed validation or lost a cancel race adds nothing.
      try {
        const artifact = Artifact.note(name, doc)
          .by("#add-file")
          .duringRun(ctx.turn.runId)
          .cancelWith(ctx.cancel);
        const written = await commitArtifact(room, artifact);
        created.push(written.meta.name);
      } catch {
        // Swallowed — matches Rust's `if let Ok(w) = ... { created.push(...) }`.
      }
    }
    emitSafely(ctx.emit, "room-files-changed", undefined);
    if (created.length === 0) {
      throw new Error("Couldn't create any files — the model returned nothing.");
    }
    const list = created.map((n) => `- ${n}`).join("\n");
    const cappedNote =
      over > 0
        ? `\n\nStopped at ${MAX_FAN_OUT_FILES} files — ${over} more were named. ` +
          "Ask again naming the ones you still want."
        : "";
    return {
      content:
        `Created ${created.length} file(s):\n${list}${cappedNote}\n\n` +
        "_Delete any you don't want from the Files list._",
      sources: created,
      effects: createToolEffects(),
    };
  }

  // Single file: optional "name: topic".
  const colonIdx = a.indexOf(":");
  let nameHint: string | null = null;
  let topic: string = a;
  if (colonIdx !== -1) {
    const n = a.slice(0, colonIdx);
    const t = a.slice(colonIdx + 1);
    const wordCount = n.split(/\s+/u).filter((w) => w !== "").length;
    if (t.trim() !== "" && wordCount <= 8) {
      nameHint = n.trim();
      topic = t.trim();
    }
  }
  // Whole pinned files as the brief; digested (not clamped) if they outgrow
  // one call, so a document written "from @source.pdf" reflects all of it.
  const refRoom = requireRoom(ctx.rooms);
  const [refctxRaw] = refsContext(refRoom.db, ctx.refs);
  const refctx = await digest(ctx, refctxRaw, "Reading the pinned files");
  // MIGRATION Phase 3: the DOC_SYS body generation lives in the sidecar's
  // `/generate_doc` mode:single.
  const singleReq = {
    model: ctx.model,
    base_url: resolvedBaseUrl(),
    mode: "single",
    topic,
    context: refctx,
    temperature: 0.4,
    keep_alive: KEEP_ALIVE_WARM,
  };
  const outcome = await sidecarJsonCancellable("/generate_doc", singleReq, ctx.cancel);
  let body: string;
  if (outcome.kind === "value") {
    body = textFromGenerateDoc(outcome.value);
  } else if (outcome.kind === "stopped") {
    body = "";
  } else {
    throw new Error(sidecarErrorSentinel(outcome.error, ctx.model));
  }
  if (body.trim() === "") {
    throw new Error("The model returned nothing — try rephrasing the topic.");
  }
  // ADD-22: default to HTML unless the user named an explicit extension.
  const name =
    nameHint !== null ? (extensionOf(nameHint) !== "" ? nameHint : `${nameHint}.html`) : htmlNoteName(topic);
  const doc = htmlTitledDoc(name, titleFromName(name), body);
  // ART-1: staged, cancel-checked at the write, and versioned when the same
  // document is asked for twice.
  const written = await saveAndOpen(
    ctx.rooms,
    ctx.emit,
    Artifact.new(name, noteMime(name), doc).by("#add-file").duringRun(ctx.turn.runId).fromFiles(ctx.refs).cancelWith(ctx.cancel)
  );
  const meta = written.meta;
  return {
    content: written.versioned
      ? `Rewrote **${meta.name}** and opened it — the previous version is in History.`
      : `Created **${meta.name}** and opened it.`,
    sources: [meta.name],
    effects: createToolEffects(),
  };
}

// ============================================================================
// #highlight
// ============================================================================

/** `chat_commands/knowledge.rs::QUOTE_SYS` — verbatim. */
const QUOTE_SYS =
  "You locate an exact passage. Output ONLY the shortest verbatim quote from the " +
  "document that best matches the request — copied character-for-character, with no " +
  "quotation marks around it and no other words. If this part of the document does not " +
  "contain the requested thing, output nothing at all.";

/** Repeatedly strip a trailing literal suffix — Rust's
 * `str::trim_end_matches(pat)`, which removes the pattern from the end AS
 * MANY TIMES as it matches, not just once. */
function stripTrailingRepeated(s: string, suffix: string): string {
  let out = s;
  while (out.endsWith(suffix)) {
    out = out.slice(0, out.length - suffix.length);
  }
  return out;
}

/** Repeatedly strip a leading/trailing literal CHARACTER from both ends —
 * Rust's `str::trim_matches(char)`. */
function trimMatchesChar(s: string, ch: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === ch) {
    start += 1;
  }
  while (end > start && s[end - 1] === ch) {
    end -= 1;
  }
  return s.slice(start, end);
}

/**
 * `#highlight <thing> in @file` — mark an exact passage in a file so it shows
 * in the viewer. Reads the WHOLE document, one window at a time, stopping at
 * the first window that yields a quote the file actually contains. Ported
 * verbatim from `cmd_highlight`.
 */
export async function cmdHighlight(ctx: CmdCtx): Promise<CommandResult> {
  const fileId = ctx.refs[0];
  if (fileId === undefined) {
    throw new Error("Add a file with @ — e.g. #highlight the total in @invoice.pdf");
  }
  let thing = ctx.args.trim();
  thing = stripTrailingRepeated(thing, " in");
  thing = stripTrailingRepeated(thing, " on");
  thing = thing.trim();
  if (thing === "") {
    throw new Error("Say what to highlight — e.g. #highlight the signature in @contract.pdf");
  }

  const room = requireRoom(ctx.rooms);
  const [realName, , , text] = getFileFull(room.db, fileId);
  const extracted = text ?? "";
  if (extracted.trim() === "") {
    throw new Error(`"${realName}" has no readable text to highlight.`);
  }

  const windows = cmdWindows(extracted);
  const total = windows.length;
  let found: { payload: Record<string, unknown>; described: string } | null = null;
  for (let i = 0; i < windows.length; i++) {
    if (ctx.cancel.load()) {
      break;
    }
    const w = windows[i] as string;
    if (total > 1) {
      step(ctx, `Looking for it (${i + 1}/${total})`);
    }
    let quote: string;
    try {
      quote = await askQuiet(ctx, QUOTE_SYS, `Request: ${thing}\n\nDocument:\n${w}`, 0.0);
    } catch {
      noteUnread(ctx);
      continue;
    }
    quote = trimMatchesChar(quote.trim(), '"').trim();
    if (quote === "") {
      continue;
    }
    // The annotation is built against the FULL text, so a quote found in a
    // later window still resolves to its real position in the file.
    const built = buildAnnotation(fileId, realName, extracted, quote, "", null, null, null);
    if (built.ok) {
      found = { payload: built.payload, described: built.described };
      break;
    }
  }

  if (found === null) {
    throw new Error(`Couldn't find an exact passage for "${thing}" in ${realName}.`);
  }
  emitSafely(ctx.emit, "agent-annotate", found.payload);
  const effects = createToolEffects();
  effects.annotation = found.payload;
  return {
    content: `Highlighted ${found.described} in **${realName}**.`,
    sources: [realName],
    effects,
  };
}

// ============================================================================
// #extract
// ============================================================================

/**
 * Deterministic column extraction for a CSV/TSV file: if EVERY requested
 * field names a column header (case-insensitively), return one output row per
 * data row holding just those columns — no model call at all. `null` for a
 * non-tabular file, or when any requested field doesn't match a header, so
 * the caller falls back to the model-based scalar path. Ported verbatim from
 * `tabular_field_rows`. Exported for direct testing — see {@link capFanOut}'s
 * own note on why.
 */
export function tabularFieldRows(name: string, text: string, fields: readonly string[]): string[][] | null {
  const ext = extensionOf(name);
  const delim = ext === "csv" ? "," : ext === "tsv" ? "\t" : null;
  if (delim === null) {
    return null;
  }
  const table = parseDelim(text, delim);
  const header = table[0];
  if (header === undefined) {
    return null;
  }
  const norm = (s: string): string => s.trim().toLowerCase();
  const cols: number[] = [];
  for (const f of fields) {
    const idx = header.findIndex((h) => norm(h) === norm(f));
    if (idx === -1) {
      return null;
    }
    cols.push(idx);
  }
  const rows: string[][] = [];
  for (const r of table.slice(1)) {
    if (!r.some((c) => c.trim() !== "")) {
      continue;
    }
    rows.push(cols.map((c) => r[c] ?? ""));
  }
  return rows;
}

/**
 * Strip the trailing "from"/"in"/"of" the UI leaves behind after removing the
 * @tokens — but only as a WHOLE WORD (a field merely ENDING in those letters,
 * "gross margin", "country of origin", "burden of proof", keeps them). Ported
 * verbatim from `strip_trailing_preposition`. Exported for direct testing —
 * see {@link capFanOut}'s own note on why.
 */
export function stripTrailingPreposition(args: string): string {
  const s = args.replace(/\s+$/, "");
  for (const word of ["from", "in", "of"]) {
    if (s.endsWith(word)) {
      const rest = s.slice(0, s.length - word.length);
      if (rest === "" || /\s$/.test(rest)) {
        return rest.replace(/\s+$/, "");
      }
    }
  }
  return s;
}

/** Parse the field-list portion of `#extract … from @file`.
 *
 * The composer normally removes @-reference tokens before dispatch, but a
 * multi-folder reference can leave its display filename behind. Only treat a
 * standalone `from` as the source-clause delimiter when the remaining text
 * actually looks like a reference (an @ token, path, or filename extension).
 * This keeps ordinary fields such as “revenue from subscriptions” intact. */
export function extractFieldNames(args: string): string[] {
  const withoutTrailing = stripTrailingPreposition(args.trim());
  const fromClauses = [...withoutTrailing.matchAll(/\s+from\s+/giu)];
  const sourceClause = fromClauses.find((match) => {
    const residue = withoutTrailing.slice((match.index ?? 0) + match[0].length).trim();
    return /(?:^|\s)@\S+/u.test(residue) ||
      /[/\\]/u.test(residue) ||
      /\.[a-z0-9]{1,12}["']?(?:\s|$)/iu.test(residue);
  });
  const fieldList = sourceClause === undefined
    ? withoutTrailing
    : withoutTrailing.slice(0, sourceClause.index).trimEnd();
  return fieldList
    .split(",")
    .map((field) => field.trim())
    .filter((field) => field !== "");
}

/**
 * `#extract <field, field…> from @a @b` — pull the same fields out of several
 * files into a spreadsheet. Reads each file whole, window by window, keeping
 * the first real value found for each field and stopping once every field is
 * answered. Ported verbatim from `cmd_extract`.
 */
export async function cmdExtract(ctx: CmdCtx): Promise<CommandResult> {
  if (ctx.refs.length === 0) {
    throw new Error("Add files with @ — e.g. #extract revenue, CEO from @a.pdf @b.pdf");
  }
  const fields = extractFieldNames(ctx.args);
  if (fields.length === 0) {
    throw new Error("Say which fields to extract — e.g. #extract revenue, CEO from @a @b");
  }
  const room = requireRoom(ctx.rooms);
  const files = refsFiles(room.db, ctx.refs);
  const rows: string[][] = [["File", ...fields]];

  for (let i = 0; i < files.length; i++) {
    if (ctx.cancel.load()) {
      break;
    }
    const [name, text] = files[i] as [string, string];
    step(ctx, `Reading ${name} (${i + 1}/${files.length})`);

    // A CSV/TSV whose columns match the requested fields is read directly —
    // exact, instant, per-row, and model-free.
    const dataRows = tabularFieldRows(name, text, fields);
    if (dataRows !== null) {
      for (const dataRow of dataRows) {
        rows.push([name, ...dataRow]);
      }
      continue;
    }

    // Full ops: read the whole file, window by window, keeping the first
    // real value found for each field and stopping as soon as every field is
    // answered.
    const windows = cmdWindows(text);
    const total = windows.length;
    const found = new Map<string, string>();
    for (let wi = 0; wi < windows.length; wi++) {
      if (ctx.cancel.load() || found.size === fields.length) {
        break;
      }
      const doc = windows[wi] as string;
      if (total > 1) {
        step(ctx, `Reading ${name} — part ${wi + 1}/${total} (${i + 1}/${files.length})`);
      }
      // Only ask for what is still missing, so later windows get a smaller,
      // sharper question instead of re-deriving what page 1 already gave.
      const missing = fields.filter((f) => !found.has(f));
      // MIGRATION Phase 3: the per-field schema, prompt, structured call and
      // "(not found)" defaulting live in the sidecar's `/knowledge_extract`
      // mode:fields. A FRESH, never-set CancelFlag — this call site is
      // Rust's non-cancellable `sidecar_json`; see this module's own doc.
      const req = {
        model: ctx.model,
        base_url: resolvedBaseUrl(),
        mode: "fields",
        fields: missing,
        document: doc,
        temperature: 0.0,
        keep_alive: KEEP_ALIVE_WARM,
      };
      const outcome = await sidecarJsonCancellable("/knowledge_extract", req, new CancelFlag());
      let values: unknown;
      if (outcome.kind === "value") {
        values = valuesFromKnowledgeExtract(outcome.value);
      } else {
        // This window went unread — a field it held reads as "(not found)"
        // unless a later window has it.
        noteUnread(ctx);
        values = null;
      }
      for (const f of missing) {
        const val = valueStr(values, f).trim();
        if (val !== "" && val.toLowerCase() !== "(not found)") {
          found.set(f, val);
        }
      }
    }
    const row = [name];
    for (const f of fields) {
      row.push(found.get(f) ?? "(not found)");
    }
    rows.push(row);
  }

  const csv = serializeDelim(rows, ",");
  const written = await saveAndOpen(
    ctx.rooms,
    ctx.emit,
    Artifact.new("extract.csv", noteMime("extract.csv"), csv)
      .by("#extract")
      .duringRun(ctx.turn.runId)
      .fromFiles(ctx.refs)
      .cancelWith(ctx.cancel)
  );
  const meta = written.meta;
  return {
    content: `Extracted ${fields.length} field(s) from ${files.length} file(s) into **${meta.name}**.`,
    sources: [meta.name],
    effects: createToolEffects(),
  };
}
