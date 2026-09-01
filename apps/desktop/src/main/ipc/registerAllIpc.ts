import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { toRoomSource as toJobsRoomSource } from "../roomManager.js";
import { modelSetting } from "../gatherContext.js";
import { SttModelState } from "../sttTools.js";
import { transcribeMediaWithSpeakers, type MediaTranscribeDeps } from "../mediaTranscribeJob.js";
import { createPeakCache } from "../peaksTools.js";
import { createSlideCache } from "../officeTools.js";
import { recStop } from "../recBridge.js";
import { startRecRead } from "../recRead.js";
import { listModels } from "../engineRouting.js";
import { bestLocalDefault } from "../ollamaModels.js";
import { runsOnThisMac } from "../capabilities.js";
import { configureVisualIndexDir } from "../sidecar.js";
import { videoVisualIndex } from "../videoVisualIndex.js";
import { createRoomServerDeps, createSpawnRoomServerIfEnabled, roomServerRoomSource, roomServerSlotOver } from "../roomServerLive.js";
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
import { generateTextAnyEngine, registerWorkflowComposeIpc, withRealOllamaGenerate } from "../workflowCompose.js";
import { registerDialogIpc } from "../dialogTools.js";
import { registerShellIpc } from "../shellTools.js";
import { registerCoreSurfaceIpc } from "../coreSurfaceIpc.js";
import { registerFileSurfaceIpc } from "../fileSurfaceIpc.js";
import { createMcpRuntime, registerMcpSurfaceIpc } from "../mcpSurfaceIpc.js";
import { registerBrowserSurfaceIpc } from "../browserSurfaceIpc.js";
import { registerJobWorkflowSurfaceIpc } from "../jobWorkflowSurfaceIpc.js";
import { registerFileRuntimeSurfaceIpc } from "../fileRuntimeSurfaceIpc.js";
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
import { runCommand, type RunCommandRequest } from "../chatCommands.js";
import { assembleLiveContext } from "../liveContext.js";
import { RegisterAllIpcOptions, RegisterAllIpcResult, buildExplicitModel, buildRoomSource, buildSafetyRoomSource, checkCompleteness, createLiveRecBridgeCtx, readViewMenuState } from "./registry.js";



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

  // Configure before any registered handler can lazily start the sidecar.
  // The sidecar accepts no cache path over HTTP, so untrusted tool arguments
  // can never redirect plaintext derived video pixels elsewhere.
  configureVisualIndexDir(userDataDir);

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

  /**
   * ONE speaker-aware transcription lane, shared by every route into it — chat
   * paste/import (`registerChatIpc`'s `enqueueStt`), file import
   * (`retranscribeImportedFile`), a trimmed video clip (`registerVideoIpc`'s
   * `enqueueStt`) and the explicit `rec_retranscribe` button.
   *
   * THREE of those four previously called `speechSttSurfaceIpc.ts`'s
   * `retranscribeFile` (the video one called nothing at all — `enqueueStt` was
   * simply never passed to `registerVideoIpc`). `retranscribeFile`
   * writes FLAT text into `files.extracted_text` and nothing else. That
   * left every one of them speakerless, and — because
   * `fileRuntimeSurfaceIpc.ts` picks the viewer by DATA (`getRecMeta(...) !==
   * null ? "recording" : viewerKind(...)`) — it also left them opening in the
   * plain audio viewer forever. `transcribeMediaWithSpeakers` writes the
   * `recordings` row as well, so the same file lands in the full
   * speaker-aware RecordingView with no new component involved.
   *
   * `onIndexed` is a live lookup, not a captured function: `deps.scheduleAutoIndex`
   * is assigned further down in this same function (after the surfaces that
   * need it are registered), so capturing it here would pin `undefined`.
   */
  const mediaTranscribe: MediaTranscribeDeps = {
    state,
    userDataDir,
    resourcesPath,
    emit,
    onIndexed: (roomPath: string): void => deps.scheduleAutoIndex?.(roomPath),
    warmVisualIndex: (stagedPath, expectedSourceSha256, timeoutMs) =>
      videoVisualIndex.warm(stagedPath, expectedSourceSha256, timeoutMs),
  };

  // ---- room lifecycle + checkpoints + chat — the real RoomManagerState ----
  registerRoomManagerIpc(recordingIpcMain, state, deps);
  registerRoomCheckpointsIpc(recordingIpcMain, state, deps);
  registerChatIpc(recordingIpcMain, state, {
    // Rust's `enqueue_stt` is fire-and-forget, so this stays `void`-and-catch:
    // a paste that landed as a real room file must not be reported as failed
    // because the transcription behind it did.
    enqueueStt: (job) => {
      void transcribeMediaWithSpeakers(mediaTranscribe, job.id).catch((error) =>
        // A LAST-RESORT net, not the reporter. `transcribeMediaWithSpeakers`
        // catches everything internally and answers `null`, emitting its own
        // `[name, "failed: …"]` on the way — so in normal operation this
        // handler never runs. It exists so that an unexpected throw becomes a
        // named event instead of an unhandled rejection on a `void`ed promise.
        //
        // Keyed by NAME, with the `failed: ` prefix, because that is the only
        // shape the consumers read: `state.ts`'s `sttStatus` map is keyed by
        // the event's first element (which `ViewerRouter`/`RecordingsPage`
        // then look up by file name), and `viewers/util.ts`'s `sttFailure`
        // recognises a failure only by `STT_FAILED_PREFIX`. This site used to
        // emit `[job.id, message]`, which landed in that map under a key
        // nothing looks up and in a shape `sttFailure` reads as "not a
        // failure" — a wasted entry, though not a lost message: the old
        // `retranscribeFile` had already emitted the correct name-keyed
        // `failed: …` for anything that threw past its staging step.
        emit("stt-progress", [
          job.name,
          `failed: ${error instanceof Error ? error.message : String(error)}`,
        ]));
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
      // An imported recording gets the SAME treatment a live one does — a
      // `recordings` row with real speaker turns, not just flat text — so it
      // opens in RecordingView with chips you can name. `FileRuntimeActions`
      // declares this seam as `Promise<void>` and its caller already discards
      // the result (`void actions.retranscribeImportedFile?.(id).catch(...)`),
      // so the meta is dropped here deliberately rather than widening a
      // contract nobody reads through.
      retranscribeImportedFile: (fileId) =>
        transcribeMediaWithSpeakers(mediaTranscribe, fileId).then(() => undefined),
    },
  );
  // `resourcesPath` is the SIXTH argument and it defaults to `null`, so
  // omitting it compiles, boots and downloads — and then every downloaded
  // podcast reports `model-missing` on the `stt-progress` lane in a packaged
  // build, because the bundled weights live under `process.resourcesPath` and
  // nothing else looks there. That is the same silent-degradation shape as
  // `diarizeModelPath` above (see the module doc's "BEST-EFFORT DEPS"), and it
  // would make `download_media`'s own tool description — "the file is
  // transcribed on this Mac with speakers separated … not at all if no speech
  // model is installed" — untrue for the default install, where the model IS
  // installed and Settings says so.
  registerMediaDownloadSurfaceIpc(
    recordingIpcMain,
    state,
    deps,
    userDataDir,
    emit,
    resourcesPath,
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
  // `videoTools.ts` declares `enqueueStt` optional so a trim never fails just
  // because the side channel is unwired — but unwired is what it was, so a
  // clip the user cut out of a video landed in the room permanently
  // transcript-less while every other import route got one. `video_trim`
  // wraps its own call in try/catch and swallows, matching Rust; the
  // `.catch` here is for the async half that try/catch cannot see.
  registerVideoIpc(recordingIpcMain, roomSource, {
    emit,
    enqueueStt: (job) => {
      void transcribeMediaWithSpeakers(mediaTranscribe, job.id).catch((error) =>
        emit("stt-progress", [
          job.name,
          `failed: ${error instanceof Error ? error.message : String(error)}`,
        ]));
    },
  });
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
    /**
     * `rec_retranscribe`. `ipc-contract.ts` declares the result as `RecMeta`
     * and `RecordingView.tsx`'s `runRetranscribe` reads `updated.durationCs`
     * the statement after awaiting it — so the previous override, which
     * awaited `retranscribeFile` and returned `undefined`, made the button
     * throw a TypeError on the renderer side EVERY time, on top of rewriting
     * `files.extracted_text` with flat text while leaving `recordings.meta`
     * untouched (orphaning the segments, speakers, words, cuts and notes the
     * screen was still drawing from).
     *
     * Decided failure behavior: REFUSE on `null`. `transcribeMediaWithSpeakers`
     * answers `null` for a file it will not transcribe (not media, or the
     * sidecar refused). Returning that through would satisfy the compiler and
     * hand the renderer exactly the same `null.durationCs` crash this is
     * fixing, so it is turned into a real, catchable message the toast can
     * show instead.
     */
    retranscribe: async (_db, _ctx, id) => {
      const meta = await transcribeMediaWithSpeakers(mediaTranscribe, id);
      if (meta === null) {
        throw new Error("This recording could not be transcribed — nothing was changed.");
      }
      return meta;
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
