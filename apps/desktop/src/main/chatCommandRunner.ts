import { CancelFlag, forget, type CancelState } from "./cancel.js";
import { getSetting } from "./db-host/settings.js";
import { insertMessage, insertTurnErrorMessage, recentMessages } from "./db-host/messages.js";
import { setChatTitleIfNew } from "./db-host/chats.js";
import { listModels as listModelsReal } from "./engineRouting.js";
import { bestLocalDefault } from "./ollamaModels.js";
import { generate as generateReal, chatStructured as chatStructuredReal } from "./ollamaGenerate.js";
import { createRoomCheckpoint } from "./roomCheckpoints.js";
import type { RoomManagerState } from "./roomManager.js";
import { TurnId, type EventSender } from "./turn.js";
import { createToolEffects, effectsJson, type ToolEffects } from "./execTool.js";
import { modelSetting, parseTemperature } from "./gatherContext.js";
import { persistAssistantReply, type TurnRoomSource } from "./turnEngine.js";
import type { Message } from "./db-host/messages.js";
import type { RoomSource } from "./jobs.js";
import { cmdAddFile, cmdExtract, cmdFind, cmdHighlight, cmdRemember, type EmitFn, type UnreadCounter } from "./chatCommandsKnowledge.js";
import { cmdCompare, cmdMinutes, cmdResearch, cmdSketch, cmdSummarize, cmdToSheet, cmdTranscribe, cmdTranslate, generateStream, type CmdCtx as CommandBodyCtx, type LayoutGraphFn, type TranscribeAudioFn } from "./chatCommandsGenerate.js";
import { CHAT_COMMANDS, formatHistory } from "./chatCommands.js";



// ============================================================================
// CmdCtx — everything a command workflow needs. Ported from `CmdCtx<'a>`.
// ============================================================================

/** The engine-calling seams the command bodies (`chatCommandsKnowledge.ts`/
 * `chatCommandsGenerate.ts`) read straight off `ctx` as plain data — see the
 * module doc. Every field defaults to the real, already-ported
 * implementation when the caller omits it. */
export interface CmdCtxDeps {
  generate?: typeof generateReal;
  chatStructured?: typeof chatStructuredReal;
  /** Forwarded verbatim to the command bodies' own seams — see
   * {@link CommandBodyCtx}. */
  generateStream?: typeof generateStream;
  transcribeAudio?: TranscribeAudioFn;
  layoutGraph?: LayoutGraphFn;
  stepTimeoutMs?: number;
}


/** Constructor parameters for {@link CmdCtx} — field-for-field the Rust
 * struct's own fields, plus {@link CmdCtxOpts.send}/{@link CmdCtxOpts.room}
 * (Rust's `window`/`state`) and the injectable engine deps above. */
export interface CmdCtxOpts extends CmdCtxDeps {
  model: string;
  /** @-pinned file ids (resolved in the UI before send). */
  refs: readonly string[];
  /** Text after the command word, with @tokens already stripped by the UI. */
  args: string;
  /** Prior conversation as plain text (oldest-first) — see {@link formatHistory}. */
  history: string;
  temperature: number | null;
  cancel: CancelFlag;
  /** Owner replacement #4: the run/chat this command's events belong to. */
  turn: TurnId;
  send: EventSender;
  /** `state.room` as the turn layer sees it. {@link CmdCtx.rooms} — the shape
   * the thirteen command bodies actually read — is derived from this when not
   * passed explicitly; both are views onto Rust's ONE `state.room` mutex. */
  room: TurnRoomSource;
  /** `jobs.ts`'s `RoomSource` view of the same open room. Optional: derived
   * from {@link CmdCtxOpts.room} when omitted. */
  rooms?: RoomSource;
  /** Rust's bare `ctx.window.emit(...)` — the RAW, non-turn-enveloped events
   * (`room-files-changed`, `agent-open-file`, `agent-annotate`) the command
   * bodies fire. Defaults to {@link CmdCtxOpts.send} itself, which is exactly
   * what Rust's single `window` handle is for both kinds of event. */
  emit?: EmitFn;
}


/**
 * Everything a command workflow needs. Ported from `CmdCtx<'a>`'s FIELDS —
 * not its `impl CmdCtx` methods (`ask_quiet`/`ask_streaming`/`ask_structured`/
 * `map_windows`/`fold_notes`/`digest`/`cancelled`/`step`/`note_unread`):
 * those are real here too, but as the FREE FUNCTIONS
 * `chatCommandsKnowledge.ts`/`chatCommandsGenerate.ts` already own (every
 * `cmd_*` body calls `digest(ctx, ...)`, never `ctx.digest(...)`) — see the
 * module doc. A class rather than a plain object literal only because
 * {@link unreadCount} needs somewhere to live and `unread` is real
 * per-instance mutable state one caller mutates and another reads (`cancel.
 * ts`'s `Node`/`CancelFlag` is this port's precedent for that shape).
 *
 * `implements CommandBodyCtx` IS THE CONNECTION, and is deliberately checked
 * by the compiler rather than asserted in a comment: Rust's `run_command`
 * hands ONE `&CmdCtx` to `cmd_remember`/`cmd_summarize`/… and the port must
 * do the same. Before this was declared, the dispatcher's context and the
 * thirteen command bodies' context were two structurally incompatible types
 * — `handlers: { remember: cmdRemember }` did not even typecheck — so the
 * whole `#command` feature was inert end to end. Any future field the bodies
 * start reading now breaks THIS line at build time instead of at runtime.
 */
export class CmdCtx implements CommandBodyCtx {
  readonly model: string;
  readonly refs: readonly string[];
  readonly args: string;
  readonly history: string;
  readonly temperature: number | null;
  readonly turn: TurnId;
  readonly room: TurnRoomSource;
  readonly rooms: RoomSource;
  readonly cancel: CancelFlag;
  readonly send: EventSender;
  readonly emit: EmitFn;
  /** `AtomicUsize` — a shared counter object, not a private number, because
   * the command bodies increment it through `ctx.unread.count` (Rust's
   * `ctx.note_unread()`) while {@link runCommand} reads it afterwards
   * (`ctx.unread.load(...)`). */
  readonly unread: UnreadCounter = { count: 0 };

  generate?: typeof generateReal;
  chatStructured?: typeof chatStructuredReal;
  generateStream?: typeof generateStream;
  transcribeAudio?: TranscribeAudioFn;
  layoutGraph?: LayoutGraphFn;
  stepTimeoutMs?: number;

  constructor(opts: CmdCtxOpts) {
    this.model = opts.model;
    this.refs = opts.refs;
    this.args = opts.args;
    this.history = opts.history;
    this.temperature = opts.temperature;
    this.turn = opts.turn;
    this.room = opts.room;
    this.rooms = opts.rooms ?? { current: () => opts.room.currentRoom() };
    this.cancel = opts.cancel;
    this.send = opts.send;
    this.emit = opts.emit ?? opts.send;
    this.assignGenerateDeps(opts);
    this.assignCommandDeps(opts);
  }

  private assignGenerateDeps(opts: CmdCtxOpts): void {
    if (opts.generate !== undefined) {
      this.generate = opts.generate;
    }
    if (opts.chatStructured !== undefined) {
      this.chatStructured = opts.chatStructured;
    }
    if (opts.generateStream !== undefined) {
      this.generateStream = opts.generateStream;
    }
  }

  private assignCommandDeps(opts: CmdCtxOpts): void {
    if (opts.transcribeAudio !== undefined) {
      this.transcribeAudio = opts.transcribeAudio;
    }
    if (opts.layoutGraph !== undefined) {
      this.layoutGraph = opts.layoutGraph;
    }
    if (opts.stepTimeoutMs !== undefined) {
      this.stepTimeoutMs = opts.stepTimeoutMs;
    }
  }

  /** How many windows of the source could not be read this run — read by
   * {@link runCommand} at the end, matching `ctx.unread.load(...)`. Every
   * `cmd_*` body increments {@link unread}'s `count` directly (the free
   * `noteUnread(ctx)` in `chatCommandsKnowledge.ts`), so this class needs no
   * mutating counterpart of its own. */
  unreadCount(): number {
    return this.unread.count;
  }
}


// ============================================================================
// The command dispatch table — Rust's `match command.as_str()` in run_command.
// ============================================================================

/** What produces exactly one `cmd_*` workflow's output. Ported from the shape
 * of `cmd_remember`/`cmd_find`/… — `async fn(&CmdCtx) -> Result<CommandResult, String>`. */
export type ChatCommandHandler = (ctx: CmdCtx) => Promise<CommandResult>;
export

/**
 * `run_command`'s dispatch `match`, as data. The thirteen model-driven
 * commands map to the REAL ported bodies in `chatCommandsKnowledge.ts`
 * (`knowledge.rs`) and `chatCommandsGenerate.ts` (`generate.rs`), exactly the
 * `mod knowledge; mod generate; pub(crate) use …::*;` call graph the Rust
 * dispatcher has. `"checkpoint"` is deliberately absent: `run_command`
 * short-circuits it inline before the model probe, so it never reaches the
 * match.
 *
 * `Object.create(null)` (rule 2): this is looked up by a name that arrives
 * over IPC. The catalog check in {@link runCommand} already rejects anything
 * not in {@link CHAT_COMMANDS} first, and {@link ownHandler} guards the read
 * as well — belt and braces, because a prototype-chain hit here would be a
 * FUNCTION the dispatcher then calls.
 */
const DEFAULT_HANDLERS: Readonly<Record<string, ChatCommandHandler>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, ChatCommandHandler>, {
    remember: cmdRemember,
    find: cmdFind,
    "add-file": cmdAddFile,
    highlight: cmdHighlight,
    extract: cmdExtract,
    summarize: cmdSummarize,
    compare: cmdCompare,
    transcribe: cmdTranscribe,
    minutes: cmdMinutes,
    sketch: cmdSketch,
    "to-sheet": cmdToSheet,
    translate: cmdTranslate,
    research: cmdResearch,
  })
);
export

/** An own-property-only read of a caller-supplied handler table — see
 * {@link DEFAULT_HANDLERS}'s note on rule 2. */
function ownHandler(
  table: Readonly<Partial<Record<string, ChatCommandHandler>>> | undefined,
  name: string
): ChatCommandHandler | undefined {
  if (table === undefined || !Object.prototype.hasOwnProperty.call(table, name)) {
    return undefined;
  }
  const fn = table[name];
  return typeof fn === "function" ? fn : undefined;
}
export function notImplementedReason(name: string): string {
  return (
    `NOT_IMPLEMENTED: #${name}'s command body ` +
    "(src-tauri/src/commands/chat_commands/{knowledge,generate}.rs) has no Electron port yet " +
    "— this dispatcher is real, the individual command workflow is not. Wire a real handler " +
    "into RunCommandDeps.handlers to close this gap."
  );
}


/** The labeled refusal a {@link CHAT_COMMANDS} entry with no handler at all
 * resolves through — never a fabricated "Done." Every one of the thirteen has
 * a real body wired in {@link DEFAULT_HANDLERS} today, so this only fires for
 * a catalog entry added without one (or for a caller that wires it here on
 * purpose, as the tests do). */
export function notImplementedChatCommandHandler(name: string): ChatCommandHandler {
  return async () => {
    throw new Error(notImplementedReason(name));
  };
}


// ============================================================================
// CommandResult
// ============================================================================

/** What a command produces: a chat message plus optional viewer effects.
 * Ported from `CommandResult`. */
export interface CommandResult {
  content: string;
  sources: string[];
  effects: ToolEffects;
}


/** `#[derive(Default)]` for {@link CommandResult}. */
export function defaultCommandResult(): CommandResult {
  return { content: "", sources: [], effects: createToolEffects() };
}


// ============================================================================
// runCommand
// ============================================================================

/** One `#command` invocation — field-for-field the Tauri command's own
 * parameters, minus `window`/`state` (which arrive via {@link RunCommandDeps}). */
export interface RunCommandRequest {
  askId: string;
  chatId: string;
  command: string;
  args: string;
  refs: readonly string[];
  raw: string;
}


/** Everything {@link runCommand} needs beyond the request itself. */
export interface RunCommandDeps {
  /** `state.room` — real DB reads/writes. See the module doc's "TWO PARTIAL
   * AppState SHAPES" section for why this and {@link checkpointState} are
   * separate objects that a production wiring must point at the same room. */
  room: TurnRoomSource;
  /** `state.cancels` (+ the tree `forget` on the way out) — `cancel.ts`'s own
   * registry, reused rather than re-declared, exactly as `turnEngine.ts`'s
   * `AskDeps.cancelState` does. See the module doc's "CANCEL REGISTRATION IS
   * FLAT" section for why this file does NOT call `registerRun`. */
  cancelState: CancelState;
  send: EventSender;
  /** `#checkpoint`'s real target — `roomCheckpoints.ts`'s `createRoomCheckpoint`
   * takes the full `RoomManagerState`, not the narrower `TurnRoomSource`. */
  checkpointState: RoomManagerState;
  /** Overridable for tests; defaults to `engineRouting.ts`'s real `listModels`. */
  listModels?: () => Promise<string[]>;
  /** Rust's bare `ctx.window.emit(...)` for the command bodies' RAW
   * (non-turn-enveloped) `room-files-changed`/`agent-open-file`/
   * `agent-annotate` events. Defaults to {@link RunCommandDeps.send}, which is
   * the same window handle Rust uses for both kinds of event. */
  emit?: EmitFn;
  /** Forwarded into every {@link CmdCtx} this run builds. */
  generate?: typeof generateReal;
  chatStructured?: typeof chatStructuredReal;
  generateStream?: typeof generateStream;
  transcribeAudio?: TranscribeAudioFn;
  layoutGraph?: LayoutGraphFn;
  stepTimeoutMs?: number;
  /** Per-command OVERRIDES of {@link DEFAULT_HANDLERS} (which already wires
   * all thirteen real `cmd_*` bodies), keyed by {@link ChatCommand.name}.
   * `"checkpoint"` is never looked up here — `runCommand` handles it inline,
   * exactly as Rust does. */
  handlers?: Readonly<Partial<Record<string, ChatCommandHandler>>>;
}
export

/**
 * Run a prebuilt "#name" workflow. Ported from `run_command`. Mirrors `ask`'s
 * cancel/save boilerplate but dispatches to a fixed pipeline instead of the
 * agent loop. Commands always use a LOCAL model (they make several small
 * calls; cloud would leak content and can't stream the pipeline).
 */
type OpenCommandRoom = NonNullable<ReturnType<TurnRoomSource["currentRoom"]>>;
export interface CommandStart {
  temperature: number | null;
  history: [string, string][];
  explicitModel: string | null;
}
export interface CommandPersistence {
  savedQuestionRoomPath: string | null;
}
export function assertKnownCommand(command: string): void {
  if (!CHAT_COMMANDS.some((c) => c.name === command)) {
    throw new Error(`Unknown command #${command}.`);
  }
}
export function commandRoom(deps: RunCommandDeps): OpenCommandRoom {
  const room = deps.room.currentRoom();
  if (room === null) {
    throw new Error("No room is open.");
  }
  return room;
}
export function commandTitle(raw: string): string {
  const characters = Array.from(raw);
  const suffix = characters.length > 48 ? "…" : "";
  return characters.slice(0, 48).join("") + suffix;
}
export function startCommand(req: RunCommandRequest, deps: RunCommandDeps, persistence: CommandPersistence): CommandStart {
  const room = commandRoom(deps);
  const temperature = parseTemperature(getSetting(room.db, "temperature"));
  const history = [...recentMessages(room.db, req.chatId, -1)].reverse();
  insertMessage(room.db, req.chatId, "user", req.raw, [], null);
  persistence.savedQuestionRoomPath = room.path;
  setChatTitleIfNew(room.db, req.chatId, commandTitle(req.raw));
  return { temperature, history, explicitModel: modelSetting(room.db) };
}
export async function checkpointCommand(req: RunCommandRequest, deps: RunCommandDeps): Promise<Message> {
  const meta = await createRoomCheckpoint(deps.checkpointState, req.args.trim());
  const content = `Saved checkpoint **${meta.name}**. Roll back to it in Settings → Checkpoints.`;
  return persistAssistantReply(deps.room, req.chatId, content, [], null);
}
export function selectedCommandModel(explicitModel: string | null, models: readonly string[]): string {
  if (explicitModel !== null) {
    return explicitModel;
  }
  if (models.length === 0) {
    throw new Error("No local AI model is installed yet — download one first.");
  }
  return bestLocalDefault(models);
}
export async function commandModel(deps: RunCommandDeps, explicitModel: string | null): Promise<string> {
  const models = await (deps.listModels ?? listModelsReal)();
  return selectedCommandModel(explicitModel, models);
}
export function commandContext(
  req: RunCommandRequest,
  deps: RunCommandDeps,
  start: CommandStart,
  cancel: CancelFlag,
  model: string
): CmdCtx {
  return new CmdCtx({
    model,
    refs: req.refs,
    args: req.args.trim(),
    history: formatHistory(start.history),
    temperature: start.temperature,
    cancel,
    turn: new TurnId(req.askId, req.chatId),
    room: deps.room,
    send: deps.send,
    emit: deps.emit ?? deps.send,
    generate: deps.generate,
    chatStructured: deps.chatStructured,
    generateStream: deps.generateStream,
    transcribeAudio: deps.transcribeAudio,
    layoutGraph: deps.layoutGraph,
    stepTimeoutMs: deps.stepTimeoutMs,
  });
}
export function commandHandler(deps: RunCommandDeps, command: string): ChatCommandHandler {
  return (
    ownHandler(deps.handlers, command) ??
    ownHandler(DEFAULT_HANDLERS, command) ??
    notImplementedChatCommandHandler(command)
  );
}
export async function runCommandHandler(handler: ChatCommandHandler, context: CmdCtx, cancel: CancelFlag): Promise<CommandResult> {
  try {
    return await handler(context);
  } catch (error) {
    if (cancel.load()) {
      return defaultCommandResult();
    }
    throw error;
  }
}
export function stoppedCommandContent(content: string, stopped: boolean): string {
  return stopped ? `${content} *(stopped)*` : content;
}
export function unreadCommandContent(content: string, unread: number, stopped: boolean): string {
  if (unread === 0 || stopped) {
    return content;
  }
  return (
    content +
    `\n\n_Note: ${unread} part(s) of the source couldn't be read (the model failed or timed out on them), so they aren't reflected above. Re-run to try them again._`
  );
}
export function commandContent(result: CommandResult, context: CmdCtx, cancel: CancelFlag): string {
  const stopped = cancel.load();
  const noted = unreadCommandContent(stoppedCommandContent(result.content, stopped), context.unreadCount(), stopped);
  return noted.trim() === "" ? "Done." : noted;
}
export async function runKnownCommand(
  req: RunCommandRequest,
  deps: RunCommandDeps,
  cancel: CancelFlag,
  persistence: CommandPersistence
): Promise<Message> {
  const start = startCommand(req, deps, persistence);
  if (req.command === "checkpoint") {
    return checkpointCommand(req, deps);
  }
  const context = commandContext(req, deps, start, cancel, await commandModel(deps, start.explicitModel));
  const result = await runCommandHandler(commandHandler(deps, req.command), context, cancel);
  return persistAssistantReply(
    deps.room,
    req.chatId,
    commandContent(result, context, cancel),
    result.sources,
    effectsJson(result.effects)
  );
}
export function commandErrorRoom(
  deps: RunCommandDeps,
  savedQuestionRoomPath: string | null
): OpenCommandRoom | null {
  if (savedQuestionRoomPath === null) {
    return null;
  }
  const room = deps.room.currentRoom();
  if (room === null || room.path !== savedQuestionRoomPath) {
    return null;
  }
  return room;
}
export function commandErrorReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/gu, " ").trim().slice(0, 600) || "The command failed.";
}
export function persistCommandFailure(
  req: RunCommandRequest,
  deps: RunCommandDeps,
  cancel: CancelFlag,
  persistence: CommandPersistence,
  error: unknown
): Message {
  if (cancel.load()) {
    throw error;
  }
  const room = commandErrorRoom(deps, persistence.savedQuestionRoomPath);
  if (room === null) {
    throw error;
  }
  const content =
    `#${req.command} could not finish: ${commandErrorReason(error)}\n\n` +
    "Check the selected file and model, then try the command again.";
  return insertTurnErrorMessage(room.db, req.chatId, content);
}
export function forgetCommandCancel(deps: RunCommandDeps, askId: string): void {
  deps.cancelState.cancels.delete(askId);
  forget(deps.cancelState, askId);
}


export async function runCommand(req: RunCommandRequest, deps: RunCommandDeps): Promise<Message> {
  assertKnownCommand(req.command);
  const cancel = new CancelFlag();
  deps.cancelState.cancels.set(req.askId, cancel);
  const persistence: CommandPersistence = { savedQuestionRoomPath: null };
  try {
    return await runKnownCommand(req, deps, cancel, persistence);
  } catch (error) {
    return persistCommandFailure(req, deps, cancel, persistence, error);
  } finally {
    forgetCommandCancel(deps, req.askId);
  }
}
