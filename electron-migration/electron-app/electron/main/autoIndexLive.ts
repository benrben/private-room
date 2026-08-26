/** Production dependency assembly for the debounced auto-index scheduler. */

import { scheduleAutoIndex, createAutoIndexState, type AutoIndexDeps } from "./autoIndex.js";
import { runsOnThisMac } from "./capabilities.js";
import { startDeepSummaryJob } from "./creativeJobSurfaceIpc.js";
import { filesMissingSummary, getFileExtractedText, setFileAiSummary } from "./db-host/files.js";
import { listModels } from "./engineRouting.js";
import { modelSetting } from "./gatherContext.js";
import type { Lane } from "./jobs.js";
import { bestLocalDefault } from "./ollamaModels.js";
import { recReadRowStarter, startRecRead } from "./recRead.js";
import type { RoomManagerDeps, RoomManagerState } from "./roomManager.js";
import { summarizeOneFile } from "./summarizeTools.js";
import type { EventSender } from "./turn.js";

const FILLER_LIMIT = 50;

async function resolveEngine(state: RoomManagerState): Promise<{ chatModel: string; lane: Lane }> {
  if (state.room === null) throw new Error("No room is open.");
  const models = await listModels();
  const chatModel = modelSetting(state.room.conn) ?? bestLocalDefault(models);
  return { chatModel, lane: runsOnThisMac(chatModel) ? "local_llm" : "cloud" };
}

function installRecordingReadStarter(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  emit: EventSender,
): void {
  if (deps.jobQueue === undefined) throw new Error("The background job queue is unavailable.");
  const starters = new Map(deps.jobQueue.starters);
  starters.set("rec_read", recReadRowStarter({
    resolvePassEngine: () => resolveEngine(state),
    onReadDone: (event) => emit("rec-read-done", event),
  }));
  deps.jobQueue = { ...deps.jobQueue, starters };
}

/** One bounded, single-flight quiet pass, matching the former host filler. */
function createSummaryFiller(state: RoomManagerState, emit: EventSender) {
  let running = false;
  return (roomPath: string, delaySecs: number): void => {
    if (running) return;
    running = true;
    const epoch = state.roomEpoch;
    void (async () => {
      try {
        if (delaySecs > 0) await new Promise((resolve) => setTimeout(resolve, delaySecs * 1_000));
        const models = await listModels();
        const open = state.room;
        if (models.length === 0 || open === null || open.path !== roomPath || state.roomEpoch !== epoch) return;
        const model = modelSetting(open.conn) ?? bestLocalDefault(models);
        const batch = filesMissingSummary(open.conn, FILLER_LIMIT);
        let wrote = false;
        for (const [id, name, mime, sample] of batch) {
          if (state.cancel.cancels.size > 0) return;
          const room = state.room;
          if (room === null || room.path !== roomPath || state.roomEpoch !== epoch) return;
          const full = getFileExtractedText(room.conn, id) ?? sample;
          const summary = await summarizeOneFile(model, name, mime, full, "2m").catch(() => "");
          if (summary === "") return;
          const current = state.room;
          if (current === null || current.path !== roomPath || state.roomEpoch !== epoch) return;
          setFileAiSummary(current.conn, id, summary);
          wrote = true;
        }
        if (wrote) emit("room-files-changed", {});
      } finally {
        running = false;
      }
    })().catch((error) => console.error("summary filler failed:", error));
  };
}

export function createLiveAutoIndex(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  emit: EventSender,
): (roomPath: string) => void {
  installRecordingReadStarter(state, deps, emit);
  const autoState = createAutoIndexState();
  const autoDeps: AutoIndexDeps = {
    rooms: deps.jobQueue!.rooms,
    cancelState: state.cancel,
    listModels,
    startDeepSummaryAuto: async (roomPath) => {
      if (state.room === null || state.room.path !== roomPath) {
        throw new Error("The room changed while indexing was starting.");
      }
      return startDeepSummaryJob(state, deps, true);
    },
    startRecRead: async (roomPath, fileId) => {
      if (state.room === null || state.room.path !== roomPath || deps.jobQueue === undefined) {
        throw new Error("The room changed while its recording read was starting.");
      }
      return startRecRead(deps.jobQueue, {
        resolvePassEngine: () => resolveEngine(state),
        onReadDone: (event) => emit("rec-read-done", event),
      }, fileId);
    },
    spawnSummaryFiller: createSummaryFiller(state, emit),
  };
  return (roomPath) => { scheduleAutoIndex(autoDeps, autoState, roomPath); };
}
