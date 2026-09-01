/** Main chat-turn and context-handoff IPC over a per-turn room MCP bridge. */

import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { Room, RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";
import { ask, handoffChat, type AskDeps, type AskRequest } from "./turnEngine.js";
import { liveTurnRoomSource } from "./liveContext.js";
import { createRoomBridge, type RunningBridge } from "./moonshotServer.js";
import { roomServerDispatcherFactory } from "./roomServerLive.js";
import { modelSetting, turnEvidencePolicyForQuestion } from "./gatherContext.js";
import type { ToolDispatcher, ToolScope } from "./mcpBridge.js";
import { runsOnThisMac } from "./capabilities.js";
import { detectedExternal } from "./externalDetection.js";
import { chatModelSeesImages, groundingPick } from "./ollamaModels.js";
import { activePolicy } from "./privacy.js";
import { embedQuestion } from "./retrievalBackfill.js";
import { listModels } from "./engineRouting.js";
import { groundPreparedImage, prepareImage } from "./visionTools.js";
import { createToolEffects } from "./execTool.js";
import { webAccessEnabled } from "./browser/webAccess.js";
import { WEB_LANES_ALL } from "./toolSpecs.js";
import type { McpRuntime } from "./mcpSurfaceIpc.js";
import type { LiveAppServices } from "./liveAppServices.js";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function stringOrEmpty(value: unknown): string {
  return String(value ?? "");
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function attachmentNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isString) : [];
}

function askRequest(raw: unknown): AskRequest {
  const args = object(raw);
  return {
    chatId: stringOrEmpty(args.chatId),
    question: stringOrEmpty(args.question),
    attachments: attachmentNames(args.attachments),
    askId: stringOrEmpty(args.askId),
    viewing: isString(args.viewing) ? args.viewing : null,
    privacyBypass: args.privacyBypass === true,
  };
}

function chatTurnScope(model: string): ToolScope {
  return runsOnThisMac(model) ? { kind: "LocalEngine" } : { kind: "CloudEngine" };
}

function openChatTurnRoom(state: RoomManagerState): Room {
  const open = state.room;
  if (!open) throw new Error("No room is open.");
  return open;
}

interface ChatTurnInvocation {
  state: RoomManagerState;
  emit: EventSender;
  mcpRuntime: McpRuntime;
  services?: LiveAppServices;
  roomSource: ReturnType<typeof liveTurnRoomSource>;
}

interface ChatTurnSetup {
  invocation: ChatTurnInvocation;
  request: AskRequest;
  open: Room;
  scope: ToolScope;
  evidencePolicy: ReturnType<typeof turnEvidencePolicyForQuestion>;
  online: boolean;
  effects: ReturnType<typeof createToolEffects>;
}

/**
 * A main Assistant turn may mutate normal files only while this process owns
 * the workspace writer lease. Sealed database rooms have no normal-file
 * backend, and duplicate/concurrently-open workspace rooms remain read-only.
 */
export function chatTurnWorkspaceWriteEnabled(room: Room): boolean {
  return room.workspace !== undefined && room.readOnly !== true;
}

/** One source of truth for the per-ask bridge grants derived from user input. */
export function chatTurnBridgeRunOptions(
  room: Room,
  privacyBypass: boolean,
): { workspaceWriteEnabled: boolean; privacyBypass: boolean } {
  return {
    workspaceWriteEnabled: chatTurnWorkspaceWriteEnabled(room),
    privacyBypass,
  };
}

/** An intentional empty capability surface. Listing returns zero schemas and
 * calling a guessed tool fails without ever touching the live dispatcher. */
export function noToolsDispatcher(): ToolDispatcher {
  return {
    listTools: () => [],
    callTool: async () => ({
      isError: true,
      content: [{ type: "text", text: "Tools are disabled for this turn." }],
    }),
  };
}

function chatTurnDispatcher(setup: ChatTurnSetup): ToolDispatcher {
  if (setup.evidencePolicy === "no-tools-no-sources") return noToolsDispatcher();
  return roomServerDispatcherFactory(setup.invocation.state, setup.invocation.emit, setup.invocation.services)(
    setup.online,
    setup.scope,
    WEB_LANES_ALL,
    {
      ...chatTurnBridgeRunOptions(setup.open, setup.request.privacyBypass),
      sharedEffects: setup.effects,
    },
  );
}

async function groundImage(
  { model: chatModel, question, image }: Parameters<NonNullable<AskDeps["groundingPass"]>>[0],
): ReturnType<NonNullable<AskDeps["groundingPass"]>> {
  const models = await listModels();
  const visionModel = await groundingPick(models, chatModel);
  if (visionModel === null) return null;
  const prepared = await prepareImage(image.bytes);
  const boxes = await groundPreparedImage(
    visionModel,
    chatModel,
    prepared.bytes,
    question,
    prepared.width,
    prepared.height,
  );
  return { fileId: image.fileId, name: image.name, boxes };
}

function askDependencies(
  invocation: ChatTurnInvocation,
  bridge: RunningBridge,
  effects: ReturnType<typeof createToolEffects>,
): AskDeps {
  return {
    room: invocation.roomSource,
    cancelState: invocation.state.cancel,
    send: invocation.emit,
    mcp: () => ({
      url: `http://127.0.0.1:${bridge.port}/mcp`,
      token: bridge.token,
    }),
    connectedMcpServers: () => invocation.mcpRuntime.manager.servers
      .filter((server) => server.status === "connected")
      .map((server) => server.name),
    embedQuestion,
    runsOnThisMac,
    detectedAdvisors: detectedExternal,
    privacyActive: () => activePolicy() !== null,
    privacyPolicy: activePolicy,
    chatModelSeesImages,
    effects,
    groundingPass: groundImage,
    notifyFilesChanged: () => invocation.emit("room-files-changed", {}),
  };
}

async function askThroughBridge(setup: ChatTurnSetup) {
  const dispatcher = chatTurnDispatcher(setup);
  let bridge: RunningBridge | null = null;
  try {
    bridge = await createRoomBridge({ scope: setup.scope, dispatcher });
    return await ask(setup.request, askDependencies(setup.invocation, bridge, setup.effects));
  } finally {
    await bridge?.stopAndWait().catch(() => {});
  }
}

async function runChatTurn(raw: unknown, invocation: ChatTurnInvocation) {
  const request = askRequest(raw);
  const open = openChatTurnRoom(invocation.state);
  const evidencePolicy = turnEvidencePolicyForQuestion(open.conn, request.question);
  const scope = chatTurnScope(modelSetting(open.conn) ?? "");
  const online = webAccessEnabled(open.conn);
  const effects = createToolEffects();
  return askThroughBridge({ invocation, request, open, scope, evidencePolicy, online, effects });
}

export function registerChatTurnSurfaceIpc(
  ipcMain: Pick<IpcMain, "handle">,
  state: RoomManagerState,
  emit: EventSender,
  mcpRuntime: McpRuntime,
  services?: LiveAppServices,
): void {
  const roomSource = liveTurnRoomSource(state);
  const invocation = { state, emit, mcpRuntime, services, roomSource };

  ipcMain.handle("ask", (_event: IpcMainInvokeEvent, raw: unknown) => runChatTurn(raw, invocation));

  ipcMain.handle("handoff_chat", (_event: IpcMainInvokeEvent, raw: unknown) =>
    handoffChat(String(object(raw).chatId ?? ""), { room: roomSource }));
}
