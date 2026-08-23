/**
 * THE HOST BOOTSTRAP for `chatCommands.ts`'s `CmdCtx`/`RunCommandDeps` and
 * `execTool.ts`'s `ExecToolDeps`: given a real, already-open room
 * (`roomManager.ts`'s `RoomManagerState`) plus a turn and an event sender,
 * assembles the two dependency bundles a live `#command` or a live `exec_tool`
 * call actually needs — every currently-unwired seam pointed at its
 * already-built real implementation.
 *
 * WHY THIS FILE EXISTS. Nine files in this port independently describe the
 * same gap in the same words — "seam exists, not yet plugged in, belongs to
 * whichever host-bootstrap batch assembles a real one" (`chatCommands.ts`,
 * `chatCommandsGenerate.ts`, `chatCommandsKnowledge.ts`,
 * `sketchLayoutAdapter.ts`, and `execTool.ts`'s own
 * `withRealAdvisorCli`/`withRealPrivacyGates` docs, among them). Every one of
 * those seams already HAS a real implementation sitting beside it:
 * `ollamaGenerate.ts`'s `generate`/`chatStructured`, `chatCommandsGenerate.ts`'s
 * `generateStream`, `sketchLayoutAdapter.ts`'s `layoutGraphReal`,
 * `externalAdvisor.ts`'s real subprocess, `privacy.ts`'s PRIV-4 gates. What was
 * missing was one caller that plugs them in at once, for a real room, instead
 * of each test file hand-rolling its own differently-partial deps literal.
 * This module is that caller.
 *
 * NO PARALLEL STATE IS INVENTED HERE. Every field below is either a real
 * function committed elsewhere or a value read through `roomManager.ts`'s OWN
 * adapters:
 *   - `RunCommandDeps.room` / `CmdCtx.room` is {@link liveTurnRoomSource}, which
 *     composes `toRoomPinSource` and `toRoomSource` rather than re-deriving the
 *     epoch/path/handle triple a third way. It re-reads `state.room` on every
 *     call, so a turn started against one open room sees a lock or a room SWAP
 *     that happens mid-turn instead of a snapshot taken at assembly time.
 *   - `CmdCtx.rooms` is left UNSET on purpose: `CmdCtx`'s own constructor
 *     derives it (`opts.rooms ?? { current: () => opts.room.currentRoom() }`),
 *     so passing a second, separately-built `RoomSource` would be two views
 *     that can disagree where the port intends one.
 *   - `RunCommandDeps.checkpointState` IS `state` — `roomCheckpoints.ts`'s
 *     `createCheckpointCore` takes the whole `RoomManagerState`, and
 *     `chatCommands.ts`'s own "TWO PARTIAL AppState SHAPES" note requires a
 *     production wiring to point both deps at the same underlying open room.
 *     Here they are literally the same object.
 *   - `RunCommandDeps.cancelState` IS `state.cancel` — `cancel.ts`'s registry,
 *     the same one `close_room`'s drain and every other cancel-aware caller
 *     already walks.
 *   - `ExecToolDeps.cancel` prefers the flag ALREADY REGISTERED for the turn's
 *     run id (`state.cancel.cancels`/`.jobCancels`, the maps `runCommand` and
 *     `registerRun` populate) over minting a disconnected one a real Stop could
 *     never reach. See {@link registeredCancelFor}.
 *
 * THE ONE SEAM THAT IS LOAD-BEARING ON ITS OWN, worth stating plainly because
 * it changes what "inert" meant for the other three engine seams:
 * `CmdCtx.generate`/`chatStructured`/`generateStream` are NOT
 * `NOT_IMPLEMENTED` stubs when omitted — `chatCommandsKnowledge.ts`'s `askQuiet`
 * reads `ctx.generate ?? generateReal` and `chatCommandsGenerate.ts`'s
 * `askStructured`/`askStreaming` do the same, so an unpassed seam already
 * resolves to the real client at the point of use. What was missing for those
 * three is the surrounding object graph: nobody in production ever built a real
 * `RunCommandDeps` to construct a `CmdCtx` from. `layoutGraph` has no such
 * fallback (`ctx.layoutGraph ?? layoutGraphNotImplemented`, a genuine throw), so
 * it is the one seam whose wiring is load-bearing independent of the rest of the
 * graph. All four are set explicitly anyway — so the wiring is VISIBLE on an
 * assembled object rather than "real by omission", which reads identically to
 * "nobody wired it yet" — and the acceptance test drives BOTH: a real
 * `chatStructured` POST over a real socket AND a real `layoutGraphReal` render.
 *
 * THE ADVISOR'S STOP IS WIRED HERE, and both earlier drafts of this file missed
 * it. `execTool.ts`'s `withRealAdvisorCli` doc states the hazard outright:
 * "pass `cancel`. Rust's own arm passes `cancel.clone()` on every consult, and
 * it is the ONLY kill path either port has — there is no wall-clock timeout in
 * `run_external` or in `runExternalCli`." `realRunAdvisorCli` (the zero-argument
 * default that composer installs) binds NO flag, so a wedged `claude -p` would
 * hold the turn open for the life of the process with Stop unable to end it.
 * {@link liveExecToolDeps} therefore binds the SAME resolved run flag it puts on
 * `ExecToolDeps.cancel` into the advisor's `RunExternalOptions`, and falls back
 * to the flagless default only when there genuinely is no run flag to bind.
 *
 * DELIBERATELY LEFT ON ITS EXISTING DEFAULT — an honest gap, not an oversight:
 *   - `CmdCtx.transcribeAudio` — on-device Whisper has no Electron port anywhere
 *     in this tree (`sttTools.ts` covers model download/management only, never
 *     live decoding). Left unset, so `#transcribe`'s on-demand branch keeps
 *     refusing through `transcribeAudioNotImplemented`; its cached-transcript
 *     branch is unaffected. Faking it is the one thing this port has repeatedly
 *     refused to do.
 *   - `ExecToolDeps.downloadJob`/`.workflowRun`/`.runStudioDeps` — each needs an
 *     APP-WIDE job queue / cancel-tree bundle that nothing in this room- and
 *     turn-scoped assembler's remit constructs. A queue owned by this module
 *     alone would be worse than the refusal: two `#command` runs would get two
 *     unrelated queues that cannot see each other's jobs.
 *   - `ExecToolDeps.callConnectorTool`/`.connectorApproved`/`.remoteSeam`/
 *     `.outboundUnmaskFor`/`.mcpStatuses`/`.mcpForgetConnectorGrants`/
 *     `.mcpReconnect`/`.confirmDestructive` — all need a live, app-wide
 *     `McpManager` and a consent surface this migration has never stood up
 *     (`roomManager.ts`'s own doc lists the connector manager among the "real
 *     ported subsystems this batch does not wire into a live bootstrap").
 *     `routes` is `[]` for the same reason, which is the honest "no connectors
 *     are live" answer rather than a placeholder.
 * A caller that later owns any of those hands them in by spreading over the
 * assembled object (`{ ...liveExecToolDeps(…), downloadJob }`) — no override
 * parameter is offered here, because an object spread already does it, and
 * already lets an explicit `undefined` genuinely clear a field.
 *
 * SCOPE BOUNDARY: this is a pure backend object-graph assembler. It touches no
 * IPC registry, no preload, no `main/index.ts` and no Touch ID — those are
 * Phase 2 Steps 1/2, owned by sibling workflows. It needs no Electron `app` or
 * `BrowserWindow` either: an `EventSender` is a plain function (see `turn.ts`
 * for why that is deliberate), which is exactly why `liveContext.test.ts` can
 * drive the whole thing against a real temp-file SQLCipher room.
 */

import { CancelFlag } from "./cancel.js";
import { CmdCtx, type CmdCtxDeps, type RunCommandDeps } from "./chatCommands.js";
import { generateStream as generateStreamReal } from "./chatCommandsGenerate.js";
import { withRealAdvisorCli, withRealPrivacyGates, type ExecToolDeps } from "./execTool.js";
// `CancelFlagLike` from here rather than `mcpBridge.ts`'s identical twin: it is
// the exact type `RunExternalOptions.cancel` declares, so the advisor binding
// below is checked against the field it actually feeds.
import type { CancelFlagLike, RunExternalOptions } from "./externalAdvisor.js";
import { chatStructured as chatStructuredReal, generate as generateReal } from "./ollamaGenerate.js";
import { toRoomPinSource, toRoomSource, type RoomManagerState } from "./roomManager.js";
import { layoutGraphReal } from "./sketchLayoutAdapter.js";
import type { EventSender, TurnId } from "./turn.js";
import type { OpenRoom, TurnRoomSource } from "./turnEngine.js";

// ============================================================================
// The room view — one RoomManagerState, through roomManager.ts's own adapters
// ============================================================================

/**
 * `RoomManagerState` as the `TurnRoomSource` that `chatCommands.ts`'s
 * `runCommand` (and `turnEngine.ts`'s `ask`) read the open room through.
 *
 * Composed from `roomManager.ts`'s OWN {@link toRoomPinSource}/{@link toRoomSource}
 * rather than a third `{db, path}` reader: the epoch/path pair and the room
 * handle both already exist and are already real, so this adds only
 * `currentRoom`'s `OpenRoom` framing (identical fields to `RoomHandle`, nothing
 * recomputed) and `rollingBack`, which `TurnRoomSource` declares and
 * `RoomSource` does not.
 */
export function liveTurnRoomSource(state: RoomManagerState): TurnRoomSource {
  const pin = toRoomPinSource(state);
  const rooms = toRoomSource(state);
  return {
    roomEpoch: pin.roomEpoch,
    currentRoomPath: pin.currentRoomPath,
    currentRoom: (): OpenRoom | null => rooms.current(),
    rollingBack: () => state.rollingBack,
  };
}

// ============================================================================
// The CmdCtx engine seams
// ============================================================================

/**
 * The four real `CmdCtx` engine seams this batch closes: `generate`/
 * `chatStructured` (`ollamaGenerate.ts`, both sidecar-backed through
 * `postGenerateCancellable`), `generateStream` (`chatCommandsGenerate.ts`'s real
 * `/generate_stream` NDJSON client) and `layoutGraph`
 * (`sketchLayoutAdapter.ts`'s `layoutGraphReal` — exactly the wiring that file's
 * own doc predicts: "wiring `ctx.layoutGraph = layoutGraphReal` wherever a real
 * `CmdCtx` is assembled … belongs to whichever host-bootstrap batch assembles
 * one").
 *
 * `transcribeAudio` is deliberately ABSENT — see the module doc.
 */
export function liveCmdCtxDeps(): CmdCtxDeps {
  return {
    generate: generateReal,
    chatStructured: chatStructuredReal,
    generateStream: generateStreamReal,
    layoutGraph: layoutGraphReal,
  };
}

// ============================================================================
// The real cancel flag for a run, from the registry a run actually uses
// ============================================================================

/**
 * The flag ALREADY REGISTERED for `runId`, or `null` when nothing registered
 * one. `runCommand` (via `deps.cancelState.cancels.set(...)`) and `ask` (via
 * `registerRun`, which populates the same flat map) both leave one there for the
 * run's lifetime, so preferring it means a Stop pressed on a genuinely running
 * turn reaches work assembled here for that same turn.
 *
 * `null` rather than a freshly minted flag: for `ExecToolDeps.cancel` that is
 * Rust's own `cancel: None`, and it says "no Stop can reach this call" where a
 * new never-flipped `CancelFlag` would say "there is a Stop" while being
 * unreachable by every Stop path in the app.
 */
function registeredCancelFor(state: RoomManagerState, runId: string): CancelFlag | null {
  return state.cancel.cancels.get(runId) ?? state.cancel.jobCancels.get(runId) ?? null;
}

// ============================================================================
// #commands — a real RunCommandDeps for chatCommands.ts's runCommand
// ============================================================================

/**
 * A real, complete {@link RunCommandDeps} for `state`'s currently open room:
 * `room` is a live view over it, `cancelState`/`checkpointState` ARE the real
 * registry and the real state object, and every `CmdCtx` engine seam is wired
 * per {@link liveCmdCtxDeps}. `runCommand(req, liveRunCommandDeps(state, send))`
 * is a real, end-to-end `#command` run against thirteen already-real `cmd_*`
 * bodies.
 *
 * `send` is the caller's own event sender — a `webContents.send` bound to a
 * window in a running app, a spy in a test. This module does not own a window
 * and does not invent one. `emit` (the raw, non-turn-enveloped
 * `room-files-changed`/`agent-open-file`/`agent-annotate` events) is set to that
 * same sender, which is precisely what Rust's single `window` handle is for both
 * kinds of event; a caller wanting them split spreads over the result.
 *
 * `listModels` is left unset so `runCommand` resolves `engineRouting.ts`'s real
 * one — the live app's behavior — rather than this module deciding for it.
 */
export function liveRunCommandDeps(state: RoomManagerState, send: EventSender): RunCommandDeps {
  return {
    room: liveTurnRoomSource(state),
    cancelState: state.cancel,
    send,
    emit: send,
    checkpointState: state,
    ...liveCmdCtxDeps(),
  };
}

// ============================================================================
// A single CmdCtx, for driving one command body without runCommand's dispatch
// ============================================================================

/** What {@link assembleCmdCtx} needs beyond the open room and the sender.
 * Everything but `model`/`turn` matches `CmdCtxOpts`'s own optionality. */
export interface LiveCmdCtxOptions {
  model: string;
  turn: TurnId;
  /** Defaults to the flag registered for `turn.runId`, and to a fresh,
   * never-flipped one when nothing registered any. `CmdCtx.cancel` is a
   * REQUIRED `CancelFlag` (`askQuiet` hands it to `generate`, `watchStream`
   * polls it), so unlike `ExecToolDeps.cancel` there is no honest `null` to fall
   * back to — a caller who never registered a run genuinely has no live Stop,
   * and a fresh flag is what that means here. */
  cancel?: CancelFlag;
  /** @-pinned file ids, resolved in the UI before send. */
  refs?: readonly string[];
  args?: string;
  history?: string;
  temperature?: number | null;
}

/**
 * A real, complete {@link CmdCtx} for `state`'s open room — for a caller that
 * wants ONE command body's real behavior without `runCommand`'s catalog
 * validation, cancel registration, history read and persist pipeline.
 *
 * `runCommand` itself does not use this: it builds its own `CmdCtx` from
 * {@link liveRunCommandDeps} plus the request, exactly as the real app does.
 */
export function assembleCmdCtx(
  state: RoomManagerState,
  send: EventSender,
  opts: LiveCmdCtxOptions
): CmdCtx {
  return new CmdCtx({
    model: opts.model,
    refs: opts.refs ?? [],
    args: opts.args ?? "",
    history: opts.history ?? "",
    temperature: opts.temperature ?? null,
    cancel: opts.cancel ?? registeredCancelFor(state, opts.turn.runId) ?? new CancelFlag(),
    turn: opts.turn,
    room: liveTurnRoomSource(state),
    send,
    emit: send,
    ...liveCmdCtxDeps(),
  });
}

// ============================================================================
// exec_tool — a real ExecToolDeps for execTool.ts / bridgeDispatcher.ts
// ============================================================================

/** What {@link liveExecToolDeps} needs beyond the open room and the sender. */
export interface LiveExecToolDepsOptions {
  /**
   * The turn this call belongs to, when it belongs to one: it threads `runId`
   * into provenance (`create_file`'s history entry) and resolves the run's
   * already-registered Stop flag. `null`/omitted is Rust's own `turn: None` —
   * genuinely how the persistent room bridge reaches `exec_tool`.
   */
  turn?: TurnId | null;
  /**
   * Overrides the turn-derived flag outright. `bridgeDispatcher.ts`'s
   * `RoomToolDispatcher` resolves its OWN per-call flag through `toolCancelFor`
   * and overlays it on a base `ExecToolDeps`, so a bridge caller passes nothing
   * here; this is for a direct `execTool` caller holding a flag of its own.
   */
  cancel?: CancelFlagLike | null;
  /**
   * Handed to `execTool.ts`'s `withRealAdvisorCli`. Production passes nothing —
   * the real `zsh -ilc` shell and the real subprocess — and a test passes
   * `spawnFn`/`shell`/`env` to stay hermetic without falling back to the
   * `NOT_IMPLEMENTED` stub. The run's Stop flag is bound automatically (see the
   * module doc) unless this supplies its own `cancel`.
   */
  advisorOptions?: RunExternalOptions;
}

/**
 * A real, complete {@link ExecToolDeps} for `state`'s currently open room — the
 * object a running app hands to `execTool`, or to
 * `RoomToolDispatcherOptions.execDeps` for a bridge that overlays its own
 * per-call `routes`/`cancel`.
 *
 * `db` is the open room's connection READ AT ASSEMBLY TIME (`null` when none
 * is open, exactly `execTool.ts`'s `requireRoom` contract) — a snapshot, not a
 * live re-read, and deliberately so: `ExecToolDeps.db` is a value field, and a
 * bridge holds ONE base deps object for its whole lifetime
 * (`RoomToolDispatcher` re-spreads it per call but only overrides
 * `routes`/`cancel`). Re-reading live would let a tool call belonging to a turn
 * started in room A land its write in room B after a mid-turn swap; a stale
 * handle instead fails loudly, and `RoomToolDispatcher.dispatch` already turns
 * that throw into a tool-shaped failure. `emit` is the caller's sender —
 * `ExecToolDeps.emit`'s signature IS `turn.ts`'s `EventSender`, and the events
 * this seam carries (`memories-changed`, `skills-changed`) are the raw,
 * non-enveloped kind Rust's bare `window.emit(...)` sends, so no adapter is
 * needed or written.
 *
 * `runAdvisorCli`/`maskOutboundWeb`/`outboundUrlRefusal` are installed through
 * `execTool.ts`'s OWN `withRealAdvisorCli`/`withRealPrivacyGates` composers,
 * extended rather than replaced. Composition order is not load-bearing (both
 * guard `!== undefined` internally); advisor-outermost is where its options
 * belong.
 */
export function liveExecToolDeps(
  state: RoomManagerState,
  send: EventSender,
  opts: LiveExecToolDepsOptions = {}
): ExecToolDeps {
  const turn = opts.turn ?? null;
  const cancel: CancelFlagLike | null =
    opts.cancel !== undefined ? opts.cancel : turn !== null ? registeredCancelFor(state, turn.runId) : null;

  const base: ExecToolDeps = {
    db: toRoomSource(state).current()?.db ?? null,
    cancel,
    runId: turn?.runId ?? null,
    emit: send,
    routes: [],
  };

  // A consult with no flag bound is unkillable — see the module doc. Passing
  // no options at all when there is nothing to bind keeps the flagless
  // `realRunAdvisorCli` (the identical function `withRealAdvisorCli` installs
  // by default), rather than an indistinguishable rebound copy of it.
  const advisorOptions: RunExternalOptions | undefined =
    cancel === null && opts.advisorOptions === undefined
      ? undefined
      : { ...(cancel !== null ? { cancel } : {}), ...opts.advisorOptions };

  return withRealAdvisorCli(withRealPrivacyGates(base), advisorOptions);
}

// ============================================================================
// assembleLiveContext — the one entry point a real host wires up
// ============================================================================

/**
 * Everything a live room needs to run a real `#command` or a real `execTool`
 * call, behind one handle.
 *
 * Not a class with shared mutable fields: the three pieces are independent — a
 * `#command` run needs {@link runCommandDeps}, while a tool call needs
 * {@link execToolDeps} scoped to ITS OWN turn and cancel, which can differ per
 * call within a single answer — so bundling them into one stateful object would
 * invite exactly the accidental cross-call sharing this module's "no parallel
 * state" stance argues against.
 */
export interface LiveContext {
  /** Feed straight to `runCommand(req, ctx.runCommandDeps)`. */
  runCommandDeps: RunCommandDeps;
  /** One real `CmdCtx`, without `runCommand`'s catalog dispatch. */
  cmdCtx(opts: LiveCmdCtxOptions): CmdCtx;
  /** One real `ExecToolDeps` (or one per turn's worth of calls). */
  execToolDeps(opts?: LiveExecToolDepsOptions): ExecToolDeps;
}

/**
 * THE assembler. A ported CONCEPT rather than ported code: `AppState` bundled a
 * `Room`, a `CancelState` and a `Window` behind one handle every command reached
 * through. This is that same bundling for the pieces this migration has actually
 * built — `RoomManagerState` (which already carries `cancel.ts`'s real
 * `CancelState` as `state.cancel`, reused rather than reinvented) plus an
 * `EventSender` standing in for the `Window`.
 */
export function assembleLiveContext(state: RoomManagerState, send: EventSender): LiveContext {
  return {
    runCommandDeps: liveRunCommandDeps(state, send),
    cmdCtx: (opts) => assembleCmdCtx(state, send, opts),
    execToolDeps: (opts) => liveExecToolDeps(state, send, opts),
  };
}
