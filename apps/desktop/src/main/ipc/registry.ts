/**
 * THE IPC REGISTRY — the single place every `registerXIpc` module in
 * `src/main/` gets wired onto a real `ipcMain`, over one shared object
 * graph, for the first time in this migration. Everything before this was
 * ported logic reachable only from its own `.test.ts`.
 *
 * ============================================================================
 * WHY NOT THE MAPPED-TYPE `defineHandlers` FORM THE PLAN DESCRIBES
 * ============================================================================
 * An early design sketches a
 * `defineHandlers(h: { [K in keyof Commands]: (a) => Promise<r> })`
 * shape, where a missing or misspelled handler is a compile error. That form
 * assumes ONE function per command, all sharing one dependency object. What
 * actually exists is 33 independently-authored `registerXIpc(ipcMain, ...)`
 * functions, each closing over its OWN dependency shape — a bare
 * `RoomManagerState`, several structurally-similar-but-not-identical
 * `RoomSource` flavors, a `RecBridgeCtx`, a `Map` of pending approvals,
 * per-feature caches — because each was ported from its own Rust source file
 * with no shared registry in mind. Forcing them into one mapped-type object
 * would mean either rewriting all 31 modules' signatures (out of scope: this
 * step adds wiring, it does not touch already-ported modules' logic) or
 * hand-writing ~296 one-line adapter closures that re-dispatch to the real
 * functions — doubling the surface that can drift, for a guarantee that would
 * only prove the ADAPTERS are complete, not the real handlers.
 *
 * So the completeness guarantee here is built from two pieces instead:
 *
 *  1. {@link ALL_COMMAND_NAMES} (`src/shared/channelAllowlist.ts`) — a
 *     runtime array of every key of `Commands`, produced from a
 *     `Record<keyof Commands, true>` OBJECT LITERAL that TypeScript refuses to
 *     compile if it is missing a key `Commands` has or lists one it doesn't.
 *     That is the "missing or misspelled name is a compile error" property,
 *     scoped honestly to command NAMES rather than to full handler signatures.
 *  2. {@link registerAllIpc} wraps the real `ipcMain` in a small recording
 *     shim before handing it to any `registerXIpc` call, so it observes the
 *     exact channel strings each one actually registers — no guessing, no
 *     re-declaring. {@link checkCompleteness} then diffs that observed set
 *     against {@link ALL_COMMAND_NAMES}, using
 *     {@link KNOWN_UNREGISTERED_COMMANDS} (now empty after cutover) as the
 *     EXPECTED difference. A test asserts the diff equals that
 *     list exactly in BOTH directions — so a channel silently dropped from a
 *     module fails the build (missing and undocumented), and so does a stale
 *     entry left behind once a future step actually wires it (documented but
 *     no longer missing). The gap list cannot drift from reality without a
 *     failing test forcing it to be updated.
 *
 * ============================================================================
 * THE ROOM-SOURCE ADAPTER PROBLEM
 * ============================================================================
 * There is no ONE `RoomSource` type in this tree. Reading the room-scoped
 * modules surfaced several structurally distinct "which room is open"
 * interfaces, none of them importing a shared one:
 *
 *   - `{ currentRoom(): { db, path } | null }` — `OpenRoom` (`turnEngine.ts`),
 *     independently re-declared by name in `docxEdit.ts`/`editGate.ts`/
 *     `moonshotCmds.ts`/`officeTools.ts`/`peaksTools.ts`/`previewTools.ts`/
 *     `recIpc.ts`/`searchTools.ts`/`sketchIpc.ts`/`skillsCmds.ts`/
 *     `spreadsheetTools.ts`/`storyTools.ts`/`visionTools.ts`/
 *     `workflowCompose.ts`, and imported straight from `recIpc.ts`/
 *     `moonshotCmds.ts` by `sttTools.ts`/`moonshotFrontPage.ts`/
 *     `moonshotGraph.ts`.
 *   - `{ currentRoom(): { db, path } | null; roomEpoch(): number }` —
 *     `videoTools.ts`'s own widened `RoomSource`.
 *   - `{ currentRoom(): { db, path, name } | null; rollingBack?(): boolean }`
 *     — `moonshotAiActions.ts`'s (`RoomHandle extends OpenRoom`).
 *   - `{ currentRoom(): { path, name, db } | null }` — `moonshotServer.ts`'s
 *     `RoomServerRoomSource`.
 *   - `{ current(): { db, path } | null }` — `jobs.ts`'s (note the DIFFERENT
 *     method name), used by `libraryTools.ts`'s `PolicyDeps.room` and imported
 *     directly by `studiosPodcastAudio.ts`.
 *   - `{ currentRoom(): { conn, path, password } | null }` —
 *     `safetyTools.ts`'s `SafetyRoomSource` (note `conn`, not `db`).
 *
 * TypeScript's structural typing (and return-type covariance for method
 * signatures) means ONE object satisfies every `currentRoom()`-shaped
 * interface at once, as long as it returns the WIDEST shape
 * ({@link AppRoomHandle} = `{ db, path, name }`) and additionally exposes
 * `roomEpoch()`/`rollingBack()`. {@link buildRoomSource} is that object, built
 * directly off `roomManager.ts`'s own {@link RoomManagerState} — the real "one
 * open room for the whole process" host state `roomManagerIpc.ts`/
 * `roomCheckpoints.ts`/`chatCmds.ts` already register against, so a room
 * opened through `open_room` is immediately visible to every other module's
 * handlers in the SAME run.
 *
 * The two shapes that genuinely cannot be satisfied by that one object (a
 * different METHOD name; a different FIELD name) reuse what already exists
 * rather than inventing a third adapter: `roomManager.ts` already exports
 * {@link toRoomSource} for `jobs.ts`'s `.current()`, and `state.room` itself
 * already carries `conn`/`path`/`password` for `safetyTools.ts`.
 *
 * ============================================================================
 * WHAT "BEST-EFFORT DEPS" MEANS FOR EACH WIRED MODULE
 * ============================================================================
 * Every module below is handed REAL, working logic wherever a real
 * implementation exists in this tree — including the seams it is easy to
 * silently drop on the floor, each of which is a real, observable behavior if
 * wired and a silent no-op if not:
 *
 *   - `emit` reaches `safetyTools.ts` (`restore_file_version`'s
 *     `room-files-changed` + `file-updated`), `videoTools.ts` (`video_trim`/
 *     `save_video_frame`'s `room-files-changed`), `workflowCompose.ts`
 *     (`compose_workflow`'s `workflows-changed`), and every module that takes
 *     an `EmitFn`/`EventSender` at all. Omitting it compiles fine and leaves
 *     the renderer never told the room changed.
 *   - `isRollingBack` is the REAL `state.rollingBack` flag, not the modules'
 *     "never busy" default, so a rollback in flight actually refuses the
 *     commands their own ports already guard (`safetyTools.ts`'s
 *     `restoreVersionInto` path, `workflowCompose.ts`'s compose).
 *   - `explicitModel` reads the OPEN ROOM's own `model` setting
 *     (`gatherContext.ts`'s `modelSetting`), so `ai_status`/`warm_model`/
 *     `grounding_model_for_room` answer for the room the user actually has
 *     open rather than always falling back to a global default.
 *   - `diarizeModelPath` (see {@link createLiveRecBridgeCtx}) resolves the
 *     BUNDLED TitaNet speaker model. Omitted — which is how this shipped —
 *     every live recording POSTs `diarizeModelPath: null`, the sidecar
 *     silently substitutes a 21-dim DSP embedding, and saved-voice enrollment
 *     plus cross-recording recognition cannot work at all while Settings
 *     still shows their UI.
 *   - `enqueueStt` reaches `chatCmds.ts` (pasted/imported audio) AND
 *     `videoTools.ts` (a trimmed clip). Both are optional, so an unwired one
 *     costs a transcript rather than failing anything: `videoTools.ts` swallows
 *     it in a `try`/`catch`, and `chatCmds.ts` falls back to
 *     `enqueueSttNotImplemented`, which logs loudly to the console and nowhere
 *     the user can see. `videoTools.ts`'s was in fact unwired.
 *   - `resourcesPath` on `registerMediaDownloadSurfaceIpc` is the sixth
 *     positional argument and DEFAULTS to `null`. Omitted, a packaged build's
 *     downloads never find the bundled speech/speaker weights and every
 *     downloaded podcast answers `model-missing` — while Settings, which reads
 *     the same weights through `resourcesPath`, says the model is installed.
 *
 * Optional dependency seams retain explicit defaults for isolated unit tests.
 * The production bootstrap overlays the live room server, backfill, STT, job,
 * workflow, browser, connector, privacy, and turn-engine services.
 *
 * ============================================================================
 * THE HOST BRIDGE — five channels this file registers directly
 * ============================================================================
 * Everything above is a `registerXIpc(...)` call. Five channels are not, and
 * are registered by {@link registerAllIpc} itself, through the SAME recording
 * shim so the completeness diff still sees them:
 *
 *   - `run_command` — the `#command` dispatch surface. Its dependency bundle
 *     is `liveContext.ts`'s `assembleLiveContext(state, emit)`, built from the
 *     same `state`/`emit` every module above closes over, so a `#command` run
 *     sees the room `open_room` opened in this same process. `runCommand`
 *     itself owns the catalog validation and the "No room is open." refusal;
 *     this registration adds nothing but the channel.
 *   - `set_unsaved_edits` / `quit_guard_rearm` / `quit_guard_confirm` —
 *     `quitDoor.ts`'s three renderer-facing questions (the first two are
 *     Rust's `commands/shell_exit.rs`; the third replaces the
 *     `@tauri-apps/plugin-process` `exit(0)` the frontend used to finish a
 *     held quit with, which an isolated Electron renderer cannot do).
 *   - `menu_sync` — `menu.ts`'s push of the window's layout state onto the
 *     live native menu.
 *
 * The last four act on objects this file cannot build: the process's ONE
 * `QuitDoor`, the ONE installed `Electron.Menu` and the real `app`, all owned
 * by `main/index.ts`. They arrive as {@link HostBridge}, a required option —
 * required, not optional, because {@link KNOWN_UNREGISTERED_COMMANDS} does not
 * list these five, so a caller that could omit them would boot a registry the
 * completeness invariant correctly refuses.
 *
 * WHY HERE AND NOT IN `index.ts` DIRECTLY, since that is where the objects
 * live: a channel registered outside {@link registerAllIpc} is invisible to
 * the recording shim, so the registry would keep reporting it as an unwired
 * gap while it was in fact live — the exact drift `KNOWN_UNREGISTERED_COMMANDS`
 * exists to make impossible, and a `goneStale` entry nothing would ever catch.
 * One place registers channels; that property is worth more than the tidiness
 * of keeping this file free of `handle` calls.
 *
 * ============================================================================
 * PRODUCTION SURFACES ASSEMBLED BY SIBLING REGISTRARS
 * ============================================================================
 * The turn engine, `exec_tool`, MCP, browser, jobs/workflows, files, scripts,
 * speech, and creative surfaces are registered through the focused surface
 * registrars imported below. They share this registry's room state and live
 * service graph.
 *
 * The ad-blocker/webRequest funnel and DB isolation remain owned by their
 * dedicated modules rather than duplicated here.
 */

import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type Database from "better-sqlite3-multiple-ciphers";

import {
  createRoomManagerState,
  spawnRoomServerIfEnabledNotImplemented,
  toRoomSource as toJobsRoomSource,
  type RoomManagerDeps,
  type RoomManagerState,
} from "../roomManager.js";
import type { SafetyOpenRoom, SafetyRoomSource } from "../safetyTools.js";
import type { EventSender } from "../turn.js";
import { modelSetting } from "../gatherContext.js";
import { SttModelState, sttEffectiveModel } from "../sttTools.js";
import {
  diarizeEffectiveModel,
  transcribeMediaWithSpeakers,
  type MediaTranscribeDeps,
} from "../mediaTranscribeJob.js";
import { createPeakCache } from "../peaksTools.js";
import { createSlideCache } from "../officeTools.js";
import { createRecBridgeCtx, recStop, type RecBridgeCtx } from "../recBridge.js";
import type { OpenRoom } from "../turnEngine.js";
import { createJobQueueState, defaultRowStarters } from "../jobQueue.js";
import { startRecRead } from "../recRead.js";
import { listModels } from "../engineRouting.js";
import { bestLocalDefault } from "../ollamaModels.js";
import { runsOnThisMac } from "../capabilities.js";
import { configureVisualIndexDir } from "../sidecar.js";
import { videoVisualIndex } from "../videoVisualIndex.js";
import { createSchedulerState, startWorkflowRunNotImplemented } from "../jobScheduler.js";
import type { JobProgressPayload } from "../jobs.js";
import {
  createRemoveDiscovery,
  createRoomServerDeps,
  createSpawnRoomServerIfEnabled,
  roomServerRoomSource,
  roomServerSlotOver,
  type RoomServerDepsOptions,
} from "../roomServerLive.js";

import { registerRoomManagerIpc } from "../roomManagerIpc.js";
import { registerRoomCheckpointsIpc } from "../roomCheckpoints.js";
import { registerChatIpc } from "../chatCmds.js";
import { registerDictIpc } from "../dictStopTimeout.js";
import { registerDocxEditIpc } from "../docxEdit.js";
import { registerEditGateIpc } from "../editGate.js";
import { registerLibraryIpc } from "../libraryTools.js";
import { registerMoonshotAiActionsIpc } from "../moonshotAiActions.js";
import { registerMoonshotIpc } from "../moonshotCmds.js";
import { registerFrontPageIpc } from "../moonshotFrontPage.js";
import { registerRoomGraphIpc } from "../moonshotGraph.js";
import { registerRolesIpc } from "../moonshotRoles.js";
import { registerMoonshotServerIpc } from "../moonshotServer.js";
import { registerOfficeIpc } from "../officeTools.js";
import { defaultAiStatusDeps, registerOllamaModelsIpc } from "../ollamaModels.js";
import { detectedExternal, ollamaInstalled } from "../externalDetection.js";
import { registerPeaksIpc } from "../peaksTools.js";
import { registerPreviewIpc, renderQuickLook } from "../previewTools.js";
import { registerRecIpc } from "../recIpc.js";
import { registerRecentIpc } from "../recentTools.js";
import { registerRuntimesIpc } from "../runtimesCmds.js";
import { registerSafetyIpc } from "../safetyTools.js";
import { registerSearchIpc } from "../searchTools.js";
import { registerSketchIpc } from "../sketchIpc.js";
import { registerSkillsIpc } from "../skillsCmds.js";
import { registerSpreadsheetIpc } from "../spreadsheetTools.js";
import { registerStoryIpc } from "../storyTools.js";
import { registerSttToolsIpc } from "../sttTools.js";
import { registerStudiosPodcastAudioIpc } from "../studiosPodcastAudio.js";
import { registerVideoIpc } from "../videoTools.js";
import { registerVisionIpc } from "../visionTools.js";
import {
  generateTextAnyEngine,
  registerWorkflowComposeIpc,
  withRealOllamaGenerate,
} from "../workflowCompose.js";
// The two plugin-surface modules. Like every module above they import
// `electron` for TYPES only, so pulling them in here costs this file nothing at
// runtime; the real `dialog`/`shell` objects arrive through
// {@link RegisterAllIpcOptions}, injected by `main/index.ts`.
import { registerDialogIpc, type DialogDeps } from "../dialogTools.js";
import { registerShellIpc, type ShellDeps } from "../shellTools.js";
import { registerCoreSurfaceIpc } from "../coreSurfaceIpc.js";
import { registerFileSurfaceIpc } from "../fileSurfaceIpc.js";
import { createMcpRuntime, registerMcpSurfaceIpc } from "../mcpSurfaceIpc.js";
import { registerBrowserSurfaceIpc } from "../browserSurfaceIpc.js";
import type { WindowContentView } from "../browser/webviewManager.js";
import { registerJobWorkflowSurfaceIpc } from "../jobWorkflowSurfaceIpc.js";
import { registerFileRuntimeSurfaceIpc, type FileRuntimeStores } from "../fileRuntimeSurfaceIpc.js";
import { registerMediaDownloadSurfaceIpc } from "../mediaDownloadSurfaceIpc.js";
import { registerScriptSurfaceIpc } from "../scriptSurfaceIpc.js";
import { registerModelCatalogSurfaceIpc } from "../modelCatalogSurfaceIpc.js";
import { registerSpeechSttSurfaceIpc } from "../speechSttSurfaceIpc.js";
import { registerChatTurnSurfaceIpc } from "../chatTurnSurfaceIpc.js";
import { createWorkflowAgentRun } from "../workflowAgentRun.js";
import { registerAgentUiSurfaceIpc } from "../agentUiSurfaceIpc.js";
import { registerCreativeJobSurfaceIpc } from "../creativeJobSurfaceIpc.js";
import { registerHarnessSurfaceIpc } from "../harnessSurfaceIpc.js";
import { createLiveAutoIndex } from "../autoIndexLive.js";
import { refreshMcpConnections, type LiveAppServices } from "../liveAppServices.js";
import {
  createEmbedBackfillState,
  spawnEmbeddingBackfill,
  spawnLegacyTextRepair,
  spawnReextractBackfill,
} from "../retrievalBackfill.js";
import { forgetRoomMemory } from "../sidecar.js";
import { extractDocumentText } from "../documentExtraction.js";

// ---- the host bridge's own three dependencies (see the module doc) --------
import { runCommand, type RunCommandRequest } from "../chatCommands.js";
import { assembleLiveContext } from "../liveContext.js";
import type { ViewMenuState } from "../menu.js";

// ============================================================================
// The compile-checked command-name list (see module doc, point 1)
// ============================================================================

// The list itself lives in `src/shared/channelAllowlist.ts` — see that
// file's own doc for why it is separate: `src/preload/index.ts` needs the
// exact same compile-checked name list to build its channel allowlist, but
// must never pull in this file's full main-process module graph (native
// bindings, Node-only modules). Re-exported here so a caller of the registry
// does not need a second import just to name the contract.
export { ALL_COMMAND_NAMES } from "../../shared/channelAllowlist.js";
import { ALL_COMMAND_NAMES } from "../../shared/channelAllowlist.js";

/** How many `registerXIpc` modules {@link registerAllIpc} calls. Derived by
 * counting {@link registerAllIpc}'s own calls at test time (see
 * `registry.test.ts`), NOT hand-maintained here — a hardcoded count is exactly
 * the kind of claim that goes quietly wrong (one candidate shipped
 * `moduleCount: 30` next to 31 real calls, with a test asserting the 30). */
export const WIRED_MODULE_COUNT = 44;

// ============================================================================
// The honest gap list (see module doc, point 2)
// ============================================================================

/**
 * The set is intentionally empty after the complete command cutover.
 * {@link checkCompleteness} re-verifies it against the observed registry on
 * every run, so any missing channel immediately fails tests and bootstrap.
 */
export const KNOWN_UNREGISTERED_COMMANDS: ReadonlySet<string> = new Set<string>([
]);

/**
 * Channels a wired module registers that are NOT a key of `Commands` at all.
 * Exactly two, both real and both deliberate:
 *
 *   - `restore_memory`: `libraryTools.ts`'s real, working S9 soft-delete-undo
 *     command. `ipc-contract.ts` was extracted byte-faithfully from the
 *     pre-migration frontend's `api.ts` call sites, so a backend command the
 *     OLD frontend never called is simply absent from it. A future renderer
 *     step either adds it to `Commands` (exposing the recovery UI) or leaves
 *     it unreached — either way this registry must not treat a real,
 *     already-shipped handler as an error.
 *   - `dict-stop-timeout`: `dictStopTimeout.ts`'s
 *     `DICT_STOP_TIMEOUT_CHANNEL` — note the hyphen. A renderer-local timing
 *     helper, never a Tauri-era `#[tauri::command]` name, so `ipc-contract.ts`
 *     has no reason to know it.
 *
 * NOTE: these two are NOT on the preload's invoke allowlist (which is exactly
 * `keyof Commands`), so neither is reachable from the renderer today. That is
 * the correct, conservative default: `restore_memory` has no UI yet, and
 * `dict-stop-timeout` becomes reachable when a renderer actually needs it and
 * the contract says so. Registered-but-unreachable is a documented state here,
 * not an oversight. */
export const KNOWN_EXTRA_CHANNELS: ReadonlySet<string> = new Set<string>([
  "restore_memory",
  "dict-stop-timeout",
]);

// ============================================================================
// Completeness check
// ============================================================================

export interface CompletenessReport {
  ok: boolean;
  totalCommandCount: number;
  registeredCount: number;
  /** In `Commands`, not registered, and NOT in
   * {@link KNOWN_UNREGISTERED_COMMANDS} — a real regression: something that
   * used to be covered (or was expected to be) silently isn't. */
  missingUndocumented: string[];
  /** In {@link KNOWN_UNREGISTERED_COMMANDS} but ACTUALLY registered — the gap
   * list is stale and must be trimmed; keeps the documentation honest rather
   * than letting it silently overclaim what's missing. */
  goneStale: string[];
  /** Registered, but neither a key of `Commands` nor in
   * {@link KNOWN_EXTRA_CHANNELS} — a typo'd or invented channel string. */
  unexpectedChannels: string[];
}

/** Diff the set of channel strings actually registered against the
 * compile-checked full command list, using {@link KNOWN_UNREGISTERED_COMMANDS}
 * / {@link KNOWN_EXTRA_CHANNELS} as the expected difference. `ok` is true only
 * when the diff matches EXACTLY what is documented — nothing more, nothing
 * less. */
export function checkCompleteness(registeredChannels: ReadonlySet<string>): CompletenessReport {
  const allSet = new Set<string>(ALL_COMMAND_NAMES);
  const missing = ALL_COMMAND_NAMES.filter((c) => !registeredChannels.has(c));
  const missingUndocumented = missing.filter((c) => !KNOWN_UNREGISTERED_COMMANDS.has(c));
  const goneStale = [...KNOWN_UNREGISTERED_COMMANDS].filter((c) => registeredChannels.has(c));
  const unexpectedChannels = [...registeredChannels].filter(
    (c) => !allSet.has(c) && !KNOWN_EXTRA_CHANNELS.has(c)
  );
  return {
    ok:
      missingUndocumented.length === 0 &&
      goneStale.length === 0 &&
      unexpectedChannels.length === 0,
    totalCommandCount: ALL_COMMAND_NAMES.length,
    registeredCount: registeredChannels.size,
    missingUndocumented,
    goneStale,
    unexpectedChannels,
  };
}
export { buildRoomSource, buildExplicitModel, buildSafetyRoomSource, readViewMenuState, createLiveRecBridgeCtx, createDefaultRoomManagerDeps, createLiveRoomManagerDeps } from "./registryRoomDeps.js";
export type { AppRoomHandle, HostBridge, RegisterAllIpcOptions, RegisterAllIpcResult } from "./registryRoomDeps.js";

export { registerAllIpc } from "./registerAllIpc.js";


// Re-export so a caller building `RoomManagerState` doesn't need a second
// import from `roomManager.js` just for the constructor.
export { createRoomManagerState };
