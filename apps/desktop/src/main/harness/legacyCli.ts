import { spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AsyncEventQueue } from "./eventQueue.js";
import { safeProviderFailure } from "./failureSafety.js";
import { nativeCliExecutable, nativeHarnessModel } from "./nativeCli.js";
import { codexAgentInstructions, loadAgentManifest, type SharedAgentDefinition } from "./agentManifest.js";
import { parseClaudeJsonResult, parseCodexJsonStream } from "../externalAdvisor.js";
import { McpBridge, type ToolCallResult, type ToolDispatcher, type ToolScope, type ToolSpec } from "../mcpBridge.js";
import type { Room, RoomManagerState } from "../roomManager.js";
import { createWorkspaceMcpBridge } from "../workspace/workspaceMcp.js";
import { normalizeRelativePath } from "../workspace/pathSafety.js";
import {
  spawnWithNativeWorkspaceSandbox,
  terminateNativeProcessTree,
  verifyNativeHarnessExecutable,
} from "./seatbelt.js";
import type { HarnessContext, HarnessEvent, HarnessInput, HarnessName, HarnessRun, HarnessRuntime } from "./types.js";

const TOOLS: ToolSpec[] = [
  ...["list", "read", "write", "edit", "delete", "glob", "grep"].map((operation): ToolSpec => ({
    name: `workspace_${operation}`,
    description: `${operation} normal files through Arcelle's restricted workspace service.`,
    inputSchema: { type: "object", additionalProperties: true },
  })),
  {
    name: "workspace_move",
    description: "Move or rename exactly one normal file to an exact destination path.",
    inputSchema: {
      type: "object",
      properties: {
        source_path: { type: "string", minLength: 1, description: "Existing path relative to the exposed workspace root." },
        destination_path: { type: "string", minLength: 1, description: "Exact destination path, including the file name, relative to the exposed workspace root." },
      },
      required: ["source_path", "destination_path"],
      additionalProperties: false,
    },
  },
  {
    name: "workspace_rename",
    description: "Rename exactly one normal file inside its current folder.",
    inputSchema: {
      type: "object",
      properties: {
        source_path: { type: "string", minLength: 1, description: "Existing path relative to the exposed workspace root." },
        new_name: { type: "string", minLength: 1, description: "New base file name only, with no slash or folder path." },
      },
      required: ["source_path", "new_name"],
      additionalProperties: false,
    },
  },
];

const WORKSPACE_MUTATIONS = new Set(["write", "edit", "delete", "move", "rename"]);
const STANDARD_MUTATION_TOOLS = new Set([
  "create_file", "write_file", "edit_file", "rename_file", "move_file", "trash_files",
  "standard_create", "standard_write", "standard_edit",
  "standard_rename", "standard_move", "standard_trash",
]);

function isWorkspaceMutation(name: string, operation: string): boolean {
  return WORKSPACE_MUTATIONS.has(operation) || STANDARD_MUTATION_TOOLS.has(name);
}

const DELEGATE_TOOL: ToolSpec = {
  name: "arcelle_delegate",
  description: "Run one Arcelle specialist as a child of this agent run. Read specialists may run in parallel; write specialists are serialized.",
  inputSchema: {
    type: "object",
    properties: {
      agent_id: { type: "string", description: "Specialist id from the Arcelle specialist catalog." },
      task: { type: "string", description: "A complete task for the specialist." },
    },
    required: ["agent_id", "task"],
    additionalProperties: false,
  },
};

export class AsyncWriteGate {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

export interface WorkspaceCalls {
  call(
    operation: string,
    args: Record<string, unknown>,
    redactedMirrorArgs?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

const CLOUD_REAL_METADATA_OPERATIONS = new Set([
  "standard_rename",
  "standard_move",
  "standard_trash",
]);

export interface CloudPrivacyWorkspaceOptions {
  /** Deep Agents use these exact tools for metadata-only binary organization. */
  routeExactMoveRenameToReal?: boolean;
}

function routesCloudOperationToReal(operation: string, options: CloudPrivacyWorkspaceOptions): boolean {
  return CLOUD_REAL_METADATA_OPERATIONS.has(operation)
    || (options.routeExactMoveRenameToReal === true && (operation === "move" || operation === "rename"));
}

function optionalMetadataField(payload: Record<string, unknown>, key: "old_path" | "path"): Record<string, unknown> {
  const value = payload[key];
  return typeof value === "string" ? { [key]: value } : {};
}

function cloudMetadataResult(operation: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (typeof payload.error === "string") {
    return { error: safeProviderFailure("provider", "tool") };
  }
  if (operation === "standard_trash") {
    const trashed = Array.isArray(payload.trashed)
      ? payload.trashed.filter((value): value is string => typeof value === "string")
      : [];
    return { trashed };
  }
  return { ...optionalMetadataField(payload, "old_path"), ...optionalMetadataField(payload, "path") };
}

async function callCloudPrivacyWorkspace(
  mirror: WorkspaceCalls,
  baselineGatedReal: WorkspaceCalls,
  options: CloudPrivacyWorkspaceOptions,
  operation: string,
  args: Record<string, unknown>,
  redactedMirrorArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!routesCloudOperationToReal(operation, options)) {
    return mirror.call(operation, redactedMirrorArgs);
  }
  return cloudMetadataResult(operation, await baselineGatedReal.call(operation, args));
}

/**
 * Cloud agents work on redacted mirror bytes. The three standard organization
 * tools may operate on the real WorkspaceService because they change only a
 * file's path/trash state and return metadata, never original content.
 *
 * The caller must supply a rollback-baseline-gated real backend. Exact
 * `workspace_*` operations stay on the mirror by default. Deep Agents may opt
 * exact move/rename into the metadata route for binary organization; their
 * read/write/edit operations still pass through mirror validation.
 */
export function createCloudPrivacyWorkspaceBackend(
  mirror: WorkspaceCalls,
  baselineGatedReal: WorkspaceCalls,
  options: CloudPrivacyWorkspaceOptions = {},
): WorkspaceCalls {
  return {
    async call(operation, args, redactedMirrorArgs = args) {
      return callCloudPrivacyWorkspace(mirror, baselineGatedReal, options, operation, args, redactedMirrorArgs);
    },
  };
}

function result(payload: Record<string, unknown>): ToolCallResult {
  const isError = typeof payload.error === "string";
  return { isError, content: [{ type: "text", text: JSON.stringify(payload) }] };
}

type DelegateCall = (agentId: string, task: string) => Promise<Record<string, unknown>>;

function delegateArguments(args: Record<string, unknown>): { agentId: string; task: string } {
  return {
    agentId: typeof args.agent_id === "string" ? args.agent_id.trim() : "",
    task: typeof args.task === "string" ? args.task.trim() : "",
  };
}

async function callDelegateTool(delegate: DelegateCall, args: Record<string, unknown>): Promise<ToolCallResult> {
  const { agentId, task } = delegateArguments(args);
  if (agentId === "" || task === "") return result({ error: "arcelle_delegate requires agent_id and task." });
  try {
    return result(await delegate(agentId, task));
  } catch {
    return result({ error: safeProviderFailure("provider", "tool") });
  }
}

async function callBaseTool(
  base: ToolDispatcher,
  scope: ToolScope,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    return await base.callTool(scope, name, args);
  } catch {
    return result({ error: safeProviderFailure("provider", "tool") });
  }
}

function dispatchBaseTool(
  base: ToolDispatcher,
  gate: AsyncWriteGate,
  scope: ToolScope,
  name: string,
  args: Record<string, unknown>,
  operation: string,
): Promise<ToolCallResult> {
  const call = () => callBaseTool(base, scope, name, args);
  return isWorkspaceMutation(name, operation) ? gate.run(call) : call();
}

async function dispatchWorkspaceTool(
  backend: WorkspaceCalls,
  gate: AsyncWriteGate,
  operation: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const call = () => backend.call(operation, args);
  const payload = isWorkspaceMutation(name, operation) ? await gate.run(call) : await call();
  return result(payload);
}

export class WorkspaceDispatcher implements ToolDispatcher {
  constructor(
    private readonly backend: WorkspaceCalls,
    private readonly writeGate: AsyncWriteGate,
    private readonly delegate?: (agentId: string, task: string) => Promise<Record<string, unknown>>,
    private readonly base?: ToolDispatcher,
  ) {}
  listTools(scope: ToolScope): ToolSpec[] {
    const tools = this.base?.listTools(scope) ?? TOOLS;
    return this.delegate === undefined ? tools : [...tools, DELEGATE_TOOL];
  }
  async callTool(scope: ToolScope, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    if (name === DELEGATE_TOOL.name && this.delegate !== undefined) {
      return callDelegateTool(this.delegate, args);
    }
    const operation = name.startsWith("workspace_") ? name.slice("workspace_".length) : "";
    if (this.base !== undefined) {
      return dispatchBaseTool(this.base, this.writeGate, scope, name, args, operation);
    }
    if (!TOOLS.some((tool) => tool.name === name)) return result({ error: `unknown tool: ${name}` });
    return dispatchWorkspaceTool(this.backend, this.writeGate, operation, name, args);
  }
}
export { createMirrorWorkspaceBackend } from "./legacyCliMirror.js";

export { RestrictedLegacyCliRuntime, RuntimeWithFallback } from "./legacyCliRuntime.js";
export type { LegacyCliRuntimeOptions } from "./legacyCliRuntime.js";


export { DelegateCall };
