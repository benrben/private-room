/** Stable local-model surface; implementation is split by lifecycle phase. */
export {
  HIGH_RAM_THRESHOLD_BYTES,
  KEEP_ALIVE_SHORT,
  KEEP_ALIVE_WARM,
  bestLocalDefault,
  deleteModel,
  ollamaCapabilities,
  ollamaNativeContextLength,
  probeOllamaModelSelection,
  resetTotalRamCacheForTests,
  totalRamBytes,
  visionKeepAlive,
  warm,
} from "./ollamaModelsCore.js";
export {
  chatModelSeesImages,
  defaultGroundingModelForRoomDeps,
  defaultGroundingPickDeps,
  defaultModelCapabilitiesDeps,
  defaultVisionSupportDeps,
  defaultWarmModelDeps,
  groundingModelForRoom,
  groundingPick,
  modelCapabilities,
  openOllama,
  openOllamaFailure,
  warmModel,
} from "./ollamaModelsSelection.js";
export type {
  GroundingModelForRoomDeps,
  GroundingPickDeps,
  ModelCapabilitiesDeps,
  OpenOllamaProcess,
  OpenOllamaSpawnFn,
  WarmModelDeps,
} from "./ollamaModelsSelection.js";
export {
  PULL_CANCELLED,
  PULL_PROGRESS_STEP,
  PULL_STALL_TIMEOUT_MS,
  defaultPullModelDeps,
  pullCancelKey,
  pullCancellable,
  pullCancellableAt,
  pullModel,
  pullProgressShouldEmit,
  registryName,
} from "./ollamaModelsPull.js";
export type { PullModelDeps, PullOutcome, PullProgressListener } from "./ollamaModelsPull.js";
export {
  AI_STATUS_DETECTION_NOT_IMPLEMENTED,
  aiStatus,
  defaultAiStatusDeps,
  detectedExternalNotImplemented,
  ollamaInstalledNotImplemented,
  registerOllamaModelsIpc,
} from "./ollamaModelsStatus.js";
export type { AiStatusDeps, OllamaModelsIpcDeps } from "./ollamaModelsStatus.js";
