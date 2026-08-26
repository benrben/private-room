import { execFile } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline";
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

const execFileAsync = promisify(execFile);

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string; code?: number };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function nestedString(value: unknown, ...keys: string[]): string | null {
  let current: unknown = value;
  for (const key of keys) current = record(current)[key];
  return typeof current === "string" ? current : null;
}

function approvalResult(decision: ApprovalDecision): { decision: string } {
  if (decision === "allow-once") return { decision: "accept" };
  if (decision === "allow-run") return { decision: "acceptForSession" };
  if (decision === "cancel") return { decision: "cancel" };
  return { decision: "decline" };
}

export class CodexAppServerRuntime implements HarnessRuntime {
  readonly name = "codex-app-server" as const;
  constructor(private readonly executable = process.env.ARCELLE_CODEX_PATH ?? "codex") {}

  async available(): Promise<boolean> {
    try {
      await execFileAsync(this.executable, ["app-server", "--help"], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  async startTurn(context: HarnessContext, input: HarnessInput): Promise<HarnessRun> {
    if (!context.exposureVerified) {
      throw new Error("Codex native harness refused an unverified workspace exposure.");
    }
    const events = new AsyncEventQueue<HarnessEvent>();
    const child = spawnWithNativeWorkspaceSandbox(
      {
        workspacePath: context.workspacePath,
        runtimePath: context.runtimePath,
        executable: this.executable,
        provider: "codex",
        writeEnabled: context.writeEnabled,
      },
      ["app-server", "--listen", "stdio://"],
      { cwd: context.workspacePath, env: { ...process.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "arcelle" } },
    );
    const pendingRpc = new Map<number | string, {
      resolve(value: unknown): void;
      reject(error: Error): void;
    }>();
    const approvalRequests = new Map<string, number | string>();
    let nextId = 1;
    let threadId: string | null = null;
    let turnId: string | null = null;
    let terminal = false;
    let stderr = "";

    const send = (message: RpcMessage): void => {
      if (child.stdin.destroyed) throw new Error("Codex app-server is closed.");
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const request = (method: string, params: Record<string, unknown>): Promise<unknown> => {
      const id = nextId++;
      send({ id, method, params });
      return new Promise((resolve, reject) => pendingRpc.set(id, { resolve, reject }));
    };
    const respond = (id: number | string, result: unknown): void => send({ id, result });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000);
    });

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message: RpcMessage;
      try { message = JSON.parse(line) as RpcMessage; } catch { return; }
      if (message.id !== undefined && message.method === undefined) {
        const pending = pendingRpc.get(message.id);
        if (pending === undefined) return;
        pendingRpc.delete(message.id);
        if (message.error !== undefined) pending.reject(new Error(message.error.message ?? "Codex request failed."));
        else pending.resolve(message.result);
        return;
      }
      if (message.id !== undefined && message.method !== undefined) {
        const method = message.method;
        if (
          method === "item/commandExecution/requestApproval" ||
          method === "item/fileChange/requestApproval"
        ) {
          const requestId = String(message.id);
          approvalRequests.set(requestId, message.id);
          events.push({
            type: "approval_requested",
            runId: context.runId,
            requestId,
            tool: method.includes("commandExecution") ? "shell" : "file_change",
            detail: nestedString(message.params, "reason") ?? nestedString(message.params, "command") ?? "Codex requests approval.",
          });
          return;
        }
        // Arcelle does not expose generic app-server elicitations yet. Refuse
        // rather than leaving the Codex process blocked forever.
        respond(message.id, { action: "decline", content: null });
        return;
      }
      if (message.method === undefined) return;
      const params = message.params ?? {};
      if (message.method === "item/agentMessage/delta") {
        const delta = nestedString(params, "delta");
        if (delta !== null) events.push({ type: "text_delta", runId: context.runId, text: delta });
      } else if (message.method === "item/started") {
        const item = record(params.item);
        const itemType = String(item.type ?? "tool");
        if (itemType === "commandExecution" || itemType === "fileChange" || itemType === "mcpToolCall") {
          events.push({
            type: "tool_started",
            runId: context.runId,
            tool: itemType,
            toolId: typeof item.id === "string" ? item.id : undefined,
          });
        }
      } else if (message.method === "item/completed") {
        const item = record(params.item);
        const itemType = String(item.type ?? "tool");
        events.push({
          type: "tool_completed",
          runId: context.runId,
          tool: itemType,
          toolId: typeof item.id === "string" ? item.id : undefined,
          error: item.status === "failed" ? nestedString(item, "error", "message") ?? "Tool failed." : undefined,
        });
      } else if (message.method === "turn/diff/updated") {
        const diff = nestedString(params, "diff");
        if (diff !== null) events.push({ type: "plan_updated", runId: context.runId, text: diff });
      } else if (message.method === "thread/tokenUsage/updated") {
        const usage = record(params.tokenUsage ?? params.usage);
        events.push({
          type: "usage_updated",
          runId: context.runId,
          inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : undefined,
          outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : undefined,
        });
      } else if (message.method === "turn/completed") {
        terminal = true;
        const turn = record(params.turn);
        const status = String(turn.status ?? "failed");
        if (status === "completed") {
          events.push({ type: "agent_completed", runId: context.runId, agentId: "coordinator" });
          events.push({ type: "run_completed", runId: context.runId, status: "completed" });
        } else if (status === "interrupted") {
          events.push({ type: "run_completed", runId: context.runId, status: "cancelled" });
        } else {
          events.push({ type: "run_failed", runId: context.runId, error: nestedString(turn, "error", "message") ?? "Codex turn failed." });
        }
        child.stdin.end();
      } else if (message.method === "error") {
        events.push({ type: "run_failed", runId: context.runId, error: nestedString(params, "error", "message") ?? "Codex app-server error." });
      }
    });

    child.once("exit", (code) => {
      for (const pending of pendingRpc.values()) pending.reject(new Error("Codex app-server exited."));
      pendingRpc.clear();
      if (!terminal) {
        events.push({
          type: "run_failed",
          runId: context.runId,
          error: stderr.trim() || `Codex app-server exited with code ${String(code)}.`,
        });
      }
      events.end();
    });

    void (async () => {
      events.push({ type: "run_started", runId: context.runId, harness: this.name });
      try {
        await request("initialize", {
          clientInfo: { name: "arcelle", title: "Arcelle", version: "0.25.0" },
          capabilities: { experimentalApi: false },
        });
        send({ method: "initialized", params: {} });
        const threadResponse = input.threadId === undefined
          ? await request("thread/start", {
              model: context.model || undefined,
              cwd: context.workspacePath,
              approvalPolicy: "unlessTrusted",
              sandbox: context.writeEnabled ? "workspaceWrite" : "readOnly",
              ephemeral: true,
            })
          : await request("thread/resume", { threadId: input.threadId, cwd: context.workspacePath });
        threadId = nestedString(threadResponse, "thread", "id");
        if (threadId === null) throw new Error("Codex did not return a thread id.");
        events.push({ type: "agent_started", runId: context.runId, agentId: "coordinator", label: "Codex" });
        const turnResponse = await request("turn/start", {
          threadId,
          input: [{ type: "text", text: input.text }],
          cwd: context.workspacePath,
          approvalPolicy: "unlessTrusted",
          sandboxPolicy: context.writeEnabled
            ? { type: "workspaceWrite", writableRoots: [context.workspacePath], networkAccess: false }
            : { type: "readOnly" },
        });
        turnId = nestedString(turnResponse, "turn", "id");
      } catch (error) {
        terminal = true;
        events.push({ type: "run_failed", runId: context.runId, error: error instanceof Error ? error.message : String(error) });
        child.kill("SIGTERM");
      }
    })();

    return {
      events,
      cancel: async () => {
        if (threadId !== null && turnId !== null) {
          try { await request("turn/interrupt", { threadId, turnId }); } catch { child.kill("SIGTERM"); }
        } else {
          child.kill("SIGTERM");
        }
      },
      approve: async (requestId, decision) => {
        const rpcId = approvalRequests.get(requestId);
        if (rpcId === undefined) throw new Error("That approval request is no longer active.");
        approvalRequests.delete(requestId);
        respond(rpcId, approvalResult(decision));
      },
    };
  }
}
