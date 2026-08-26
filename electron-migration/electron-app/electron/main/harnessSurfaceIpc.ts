import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { ApprovalDecision, PrivacyMode } from "../shared/harnessTypes.js";
import { HarnessController, type HarnessStartRequest } from "./harness/controller.js";
import type { RoomManagerDeps, RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";

function stringValue(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(`${label} must be a${allowEmpty ? "" : " non-empty"} string.`);
  }
  return value;
}

function startRequest(args: unknown): HarnessStartRequest {
  const row = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  if (row.provider !== "codex" && row.provider !== "claude") throw new Error("provider must be codex or claude.");
  if (row.privacyMode !== "local" && row.privacyMode !== "cloud-direct" && row.privacyMode !== "cloud-redacted") {
    throw new Error("privacyMode is invalid.");
  }
  if (typeof row.writeEnabled !== "boolean") throw new Error("writeEnabled must be a boolean.");
  return {
    provider: row.provider,
    model: stringValue(row.model, "model"),
    privacyMode: row.privacyMode satisfies PrivacyMode,
    writeEnabled: row.writeEnabled,
    text: stringValue(row.text, "text"),
    ...(row.threadId === undefined ? {} : { threadId: stringValue(row.threadId, "threadId") }),
    ...(row.systemPrompt === undefined ? {} : { systemPrompt: stringValue(row.systemPrompt, "systemPrompt", true) }),
  };
}

export function registerHarnessSurfaceIpc(
  ipcMain: Pick<IpcMain, "handle">,
  state: RoomManagerState,
  deps: RoomManagerDeps,
  userDataDir: string,
  emit: EventSender,
): HarnessController {
  const controller = new HarnessController(state, userDataDir, emit);
  const handle = (channel: string, fn: (args: unknown) => unknown): void => {
    ipcMain.handle(channel, (_event: IpcMainInvokeEvent, args: unknown) => fn(args));
  };
  handle("harness_capabilities", () => controller.capabilities());
  handle("harness_start", (args) => controller.start(startRequest(args)).then((runId) => ({ runId })));
  handle("harness_approve", (args) => {
    const row = args as Record<string, unknown>;
    const decision = row.decision;
    if (decision !== "allow-once" && decision !== "allow-run" && decision !== "deny" && decision !== "cancel") {
      throw new Error("The harness approval decision is invalid.");
    }
    return controller.approve(
      stringValue(row.runId, "runId"),
      stringValue(row.requestId, "requestId"),
      decision satisfies ApprovalDecision,
    );
  });
  handle("harness_cancel", (args) => controller.cancel(stringValue((args as Record<string, unknown>).runId, "runId")));
  handle("harness_cloud_writeback", (args) => {
    const row = args as Record<string, unknown>;
    if (typeof row.approved !== "boolean") throw new Error("approved must be a boolean.");
    controller.approveCloudWriteback(stringValue(row.runId, "runId"), row.approved);
  });
  handle("harness_rollback", (args) => controller.rollback(stringValue((args as Record<string, unknown>).runId, "runId")));
  handle("harness_restore_baseline_copies", (args) => {
    const row = args as Record<string, unknown>;
    if (!Array.isArray(row.relativePaths) || !row.relativePaths.every((value) => typeof value === "string")) {
      throw new Error("relativePaths must be a list of strings.");
    }
    return controller.restoreBaselineAsCopies(stringValue(row.runId, "runId"), row.relativePaths as string[]);
  });

  // Lock/close waits for providers and mirror finalization while the encrypted
  // database is still open. Forced teardown also sends a best-effort cancel.
  deps.stopHarnessRuns = (timeoutMs) => controller.stopAll(timeoutMs);
  deps.stopHarnessRunsNoWait = () => controller.stopAllNoWait();
  void controller.cleanupAbandoned().catch(() => undefined);
  return controller;
}
