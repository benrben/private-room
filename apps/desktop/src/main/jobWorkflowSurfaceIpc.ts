/** Job activity and workflow-library IPC over the shared app queue. */

import path from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { RoomManagerDeps, RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";
import {
  deleteJob,
  getJob,
  getJobArtifact,
  listJobs,
  setJobStatus,
} from "./db-host/jobs.js";
import {
  createWorkflow,
  getSchedule,
  getWorkflow,
  listWorkflowRuns,
  listWorkflows,
  setWorkflowStatus,
  updateWorkflow,
} from "./db-host/workflows.js";
import { submit } from "./jobQueue.js";
import {
  deleteWorkflowCmd,
  runWorkflowCommand,
  setWorkflowPinnedCmd,
  setWorkflowScheduleCmd,
  setWorkflowStatusCmd,
  startWorkflowRun,
  workflowRowStarter,
  type WorkflowRunDeps,
} from "./workflowRuns.js";
import {
  applySchedule,
  parseBinding,
  parseDef,
  validateWorkflowInner,
  type ScheduleArg,
} from "./workflowCompose.js";
import { createScriptApprovalRequester } from "./scriptSurfaceIpc.js";
import { listModels } from "./engineRouting.js";
import { modelSetting } from "./gatherContext.js";
import { bestLocalDefault } from "./ollamaModels.js";
import { runsOnThisMac } from "./capabilities.js";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function scheduleArg(value: unknown): ScheduleArg {
  const a = object(value);
  return {
    kind: typeof a.kind === "string" ? a.kind : "",
    param: typeof a.param === "string" ? a.param : "",
    enabled: typeof a.enabled === "boolean" ? a.enabled : true,
    catchUp: typeof a.catchUp === "boolean" ? a.catchUp : true,
  };
}

type WorkflowDatabase = Parameters<typeof createWorkflow>[0];

interface ParsedWorkflowUpdate {
  binding: ReturnType<typeof parseBinding>;
  definition: unknown;
  parsedDefinition: ReturnType<typeof parseDef>;
}

function asDefaultString(value: unknown, fallback: string): string {
  return String(value ?? fallback);
}

function newWorkflowName(value: unknown): string {
  return asDefaultString(value, "New workflow").trim() || "New workflow";
}

function newWorkflowEmoji(value: unknown): string {
  return asDefaultString(value, "✨") || "✨";
}

function throwWorkflowErrors(errors: string[]): void {
  if (errors.length) throw new Error(errors.join("; "));
}

function applyRequestedSchedule(
  db: WorkflowDatabase,
  id: string,
  definition: ReturnType<typeof parseDef>,
  rawSchedule: unknown,
): void {
  if (rawSchedule === undefined) return;
  const schedule = scheduleArg(rawSchedule);
  applySchedule(db, id, definition, schedule.kind, schedule.param, schedule.enabled, schedule.catchUp);
}

async function saveWorkflowFromRaw(
  db: WorkflowDatabase,
  raw: unknown,
  changed: () => void,
): Promise<string> {
  const values = object(raw);
  const definition = parseDef(values.definition);
  const binding = parseBinding(values.binding);
  const errors = await validateWorkflowInner(db, definition, binding);
  throwWorkflowErrors(errors);
  const id = createWorkflow(
    db,
    newWorkflowName(values.name),
    asDefaultString(values.description, ""),
    newWorkflowEmoji(values.emoji),
    values.definition,
    asDefaultString(values.createdBy, "user"),
    binding,
  );
  applyRequestedSchedule(db, id, definition, values.schedule);
  changed();
  return id;
}

function parsedWorkflowUpdate(
  values: Record<string, unknown>,
  existing: ReturnType<typeof getWorkflow>,
): ParsedWorkflowUpdate {
  const definition = values.definition ?? existing.definition;
  const binding = values.binding ?? existing.binding;
  return { definition, binding: parseBinding(binding), parsedDefinition: parseDef(definition) };
}

function updatedWorkflowString(value: unknown, existing: string): string {
  return typeof value === "string" ? value : existing;
}

async function updateWorkflowFromRaw(
  db: WorkflowDatabase,
  raw: unknown,
  changed: () => void,
): Promise<void> {
  const values = object(raw);
  const id = String(values.id ?? "");
  const existing = getWorkflow(db, id);
  const update = parsedWorkflowUpdate(values, existing);
  const errors = await validateWorkflowInner(db, update.parsedDefinition, update.binding);
  throwWorkflowErrors(errors);
  updateWorkflow(
    db, id,
    updatedWorkflowString(values.name, existing.name),
    updatedWorkflowString(values.description, existing.description),
    updatedWorkflowString(values.emoji, existing.emoji),
    update.definition, update.binding,
  );
  setWorkflowStatus(db, id, "draft");
  applyRequestedSchedule(db, id, update.parsedDefinition, values.schedule);
  changed();
}

export function createWorkflowRunDeps(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  userDataDir: string,
  emit: EventSender,
): WorkflowRunDeps {
  if (!deps.jobQueue) throw new Error("The job queue is unavailable.");
  return {
    ...deps.jobQueue,
    rooms: deps.jobQueue.rooms,
    cacheDir: path.join(userDataDir, "cache"),
    userDataDir,
    emit,
    notifyFilesChanged: () => emit("room-files-changed", {}),
    isRollingBack: () => state.rollingBack,
    ...(deps.workflowAgentRun === undefined ? {} : { agentRun: deps.workflowAgentRun }),
    resolveEngine: async () => {
      if (state.room === null) throw new Error("No room is open.");
      const models = await listModels();
      const model = modelSetting(state.room.conn) ?? bestLocalDefault(models);
      return { model, lane: runsOnThisMac(model) ? "local_llm" : "cloud" };
    },
  };
}

export function registerJobWorkflowSurfaceIpc(
  ipcMain: Pick<IpcMain, "handle">,
  state: RoomManagerState,
  deps: RoomManagerDeps,
  userDataDir: string,
  emit: EventSender,
): void {
  const room = () => {
    if (!state.room) throw new Error("No room is open.");
    return state.room;
  };
  const queue = deps.jobQueue;
  if (queue) {
    const starters = new Map(queue.starters);
    const workflowDeps = (): WorkflowRunDeps => createWorkflowRunDeps(state, deps, userDataDir, emit);
    starters.set("workflow", workflowRowStarter(workflowDeps()));
    deps.jobQueue = { ...queue, starters };
    if (deps.scheduler) {
      deps.scheduler.deps.startWorkflowRun = (workflowId, trigger, inputFileId) =>
        startWorkflowRun(workflowDeps(), workflowId, trigger, inputFileId, new Set());
    }
  }

  const workflowDeps = (): WorkflowRunDeps => createWorkflowRunDeps(state, deps, userDataDir, emit);
  const changed = (): void => emit("workflows-changed", undefined);

  ipcMain.handle("list_jobs", () => listJobs(room().conn));
  ipcMain.handle("cancel_job", (_e: IpcMainInvokeEvent, raw: unknown) => {
    const id = String(object(raw).id ?? "");
    const db = room().conn;
    const job = getJob(db, id);
    state.cancel.jobCancels.get(id)?.store(true);
    if (job.status === "queued") setJobStatus(db, id, "paused", null);
  });
  ipcMain.handle("resume_job", async (_e: IpcMainInvokeEvent, raw: unknown) => {
    const id = String(object(raw).id ?? "");
    const db = room().conn;
    const job = getJob(db, id);
    if (job.status !== "paused" && job.status !== "error") {
      throw new Error("Only a paused or failed job can be resumed.");
    }
    setJobStatus(db, id, "queued", null);
    if (!deps.jobQueue) throw new Error("The job queue is unavailable.");
    await submit(deps.jobQueue, id);
  });
  ipcMain.handle("delete_job", (_e: IpcMainInvokeEvent, raw: unknown) => {
    const id = String(object(raw).id ?? "");
    state.cancel.jobCancels.get(id)?.store(true);
    deleteJob(room().conn, id);
  });

  ipcMain.handle("list_workflows", () => listWorkflows(room().conn));
  ipcMain.handle("get_workflow_schedule", (_e: IpcMainInvokeEvent, raw: unknown) =>
    getSchedule(room().conn, String(object(raw).id ?? "")));
  ipcMain.handle("get_workflow_runs", (_e: IpcMainInvokeEvent, raw: unknown) =>
    listWorkflowRuns(room().conn, String(object(raw).id ?? "")));
  ipcMain.handle("get_job_step_artifact", (_e: IpcMainInvokeEvent, raw: unknown) => {
    const a = object(raw);
    return getJobArtifact(room().conn, String(a.jobId ?? ""), Number(a.stepId ?? 0));
  });
  ipcMain.handle("validate_workflow", async (_e: IpcMainInvokeEvent, raw: unknown) => {
    const a = object(raw);
    return validateWorkflowInner(room().conn, parseDef(a.definition), parseBinding(a.binding));
  });
  ipcMain.handle("save_workflow", (_e: IpcMainInvokeEvent, raw: unknown) =>
    saveWorkflowFromRaw(room().conn, raw, changed));
  ipcMain.handle("update_workflow", (_e: IpcMainInvokeEvent, raw: unknown) =>
    updateWorkflowFromRaw(room().conn, raw, changed));
  ipcMain.handle("delete_workflow", (_e: IpcMainInvokeEvent, raw: unknown) => {
    deleteWorkflowCmd(room().conn, String(object(raw).id ?? ""), state.cancel);
    changed();
  });
  ipcMain.handle("set_workflow_status", (_e: IpcMainInvokeEvent, raw: unknown) => {
    const a = object(raw);
    setWorkflowStatusCmd(room().conn, String(a.id ?? ""), String(a.status ?? "draft"));
    changed();
  });
  ipcMain.handle("set_workflow_pinned", (_e: IpcMainInvokeEvent, raw: unknown) => {
    const a = object(raw);
    setWorkflowPinnedCmd(room().conn, String(a.id ?? ""), a.pinned === true);
    changed();
  });
  ipcMain.handle("set_workflow_schedule", (_e: IpcMainInvokeEvent, raw: unknown) => {
    const a = object(raw);
    setWorkflowScheduleCmd(room().conn, String(a.id ?? ""), scheduleArg(a.schedule));
    changed();
  });
  ipcMain.handle("run_workflow", (_e: IpcMainInvokeEvent, raw: unknown) => {
    const a = object(raw);
    return runWorkflowCommand(
      {
        ...workflowDeps(),
        scriptRunApproved: createScriptApprovalRequester(state, userDataDir, emit),
      },
      String(a.id ?? ""),
      typeof a.fileId === "string" ? a.fileId : null,
    );
  });
}
