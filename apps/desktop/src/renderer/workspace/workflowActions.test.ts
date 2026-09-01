import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  api: {
    deleteWorkflow: vi.fn(),
    listWorkflows: vi.fn(),
    runWorkflow: vi.fn(),
    saveWorkflow: vi.fn(),
    setWorkflowPinned: vi.fn(),
    setWorkflowSchedule: vi.fn(),
    setWorkflowStatus: vi.fn(),
    updateWorkflow: vi.fn(),
  },
  tryToast: vi.fn(async (_state: unknown, work: () => Promise<void>) => work()),
}));

vi.mock("../api", () => ({ api: fakes.api }));
vi.mock("./guard", () => ({ tryToast: fakes.tryToast }));

import { makeWorkflowActions } from "./workflowActions";

function state() {
  return {
    pushToast: vi.fn(),
    setOpenFile: vi.fn(),
    setShowMap: vi.fn(),
    setShowWorkflows: vi.fn(),
    setWfDetailId: vi.fn(),
    setWorkflows: vi.fn(),
    workflows: [{ id: "workflow-1", name: "Fabricated workflow" }],
  };
}

describe("workflow actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes fabricated workflows but preserves the screen list when that read fails", async () => {
    const s = state();
    const actions = makeWorkflowActions(s as never);
    const fetched = [{ id: "workflow-2", name: "Fresh fabricated workflow" }];
    fakes.api.listWorkflows.mockResolvedValueOnce(fetched).mockRejectedValueOnce(new Error("fake room unavailable"));

    await actions.refreshWorkflows();
    await actions.refreshWorkflows();

    expect(s.setWorkflows).toHaveBeenCalledOnce();
    expect(s.setWorkflows).toHaveBeenCalledWith(fetched);
  });

  it("opens fabricated workflow views and runs both general and file-specific actions", async () => {
    const s = state();
    const actions = makeWorkflowActions(s as never);
    fakes.api.listWorkflows.mockResolvedValue([]);
    fakes.api.runWorkflow.mockResolvedValue(undefined);

    actions.openWorkflows();
    actions.openWorkflowDetail("workflow-1");
    await actions.runWorkflowNow("workflow-1");
    await actions.runWorkflowNow("missing-workflow", "file-1");
    await actions.runWorkflowOn("workflow-1", "file-2", "fabricated.md");

    expect(s.setShowMap).toHaveBeenCalledWith(false);
    expect(s.setOpenFile).toHaveBeenCalledWith(null);
    expect(s.setWfDetailId).toHaveBeenCalledWith(null);
    expect(s.setWfDetailId).toHaveBeenCalledWith("workflow-1");
    expect(fakes.api.runWorkflow).toHaveBeenNthCalledWith(1, "workflow-1", undefined);
    expect(fakes.api.runWorkflow).toHaveBeenNthCalledWith(2, "missing-workflow", "file-1");
    expect(fakes.api.runWorkflow).toHaveBeenNthCalledWith(3, "workflow-1", "file-2");
    expect(s.pushToast).toHaveBeenNthCalledWith(
      1,
      "info",
      "Fabricated workflow started",
      expect.objectContaining({ label: "View", run: expect.any(Function) }),
    );
    expect(s.pushToast).toHaveBeenNthCalledWith(
      2,
      "info",
      "Workflow started",
      expect.objectContaining({ label: "View", run: expect.any(Function) }),
    );
    expect(s.pushToast).toHaveBeenNthCalledWith(
      3,
      "info",
      "Fabricated workflow started on fabricated.md",
      expect.objectContaining({ label: "View", run: expect.any(Function) }),
    );

    const detail = s.pushToast.mock.calls[0]?.[2].run as () => void;
    const library = s.pushToast.mock.calls[2]?.[2].run as () => void;
    detail();
    library();
    expect(s.setWfDetailId).toHaveBeenLastCalledWith(null);
  });

  it("updates, deletes, and creates workflows against the fabricated API", async () => {
    const s = state();
    const actions = makeWorkflowActions(s as never);
    fakes.api.listWorkflows.mockResolvedValue([]);
    fakes.api.saveWorkflow
      .mockResolvedValueOnce("workflow-from-template")
      .mockResolvedValueOnce("workflow-blank");

    await actions.setWorkflowStatus("workflow-1", "active");
    await actions.setWorkflowPinned("workflow-1", true);
    await actions.setWorkflowSchedule("workflow-1", { kind: "daily" } as never);
    await actions.saveWorkflowEdits("workflow-1", { name: "Renamed", definition: { version: 1 } });
    await actions.deleteWorkflow("workflow-1");
    await actions.instantiateTemplate({
      name: "Template",
      description: "A fake template",
      emoji: "✨",
      definition: { version: 1 },
      binding: { kind: "all" },
      schedule: { kind: "manual" },
    } as never);
    await actions.createBlankWorkflow();

    expect(fakes.api.setWorkflowStatus).toHaveBeenCalledWith("workflow-1", "active");
    expect(fakes.api.setWorkflowPinned).toHaveBeenCalledWith("workflow-1", true);
    expect(fakes.api.setWorkflowSchedule).toHaveBeenCalledWith("workflow-1", { kind: "daily" });
    expect(fakes.api.updateWorkflow).toHaveBeenCalledWith({
      id: "workflow-1",
      name: "Renamed",
      definition: { version: 1 },
    });
    expect(fakes.api.deleteWorkflow).toHaveBeenCalledWith("workflow-1");
    expect(s.setWfDetailId).toHaveBeenCalledWith(null);
    expect(fakes.api.saveWorkflow).toHaveBeenNthCalledWith(1, expect.objectContaining({
      name: "Template",
      description: "A fake template",
      emoji: "✨",
    }));
    expect(fakes.api.saveWorkflow).toHaveBeenNthCalledWith(2, expect.objectContaining({
      name: "New workflow",
      emoji: "⚙️",
      definition: expect.objectContaining({ version: 1 }),
    }));
    expect(s.setWfDetailId).toHaveBeenCalledWith("workflow-from-template");
    expect(s.setWfDetailId).toHaveBeenCalledWith("workflow-blank");
    expect(fakes.tryToast).toHaveBeenCalledTimes(7);
  });
});
