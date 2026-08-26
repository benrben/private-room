import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { EventSender } from "../turn.js";
import { activePolicy, type PolicyState } from "../privacy.js";
import type { RoomManagerState } from "../roomManager.js";
import type { LiveAppServices } from "../liveAppServices.js";
import { runsOnThisMac } from "../capabilities.js";
import { roomServerDispatcherFactory } from "../roomServerLive.js";
import { WEB_LANES_ALL } from "../toolSpecs.js";
import {
  workspaceHarnessCapabilities,
  workspaceHarnessFlag,
  type WorkspaceHarnessFlag,
} from "../workspace/featureFlags.js";
import { ClaudeAgentSdkRuntime } from "./claudeAgentSdk.js";
import { CloudRedactedMirror } from "./cloudMirror.js";
import { CodexAppServerRuntime } from "./codexAppServer.js";
import {
  RestrictedLegacyCliRuntime,
  RuntimeWithFallback,
  type LegacyCliRuntimeOptions,
} from "./legacyCli.js";
import { DeepAgentRuntime } from "./deepAgentRuntime.js";
import { HarnessOrchestrator, type HarnessFinalStatus } from "./orchestrator.js";
import { RunProtection, type RollbackResult } from "./runProtection.js";
import { nativeWorkspaceSandboxSupported, verifyNativeHarnessExecutable } from "./seatbelt.js";
import type {
  ApprovalDecision,
  HarnessEvent,
  HarnessRuntime,
  PrivacyMode,
} from "./types.js";

export type HarnessProvider = "codex" | "claude" | "ollama-local" | "ollama-cloud" | "openrouter";

export interface HarnessStartRequest {
  provider: HarnessProvider;
  model: string;
  privacyMode: PrivacyMode;
  writeEnabled: boolean;
  text: string;
  threadId?: string;
  systemPrompt?: string;
}

export interface HarnessCapabilityReport {
  flags: Record<WorkspaceHarnessFlag, boolean>;
  roomFormat: "workspace-folder" | "sealed-db" | null;
  outsideWorkspaceIsolation: boolean;
  providers: Record<string, { enabled: boolean; installed: boolean; reason: string | null }>;
}

interface MirrorRun {
  mirror: CloudRedactedMirror;
  writeEnabled: boolean;
}

interface PendingMirrorApproval {
  resolve(approved: boolean): void;
}

export interface HarnessControllerOptions {
  runtimes?: Partial<Record<HarnessProvider, HarnessRuntime>>;
  services?: LiveAppServices;
  policy?: () => PolicyState | null;
  flag?: (name: WorkspaceHarnessFlag) => boolean;
  /**
   * Must prove both private-path denial and outside-workspace denial.
   * Production deliberately supplies no verifier until that stronger sandbox
   * exists. The old `.arcelle`-only canary is not enough.
   */
  verifyExposure?: (
    workspacePath: string,
    provider: "codex" | "claude",
    runtimePath: string,
    writeEnabled: boolean,
  ) => Promise<boolean>;
  outsideWorkspaceIsolation?: boolean;
}

/** Trusted bridge between room state, provider runtimes and renderer events. */
export class HarnessController {
  private readonly runtimes: Record<HarnessProvider, HarnessRuntime>;
  private readonly policy: () => PolicyState | null;
  private readonly flag: (name: WorkspaceHarnessFlag) => boolean;
  private readonly verifyExposure: NonNullable<HarnessControllerOptions["verifyExposure"]>;
  private isolationProven: boolean;
  private readonly mirrors = new Map<string, MirrorRun>();
  private readonly pendingMirrorApprovals = new Map<string, PendingMirrorApproval>();
  private readonly pendingSafetyApprovals = new Map<string, PendingMirrorApproval>();
  private readonly pumps = new Map<string, Promise<void>>();
  private readonly runRoots = new Map<string, string>();
  private orchestrator: HarnessOrchestrator | null = null;
  private roomId: string | null = null;

  constructor(
    private readonly state: RoomManagerState,
    private readonly userDataDir: string,
    private readonly emit: EventSender,
    options: HarnessControllerOptions = {},
  ) {
    const fallbackDispatcher = roomServerDispatcherFactory(state, emit, options.services);
    const fallbackOptions: LegacyCliRuntimeOptions = {
      baseDispatcher: (context, workspace) =>
        fallbackDispatcher(false, { kind: "CloudEngine" }, WEB_LANES_ALL, {
          workspace,
          privacyBypass: context.privacyMode === "cloud-direct",
        }),
    };
    this.runtimes = {
      codex: options.runtimes?.codex ?? new RuntimeWithFallback(
        new CodexAppServerRuntime(),
        new RestrictedLegacyCliRuntime("codex", state, fallbackOptions),
      ),
      claude: options.runtimes?.claude ?? new RuntimeWithFallback(
        new ClaudeAgentSdkRuntime(),
        new RestrictedLegacyCliRuntime("claude", state, fallbackOptions),
      ),
      "ollama-local": options.runtimes?.["ollama-local"] ?? new DeepAgentRuntime(state, emit, options.services),
      "ollama-cloud": options.runtimes?.["ollama-cloud"] ?? new DeepAgentRuntime(state, emit, options.services),
      openrouter: options.runtimes?.openrouter ?? new DeepAgentRuntime(state, emit, options.services),
    };
    this.policy = options.policy ?? activePolicy;
    this.flag = options.flag ?? workspaceHarnessFlag;
    this.verifyExposure = options.verifyExposure ?? (async (workspacePath, provider, runtimePath, writeEnabled) => {
      const runtime = this.runtimes[provider];
      if (runtime.verifyExposure !== undefined) {
        return runtime.verifyExposure(workspacePath, runtimePath, writeEnabled);
      }
      return verifyNativeHarnessExecutable({
        workspacePath,
        runtimePath,
        provider,
        writeEnabled,
        executable: provider === "codex"
          ? process.env.ARCELLE_CODEX_PATH ?? "codex"
          : process.env.ARCELLE_CLAUDE_PATH ?? "claude",
      }, provider === "codex" ? ["app-server", "--help"] : ["--version"]);
    });
    this.isolationProven = options.outsideWorkspaceIsolation ?? nativeWorkspaceSandboxSupported();
  }

  private runtimeRoot(): string {
    return path.join(this.userDataDir, "Arcelle Runtime");
  }

  private ensureOrchestrator(): HarnessOrchestrator {
    const room = this.state.room;
    if (room?.workspace === undefined || room.descriptor?.kind !== "workspace-folder") {
      throw new Error("The unified file harness requires an unlocked workspace room.");
    }
    if (this.orchestrator !== null && this.roomId === room.descriptor.roomId) return this.orchestrator;
    if (this.pumps.size > 0) throw new Error("Wait for the active agent runs to stop before changing rooms.");
    const protection = new RunProtection(
      room.workspace,
      room.descriptor.roomId,
      () => room.workspaceIndexer?.indexPending() ?? Promise.resolve(),
      (progress) => this.emit("workspace-operation-progress", progress),
    );
    const orchestrator = new HarnessOrchestrator(protection, {
      beforeFinish: async (runId, status, send) => {
        const mirrorStatus = await this.finishMirror(runId, status, send);
        return this.reviewMassChanges(protection, runId, mirrorStatus, send);
      },
    });
    orchestrator.register("codex", this.runtimes.codex);
    orchestrator.register("claude", this.runtimes.claude);
    orchestrator.register("ollama-local", this.runtimes["ollama-local"]);
    orchestrator.register("ollama-cloud", this.runtimes["ollama-cloud"]);
    orchestrator.register("openrouter", this.runtimes.openrouter);
    this.orchestrator = orchestrator;
    this.roomId = room.descriptor.roomId;
    return orchestrator;
  }

  async capabilities(): Promise<HarnessCapabilityReport> {
    const flags = workspaceHarnessCapabilities();
    for (const name of Object.keys(flags) as WorkspaceHarnessFlag[]) flags[name] = this.flag(name);
    const provider = async (name: "codex" | "claude", providerFlag: WorkspaceHarnessFlag) => {
      const installed = flags[providerFlag] ? await this.runtimes[name].available() : false;
      const room = this.state.room;
      let sandboxReady = false;
      if (
        flags.unified_harness
        && flags[providerFlag]
        && this.isolationProven
        && installed
        && room?.workspace !== undefined
        && room.descriptor?.kind === "workspace-folder"
        && room.descriptor.rootPath !== null
      ) {
        const probePath = path.join(this.runtimeRoot(), room.descriptor.roomId, `capability-${randomUUID()}`);
        await mkdir(probePath, { recursive: true, mode: 0o700 });
        try { sandboxReady = await this.verifyExposure(room.descriptor.rootPath, name, probePath, false); }
        finally { await rm(probePath, { recursive: true, force: true }); }
      }
      let reason: string | null = null;
      if (!flags.unified_harness) reason = "The unified harness feature is disabled.";
      else if (!flags[providerFlag]) reason = `The ${name} native harness feature is disabled.`;
      else if (!this.isolationProven) reason = "Outside-workspace process isolation has not passed its security test.";
      else if (!installed) reason = `The ${name} agent runtime is not installed.`;
      else if (room?.descriptor?.kind !== "workspace-folder") reason = "Open a workspace room to run the sandbox capability test.";
      else if (!sandboxReady) reason = `The ${name} runtime failed its sandbox capability test.`;
      return { enabled: sandboxReady, installed, reason };
    };
    const deepProvider = async (name: "ollama-local" | "ollama-cloud" | "openrouter") => {
      const installed = flags.deep_agent_harness ? await this.runtimes[name].available() : false;
      const room = this.state.room;
      let reason: string | null = null;
      if (!flags.unified_harness) reason = "The unified harness feature is disabled.";
      else if (!flags.deep_agent_harness) reason = "The Arcelle Deep Harness feature is disabled.";
      else if (!installed) reason = "The built-in Deep Harness runtime is unavailable.";
      else if (room?.descriptor?.kind !== "workspace-folder" || room.workspace === undefined) {
        reason = "Open a workspace room to use the Deep Harness.";
      }
      return { enabled: reason === null, installed, reason };
    };
    // Provider probes may execute installed CLIs and their sandbox self-tests.
    // They are independent, so running them serially makes one slow/missing
    // executable hold every other provider's result behind it (and can turn a
    // diagnostics refresh into the sum of all probe timeouts).
    const [codex, claude, ollamaLocal, ollamaCloud, openrouter] = await Promise.all([
      provider("codex", "codex_app_server"),
      provider("claude", "claude_agent_sdk"),
      deepProvider("ollama-local"),
      deepProvider("ollama-cloud"),
      deepProvider("openrouter"),
    ]);
    return {
      flags,
      roomFormat: this.state.room?.descriptor?.kind ?? null,
      outsideWorkspaceIsolation: this.isolationProven,
      providers: {
        codex,
        claude,
        "ollama-local": ollamaLocal,
        "ollama-cloud": ollamaCloud,
        openrouter,
      },
    };
  }

  async start(request: HarnessStartRequest): Promise<string> {
    if (!this.flag("unified_harness")) throw new Error("The unified harness feature is disabled.");
    const native = request.provider === "codex" || request.provider === "claude";
    const providerFlag = request.provider === "codex"
      ? "codex_app_server"
      : request.provider === "claude"
        ? "claude_agent_sdk"
        : "deep_agent_harness";
    if (!this.flag(providerFlag)) throw new Error(`The ${request.provider} native harness feature is disabled.`);
    if (native && !this.isolationProven) {
      throw new Error("Native harness mode is disabled because outside-workspace isolation is not proven.");
    }
    if (native && request.privacyMode === "local") {
      throw new Error("Codex and Claude are cloud providers. Choose cloud-direct or cloud-redacted privacy mode.");
    }
    if (request.provider === "ollama-local" && request.privacyMode !== "local") {
      throw new Error("Local Ollama uses local privacy mode.");
    }
    if (request.provider === "ollama-local" && !runsOnThisMac(request.model)) {
      throw new Error("Choose a model that runs on this Mac for the local Ollama harness.");
    }
    if ((request.provider === "ollama-cloud" || request.provider === "openrouter") && request.privacyMode === "local") {
      throw new Error("This cloud provider requires cloud-direct or cloud-redacted privacy mode.");
    }
    if (request.provider === "ollama-cloud" && runsOnThisMac(request.model)) {
      throw new Error("Choose an Ollama cloud model for the Ollama cloud harness.");
    }
    const room = this.state.room;
    if (
      room?.workspace === undefined
      || room.descriptor?.kind !== "workspace-folder"
      || room.descriptor.rootPath === null
    ) {
      throw new Error("Open a workspace room before starting this harness.");
    }
    if (room.readOnly === true && request.writeEnabled) {
      throw new Error("This workspace is read-only because another Arcelle process owns the writer lease.");
    }
    const runId = randomUUID();
    const runRuntimePath = path.join(this.runtimeRoot(), room.descriptor.roomId, runId);
    this.runRoots.set(runId, runRuntimePath);
    let workspacePath = room.descriptor.rootPath;
    if (request.privacyMode === "cloud-redacted") {
      if (!this.flag("cloud_redacted_mirror")) throw new Error("Cloud Privacy workspace mirrors are disabled.");
      const policy = this.policy();
      if (policy === null) throw new Error("Turn on Cloud Privacy before starting a redacted cloud run.");
      const mirror = new CloudRedactedMirror(
        room.workspace,
        this.runtimeRoot(),
        room.descriptor.roomId,
        runId,
        { redactor: policy.redactor, rules: policy.rules },
      );
      const info = await mirror.create();
      workspacePath = info.workspacePath;
      this.mirrors.set(runId, { mirror, writeEnabled: request.writeEnabled });
    } else {
      await mkdir(runRuntimePath, { recursive: true, mode: 0o700 });
    }
    if (native && !(await this.verifyExposure(
      workspacePath,
      request.provider as "codex" | "claude",
      runRuntimePath,
      request.writeEnabled,
    ))) {
      await this.removeRunRuntime(runId);
      throw new Error("The native harness exposure failed its sandbox self-test.");
    }

    const orchestrator = this.ensureOrchestrator();
    try {
      const started = await orchestrator.start({
        ...request,
        runId,
        roomId: room.descriptor.roomId,
        workspacePath,
        runtimePath: runRuntimePath,
        exposureVerified: true,
      });
      const pump = (async () => {
        let terminal: HarnessEvent | null = null;
        try {
          for await (const event of started.events) {
            // A terminal event is a lifecycle promise to the renderer: once it
            // paints Done/Failed/Stopped, the private run directory and mirror
            // must already be gone. Buffer the one terminal event until cleanup
            // completes so callers cannot race a room close, test teardown, or
            // the next run against a still-removing runtime tree.
            if (event.type === "run_completed" || event.type === "run_failed") terminal = event;
            else this.emit("harness-event", event);
          }
        } finally {
          await this.removeRunRuntime(runId);
          this.pumps.delete(runId);
        }
        if (terminal !== null) this.emit("harness-event", terminal);
      })();
      this.pumps.set(runId, pump);
      return runId;
    } catch (error) {
      await this.removeRunRuntime(runId);
      throw error;
    }
  }

  approve(runId: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    if (requestId === `mass-change-${runId}`) {
      const pending = this.pendingSafetyApprovals.get(runId);
      if (pending === undefined) throw new Error("That mass-change approval is no longer pending.");
      pending.resolve(decision === "allow-once" || decision === "allow-run");
      return Promise.resolve();
    }
    if (this.orchestrator === null) throw new Error("No harness run is active.");
    return this.orchestrator.approve(runId, requestId, decision);
  }

  async cancel(runId: string): Promise<void> {
    this.pendingMirrorApprovals.get(runId)?.resolve(false);
    this.pendingSafetyApprovals.get(runId)?.resolve(false);
    await this.orchestrator?.cancel(runId);
  }

  approveCloudWriteback(runId: string, approved: boolean): void {
    const pending = this.pendingMirrorApprovals.get(runId);
    if (pending === undefined) throw new Error("That cloud write-back approval is no longer pending.");
    pending.resolve(approved);
  }

  rollback(runId: string): Promise<RollbackResult> {
    if (this.orchestrator === null) throw new Error("No harness history is available for this room.");
    return this.orchestrator.rollback(runId);
  }

  restoreBaselineAsCopies(runId: string, paths: string[]): Promise<string[]> {
    if (this.orchestrator === null) throw new Error("No harness history is available for this room.");
    return this.orchestrator.restoreBaselineAsCopies(runId, paths);
  }

  async stopAll(timeoutMs = 10_000): Promise<void> {
    const ids = this.orchestrator?.activeRunIds() ?? [];
    await Promise.allSettled(ids.map((id) => this.cancel(id)));
    const pumps = [...this.pumps.values()];
    if (pumps.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(pumps),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    }
    await Promise.allSettled([...this.runRoots.keys()].map((id) => this.removeRunRuntime(id)));
  }

  /** Forced synchronous teardown: signal providers and remove cloud exposure now. */
  stopAllNoWait(): void {
    for (const id of this.orchestrator?.activeRunIds() ?? []) {
      this.pendingMirrorApprovals.get(id)?.resolve(false);
      this.pendingSafetyApprovals.get(id)?.resolve(false);
      void this.orchestrator?.cancel(id).catch(() => undefined);
    }
    for (const id of this.runRoots.keys()) void this.removeRunRuntime(id).catch(() => undefined);
  }

  cleanupAbandoned(): Promise<number> {
    // No run survives an app process restart, so every existing run folder is
    // abandoned regardless of age.
    return CloudRedactedMirror.cleanupAbandoned(this.runtimeRoot(), 0);
  }

  private async finishMirror(
    runId: string,
    status: HarnessFinalStatus,
    send: (event: HarnessEvent) => void,
  ): Promise<HarnessFinalStatus> {
    const entry = this.mirrors.get(runId);
    if (entry === undefined) return status;
    try {
      if (status !== "completed" || !entry.writeEnabled) return status;
      let result = await entry.mirror.writeBack(false);
      if (result.requiresReview.length > 0) {
        send({
          type: "approval_requested",
          runId,
          requestId: `cloud-writeback-${runId}`,
          tool: "cloud_writeback",
          detail: "Cloud output duplicated protected placeholders. Review is required before applying it.",
        });
        const approved = await new Promise<boolean>((resolve) => {
          this.pendingMirrorApprovals.set(runId, { resolve });
        });
        this.pendingMirrorApprovals.delete(runId);
        if (!approved) return "cancelled";
        result = await entry.mirror.writeBack(true);
      }
      for (const relativePath of [...result.updated, ...result.created]) {
        send({ type: "file_changed", runId, relativePath, change: result.created.includes(relativePath) ? "created" : "modified" });
      }
      return status;
    } finally {
      this.pendingMirrorApprovals.delete(runId);
      await this.removeMirror(runId);
    }
  }

  private async reviewMassChanges(
    protection: RunProtection,
    runId: string,
    status: HarnessFinalStatus,
    send: (event: HarnessEvent) => void,
  ): Promise<HarnessFinalStatus> {
    if (status !== "completed") return status;
    const summary = await protection.captureFinalState(runId);
    if (summary.count <= 20) return status;
    send({
      type: "approval_requested",
      runId,
      requestId: `mass-change-${runId}`,
      tool: "workspace_mass_change",
      detail: `The agent changed ${summary.count} files. Approve to keep them, or deny to restore the protected baseline.`,
    });
    const approved = await new Promise<boolean>((resolve) => {
      this.pendingSafetyApprovals.set(runId, { resolve });
    });
    this.pendingSafetyApprovals.delete(runId);
    if (approved) return status;
    await protection.rollback(runId);
    return "cancelled";
  }

  private async removeMirror(runId: string): Promise<void> {
    const entry = this.mirrors.get(runId);
    this.mirrors.delete(runId);
    if (entry !== undefined) await entry.mirror.cleanup();
  }

  private async removeRunRuntime(runId: string): Promise<void> {
    this.pendingSafetyApprovals.delete(runId);
    const runRoot = this.runRoots.get(runId);
    this.runRoots.delete(runId);
    if (this.mirrors.has(runId)) await this.removeMirror(runId);
    else if (runRoot !== undefined) {
      // macOS can briefly report ENOTEMPTY while a just-exited provider's file
      // descriptors settle. Node only retries recursive removal when
      // maxRetries is explicit; keep this bounded and local to the per-run
      // directory rather than leaking a transient cleanup race to the UI.
      await rm(runRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  }
}
