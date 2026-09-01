import type { Room, RoomManagerState } from "../roomManager.js";
import { createWorkspaceMcpBridge } from "../workspace/workspaceMcp.js";

interface BaselineRow {
  baseline_completed: number;
  status: string;
}

export interface DeepWorkspaceBridgeGrant {
  workspace: ReturnType<typeof createWorkspaceMcpBridge>;
  /** Fields copied into Python RunRequest.mcp beside the bridge URL/token. */
  wireAuthority: {
    workspaceWrite: boolean;
    baselineRunId: string;
  };
}

/**
 * Create the Deep Harness workspace capability for exactly one run.
 *
 * The normal room bridge is permanently read-only. A caller may request this
 * write grant only after RunProtection has committed every baseline object and
 * moved the matching agent_runs row to `running`.
 */
export function createDeepWorkspaceBridgeGrant(
  state: RoomManagerState,
  runId: string,
  requestedWrite: boolean,
): DeepWorkspaceBridgeGrant {
  validateDeepWorkspaceRunId(runId);
  const room = deepWorkspaceRoom(state);
  const writeEnabled = deepWorkspaceWriteEnabled(room, runId, requestedWrite);

  return {
    workspace: createWorkspaceMcpBridge(state, writeEnabled),
    wireAuthority: {
      workspaceWrite: writeEnabled,
      baselineRunId: writeEnabled ? runId : "",
    },
  };
}

type DeepWorkspaceRoom = Room & {
  workspace: NonNullable<Room["workspace"]>;
  descriptor: NonNullable<Room["descriptor"]> & { kind: "workspace-folder" };
};

function validateDeepWorkspaceRunId(runId: string): void {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw new Error("The agent run ID is invalid.");
}

function deepWorkspaceRoom(state: RoomManagerState): DeepWorkspaceRoom {
  const room = state.room;
  if (room?.workspace === undefined || room.descriptor?.kind !== "workspace-folder") {
    throw new Error("The Deep Harness requires an unlocked workspace room.");
  }
  return room as DeepWorkspaceRoom;
}

function deepWorkspaceWriteEnabled(room: DeepWorkspaceRoom, runId: string, requestedWrite: boolean): boolean {
  if (!requestedWrite) return false;
  const baseline = room.conn.prepare(
    `SELECT baseline_completed, status
     FROM agent_runs
     WHERE run_id = ? AND room_id = ?`,
  ).get(runId, room.descriptor.roomId) as BaselineRow | undefined;
  if (!hasCompletedDeepWorkspaceBaseline(baseline)) {
    throw new Error("The write workspace bridge cannot start before its rollback baseline is complete.");
  }
  return true;
}

function hasCompletedDeepWorkspaceBaseline(baseline: BaselineRow | undefined): boolean {
  return baseline !== undefined && baseline.baseline_completed === 1 && baseline.status === "running";
}
