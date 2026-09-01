import path from "node:path";
import type { EventSender } from "../turn.js";
import { TurnId } from "../turn.js";
import { resolvedBaseUrl } from "../engineRouting.js";
import { WEB_LANES_ALL } from "../toolSpecs.js";
import { createRoomBridge, type RunningBridge } from "../moonshotServer.js";
import { roomServerDispatcherFactory } from "../roomServerLive.js";
import type { RoomManagerState } from "../roomManager.js";
import type { LiveAppServices } from "../liveAppServices.js";
import {
  ensureProviderCatalog,
  providerRuntimeConfig,
  providerRuntimeConfigWire,
} from "../providers.js";
import { runViaSidecar, type RunViaSidecarRequest, type SidecarOutcome } from "../sidecar.js";
import { AsyncEventQueue } from "./eventQueue.js";
import { safeProviderFailure } from "./failureSafety.js";
import { createDeepWorkspaceBridgeGrant } from "./deepWorkspaceBridge.js";
import { createCloudPrivacyWorkspaceBackend, createMirrorWorkspaceBackend } from "./legacyCli.js";
import type {
  ApprovalDecision,
  HarnessContext,
  HarnessEvent,
  HarnessInput,
  HarnessRun,
  HarnessRuntime,
} from "./types.js";

function payloadValue(payload: unknown): unknown {
  return typeof payload === "object" && payload !== null && "v" in payload
    ? (payload as { v: unknown }).v
    : payload;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value ?? ""); }
}

function numeric(row: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function isLoopbackBaseUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLocaleLowerCase("en-US");
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

type LegacyEventContext = Pick<HarnessContext, "provider" | "runId">;
type LegacyEventNormalizer = (context: LegacyEventContext, value: unknown) => HarnessEvent | null;

function eventRow(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function legacyAgentId(row: Record<string, unknown>, value: unknown): string {
  if (typeof row.id === "string") return row.id;
  if (typeof row.agent === "string") return row.agent;
  return text(value);
}

function legacyPlanUpdated(context: LegacyEventContext, value: unknown): HarnessEvent {
  return { type: "plan_updated", runId: context.runId, text: text(value) };
}

function legacyAgentStarted(context: LegacyEventContext, value: unknown): HarnessEvent {
  const row = eventRow(value);
  return {
    type: "agent_started",
    runId: context.runId,
    agentId: legacyAgentId(row, value) || "chat.answer",
    ...(typeof row.label === "string" ? { label: row.label } : {}),
  };
}

function legacyTextDelta(context: LegacyEventContext, value: unknown): HarnessEvent {
  return { type: "text_delta", runId: context.runId, text: text(value) };
}

function legacyToolStarted(context: LegacyEventContext, value: unknown): HarnessEvent {
  const row = eventRow(value);
  const label = typeof row.label === "string" ? row.label : text(value);
  return { type: "tool_started", runId: context.runId, tool: label || "workspace" };
}

function legacyToolReport(context: LegacyEventContext, value: unknown): HarnessEvent {
  const row = eventRow(value);
  const failed = row.ok === false;
  return {
    type: "tool_completed",
    runId: context.runId,
    tool: typeof row.node === "string" ? row.node : "specialist",
    result: failed ? undefined : typeof row.text === "string" ? row.text : value,
    ...(failed ? { error: safeProviderFailure(context.provider, "tool") } : {}),
  };
}

function legacyToolStatus(context: LegacyEventContext, value: unknown): HarnessEvent | null {
  const row = eventRow(value);
  // Only ordinary room tools carry their exact name. Specialist asks
  // intentionally do not: ask-report above is their one completion.
  const tool = typeof row.tool === "string" ? row.tool.trim() : "";
  if (tool === "") return null;
  return {
    type: "tool_completed",
    runId: context.runId,
    tool,
    ...(row.ok !== true ? { error: safeProviderFailure(context.provider, "tool") } : {}),
  };
}

function legacyUsageUpdated(context: LegacyEventContext, value: unknown): HarnessEvent {
  const row = eventRow(value);
  return {
    type: "usage_updated",
    runId: context.runId,
    inputTokens: numeric(row, "inputTokens", "input_tokens", "prompt_eval_count"),
    outputTokens: numeric(row, "outputTokens", "output_tokens", "eval_count"),
    costUsd: numeric(row, "costUsd", "cost_usd"),
  };
}

const legacyEventNormalizers: Readonly<Record<string, LegacyEventNormalizer>> = {
  "ask-plan": legacyPlanUpdated,
  "ask-agent": legacyAgentStarted,
  "ask-delta": legacyTextDelta,
  "ask-step": legacyToolStarted,
  "ask-report": legacyToolReport,
  "ask-step-status": legacyToolStatus,
  "ask-token-usage": legacyUsageUpdated,
};

function normalizeLegacyEvent(
  event: string,
  raw: unknown,
  context: LegacyEventContext,
): HarnessEvent | null {
  const normalize = legacyEventNormalizers[event];
  return normalize === undefined ? null : normalize(context, payloadValue(raw));
}

function createLegacyEventSender(
  output: AsyncEventQueue<HarnessEvent>,
  context: LegacyEventContext,
): EventSender {
  return (event, raw) => {
    const normalized = normalizeLegacyEvent(event, raw, context);
    if (normalized !== null) output.push(normalized);
  };
}

type DeepWorkspaceGrant = ReturnType<typeof createDeepWorkspaceBridgeGrant>;

function workspaceFolderRoot(state: RoomManagerState): string | null {
  const descriptor = state.room?.descriptor;
  return descriptor?.kind === "workspace-folder" ? descriptor.rootPath : null;
}

function usesRoomWorkspace(context: HarnessContext, realRoot: string | null): boolean {
  return realRoot !== null && path.resolve(context.workspacePath) === path.resolve(realRoot);
}

function deepWorkspace(
  context: HarnessContext,
  grant: DeepWorkspaceGrant,
  realRoot: string | null,
  mirrorBackend: typeof createMirrorWorkspaceBackend,
  cloudPrivacyBackend: typeof createCloudPrivacyWorkspaceBackend,
) {
  if (usesRoomWorkspace(context, realRoot)) return grant.workspace;
  const mirror = mirrorBackend(context.workspacePath, context.writeEnabled);
  if (context.privacyMode === "cloud-redacted") {
    return cloudPrivacyBackend(mirror, grant.workspace, { routeExactMoveRenameToReal: true });
  }
  return mirror;
}

function deepScope(provider: string) {
  return provider === "ollama-local" ? { kind: "LocalEngine" as const } : { kind: "CloudEngine" as const };
}

async function openDeepBridge(
  state: RoomManagerState,
  emit: EventSender,
  services: LiveAppServices | undefined,
  scope: ReturnType<typeof deepScope>,
  workspace: ReturnType<typeof deepWorkspace>,
  privacyMode: HarnessContext["privacyMode"],
): Promise<RunningBridge> {
  const dispatcher = roomServerDispatcherFactory(state, emit, services)(
    false,
    scope,
    WEB_LANES_ALL,
    { workspace, privacyBypass: privacyMode === "cloud-direct" },
  );
  return createRoomBridge({ scope, dispatcher });
}

function openRouterRuntimeConfig(model: string): Record<string, unknown> {
  const config = providerRuntimeConfig(model);
  if (config === null) throw new Error("Choose an OpenRouter model for the OpenRouter harness.");
  return providerRuntimeConfigWire(config);
}

async function sidecarProvider(context: HarnessContext): Promise<Record<string, unknown> | null> {
  if (context.provider !== "openrouter") return null;
  await ensureProviderCatalog(context.model);
  return openRouterRuntimeConfig(context.model);
}

function validatedOllamaBaseUrl(context: HarnessContext): string {
  const ollamaBaseUrl = resolvedBaseUrl();
  if (context.provider !== "ollama-local") return ollamaBaseUrl;
  if (isLoopbackBaseUrl(ollamaBaseUrl)) return ollamaBaseUrl;
  throw new Error("Local Ollama must use a loopback server on this Mac.");
}

function systemMessages(context: HarnessContext): RunViaSidecarRequest["messages"] {
  return context.systemPrompt ? [{ role: "system", content: context.systemPrompt }] : [];
}

function deepSidecarRequest(
  context: HarnessContext,
  input: HarnessInput,
  bridge: RunningBridge,
  grant: DeepWorkspaceGrant,
  provider: Record<string, unknown> | null,
  ollamaBaseUrl: string,
): RunViaSidecarRequest {
  return {
    model: context.model,
    question: input.text,
    harness: "deep",
    temperature: 0,
    messages: systemMessages(context),
    ollamaBaseUrl,
    mcp: {
      url: `http://127.0.0.1:${bridge.port}/mcp`,
      token: bridge.token,
      ...grant.wireAuthority,
    },
    routing: { write: context.writeEnabled },
    webEnabled: false,
    runId: context.runId,
    provider,
  };
}

function pushSidecarOutcome(
  output: AsyncEventQueue<HarnessEvent>,
  context: HarnessContext,
  outcome: SidecarOutcome,
  aborted: boolean,
): void {
  if (outcome.kind === "failed") {
    output.push({ type: "run_failed", runId: context.runId, error: safeProviderFailure(context.provider) });
    return;
  }
  output.push({
    type: "run_completed",
    runId: context.runId,
    status: aborted ? "cancelled" : "completed",
  });
}

function pushStartupFailure(output: AsyncEventQueue<HarnessEvent>, context: HarnessContext): void {
  output.push({
    type: "run_failed",
    runId: context.runId,
    error: safeProviderFailure(context.provider, "startup"),
  });
}

async function stopBridge(bridge: RunningBridge | null): Promise<void> {
  await bridge?.stopAndWait().catch(() => undefined);
}

/** Built-in provider-neutral Deep Agents runtime over Arcelle's MCP bridge. */
export class DeepAgentRuntime implements HarnessRuntime {
  readonly name = "arcelle-deep" as const;

  constructor(
    private readonly state: RoomManagerState,
    private readonly emit: EventSender,
    private readonly services?: LiveAppServices,
    private readonly runSidecar: typeof runViaSidecar = runViaSidecar,
    private readonly mirrorBackend: typeof createMirrorWorkspaceBackend = createMirrorWorkspaceBackend,
    private readonly cloudPrivacyBackend: typeof createCloudPrivacyWorkspaceBackend = createCloudPrivacyWorkspaceBackend,
  ) {}

  available(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async startTurn(context: HarnessContext, input: HarnessInput): Promise<HarnessRun> {
    const output = new AsyncEventQueue<HarnessEvent>();
    const abort = new AbortController();
    let bridge: RunningBridge | null = null;
    let finished: Promise<void> = Promise.resolve();
    const sendOldEvent = createLegacyEventSender(output, context);

    const run = async (): Promise<void> => {
      output.push({ type: "run_started", runId: context.runId, harness: this.name });
      try {
        const grant = createDeepWorkspaceBridgeGrant(this.state, context.runId, context.writeEnabled);
        // Deep Agents access files through MCP rather than a raw cwd. When
        // Cloud Privacy supplies a redacted mirror, the MCP backend must point
        // at that mirror too; otherwise a cloud tool can bypass placeholder
        // validation and mutate the real workspace directly.
        const workspace = deepWorkspace(
          context,
          grant,
          workspaceFolderRoot(this.state),
          this.mirrorBackend,
          this.cloudPrivacyBackend,
        );
        const scope = deepScope(context.provider);
        bridge = await openDeepBridge(this.state, this.emit, this.services, scope, workspace, context.privacyMode);
        const provider = await sidecarProvider(context);
        const owner = new TurnId(context.runId, input.threadId ?? "");
        const ollamaBaseUrl = validatedOllamaBaseUrl(context);
        const outcome: SidecarOutcome = await this.runSidecar(
          deepSidecarRequest(context, input, bridge, grant, provider, ollamaBaseUrl),
          { turn: owner, onEvent: sendOldEvent, signal: abort.signal },
        );
        pushSidecarOutcome(output, context, outcome, abort.signal.aborted);
      } catch {
        pushStartupFailure(output, context);
      } finally {
        await stopBridge(bridge);
        bridge = null;
        output.end();
      }
    };
    finished = run();

    return {
      events: output,
      cancel: async () => {
        abort.abort();
        await finished;
      },
      approve: async (_requestId: string, _decision: ApprovalDecision) => {
        throw new Error("The Deep Harness has no pending provider approval.");
      },
    };
  }
}
