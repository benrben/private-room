/** Live headless agent turns used by workflow `agent_run` nodes. */

import { randomUUID } from "node:crypto";

import { runsOnThisMac } from "./capabilities.js";
import { detectedExternal } from "./externalDetection.js";
import { createToolEffects } from "./execTool.js";
import { advisorsEnabled, modelSetting, webAccessEnabled } from "./gatherContext.js";
import type { LiveAppServices } from "./liveAppServices.js";
import { createRoomBridge, webLanesFromSettings, type RunningBridge } from "./moonshotServer.js";
import { activePolicy } from "./privacy.js";
import type { RoomManagerState } from "./roomManager.js";
import { roomServerDispatcherFactory } from "./roomServerLive.js";
import { listModels } from "./engineRouting.js";
import { bestDefault } from "./turnContext.js";
import { TurnId, type EventSender } from "./turn.js";
import { streamAnswer } from "./turnEngine.js";
import type { AgentRunFn } from "./workflowEngine.js";

/**
 * A workflow run belongs to a job, not a chat. Sidecar turn events are
 * swallowed, while tool effects such as room-file changes still use the app
 * sender through the room bridge's dispatcher.
 */
export function createWorkflowAgentRun(
  state: RoomManagerState,
  emit: EventSender,
  services: LiveAppServices,
): AgentRunFn {
  return async (question, cancel, roomPath) => {
    if (cancel === undefined || roomPath === undefined) {
      throw new Error("a workflow agent turn needs its job cancellation flag and pinned room");
    }
    const room = state.room;
    if (room === null || room.path !== roomPath) {
      throw new Error("the room this workflow belongs to is no longer open");
    }
    const models = await listModels().catch(() => [] as string[]);
    const model = modelSetting(room.conn) ?? bestDefault(models);
    const scope = runsOnThisMac(model)
      ? { kind: "LocalEngine" as const }
      : { kind: "CloudEngine" as const };
    const online = webAccessEnabled(room.conn);
    const dispatcher = roomServerDispatcherFactory(state, emit, services)(
      online,
      scope,
      webLanesFromSettings(room.conn),
    );
    let bridge: RunningBridge | null = null;
    try {
      bridge = await createRoomBridge({ scope, dispatcher });
      const turn = new TurnId(`workflow:${randomUUID()}`, "");
      const running = bridge;
      return await streamAnswer(
        {
          model,
          question,
          chatMessages: [],
          temperature: null,
          effects: createToolEffects(),
          webEnabled: online,
          advisorsOn: advisorsEnabled(room.conn),
          cancel,
          privacyBypass: false,
          turn,
          mcp: { url: `http://127.0.0.1:${running.port}/mcp`, token: running.token },
        },
        {
          send: () => undefined,
          detectedAdvisors: detectedExternal,
          privacyActive: () => activePolicy() !== null,
        },
      );
    } finally {
      await bridge?.stopAndWait().catch(() => undefined);
    }
  };
}
