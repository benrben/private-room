import { describe, expect, it, vi } from "vitest";
import type { RoomManagerState } from "../roomManager.js";
import { createDeepWorkspaceBridgeGrant } from "./deepWorkspaceBridge.js";

function stateWith(row: { baseline_completed: number; status: string } | undefined): RoomManagerState {
  return {
    room: {
      descriptor: { kind: "workspace-folder", roomId: "room-1" },
      workspace: {},
      conn: {
        prepare: vi.fn(() => ({ get: vi.fn(() => row) })),
      },
    },
  } as unknown as RoomManagerState;
}

describe("createDeepWorkspaceBridgeGrant", () => {
  it("refuses an invalid run id and a non-workspace room before issuing a bridge", () => {
    expect(() => createDeepWorkspaceBridgeGrant(stateWith(undefined), "not/a-run", false)).toThrow(
      "The agent run ID is invalid."
    );
    expect(() => createDeepWorkspaceBridgeGrant({ room: null } as RoomManagerState, "run-1", false)).toThrow(
      "The Deep Harness requires an unlocked workspace room."
    );
  });

  it("keeps ordinary and read-only runs unprivileged", () => {
    const grant = createDeepWorkspaceBridgeGrant(stateWith(undefined), "run-1", false);
    expect(grant.wireAuthority).toEqual({ workspaceWrite: false, baselineRunId: "" });
  });

  it("refuses write authority until the matching baseline is complete", () => {
    expect(() => createDeepWorkspaceBridgeGrant(
      stateWith({ baseline_completed: 0, status: "preparing" }),
      "run-1",
      true,
    )).toThrow(/before its rollback baseline is complete/);
  });

  it("binds write authority to the protected run id", () => {
    const grant = createDeepWorkspaceBridgeGrant(
      stateWith({ baseline_completed: 1, status: "running" }),
      "run-1",
      true,
    );
    expect(grant.wireAuthority).toEqual({ workspaceWrite: true, baselineRunId: "run-1" });
  });
});
