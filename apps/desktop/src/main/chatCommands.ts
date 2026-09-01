/**
 * The `#command` catalog and dispatcher. Ported from
 * `src-tauri/src/commands/chat_commands.rs` (785 lines, read in full,
 * including its own `#[cfg(test)] mod` blocks — `full_ops_tests`,
 * `quiet_step_tests` and `stream_watchdog_tests` are all reproduced in
 * `chatCommands.test.ts`).
 *
 * SCOPE — this file is the DISPATCHER. `chat_commands.rs` itself is a thin top
 * level: the `CHAT_COMMANDS` catalog, `run_command`'s validate →
 * cancel-register → read-history → (checkpoint short-circuit) → resolve-model
 * → dispatch → unread-note/stopped-suffix → persist pipeline, and `CmdCtx` —
 * the shared toolkit (`ask_streaming`, `ask_quiet`, `ask_structured`,
 * `map_windows`, `fold_notes`, `digest`) every `cmd_*` workflow is built on.
 * The thirteen `cmd_*` FUNCTIONS THEMSELVES (`#remember`, `#find`,
 * `#add-file`, `#highlight`, `#extract`, `#summarize`, `#compare`,
 * `#transcribe`, `#minutes`, `#sketch`, `#to-sheet`, `#translate`,
 * `#research`) live in two SIBLING Rust files — `chat_commands/knowledge.rs`
 * and `chat_commands/generate.rs`, pulled in via `mod knowledge; mod generate;
 * pub(crate) use knowledge::*; pub(crate) use generate::*;` — whose ports are
 * `chatCommandsKnowledge.ts` and `chatCommandsGenerate.ts`. {@link DEFAULT_HANDLERS}
 * IS that `use`: all thirteen are wired here, so {@link runCommand} really
 * dispatches into them the way Rust's `match command.as_str()` does.
 * `#checkpoint` is the one exception: it is a real, self-contained, no-model
 * "commit" that `run_command` handles inline, and it IS ported below for real.
 *
 * THE CONNECTION IS COMPILER-CHECKED, and was once genuinely broken. This
 * file, `chatCommandsKnowledge.ts` and `chatCommandsGenerate.ts` were written
 * by three concurrent sessions, each of which built its own `CmdCtx`. The
 * dispatcher's was a class over `TurnRoomSource` with a private `unread`
 * number and no `emit`; the bodies' was an interface over `RoomSource` with a
 * shared `UnreadCounter` and a raw `emit` — so `handlers: { remember:
 * cmdRemember }` did not typecheck, `handlers` defaulted to a
 * `NOT_IMPLEMENTED` throw for every command, and the whole `#command` feature
 * was inert end to end however green each file's own suite was.
 * {@link CmdCtx} now `implements CommandBodyCtx` (the bodies' shape, imported
 * — never re-declared), so the two can never drift apart again without
 * failing the build.
 *
 * NOT AN exec_tool ARM. `execTool.ts`'s full match-arm list (mirroring
 * `agent.rs`'s `exec_tool`) was checked and has no `"run_command"`/`"#…"` case,
 * and `toolSpecs.ts` advertises no such tool to a model either. A `#command` is
 * TYPED BY THE HUMAN in the composer, not something a model calls — this is
 * `story.rs`'s exact shape (`storyTools.ts`'s own doc: "a page a person clicks
 * around in, not a tool a model can call").
 *
 * WHERE "RECOGNITION" ACTUALLY LIVES — worth stating since the request that
 * produced this file asked "how is a message recognized as one". It is NOT in
 * `chat_commands.rs`: `run_command`'s own doc says its `command`/`args`/`refs`
 * parameters arrive already split, "with @tokens already stripped by the UI".
 * The real `#word` / `/skill` / `*specialist` / `@ref` regex recognition is
 * `src/workspace/composer.ts`'s `parseComposer` (the PRE-MIGRATION renderer,
 * outside `electron-migration/` and outside this task's target directory) —
 * `tokenAtCaret`/`resolveRefs`/`parseComposer` there, none of it re-declared
 * here. What THIS file does with the name is the one thing `chat_commands.rs`
 * itself does: validate it against {@link CHAT_COMMANDS} before anything else
 * runs, exactly once, in {@link runCommand}'s first line — defense in depth
 * against a caller that skipped the renderer's own check.
 *
 * WHAT IS REAL HERE, against already-ported dependencies — nothing re-declared:
 *   - {@link CHAT_COMMANDS}/{@link listChatCommands} — the catalog, verbatim.
 *   - {@link cmdWindows}/{@link CMD_WINDOW_CHARS}/{@link CMD_WINDOW_OVERLAP} —
 *     over `extractionWindow.ts`'s real `partitionWindows`/`byteLength`/
 *     `sliceUtf8` (ADD-32's `extraction::partition_windows`, already ported).
 *   - {@link formatHistory} — over `db-host/retrieval.ts`'s real
 *     `stripMarkupBlocks`.
 *   - {@link quietStepText}/{@link streamIdleSecs} — over `engineRouting.ts`'s
 *     real `stripThinkSpans` and `turnContext.ts`'s real `isCliEngine`
 *     (the silence budget is about engine KIND, not the streaming flag — see
 *     `streamIdleSecs`).
 *   - `#checkpoint` — over `roomCheckpoints.ts`'s format-aware checkpoint command.
 *   - {@link watchStream} — the Stop/stall watchdog race, pure and fully
 *     ported (both Rust tests reproduced) — see its own doc for the one place
 *     the JS/Rust cancellation MODELS genuinely differ.
 *   - {@link runCommand} — validate, cancel-register (FLAT, see its own doc),
 *     Phase 1 (real history/settings reads + the user's raw line saved),
 *     `#checkpoint`'s short-circuit, model resolution (never falling back to a
 *     cloud model — commands make several small calls a cloud model would leak,
 *     and can't stream the pipeline), dispatch, unread-note/stopped-suffix,
 *     persist. All real.
 *
 * {@link CmdCtx} DOES NOT reimplement `ask_quiet`/`ask_streaming`/
 * `ask_structured`/`map_windows`/`fold_notes`/`digest`, unlike Rust's own
 * `impl CmdCtx` inherent methods. An earlier revision of this file DID carry a
 * second, class-method copy of that toolkit — never reachable, because every
 * `cmd_*` body (in `chatCommandsKnowledge.ts`/`chatCommandsGenerate.ts`) calls
 * the FREE-FUNCTION versions those two files already own, passing `ctx` as
 * plain data (`digest(ctx, ...)`, not `ctx.digest(...)`). Two live copies of
 * the same behavior, one of them provably dead — the class-method copy was
 * deleted rather than kept "just in case"; {@link CmdCtx} here is a pure data
 * container (plus {@link CmdCtx.unreadCount}, which {@link runCommand} itself
 * reads).
 *
 * `/generate_stream` IS PORTED — by `chatCommandsGenerate.ts`, whose own
 * `generateStream` is the real NDJSON client for `sidecar::generate_stream`
 * (the tool-less, streamed plain-generate endpoint the free `askStreaming`
 * rides). Its {@link StreamGenerateFn} seam (`ctx.generateStream`) therefore
 * defaults to {@link defaultStreamGenerate}, a thin adapter over it. It used
 * to default to a `NOT_IMPLEMENTED` refusal, correctly, when nothing in this
 * tree POSTed that path; keeping the refusal after a sibling in the same
 * feature implemented it would have been a stub standing in front of working
 * code, which rule 3 does not ask for and a reader would have believed.
 *
 * THE REMAINING HONEST GAPS all live in the command bodies, not here, and are
 * declared there: on-device Whisper transcription (`#transcribe`'s on-demand
 * branch) and `sketchdoc::layout_graph` (`#sketch`'s render), both injectable
 * through {@link RunCommandDeps.transcribeAudio}/{@link RunCommandDeps.layoutGraph}
 * and both defaulting to a labeled `NOT_IMPLEMENTED` rejection.
 * {@link RunCommandDeps.handlers} remains as a per-command OVERRIDE of
 * {@link DEFAULT_HANDLERS}; a catalog name with no handler at all would still
 * resolve through {@link notImplementedChatCommandHandler}, and `runCommand`'s
 * Stop-swallow (`Err(_) if stopped => CommandResult::default()`) applies to
 * that throw exactly as it does to any other.
 *
 * TWO PARTIAL "AppState" SHAPES, KEPT SEPARATE — a structural fact of this
 * migration's current state, not an invention of this file.
 * {@link RunCommandDeps.room} is `turnEngine.ts`'s `TurnRoomSource` (an
 * `OpenRoom{db,path}` view); {@link RunCommandDeps.checkpointState} is
 * `roomManager.ts`'s `RoomManagerState` (a `Room{conn,path,name,password}`
 * view), because `#checkpoint` reuses `roomCheckpoints.ts`'s real
 * `createRoomCheckpoint(state, name)` rather than re-deriving a
 * third shape. Rust's `run_command` also touches the room lock twice (Phase 1's
 * `state.room.lock()` block, then `create_checkpoint_core`'s own
 * `state.with_room(...)`) — two acquisitions of ONE mutex, not two objects —
 * so a production wiring MUST point both deps at the same underlying open
 * room, exactly as `roomCheckpoints.test.ts`'s own `openRoomState` fixture
 * does. Nothing here reconciles the two automatically.
 *
 * CANCEL REGISTRATION IS FLAT, UNLIKE `ask`. `turnEngine.ts`'s `ask()` calls
 * `cancel.ts`'s `registerRun` (a cancel-TREE root, because a turn can spawn
 * delegated specialists/background jobs/studio builds as its children). Rust's
 * `run_command` does not: it inserts directly into the flat `state.cancels`
 * map (`state.cancels.lock().unwrap().insert(ask_id.clone(), cancel.clone())`)
 * with no `cancel::register_run` call anywhere in the file — a `#command`
 * pipeline has no cancellable children of its own. {@link runCommand} mirrors
 * that: a bare `cancelState.cancels.set(...)`, not `registerRun`. `forget` is
 * still called on the way out (a no-op on an id the tree never held), matching
 * Rust's `CancelGuard::drop` unconditionally calling `cancel::forget` — the
 * SAME guard type `ask`'s cancel setup uses, which does not know at drop time
 * whether a tree root was ever registered for this id.
 */

import { CancelFlag, forget, type CancelState } from "./cancel.js";
import { getSetting } from "./db-host/settings.js";
import { insertMessage, insertTurnErrorMessage, recentMessages } from "./db-host/messages.js";
import { setChatTitleIfNew } from "./db-host/chats.js";
import { stripMarkupBlocks } from "./db-host/retrieval.js";
import { byteLength, partitionWindows, sliceUtf8 } from "./extractionWindow.js";

import { stripThinkSpans, listModels as listModelsReal } from "./engineRouting.js";
import { bestLocalDefault } from "./ollamaModels.js";
import { generate as generateReal, chatStructured as chatStructuredReal } from "./ollamaGenerate.js";
import { defaultProviderDeps, type ProviderDeps } from "./providers.js";
import { createRoomCheckpoint } from "./roomCheckpoints.js";
import type { RoomManagerState } from "./roomManager.js";
import { TurnId, type EventSender } from "./turn.js";
import { createToolEffects, effectsJson, type ToolEffects } from "./execTool.js";
import { modelSetting, parseTemperature } from "./gatherContext.js";
import { persistAssistantReply, type TurnRoomSource } from "./turnEngine.js";
import type { Message } from "./db-host/messages.js";
import type { ChatCommand } from "../shared/apiTypes.js";
import type { RoomSource } from "./jobs.js";
import {
  cmdAddFile,
  cmdExtract,
  cmdFind,
  cmdHighlight,
  cmdRemember,
  type EmitFn,
  type UnreadCounter,
} from "./chatCommandsKnowledge.js";
import {
  cmdCompare,
  cmdMinutes,
  cmdResearch,
  cmdSketch,
  cmdSummarize,
  cmdToSheet,
  cmdTranscribe,
  cmdTranslate,
  generateStream,
  type CmdCtx as CommandBodyCtx,
  type LayoutGraphFn,
  type TranscribeAudioFn,
} from "./chatCommandsGenerate.js";

// ============================================================================
// The catalog — verbatim from `CHAT_COMMANDS`. Keep in sync with the dispatch
// table a future knowledge.ts/generate.ts wires into `RunCommandDeps.handlers`.
// ============================================================================

export const CHAT_COMMANDS: readonly ChatCommand[] = [
  {
    name: "add-file",
    summary: 'Write a new note or document — or one per item with "for each"',
    usage: "#add-file <name>: <topic>   ·   #add-file for each <thing>",
  },
  {
    name: "remember",
    summary: "Save a fact to the room's permanent memory",
    usage: "#remember <fact>",
  },
  {
    name: "find",
    summary: "Search the room's files for content and list what matches",
    usage: "#find <keywords>",
  },
  {
    name: "highlight",
    summary: "Mark an exact passage in a file so you can see it in the viewer",
    usage: "#highlight <thing> in @file",
  },
  {
    name: "extract",
    summary: "Pull the same fields out of several files into a spreadsheet",
    usage: "#extract <field, field…> from @a @b",
  },
  {
    name: "summarize",
    summary: "Summarize the whole room, or one @file",
    usage: "#summarize   ·   #summarize @file",
  },
  {
    name: "compare",
    summary: "Compare two or more @files side by side",
    usage: "#compare @a @b",
  },
  {
    name: "transcribe",
    summary: "Show the transcript of an @recording",
    usage: "#transcribe @recording",
  },
  {
    name: "sketch",
    summary: "Draw an @file as a diagram, with a note explaining each part",
    usage: "#sketch @plan.md   ·   #sketch how our login flow works",
  },
  {
    name: "minutes",
    summary: "Turn a meeting transcript or notes into timeline-style HTML minutes",
    usage: "#minutes @recording   ·   #minutes @notes.md",
  },
  {
    name: "to-sheet",
    summary: "Turn the table in the last answer into a spreadsheet",
    usage: "#to-sheet",
  },
  {
    name: "translate",
    summary: "Translate an @file into another language",
    usage: "#translate @file to <language>",
  },
  // D8 (the Airlock): search the web, pull each source into the room as an
  // owned offline copy, then answer from those files — so the sources stay
  // even after the network is gone. Requires a web provider in Settings.
  {
    name: "research",
    summary: "Search the web, save each source into the room, then answer offline",
    usage: "#research <question>",
  },
  // Wave 3 (Idea 9): one-click "commit" — a named whole-room checkpoint from
  // the composer, no model call. Rollback stays gated in Settings.
  {
    name: "checkpoint",
    summary: "Save a named checkpoint of the whole room (roll back later in Settings)",
    usage: "#checkpoint   ·   #checkpoint before cleanup",
  },
];

/** The catalog, for the frontend autocomplete and help. Ported from
 * `list_chat_commands`. Returns fresh copies — Rust's `CHAT_COMMANDS.to_vec()`
 * clones, so no caller can mutate the catalog through the returned array. */
export function listChatCommands(): ChatCommand[] {
  return CHAT_COMMANDS.map((c) => ({ ...c }));
}

// ============================================================================
// full ops: a pass per window, never a truncation — verbatim from the Rust
// source's own "full ops" section banner and constants.
// ============================================================================

/** Source bytes per pass. Ported verbatim from `CMD_WINDOW_CHARS`. */
export const CMD_WINDOW_CHARS = 16_000;

/** Bytes carried from the previous window. Ported verbatim from
 * `CMD_WINDOW_OVERLAP`. */
export const CMD_WINDOW_OVERLAP = 400;

/**
 * Every window of `text`, in order — exhaustive. Ported verbatim from
 * `cmd_windows`, over `extractionWindow.ts`'s real `partitionWindows`
 * (`extraction::partition_windows`).
 */
export function cmdWindows(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === "") {
    return [];
  }
  if (byteLength(trimmed) <= CMD_WINDOW_CHARS) {
    return [trimmed];
  }
  return partitionWindows(trimmed, CMD_WINDOW_CHARS, CMD_WINDOW_OVERLAP).map(([start, end]) => {
    const slice = sliceUtf8(trimmed, start, end);
    if (slice === null) {
      // partitionWindows only ever returns char-boundary-safe, in-bounds spans
      // over THIS SAME text — a null here would mean a window silently
      // vanished from an exhaustive pass, which is exactly the failure
      // "full ops" exists to prevent. Fail loudly rather than under-cover.
      throw new Error("cmdWindows: partitionWindows produced an invalid span");
    }
    return slice;
  });
}

/** Format prior conversation as plain text (oldest-first), markup stripped.
 * Ported verbatim from `format_history`, over `db-host/retrieval.ts`'s real
 * `stripMarkupBlocks`. */
export function formatHistory(history: readonly (readonly [string, string])[]): string {
  let out = "";
  for (const [role, content] of history) {
    const stripped = stripMarkupBlocks(content);
    if (stripped.trim() === "") {
      continue;
    }
    out += `\n[${role}]\n${stripped}\n`;
  }
  return out.trim();
}

// ============================================================================
// Quiet-step think-stripping and the streaming idle budget
// ============================================================================

/** What one QUIET command step hands on to the rest of the command. Ported
 * verbatim from `quiet_step_text`, over `engineRouting.ts`'s real
 * `stripThinkSpans`. */
export function quietStepText(raw: string): string {
  return stripThinkSpans(raw).trim();
}

/** Wall-clock ceiling for a single non-streamed command step (`askQuiet`).
 * Ported verbatim from `COMMAND_STEP_TIMEOUT_SECS`. */
export const COMMAND_STEP_TIMEOUT_SECS = 300;

/** Longest gap with no token before a STREAMED step counts as stalled — the
 * ordinary (streaming-capable engine) budget. Ported verbatim from
 * `COMMAND_STREAM_IDLE_SECS`. */
export const COMMAND_STREAM_IDLE_SECS = COMMAND_STEP_TIMEOUT_SECS;

/** The cloud-CLI twin: sized past the sidecar's own wedged-CLI budget (900s).
 * A CLI engine now streams its answer text live, but its SILENT phases are
 * still whole work sessions — thinking blocks and tool loops emit no text
 * delta for minutes at a time — so the ordinary streaming clock would kill
 * healthy work. Ported verbatim from `COMMAND_STREAM_IDLE_CLI_SECS`. */
export const COMMAND_STREAM_IDLE_CLI_SECS = 960;

/** How long Stop waits for the stream to notice the flag by itself before
 * {@link watchStream} hangs up on its behalf. Ported verbatim from
 * `COMMAND_STOP_GRACE_MS`. */
export const COMMAND_STOP_GRACE_MS = 1_500;

/**
 * How long a streamed step may go with no token before it counts as stalled,
 * for the engine actually answering. One rule, defined once in
 * `chatCommandsGenerate.ts` (this module and that one each grew a copy during
 * the parallel port, and the copies drifted the day the rule changed) —
 * re-exported here so both call sites and both test files read the same
 * behavior.
 */
export { streamIdleSecs } from "./chatCommandsGenerate.js";

// ============================================================================
// watchStream — the Stop/stall watchdog. Pure, fully ported, both Rust tests
// reproduced in chatCommands.test.ts.
// ============================================================================

/** How often {@link watchStream} samples the Stop flag and the token-silence
 * clock. Ported from `watch_stream`'s own `sleep(Duration::from_millis(200))`
 * cadence inside its `tokio::select!` loop. */
const WATCH_POLL_MS = 200;

const STREAM_STALLED_MESSAGE =
  "The model stopped responding. Try a shorter selection, or switch to a faster model in Settings.";

/**
 * Drives `fut` while sampling the Stop flag and the gap since the last token;
 * `lastToken`/`partial` are the handles the caller's delta callback writes to.
 * Ported from `watch_stream`.
 *
 * ONE MODEL DIFFERENCE FROM RUST, WORTH NAMING: Rust's `tokio::pin!(fut)` lets
 * `watch_stream` DROP the future the instant it decides to hang up — for a
 * real HTTP stream that tears the connection down, exactly what an in-stream
 * Stop does. A JS `Promise` cannot be un-awaited from outside; `fut` here is
 * expected to be built (by a `streamGenerate`-shaped dependency, the same
 * seam `chatCommandsGenerate.ts`'s own free `askStreaming` reads off
 * `ctx.generateStream`) so that ITS OWN internals already watch `cancel` and
 * abort their own request — the same "cancel is polled inside the call" contract
 * `sidecarJsonCancellable.ts` already gives `ollamaGenerate.ts`'s `generate`/
 * `chatStructured`. What THIS function adds on top, faithfully, is the OUTER
 * race Rust's watchdog exists for: noticing a Stop or a stall the inner call
 * cannot notice on its own (no chunk ever arriving means no internal check
 * ever fires), and resolving/rejecting promptly regardless of whether `fut`
 * ever settles.
 */
export function watchStream(
  fut: Promise<string>,
  cancel: CancelFlag,
  lastToken: { value: number },
  partial: { value: string },
  idleSecs: number,
  graceMs: number,
  pollMs: number = WATCH_POLL_MS
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let stopSeenAt: number | null = null;
    const timer: ReturnType<typeof setInterval> = setInterval(() => {
      if (!settled) {
        const now = Date.now();
        if (cancel.load()) {
          if (stopSeenAt === null) {
            stopSeenAt = now;
          }
          if (now - stopSeenAt >= graceMs) {
            finish(() => resolve(partial.value));
            return;
          }
        }
        if (now - lastToken.value >= idleSecs * 1_000) {
          finish(() => reject(new Error(STREAM_STALLED_MESSAGE)));
        }
      }
    }, pollMs);

    function finish(action: () => void): void {
      if (!settled) {
        settled = true;
        clearInterval(timer);
        action();
      }
    }

    fut.then(
      (value) => finish(() => resolve(value)),
      (err: unknown) => finish(() => reject(err instanceof Error ? err : new Error(String(err))))
    );
  });
}

// ============================================================================
// /generate_stream — REAL, via chatCommandsGenerate.ts's own NDJSON client.
// ============================================================================

/** What the free `askStreaming` (`chatCommandsGenerate.ts`) needs from a real
 * `/generate_stream` POST: the request body, the shared cancel flag to poll
 * internally, and a per-chunk delta callback — mirroring `sidecar::generate_stream`'s own
 * `move |d| { ... }` callback shape. Returns the FULL accumulated text on a
 * clean finish (matching `Ok(full)` from the Rust source, which the caller
 * treats identically to a Stop's partial). */
export type StreamGenerateFn = (
  body: Record<string, unknown>,
  cancel: CancelFlag,
  onDelta: (chunk: string) => void
) => Promise<string>;

/**
 * The default {@link StreamGenerateFn}: `chatCommandsGenerate.ts`'s REAL
 * `sidecar::generate_stream` port (`POST /generate_stream`, NDJSON, PRIV-1
 * policy injection and provider-runtime wiring included), adapted to this
 * file's narrower three-argument seam.
 *
 * This used to be a `NOT_IMPLEMENTED` refusal, correctly, when no Electron
 * code POSTed `/generate_stream` anywhere. `chatCommandsGenerate.ts` now
 * does — that is the endpoint its own free `askStreaming` rides — so a
 * refusal here would be a stub standing in front of a working implementation,
 * not an honest gap.
 */
export function defaultStreamGenerateWith(providerDeps: ProviderDeps): StreamGenerateFn {
  return (body, cancel, onDelta) =>
    generateStream("/generate_stream", body, cancel, new AbortController(), onDelta, providerDeps);
}

/** {@link defaultStreamGenerateWith} over the real provider catalog. */
export const defaultStreamGenerate: StreamGenerateFn = defaultStreamGenerateWith(defaultProviderDeps);
export { CmdCtx, notImplementedChatCommandHandler, defaultCommandResult, runCommand } from "./chatCommandRunner.js";
export type { CmdCtxDeps, CmdCtxOpts, ChatCommandHandler, CommandResult, RunCommandRequest, RunCommandDeps } from "./chatCommandRunner.js";
