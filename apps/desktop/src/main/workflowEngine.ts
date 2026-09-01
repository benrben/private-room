export { ROOM_GONE, SIDECAR_CHAIN_TIMEOUT_MS, countNewFiles, edgeIsLive, emitWorkflowNode, evalCondition, interpolate, loadWfArtifact, resolveFiles, storeWfArtifact } from "./workflowEngineInputs.js";
export type { FileTriple, WfNodePostFn, WorkflowNodeStatus } from "./workflowEngineInputs.js";
export { AGENT_RUN_NOT_IMPLEMENTED, NEEDS_APPROVAL, agentRunNotImplemented, applyMerge, applyTransform, buildWfNodePayload, classifyLiner, sidecarJsonCancellableRun, summarizeOneFileViaSidecar, wfGenerate, wfNode, wfNodeValue } from "./workflowEngineGeneration.js";
export type { AgentRunFn, LinerOutcome, SummarizeOneFileFn, WorkflowStepDeps } from "./workflowEngineGeneration.js";
export { PER_FILE_CHARS } from "./workflowEngineSteps.js";
export type { NodeReport } from "./workflowEngineSteps.js";
export { appendedWorkspaceContent, saveFileNode, saveFileNodeHybrid, saveNamedWorkspaceOutput } from "./workflowEngineSave.js";
export { executeWorkflowStep, runWorkflowNode } from "./workflowEngineDispatch.js";
export { appendIntoHtml, cleanSaveName, MAX_SAVE_NAME_CHARS } from "./workflowSaveFile.js";
/** `like_escape` (workflow.rs:1258-1267) is byte-identical to the already-
 * ported `db-host/messages.ts` one — same three characters (`\`, `%`, `_`),
 * escaped the same way — so it is REUSED rather than re-spelled, exactly as
 * `db-host/files.ts`'s `availableName` already reuses it instead of deriving
 * a second copy. Re-exported so this module's own callers and tests can reach
 * it by the name the Rust source uses. */
export { likeEscape } from "./db-host/messages.js";
export type { EmitFn, PublishedRef, SidecarPostFn } from "./filePass.js";
