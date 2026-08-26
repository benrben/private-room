import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import readline from "node:readline";
import { AsyncEventQueue } from "./eventQueue.js";
import { codexAgentInstructions } from "./agentManifest.js";
import { inspectCodexSchemaDirectory, type CodexSchemaCompatibility } from "./codexSchema.js";
import { safeProviderFailure } from "./failureSafety.js";
import {
  spawnWithNativeWorkspaceSandbox,
  terminateNativeProcessTree,
  type NativeWorkspaceSandbox,
} from "./seatbelt.js";
import type {
  ApprovalDecision,
  HarnessContext,
  HarnessEvent,
  HarnessInput,
  HarnessRun,
  HarnessRuntime,
} from "./types.js";

const execFileAsync = promisify(execFile);
type SandboxSpawn = typeof spawnWithNativeWorkspaceSandbox;

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

function itemType(item: Record<string, unknown>): string {
  return String(item.type ?? "tool").replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
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

export class CodexAppServerRuntime implements HarnessRuntime {
  readonly name = "codex-app-server" as const;
  private compatibility: CodexSchemaCompatibility | null = null;
  constructor(
    private readonly executable = process.env.ARCELLE_CODEX_PATH ?? "codex",
    private readonly sandboxSpawn: SandboxSpawn = spawnWithNativeWorkspaceSandbox,
    private readonly startupProbeTimeoutMs = 5_000,
  ) {}

  async available(): Promise<boolean> {
    const schemaRoot = await mkdtemp(path.join(os.tmpdir(), "arcelle-codex-schema-"));
    try {
      await execFileAsync(this.executable, ["app-server", "--help"], { timeout: 5_000 });
      // app-server is versioned with the installed Codex binary. Generating
      // its stable schema is both a compatibility probe and proof that Arcelle
      // can bind to that exact installed protocol instead of a bundled guess.
      await execFileAsync(
        this.executable,
        ["app-server", "generate-json-schema", "--out", schemaRoot],
        { timeout: 10_000 },
      );
      if (!(await readdir(schemaRoot)).some((name) => name.endsWith(".json") || name === "v1" || name === "v2")) return false;
      this.compatibility = await inspectCodexSchemaDirectory(schemaRoot);
      return this.compatibility.compatible;
    } catch {
      this.compatibility = null;
      return false;
    } finally {
      await rm(schemaRoot, { recursive: true, force: true });
    }
  }

  installedSchemaCompatibility(): CodexSchemaCompatibility | null {
    return this.compatibility === null ? null : { ...this.compatibility, missingMethods: [...this.compatibility.missingMethods] };
  }

  async verifyExposure(workspacePath: string, runtimePath: string, writeEnabled: boolean): Promise<boolean> {
    const options: NativeWorkspaceSandbox = {
      workspacePath,
      runtimePath,
      executable: this.executable,
      provider: "codex",
      writeEnabled,
    };
    let child;
    try {
      child = this.sandboxSpawn(
        options,
        ["app-server", "--listen", "stdio://"],
        {
          cwd: workspacePath,
          env: { ...process.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "arcelle" },
        },
      );
    } catch {
      return false;
    }

    // The help command only proves the executable can be loaded. Newer Codex
    // releases initialize config and SQLite after app-server startup, so the
    // real capability boundary is a successful JSON-RPC initialize response
    // under this exact Seatbelt profile. Drain but never retain stderr: it may
    // contain provider paths, credentials, or room-derived diagnostics.
    child.stderr.on("data", () => undefined);
    const lines = readline.createInterface({ input: child.stdout });
    let ready = false;
    let exited = false;
    let settle!: () => void;
    const lifecycle = new Promise<void>((resolve) => { settle = resolve; });
    child.once("error", () => { exited = true; settle(); });
    child.once("exit", () => { exited = true; settle(); });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as RpcMessage;
        if (message.id === "arcelle-capability" && message.error === undefined) {
          ready = true;
          settle();
        }
      } catch {
        // Non-protocol stdout cannot establish capability.
      }
    });
    try {
      child.stdin.write(`${JSON.stringify({
        id: "arcelle-capability",
        method: "initialize",
        params: {
          clientInfo: { name: "arcelle-capability", title: "Arcelle", version: "0.25.0" },
          capabilities: { experimentalApi: false },
        },
      })}\n`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        lifecycle,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.startupProbeTimeoutMs);
          timer.unref?.();
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    } catch {
      ready = false;
    } finally {
      lines.close();
      if (!exited) terminateNativeProcessTree(child, "SIGTERM", 250);
      if (!exited) {
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          lifecycle,
          new Promise<void>((resolve) => {
            cleanupTimer = setTimeout(resolve, 1_000);
            cleanupTimer.unref?.();
          }),
        ]);
        if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
      }
      if (!exited) terminateNativeProcessTree(child, "SIGKILL", -1);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
    return ready;
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

    // Drain stderr, but never retain it: provider diagnostics may echo room
    // content, absolute paths, prompts, or credentials.
    child.stderr.on("data", () => undefined);

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message: RpcMessage;
      try { message = JSON.parse(line) as RpcMessage; } catch { return; }
      if (message.id !== undefined && message.method === undefined) {
        const pending = pendingRpc.get(message.id);
        if (pending === undefined) return;
        pendingRpc.delete(message.id);
        if (message.error !== undefined) pending.reject(new Error(safeProviderFailure("codex", "run")));
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
        const type = itemType(item);
        if (type === "collabToolCall" || type === "collabAgentToolCall") {
          const tool = String(item.tool ?? "collaboration");
          for (const agentId of collabAgentIds(item)) {
            events.push({ type: "agent_started", runId: context.runId, agentId, label: tool });
          }
        }
        if (type === "commandExecution" || type === "fileChange" || type === "mcpToolCall" || type === "collabToolCall" || type === "collabAgentToolCall") {
          events.push({
            type: "tool_started",
            runId: context.runId,
            tool: type,
            toolId: typeof item.id === "string" ? item.id : undefined,
          });
        }
      } else if (message.method === "item/completed") {
        const item = record(params.item);
        const type = itemType(item);
        events.push({
          type: "tool_completed",
          runId: context.runId,
          tool: type,
          toolId: typeof item.id === "string" ? item.id : undefined,
          error: item.status === "failed" ? safeProviderFailure("codex", "tool") : undefined,
        });
        if (type === "collabToolCall" || type === "collabAgentToolCall") {
          const statuses = collabStatuses(item);
          const ids = statuses.length > 0 ? statuses.map(([id]) => id) : collabAgentIds(item);
          for (const agentId of ids) {
            const status = statuses.find(([id]) => id === agentId)?.[1];
            if (status === "completed" || status === "errored" || status === "interrupted" || status === "shutdown" || item.status === "failed") {
              events.push({ type: "agent_completed", runId: context.runId, agentId });
            }
          }
        }
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
          events.push({ type: "run_failed", runId: context.runId, error: safeProviderFailure("codex") });
        }
        child.stdin.end();
      } else if (message.method === "error") {
        events.push({ type: "run_failed", runId: context.runId, error: safeProviderFailure("codex") });
      }
    });

    child.once("exit", (code) => {
      for (const pending of pendingRpc.values()) pending.reject(new Error("Codex app-server exited."));
      pendingRpc.clear();
      if (!terminal) {
        events.push({
          type: "run_failed",
          runId: context.runId,
          error: safeProviderFailure("codex", "run", code),
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
        const generatedInstructions = codexAgentInstructions();
        const prompt = [
          context.systemPrompt,
          generatedInstructions,
          `User task:\n${input.text}`,
        ].filter((part): part is string => typeof part === "string" && part.length > 0).join("\n\n");
        const turnResponse = await request("turn/start", {
          threadId,
          input: [{ type: "text", text: prompt }],
          cwd: context.workspacePath,
          approvalPolicy: "unlessTrusted",
          sandboxPolicy: context.writeEnabled
            ? { type: "workspaceWrite", writableRoots: [context.workspacePath], networkAccess: false }
            : { type: "readOnly" },
        });
        turnId = nestedString(turnResponse, "turn", "id");
      } catch (error) {
        terminal = true;
        events.push({ type: "run_failed", runId: context.runId, error: safeProviderFailure("codex", "startup") });
        terminateNativeProcessTree(child);
      }
    })();

    return {
      events,
      cancel: async () => {
        if (threadId !== null && turnId !== null) {
          try { await request("turn/interrupt", { threadId, turnId }); } catch { terminateNativeProcessTree(child); }
        } else {
          terminateNativeProcessTree(child);
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
