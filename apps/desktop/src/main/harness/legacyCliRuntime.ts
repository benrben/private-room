import { spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AsyncEventQueue } from "./eventQueue.js";
import { safeProviderFailure } from "./failureSafety.js";
import { nativeCliExecutable, nativeHarnessModel } from "./nativeCli.js";
import { codexAgentInstructions, loadAgentManifest, type SharedAgentDefinition } from "./agentManifest.js";
import { parseClaudeJsonResult, parseCodexJsonStream } from "../externalAdvisor.js";
import { McpBridge, type ToolDispatcher } from "../mcpBridge.js";
import type { Room, RoomManagerState } from "../roomManager.js";
import { createWorkspaceMcpBridge } from "../workspace/workspaceMcp.js";
import { spawnWithNativeWorkspaceSandbox, terminateNativeProcessTree, verifyNativeHarnessExecutable } from "./seatbelt.js";
import type { HarnessContext, HarnessEvent, HarnessInput, HarnessName, HarnessRun, HarnessRuntime } from "./types.js";
import { AsyncWriteGate, DelegateCall, WorkspaceCalls, WorkspaceDispatcher, createCloudPrivacyWorkspaceBackend, createMirrorWorkspaceBackend } from "./legacyCli.js";



export interface LegacyCliRuntimeOptions {
  executable?: string;
  spawn?: typeof spawnWithNativeWorkspaceSandbox;
  available?: () => boolean;
  /** Internal shared gates used by delegated children of one parent run. */
  writeGate?: AsyncWriteGate;
  specialistGate?: AsyncWriteGate;
  /** Full Arcelle MCP catalog, while the CLI still sees no real filesystem. */
  baseDispatcher?: (context: HarnessContext, workspace: WorkspaceCalls) => ToolDispatcher;
}
export type WorkspaceRoom = Room & {
  workspace: NonNullable<Room["workspace"]>;
  descriptor: NonNullable<Room["descriptor"]> & { kind: "workspace-folder"; rootPath: string };
};
export type BaselineRecord = {
  baseline_completed: number;
  status: string;
  write_enabled: number;
};
export interface LegacyDelegationState {
  parentCancelled: boolean;
}
export function requireLegacyWorkspaceRoom(state: RoomManagerState, context: HarnessContext): WorkspaceRoom {
  if (!context.exposureVerified) {
    throw new Error("Restricted CLI fallback refused an unverified runtime exposure.");
  }
  const room = state.room;
  if (room?.workspace === undefined || room.descriptor?.kind !== "workspace-folder") {
    throw new Error("Restricted CLI fallback requires an unlocked workspace room.");
  }
  return room as WorkspaceRoom;
}
export function isRealLegacyWorkspace(room: WorkspaceRoom, context: HarnessContext): boolean {
  return path.resolve(context.workspacePath) === path.resolve(room.descriptor.rootPath);
}
export function cloudPrivacyBaseline(room: WorkspaceRoom, context: HarnessContext): BaselineRecord | undefined {
  const baselineRunId = context.baselineRunId ?? context.runId;
  return room.conn.prepare(
    `SELECT baseline_completed, status, write_enabled
     FROM agent_runs WHERE run_id = ? AND room_id = ?`,
  ).get(baselineRunId, context.roomId) as BaselineRecord | undefined;
}
export function validCloudPrivacyBaseline(room: WorkspaceRoom, baseline: BaselineRecord | undefined): boolean {
  return room.readOnly !== true
    && baseline !== undefined
    && baseline.baseline_completed === 1
    && baseline.status === "running"
    && baseline.write_enabled === 1;
}
export function assertCloudPrivacyBackend(room: WorkspaceRoom, context: HarnessContext): void {
  if (room.descriptor.roomId !== context.roomId) {
    throw new Error("The restricted Cloud Privacy bridge requires the matching room.");
  }
  if (context.writeEnabled && !validCloudPrivacyBaseline(room, cloudPrivacyBaseline(room, context))) {
    throw new Error("The Cloud Privacy organization bridge cannot start before its rollback baseline is complete.");
  }
}
export function legacyWorkspaceBackend(
  state: RoomManagerState,
  room: WorkspaceRoom,
  context: HarnessContext,
): WorkspaceCalls {
  if (isRealLegacyWorkspace(room, context)) {
    return createWorkspaceMcpBridge(state, context.writeEnabled);
  }
  const mirror = createMirrorWorkspaceBackend(context.workspacePath, context.writeEnabled);
  if (context.privacyMode !== "cloud-redacted") return mirror;
  assertCloudPrivacyBackend(room, context);
  return createCloudPrivacyWorkspaceBackend(mirror, createWorkspaceMcpBridge(state, context.writeEnabled));
}
export async function legacyIsolatedWorkspace(context: HarnessContext): Promise<string> {
  const isolated = path.join(context.runtimePath, "legacy-cli-workspace");
  await mkdir(path.join(isolated, ".arcelle"), { recursive: true, mode: 0o700 });
  return isolated;
}
export function legacyPrompt(context: HarnessContext, input: HarnessInput): string {
  return [context.systemPrompt, codexAgentInstructions(), input.text].filter(Boolean).join("\n\n");
}
export function selectedModelArgs(model: string | undefined): string[] {
  return model === undefined ? [] : ["--model", model];
}
export function claudeLegacyArgs(configPath: string, model: string | undefined): string[] {
  return [
    "-p", "--output-format", "json", "--mcp-config", configPath, "--strict-mcp-config", "--tools", "",
    "--allowedTools", "mcp__room__*", ...selectedModelArgs(model),
  ];
}
export function codexLegacyArgs(bridge: McpBridge, model: string | undefined): string[] {
  return [
    "exec", "--json", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only",
    "-c", "approval_policy=\"never\"", "--disable", "shell_tool", "--disable", "unified_exec", "-c",
    "web_search=\"disabled\"", "-c", `mcp_servers.room.url=\"${bridge.url}\"`, "-c",
    "mcp_servers.room.bearer_token_env_var=\"ARCELLE_ROOM_MCP_TOKEN\"", ...selectedModelArgs(model), "-",
  ];
}
export function legacyCliArgs(provider: "codex" | "claude", configPath: string, bridge: McpBridge, model: string): string[] {
  const selectedModel = nativeHarnessModel(model);
  return provider === "claude"
    ? claudeLegacyArgs(configPath, selectedModel)
    : codexLegacyArgs(bridge, selectedModel);
}
export async function createLegacyBridge(
  token: string,
  backend: WorkspaceCalls,
  gate: AsyncWriteGate,
  delegate: DelegateCall | undefined,
  base: ToolDispatcher | undefined,
): Promise<McpBridge> {
  const bridge = new McpBridge({
    token,
    scope: { kind: "CloudEngine" },
    dispatcher: new WorkspaceDispatcher(backend, gate, delegate, base),
  });
  await bridge.listen(0);
  return bridge;
}
export async function writeLegacyMcpConfig(isolated: string, bridge: McpBridge, token: string): Promise<string> {
  const configPath = path.join(isolated, "mcp-room.json");
  const config = { mcpServers: { room: { type: "http", url: bridge.url, headers: { Authorization: `Bearer ${token}` } } } };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  return configPath;
}
export function cliExitEvents(
  provider: "codex" | "claude",
  runId: string,
  stdout: readonly Buffer[],
  code: number | null,
  signal: NodeJS.Signals | null,
): HarnessEvent[] {
  if (signal !== null) return [{ type: "run_completed", runId, status: "cancelled" }];
  if (code !== 0) return [{ type: "run_failed", runId, error: safeProviderFailure(provider, "run", code) }];
  return successfulCliExitEvents(provider, runId, stdout);
}
export function successfulCliExitEvents(
  provider: "codex" | "claude",
  runId: string,
  stdout: readonly Buffer[],
): HarnessEvent[] {
  const parsed = provider === "claude" ? parseClaudeJsonResult(Buffer.concat(stdout)) : parseCodexJsonStream(Buffer.concat(stdout));
  const events: HarnessEvent[] = [];
  if (parsed.text !== "") events.push({ type: "text_delta", runId, text: parsed.text });
  events.push({ type: "usage_updated", runId, inputTokens: parsed.usage.inputTokens ?? undefined, outputTokens: parsed.usage.outputTokens ?? undefined });
  events.push({ type: "agent_completed", runId, agentId: "coordinator" });
  events.push({ type: "run_completed", runId, status: "completed" });
  return events;
}
export async function completeLegacyCliRun(
  state: { terminal: boolean },
  provider: "codex" | "claude",
  bridge: McpBridge,
  events: AsyncEventQueue<HarnessEvent>,
  context: HarnessContext,
  stdout: readonly Buffer[],
  code: number | null,
  signal: NodeJS.Signals | null,
): Promise<void> {
  try {
    if (state.terminal) return;
    state.terminal = true;
    for (const event of cliExitEvents(provider, context.runId, stdout, code, signal)) events.push(event);
  } finally {
    await bridge.stop();
    events.end();
  }
}
export function attachLegacyCliLifecycle(
  child: ChildProcessWithoutNullStreams,
  provider: "codex" | "claude",
  bridge: McpBridge,
  events: AsyncEventQueue<HarnessEvent>,
  context: HarnessContext,
): void {
  const stdout: Buffer[] = [];
  const state = { terminal: false };
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", () => undefined);
  child.once("exit", (code, signal) => {
    void completeLegacyCliRun(state, provider, bridge, events, context, stdout, code, signal);
  });
}
export function legacyHarnessRun(
  events: AsyncEventQueue<HarnessEvent>,
  child: ChildProcessWithoutNullStreams,
  activeChildren: Set<HarnessRun>,
  delegation: LegacyDelegationState,
): HarnessRun {
  return {
    events,
    cancel: async () => {
      delegation.parentCancelled = true;
      await Promise.allSettled([...activeChildren].map((run) => run.cancel()));
      terminateNativeProcessTree(child);
    },
    approve: async () => { throw new Error("Restricted CLI fallback does not request provider approvals."); },
  };
}
export function delegatedSystemPrompt(specialist: SharedAgentDefinition): string {
  const writeInstruction = specialist.permission === "read"
    ? "This child is read-only."
    : "All writes must use the Arcelle workspace tools.";
  return [
    specialist.instructions,
    `You are Arcelle specialist ${specialist.id}. Graph policy: ${specialist.graph}.`,
    `Allowed Arcelle tools: ${specialist.tools.join(", ") || "none"}.`,
    writeInstruction,
  ].join("\n");
}
export function delegatedChildContext(
  parent: HarnessContext,
  specialist: SharedAgentDefinition,
  suffix: string,
): HarnessContext {
  return {
    ...parent,
    runId: `${parent.runId}-child-${suffix}`,
    baselineRunId: parent.baselineRunId ?? parent.runId,
    runtimePath: path.join(parent.runtimePath, "children", suffix),
    writeEnabled: specialist.permission === "write",
    systemPrompt: delegatedSystemPrompt(specialist),
    delegationDepth: (parent.delegationDepth ?? 0) + 1,
  };
}
export function delegableSpecialist(agentId: string): SharedAgentDefinition {
  const specialist = loadAgentManifest().agents.find((agent) => agent.id === agentId);
  if (specialist === undefined || specialist.id === "chat.answer") {
    throw new Error("That Arcelle specialist is not available for delegation.");
  }
  return specialist;
}
export function assertSpecialistWriteAccess(specialist: SharedAgentDefinition, writeEnabled: boolean): void {
  if (specialist.permission === "write" && !writeEnabled) {
    throw new Error("A write specialist cannot run inside a read-only parent run.");
  }
}
export function isForwardedChildActivity(event: HarnessEvent): boolean {
  return event.type === "usage_updated"
    || event.type === "tool_started"
    || event.type === "tool_completed"
    || event.type === "approval_requested";
}
export function delegatedChildFailure(event: HarnessEvent): string | null {
  if (event.type === "run_failed") return event.error;
  if (event.type === "run_completed" && event.status === "cancelled") {
    return "The delegated specialist was cancelled.";
  }
  return null;
}
export function forwardDelegatedChildEvent(
  event: HarnessEvent,
  parentRunId: string,
  agentId: string,
  output: AsyncEventQueue<HarnessEvent>,
): string | null {
  if (event.type === "text_delta") {
    output.push({ type: "text_delta", runId: parentRunId, text: event.text, agentId });
    return null;
  }
  if (isForwardedChildActivity(event)) {
    output.push({ ...event, runId: parentRunId });
    return null;
  }
  return delegatedChildFailure(event);
}
export async function collectDelegatedChild(
  child: HarnessRun,
  parentRunId: string,
  agentId: string,
  output: AsyncEventQueue<HarnessEvent>,
): Promise<Record<string, unknown>> {
  let text = "";
  let failure: string | null = null;
  for await (const event of child.events) {
    if (event.type === "text_delta") text += event.text;
    const childFailure = forwardDelegatedChildEvent(event, parentRunId, agentId, output);
    if (childFailure !== null) failure = childFailure;
  }
  if (failure !== null) throw new Error(failure);
  return { agent_id: agentId, text };
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
  private readonly writeGate: AsyncWriteGate;
  private readonly specialistGate: AsyncWriteGate;
  private readonly options: LegacyCliRuntimeOptions;

  constructor(
    private readonly provider: "codex" | "claude",
    private readonly state: RoomManagerState,
    options: LegacyCliRuntimeOptions = {},
  ) {
    this.options = options;
    this.executable = options.executable ?? nativeCliExecutable(provider);
    this.spawn = options.spawn ?? spawnWithNativeWorkspaceSandbox;
    this.availableProbe = options.available ?? (() => spawnSync(this.executable, ["--version"], { stdio: "ignore", timeout: 5_000 }).status === 0);
    this.writeGate = options.writeGate ?? new AsyncWriteGate();
    this.specialistGate = options.specialistGate ?? new AsyncWriteGate();
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
    const room = requireLegacyWorkspaceRoom(this.state, context);
    const isolated = await legacyIsolatedWorkspace(context);
    const backend = legacyWorkspaceBackend(this.state, room, context);
    const events = new AsyncEventQueue<HarnessEvent>();
    const activeChildren = new Set<HarnessRun>();
    const delegation = { parentCancelled: false };
    const delegate = this.delegateFor(context, events, activeChildren, delegation);
    const token = randomUUID();
    const bridge = await createLegacyBridge(
      token, backend, this.writeGate, delegate, this.options.baseDispatcher?.(context, backend),
    );
    const configPath = await writeLegacyMcpConfig(isolated, bridge, token);
    const prompt = legacyPrompt(context, input);
    const env = { ...process.env, ARCELLE_ROOM_MCP_TOKEN: token };
    const args = legacyCliArgs(this.provider, configPath, bridge, context.model);
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
    attachLegacyCliLifecycle(child, this.provider, bridge, events, context);
    events.push({ type: "run_started", runId: context.runId, harness: this.name });
    events.push({ type: "agent_started", runId: context.runId, agentId: "coordinator", label: `${this.provider} restricted CLI` });
    child.stdin.end(prompt, "utf8");
    return legacyHarnessRun(events, child, activeChildren, delegation);
  }

  private delegateFor(
    context: HarnessContext,
    events: AsyncEventQueue<HarnessEvent>,
    activeChildren: Set<HarnessRun>,
    delegation: LegacyDelegationState,
  ): DelegateCall | undefined {
    if ((context.delegationDepth ?? 0) > 0) return undefined;
    return async (agentId, task) => this.delegateToSpecialist(context, agentId, task, events, activeChildren, delegation);
  }

  private async delegateToSpecialist(
    context: HarnessContext,
    agentId: string,
    task: string,
    events: AsyncEventQueue<HarnessEvent>,
    activeChildren: Set<HarnessRun>,
    delegation: LegacyDelegationState,
  ): Promise<Record<string, unknown>> {
    if (delegation.parentCancelled) throw new Error("The parent run was cancelled.");
    const specialist = delegableSpecialist(agentId);
    assertSpecialistWriteAccess(specialist, context.writeEnabled);
    const execute = () => this.runDelegatedChild(context, specialist, task, events, activeChildren);
    return specialist.permission === "write" ? this.specialistGate.run(execute) : execute();
  }

  private async runDelegatedChild(
    parent: HarnessContext,
    specialist: SharedAgentDefinition,
    task: string,
    output: AsyncEventQueue<HarnessEvent>,
    activeChildren: Set<HarnessRun>,
  ): Promise<Record<string, unknown>> {
    const suffix = randomUUID();
    const agentId = specialist.id;
    output.push({ type: "agent_started", runId: parent.runId, agentId, label: specialist.label });
    const runtime = new RestrictedLegacyCliRuntime(this.provider, this.state, {
      ...this.options,
      writeGate: this.writeGate,
      specialistGate: this.specialistGate,
    });
    const child = await runtime.startTurn(delegatedChildContext(parent, specialist, suffix), { text: task });
    activeChildren.add(child);
    try {
      return await collectDelegatedChild(child, parent.runId, agentId, output);
    } finally {
      activeChildren.delete(child);
      output.push({ type: "agent_completed", runId: parent.runId, agentId });
    }
  }
}


/** Select rich structured mode when available, otherwise the restricted CLI. */
export class RuntimeWithFallback implements HarnessRuntime {
  readonly name;
  private readonly exposureSelections = new Map<string, HarnessRuntime>();
  constructor(private readonly primary: HarnessRuntime, private readonly fallback: HarnessRuntime) {
    this.name = primary.name;
  }
  async available(): Promise<boolean> { return (await this.primary.available()) || this.fallback.available(); }
  async verifyExposure(workspacePath: string, runtimePath: string, writeEnabled: boolean): Promise<boolean> {
    this.exposureSelections.delete(runtimePath);
    if (
      await this.primary.available()
      && await this.primary.verifyExposure?.(workspacePath, runtimePath, writeEnabled) === true
    ) {
      this.exposureSelections.set(runtimePath, this.primary);
      return true;
    }
    if (
      await this.fallback.available()
      && await this.fallback.verifyExposure?.(workspacePath, runtimePath, writeEnabled) === true
    ) {
      this.exposureSelections.set(runtimePath, this.fallback);
      return true;
    }
    return false;
  }
  /** Which verified runtime a capability probe selected; consumes probe state. */
  consumeVerifiedHarness(runtimePath: string): HarnessName | null {
    const selected = this.exposureSelections.get(runtimePath);
    this.exposureSelections.delete(runtimePath);
    return selected?.name ?? null;
  }
  async startTurn(context: HarnessContext, input: HarnessInput): Promise<HarnessRun> {
    const verified = this.exposureSelections.get(context.runtimePath);
    this.exposureSelections.delete(context.runtimePath);
    if (verified !== undefined) return verified.startTurn(context, input);
    return (await this.primary.available() ? this.primary : this.fallback).startTurn(context, input);
  }
}
