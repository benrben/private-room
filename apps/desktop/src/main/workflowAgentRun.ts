/** Live headless agent turns used by workflow `agent_run` nodes. */

import { randomUUID } from "node:crypto";

import { runsOnThisMac } from "./capabilities.js";
import { detectedExternal } from "./externalDetection.js";
import { createToolEffects } from "./execTool.js";
import { advisorsEnabled, modelSetting, webAccessEnabled } from "./gatherContext.js";
import type { LiveAppServices } from "./liveAppServices.js";
import { createRoomBridge, webLanesFromSettings, type RunningBridge } from "./moonshotServer.js";
import { activePolicy } from "./privacy.js";
import type { CancelFlag } from "./cancel.js";
import type { RoomManagerState } from "./roomManager.js";
import { roomServerDispatcherFactory } from "./roomServerLive.js";
import { listModels } from "./engineRouting.js";
import { bestDefault } from "./turnContext.js";
import { TurnId, type EventSender } from "./turn.js";
import { streamAnswer } from "./turnEngine.js";
import type { AgentRunFn } from "./workflowEngine.js";

type WorkflowRoom = NonNullable<RoomManagerState["room"]>;

function requireWorkflowTurn(
  cancel: CancelFlag | undefined,
  roomPath: string | undefined,
): { cancel: CancelFlag; roomPath: string } {
  if (cancel === undefined || roomPath === undefined) {
    throw new Error("a workflow agent turn needs its job cancellation flag and pinned room");
  }
  return { cancel, roomPath };
}

function workflowRoom(state: RoomManagerState, roomPath: string): WorkflowRoom {
  const room = state.room;
  if (room === null || room.path !== roomPath) {
    throw new Error("the room this workflow belongs to is no longer open");
  }
  return room;
}

async function workflowModel(room: WorkflowRoom): Promise<string> {
  const models = await listModels().catch(() => [] as string[]);
  return modelSetting(room.conn) ?? bestDefault(models);
}

function workflowScope(model: string) {
  return runsOnThisMac(model)
    ? { kind: "LocalEngine" as const }
    : { kind: "CloudEngine" as const };
}

function workflowDispatcher(
  state: RoomManagerState,
  emit: EventSender,
  services: LiveAppServices,
  room: WorkflowRoom,
  online: boolean,
  scope: ReturnType<typeof workflowScope>,
) {
  return roomServerDispatcherFactory(state, emit, services)(
    online,
    scope,
    webLanesFromSettings(room.conn),
  );
}

async function runWorkflowAgentTurn(
  state: RoomManagerState,
  emit: EventSender,
  services: LiveAppServices,
  room: WorkflowRoom,
  question: string,
  cancel: CancelFlag,
): Promise<string> {
  const model = await workflowModel(room);
  const scope = workflowScope(model);
  const online = webAccessEnabled(room.conn);
  const dispatcher = workflowDispatcher(state, emit, services, room, online, scope);
  let bridge: RunningBridge | null = null;
  try {
    bridge = await createRoomBridge({ scope, dispatcher });
    const turn = new TurnId(`workflow:${randomUUID()}`, "");
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
        mcp: { url: `http://127.0.0.1:${bridge.port}/mcp`, token: bridge.token },
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
}

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
    const turn = requireWorkflowTurn(cancel, roomPath);
    return runWorkflowAgentTurn(
      state,
      emit,
      services,
      workflowRoom(state, turn.roomPath),
      question,
      turn.cancel,
    );
  };
}
