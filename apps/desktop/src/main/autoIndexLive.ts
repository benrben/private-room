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
type OpenRoom = NonNullable<RoomManagerState["room"]>;
type SummaryFillerFile = ReturnType<typeof filesMissingSummary>[number];

interface SummaryFillerPass {
  epoch: number;
  model: string;
  room: OpenRoom;
  roomPath: string;
  state: RoomManagerState;
}

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

function currentSummaryFillerRoom(
  state: RoomManagerState,
  roomPath: string,
  epoch: number,
): OpenRoom | null {
  const room = state.room;
  if (room === null) return null;
  if (room.path !== roomPath) return null;
  if (state.roomEpoch !== epoch) return null;
  return room;
}

async function waitForSummaryFillerDelay(delaySecs: number): Promise<void> {
  if (delaySecs > 0) await new Promise((resolve) => setTimeout(resolve, delaySecs * 1_000));
}

async function summaryFillerPass(
  state: RoomManagerState,
  roomPath: string,
  epoch: number,
): Promise<SummaryFillerPass | null> {
  const models = await listModels();
  if (models.length === 0) return null;
  const room = currentSummaryFillerRoom(state, roomPath, epoch);
  if (room === null) return null;
  return { epoch, model: modelSetting(room.conn) ?? bestLocalDefault(models), room, roomPath, state };
}

async function summarizeFillerFile(
  model: string,
  name: string,
  mime: string,
  text: string,
): Promise<string> {
  return summarizeOneFile(model, name, mime, text, "2m").catch(() => "");
}

async function writeSummaryFillerFile(
  pass: SummaryFillerPass,
  [id, name, mime, sample]: SummaryFillerFile,
): Promise<boolean | null> {
  if (pass.state.cancel.cancels.size > 0) return null;
  const room = currentSummaryFillerRoom(pass.state, pass.roomPath, pass.epoch);
  if (room === null) return null;
  const full = getFileExtractedText(room.conn, id) ?? sample;
  const summary = await summarizeFillerFile(pass.model, name, mime, full);
  if (summary === "") return null;
  const current = currentSummaryFillerRoom(pass.state, pass.roomPath, pass.epoch);
  if (current === null) return null;
  setFileAiSummary(current.conn, id, summary);
  return true;
}

async function fillMissingSummaries(pass: SummaryFillerPass): Promise<boolean | null> {
  const batch = filesMissingSummary(pass.room.conn, FILLER_LIMIT);
  let wrote = false;
  for (const file of batch) {
    const didWrite = await writeSummaryFillerFile(pass, file);
    if (didWrite === null) return null;
    wrote = wrote || didWrite;
  }
  return wrote;
}

async function runSummaryFiller(
  state: RoomManagerState,
  emit: EventSender,
  roomPath: string,
  delaySecs: number,
  epoch: number,
): Promise<void> {
  await waitForSummaryFillerDelay(delaySecs);
  const pass = await summaryFillerPass(state, roomPath, epoch);
  if (pass === null) return;
  const wrote = await fillMissingSummaries(pass);
  if (wrote) emit("room-files-changed", {});
}

async function runSummaryFillerAndRelease(
  state: RoomManagerState,
  emit: EventSender,
  roomPath: string,
  delaySecs: number,
  epoch: number,
  release: () => void,
): Promise<void> {
  try {
    await runSummaryFiller(state, emit, roomPath, delaySecs, epoch);
  } finally {
    release();
  }
}

/** One bounded, single-flight quiet pass, matching the former host filler. */
function createSummaryFiller(state: RoomManagerState, emit: EventSender) {
  let running = false;
  return (roomPath: string, delaySecs: number): void => {
    if (running) return;
    running = true;
    const epoch = state.roomEpoch;
    void runSummaryFillerAndRelease(state, emit, roomPath, delaySecs, epoch, () => { running = false; })
      .catch((error) => console.error("summary filler failed:", error));
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
