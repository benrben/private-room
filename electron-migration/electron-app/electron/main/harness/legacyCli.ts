import { spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AsyncEventQueue } from "./eventQueue.js";
import { codexAgentInstructions } from "./agentManifest.js";
import { parseClaudeJsonResult, parseCodexJsonStream } from "../externalAdvisor.js";
import { McpBridge, type ToolCallResult, type ToolDispatcher, type ToolScope, type ToolSpec } from "../mcpBridge.js";
import type { RoomManagerState } from "../roomManager.js";
import { createWorkspaceMcpBridge } from "../workspace/workspaceMcp.js";
import { normalizeRelativePath } from "../workspace/pathSafety.js";
import {
  spawnWithNativeWorkspaceSandbox,
  terminateNativeProcessTree,
  verifyNativeHarnessExecutable,
} from "./seatbelt.js";
import type { HarnessContext, HarnessInput, HarnessRun, HarnessRuntime } from "./types.js";

const TOOLS: ToolSpec[] = ["list", "read", "write", "edit", "delete", "glob", "grep"].map((operation) => ({
  name: `workspace_${operation}`,
  description: `${operation} normal files through Arcelle's restricted workspace service.`,
  inputSchema: { type: "object", additionalProperties: true },
}));

interface WorkspaceCalls {
  call(operation: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}
function result(payload: Record<string, unknown>): ToolCallResult {
  const isError = typeof payload.error === "string";
  return { isError, content: [{ type: "text", text: JSON.stringify(payload) }] };
}

class WorkspaceDispatcher implements ToolDispatcher {
  constructor(private readonly backend: WorkspaceCalls) {}
  listTools(_scope: ToolScope): ToolSpec[] { return TOOLS; }
  async callTool(_scope: ToolScope, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const operation = name.startsWith("workspace_") ? name.slice("workspace_".length) : "";
    if (!TOOLS.some((tool) => tool.name === name)) return result({ error: `unknown tool: ${name}` });
    return result(await this.backend.call(operation, args));
  }
}

async function assertNoSymlinkParents(root: string, relative: string): Promise<void> {
  const parts = relative.split("/").slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("Workspace symlinks are not exposed to agents.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function relativeArg(value: unknown): string {
  const raw = typeof value === "string" ? value.replace(/^\/+/, "") : "";
  return normalizeRelativePath(raw);
}

function globRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

/** Filesystem projection used only for a redacted runtime mirror. */
function mirrorBackend(root: string, writeEnabled: boolean): WorkspaceCalls {
  const absolute = async (value: unknown): Promise<{ relative: string; absolute: string }> => {
    const relative = relativeArg(value);
    await assertNoSymlinkParents(root, relative);
    const candidate = path.join(root, relative);
    try {
      if ((await lstat(candidate)).isSymbolicLink()) throw new Error("Workspace symlinks are not exposed to agents.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { relative, absolute: candidate };
  };
  const files = async (): Promise<string[]> => {
    const found: string[] = [];
    const walk = async (directory: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (prefix === "" && entry.name.toLocaleLowerCase("en-US") === ".arcelle") continue;
        const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
        else if (entry.isFile()) found.push(relative);
      }
    };
    await walk(root, "");
    return found;
  };
  const writable = (): void => {
    if (!writeEnabled) throw new Error("This harness run is read-only.");
  };
  return {
    async call(operation, args) {
      try {
        if (operation === "list") {
          const prefix = typeof args.path === "string" ? args.path.replace(/^\/+|\/+$/g, "") : "";
          return { entries: (await files()).filter((file) => prefix === "" || file.startsWith(`${prefix}/`) || file === prefix).map((file) => ({ path: `/${file}`, is_dir: false })) };
        }
        if (operation === "glob") {
          const pattern = typeof args.pattern === "string" ? args.pattern.replace(/^\/+/, "") : "**/*";
          const matcher = globRegex(pattern);
          return { matches: (await files()).filter((file) => matcher.test(file)).map((file) => `/${file}`) };
        }
        if (operation === "grep") {
          const pattern = String(args.pattern ?? "");
          const matches: Array<{ path: string; line: number; text: string }> = [];
          for (const file of await files()) {
            const text = await readFile(path.join(root, file), "utf8").catch(() => null);
            if (text === null) continue;
            text.split(/\r?\n/).forEach((line, index) => {
              if (line.includes(pattern)) matches.push({ path: `/${file}`, line: index + 1, text: line });
            });
          }
          return { matches };
        }
        const requested = await absolute(args.path ?? args.name);
        if (operation === "read") {
          const text = await readFile(requested.absolute, "utf8");
          const lines = text.split(/\r?\n/);
          const start = Math.max(1, Number(args.start_line ?? 1));
          const end = Math.min(lines.length, Number(args.end_line ?? lines.length));
          return { path: `/${requested.relative}`, content: lines.slice(start - 1, end).join("\n"), start_line: start, end_line: end };
        }
        writable();
        if (operation === "delete") {
          await rm(requested.absolute, { force: false });
          return { path: `/${requested.relative}`, deleted: true };
        }
        let content = String(args.content ?? "");
        if (operation === "edit") {
          const current = await readFile(requested.absolute, "utf8");
          const oldText = String(args.old_string ?? args.old_text ?? "");
          const newText = String(args.new_string ?? args.new_text ?? "");
          const count = oldText === "" ? 0 : current.split(oldText).length - 1;
          if (count === 0) return { error: "The old text was not found." };
          if (count > 1 && args.all !== true) return { error: "The old text is not unique." };
          content = args.all === true ? current.split(oldText).join(newText) : current.replace(oldText, newText);
        } else if (operation !== "write") {
          return { error: `Unknown workspace operation: ${operation}` };
        }
        await mkdir(path.dirname(requested.absolute), { recursive: true });
        const temporary = path.join(path.dirname(requested.absolute), `.${path.basename(requested.absolute)}.arcelle-${randomUUID()}.tmp`);
        await writeFile(temporary, content, { mode: 0o600 });
        await rename(temporary, requested.absolute);
        return { path: `/${requested.relative}` };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

export interface LegacyCliRuntimeOptions {
  executable?: string;
  spawn?: typeof spawnWithNativeWorkspaceSandbox;
  available?: () => boolean;
}

/**
 * Last-resort CLI harness. It never gives the CLI the real workspace path:
 * the process sees an empty sandbox and can touch room files only through the
 * scoped loopback MCP bridge.
 */
export class RestrictedLegacyCliRuntime implements HarnessRuntime {
  readonly name = "legacy-cli" as const;
  private readonly executable: string;
  private readonly spawn: typeof spawnWithNativeWorkspaceSandbox;
  private readonly availableProbe: () => boolean;

  constructor(
    private readonly provider: "codex" | "claude",
    private readonly state: RoomManagerState,
    options: LegacyCliRuntimeOptions = {},
  ) {
    this.executable = options.executable ?? (provider === "codex"
      ? process.env.ARCELLE_CODEX_PATH ?? "codex"
      : process.env.ARCELLE_CLAUDE_PATH ?? "claude");
    this.spawn = options.spawn ?? spawnWithNativeWorkspaceSandbox;
    this.availableProbe = options.available ?? (() => spawnSync(this.executable, ["--version"], { stdio: "ignore", timeout: 5_000 }).status === 0);
  }

  async available(): Promise<boolean> { return this.availableProbe(); }

  async verifyExposure(_workspacePath: string, runtimePath: string): Promise<boolean> {
    const isolated = path.join(runtimePath, "legacy-cli-probe");
    await mkdir(path.join(isolated, ".arcelle"), { recursive: true, mode: 0o700 });
    return verifyNativeHarnessExecutable({
      workspacePath: isolated,
      runtimePath: isolated,
      executable: this.executable,
      provider: this.provider,
      writeEnabled: false,
    }, ["--version"]);
  }

  async startTurn(context: HarnessContext, input: HarnessInput): Promise<HarnessRun> {
    if (!context.exposureVerified) throw new Error("Restricted CLI fallback refused an unverified runtime exposure.");
    const room = this.state.room;
    if (room?.workspace === undefined || room.descriptor?.kind !== "workspace-folder") {
      throw new Error("Restricted CLI fallback requires an unlocked workspace room.");
    }
    const isolated = path.join(context.runtimePath, "legacy-cli-workspace");
    await mkdir(path.join(isolated, ".arcelle"), { recursive: true, mode: 0o700 });
    const realRoot = room.descriptor.rootPath;
    const isRealWorkspace = realRoot !== null && path.resolve(context.workspacePath) === path.resolve(realRoot);
    const backend = isRealWorkspace
      ? createWorkspaceMcpBridge(this.state, context.writeEnabled)
      : mirrorBackend(context.workspacePath, context.writeEnabled);
    const token = randomUUID();
    const bridge = new McpBridge({ token, scope: { kind: "ExternalAgent" }, dispatcher: new WorkspaceDispatcher(backend) });
    await bridge.listen(0);
    const configPath = path.join(isolated, "mcp-room.json");
    await writeFile(configPath, JSON.stringify({ mcpServers: { room: { type: "http", url: bridge.url, headers: { Authorization: `Bearer ${token}` } } } }), { mode: 0o600 });
    const prompt = [context.systemPrompt, codexAgentInstructions(), input.text].filter(Boolean).join("\n\n");
    const env = { ...process.env, ARCELLE_ROOM_MCP_TOKEN: token };
    const args = this.provider === "claude"
      ? ["-p", "--output-format", "json", "--mcp-config", configPath, "--strict-mcp-config", "--tools", "", "--allowedTools", "mcp__room__*", ...(context.model ? ["--model", context.model] : [])]
      : ["exec", "--json", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "-c", "approval_policy=\"never\"", "--disable", "shell_tool", "--disable", "unified_exec", "-c", "web_search=\"disabled\"", "-c", `mcp_servers.room.url=\"${bridge.url}\"`, "-c", "mcp_servers.room.bearer_token_env_var=\"ARCELLE_ROOM_MCP_TOKEN\"", ...(context.model ? ["--model", context.model] : []), "-"];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawn({
        workspacePath: isolated,
        runtimePath: context.runtimePath,
        executable: this.executable,
        provider: this.provider,
        writeEnabled: false,
        env,
      }, args, { cwd: isolated, env });
    } catch (error) {
      await bridge.stop();
      throw error;
    }
    const events = new AsyncEventQueue<import("./types.js").HarnessEvent>();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let terminal = false;
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once("exit", (code, signal) => {
      void (async () => {
        try {
          if (terminal) return;
          terminal = true;
          if (signal !== null) {
            events.push({ type: "run_completed", runId: context.runId, status: "cancelled" });
          } else if (code !== 0) {
            events.push({ type: "run_failed", runId: context.runId, error: Buffer.concat(stderr).toString("utf8").trim() || `${this.provider} fallback exited with code ${String(code)}.` });
          } else {
            const parsed = this.provider === "claude" ? parseClaudeJsonResult(Buffer.concat(stdout)) : parseCodexJsonStream(Buffer.concat(stdout));
            if (parsed.text !== "") events.push({ type: "text_delta", runId: context.runId, text: parsed.text });
            events.push({ type: "usage_updated", runId: context.runId, inputTokens: parsed.usage.inputTokens ?? undefined, outputTokens: parsed.usage.outputTokens ?? undefined });
            events.push({ type: "agent_completed", runId: context.runId, agentId: "coordinator" });
            events.push({ type: "run_completed", runId: context.runId, status: "completed" });
          }
        } finally {
          await bridge.stop();
          events.end();
        }
      })();
    });
    events.push({ type: "run_started", runId: context.runId, harness: this.name });
    events.push({ type: "agent_started", runId: context.runId, agentId: "coordinator", label: `${this.provider} restricted CLI` });
    child.stdin.end(prompt, "utf8");
    return {
      events,
      cancel: async () => { terminateNativeProcessTree(child); },
      approve: async () => { throw new Error("Restricted CLI fallback does not request provider approvals."); },
    };
  }
}

/** Select rich structured mode when available, otherwise the restricted CLI. */
export class RuntimeWithFallback implements HarnessRuntime {
  readonly name;
  constructor(private readonly primary: HarnessRuntime, private readonly fallback: HarnessRuntime) {
    this.name = primary.name;
  }
  async available(): Promise<boolean> { return (await this.primary.available()) || this.fallback.available(); }
  async verifyExposure(workspacePath: string, runtimePath: string, writeEnabled: boolean): Promise<boolean> {
    const selected = await this.primary.available() ? this.primary : this.fallback;
    return selected.verifyExposure?.(workspacePath, runtimePath, writeEnabled) ?? false;
  }
  async startTurn(context: HarnessContext, input: HarnessInput): Promise<HarnessRun> {
    return (await this.primary.available() ? this.primary : this.fallback).startTurn(context, input);
  }
}
