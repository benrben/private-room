import { randomBytes } from "node:crypto";
import path from "node:path";
import { McpBridge, type ToolDispatcher, type ToolScope } from "../mcpBridge.js";
import type { RoomManagerState } from "../roomManager.js";
import { createWorkspaceMcpBridge } from "../workspace/workspaceMcp.js";
import {
  createCloudPrivacyWorkspaceBackend,
  createMirrorWorkspaceBackend,
  type WorkspaceCalls,
} from "./legacyCli.js";
import type { HarnessContext } from "./types.js";

const ROOM_SCOPE: ToolScope = { kind: "CloudEngine" };

export const NATIVE_ROOM_MCP_SERVER = "room";
export const NATIVE_ROOM_MCP_TOKEN_ENV = "ARCELLE_ROOM_MCP_TOKEN";

interface BaselineRow {
  baseline_completed: number;
  status: string;
  write_enabled: number;
}

export interface NativeRoomMcpExposure {
  readonly url: string;
  readonly token: string;
  readonly instructions: string;
  stop(): Promise<void>;
}

export type NativeRoomDispatcherFactory = (
  context: HarnessContext,
  workspace: WorkspaceCalls,
) => ToolDispatcher;

export type NativeRoomMcpFactory = (context: HarnessContext) => Promise<NativeRoomMcpExposure>;

/**
 * Build the one MCP bridge owned by a native provider turn.
 *
 * HarnessOrchestrator calls the provider only after RunProtection has moved
 * the matching run row from `preparing` to `running`. Re-check that boundary
 * here before exposing any write-capable Arcelle tool, so no direct driver or
 * future call site can accidentally bypass the rollback baseline.
 */
export function createNativeRoomMcpFactory(
  state: RoomManagerState,
  dispatcher: NativeRoomDispatcherFactory,
): NativeRoomMcpFactory {
  return async (context) => {
    const room = state.room;
    if (
      room?.workspace === undefined
      || room.descriptor?.kind !== "workspace-folder"
      || room.descriptor.rootPath === null
      || room.descriptor.roomId !== context.roomId
    ) {
      throw new Error("The native Room MCP bridge requires the matching unlocked workspace room.");
    }

    const baseline = room.conn.prepare(
      `SELECT baseline_completed, status, write_enabled
       FROM agent_runs
       WHERE run_id = ? AND room_id = ?`,
    ).get(context.runId, context.roomId) as BaselineRow | undefined;
    if (
      baseline === undefined
      || baseline.baseline_completed !== 1
      || baseline.status !== "running"
      || baseline.write_enabled !== (context.writeEnabled ? 1 : 0)
      || (context.writeEnabled && room.readOnly === true)
    ) {
      throw new Error("The native Room MCP bridge cannot start before its rollback baseline is complete.");
    }

    const realRoot = path.resolve(room.descriptor.rootPath);
    const exposedRoot = path.resolve(context.workspacePath);
    let workspace: WorkspaceCalls;
    if (context.privacyMode === "cloud-redacted") {
      if (exposedRoot === realRoot) {
        throw new Error("Cloud Privacy native runs require the redacted workspace mirror.");
      }
      workspace = createCloudPrivacyWorkspaceBackend(
        createMirrorWorkspaceBackend(context.workspacePath, context.writeEnabled),
        createWorkspaceMcpBridge(state, context.writeEnabled),
      );
    } else {
      if (exposedRoot !== realRoot) {
        throw new Error("Direct native runs require the real verified workspace.");
      }
      workspace = createWorkspaceMcpBridge(state, context.writeEnabled);
    }

    const token = randomBytes(32).toString("base64url");
    const bridge = new McpBridge({
      token,
      scope: ROOM_SCOPE,
      dispatcher: dispatcher(context, workspace),
    });
    await bridge.listen(0);
    let stopped = false;
    return {
      url: bridge.url,
      token,
      instructions: [
        "Arcelle exposes a trusted MCP server named room for this run.",
        "Use native file tools for ordinary reads and edits inside the exposed workspace.",
        "Use only tools actually listed by the room server for Arcelle operations; never invent MCP tool names.",
        "For file organization, rename, move, and trash operations, prefer the registered room tools so Arcelle can preserve metadata and recovery behavior.",
      ].join(" "),
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await bridge.stop();
      },
    };
  };
}
