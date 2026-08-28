import type { RoomManagerState } from "../roomManager.js";
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
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw new Error("The agent run ID is invalid.");
  const room = state.room;
  if (
    room?.workspace === undefined
    || room.descriptor?.kind !== "workspace-folder"
  ) {
    throw new Error("The Deep Harness requires an unlocked workspace room.");
  }

  let writeEnabled = false;
  if (requestedWrite) {
    const baseline = room.conn.prepare(
      `SELECT baseline_completed, status
       FROM agent_runs
       WHERE run_id = ? AND room_id = ?`,
    ).get(runId, room.descriptor.roomId) as BaselineRow | undefined;
    if (baseline === undefined || baseline.baseline_completed !== 1 || baseline.status !== "running") {
      throw new Error("The write workspace bridge cannot start before its rollback baseline is complete.");
    }
    writeEnabled = true;
  }

  return {
    workspace: createWorkspaceMcpBridge(state, writeEnabled),
    wireAuthority: {
      workspaceWrite: writeEnabled,
      baselineRunId: writeEnabled ? runId : "",
    },
  };
}
