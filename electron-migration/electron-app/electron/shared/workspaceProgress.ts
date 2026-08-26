/** Provider-neutral progress for long workspace storage operations. */
export type WorkspaceOperationKind =
  | "legacy-conversion"
  | "sealed-package-create"
  | "sealed-package-import"
  | "workspace-checkpoint"
  | "write-baseline";

export type WorkspaceOperationPhase =
  | "preparing"
  | "planning"
  | "scanning"
  | "copying-files"
  | "copying-history"
  | "validating"
  | "publishing"
  | "snapshotting"
  | "completed"
  | "failed";

export interface WorkspaceOperationProgressEvent {
  /** Stable for one invocation; a harness baseline uses its run ID. */
  operationId: string;
  operation: WorkspaceOperationKind;
  phase: WorkspaceOperationPhase;
  status: "started" | "running" | "completed" | "failed";
  /** Progress within the current phase. */
  completed: number;
  /** Null only while the phase cannot yet know its item count. */
  total: number | null;
  unit: "steps" | "files" | "objects";
}

export type WorkspaceOperationProgressSink = (event: WorkspaceOperationProgressEvent) => void;

