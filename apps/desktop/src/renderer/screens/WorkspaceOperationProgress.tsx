import type { WorkspaceOperationProgressEvent } from "../api";
import {
  workspaceOperationDetail,
  workspaceOperationLabel,
} from "../workspaceOperationProgress";

export function WorkspaceOperationProgress({
  operations,
}: {
  operations: readonly WorkspaceOperationProgressEvent[];
}) {
  if (operations.length === 0) return null;

  return (
    <section
      className="workspace-operation-progress"
      aria-label="Workspace operation progress"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {operations.map((operation) => {
        const label = workspaceOperationLabel(operation.operation);
        const detail = workspaceOperationDetail(operation);
        const terminal = operation.status === "completed" || operation.status === "failed";
        return (
          <div
            className={`workspace-operation-progress-row ${operation.status}`}
            key={operation.operationId}
            role="status"
          >
            <span className="workspace-operation-progress-copy">
              <strong>{label}</strong>
              <span>{detail}</span>
            </span>
            {!terminal && operation.total !== null && operation.total > 0 ? (
              <progress
                aria-label={`${label}: ${detail}`}
                max={operation.total}
                value={Math.min(Math.max(0, operation.completed), operation.total)}
              />
            ) : !terminal ? (
              <progress aria-label={`${label}: ${detail}`} />
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
