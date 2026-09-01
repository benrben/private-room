import type { IpcMain } from "electron";
import type Database from "better-sqlite3-multiple-ciphers";
import { spawnRoomServerIfEnabledNotImplemented, toRoomSource as toJobsRoomSource, type RoomManagerDeps, type RoomManagerState } from "../roomManager.js";
import type { SafetyOpenRoom, SafetyRoomSource } from "../safetyTools.js";
import type { EventSender } from "../turn.js";
import { modelSetting } from "../gatherContext.js";
import { sttEffectiveModel } from "../sttTools.js";
import { diarizeEffectiveModel } from "../mediaTranscribeJob.js";
import { createRecBridgeCtx, type RecBridgeCtx } from "../recBridge.js";
import type { OpenRoom } from "../turnEngine.js";
import { createJobQueueState, defaultRowStarters } from "../jobQueue.js";
import { createSchedulerState, startWorkflowRunNotImplemented } from "../jobScheduler.js";
import type { JobProgressPayload } from "../jobs.js";
import { createRemoveDiscovery, createRoomServerDeps, createSpawnRoomServerIfEnabled, type RoomServerDepsOptions } from "../roomServerLive.js";
import { type DialogDeps } from "../dialogTools.js";
import { type ShellDeps } from "../shellTools.js";
import type { WindowContentView } from "../browser/webviewManager.js";
import { type FileRuntimeStores } from "../fileRuntimeSurfaceIpc.js";
import { createEmbedBackfillState, spawnEmbeddingBackfill, spawnLegacyTextRepair, spawnReextractBackfill } from "../retrievalBackfill.js";
import { forgetRoomMemory } from "../sidecar.js";
import { extractDocumentText } from "../documentExtraction.js";
import type { ViewMenuState } from "../menu.js";
import { CompletenessReport } from "./registry.js";



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
 * Settings/recording STT resolver wiring is directly regression-testable.
 *
 * BOTH model resolvers are wired here, and for the same reason: `recBridge.ts`
 * declares each as an OPTIONAL dep with an honest `null` default, so omitting
 * one compiles, boots, records, and silently degrades.
 *
 *   - `resolveSttModel` — omitted, every `rec_start` answers STT_MODEL_MISSING
 *     while Settings cheerfully says "Voice model installed".
 *   - `diarizeModelPath` — omitted, `/rec/start` is POSTed
 *     `diarizeModelPath: null` (recBridge.ts's `?? null`), the sidecar falls
 *     back to its 21-dim DSP embedding, `identityPrint` (which needs the
 *     192-dim TitaNet vector) returns null, `learnVoice` early-returns, and
 *     saved-voice enrollment plus cross-recording recognition never work at
 *     all. That was the shipped state: the 40MB TitaNet model is bundled in
 *     `resources/models/`, and nothing ever loaded it. Settings > Saved voices
 *     and the "?" guessed-name affordance were dead UI on a dead pipeline.
 *
 * Neither failure raises anything anywhere — which is exactly why this factory
 * exists as a named, exported seam with its own test rather than as an inline
 * object literal at the one call site.
 */
export function createLiveRecBridgeCtx(
  currentRoom: () => OpenRoom | null,
  userDataDir: string,
  resourcesPath: string | null,
): RecBridgeCtx {
  return createRecBridgeCtx({
    currentRoom,
    resolveSttModel: () => sttEffectiveModel(userDataDir, resourcesPath),
    diarizeModelPath: () => diarizeEffectiveModel(userDataDir, resourcesPath),
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
