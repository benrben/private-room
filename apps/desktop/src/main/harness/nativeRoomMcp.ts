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

type NativeWorkspaceRoom = NonNullable<RoomManagerState["room"]> & {
  descriptor: NonNullable<NonNullable<RoomManagerState["room"]>["descriptor"]> & {
    kind: "workspace-folder";
    rootPath: string;
  };
  workspace: NonNullable<NonNullable<RoomManagerState["room"]>["workspace"]>;
};

interface NativeWorkspaceSelection {
  nativeExposure: "direct" | "redacted";
  workspace: WorkspaceCalls;
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

const NATIVE_ROOM_MCP_INSTRUCTIONS = [
  "Arcelle provides a trusted MCP server named room for this run.",
  "Work only with normal files inside the exposed workspace.",
  "The private .arcelle folder is always blocked. Never try to read, list, change, move, or delete .arcelle.",
  "Use the provider's native file tools first when they support the task: Read, Write, Edit, Glob, Grep, NotebookEdit, or the native shell.",
  "Do not use an Arcelle MCP tool for a normal file action that a native tool can complete.",
  "When this run allows file changes, Claude has no native rename, move, or delete tool. This is an exception to the native-shell-first rule: Claude must use workspace_rename to rename, workspace_move to move, and workspace_delete to delete a normal file. workspace_delete moves the file to Arcelle Trash, so it can be restored.",
  "In a Cloud Privacy mirror, an exact workspace organization tool may be hidden. Use the Arcelle rename, move, or trash tool that the room server lists.",
  "Use only tool names listed by the room server. Never invent an MCP tool name.",
].join(" ");

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

function matchingUnlockedWorkspace(
  state: RoomManagerState,
  context: HarnessContext,
): NativeWorkspaceRoom {
  const room = state.room;
  if (
    room?.workspace === undefined
    || room.descriptor?.kind !== "workspace-folder"
    || room.descriptor.rootPath === null
    || room.descriptor.roomId !== context.roomId
  ) {
    throw new Error("The native Room MCP bridge requires the matching unlocked workspace room.");
  }
  return room as NativeWorkspaceRoom;
}

function readBaseline(room: NativeWorkspaceRoom, context: HarnessContext): BaselineRow | undefined {
  return room.conn.prepare(
    `SELECT baseline_completed, status, write_enabled
     FROM agent_runs
     WHERE run_id = ? AND room_id = ?`,
  ).get(context.runId, context.roomId) as BaselineRow | undefined;
}

function baselineWriteModeMatches(baseline: BaselineRow, context: HarnessContext): boolean {
  return baseline.write_enabled === (context.writeEnabled ? 1 : 0);
}

function writableNativeRoom(room: NativeWorkspaceRoom, context: HarnessContext): boolean {
  return !context.writeEnabled || room.readOnly !== true;
}

function baselineAllowsNativeRoomMcp(
  baseline: BaselineRow | undefined,
  room: NativeWorkspaceRoom,
  context: HarnessContext,
): boolean {
  if (baseline === undefined) return false;
  if (baseline.baseline_completed !== 1) return false;
  if (baseline.status !== "running") return false;
  if (!baselineWriteModeMatches(baseline, context)) return false;
  return writableNativeRoom(room, context);
}

function requireNativeRoomBaseline(
  room: NativeWorkspaceRoom,
  context: HarnessContext,
): void {
  if (baselineAllowsNativeRoomMcp(readBaseline(room, context), room, context)) return;
  throw new Error("The native Room MCP bridge cannot start before its rollback baseline is complete.");
}

function redactedNativeWorkspace(
  state: RoomManagerState,
  context: HarnessContext,
  realRoot: string,
  exposedRoot: string,
): NativeWorkspaceSelection {
  if (exposedRoot === realRoot) {
    throw new Error("Cloud Privacy native runs require the redacted workspace mirror.");
  }
  return {
    nativeExposure: "redacted",
    workspace: createCloudPrivacyWorkspaceBackend(
      createMirrorWorkspaceBackend(context.workspacePath, context.writeEnabled),
      createWorkspaceMcpBridge(state, context.writeEnabled),
    ),
  };
}

function directNativeWorkspace(
  state: RoomManagerState,
  context: HarnessContext,
  realRoot: string,
  exposedRoot: string,
): NativeWorkspaceSelection {
  if (exposedRoot !== realRoot) {
    throw new Error("Direct native runs require the real verified workspace.");
  }
  return {
    nativeExposure: "direct",
    workspace: createWorkspaceMcpBridge(state, context.writeEnabled),
  };
}

function selectNativeWorkspace(
  state: RoomManagerState,
  room: NativeWorkspaceRoom,
  context: HarnessContext,
): NativeWorkspaceSelection {
  const realRoot = path.resolve(room.descriptor.rootPath);
  const exposedRoot = path.resolve(context.workspacePath);
  if (context.privacyMode === "cloud-redacted") {
    return redactedNativeWorkspace(state, context, realRoot, exposedRoot);
  }
  return directNativeWorkspace(state, context, realRoot, exposedRoot);
}

function oneShotBridgeStop(bridge: McpBridge): () => Promise<void> {
  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    await bridge.stop();
  };
}

async function exposeNativeRoomMcp(
  context: HarnessContext,
  dispatcher: NativeRoomDispatcherFactory,
  selection: NativeWorkspaceSelection,
): Promise<NativeRoomMcpExposure> {
  const token = randomBytes(32).toString("base64url");
  const selectedDispatcher = dispatcher(context, selection.workspace);
  const bridge = new McpBridge({
    token,
    scope: ROOM_SCOPE,
    dispatcher: nativeRoomDispatcher(selectedDispatcher, selection.nativeExposure),
  });
  await bridge.listen(0);
  return {
    url: bridge.url,
    token,
    instructions: NATIVE_ROOM_MCP_INSTRUCTIONS,
    stop: oneShotBridgeStop(bridge),
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
    const room = matchingUnlockedWorkspace(state, context);
    requireNativeRoomBaseline(room, context);
    return exposeNativeRoomMcp(context, dispatcher, selectNativeWorkspace(state, room, context));
  };
}
