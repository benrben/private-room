/** Main chat-turn and context-handoff IPC over a per-turn room MCP bridge. */

import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";
import { ask, handoffChat, type AskRequest } from "./turnEngine.js";
import { liveTurnRoomSource } from "./liveContext.js";
import { createRoomBridge, type RunningBridge } from "./moonshotServer.js";
import { roomServerDispatcherFactory } from "./roomServerLive.js";
import { modelSetting } from "./gatherContext.js";
import { runsOnThisMac } from "./capabilities.js";
import { detectedExternal } from "./externalDetection.js";
import { chatModelSeesImages, groundingPick } from "./ollamaModels.js";
import { activePolicy } from "./privacy.js";
import { embedQuestion } from "./retrievalBackfill.js";
import { listModels } from "./engineRouting.js";
import { groundPreparedImage, prepareImage } from "./visionTools.js";
import { webAccessEnabled } from "./browser/webAccess.js";
import { WEB_LANES_ALL } from "./toolSpecs.js";
import type { McpRuntime } from "./mcpSurfaceIpc.js";
import type { LiveAppServices } from "./liveAppServices.js";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
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
    const model = modelSetting(open.conn) ?? "";
    const scope = runsOnThisMac(model)
      ? { kind: "LocalEngine" as const }
      : { kind: "CloudEngine" as const };
    const online = webAccessEnabled(open.conn);
    const dispatcher = roomServerDispatcherFactory(state, emit, services)(online, scope, WEB_LANES_ALL);
    let bridge: RunningBridge | null = null;
    try {
      bridge = await createRoomBridge({ scope, dispatcher });
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
        chatModelSeesImages,
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
