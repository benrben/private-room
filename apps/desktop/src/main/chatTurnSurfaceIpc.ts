/** Main chat-turn and context-handoff IPC over a per-turn room MCP bridge. */

import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { Room, RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";
import { ask, handoffChat, type AskRequest } from "./turnEngine.js";
import { liveTurnRoomSource } from "./liveContext.js";
import { createRoomBridge, type RunningBridge } from "./moonshotServer.js";
import { roomServerDispatcherFactory } from "./roomServerLive.js";
import { modelSetting, turnEvidencePolicyForQuestion } from "./gatherContext.js";
import type { ToolDispatcher } from "./mcpBridge.js";
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

export function registerChatTurnSurfaceIpc(
  ipcMain: Pick<IpcMain, "handle">,
  state: RoomManagerState,
  emit: EventSender,
  mcpRuntime: McpRuntime,
  services?: LiveAppServices,
): void {
  const roomSource = liveTurnRoomSource(state);

  ipcMain.handle("ask", async (_event: IpcMainInvokeEvent, raw: unknown) => {
    const args = object(raw);
    const open = state.room;
    if (!open) throw new Error("No room is open.");
    const request: AskRequest = {
      chatId: String(args.chatId ?? ""),
      question: String(args.question ?? ""),
      attachments: Array.isArray(args.attachments)
        ? args.attachments.filter((value): value is string => typeof value === "string")
        : [],
      askId: String(args.askId ?? ""),
      viewing: typeof args.viewing === "string" ? args.viewing : null,
      privacyBypass: args.privacyBypass === true,
    };
    const evidencePolicy = turnEvidencePolicyForQuestion(open.conn, request.question);
    const model = modelSetting(open.conn) ?? "";
    const scope = runsOnThisMac(model)
      ? { kind: "LocalEngine" as const }
      : { kind: "CloudEngine" as const };
    const online = webAccessEnabled(open.conn);
    // The sidecar calls room tools over this bridge, while turnEngine owns the
    // provider-bound image queue. They must share one sink or a successful
    // read_drawing/view_file_image call loses its PNG at the bridge boundary.
    const effects = createToolEffects();
    // This bridge exists only for this user-started chat turn. Workspace
    // writes still go through the path-safe, atomic WorkspaceService and the
    // factory clamps the grant off when another process owns the room lease.
    // The same explicit one-turn privacy approval used by ask() must also
    // reach its file tools; otherwise their results stay redacted mid-turn.
    const dispatcher = evidencePolicy === "no-tools-no-sources"
      ? noToolsDispatcher()
      : roomServerDispatcherFactory(state, emit, services)(
          online,
          scope,
          WEB_LANES_ALL,
          {
            ...chatTurnBridgeRunOptions(open, request.privacyBypass),
            sharedEffects: effects,
          },
        );
    let bridge: RunningBridge | null = null;
    try {
      bridge = await createRoomBridge({ scope, dispatcher });
      const running = bridge;
      return await ask(request, {
        room: roomSource,
        cancelState: state.cancel,
        send: emit,
        mcp: () => ({
          url: `http://127.0.0.1:${running.port}/mcp`,
          token: running.token,
        }),
        connectedMcpServers: () => mcpRuntime.manager.servers
          .filter((server) => server.status === "connected")
          .map((server) => server.name),
        embedQuestion,
        runsOnThisMac,
        detectedAdvisors: detectedExternal,
        privacyActive: () => activePolicy() !== null,
        privacyPolicy: activePolicy,
        chatModelSeesImages,
        effects,
        groundingPass: async ({ model: chatModel, question, image }) => {
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
        },
        notifyFilesChanged: () => emit("room-files-changed", {}),
      });
    } finally {
      await bridge?.stopAndWait().catch(() => {});
    }
  });

  ipcMain.handle("handoff_chat", (_event: IpcMainInvokeEvent, raw: unknown) =>
    handoffChat(String(object(raw).chatId ?? ""), { room: roomSource }));
}
