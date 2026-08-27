/** IPC wiring for the host metadata, provider, capability and privacy lanes. */

import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { RoomManagerDeps, RoomManagerState } from "./roomManager.js";
import { toRoomSource } from "./roomManager.js";
import { appDiag, feedbackDraft } from "./feedbackTools.js";
import {
  connectAiProvider,
  disconnectAiProvider,
  ensureProviderCatalog,
  listAiProviders,
  providerConnected,
  providerModelFacts,
} from "./providers.js";
import { cancelAsk, listSpecialists } from "./specialists.js";
import { listChatCommands } from "./chatCommands.js";
import { listModels, resolvedBaseUrl } from "./engineRouting.js";
import { bestDefault } from "./turnContext.js";
import { bestLocalDefault } from "./ollamaModels.js";
import { declaredFor, engineCapabilities, enginePreflight, engineSupportMatrix } from "./capabilities.js";
import { roomToolNamesWith, WEB_LANES_ALL } from "./bridgeDispatcher.js";
import { webAccessEnabled } from "./browser/webAccess.js";
import { modelSetting } from "./gatherContext.js";
import { CancelFlag } from "./cancel.js";
import { sidecarJsonCancellable } from "./sidecarJsonCancellable.js";
import {
  activePolicy,
  addPrivacyBlock,
  privacyPreview,
  privacyStatus,
  removePrivacyEntity,
  setPrivacyConcepts,
  setPrivacyGlobal,
  setPrivacyRoom,
  startPrivacyScan,
  type PrivacyScanDeps,
} from "./privacy.js";
import type { EventSender } from "./turn.js";
import { detectedExternal } from "./externalDetection.js";

export interface CoreSurfaceHost {
  appVersion(): string;
  osVersion(): string;
}

function args(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

async function sidecarValue(path: string, body: Record<string, unknown>): Promise<unknown> {
  const outcome = await sidecarJsonCancellable(path, body, new CancelFlag());
  if (outcome.kind === "value") return outcome.value;
  if (outcome.kind === "stopped") throw new Error("Stopped.");
  const error = new Error(outcome.error.error) as Error & { code?: string };
  error.code = outcome.error.code;
  throw error;
}

export function registerCoreSurfaceIpc(
  ipcMain: Pick<IpcMain, "handle">,
  state: RoomManagerState,
  userDataDir: string,
  emit: EventSender,
  host: CoreSurfaceHost,
  roomDeps: RoomManagerDeps,
): void {
  const rooms = toRoomSource(state);
  const requireRoom = () => {
    const room = state.room;
    if (room === null) throw new Error("No room is open.");
    return room;
  };
  const scan: PrivacyScanDeps = {
    room: rooms,
    userDataDir,
    roomEpoch: () => state.roomEpoch,
    emit: { emit: (payload) => emit("privacy-scan", payload) },
    privacyScanCall: (body) => sidecarValue("/privacy_scan", body) as Promise<{ entities?: Array<{ text?: string; category?: string }>; complete?: boolean }>,
    resolveGuardModel: async (preferred) => {
      const installed = await listModels();
      return installed.includes(preferred) ? preferred : bestLocalDefault(installed);
    },
    isChatBusy: () => state.cancel.cancels.size > 0,
  };
  // Room-open schedules its automatic scan through RoomManagerDeps. Keep the
  // manual privacy commands and the lifecycle hook on this exact same object
  // so they cannot drift to different room/epoch state.
  roomDeps.privacyScan = scan;

  ipcMain.handle("app_diag", () => appDiag(host));
  ipcMain.handle("feedback_draft", (_event: IpcMainInvokeEvent, raw: unknown) =>
    feedbackDraft({ rooms }, String(args(raw).text ?? "")),
  );
  ipcMain.handle("list_ai_providers", () => listAiProviders());
  ipcMain.handle("connect_ai_provider", (_event: IpcMainInvokeEvent, raw: unknown) => {
    const a = args(raw);
    return connectAiProvider(String(a.provider ?? ""), String(a.apiKey ?? ""));
  });
  ipcMain.handle("disconnect_ai_provider", (_event: IpcMainInvokeEvent, raw: unknown) =>
    disconnectAiProvider(String(args(raw).provider ?? "")),
  );
  ipcMain.handle("cancel_ask", (_event: IpcMainInvokeEvent, raw: unknown) =>
    cancelAsk(state.cancel, String(args(raw).askId ?? "")),
  );
  ipcMain.handle("list_chat_commands", () => listChatCommands());
  ipcMain.handle("list_specialists", () => {
    const room = requireRoom();
    return listSpecialists(
      {
        webEnabled: () => webAccessEnabled(room.conn),
        explicitModel: () => modelSetting(room.conn) ?? undefined,
      },
      {
        listModels,
        bestDefault,
        servedToolNames: (model, web) => roomToolNamesWith(web, WEB_LANES_ALL, declaredFor(model).tier, []),
        fetchAgents: (body) => sidecarValue("/agents", body),
      },
    );
  });

  const capabilityDeps = {
    listModels,
    ollamaCapabilities: async (model: string): Promise<string[]> => {
      const value = await sidecarValue("/capabilities", { model, base_url: resolvedBaseUrl() });
      const listed = (value as { capabilities?: unknown } | null)?.capabilities;
      return Array.isArray(listed) ? listed.filter((v): v is string => typeof v === "string") : [];
    },
    ollamaNativeContextLength: async (model: string): Promise<number | null> => {
      const value = await sidecarValue("/context_length", { model, base_url: resolvedBaseUrl() });
      const length = (value as { context_length?: unknown } | null)?.context_length;
      return typeof length === "number" && Number.isFinite(length) ? length : null;
    },
    ensureProviderCatalog,
    providerModelFacts,
    codexContextWindow: async (): Promise<undefined> => undefined,
    privacyDoorActive: () => activePolicy() !== null,
  };
  ipcMain.handle("engine_capabilities", () =>
    engineCapabilities(modelSetting(requireRoom().conn), capabilityDeps),
  );
  ipcMain.handle("engine_preflight", (_event: IpcMainInvokeEvent, raw: unknown) =>
    enginePreflight(
      modelSetting(requireRoom().conn),
      String(args(raw).capability ?? "chat") as Parameters<typeof enginePreflight>[1],
      capabilityDeps,
    ),
  );
  ipcMain.handle("engine_support_matrix", () =>
    engineSupportMatrix({
      listModels,
      detectedAdvisors: detectedExternal,
      providerConnected,
      fetchAgentSupport: (body) => sidecarValue("/agent_support", body),
    }),
  );

  ipcMain.handle("privacy_status", () => privacyStatus({ room: rooms, userDataDir }));
  ipcMain.handle("privacy_preview", (_event: IpcMainInvokeEvent, raw: unknown) =>
    privacyPreview({ room: rooms }, String(args(raw).fileId ?? "")),
  );
  ipcMain.handle("set_privacy_room", (_event: IpcMainInvokeEvent, raw: unknown) =>
    setPrivacyRoom({ room: rooms, userDataDir }, String(args(raw).mode ?? ""), scan),
  );
  ipcMain.handle("set_privacy_global", (_event: IpcMainInvokeEvent, raw: unknown) =>
    setPrivacyGlobal({ room: rooms, userDataDir }, args(raw).on === true, scan),
  );
  ipcMain.handle("add_privacy_block", (_event: IpcMainInvokeEvent, raw: unknown) => {
    const a = args(raw);
    return addPrivacyBlock({ room: rooms, userDataDir }, String(a.text ?? ""), String(a.category ?? ""));
  });
  ipcMain.handle("remove_privacy_entity", (_event: IpcMainInvokeEvent, raw: unknown) =>
    removePrivacyEntity({ room: rooms, userDataDir }, String(args(raw).id ?? "")),
  );
  ipcMain.handle("set_privacy_concepts", (_event: IpcMainInvokeEvent, raw: unknown) => {
    const concepts = args(raw).concepts;
    return setPrivacyConcepts(
      { room: rooms, userDataDir },
      Array.isArray(concepts) ? concepts.filter((v): v is string => typeof v === "string") : [],
      scan,
    );
  });
  ipcMain.handle("start_privacy_scan", () => startPrivacyScan(scan));
}
