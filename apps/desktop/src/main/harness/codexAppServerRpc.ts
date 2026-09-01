import { AsyncEventQueue } from "./eventQueue.js";
import { safeProviderFailure } from "./failureSafety.js";
import { NATIVE_ROOM_MCP_SERVER } from "./nativeRoomMcp.js";
import type { ApprovalDecision, HarnessEvent } from "./types.js";

export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string; code?: number };
}

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

export function nestedString(value: unknown, ...keys: string[]): string | null {
  let current: unknown = value;
  for (const key of keys) current = record(current)[key];
  return typeof current === "string" ? current : null;
}

export function permissionApprovalResult(
  requested: Record<string, unknown>,
  decision: ApprovalDecision,
): { permissions: Record<string, unknown>; scope: "turn" | "session"; strictAutoReview: boolean } {
  const allowed = decision === "allow-once" || decision === "allow-run";
  return {
    permissions: allowed ? requested : {},
    scope: decision === "allow-run" ? "session" : "turn",
    strictAutoReview: false,
  };
}

export function approvalResult(decision: ApprovalDecision): { decision: string } {
  if (decision === "allow-once") return { decision: "accept" };
  if (decision === "allow-run") return { decision: "acceptForSession" };
  if (decision === "cancel") return { decision: "cancel" };
  return { decision: "decline" };
}

export function mcpApprovalResult(
  decision: ApprovalDecision,
  sessionPersistAllowed: boolean,
): { action: "accept" | "decline" | "cancel"; content: null; _meta?: { persist: "session" } } {
  if (decision === "cancel") return { action: "cancel", content: null };
  if (decision === "deny") return { action: "decline", content: null };
  if (decision === "allow-run" && sessionPersistAllowed) {
    return { action: "accept", content: null, _meta: { persist: "session" } };
  }
  return { action: "accept", content: null };
}

function advertisesSessionPersistence(meta: Record<string, unknown>): boolean {
  const persist = meta.persist;
  return persist === "session" || (Array.isArray(persist) && persist.includes("session"));
}

function itemType(item: Record<string, unknown>): string {
  return String(item.type ?? "tool").replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function itemToolLabel(item: Record<string, unknown>, type: string): string {
  if (type !== "mcpToolCall") return type;
  const server = typeof item.server === "string" ? item.server : "mcp";
  const tool = typeof item.tool === "string" ? item.tool : "tool";
  return `${server}.${tool}`;
}

const TOOL_ERROR_MESSAGES: Array<[RegExp, string]> = [
  [/read[- ]?only/i, "The provider treated this tool as read-only."],
  [/not found|no file|missing/i, "The requested workspace file was not found."],
  [/argument|schema|invalid input/i, "The provider rejected the tool arguments."],
  [/permission|approval|denied|declin/i, "The provider denied the tool permission request."],
];

export function safeToolError(item: Record<string, unknown>): string | undefined {
  if (item.status !== "failed" && item.error == null) return undefined;
  const message = nestedString(item, "error", "message") ?? "";
  return toolFailureMessage(message);
}

function toolFailureMessage(message: string): string {
  const known = TOOL_ERROR_MESSAGES.find(([pattern]) => pattern.test(message));
  if (known) return known[1];
  const httpStatus = message.match(/\b(?:HTTP\D*)?(400|401|403|404|409|413|429|500|502|503)\b/i)?.[1];
  if (httpStatus !== undefined) return `The Room MCP call failed with HTTP ${httpStatus}.`;
  return networkToolFailure(message);
}

function networkToolFailure(message: string): string {
  if (/transport/i.test(message)) return "The provider reported a Room MCP transport failure.";
  if (/connect|mcp|server|http/i.test(message)) return "The provider could not complete the Room MCP call.";
  return safeProviderFailure("codex", "tool");
}

function collabAgentIds(item: Record<string, unknown>): string[] {
  const direct = item.receiverThreadIds ?? item.receiver_thread_ids;
  if (Array.isArray(direct)) return direct.filter((value): value is string => typeof value === "string");
  const single = item.newThreadId ?? item.new_thread_id;
  return typeof single === "string" ? [single] : [];
}

function collabStatuses(item: Record<string, unknown>): Array<[string, string]> {
  const raw = record(item.agentsStates ?? item.agents_states);
  return Object.entries(raw).map(([id, state]) => [id, String(record(state).status ?? "")]);
}

export type PendingRpc = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

export type ApprovalRequest = {
  rpcId: number | string;
  kind: "standard" | "permissions" | "mcp";
  permissions?: Record<string, unknown>;
  sessionPersistAllowed?: boolean;
};

export interface AppServerLineHandlerContext {
  runId: string;
  events: AsyncEventQueue<HarnessEvent>;
  pendingRpc: Map<number | string, PendingRpc>;
  approvalRequests: Map<string, ApprovalRequest>;
  respond(id: number | string, result: unknown): void;
  markTerminal(): void;
  endInput(): void;
}

type AppServerNotificationHandler = (message: RpcMessage, context: AppServerLineHandlerContext) => void;

const STANDARD_APPROVAL_TOOLS: ReadonlyMap<string, "shell" | "file_change"> = new Map([
  ["item/commandExecution/requestApproval", "shell"],
  ["item/fileChange/requestApproval", "file_change"],
]);

function parseRpcMessage(line: string): RpcMessage | null {
  try {
    return JSON.parse(line) as RpcMessage;
  } catch {
    return null;
  }
}

function settlePendingRpc(message: RpcMessage, pendingRpc: AppServerLineHandlerContext["pendingRpc"]): boolean {
  if (message.id === undefined || message.method !== undefined) return false;
  const pending = pendingRpc.get(message.id);
  if (pending === undefined) return true;
  pendingRpc.delete(message.id);
  if (message.error !== undefined) pending.reject(new Error(safeProviderFailure("codex", "run")));
  else pending.resolve(message.result);
  return true;
}

function stageStandardApproval(message: RpcMessage, context: AppServerLineHandlerContext): boolean {
  const tool = STANDARD_APPROVAL_TOOLS.get(message.method!);
  if (tool === undefined) return false;
  const requestId = String(message.id);
  context.approvalRequests.set(requestId, { rpcId: message.id!, kind: "standard" });
  context.events.push({
    type: "approval_requested",
    runId: context.runId,
    requestId,
    tool,
    detail: nestedString(message.params, "reason") ?? nestedString(message.params, "command") ?? "Codex requests approval.",
  });
  return true;
}

function stagePermissionsApproval(message: RpcMessage, context: AppServerLineHandlerContext): boolean {
  if (message.method !== "item/permissions/requestApproval") return false;
  const requestId = String(message.id);
  const permissions = record(message.params?.permissions);
  context.approvalRequests.set(requestId, { rpcId: message.id!, kind: "permissions", permissions });
  context.events.push({
    type: "approval_requested",
    runId: context.runId,
    requestId,
    tool: "permissions",
    detail: nestedString(message.params, "reason") ?? "Codex requests permission for this protected operation.",
  });
  return true;
}

function isRoomMcpToolApproval(message: RpcMessage): boolean {
  if (message.method !== "mcpServer/elicitation/request") return false;
  const params = message.params ?? {};
  const meta = record(params._meta);
  return params.serverName === NATIVE_ROOM_MCP_SERVER
    && params.mode === "form"
    && meta.codex_approval_kind === "mcp_tool_call";
}

function stageMcpApproval(message: RpcMessage, context: AppServerLineHandlerContext): boolean {
  if (!isRoomMcpToolApproval(message)) return false;
  const requestId = String(message.id);
  const params = message.params ?? {};
  context.approvalRequests.set(requestId, {
    rpcId: message.id!,
    kind: "mcp",
    sessionPersistAllowed: advertisesSessionPersistence(record(params._meta)),
  });
  context.events.push({
    type: "approval_requested",
    runId: context.runId,
    requestId,
    tool: "room_mcp",
    detail: typeof params.message === "string" ? params.message : "Codex requests approval for an Arcelle Room tool.",
  });
  return true;
}

function handleRpcRequest(message: RpcMessage, context: AppServerLineHandlerContext): void {
  if (stageStandardApproval(message, context)) return;
  if (stagePermissionsApproval(message, context)) return;
  if (stageMcpApproval(message, context)) return;
  context.respond(message.id!, { action: "decline", content: null });
}

function isCollaborationItem(type: string): boolean {
  return type === "collabToolCall" || type === "collabAgentToolCall";
}

function isTrackedToolStart(type: string): boolean {
  return type === "commandExecution"
    || type === "fileChange"
    || type === "mcpToolCall"
    || type === "collabToolCall"
    || type === "collabAgentToolCall";
}

function emitCollaboratorStarts(item: Record<string, unknown>, tool: string, context: AppServerLineHandlerContext): void {
  for (const agentId of collabAgentIds(item)) {
    context.events.push({ type: "agent_started", runId: context.runId, agentId, label: tool });
  }
}

function handleItemStarted(message: RpcMessage, context: AppServerLineHandlerContext): void {
  const item = record(message.params?.item);
  const type = itemType(item);
  if (isCollaborationItem(type)) emitCollaboratorStarts(item, String(item.tool ?? "collaboration"), context);
  if (isTrackedToolStart(type)) {
    context.events.push({
      type: "tool_started",
      runId: context.runId,
      tool: itemToolLabel(item, type),
      toolId: typeof item.id === "string" ? item.id : undefined,
    });
  }
}

function collaborationCompletionIds(item: Record<string, unknown>, statuses: Array<[string, string]>): string[] {
  return statuses.length > 0 ? statuses.map(([id]) => id) : collabAgentIds(item);
}

function isCompletedCollaborator(status: string | undefined, item: Record<string, unknown>): boolean {
  return status === "completed"
    || status === "errored"
    || status === "interrupted"
    || status === "shutdown"
    || item.status === "failed";
}

function emitCollaboratorCompletions(item: Record<string, unknown>, context: AppServerLineHandlerContext): void {
  const statuses = collabStatuses(item);
  for (const agentId of collaborationCompletionIds(item, statuses)) {
    const status = statuses.find(([id]) => id === agentId)?.[1];
    if (isCompletedCollaborator(status, item)) {
      context.events.push({ type: "agent_completed", runId: context.runId, agentId });
    }
  }
}

function handleItemCompleted(message: RpcMessage, context: AppServerLineHandlerContext): void {
  const item = record(message.params?.item);
  const type = itemType(item);
  context.events.push({
    type: "tool_completed",
    runId: context.runId,
    tool: itemToolLabel(item, type),
    toolId: typeof item.id === "string" ? item.id : undefined,
    error: safeToolError(item),
  });
  if (isCollaborationItem(type)) emitCollaboratorCompletions(item, context);
}

function handleAgentMessageDelta(message: RpcMessage, context: AppServerLineHandlerContext): void {
  const delta = nestedString(message.params ?? {}, "delta");
  if (delta !== null) context.events.push({ type: "text_delta", runId: context.runId, text: delta });
}

function handleDiffUpdated(message: RpcMessage, context: AppServerLineHandlerContext): void {
  const diff = nestedString(message.params ?? {}, "diff");
  if (diff !== null) context.events.push({ type: "plan_updated", runId: context.runId, text: diff });
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function handleTokenUsageUpdated(message: RpcMessage, context: AppServerLineHandlerContext): void {
  const params = message.params ?? {};
  const usage = record(params.tokenUsage ?? params.usage);
  context.events.push({
    type: "usage_updated",
    runId: context.runId,
    inputTokens: tokenCount(usage.inputTokens),
    outputTokens: tokenCount(usage.outputTokens),
  });
}

function turnCompletionEvents(runId: string, status: string): HarnessEvent[] {
  if (status === "completed") {
    return [
      { type: "agent_completed", runId, agentId: "coordinator" },
      { type: "run_completed", runId, status: "completed" },
    ];
  }
  if (status === "interrupted") return [{ type: "run_completed", runId, status: "cancelled" }];
  return [{ type: "run_failed", runId, error: safeProviderFailure("codex") }];
}

function handleTurnCompleted(message: RpcMessage, context: AppServerLineHandlerContext): void {
  context.markTerminal();
  const status = String(record(message.params?.turn).status ?? "failed");
  for (const event of turnCompletionEvents(context.runId, status)) context.events.push(event);
  context.endInput();
}

function handleServerError(_message: RpcMessage, context: AppServerLineHandlerContext): void {
  context.events.push({ type: "run_failed", runId: context.runId, error: safeProviderFailure("codex") });
}

const NOTIFICATION_HANDLERS: ReadonlyMap<string, AppServerNotificationHandler> = new Map([
  ["item/agentMessage/delta", handleAgentMessageDelta],
  ["item/started", handleItemStarted],
  ["item/completed", handleItemCompleted],
  ["turn/diff/updated", handleDiffUpdated],
  ["thread/tokenUsage/updated", handleTokenUsageUpdated],
  ["turn/completed", handleTurnCompleted],
  ["error", handleServerError],
]);

function handleServerNotification(message: RpcMessage, context: AppServerLineHandlerContext): void {
  if (message.method === undefined) return;
  const handler = NOTIFICATION_HANDLERS.get(message.method);
  if (handler !== undefined) handler(message, context);
}

export function createAppServerLineHandler(context: AppServerLineHandlerContext): (line: string) => void {
  return (line) => {
    const message = parseRpcMessage(line);
    if (message === null) return;
    if (settlePendingRpc(message, context.pendingRpc)) return;
    if (message.id !== undefined && message.method !== undefined) {
      handleRpcRequest(message, context);
      return;
    }
    handleServerNotification(message, context);
  };
}
