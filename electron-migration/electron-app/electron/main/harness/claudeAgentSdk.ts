import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
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
import { nativeCliExecutable } from "./nativeCli.js";
import type { NativeRoomMcpExposure, NativeRoomMcpFactory } from "./nativeRoomMcp.js";
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

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
const SAFE_TOOL_FAILURE = "Claude tool failed. Provider diagnostics were omitted to protect room data.";
const SAFE_TOOL_DENIAL = "Claude tool was denied by the Arcelle permission policy.";
const SAFE_TOOL_INCOMPLETE = "Claude tool ended without a completion result.";
const NETWORK_COMMAND = /(^|[;&|()\s])(curl|wget|nc|ncat|ssh|scp|sftp|ftp|telnet)\b/i;
const EXECUTABLE_CHANGE = /(^|[;&|()\s])chmod\s+(?:-[^\s]+\s+)*[^\n]*(?:\+x|[157][0-7]{2})/i;

function within(root: string, candidate: string): boolean {
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(path.resolve(root), absolute);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function canonicalPath(candidate: string): string {
  try { return realpathSync(candidate); }
  catch { return path.resolve(candidate); }
}

function requestedPath(input: Record<string, unknown>): string | null {
  for (const key of ["file_path", "path", "notebook_path"]) {
    if (typeof input[key] === "string") return input[key] as string;
  }
  return null;
}

function privateOrOutside(root: string, candidate: string): boolean {
  const absolute = path.resolve(root, candidate);
  const privateRoot = path.join(path.resolve(root), ".arcelle");
  return absolute === privateRoot || absolute.startsWith(`${privateRoot}${path.sep}`) || !within(root, absolute);
}

function mutatingTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName)
    || /(?:^|__)(?:workspace_(?:write|edit|move|rename|delete)|trash_files|organize_files|save_generated_file)$/i.test(toolName);
}

function streamText(message: SDKMessage): string | null {
  if (message.type !== "stream_event" || message.event.type !== "content_block_delta") return null;
  const delta = message.event.delta as { type?: string; text?: string };
  return delta.type === "text_delta" && typeof delta.text === "string" ? delta.text : null;
}

interface PendingApproval {
  resolve(decision: ApprovalDecision): void;
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

  async verifyExposure(workspacePath: string, runtimePath: string, writeEnabled: boolean): Promise<boolean> {
    return verifyNativeHarnessExecutable({
      workspacePath,
      runtimePath,
      executable: this.executable,
      provider: "claude",
      writeEnabled,
    }, ["--version"]);
  }

  async startTurn(context: HarnessContext, input: HarnessInput): Promise<HarnessRun> {
    if (!context.exposureVerified) {
      throw new Error("Claude native harness refused an unverified workspace exposure.");
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
    const startedTools = new Map<string, string>();
    const settledTools = new Set<string>();
    let hadMutatingToolFailure = false;
    const roomMcp = await this.roomMcpFactory?.(context);

    const startTool = (toolId: string, tool: string): void => {
      if (settledTools.has(toolId) || startedTools.has(toolId)) return;
      startedTools.set(toolId, tool);
      events.push({ type: "tool_started", runId: context.runId, tool, toolId });
    };
    const settleTool = (toolId: string, tool: string, error?: string): void => {
      if (settledTools.has(toolId)) return;
      startTool(toolId, tool);
      settledTools.add(toolId);
      startedTools.delete(toolId);
      if (error !== undefined && mutatingTool(tool)) hadMutatingToolFailure = true;
      events.push({ type: "tool_completed", runId: context.runId, tool, toolId, error });
    };

    const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
      const requestId = options.requestId || options.toolUseID;
      events.push({
        type: "approval_requested",
        runId: context.runId,
        requestId,
        tool: toolName,
        detail: options.title ?? options.description ?? `Claude wants to use ${toolName}.`,
      });
      const decision = await new Promise<ApprovalDecision>((resolve) => {
        const onAbort = () => resolve("cancel");
        options.signal.addEventListener("abort", onAbort, { once: true });
        pending.set(requestId, { resolve: (value) => {
          options.signal.removeEventListener("abort", onAbort);
          resolve(value);
        } });
      });
      pending.delete(requestId);
      return decision === "allow-once" || decision === "allow-run"
        ? { behavior: "allow", updatedInput: toolInput, toolUseID: options.toolUseID }
        : { behavior: "deny", message: "Arcelle did not approve this operation.", interrupt: decision === "cancel" };
    };

    const preTool: HookCallback = async (hookInput) => {
      const pre = hookInput as PreToolUseHookInput;
      const toolInput = (pre.tool_input ?? {}) as Record<string, unknown>;
      const candidate = requestedPath(toolInput);
      if (candidate !== null && privateOrOutside(workspacePath, candidate)) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "Arcelle only exposes normal files inside this room.",
          },
        };
      }
      if (WRITE_TOOLS.has(pre.tool_name) && !context.writeEnabled) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "This run is read-only.",
          },
        };
      }
      if (pre.tool_name === "Bash") {
        const command = String(toolInput.command ?? "");
        if (NETWORK_COMMAND.test(command)) {
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: "Shell network access is disabled; use Arcelle browser tools.",
            },
          };
        }
        if (EXECUTABLE_CHANGE.test(command)) {
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: "Agents cannot make room files executable.",
            },
          };
        }
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason: "Shell commands require approval.",
          },
        };
      }
      if (FILE_TOOLS.has(pre.tool_name)) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            permissionDecisionReason: "The operation stays inside the verified room exposure.",
          },
        };
      }
      return {};
    };

    const postTool: HookCallback = async (hookInput, toolUseId) => {
      const inputRecord = hookInput as unknown as { tool_name?: string; tool_use_id?: string };
      const settledId = toolUseId ?? inputRecord.tool_use_id;
      if (settledId !== undefined) settleTool(settledId, inputRecord.tool_name ?? "tool");
      const subagent = settledId === undefined ? undefined : subagents.get(settledId);
      if (subagent !== undefined) {
        events.push({ type: "agent_completed", runId: context.runId, agentId: subagent });
        subagents.delete(settledId!);
      }
      return {};
    };

    const postToolFailure: HookCallback = async (hookInput, toolUseId) => {
      const failure = hookInput as PostToolUseFailureHookInput;
      settleTool(toolUseId ?? failure.tool_use_id, failure.tool_name, SAFE_TOOL_FAILURE);
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
        model: context.model || undefined,
        systemPrompt: context.systemPrompt === undefined
          ? roomMcp === undefined
            ? { type: "preset", preset: "claude_code" }
            : { type: "preset", preset: "claude_code", append: roomMcp.instructions }
          : {
              type: "preset",
              preset: "claude_code",
              append: [context.systemPrompt, roomMcp?.instructions].filter(Boolean).join("\n\n"),
            },
        tools: { type: "preset", preset: "claude_code" },
        agents: claudeAgentDefinitions(),
        mcpServers: roomMcp === undefined ? undefined : {
          room: claudeRoomMcpConfiguration(roomMcp),
        },
        strictMcpConfig: roomMcp !== undefined,
        disallowedTools: ["WebFetch", "WebSearch"],
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

    void (async () => {
      events.push({ type: "run_started", runId: context.runId, harness: this.name });
      let receivedResult = false;
      let providerSucceeded = false;
      try {
        for await (const message of sdkQuery) {
          const delta = streamText(message);
          if (delta !== null) {
            const parentToolUseId = (message as unknown as { parent_tool_use_id?: string | null }).parent_tool_use_id;
            events.push({
              type: "text_delta",
              runId: context.runId,
              text: delta,
              agentId: parentToolUseId == null ? undefined : subagents.get(parentToolUseId),
            });
          }
          if (message.type === "system" && message.subtype === "init") {
            events.push({ type: "agent_started", runId: context.runId, agentId: "coordinator", label: "Claude" });
          }
          if (message.type === "assistant") {
            for (const block of message.message.content) {
              if (block.type === "tool_use") {
                const toolInput = block.input as Record<string, unknown>;
                if (block.name === "Agent" || block.name === "Task") {
                  const agentId = typeof toolInput.subagent_type === "string"
                    ? toolInput.subagent_type
                    : typeof toolInput.agent === "string"
                      ? toolInput.agent
                      : block.id;
                  subagents.set(block.id, agentId);
                  events.push({ type: "agent_started", runId: context.runId, agentId, label: agentId });
                }
                startTool(block.id, block.name);
              }
            }
          }
          if (message.type === "result") {
            receivedResult = true;
            providerSucceeded = message.subtype === "success" && !message.is_error;
            for (const denial of message.permission_denials ?? []) {
              settleTool(denial.tool_use_id, denial.tool_name, SAFE_TOOL_DENIAL);
            }
            const usage = message.subtype === "success" ? message.usage : undefined;
            events.push({
              type: "usage_updated",
              runId: context.runId,
              inputTokens: usage?.input_tokens,
              outputTokens: usage?.output_tokens,
              costUsd: message.total_cost_usd,
            });
          }
        }
        for (const [toolId, tool] of startedTools) {
          settleTool(toolId, tool, SAFE_TOOL_INCOMPLETE);
        }
        if (!receivedResult || !providerSucceeded || hadMutatingToolFailure) {
          events.push({ type: "run_failed", runId: context.runId, error: "Claude Agent SDK run failed." });
        } else {
          events.push({ type: "agent_completed", runId: context.runId, agentId: "coordinator" });
          events.push({ type: "run_completed", runId: context.runId, status: "completed" });
        }
      } catch (error) {
        events.push({ type: "run_failed", runId: context.runId, error: safeProviderFailure("claude") });
      } finally {
        for (const approval of pending.values()) approval.resolve("cancel");
        pending.clear();
        await roomMcp?.stop();
        events.end();
      }
    })();

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
        if (approval === undefined) throw new Error("That approval request is no longer active.");
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
