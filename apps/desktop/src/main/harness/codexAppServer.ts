import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import readline from "node:readline";
import { AsyncEventQueue } from "./eventQueue.js";
import { codexAgentInstructions } from "./agentManifest.js";
import { inspectCodexSchemaDirectory, type CodexSchemaCompatibility } from "./codexSchema.js";
import {
  approvalResult,
  createAppServerLineHandler,
  mcpApprovalResult,
  nestedString,
  permissionApprovalResult,
  record,
  type ApprovalRequest,
  type PendingRpc,
  type RpcMessage,
} from "./codexAppServerRpc.js";
import { safeProviderFailure } from "./failureSafety.js";
import { nativeCliExecutable, nativeHarnessModel } from "./nativeCli.js";
import {
  NATIVE_ROOM_MCP_TOKEN_ENV,
  type NativeRoomMcpExposure,
  type NativeRoomMcpFactory,
} from "./nativeRoomMcp.js";
import {
  spawnWithNativeWorkspaceSandbox,
  terminateNativeProcessTree,
  type NativeWorkspaceSandbox,
} from "./seatbelt.js";
import type {
  HarnessContext,
  HarnessEvent,
  HarnessInput,
  HarnessRun,
  HarnessRuntime,
} from "./types.js";

export { mcpApprovalResult, permissionApprovalResult, safeToolError } from "./codexAppServerRpc.js";

const execFileAsync = promisify(execFile);
type SandboxSpawn = typeof spawnWithNativeWorkspaceSandbox;

const CODEX_RUNTIME_HOME = "codex-home";
const CODEX_BOOTSTRAP_FILES = ["auth.json", "config.toml"] as const;

function sourceCodexHome(): string {
  return path.resolve(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
}

/**
 * Give Codex mutable state without granting it write access to the user's
 * real `~/.codex`. Codex 0.144.5 opens SQLite state during app-server startup,
 * before a turn exists, so a read-only real home cannot initialize.
 *
 * Only authentication and configuration cross into the private run tree.
 * History, memories, queues and previous thread state remain outside the
 * sandbox. The controller already removes the complete runtime tree after the
 * probe/run, including this copy.
 */
export async function prepareCodexRuntimeHome(
  runtimePath: string,
  sourceHome = sourceCodexHome(),
): Promise<string> {
  const runtimeHome = path.resolve(runtimePath, CODEX_RUNTIME_HOME);
  await mkdir(runtimeHome, { recursive: true, mode: 0o700 });
  await chmod(runtimeHome, 0o700);
  for (const name of CODEX_BOOTSTRAP_FILES) {
    const source = path.resolve(sourceHome, name);
    const destination = path.join(runtimeHome, name);
    if (source === destination) continue;
    try {
      await copyFile(source, destination);
      await chmod(destination, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // API-key and managed installations may not use one or both files.
    }
  }
  // macOS temp locations commonly enter through /var but Seatbelt grants the
  // canonical /private/var path. Passing the canonical home keeps the runtime
  // environment and the generated profile aligned.
  return realpath(runtimeHome);
}

function codexRunEnvironment(codexHome: string, roomMcp?: NativeRoomMcpExposure): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CODEX_HOME: codexHome,
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "arcelle",
    ...(roomMcp === undefined ? {} : { [NATIVE_ROOM_MCP_TOKEN_ENV]: roomMcp.token }),
  };
}

type AppServerRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;

interface AppServerTurnReferences {
  threadId: string | null;
  turnId: string | null;
}

interface AppServerTurnStartup {
  context: HarnessContext;
  input: HarnessInput;
  roomMcp: NativeRoomMcpExposure | undefined;
  request: AppServerRequest;
  send(message: RpcMessage): void;
  events: AsyncEventQueue<HarnessEvent>;
  references: AppServerTurnReferences;
  fail(): void;
}

function appServerDeveloperInstructions(context: HarnessContext, roomMcp: NativeRoomMcpExposure | undefined): string {
  return [context.systemPrompt, roomMcp?.instructions, codexAgentInstructions()]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n\n");
}

function appServerThreadStartParams(
  context: HarnessContext,
  developerInstructions: string,
  roomMcp: NativeRoomMcpExposure | undefined,
): Record<string, unknown> {
  return {
    model: nativeHarnessModel(context.model),
    cwd: context.workspacePath,
    developerInstructions,
    config: roomMcp === undefined ? undefined : codexRoomMcpConfiguration(roomMcp),
    approvalPolicy: "on-request",
    sandbox: context.writeEnabled ? "workspace-write" : "read-only",
    ephemeral: true,
  };
}

function appServerThreadResumeParams(
  context: HarnessContext,
  input: HarnessInput,
  developerInstructions: string,
  roomMcp: NativeRoomMcpExposure | undefined,
): Record<string, unknown> {
  return {
    threadId: input.threadId,
    cwd: context.workspacePath,
    developerInstructions,
    config: roomMcp === undefined ? undefined : codexRoomMcpConfiguration(roomMcp),
  };
}

function startOrResumeAppServerThread(
  request: AppServerRequest,
  context: HarnessContext,
  input: HarnessInput,
  developerInstructions: string,
  roomMcp: NativeRoomMcpExposure | undefined,
): Promise<unknown> {
  if (input.threadId === undefined) {
    return request("thread/start", appServerThreadStartParams(context, developerInstructions, roomMcp));
  }
  return request("thread/resume", appServerThreadResumeParams(context, input, developerInstructions, roomMcp));
}

function appServerTurnSandboxPolicy(context: HarnessContext): Record<string, unknown> {
  if (context.writeEnabled) {
    return { type: "workspaceWrite", writableRoots: [context.workspacePath], networkAccess: false };
  }
  return { type: "readOnly" };
}

function appServerTurnStartParams(context: HarnessContext, input: HarnessInput, threadId: string): Record<string, unknown> {
  return {
    threadId,
    input: [{ type: "text", text: input.text }],
    cwd: context.workspacePath,
    approvalPolicy: "on-request",
    sandboxPolicy: appServerTurnSandboxPolicy(context),
  };
}

async function startAppServerTurn(startup: AppServerTurnStartup): Promise<void> {
  const { context, input, roomMcp, request, send, events, references } = startup;
  events.push({ type: "run_started", runId: context.runId, harness: "codex-app-server" });
  try {
    await request("initialize", {
      clientInfo: { name: "arcelle", title: "Arcelle", version: "0.25.0" },
      capabilities: { experimentalApi: false },
    });
    send({ method: "initialized", params: {} });
    // Codex app-server has a dedicated developer-instruction channel on
    // thread creation/resume. Keep Arcelle policy out of the user turn so
    // the model cannot confuse trusted harness policy with task content.
    const developerInstructions = appServerDeveloperInstructions(context, roomMcp);
    const threadResponse = await startOrResumeAppServerThread(
      request,
      context,
      input,
      developerInstructions,
      roomMcp,
    );
    references.threadId = nestedString(threadResponse, "thread", "id");
    if (references.threadId === null) throw new Error("Codex did not return a thread id.");
    events.push({ type: "agent_started", runId: context.runId, agentId: "coordinator", label: "Codex" });
    const turnResponse = await request("turn/start", appServerTurnStartParams(context, input, references.threadId));
    references.turnId = nestedString(turnResponse, "turn", "id");
  } catch {
    startup.fail();
  }
}

type ExposureProbeChild = ReturnType<SandboxSpawn>;

interface ExposureProbe {
  child: ExposureProbeChild;
  lines: readline.Interface;
  lifecycle: Promise<void>;
  initialized(): boolean;
  exited(): boolean;
}

function createExposureProbe(child: ExposureProbeChild): ExposureProbe {
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
  return {
    child,
    lines,
    lifecycle,
    initialized: () => ready,
    exited: () => exited,
  };
}

async function waitForExposureProbe(probe: ExposureProbe, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    probe.lifecycle,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

async function initializeExposureProbe(probe: ExposureProbe, timeoutMs: number): Promise<boolean> {
  try {
    probe.child.stdin.write(`${JSON.stringify({
      id: "arcelle-capability",
      method: "initialize",
      params: {
        clientInfo: { name: "arcelle-capability", title: "Arcelle", version: "0.25.0" },
        capabilities: { experimentalApi: false },
      },
    })}\n`);
    await waitForExposureProbe(probe, timeoutMs);
    return probe.initialized();
  } catch {
    return false;
  }
}

async function closeExposureProbe(probe: ExposureProbe): Promise<void> {
  probe.lines.close();
  if (!probe.exited()) terminateNativeProcessTree(probe.child, "SIGTERM", 250);
  if (!probe.exited()) await waitForExposureProbe(probe, 1_000);
  if (!probe.exited()) terminateNativeProcessTree(probe.child, "SIGKILL", -1);
  probe.child.stdin.destroy();
  probe.child.stdout.destroy();
  probe.child.stderr.destroy();
}

export class CodexAppServerRuntime implements HarnessRuntime {
  readonly name = "codex-app-server" as const;
  private compatibility: CodexSchemaCompatibility | null = null;
  constructor(
    private readonly executable = nativeCliExecutable("codex"),
    private readonly sandboxSpawn: SandboxSpawn = spawnWithNativeWorkspaceSandbox,
    private readonly startupProbeTimeoutMs = 5_000,
    private readonly codexHomeSource = sourceCodexHome(),
    private readonly roomMcpFactory?: NativeRoomMcpFactory,
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

  private async spawnExposureProbe(
    options: NativeWorkspaceSandbox,
    workspacePath: string,
    runtimePath: string,
  ): Promise<ExposureProbeChild | null> {
    try {
      const codexHome = await prepareCodexRuntimeHome(runtimePath, this.codexHomeSource);
      return this.sandboxSpawn(
        options,
        ["app-server", "--listen", "stdio://"],
        {
          cwd: workspacePath,
          env: codexRunEnvironment(codexHome),
        },
      );
    } catch {
      return null;
    }
  }

  async verifyExposure(workspacePath: string, runtimePath: string, writeEnabled: boolean): Promise<boolean> {
    const options: NativeWorkspaceSandbox = {
      workspacePath,
      runtimePath,
      executable: this.executable,
      provider: "codex",
      writeEnabled,
    };
    const child = await this.spawnExposureProbe(options, workspacePath, runtimePath);
    if (child === null) return false;

    // The help command only proves the executable can be loaded. Newer Codex
    // releases initialize config and SQLite after app-server startup, so the
    // real capability boundary is a successful JSON-RPC initialize response
    // under this exact Seatbelt profile. Drain but never retain stderr: it may
    // contain provider paths, credentials, or room-derived diagnostics.
    const probe = createExposureProbe(child);
    try {
      return await initializeExposureProbe(probe, this.startupProbeTimeoutMs);
    } finally {
      await closeExposureProbe(probe);
    }
  }

  async startTurn(context: HarnessContext, input: HarnessInput): Promise<HarnessRun> {
    if (!context.exposureVerified) {
      throw new Error("Codex native harness refused an unverified workspace exposure.");
    }
    const events = new AsyncEventQueue<HarnessEvent>();
    const roomMcp = await this.roomMcpFactory?.(context);
    let child;
    try {
      const codexHome = await prepareCodexRuntimeHome(context.runtimePath, this.codexHomeSource);
      const env = codexRunEnvironment(codexHome, roomMcp);
      child = this.sandboxSpawn(
        {
          workspacePath: context.workspacePath,
          runtimePath: context.runtimePath,
          executable: this.executable,
          provider: "codex",
          writeEnabled: context.writeEnabled,
          env,
        },
        ["app-server", "--listen", "stdio://"],
        { cwd: context.workspacePath, env },
      );
    } catch (error) {
      await roomMcp?.stop();
      throw error;
    }
    const pendingRpc = new Map<number | string, PendingRpc>();
    const approvalRequests = new Map<string, ApprovalRequest>();
    let nextId = 1;
    const references: AppServerTurnReferences = { threadId: null, turnId: null };
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
    lines.on("line", createAppServerLineHandler({
      runId: context.runId,
      events,
      pendingRpc,
      approvalRequests,
      respond,
      markTerminal: () => { terminal = true; },
      endInput: () => child.stdin.end(),
    }));

    child.once("exit", (code) => {
      void (async () => {
        for (const pending of pendingRpc.values()) pending.reject(new Error("Codex app-server exited."));
        pendingRpc.clear();
        if (!terminal) {
          events.push({
            type: "run_failed",
            runId: context.runId,
            error: safeProviderFailure("codex", "run", code),
          });
        }
        await roomMcp?.stop();
        events.end();
      })();
    });

    void startAppServerTurn({
      context,
      input,
      roomMcp,
      request,
      send,
      events,
      references,
      fail: () => {
        terminal = true;
        events.push({ type: "run_failed", runId: context.runId, error: safeProviderFailure("codex", "startup") });
        terminateNativeProcessTree(child);
      },
    });

    return {
      events,
      cancel: async () => {
        await roomMcp?.stop();
        if (references.threadId !== null && references.turnId !== null) {
          try {
            await request("turn/interrupt", { threadId: references.threadId, turnId: references.turnId });
          } catch {
            terminateNativeProcessTree(child);
          }
        } else {
          terminateNativeProcessTree(child);
        }
      },
      approve: async (requestId, decision) => {
        const pending = approvalRequests.get(requestId);
        if (pending === undefined) throw new Error("That approval request is no longer active.");
        approvalRequests.delete(requestId);
        respond(
          pending.rpcId,
          pending.kind === "permissions"
            ? permissionApprovalResult(pending.permissions ?? {}, decision)
            : pending.kind === "mcp"
              ? mcpApprovalResult(decision, pending.sessionPersistAllowed === true)
              : approvalResult(decision),
        );
      },
    };
  }
}

/** App-server thread config keeps the bearer out of JSON-RPC and process args. */
export function codexRoomMcpConfiguration(exposure: NativeRoomMcpExposure): {
  mcp_servers: {
    room: {
      url: string;
      bearer_token_env_var: typeof NATIVE_ROOM_MCP_TOKEN_ENV;
      default_tools_approval_mode: "approve";
    };
  };
} {
  return {
    mcp_servers: {
      room: {
        url: exposure.url,
        bearer_token_env_var: NATIVE_ROOM_MCP_TOKEN_ENV,
        // The app-server otherwise routes every MCP call through its generic
        // user-input flow. Headless rich clients cannot answer that flow, so
        // Codex cancels the call before it reaches Arcelle. This server is
        // per-run, bearer protected, baseline gated, and still confined by
        // the native workspace sandbox and Arcelle's own tool policies.
        default_tools_approval_mode: "approve",
      },
    },
  };
}
