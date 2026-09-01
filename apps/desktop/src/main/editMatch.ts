export { EditError, MAX_FUZZY_BYTES, PREVIEW_CLIP, commitPlans, extractText, hashBytes, storeFileBytes } from "./editMatchCore.js";
export type { EditMethod, EditRefinements, PlannedWrite, PreviewEdit } from "./editMatchCore.js";
export type { ComputedEdit } from "./editMatchText.js";
export { MAX_BATCH_EDITS, computeEdit, computeEditBytes, planSetCells, planSetCellsWorkspace, planSingleEdit, planSingleEditWorkspace, planWriteFile, planWriteFileWorkspace } from "./editMatchPlans.js";
export { countBatchOps, parseBatchOps, planBatch, planBatchWorkspace } from "./editMatchBatch.js";
export type { BatchApplied, BatchOp, EditApplied } from "./editMatchBatch.js";
export { runEditFile, runEditFileRefined, runEditFiles } from "./editMatchRun.js";
