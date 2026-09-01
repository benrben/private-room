/** Stable whole-file-pass facade; implementation is split by execution phase. */
export {
  PASS_SECTION_WINDOWS,
  PASS_WINDOW_CHARS,
  PASS_WINDOW_OVERLAP,
  buildPassSteps,
  isFatal,
  loadArtifact,
  parsePassPlan,
  storeArtifact,
} from "./filePassCore.js";
export type { PassArtifact, PassPlan } from "./filePassCore.js";
export { executePassStep } from "./filePassExecute.js";
export type { EmitFn, FilePassStepDeps, PublishedRef, SidecarPostFn } from "./filePassExecute.js";
export {
  RESOLVE_PASS_ENGINE_NOT_IMPLEMENTED,
  driveFilePass,
  passProgressLabel,
  resolvePassEngineNotImplemented,
  resumableChild,
} from "./filePassProgress.js";
export type { DriveFilePassDeps, ResolvePassEngine } from "./filePassProgress.js";
export type { SidecarError } from "./sidecarJsonCancellable.js";
