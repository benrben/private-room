import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ randomUUID: vi.fn() }));

vi.mock("node:crypto", () => ({ randomUUID: mocks.randomUUID }));
vi.mock("./db-host/files.js", () => ({
  getFileBytes: vi.fn(),
  getFileName: vi.fn(),
  setFileExtractedText: vi.fn(),
}));
vi.mock("./db-host/settings.js", () => ({ getSetting: vi.fn() }));
vi.mock("./editMatch.js", () => ({
  EditError: class EditError extends Error {},
  commitPlans: vi.fn(),
  extractText: vi.fn(),
  hashBytes: vi.fn(() => Buffer.alloc(0)),
}));

import { editCallApproved, resolveEditApproval, type EditPreview, type GatedWriteDeps } from "./editGate.js";

function dependencies(timeoutMs?: number, emit?: (event: string, payload: unknown) => void): GatedWriteDeps {
  const deps: GatedWriteDeps = {
    editPending: new Map(),
    emit,
    rooms: { currentRoom: () => null },
  };
  if (timeoutMs !== undefined) deps.timeoutMs = timeoutMs;
  return deps;
}

const preview: EditPreview = {
  tool: "edit_file",
  allowTurn: true,
  files: [{ name: "plan.md", before: "before", after: "after", clipped: false }],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
});

afterEach(() => vi.useRealTimers());

describe("editCallApproved with fabricated approval dependencies", () => {
  it("emits the exact preview and marks a run-scoped turn approval", async () => {
    mocks.randomUUID.mockReturnValue("approval-1");
    const events: Array<[string, unknown]> = [];
    const deps = dependencies(20, (event, payload) => events.push([event, payload]));
    const effects = { runScoped: true, editApprovedThisTurn: false };

    const waiting = editCallApproved(deps, effects, preview);

    expect(events).toEqual([
      [
        "edit-approve-request",
        { id: "approval-1", tool: "edit_file", allowTurn: true, files: preview.files },
      ],
    ]);
    resolveEditApproval(deps.editPending, "approval-1", "turn");
    await expect(waiting).resolves.toBe("approved");
    expect(effects.editApprovedThisTurn).toBe(true);
    expect(deps.editPending).toEqual(new Map());
  });

  it("returns declined without changing the turn flag", async () => {
    mocks.randomUUID.mockReturnValue("approval-2");
    const deps = dependencies();
    const effects = { runScoped: true, editApprovedThisTurn: false };
    const waiting = editCallApproved(deps, effects, preview);

    resolveEditApproval(deps.editPending, "approval-2", "decline");
    await expect(waiting).resolves.toBe("declined");
    expect(effects.editApprovedThisTurn).toBe(false);
  });

  it("ignores duplicate resolutions and an already-scheduled timeout after approval", async () => {
    mocks.randomUUID.mockReturnValue("approval-3");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
    const deps = dependencies(20);
    const effects = { runScoped: false, editApprovedThisTurn: false };
    const waiting = editCallApproved(deps, effects, preview);
    const resolveOnce = deps.editPending.get("approval-3");
    if (!resolveOnce) throw new Error("fabricated approval was not registered");

    resolveEditApproval(deps.editPending, "approval-3", "once");
    resolveOnce({ approved: false, restOfTurn: false });
    await vi.advanceTimersByTimeAsync(20);

    await expect(waiting).resolves.toBe("approved");
    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    expect(effects.editApprovedThisTurn).toBe(false);
  });

  it("declines as no_answer and removes an unanswered fabricated approval on timeout", async () => {
    mocks.randomUUID.mockReturnValue("approval-4");
    const deps = dependencies(20);
    const waiting = editCallApproved(deps, { runScoped: false, editApprovedThisTurn: false }, preview);

    await vi.advanceTimersByTimeAsync(20);

    await expect(waiting).resolves.toBe("no_answer");
    expect(deps.editPending.size).toBe(0);
  });
});
