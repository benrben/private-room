/** Scripts-page IPC and the per-Mac, content-addressed consent round trip. */

import path from "node:path";
import { randomUUID } from "node:crypto";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { RoomManagerDeps, RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";
import { listFiles } from "./db-host/files.js";
import { readRoomFile } from "./workspace/roomContent.js";
import {
  addScriptApproval,
  ensureScriptWorkflow,
  interpreterLine,
  listScriptsInRoom,
  readScriptApprovals,
  resolveScriptRun,
  setScriptScheduleInRoom,
} from "./scriptConsent.js";
import {
  parseScriptManifest,
  referencedRoomFiles,
  resolveInterpreter,
  scriptFingerprint,
  scriptLangOf,
  type Runner,
  type ScriptManifest,
} from "./scriptRun.js";
import {
  startWorkflowRun,
  type ScriptApprovalRequest,
  type ScriptRunApprovedFn,
  type WorkflowRunDeps,
} from "./workflowRuns.js";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function expandedInputs(state: RoomManagerState, declared: readonly string[], text: string): string[] {
  const open = state.room;
  if (!open) return [...declared];
  const names = listFiles(open.conn).map((file) => file.name);
  const result = [...declared];
  for (const name of referencedRoomFiles(text, names, 20)) {
    if (!result.some((existing) => existing.toLowerCase() === name.toLowerCase())) result.push(name);
  }
  return result;
}

/** The live card used by both Run Script and manual workflows with script nodes. */
export function createScriptApprovalRequester(
  state: RoomManagerState,
  userDataDir: string,
  emit: EventSender,
): ScriptRunApprovedFn {
  return async (request: ScriptApprovalRequest): Promise<boolean> => {
    if (readScriptApprovals(userDataDir).includes(request.sha)) return true;
    const open = state.room;
    if (!open) throw new Error("No room is open.");
    const file = await readRoomFile({ db: open.conn, path: open.path }, request.fileId);
    const name = file.name;
    const bytes = file.bytes ?? Buffer.alloc(0);
    const manifest = parseScriptManifest(name, bytes.toString("utf8"));
    const id = randomUUID();
    const decision = await new Promise<{ approved: boolean; remember: boolean }>((resolve) => {
      const timer = setTimeout(() => {
        state.scriptPending.delete(id);
        resolve({ approved: false, remember: false });
      }, 180_000);
      timer.unref?.();
      state.scriptPending.set(id, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      emit("script-approve-request", {
        id,
        name,
        interpreterLine: request.interpreterLine,
        deps: manifest.deps,
        inputs: expandedInputs(state, manifest.inputs, bytes.toString("utf8")),
        outputs: manifest.outputs,
        timeout: manifest.timeoutSecs,
      });
    });
    if (decision.approved && decision.remember) addScriptApproval(userDataDir, request.sha);
    return decision.approved;
  };
}

export function createScriptBytesApprovalRequester(
  state: RoomManagerState,
  userDataDir: string,
  emit: EventSender,
): (displayName: string, bytes: Uint8Array) => Promise<{ runner: Runner; manifest: ScriptManifest }> {
  return async (displayName, bytesValue) => {
    const bytes = Buffer.from(bytesValue);
    const manifest = parseScriptManifest(displayName, bytes.toString("utf8"));
    const runner = resolveInterpreter(manifest);
    const sha = scriptFingerprint(bytes);
    if (readScriptApprovals(userDataDir).includes(sha)) return { runner, manifest };
    const id = randomUUID();
    const decision = await new Promise<{ approved: boolean; remember: boolean }>((resolve) => {
      const timer = setTimeout(() => {
        state.scriptPending.delete(id);
        resolve({ approved: false, remember: false });
      }, 180_000);
      timer.unref?.();
      state.scriptPending.set(id, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      emit("script-approve-request", {
        id,
        name: displayName,
        interpreterLine: interpreterLine(runner, displayName),
        deps: manifest.deps,
        inputs: manifest.inputs,
        outputs: manifest.outputs,
        timeout: manifest.timeoutSecs,
      });
    });
    if (!decision.approved) throw new Error("This skill script was not approved to run.");
    if (decision.remember) addScriptApproval(userDataDir, sha);
    return { runner, manifest };
  };
}

function workflowDeps(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  userDataDir: string,
  emit: EventSender,
): WorkflowRunDeps {
  if (!deps.jobQueue) throw new Error("The job queue is unavailable.");
  return {
    ...deps.jobQueue,
    cacheDir: path.join(userDataDir, "cache"),
    userDataDir,
    emit,
    notifyFilesChanged: () => emit("room-files-changed", {}),
    isRollingBack: () => state.rollingBack,
  };
}

export async function runScriptFile(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  userDataDir: string,
  emit: EventSender,
  fileId: string,
): Promise<string> {
  if (!state.room) throw new Error("No room is open.");
  const file = await readRoomFile({ db: state.room.conn, path: state.room.path }, fileId);
  const name = file.name;
  const bytes = file.bytes ?? Buffer.alloc(0);
  if (scriptLangOf(name) === null) throw new Error("Only .py or .js files can be run as scripts.");
  const manifest = parseScriptManifest(name, bytes.toString("utf8"));
  const runner = resolveInterpreter(manifest);
  const sha = scriptFingerprint(bytes);
  if (!readScriptApprovals(userDataDir).includes(sha)) {
    const allowed = await createScriptApprovalRequester(state, userDataDir, emit)({
      fileId,
      name,
      sha,
      interpreterLine: interpreterLine(runner, name),
    });
    if (!allowed) throw new Error("This script was not approved to run.");
  }
  const workflowId = ensureScriptWorkflow(state.room.conn, fileId, name);
  return startWorkflowRun(workflowDeps(state, deps, userDataDir, emit), workflowId, "manual", null, new Set([sha]));
}

export function registerScriptSurfaceIpc(
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
  ipcMain.handle("list_scripts", () => {
    const open = room();
    return listScriptsInRoom(
      {
        db: open.conn,
        path: open.path,
        ...(open.workspace === undefined ? {} : { workspace: open.workspace }),
      },
      userDataDir,
    );
  });
  ipcMain.handle("resolve_script_run", (_event: IpcMainInvokeEvent, raw: unknown): void => {
    const args = object(raw);
    resolveScriptRun(state.scriptPending, String(args.id ?? ""), String(args.decision ?? "deny"));
  });
  ipcMain.handle("set_script_schedule", async (_event: IpcMainInvokeEvent, raw: unknown): Promise<void> => {
    const args = object(raw);
    const open = room();
    await setScriptScheduleInRoom(
      {
        db: open.conn,
        path: open.path,
        ...(open.workspace === undefined ? {} : { workspace: open.workspace }),
      },
      userDataDir,
      String(args.fileId ?? ""),
      String(args.kind ?? ""),
      String(args.param ?? ""),
      args.enabled === true,
    );
    emit("workflows-changed", undefined);
  });
  ipcMain.handle("run_script", async (_event: IpcMainInvokeEvent, raw: unknown): Promise<string> => {
    return runScriptFile(state, deps, userDataDir, emit, String(object(raw).fileId ?? ""));
  });
}
