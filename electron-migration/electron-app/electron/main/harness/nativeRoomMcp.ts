import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  McpBridge,
  type ToolCallResult,
  type ToolDispatcher,
  type ToolScope,
} from "../mcpBridge.js";
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

const NATIVE_CONTENT_TOOLS = new Set([
  "workspace_list",
  "workspace_read",
  "workspace_write",
  "workspace_edit",
  "workspace_glob",
  "workspace_grep",
  "list_room_files",
  "create_file",
  "edit_file",
  "edit_files",
  "write_file",
]);

const REDACTED_EXACT_ORGANIZATION_TOOLS = new Set([
  "workspace_move",
  "workspace_rename",
  "workspace_delete",
]);

/**
 * Native harnesses already have provider-owned file tools over their exposed
 * root (real or redacted). Hide Arcelle's duplicate content tools. A redacted
 * run also hides exact workspace organization because trusted standard
 * rename/move/trash tools own metadata recovery against the real room.
 */
export function nativeRoomDispatcher(
  base: ToolDispatcher,
  exposure: "direct" | "redacted",
): ToolDispatcher {
  const hidden = (name: string): boolean => NATIVE_CONTENT_TOOLS.has(name)
    || (exposure === "redacted" && REDACTED_EXACT_ORGANIZATION_TOOLS.has(name));
  return {
    listTools: (scope) => base.listTools(scope)
      .filter((tool) => !hidden(tool.name)),
    callTool: (scope, name, args): Promise<ToolCallResult> => {
      if (hidden(name)) {
        return Promise.resolve({
          isError: true,
          content: [{ type: "text", text: `unknown tool: ${name}` }],
        });
      }
      return base.callTool(scope, name, args);
    },
  };
}

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
    let nativeExposure: "direct" | "redacted";
    if (context.privacyMode === "cloud-redacted") {
      if (exposedRoot === realRoot) {
        throw new Error("Cloud Privacy native runs require the redacted workspace mirror.");
      }
      workspace = createCloudPrivacyWorkspaceBackend(
        createMirrorWorkspaceBackend(context.workspacePath, context.writeEnabled),
        createWorkspaceMcpBridge(state, context.writeEnabled),
      );
      nativeExposure = "redacted";
    } else {
      if (exposedRoot !== realRoot) {
        throw new Error("Direct native runs require the real verified workspace.");
      }
      workspace = createWorkspaceMcpBridge(state, context.writeEnabled);
      nativeExposure = "direct";
    }

    const token = randomBytes(32).toString("base64url");
    const selectedDispatcher = dispatcher(context, workspace);
    const bridge = new McpBridge({
      token,
      scope: ROOM_SCOPE,
      dispatcher: nativeRoomDispatcher(selectedDispatcher, nativeExposure),
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
