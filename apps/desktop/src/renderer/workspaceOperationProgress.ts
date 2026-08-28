import type {
  WorkspaceOperationKind,
  WorkspaceOperationPhase,
  WorkspaceOperationProgressEvent,
} from "./apiTypes";

const OPERATION_LABELS: Record<WorkspaceOperationKind, string> = {
  "legacy-conversion": "Converting legacy room",
  "sealed-package-create": "Creating sealed backup",
  "sealed-package-import": "Importing sealed backup",
  "workspace-checkpoint": "Saving checkpoint",
  "write-baseline": "Protecting files before the agent starts",
};

const PHASE_LABELS: Record<WorkspaceOperationPhase, string> = {
  preparing: "Preparing",
  planning: "Planning",
  scanning: "Scanning files",
  "copying-files": "Copying files",
  "copying-history": "Copying private history",
  validating: "Checking the result",
  publishing: "Finishing safely",
  snapshotting: "Saving recovery copies",
  completed: "Complete",
  failed: "Failed",
};

export function workspaceOperationLabel(operation: WorkspaceOperationKind): string {
  return OPERATION_LABELS[operation];
}

export function workspaceOperationDetail(event: WorkspaceOperationProgressEvent): string {
  const phase = PHASE_LABELS[event.phase];
  if (event.status === "completed" || event.status === "failed") return phase;
  if (event.total === null || event.total <= 0) return `${phase}…`;
  const completed = Math.min(Math.max(0, event.completed), event.total);
  return `${phase} — ${completed} of ${event.total} ${event.unit}`;
}

/** Replace one operation without hiding other long operations that overlap it. */
export function updateWorkspaceOperations(
  current: readonly WorkspaceOperationProgressEvent[],
  event: WorkspaceOperationProgressEvent,
): WorkspaceOperationProgressEvent[] {
  const index = current.findIndex((entry) => entry.operationId === event.operationId);
  if (index < 0) return [...current, event];
  const next = [...current];
  next[index] = event;
  return next;
}

export function removeWorkspaceOperation(
  current: readonly WorkspaceOperationProgressEvent[],
  operationId: string,
): WorkspaceOperationProgressEvent[] {
  return current.filter((entry) => entry.operationId !== operationId);
}
