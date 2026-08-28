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
import { retranscribeFile } from "../speechSttSurfaceIpc.js";
import { createPeakCache } from "../peaksTools.js";
import { createSlideCache } from "../officeTools.js";
import { createRecBridgeCtx, recStop, type RecBridgeCtx } from "../recBridge.js";
import type { OpenRoom } from "../turnEngine.js";
import { createJobQueueState, defaultRowStarters } from "../jobQueue.js";
import { startRecRead } from "../recRead.js";
import { listModels } from "../engineRouting.js";
import { bestLocalDefault } from "../ollamaModels.js";
import { runsOnThisMac } from "../capabilities.js";
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

// ============================================================================
// Room-source adapters (see module doc, "THE ROOM-SOURCE ADAPTER PROBLEM")
// ============================================================================

/** The widest `currentRoom()` shape any wired module's `RoomSource` needs — a
 * superset of `OpenRoom` (`{db, path, workspace?}`), `moonshotAiActions.ts`'s `RoomHandle`
 * (`OpenRoom` + `name`), and `moonshotServer.ts`'s `RoomServerRoomSource`
 * (`{path, name, db}`). Field order is irrelevant — TypeScript's structural
 * typing only checks presence and type. */
export interface AppRoomHandle {
  db: Database.Database;
  path: string;
  name: string;
  /** Preserve the hybrid room's normal-file service. Dropping this field made
   * every module registered through this shared adapter silently take its
   * legacy database-blob branch even while a workspace room was open. */
  workspace?: OpenRoom["workspace"];
}

/** One object, built off the real {@link RoomManagerState}, that structurally
 * satisfies every `{ currentRoom(): ... }`-shaped `RoomSource` in the wired
 * modules at once — see the module doc for the full list of interfaces this
 * matches and why return-type covariance makes one object enough. */
export function buildRoomSource(state: RoomManagerState): {
  currentRoom(): AppRoomHandle | null;
  roomEpoch(): number;
  rollingBack(): boolean;
} {
  return {
    currentRoom: (): AppRoomHandle | null =>
      state.room === null
        ? null
        : {
            db: state.room.conn,
            path: state.room.path,
            name: state.room.name,
            workspace: state.room.workspace,
          },
    roomEpoch: (): number => state.roomEpoch,
    rollingBack: (): boolean => state.rollingBack,
  };
}

/**
 * The OPEN ROOM's own configured chat model, read live on every call — the
 * seam `ai_status`/`warm_model`/`grounding_model_for_room` resolve through.
 *
 * A named, exported builder for the same reason {@link buildRoomSource} is
 * one: it is a dependency this registry SYNTHESISES rather than forwards, so
 * without a seam the only way to check it is a network-backed handler
 * (`groundingModelForRoom` calls `listModels()` before it ever reaches the
 * value). Regressing this to a constant `() => null` — which is exactly the
 * modules' own default, and what one merge candidate shipped — compiles
 * cleanly and makes those three commands answer for a room the user does not
 * have open. That must be able to fail a test.
 */
export function buildExplicitModel(state: RoomManagerState): () => string | null {
  return (): string | null => (state.room === null ? null : modelSetting(state.room.conn));
}

/** `safetyTools.ts`'s `SafetyRoomSource` needs `conn`/`path`/`password` — a
 * DIFFERENT field name (`conn`, not `db`), so {@link buildRoomSource} cannot
 * satisfy it. No adapter object is needed either: `RoomManagerState.room`
 * (`roomManager.ts`'s own `Room`) already carries `conn`/`path`/`name`/
 * `password` — a strict superset of {@link SafetyOpenRoom} — so it is returned
 * directly. */
export function buildSafetyRoomSource(state: RoomManagerState): SafetyRoomSource {
  return {
    currentRoom: (): SafetyOpenRoom | null => state.room,
  };
}

// ============================================================================
// registerAllIpc
// ============================================================================

/**
 * The two host-owned objects three of {@link registerAllIpc}'s own channels
 * act on — see the module doc's "THE HOST BRIDGE".
 *
 * Methods rather than the objects themselves (`QuitDoor`, `Electron.Menu`), so
 * this file neither imports Electron's `Menu` type at runtime nor grows a
 * second opinion about how a menu is synced: the caller that built the menu
 * decides, and this file only decides WHEN.
 */
export interface HostBridge {
  /** `quitDoor.setUnsavedEdits` — the frontend's answer to "is there anything
   * to lose right now?". */
  setUnsavedEdits(on: boolean): void;
  /** `quitDoor.rearm` — the window answered the quit question with "no". */
  rearmQuitGuard(): void;
  /** `quitDoor.confirmQuit` + the real `app.quit()` — the window answered with
   * "yes". Both halves belong to the caller: this file has no `app`, and a
   * door cleared without an exit following would leave the user's answer
   * unanswered. */
  confirmQuit(): void;
  /** `menuSync(theInstalledMenu, view)` — push the window's layout state onto
   * the live native menu. */
  syncMenu(view: ViewMenuState): void;
  /** Electron app metadata and the signed bridge updater. */
  appVersion(): string;
  osVersion(): string;
  checkForUpdate(): Promise<{ version: string; notes?: string } | null>;
  installUpdate(): Promise<void>;
  windowContentView(): WindowContentView | null;
  focusMainWindow(): void;
  openPath(target: string): Promise<void>;
}

/**
 * Read `menu_sync`'s payload into a real {@link ViewMenuState}.
 *
 * An IPC payload is data from outside, and `menu.ts`'s own doc asks its caller
 * to do exactly this: "a caller relaying an IPC payload that might omit it
 * should default the field to `""` itself before calling in". Every flag
 * defaults to `false` — the safe direction for a tick (a row claiming a pane
 * is open when it is not is the lie worth avoiding) and for `enabled` (a
 * greyed row cannot mislead). `sidebar` defaults to `""`, which
 * `sidebarLabel` already turns back into the generic "Sidebar".
 */
export function readViewMenuState(args: unknown): ViewMenuState {
  const view = (args as { view?: Partial<ViewMenuState> } | null | undefined)?.view;
  return {
    enabled: view?.enabled === true,
    library: view?.library === true,
    assistant: view?.assistant === true,
    focus: view?.focus === true,
    railLabels: view?.railLabels === true,
    railLabelsSettable: view?.railLabelsSettable === true,
    sidebar: typeof view?.sidebar === "string" ? view.sidebar : "",
  };
}

export interface RegisterAllIpcOptions {
  ipcMain: Pick<IpcMain, "handle">;
  state: RoomManagerState;
  deps: RoomManagerDeps;
  /** The quit door, the live menu and the app's own exit — see
   * {@link HostBridge}. Required: the four channels it backs are not in
   * {@link KNOWN_UNREGISTERED_COMMANDS}, so a registry built without it would
   * fail its own completeness invariant. */
  host: HostBridge;
  /** Electron's real `dialog` plus the main window to sheet a panel onto —
   * `dialogTools.ts`'s own deps, injected here for the same reason `host` is:
   * this file must not import the `electron` module at runtime. */
  dialog: DialogDeps;
  /** Electron's real `shell` plus the `/usr/bin/open -a` bridge —
   * `shellTools.ts`'s own deps. */
  shell: ShellDeps;
  /** `window.webContents.send` fan-out, threaded to every module whose deps
   * accept one (`EmitFn`/`EventSender` — structurally identical
   * `(event: string, payload: unknown) => void` in every module that declares
   * it). */
  emit: EventSender;
  userDataDir: string;
  /** `process.resourcesPath`, or `null` for a build with no bundled STT
   * weights (every dev/test run). */
  resourcesPath: string | null;
}

export interface RegisterAllIpcResult {
  registeredChannels: ReadonlySet<string>;
  completeness: CompletenessReport;
  runtimeStores: FileRuntimeStores;
}

/** Production recording context. Kept as a named factory so the critical
 * Settings/recording STT resolver wiring is directly regression-testable. */
export function createLiveRecBridgeCtx(
  currentRoom: () => OpenRoom | null,
  userDataDir: string,
  resourcesPath: string | null,
): RecBridgeCtx {
  return createRecBridgeCtx({
    currentRoom,
    resolveSttModel: () => sttEffectiveModel(userDataDir, resourcesPath),
  });
}

/** Build the default {@link RoomManagerDeps} the registry boots with when the
 * caller has no fuller object graph to hand in yet — `userDataDir` and a real
 * `emit`, with every other seam left at its own honest default (see
 * `roomManager.ts`'s own doc on its two buckets).
 * `spawnRoomServerIfEnabled` is the one REQUIRED field `RoomManagerDeps` has
 * no default for; `spawnRoomServerIfEnabledNotImplemented` is
 * `roomManager.ts`'s own ready-made honest refusal for it, not one invented
 * here. */
export function createDefaultRoomManagerDeps(
  userDataDir: string,
  emit: EventSender
): RoomManagerDeps {
  return {
    userDataDir,
    emit,
    spawnRoomServerIfEnabled: spawnRoomServerIfEnabledNotImplemented,
  };
}

/** Production room-lifecycle dependencies. This closes the interrupted
 * migration's three live-wiring gaps: queued jobs are pumped after unlock,
 * the workflow scheduler performs its catch-up pass, and the persistent room
 * MCP server is started/stopped through the same RoomManagerState used by the
 * Settings IPC. */
export function createLiveRoomManagerDeps(
  state: RoomManagerState,
  userDataDir: string,
  emit: EventSender,
  roomServerOptions: RoomServerDepsOptions = {}
): RoomManagerDeps {
  const rooms = toJobsRoomSource(state);
  const embedState = createEmbedBackfillState();
  const roomServerDeps = createRoomServerDeps(state, emit, roomServerOptions);
  return {
    userDataDir,
    emit,
    scheduler: {
      deps: { rooms, startWorkflowRun: startWorkflowRunNotImplemented },
      state: createSchedulerState(),
    },
    jobQueue: {
      state: createJobQueueState(),
      rooms,
      sink: {
        emit: (payload: JobProgressPayload): void => emit("job-progress", payload),
      },
      cancelState: state.cancel,
      starters: defaultRowStarters(),
    },
    policy: { room: rooms, userDataDir },
    spawnEmbeddingBackfill: () => { spawnEmbeddingBackfill({ rooms }, embedState); },
    spawnReextractBackfill: () => spawnReextractBackfill({
      rooms,
      roomEpoch: () => state.roomEpoch,
      extractText: extractDocumentText,
      notifyFilesChanged: () => emit("room-files-changed", {}),
    }),
    spawnLegacyTextRepair: () => spawnLegacyTextRepair({
      rooms,
      roomEpoch: () => state.roomEpoch,
      extractText: extractDocumentText,
    }),
    noteRoomClosed: () => undefined,
    forgetRoomMemory,
    spawnRoomServerIfEnabled: createSpawnRoomServerIfEnabled(state, roomServerDeps),
    removeDiscovery: createRemoveDiscovery(roomServerOptions.discoveryHome),
  };
}

/**
 * Register every wired `registerXIpc` module's channels on the real
 * `ipcMain`, over one shared {@link RoomManagerState}, and return the
 * completeness diff described in the module doc.
 *
 * `ipcMain` is wrapped in a small recording shim before ANY module sees it:
 * every `.handle(channel, fn)` call is (a) recorded into the returned
 * `registeredChannels` set and (b) checked against every channel already seen
 * THIS CALL, throwing loudly on a genuine double-registration (two modules
 * claiming the same channel string) rather than depending on the particular
 * `ipcMain` to notice — the one failure mode a name-based completeness check
 * on its own could not catch.
 *
 * Call it exactly once per process: real Electron's `ipcMain.handle` throws on
 * a repeated channel, and this shim's own duplicate check is per-call.
 */
export function registerAllIpc(opts: RegisterAllIpcOptions): RegisterAllIpcResult {
  const { state, deps, emit, host, dialog, shell, userDataDir, resourcesPath } = opts;

  const registeredChannels = new Set<string>();
  const recordingIpcMain: Pick<IpcMain, "handle"> = {
    handle(
      channel: string,
      listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
    ) {
      if (registeredChannels.has(channel)) {
        throw new Error(
          `registry: channel "${channel}" was registered twice — two registerXIpc modules ` +
            "claim the same command name. This is a real conflict, not a completeness gap; " +
            "Electron's own ipcMain.handle would otherwise let the second registration " +
            "throw (or, on a permissive fake, silently win), hiding the first module's handler."
        );
      }
      registeredChannels.add(channel);
      opts.ipcMain.handle(channel, listener);
    },
  };

  const roomSource = buildRoomSource(state);
  const safetyRoomSource = buildSafetyRoomSource(state);
  const jobsRoomSource = toJobsRoomSource(state);
  /** The REAL rollback-in-flight flag, not the modules' "never busy" default —
   * see the module doc's "BEST-EFFORT DEPS". */
  const isRollingBack = (): boolean => state.rollingBack;

  // ---- room lifecycle + checkpoints + chat — the real RoomManagerState ----
  registerRoomManagerIpc(recordingIpcMain, state, deps);
  registerRoomCheckpointsIpc(recordingIpcMain, state, deps);
  registerChatIpc(recordingIpcMain, state, {
    enqueueStt: (job) => {
      void retranscribeFile(state, userDataDir, resourcesPath, emit, job.id, (roomPath) => deps.scheduleAutoIndex?.(roomPath)).catch((error) =>
        emit("stt-progress", [job.id, error instanceof Error ? error.message : String(error)]));
    },
  });

  // ---- the host bridge: the four channels this file registers itself ------
  // See the module doc's "THE HOST BRIDGE" for why these are here rather than
  // in `main/index.ts`, and why they go through `recordingIpcMain` like
  // everything else. `assembleLiveContext` closes over the SAME `state`/`emit`
  // as every module above, so a `#command` sees the room `open_room` opened.
  const liveContext = assembleLiveContext(state, emit, { userDataDir, resourcesPath });
  recordingIpcMain.handle("run_command", (_event: IpcMainInvokeEvent, args: unknown) =>
    runCommand(args as RunCommandRequest, liveContext.runCommandDeps)
  );
  recordingIpcMain.handle("set_unsaved_edits", (_event: IpcMainInvokeEvent, args: unknown): void => {
    const on = (args as { on?: unknown } | null | undefined)?.on;
    if (typeof on !== "boolean") {
      // Decided failure behavior: REFUSE, never coerce. Reading a malformed
      // payload as `false` would silently disarm the unsaved-edits guard and
      // the next ⌘Q would take the buffer with it — the exact bug
      // `quitDoor.ts` exists to have fixed once.
      throw new Error("set_unsaved_edits needs a boolean `on`.");
    }
    host.setUnsavedEdits(on);
  });
  recordingIpcMain.handle("quit_guard_rearm", (): void => {
    host.rearmQuitGuard();
  });
  recordingIpcMain.handle("quit_guard_confirm", (): void => {
    host.confirmQuit();
  });
  recordingIpcMain.handle("menu_sync", (_event: IpcMainInvokeEvent, args: unknown): void => {
    host.syncMenu(readViewMenuState(args));
  });
  recordingIpcMain.handle("app_version", (): string => host.appVersion());
  recordingIpcMain.handle("updater_check", () => host.checkForUpdate());
  recordingIpcMain.handle("updater_install", () => host.installUpdate());

  // ---- the two plugin surfaces: arcelle.dialog / arcelle.shell ------------
  registerDialogIpc(recordingIpcMain, dialog);
  registerShellIpc(recordingIpcMain, shell);
  registerCoreSurfaceIpc(recordingIpcMain, state, userDataDir, emit, host, deps);
  registerFileSurfaceIpc(recordingIpcMain, state, emit);
  const mcpRuntime = createMcpRuntime();
  deps.mcp = mcpRuntime.manager;
  registerMcpSurfaceIpc(
    recordingIpcMain,
    state,
    userDataDir,
    emit,
    mcpRuntime,
    (url) => shell.shell.openExternal(url).then(() => undefined),
  );
  const agentUiRuntime = registerAgentUiSurfaceIpc(
    recordingIpcMain,
    deps,
  );
  const browserRuntime = registerBrowserSurfaceIpc(recordingIpcMain, state, deps, userDataDir, emit, host);
  const sttModelState = new SttModelState();
  const runtimeStores = registerFileRuntimeSurfaceIpc(
    recordingIpcMain,
    state,
    deps,
    userDataDir,
    emit,
    host,
    {
      retranscribeImportedFile: (fileId) => retranscribeFile(
        state,
        userDataDir,
        resourcesPath,
        emit,
        fileId,
        (roomPath) => deps.scheduleAutoIndex?.(roomPath),
      ),
    },
  );
  registerMediaDownloadSurfaceIpc(
    recordingIpcMain,
    state,
    deps,
    userDataDir,
    emit,
  );
  const liveServices: LiveAppServices = {
    roomDeps: deps,
    userDataDir,
    mcp: mcpRuntime,
    agentUi: agentUiRuntime,
    files: runtimeStores,
    browser: browserRuntime,
    sttModelState,
    resourcesPath,
  };
  deps.workflowAgentRun = createWorkflowAgentRun(state, emit, liveServices);
  registerJobWorkflowSurfaceIpc(recordingIpcMain, state, deps, userDataDir, emit);
  deps.refreshMcp = () => refreshMcpConnections(state, liveServices);
  const liveRoomServerDeps = createRoomServerDeps(state, emit, { services: liveServices });
  deps.spawnRoomServerIfEnabled = createSpawnRoomServerIfEnabled(state, liveRoomServerDeps);
  registerChatTurnSurfaceIpc(
    recordingIpcMain,
    state,
    emit,
    mcpRuntime,
    liveServices,
  );
  registerScriptSurfaceIpc(
    recordingIpcMain,
    state,
    deps,
    userDataDir,
    emit,
  );
  registerModelCatalogSurfaceIpc(
    recordingIpcMain,
  );
  registerSpeechSttSurfaceIpc(
    recordingIpcMain,
    state,
    userDataDir,
    resourcesPath,
    emit,
    (roomPath) => deps.scheduleAutoIndex?.(roomPath),
  );
  registerCreativeJobSurfaceIpc(
    recordingIpcMain,
    state,
    deps,
    emit,
  );
  registerHarnessSurfaceIpc(recordingIpcMain, state, deps, userDataDir, emit, liveServices);
  deps.scheduleAutoIndex = createLiveAutoIndex(state, deps, emit);

  // ---- standalone channels with no room dependency ----
  registerDictIpc(recordingIpcMain);
  registerRolesIpc(recordingIpcMain);
  registerRecentIpc(recordingIpcMain, userDataDir, {
    trashItem: (targetPath) => shell.shell.trashItem(targetPath),
    currentRoomPath: () => state.room?.path ?? null,
  });
  registerRuntimesIpc(recordingIpcMain, userDataDir, emit);

  // ---- OpenRoom-shaped RoomSource modules ----
  registerDocxEditIpc(recordingIpcMain, roomSource, emit);
  registerEditGateIpc(recordingIpcMain, state.editPending);
  registerMoonshotIpc(recordingIpcMain, { rooms: roomSource });
  registerFrontPageIpc(recordingIpcMain, roomSource);
  registerRoomGraphIpc(recordingIpcMain, roomSource);
  registerOfficeIpc(recordingIpcMain, roomSource, createSlideCache(), renderQuickLook);
  registerPeaksIpc(recordingIpcMain, roomSource, createPeakCache());
  registerPreviewIpc(recordingIpcMain, roomSource, renderQuickLook);
  registerSearchIpc(recordingIpcMain, roomSource);
  registerSketchIpc(recordingIpcMain, roomSource, emit);
  registerSkillsIpc(recordingIpcMain, roomSource, emit, { isRollingBack });
  registerSpreadsheetIpc(recordingIpcMain, roomSource, emit);
  registerStoryIpc(recordingIpcMain, roomSource);
  registerVideoIpc(recordingIpcMain, roomSource, { emit });
  registerVisionIpc(recordingIpcMain, roomSource);
  registerWorkflowComposeIpc(recordingIpcMain, roomSource, {
    isRollingBack,
    generate: (model, prompt) => generateTextAnyEngine(model, prompt, withRealOllamaGenerate({})),
  }, emit);
  registerSttToolsIpc(recordingIpcMain, {
    userDataDir,
    resourcesPath,
    modelState: sttModelState,
    room: roomSource,
  });
  // Recording and Settings must resolve the SAME model. Before this explicit
  // dependency was wired, Settings correctly displayed "Voice model installed"
  // while createRecBridgeCtx's honest default always made rec_start answer
  // STT_MODEL_MISSING in the packaged app.
  const recCtx = createLiveRecBridgeCtx(() => roomSource.currentRoom(), userDataDir, resourcesPath);
  deps.stopRecordingAndWait = async (timeoutMs) => {
    if (recCtx.state.liveFileId === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        recStop(recCtx),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Timed out while saving the live recording.")), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  deps.stopRecordingNoWait = () => {
    if (recCtx.state.liveFileId !== null) void recStop(recCtx).catch(() => undefined);
  };
  registerRecIpc(recordingIpcMain, recCtx, roomSource, {
    readStart: async (_db, _ctx, id) => {
      if (deps.jobQueue === undefined) throw new Error("The background job queue is unavailable.");
      return startRecRead(deps.jobQueue, {
        resolvePassEngine: async () => {
          if (state.room === null) throw new Error("No room is open.");
          const models = await listModels();
          const model = modelSetting(state.room.conn) ?? bestLocalDefault(models);
          return { chatModel: model, lane: runsOnThisMac(model) ? "local_llm" : "cloud" };
        },
        onReadDone: (event) => emit("rec-read-done", event),
      }, id);
    },
    retranscribe: async (_db, _ctx, id) => {
      await retranscribeFile(state, userDataDir, resourcesPath, emit, id, (roomPath) => deps.scheduleAutoIndex?.(roomPath));
    },
  });

  // ---- RoomHandle(+name)-shaped / room-server-shaped RoomSource modules ----
  registerMoonshotAiActionsIpc(recordingIpcMain, {
    rooms: roomSource,
    cancelState: state.cancel,
    send: emit,
  });
  registerMoonshotServerIpc(
    recordingIpcMain,
    roomServerRoomSource(state),
    roomServerSlotOver(state),
    createRoomServerDeps(state, emit, { services: liveServices })
  );

  // ---- jobs.ts-shaped (`.current()`) RoomSource modules ----
  registerLibraryIpc(recordingIpcMain, { room: jobsRoomSource, userDataDir });
  registerStudiosPodcastAudioIpc(recordingIpcMain, jobsRoomSource);

  // ---- safetyTools.ts-shaped (`conn`/`password`) RoomSource ----
  registerSafetyIpc(recordingIpcMain, safetyRoomSource, {
    isRollingBack,
    emit,
    // `changePasswordCore`'s own doc: "CALLER OWNS THE IN-MEMORY PASSWORD …
    // A future host-state batch that wires registerSafetyIpc should pass an
    // `onPasswordChanged` that does exactly this." Without it, a successful
    // `change_password` leaves `state.room.password` holding the OLD secret,
    // and the next command that needs it — `duplicate_room`'s re-key,
    // `touchid_enable`'s Keychain write — fails (or silently stores the wrong
    // password) on a room that is perfectly fine.
    onPasswordChanged: (newPassword: string): void => {
      if (state.room !== null) {
        state.room.password = newPassword;
      }
    },
  });

  // ---- ollamaModels — its own deps shape, no RoomSource ----
  registerOllamaModelsIpc(recordingIpcMain, {
    cancelState: state.cancel,
    // The open room's own `model` setting, read live on every call — NOT a
    // constant `null`, which would make ai_status/warm_model/grounding answer
    // for a room the user does not have open.
    explicitModel: buildExplicitModel(state),
    aiStatusDeps: {
      ...defaultAiStatusDeps,
      detectedExternal,
      ollamaInstalled,
    },
  });

  return {
    registeredChannels,
    completeness: checkCompleteness(registeredChannels),
    runtimeStores,
  };
}

// Re-export so a caller building `RoomManagerState` doesn't need a second
// import from `roomManager.js` just for the constructor.
export { createRoomManagerState };
