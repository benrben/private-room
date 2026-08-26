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
import { runViaSidecar, type SidecarOutcome } from "../sidecar.js";
import { AsyncEventQueue } from "./eventQueue.js";
import { safeProviderFailure } from "./failureSafety.js";
import { createDeepWorkspaceBridgeGrant } from "./deepWorkspaceBridge.js";
import { createMirrorWorkspaceBackend } from "./legacyCli.js";
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

/** Built-in provider-neutral Deep Agents runtime over Arcelle's MCP bridge. */
export class DeepAgentRuntime implements HarnessRuntime {
  readonly name = "arcelle-deep" as const;

  constructor(
    private readonly state: RoomManagerState,
    private readonly emit: EventSender,
    private readonly services?: LiveAppServices,
    private readonly runSidecar: typeof runViaSidecar = runViaSidecar,
    private readonly mirrorBackend: typeof createMirrorWorkspaceBackend = createMirrorWorkspaceBackend,
  ) {}

  available(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async startTurn(context: HarnessContext, input: HarnessInput): Promise<HarnessRun> {
    const output = new AsyncEventQueue<HarnessEvent>();
    const abort = new AbortController();
    let bridge: RunningBridge | null = null;
    let finished: Promise<void> = Promise.resolve();

    const sendOldEvent: EventSender = (event, raw) => {
      const value = payloadValue(raw);
      switch (event) {
        case "ask-plan":
          output.push({ type: "plan_updated", runId: context.runId, text: text(value) });
          break;
        case "ask-agent": {
          const row = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
          const agentId = typeof row.id === "string" ? row.id : typeof row.agent === "string" ? row.agent : text(value);
          output.push({
            type: "agent_started",
            runId: context.runId,
            agentId: agentId || "chat.answer",
            ...(typeof row.label === "string" ? { label: row.label } : {}),
          });
          break;
        }
        case "ask-delta":
          output.push({ type: "text_delta", runId: context.runId, text: text(value) });
          break;
        case "ask-step": {
          const row = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
          const label = typeof row.label === "string" ? row.label : text(value);
          output.push({ type: "tool_started", runId: context.runId, tool: label || "workspace" });
          break;
        }
        case "ask-report": {
          const row = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
          const failed = row.ok === false;
          output.push({
            type: "tool_completed",
            runId: context.runId,
            tool: typeof row.node === "string" ? row.node : "specialist",
            result: failed ? undefined : typeof row.text === "string" ? row.text : value,
            ...(failed ? { error: safeProviderFailure(context.provider, "tool") } : {}),
          });
          break;
        }
        case "ask-token-usage": {
          const row = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
          output.push({
            type: "usage_updated",
            runId: context.runId,
            inputTokens: numeric(row, "inputTokens", "input_tokens", "prompt_eval_count"),
            outputTokens: numeric(row, "outputTokens", "output_tokens", "eval_count"),
            costUsd: numeric(row, "costUsd", "cost_usd"),
          });
          break;
        }
        default:
          // Round/lane/privacy/status remain represented by normalized plan,
          // tool and terminal events; no provider-specific wire reaches UI.
          break;
      }
    };

    const run = async (): Promise<void> => {
      output.push({ type: "run_started", runId: context.runId, harness: this.name });
      try {
        const grant = createDeepWorkspaceBridgeGrant(this.state, context.runId, context.writeEnabled);
        const realRoot = this.state.room?.descriptor?.kind === "workspace-folder"
          ? this.state.room.descriptor.rootPath
          : null;
        // Deep Agents access files through MCP rather than a raw cwd. When
        // Cloud Privacy supplies a redacted mirror, the MCP backend must point
        // at that mirror too; otherwise a cloud tool can bypass placeholder
        // validation and mutate the real workspace directly.
        const workspace = realRoot !== null
          && path.resolve(context.workspacePath) === path.resolve(realRoot)
          ? grant.workspace
          : this.mirrorBackend(context.workspacePath, context.writeEnabled);
        const cloud = context.provider !== "ollama-local";
        const scope = cloud ? { kind: "CloudEngine" as const } : { kind: "LocalEngine" as const };
        const dispatcher = roomServerDispatcherFactory(this.state, this.emit, this.services)(
          false,
          scope,
          WEB_LANES_ALL,
          {
            workspace,
            privacyBypass: context.privacyMode === "cloud-direct",
          },
        );
        bridge = await createRoomBridge({ scope, dispatcher });

        let provider: Record<string, unknown> | null = null;
        if (context.provider === "openrouter") {
          await ensureProviderCatalog(context.model);
          const config = providerRuntimeConfig(context.model);
          if (config === null) throw new Error("Choose an OpenRouter model for the OpenRouter harness.");
          provider = providerRuntimeConfigWire(config);
        }
        const owner = new TurnId(context.runId, input.threadId ?? "");
        const ollamaBaseUrl = resolvedBaseUrl();
        if (context.provider === "ollama-local" && !isLoopbackBaseUrl(ollamaBaseUrl)) {
          throw new Error("Local Ollama must use a loopback server on this Mac.");
        }
        const outcome: SidecarOutcome = await this.runSidecar(
          {
            model: context.model,
            question: input.text,
            harness: "deep",
            messages: context.systemPrompt ? [{ role: "system", content: context.systemPrompt }] : [],
            ollamaBaseUrl,
            mcp: {
              url: `http://127.0.0.1:${bridge.port}/mcp`,
              token: bridge.token,
              ...grant.wireAuthority,
            },
            // The UI's explicit Allow file changes choice is authoritative.
            // Prompt keyword inference must not silently remove a granted,
            // baseline-protected write capability.
            routing: { write: context.writeEnabled },
            webEnabled: false,
            runId: context.runId,
            provider,
          },
          { turn: owner, onEvent: sendOldEvent, signal: abort.signal },
        );
        if (outcome.kind === "failed") {
          output.push({ type: "run_failed", runId: context.runId, error: safeProviderFailure(context.provider) });
        } else {
          output.push({
            type: "run_completed",
            runId: context.runId,
            status: abort.signal.aborted ? "cancelled" : "completed",
          });
        }
      } catch (error) {
        output.push({
          type: "run_failed",
          runId: context.runId,
          error: safeProviderFailure(context.provider, "startup"),
        });
      } finally {
        await bridge?.stopAndWait().catch(() => undefined);
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
