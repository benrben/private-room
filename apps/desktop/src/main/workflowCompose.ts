/** Stable workflow-compose facade; implementation is grouped by responsibility. */
export {
  COMPOSE_TEMPERATURE,
  OLLAMA_GENERATE_NOT_IMPLEMENTED,
  composePrompt,
  generateOllamaNotImplemented,
  generateTextAnyEngine,
  recoverJson,
  withRealOllamaGenerate,
} from "./workflowComposeCore.js";
export type { GenerateOllamaFn, GenerateTextAnyEngineDeps } from "./workflowComposeCore.js";
export {
  applySchedule,
  backfillNodeLabels,
  humanKindLabel,
  parseBinding,
  parseDef,
  scheduleFromArgs,
  validateWorkflowInner,
} from "./workflowComposeParsing.js";
export type { ScheduleArg, ValidateWorkflowInnerDeps } from "./workflowComposeParsing.js";
export {
  DESCRIBE_WORKFLOW_EMPTY,
  clampTestReport,
  composeWorkflow,
  testRunTrailer,
} from "./workflowComposeRun.js";
export type { ComposeWorkflowDeps, EmitFn } from "./workflowComposeRun.js";
export { builtinTemplates, workflowTemplates } from "./workflowComposeTemplates.js";
export type { WorkflowTemplate } from "./workflowComposeTemplates.js";
export { registerWorkflowComposeIpc } from "./workflowComposeRegistry.js";
export type { RoomSource } from "./workflowComposeRegistry.js";
