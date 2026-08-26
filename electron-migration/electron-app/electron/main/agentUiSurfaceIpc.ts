/** Backend-to-renderer UI request broker used by agent screen-driving tools. */

import { randomUUID } from "node:crypto";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { AgentUiRequest } from "../shared/apiTypes.js";
import type { RoomManagerDeps } from "./roomManager.js";
import type { EventSender } from "./turn.js";

export const NO_LONGER_WAITING =
  "That request had already been given up on, so answering it now did nothing. Ask again if you still want it.";

type Resolver = (payload: unknown) => void;
export interface AgentUiRuntime { pending: Map<string, Resolver> }

export function createAgentUiRuntime(): AgentUiRuntime {
  return { pending: new Map() };
}

export async function requestAgentUi(
  runtime: AgentUiRuntime,
  emit: EventSender,
  kind: AgentUiRequest["kind"],
  args: Record<string, unknown>,
): Promise<unknown> {
  const id = randomUUID();
  const human = kind === "browse_consent";
  const payload = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      runtime.pending.delete(id);
      reject(new Error(human
        ? "The user did not answer the approval request, so nothing was typed. Tell them it is still waiting rather than trying again."
        : `The app's interface didn't answer the ${kind} request in time.`));
    }, human ? 600_000 : 20_000);
    timer.unref?.();
    runtime.pending.set(id, (answer) => {
      clearTimeout(timer);
      resolve(answer);
    });
    emit("agent-ui-request", { id, kind, args });
  });
  if (typeof payload === "object" && payload !== null && typeof (payload as Record<string, unknown>).error === "string") {
    throw new Error(String((payload as Record<string, unknown>).error));
  }
  return payload;
}

export function registerAgentUiSurfaceIpc(
  ipcMain: Pick<IpcMain, "handle">,
  deps: RoomManagerDeps,
  runtime: AgentUiRuntime = createAgentUiRuntime(),
): AgentUiRuntime {
  const previousClear = deps.clearEphemeralCaches;
  deps.clearEphemeralCaches = () => {
    previousClear?.();
    for (const resolve of runtime.pending.values()) resolve({ error: "The room was closed." });
    runtime.pending.clear();
  };
  ipcMain.handle("resolve_agent_ui", (_event: IpcMainInvokeEvent, raw: unknown): void => {
    const args = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
    const id = String(args.id ?? "");
    const resolve = runtime.pending.get(id);
    if (!resolve) throw new Error(NO_LONGER_WAITING);
    runtime.pending.delete(id);
    resolve(args.payload);
  });
  return runtime;
}
