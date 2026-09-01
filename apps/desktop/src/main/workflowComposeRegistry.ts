import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type Database from "better-sqlite3-multiple-ciphers";
import { createWorkflow, upsertSchedule } from "./db-host/workflows.js";
import { listModels as listModelsReal, stripThinkSpans } from "./engineRouting.js";
import {
  runExternalCli as runExternalCliReal,
  type ExternalRunResult,
  type RunExternalOptions,
} from "./externalAdvisor.js";
import { modelSetting } from "./gatherContext.js";
import { nextRunFromNow } from "./jobScheduler.js";
import { generate as realOllamaGenerate } from "./ollamaGenerate.js";
import { KEEP_ALIVE_WARM } from "./ollamaModels.js";
import type { SidecarChatMessage } from "./sidecar.js";
import { isCliEngine, ROLLBACK_BUSY } from "./turnContext.js";
import type { OpenRoom } from "./turnEngine.js";
import {
  compileWorkflow,
  defUsesRunInput,
  defaultResolvedModel,
  parseWorkflowBinding,
  parseWorkflowDef,
  validateWithBinding,
  type WorkflowBinding,
  type WorkflowDef,
} from "./workflowModel.js";
import {
  composeWorkflow,
  type ComposeWorkflowDeps,
  type EmitFn,
} from "./workflowComposeRun.js";
import { workflowTemplates } from "./workflowComposeTemplates.js";

// ============================================================================
// the #[tauri::command] half
// ============================================================================

/** The slice of room state these handlers need: whichever room is open RIGHT
 * NOW, not whatever was open when {@link registerWorkflowComposeIpc} ran.
 * Mirrors `recIpc.ts`'s own `RoomSource` rather than importing it, so this
 * module has no runtime dependency on that one. */
export interface RoomSource {
  currentRoom(): OpenRoom | null;
}

/** `AppState::with_room`'s own refusal, spelled the way `recIpc.ts`,
 * `docxEdit.ts` and `skillsCmds.ts` already spell it. */
export const NO_ROOM_OPEN = "No room is open.";

export function openDb(room: RoomSource): Database.Database {
  const open = room.currentRoom();
  if (open === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return open.db;
}

/**
 * Register this slice's two `#[tauri::command]`s on `ipcMain`, under the exact
 * channel names `src/api.ts` already invokes (`compose_workflow` at line 782,
 * `workflow_templates` at 749), so the renderer needs no rename. `ipcMain` is a
 * PARAMETER, typed against the real `electron` module without importing it at
 * runtime, so this file resolves and tests under plain Node/vitest — the
 * `registerRecIpc`/`registerDocxEditIpc` precedent.
 *
 * Exported and directly testable, but — same as those two — NOT called from any
 * live main-process entrypoint by this batch. Wiring it in is Phase 2 work
 * pending an explicit owner go-ahead.
 */
export function registerWorkflowComposeIpc(
  ipcMain: Pick<IpcMain, "handle">,
  room: RoomSource,
  deps: ComposeWorkflowDeps = {},
  emit?: EmitFn
): void {
  ipcMain.handle("workflow_templates", (_event: IpcMainInvokeEvent) => workflowTemplates());
  ipcMain.handle(
    "compose_workflow",
    (_event: IpcMainInvokeEvent, args: { description: string }) =>
      composeWorkflow(openDb(room), args.description, deps, emit)
  );
}
