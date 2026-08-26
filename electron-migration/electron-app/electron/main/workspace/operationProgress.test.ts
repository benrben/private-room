import { describe, expect, it, vi } from "vitest";
import type { WorkspaceOperationProgressEvent } from "../../shared/workspaceProgress.js";
import { WorkspaceOperationReporter } from "./operationProgress.js";

describe("WorkspaceOperationReporter", () => {
  it("uses one operation id and normalizes provider-neutral progress", () => {
    const events: WorkspaceOperationProgressEvent[] = [];
    const reporter = new WorkspaceOperationReporter("legacy-conversion", (event) => events.push(event), "op-1");
    reporter.start();
    reporter.emit("copying-files", 1.9, 3.2, "files");
    reporter.complete();
    expect(events).toEqual([
      { operationId: "op-1", operation: "legacy-conversion", phase: "preparing", status: "started", completed: 0, total: null, unit: "steps" },
      { operationId: "op-1", operation: "legacy-conversion", phase: "copying-files", status: "running", completed: 1, total: 3, unit: "files" },
      { operationId: "op-1", operation: "legacy-conversion", phase: "completed", status: "completed", completed: 1, total: 1, unit: "steps" },
    ]);
  });

  it("does not let a closed renderer break the operation", () => {
    const reporter = new WorkspaceOperationReporter("write-baseline", vi.fn(() => { throw new Error("gone"); }));
    expect(() => reporter.start()).not.toThrow();
    expect(() => reporter.fail()).not.toThrow();
  });
});
