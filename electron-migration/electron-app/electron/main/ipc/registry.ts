/**
 * THE IPC REGISTRY — the single place every `registerXIpc` module in
 * `electron/main/` gets wired onto a real `ipcMain`, over one shared object
 * graph, for the first time in this migration. Everything before this was
 * ported logic reachable only from its own `.test.ts`.
 *
 * ============================================================================
 * WHY NOT THE MAPPED-TYPE `defineHandlers` FORM THE PLAN DESCRIBES
 * ============================================================================
 * `pm-request/electron-python-migration-plan-2026-08-22.md` (Part B §2)
 * sketches a `defineHandlers(h: { [K in keyof Commands]: (a) => Promise<r> })`
 * shape, where a missing or misspelled handler is a compile error. That form
 * assumes ONE function per command, all sharing one dependency object. What
 * actually exists is 31 independently-authored `registerXIpc(ipcMain, ...)`
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
 *  1. {@link ALL_COMMAND_NAMES} (`electron/shared/channelAllowlist.ts`) — a
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
 *     {@link KNOWN_UNREGISTERED_COMMANDS} (this step's honestly-documented gap
 *     list) as the EXPECTED difference. A test asserts the diff equals that
 *     list exactly in BOTH directions — so a channel silently dropped from a
 *     module fails the build (missing and undocumented), and so does a stale
 *     entry left behind once a future step actually wires it (documented but
 *     no longer missing). The gap list cannot drift from reality without a
 *     failing test forcing it to be updated.
 *
 * ============================================================================
 * THE ROOM-SOURCE ADAPTER PROBLEM
 * ============================================================================
 * There is no ONE `RoomSource` type in this tree. Reading the 31 modules
 * surfaced several structurally distinct "which room is open" interfaces, none
 * of them importing a shared one:
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
 * Where a module's deps interface has an OPTIONAL seam this step has no live
 * implementation for yet (a room-server bridge dispatcher, an
 * embedding-backfill kick, an STT job enqueue), the module's OWN
 * already-shipped `NOT_IMPLEMENTED`/`SKIPPED` default is left in place —
 * nothing here fabricates a working answer for a seam its author already
 * documented as open.
 *
 * ============================================================================
 * NOT WIRED HERE, deliberately (SCOPE BOUNDARIES)
 * ============================================================================
 * A real `CmdCtx`/`ExecToolDeps` object graph for `#commands`/`exec_tool`, the
 * ad-blocker/webRequest funnel, and DB `utilityProcess` isolation are
 * untouched by this file — each is its own sequenced step. Their command
 * surface (`ask`, `run_command`, the `mcp_*` family, `browser_*`,
 * jobs/workflows CRUD) is exactly the bulk of
 * {@link KNOWN_UNREGISTERED_COMMANDS} below.
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
import { SttModelState } from "../sttTools.js";
import { createPeakCache } from "../peaksTools.js";
import { createSlideCache } from "../officeTools.js";
import { createRecBridgeCtx } from "../recBridge.js";
import type { RoomServerSlot } from "../moonshotServer.js";

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
import { registerOllamaModelsIpc } from "../ollamaModels.js";
import { registerPeaksIpc } from "../peaksTools.js";
import { registerPreviewIpc } from "../previewTools.js";
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
import { registerWorkflowComposeIpc } from "../workflowCompose.js";

// ============================================================================
// The compile-checked command-name list (see module doc, point 1)
// ============================================================================

// The list itself lives in `electron/shared/channelAllowlist.ts` — see that
// file's own doc for why it is separate: `electron/preload/index.ts` needs the
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
export const WIRED_MODULE_COUNT = 31;

// ============================================================================
// The honest gap list (see module doc, point 2)
// ============================================================================

/**
 * Every `Commands` key the 31 wired `registerXIpc` modules do not cover.
 * Every one belongs to a subsystem with no `registerXIpc` module yet (the turn
 * engine's `ask`/`run_command`/`cancel_ask`/`handoff_chat`, the `mcp_*`
 * connector family, every `browser_*` channel, jobs/workflows CRUD, file
 * trash/versions beyond what `safetyTools.ts` covers, the privacy command
 * surface, and a handful of others) — none is a channel a wired module
 * silently dropped. {@link checkCompleteness} re-verifies this set against the
 * OBSERVED gap on every run, so it cannot go stale without a failing test.
 */
export const KNOWN_UNREGISTERED_COMMANDS: ReadonlySet<string> = new Set<string>([
  "add_privacy_block",
  "app_diag",
  "approve_mcp",
  "ask",
  "browser_clear_journal",
  "browser_clear_scope",
  "browser_close_tab",
  "browser_focus_app",
  "browser_go",
  "browser_info",
  "browser_journal",
  "browser_navigate",
  "browser_new_tab",
  "browser_page_selection",
  "browser_page_text",
  "browser_peek",
  "browser_preview",
  "browser_retry_protection",
  "browser_save_page",
  "browser_search",
  "browser_search_summary",
  "browser_select_tab",
  "browser_set_bounds",
  "browser_set_takeover",
  "browser_tabs",
  "browser_verify_private",
  "cancel_ask",
  "cancel_job",
  "cancel_media_download",
  "connect_ai_provider",
  "decode_file_text",
  "delete_file_permanently",
  "delete_files_permanently",
  "delete_job",
  "delete_workflow",
  "disconnect_ai_provider",
  "empty_trash",
  "engine_capabilities",
  "engine_preflight",
  "engine_support_matrix",
  "feedback_draft",
  "get_file_content",
  "get_job_step_artifact",
  "get_mcp_auto_approve",
  "get_mcp_connector_powers",
  "get_mcp_outbound_unmask",
  "get_workflow_runs",
  "get_workflow_schedule",
  "handoff_chat",
  "import_files",
  "import_link",
  "import_media_url",
  "import_search_result",
  "list_ai_providers",
  "list_chat_commands",
  "list_create_models",
  "list_engine_models",
  "list_files",
  "list_jobs",
  "list_media_formats",
  "list_neural_voices",
  "list_scripts",
  "list_specialists",
  "list_trashed_files",
  "list_workflows",
  "mcp_apply_config",
  "mcp_get_config",
  "mcp_get_tool_prefs",
  "mcp_oauth_authorize",
  "mcp_oauth_sign_out",
  "mcp_oauth_status",
  "mcp_registry_optin_status",
  "mcp_registry_search",
  "mcp_remove_server",
  "mcp_set_server_enabled",
  "mcp_set_tool_enabled",
  "mcp_status",
  "menu_sync",
  "move_files_to_folder",
  "open_html_in_browser",
  "open_scratch_pad",
  "privacy_preview",
  "privacy_status",
  "quit_guard_rearm",
  "remove_privacy_entity",
  "rename_file",
  "resolve_agent_ui",
  "resolve_mcp_call",
  "resolve_script_run",
  "restore_file",
  "restore_files",
  "resume_job",
  "retranscribe_file",
  "reveal_logs",
  "run_command",
  "run_script",
  "run_workflow",
  "save_generated_file",
  "save_workflow",
  "set_file_in_library",
  "set_mcp_auto_approve",
  "set_mcp_connector_power",
  "set_mcp_outbound_unmask",
  "set_mcp_registry_optin",
  "set_privacy_concepts",
  "set_privacy_global",
  "set_privacy_room",
  "set_script_schedule",
  "set_unsaved_edits",
  "set_workflow_pinned",
  "set_workflow_schedule",
  "set_workflow_status",
  "speak_text_neural",
  "stage_preview_html",
  "start_create_job",
  "start_deep_summary",
  "start_download_job",
  "start_podcast_audio_job",
  "start_privacy_scan",
  "start_shot_list_job",
  "start_studio_job",
  "story_film_plan",
  "studio_prompts",
  "trash_file",
  "trash_files",
  "update_file_content",
  "update_workflow",
  "validate_workflow",
  "web_search_test",
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
 * superset of `OpenRoom` (`{db, path}`), `moonshotAiActions.ts`'s `RoomHandle`
 * (`OpenRoom` + `name`), and `moonshotServer.ts`'s `RoomServerRoomSource`
 * (`{path, name, db}`). Field order is irrelevant — TypeScript's structural
 * typing only checks presence and type. */
export interface AppRoomHandle {
  db: Database.Database;
  path: string;
  name: string;
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
        : { db: state.room.conn, path: state.room.path, name: state.room.name },
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

export interface RegisterAllIpcOptions {
  ipcMain: Pick<IpcMain, "handle">;
  state: RoomManagerState;
  deps: RoomManagerDeps;
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
  const { state, deps, emit, userDataDir, resourcesPath } = opts;

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
  registerChatIpc(recordingIpcMain, state);

  // ---- standalone channels with no room dependency ----
  registerDictIpc(recordingIpcMain);
  registerRolesIpc(recordingIpcMain);
  registerRecentIpc(recordingIpcMain, userDataDir);
  registerRuntimesIpc(recordingIpcMain, userDataDir, emit);

  // ---- OpenRoom-shaped RoomSource modules ----
  registerDocxEditIpc(recordingIpcMain, roomSource, emit);
  registerEditGateIpc(recordingIpcMain, state.editPending);
  registerMoonshotIpc(recordingIpcMain, { rooms: roomSource });
  registerFrontPageIpc(recordingIpcMain, roomSource);
  registerRoomGraphIpc(recordingIpcMain, roomSource);
  registerOfficeIpc(recordingIpcMain, roomSource, createSlideCache());
  registerPeaksIpc(recordingIpcMain, roomSource, createPeakCache());
  registerPreviewIpc(recordingIpcMain, roomSource);
  registerSearchIpc(recordingIpcMain, roomSource);
  registerSketchIpc(recordingIpcMain, roomSource, emit);
  registerSkillsIpc(recordingIpcMain, roomSource, emit);
  registerSpreadsheetIpc(recordingIpcMain, roomSource, emit);
  registerStoryIpc(recordingIpcMain, roomSource);
  registerVideoIpc(recordingIpcMain, roomSource, { emit });
  registerVisionIpc(recordingIpcMain, roomSource);
  registerWorkflowComposeIpc(recordingIpcMain, roomSource, { isRollingBack }, emit);
  registerSttToolsIpc(recordingIpcMain, {
    userDataDir,
    resourcesPath,
    modelState: new SttModelState(),
    room: roomSource,
  });
  registerRecIpc(
    recordingIpcMain,
    createRecBridgeCtx({ currentRoom: () => roomSource.currentRoom() }),
    roomSource
  );

  // ---- RoomHandle(+name)-shaped / room-server-shaped RoomSource modules ----
  registerMoonshotAiActionsIpc(recordingIpcMain, {
    rooms: roomSource,
    cancelState: state.cancel,
    send: emit,
  });
  const roomServerSlot: RoomServerSlot = { bridge: null };
  registerMoonshotServerIpc(recordingIpcMain, roomSource, roomServerSlot);

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
  });

  return {
    registeredChannels,
    completeness: checkCompleteness(registeredChannels),
  };
}

// Re-export so a caller building `RoomManagerState` doesn't need a second
// import from `roomManager.js` just for the constructor.
export { createRoomManagerState };
