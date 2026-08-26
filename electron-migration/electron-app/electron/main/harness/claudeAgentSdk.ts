import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  query,
  type CanUseTool,
  type HookCallback,
  type PreToolUseHookInput,
  type SDKMessage,
  type SpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { AsyncEventQueue } from "./eventQueue.js";
import { spawnWithNativeWorkspaceSandbox } from "./seatbelt.js";
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
const NETWORK_COMMAND = /(^|[;&|()\s])(curl|wget|nc|ncat|ssh|scp|sftp|ftp|telnet)\b/i;
const EXECUTABLE_CHANGE = /(^|[;&|()\s])chmod\s+(?:-[^\s]+\s+)*[^\n]*(?:\+x|[157][0-7]{2})/i;

function within(root: string, candidate: string): boolean {
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(path.resolve(root), absolute);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
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

  async available(): Promise<boolean> {
    const result = spawnSync(process.env.ARCELLE_CLAUDE_PATH ?? "claude", ["--version"], {
      stdio: "ignore",
      timeout: 5_000,
    });
    return result.status === 0;
  }

  async startTurn(context: HarnessContext, input: HarnessInput): Promise<HarnessRun> {
    if (!context.exposureVerified) {
      throw new Error("Claude native harness refused an unverified workspace exposure.");
    }
    const events = new AsyncEventQueue<HarnessEvent>();
    const abortController = new AbortController();
    const pending = new Map<string, PendingApproval>();

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
      if (candidate !== null && privateOrOutside(context.workspacePath, candidate)) {
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
      const inputRecord = hookInput as unknown as { tool_name?: string };
      events.push({
        type: "tool_completed",
        runId: context.runId,
        tool: inputRecord.tool_name ?? "tool",
        toolId: toolUseId,
      });
      return {};
    };

    const spawnSandboxed = (options: SpawnOptions): SpawnedProcess =>
      spawnWithNativeWorkspaceSandbox(
        {
          workspacePath: context.workspacePath,
          runtimePath: context.runtimePath,
          executable: options.command,
          provider: "claude",
          writeEnabled: context.writeEnabled,
          env: options.env,
        },
        options.args,
        { cwd: options.cwd, env: options.env, signal: options.signal },
      );

    const sdkQuery = query({
      prompt: input.text,
      options: {
        abortController,
        cwd: context.workspacePath,
        model: context.model || undefined,
        systemPrompt: context.systemPrompt === undefined
          ? { type: "preset", preset: "claude_code" }
          : { type: "preset", preset: "claude_code", append: context.systemPrompt },
        tools: { type: "preset", preset: "claude_code" },
        disallowedTools: ["WebFetch", "WebSearch"],
        permissionMode: "default",
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: false,
          allowUnsandboxedCommands: false,
          filesystem: {
            allowManagedReadPathsOnly: true,
            allowRead: [context.workspacePath],
            allowWrite: context.writeEnabled ? [context.workspacePath] : [],
            denyRead: [path.join(context.workspacePath, ".arcelle")],
            denyWrite: [path.join(context.workspacePath, ".arcelle")],
          },
          network: {
            strictAllowlist: true,
            allowedDomains: [],
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
        },
        spawnClaudeCodeProcess: spawnSandboxed,
      },
    });

    void (async () => {
      events.push({ type: "run_started", runId: context.runId, harness: this.name });
      try {
        for await (const message of sdkQuery) {
          const delta = streamText(message);
          if (delta !== null) events.push({ type: "text_delta", runId: context.runId, text: delta });
          if (message.type === "system" && message.subtype === "init") {
            events.push({ type: "agent_started", runId: context.runId, agentId: "coordinator", label: "Claude" });
          }
          if (message.type === "assistant") {
            for (const block of message.message.content) {
              if (block.type === "tool_use") {
                events.push({
                  type: "tool_started",
                  runId: context.runId,
                  tool: block.name,
                  toolId: block.id,
                });
              }
            }
          }
          if (message.type === "result") {
            const usage = message.subtype === "success" ? message.usage : undefined;
            events.push({
              type: "usage_updated",
              runId: context.runId,
              inputTokens: usage?.input_tokens,
              outputTokens: usage?.output_tokens,
              costUsd: message.total_cost_usd,
            });
            if (message.subtype !== "success" || message.is_error) {
              events.push({ type: "run_failed", runId: context.runId, error: "Claude Agent SDK run failed." });
            } else {
              events.push({ type: "agent_completed", runId: context.runId, agentId: "coordinator" });
              events.push({ type: "run_completed", runId: context.runId, status: "completed" });
            }
          }
        }
      } catch (error) {
        events.push({ type: "run_failed", runId: context.runId, error: error instanceof Error ? error.message : String(error) });
      } finally {
        for (const approval of pending.values()) approval.resolve("cancel");
        pending.clear();
        events.end();
      }
    })();

    return {
      events,
      cancel: async () => {
        abortController.abort();
        sdkQuery.close();
      },
      approve: async (requestId, decision) => {
        const approval = pending.get(requestId);
        if (approval === undefined) throw new Error("That approval request is no longer active.");
        approval.resolve(decision);
      },
    };
  }
}
