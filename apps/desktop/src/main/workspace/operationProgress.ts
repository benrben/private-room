import { randomUUID } from "node:crypto";
import type {
  WorkspaceOperationKind,
  WorkspaceOperationPhase,
  WorkspaceOperationProgressEvent,
  WorkspaceOperationProgressSink,
} from "../../shared/workspaceProgress.js";

export interface WorkspaceOperationProgressOptions {
  operationId?: string;
  progress?: WorkspaceOperationProgressSink;
}

/** Small fail-safe reporter shared by storage and harness operations. */
export class WorkspaceOperationReporter {
  readonly operationId: string;

  constructor(
    readonly operation: WorkspaceOperationKind,
    private readonly sink?: WorkspaceOperationProgressSink,
    operationId: string = randomUUID(),
  ) {
    this.operationId = operationId;
  }

  emit(
    phase: WorkspaceOperationPhase,
    completed: number,
    total: number | null,
    unit: WorkspaceOperationProgressEvent["unit"] = "steps",
  ): void {
    const status = phase === "preparing" ? "started"
      : phase === "completed" ? "completed"
        : phase === "failed" ? "failed"
          : "running";
    const event: WorkspaceOperationProgressEvent = {
      operationId: this.operationId,
      operation: this.operation,
      phase,
      status,
      completed: Math.max(0, Math.floor(completed)),
      total: total === null ? null : Math.max(0, Math.floor(total)),
      unit,
    };
    // Reporting must never make a safe storage operation fail.
    try { this.sink?.(event); } catch { /* renderer may have closed */ }
  }

  start(): void { this.emit("preparing", 0, null); }
  complete(): void { this.emit("completed", 1, 1); }
  fail(): void { this.emit("failed", 0, null); }
}
