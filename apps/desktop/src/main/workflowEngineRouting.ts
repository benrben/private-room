/** Cohesive extraction from workflowEngineDispatch.ts; the facade preserves its public API. */
import { CancelFlag } from "./cancel.js";
import { type Step } from "./jobs.js";
import { fetchPage as realFetchPage } from "./webFetch.js";
import { type PublishedRef } from "./filePass.js";
import { DEFAULT_WF_ARTIFACT, type WfArtifact, type WorkflowNode, type WorkflowPlan } from "./workflowModel.js";
import { applyMerge, sidecarJsonCancellableRun, wfNode, wfNodeValue, type WorkflowStepDeps } from "./workflowEngineGeneration.js";
import { forEachFileNode, type NodeReport, stepIncoming, stepModel, stepParamsRecord } from "./workflowEngineSteps.js";
import { interpolate } from "./workflowEngineInputs.js";
import { priorWorkflowArtifact, readLiveWorkflowInputs, runAgentWorkflowNode, runConditionWorkflowNode, runFilePassWorkflowNode, runGenerateWorkflowNode, runSaveFileWorkflowNode, runScriptWorkflowNode, runSummarizeFileWorkflowNode, runTransformWorkflowNode, skipDeadWorkflowNode, storeCompletedWorkflowNode, type WorkflowNodeRunContext } from "./workflowEngineExecution.js";



function runMergeWorkflowNode(
  context: WorkflowNodeRunContext,
  node: Extract<WorkflowNode, { kind: "merge" }>
): WfArtifact {
  return { ...DEFAULT_WF_ARTIFACT, result: applyMerge(node.mode, node.separator, context.liveInputs) };
}



async function runHttpFetchWorkflowNode(
  context: WorkflowNodeRunContext,
  node: Extract<WorkflowNode, { kind: "http_fetch" }>
): Promise<WfArtifact> {
  if (context.cancel.load()) {
    throw new Error("STOPPED");
  }
  const url = interpolate(context.deps.rooms, context.roomPath, node.url, context.inputsJoined);
  const page = await (context.deps.fetchPage ?? realFetchPage)(url);
  return { ...DEFAULT_WF_ARTIFACT, result: `${page.title}\n\n${page.text}` };
}



async function runExtractWorkflowNode(
  context: WorkflowNodeRunContext,
  node: Extract<WorkflowNode, { kind: "extract" }>
): Promise<WfArtifact> {
  const model = context.modelChoice ?? context.plan.resolved_model;
  const result = await wfNode(
    context.deps.wfNodePost ?? sidecarJsonCancellableRun,
    "extract",
    model,
    context.jobId,
    context.step.id,
    context.step.lane,
    { fields: node.fields, context: context.inputsJoined },
    context.cancel
  );
  return { ...DEFAULT_WF_ARTIFACT, result };
}



async function runRouteWorkflowNode(
  context: WorkflowNodeRunContext,
  node: Extract<WorkflowNode, { kind: "route" }>
): Promise<WfArtifact> {
  const model = context.modelChoice ?? context.plan.resolved_model;
  const prompt = interpolate(context.deps.rooms, context.roomPath, node.prompt, context.inputsJoined);
  const value = await wfNodeValue(
    context.deps.wfNodePost ?? sidecarJsonCancellableRun,
    "route",
    model,
    context.jobId,
    context.step.id,
    context.step.lane,
    { prompt, labels: node.labels, context: context.inputsJoined },
    context.cancel
  );
  return {
    ...DEFAULT_WF_ARTIFACT,
    result: typeof value.result === "string" ? value.result : "",
    branch: typeof value.branch === "string" ? value.branch : null,
  };
}



async function runVoteWorkflowNode(
  context: WorkflowNodeRunContext,
  node: Extract<WorkflowNode, { kind: "vote" }>
): Promise<WfArtifact> {
  const model = context.modelChoice ?? context.plan.resolved_model;
  const prompt = interpolate(context.deps.rooms, context.roomPath, node.prompt, context.inputsJoined);
  const result = await wfNode(
    context.deps.wfNodePost ?? sidecarJsonCancellableRun,
    "vote",
    model,
    context.jobId,
    context.step.id,
    context.step.lane,
    { prompt, mode: node.mode, samples: node.samples },
    context.cancel
  );
  return { ...DEFAULT_WF_ARTIFACT, result };
}



function runForEachFileWorkflowNode(
  context: WorkflowNodeRunContext,
  node: Extract<WorkflowNode, { kind: "for_each_file" }>
): Promise<WfArtifact> {
  return forEachFileNode(
    context.deps,
    context.roomPath,
    context.plan,
    node.select,
    node.instruction,
    context.modelChoice,
    context.inputsJoined,
    context.cancel
  );
}



async function runRefineWorkflowNode(
  context: WorkflowNodeRunContext,
  node: Extract<WorkflowNode, { kind: "refine" }>
): Promise<WfArtifact> {
  const model = context.modelChoice ?? context.plan.resolved_model;
  const prompt = interpolate(context.deps.rooms, context.roomPath, node.prompt, context.inputsJoined);
  const result = await wfNode(
    context.deps.wfNodePost ?? sidecarJsonCancellableRun,
    "refine",
    model,
    context.jobId,
    context.step.id,
    context.step.lane,
    { prompt, rubric: node.rubric, max_rounds: node.max_rounds },
    context.cancel
  );
  return { ...DEFAULT_WF_ARTIFACT, result };
}



async function runPlanAndMapWorkflowNode(
  context: WorkflowNodeRunContext,
  node: Extract<WorkflowNode, { kind: "plan_and_map" }>
): Promise<WfArtifact> {
  const model = context.modelChoice ?? context.plan.resolved_model;
  const prompt = interpolate(context.deps.rooms, context.roomPath, node.objective, context.inputsJoined);
  const result = await wfNode(
    context.deps.wfNodePost ?? sidecarJsonCancellableRun,
    "plan_and_map",
    model,
    context.jobId,
    context.step.id,
    context.step.lane,
    { prompt, context: context.inputsJoined, max_workers: node.max_workers },
    context.cancel
  );
  return { ...DEFAULT_WF_ARTIFACT, result };
}



function unhandledWorkflowNode(node: WorkflowNode): never {
  throw new Error(`internal: unhandled node kind ${JSON.stringify(node)}`);
}



async function dispatchFinalWorkflowNode(context: WorkflowNodeRunContext, node: WorkflowNode): Promise<WfArtifact> {
  if (node.kind === "vote") return runVoteWorkflowNode(context, node);
  if (node.kind === "for_each_file") return runForEachFileWorkflowNode(context, node);
  if (node.kind === "refine") return runRefineWorkflowNode(context, node);
  if (node.kind === "plan_and_map") return runPlanAndMapWorkflowNode(context, node);
  return unhandledWorkflowNode(node);
}



async function dispatchStructuredWorkflowNode(context: WorkflowNodeRunContext, node: WorkflowNode): Promise<WfArtifact> {
  if (node.kind === "http_fetch") return runHttpFetchWorkflowNode(context, node);
  if (node.kind === "extract") return runExtractWorkflowNode(context, node);
  if (node.kind === "route") return runRouteWorkflowNode(context, node);
  return dispatchFinalWorkflowNode(context, node);
}



async function dispatchFollowupWorkflowNode(context: WorkflowNodeRunContext, node: WorkflowNode): Promise<WfArtifact> {
  if (node.kind === "script_run") return runScriptWorkflowNode(context, node);
  if (node.kind === "transform") return runTransformWorkflowNode(context, node);
  if (node.kind === "merge") return runMergeWorkflowNode(context, node);
  return dispatchStructuredWorkflowNode(context, node);
}



async function dispatchRunnableWorkflowNode(context: WorkflowNodeRunContext, node: WorkflowNode): Promise<WfArtifact> {
  if (node.kind === "agent_run") return runAgentWorkflowNode(context, node);
  if (node.kind === "save_file") return runSaveFileWorkflowNode(context, node);
  if (node.kind === "condition") return runConditionWorkflowNode(context, node);
  return dispatchFollowupWorkflowNode(context, node);
}



async function dispatchWorkflowNode(context: WorkflowNodeRunContext, node: WorkflowNode): Promise<WfArtifact> {
  if (node.kind === "generate") return runGenerateWorkflowNode(context, node);
  if (node.kind === "summarize_file") return runSummarizeFileWorkflowNode(context, node);
  if (node.kind === "file_pass") return runFilePassWorkflowNode(context, node);
  return dispatchRunnableWorkflowNode(context, node);
}



/**
 * The step's actual work. Room-pinned throughout (every DB touch re-pins,
 * because an `await` is exactly where the open room can be swapped out).
 * Emits nothing — its caller owns the diagram. Ported from
 * `run_workflow_node`.
 */
export async function runWorkflowNode(
  deps: WorkflowStepDeps,
  jobId: string,
  roomPath: string,
  plan: WorkflowPlan,
  step: Step,
  cancel: CancelFlag,
  published: PublishedRef,
  node: WorkflowNode
): Promise<NodeReport> {
  const params = stepParamsRecord(step);
  const modelChoice = stepModel(params);
  const incoming = stepIncoming(params);
  const { inputs: liveInputs, livePresent } = readLiveWorkflowInputs(deps, roomPath, jobId, incoming);
  const skipped = skipDeadWorkflowNode(deps, roomPath, jobId, step, node, incoming, livePresent);
  if (skipped !== null) {
    return skipped;
  }
  const context: WorkflowNodeRunContext = {
    deps,
    jobId,
    roomPath,
    plan,
    step,
    cancel,
    published,
    modelChoice,
    inputsJoined: liveInputs.join("\n\n"),
    liveInputs,
    existing: priorWorkflowArtifact(deps, roomPath, jobId, step.id),
  };
  const artifact = await dispatchWorkflowNode(context, node);
  return storeCompletedWorkflowNode(deps, roomPath, jobId, step.id, node, artifact);
}
