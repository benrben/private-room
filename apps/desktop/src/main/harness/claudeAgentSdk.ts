import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  query,
  type CanUseTool,
  type HookCallback,
  type PostToolUseFailureHookInput,
  type PreToolUseHookInput,
  type SDKMessage,
  type SpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { AsyncEventQueue } from "./eventQueue.js";
import { claudeAgentDefinitions } from "./agentManifest.js";
import { safeProviderFailure } from "./failureSafety.js";
import { nativeCliExecutable, nativeHarnessModel } from "./nativeCli.js";
import type {
  NativeRoomMcpExposure,
  NativeRoomMcpFactory,
} from "./nativeRoomMcp.js";
import {
  spawnWithNativeWorkspaceSandbox,
  terminateNativeProcessTree,
  verifyNativeHarnessExecutable,
} from "./seatbelt.js";
import type {
  ApprovalDecision,
  HarnessContext,
  HarnessEvent,
  HarnessInput,
  HarnessRun,
  HarnessRuntime,
} from "./types.js";
import { canonicalPath, mutatingTool, preToolDecision } from "./claudeToolPolicy.js";

const SAFE_TOOL_FAILURE =
  "Claude tool failed. Provider diagnostics were omitted to protect room data.";
const SAFE_TOOL_DENIAL =
  "Claude tool was denied by the Arcelle permission policy.";
const SAFE_TOOL_INCOMPLETE = "Claude tool ended without a completion result.";
const WORKSPACE_TOOL_GUIDANCE =
  "Use native Read, Write, Edit, Glob, Grep, and NotebookEdit for normal room files. " +
  "For move, rename, or delete operations, you must use the Arcelle Room MCP tools because Claude has no native tool for those operations. " +
  "Bash is unavailable in this runtime.";

function streamText(message: SDKMessage): string | null {
  if (
    message.type !== "stream_event" ||
    message.event.type !== "content_block_delta"
  )
    return null;
  const delta = message.event.delta as { type?: string; text?: string };
  return delta.type === "text_delta" && typeof delta.text === "string"
    ? delta.text
    : null;
}

interface PendingApproval {
  resolve(decision: ApprovalDecision): void;
}

type ClaudeToolTracker = {
  events: AsyncEventQueue<HarnessEvent>;
  runId: string;
  started: Map<string, string>;
  settled: Set<string>;
  hadMutatingFailure: boolean;
};

type ClaudeStreamState = {
  context: HarnessContext;
  events: AsyncEventQueue<HarnessEvent>;
  subagents: Map<string, string>;
  tools: ClaudeToolTracker;
  receivedResult: boolean;
  providerSucceeded: boolean;
};

type ClaudeAssistantMessage = Extract<SDKMessage, { type: "assistant" }>;
type ClaudeContentBlock = ClaudeAssistantMessage["message"]["content"][number];
type ClaudeResultMessage = Extract<SDKMessage, { type: "result" }>;

function startTrackedTool(
  tracker: ClaudeToolTracker,
  toolId: string,
  tool: string,
): void {
  if (tracker.settled.has(toolId) || tracker.started.has(toolId)) return;
  tracker.started.set(toolId, tool);
  tracker.events.push({
    type: "tool_started",
    runId: tracker.runId,
    tool,
    toolId,
  });
}

function settleTrackedTool(
  tracker: ClaudeToolTracker,
  toolId: string,
  tool: string,
  error?: string,
): void {
  if (tracker.settled.has(toolId)) return;
  startTrackedTool(tracker, toolId, tool);
  tracker.settled.add(toolId);
  tracker.started.delete(toolId);
  if (error !== undefined && mutatingTool(tool))
    tracker.hadMutatingFailure = true;
  tracker.events.push({
    type: "tool_completed",
    runId: tracker.runId,
    tool,
    toolId,
    error,
  });
}

function parentToolUseId(message: SDKMessage): string | null {
  const value = (message as unknown as { parent_tool_use_id?: string | null })
    .parent_tool_use_id;
  return value ?? null;
}

function emitStreamText(message: SDKMessage, state: ClaudeStreamState): void {
  const delta = streamText(message);
  if (delta === null) return;
  const parentId = parentToolUseId(message);
  state.events.push({
    type: "text_delta",
    runId: state.context.runId,
    text: delta,
    agentId: parentId === null ? undefined : state.subagents.get(parentId),
  });
}

function emitCoordinatorStart(
  message: SDKMessage,
  state: ClaudeStreamState,
): void {
  if (message.type !== "system" || message.subtype !== "init") return;
  state.events.push({
    type: "agent_started",
    runId: state.context.runId,
    agentId: "coordinator",
    label: "Claude",
  });
}

function isSubagentTool(name: string): boolean {
  return name === "Agent" || name === "Task";
}

function subagentId(input: Record<string, unknown>, fallback: string): string {
  if (typeof input.subagent_type === "string") return input.subagent_type;
  if (typeof input.agent === "string") return input.agent;
  return fallback;
}

function recordAssistantBlock(
  block: ClaudeContentBlock,
  state: ClaudeStreamState,
): void {
  if (block.type !== "tool_use") return;
  const input = block.input as Record<string, unknown>;
  if (isSubagentTool(block.name)) {
    const agentId = subagentId(input, block.id);
    state.subagents.set(block.id, agentId);
    state.events.push({
      type: "agent_started",
      runId: state.context.runId,
      agentId,
      label: agentId,
    });
  }
  startTrackedTool(state.tools, block.id, block.name);
}

function recordAssistantTools(
  message: SDKMessage,
  state: ClaudeStreamState,
): void {
  if (message.type !== "assistant") return;
  for (const block of message.message.content)
    recordAssistantBlock(block, state);
}

function resultUsage(message: ClaudeResultMessage) {
  return message.subtype === "success" ? message.usage : undefined;
}

function recordResult(message: SDKMessage, state: ClaudeStreamState): void {
  if (message.type !== "result") return;
  state.receivedResult = true;
  state.providerSucceeded = message.subtype === "success" && !message.is_error;
  for (const denial of message.permission_denials ?? []) {
    settleTrackedTool(
      state.tools,
      denial.tool_use_id,
      denial.tool_name,
      SAFE_TOOL_DENIAL,
    );
  }
  const usage = resultUsage(message);
  state.events.push({
    type: "usage_updated",
    runId: state.context.runId,
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
    costUsd: message.total_cost_usd,
  });
}

function recordSdkMessage(message: SDKMessage, state: ClaudeStreamState): void {
  emitStreamText(message, state);
  emitCoordinatorStart(message, state);
  recordAssistantTools(message, state);
  recordResult(message, state);
}

function settleUnfinishedTools(tracker: ClaudeToolTracker): void {
  for (const [toolId, tool] of tracker.started) {
    settleTrackedTool(tracker, toolId, tool, SAFE_TOOL_INCOMPLETE);
  }
}

function runSucceeded(state: ClaudeStreamState): boolean {
  return (
    state.receivedResult &&
    state.providerSucceeded &&
    !state.tools.hadMutatingFailure
  );
}

function emitRunTerminal(state: ClaudeStreamState): void {
  if (!runSucceeded(state)) {
    state.events.push({
      type: "run_failed",
      runId: state.context.runId,
      error: "Claude Agent SDK run failed.",
    });
    return;
  }
  state.events.push({
    type: "agent_completed",
    runId: state.context.runId,
    agentId: "coordinator",
  });
  state.events.push({
    type: "run_completed",
    runId: state.context.runId,
    status: "completed",
  });
}

function cancelPendingApprovals(pending: Map<string, PendingApproval>): void {
  for (const approval of pending.values()) approval.resolve("cancel");
  pending.clear();
}

async function streamClaudeEvents(
  sdkQuery: ReturnType<typeof query>,
  state: ClaudeStreamState,
  pending: Map<string, PendingApproval>,
  roomMcp: NativeRoomMcpExposure | undefined,
): Promise<void> {
  try {
    for await (const message of sdkQuery) recordSdkMessage(message, state);
    settleUnfinishedTools(state.tools);
    emitRunTerminal(state);
  } catch {
    state.events.push({
      type: "run_failed",
      runId: state.context.runId,
      error: safeProviderFailure("claude"),
    });
  } finally {
    cancelPendingApprovals(pending);
    await roomMcp?.stop();
    state.events.end();
  }
}

export class ClaudeAgentSdkRuntime implements HarnessRuntime {
  readonly name = "claude-agent-sdk" as const;

  private readonly executable: string;

  constructor(
    executable = nativeCliExecutable("claude"),
    private readonly roomMcpFactory?: NativeRoomMcpFactory,
  ) {
    this.executable = executable;
  }

  async available(): Promise<boolean> {
    const result = spawnSync(this.executable, ["--version"], {
      stdio: "ignore",
      timeout: 5_000,
    });
    return result.status === 0;
  }

  async verifyExposure(
    workspacePath: string,
    runtimePath: string,
    writeEnabled: boolean,
  ): Promise<boolean> {
    return verifyNativeHarnessExecutable(
      {
        workspacePath,
        runtimePath,
        executable: this.executable,
        provider: "claude",
        writeEnabled,
      },
      ["--version"],
    );
  }

  async startTurn(
    context: HarnessContext,
    input: HarnessInput,
  ): Promise<HarnessRun> {
    if (!context.exposureVerified) {
      throw new Error(
        "Claude native harness refused an unverified workspace exposure.",
      );
    }
    const events = new AsyncEventQueue<HarnessEvent>();
    // macOS exposes /var as a symlink to /private/var. Claude resolves its cwd
    // before producing native Read/Write inputs, so every containment check and
    // both sandbox layers must use the same physical workspace path.
    const workspacePath = canonicalPath(context.workspacePath);
    const abortController = new AbortController();
    const pending = new Map<string, PendingApproval>();
    const spawned = new Set<SpawnedProcess>();
    const subagents = new Map<string, string>();
    const tools: ClaudeToolTracker = {
      events,
      runId: context.runId,
      started: new Map<string, string>(),
      settled: new Set<string>(),
      hadMutatingFailure: false,
    };
    const roomMcp = await this.roomMcpFactory?.(context);

    const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
      const requestId = options.requestId || options.toolUseID;
      events.push({
        type: "approval_requested",
        runId: context.runId,
        requestId,
        tool: toolName,
        detail:
          options.title ??
          options.description ??
          `Claude wants to use ${toolName}.`,
      });
      const decision = await new Promise<ApprovalDecision>((resolve) => {
        const onAbort = () => resolve("cancel");
        options.signal.addEventListener("abort", onAbort, { once: true });
        pending.set(requestId, {
          resolve: (value) => {
            options.signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
        });
      });
      pending.delete(requestId);
      return decision === "allow-once" || decision === "allow-run"
        ? {
            behavior: "allow",
            updatedInput: toolInput,
            toolUseID: options.toolUseID,
          }
        : {
            behavior: "deny",
            message: "Arcelle did not approve this operation.",
            interrupt: decision === "cancel",
          };
    };

    const preTool: HookCallback = async (hookInput) => {
      const pre = hookInput as PreToolUseHookInput;
      const toolInput = (pre.tool_input ?? {}) as Record<string, unknown>;
      return preToolDecision(
        pre.tool_name,
        toolInput,
        workspacePath,
        context.writeEnabled,
      );
    };

    const postTool: HookCallback = async (hookInput, toolUseId) => {
      const inputRecord = hookInput as unknown as {
        tool_name?: string;
        tool_use_id?: string;
      };
      const settledId = toolUseId ?? inputRecord.tool_use_id;
      if (settledId !== undefined)
        settleTrackedTool(tools, settledId, inputRecord.tool_name ?? "tool");
      const subagent =
        settledId === undefined ? undefined : subagents.get(settledId);
      if (subagent !== undefined) {
        events.push({
          type: "agent_completed",
          runId: context.runId,
          agentId: subagent,
        });
        subagents.delete(settledId!);
      }
      return {};
    };

    const postToolFailure: HookCallback = async (hookInput, toolUseId) => {
      const failure = hookInput as PostToolUseFailureHookInput;
      settleTrackedTool(
        tools,
        toolUseId ?? failure.tool_use_id,
        failure.tool_name,
        SAFE_TOOL_FAILURE,
      );
      return {};
    };

    const spawnSandboxed = (options: SpawnOptions): SpawnedProcess => {
      const child = spawnWithNativeWorkspaceSandbox(
        {
          workspacePath,
          runtimePath: context.runtimePath,
          executable: options.command,
          provider: "claude",
          writeEnabled: context.writeEnabled,
          env: options.env,
        },
        options.args,
        { cwd: options.cwd, env: options.env, signal: options.signal },
      );
      spawned.add(child);
      child.once("exit", () => spawned.delete(child));
      return child;
    };

    let sdkQuery: ReturnType<typeof query>;
    try {
      const systemAppend = [
        context.systemPrompt,
        WORKSPACE_TOOL_GUIDANCE,
        roomMcp?.instructions,
      ]
        .filter(
          (value): value is string =>
            typeof value === "string" && value.length > 0,
        )
        .join("\n\n");
      sdkQuery = query({
        prompt: input.text,
        options: {
          abortController,
          // The SDK resolves its optional CLI relative to sdk.mjs. Inside an
          // Electron asar that virtual path is readable by Node but cannot be
          // executed by spawn(2). Use the executable that Arcelle already
          // capability-probed (normally the installed Claude Code CLI), so the
          // packaged app starts the same verified binary as the sandbox test.
          pathToClaudeCodeExecutable: this.executable,
          cwd: workspacePath,
          model: nativeHarnessModel(context.model),
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: systemAppend,
          },
          tools: { type: "preset", preset: "claude_code" },
          agents: claudeAgentDefinitions(),
          mcpServers:
            roomMcp === undefined
              ? undefined
              : {
                  room: claudeRoomMcpConfiguration(roomMcp),
                },
          strictMcpConfig: roomMcp !== undefined,
          // Claude Code's Bash tool starts its own macOS sandbox. Arcelle has
          // already placed the CLI inside a stricter Seatbelt profile, and the
          // nested sandbox is not compatible with that verified exposure.
          disallowedTools: ["Bash", "WebFetch", "WebSearch"],
          permissionMode: "default",
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            autoAllowBashIfSandboxed: false,
            allowUnsandboxedCommands: false,
            filesystem: {
              allowManagedReadPathsOnly: true,
              allowRead: [workspacePath],
              allowWrite: context.writeEnabled ? [workspacePath] : [],
              denyRead: [path.join(workspacePath, ".arcelle")],
              denyWrite: [path.join(workspacePath, ".arcelle")],
            },
            network: {
              strictAllowlist: true,
              // The per-run Arcelle MCP bridge is the only network endpoint
              // exposed to the native Claude process. Seatbelt still blocks
              // filesystem escape and the bridge requires a fresh bearer token.
              allowedDomains: roomMcp === undefined ? [] : ["127.0.0.1"],
              allowLocalBinding: false,
              allowAllUnixSockets: false,
            },
          },
          canUseTool,
          includePartialMessages: true,
          forwardSubagentText: true,
          includeHookEvents: true,
          settingSources: [],
          hooks: {
            PreToolUse: [{ hooks: [preTool] }],
            PostToolUse: [{ hooks: [postTool] }],
            PostToolUseFailure: [{ hooks: [postToolFailure] }],
          },
          spawnClaudeCodeProcess: spawnSandboxed,
        },
      });
    } catch (error) {
      await roomMcp?.stop();
      throw error;
    }

    events.push({
      type: "run_started",
      runId: context.runId,
      harness: this.name,
    });
    void streamClaudeEvents(
      sdkQuery,
      {
        context,
        events,
        subagents,
        tools,
        receivedResult: false,
        providerSucceeded: false,
      },
      pending,
      roomMcp,
    );

    return {
      events,
      cancel: async () => {
        abortController.abort();
        sdkQuery.close();
        for (const child of spawned) terminateNativeProcessTree(child);
        spawned.clear();
        await roomMcp?.stop();
      },
      approve: async (requestId, decision) => {
        const approval = pending.get(requestId);
        if (approval === undefined)
          throw new Error("That approval request is no longer active.");
        approval.resolve(decision);
      },
    };
  }
}

/** Serializable SDK config for the one authenticated per-run Room bridge. */
export function claudeRoomMcpConfiguration(exposure: NativeRoomMcpExposure): {
  type: "http";
  url: string;
  headers: Record<string, string>;
  alwaysLoad: true;
} {
  return {
    type: "http",
    url: exposure.url,
    headers: { Authorization: `Bearer ${exposure.token}` },
    // The specialist definitions reference exact room tool names. Loading
    // the catalog before turn one prevents those names from being deferred.
    alwaysLoad: true,
  };
}
