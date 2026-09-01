import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { EventSender } from "../turn.js";
import { type PolicyState } from "../privacy.js";
import type { RoomManagerState } from "../roomManager.js";
import { runsOnThisMac } from "../capabilities.js";
import { listModels as listOllamaModels } from "../engineRouting.js";
import { registryName } from "../ollamaModels.js";
import { workspaceHarnessCapabilities, type WorkspaceHarnessFlag } from "../workspace/featureFlags.js";
import { RuntimeWithFallback } from "./legacyCli.js";
import { HarnessOrchestrator, type HarnessFinalStatus } from "./orchestrator.js";
import { RunProtection } from "./runProtection.js";
import { verifyNativeHarnessExecutable } from "./seatbelt.js";
import { nativeCliExecutable, nativeHarnessModel } from "./nativeCli.js";
import { validateModelSelection } from "../modelCatalogSurfaceIpc.js";
import type { HarnessEvent, HarnessRuntime, PrivacyMode } from "./types.js";
import { resolvedControllerOptions, controllerRuntimes } from "./controller.js";
import type { NativeHarnessProvider, NativeHarnessRoom, NativeProviderProbe, HarnessProvider, HarnessStartRequest, HarnessCapabilityReport, MirrorRun, PendingMirrorApproval, HarnessControllerOptions } from "./controller.js";

export abstract class HarnessControllerCore {

  protected readonly runtimes: Record<HarnessProvider, HarnessRuntime>;

  protected readonly policy: () => PolicyState | null;

  protected readonly flag: (name: WorkspaceHarnessFlag) => boolean;

  protected readonly verifyExposure: NonNullable<HarnessControllerOptions["verifyExposure"]>;

  protected readonly listOllamaModels: () => Promise<string[]>;

  protected readonly validateModelSelection: typeof validateModelSelection;

  protected isolationProven: boolean;

  protected readonly mirrors = new Map<string, MirrorRun>();

  protected readonly pendingMirrorApprovals = new Map<string, PendingMirrorApproval>();

  protected readonly pendingSafetyApprovals = new Map<string, PendingMirrorApproval>();

  protected readonly pumps = new Map<string, Promise<void>>();

  protected readonly runRoots = new Map<string, string>();

  protected orchestrator: HarnessOrchestrator | null = null;

  protected roomId: string | null = null;

  protected workspace: object | null = null;


  constructor(
    protected readonly state: RoomManagerState,
    protected readonly userDataDir: string,
    protected readonly emit: EventSender,
    options: HarnessControllerOptions = {},
  ) {
    this.runtimes = controllerRuntimes(state, emit, options.runtimes, options.services);
    const resolved = resolvedControllerOptions(options);
    this.policy = resolved.policy;
    this.flag = resolved.flag;
    this.listOllamaModels = resolved.listOllamaModels;
    this.validateModelSelection = resolved.validateModelSelection;
    this.verifyExposure = this.configuredExposureVerifier(resolved.verifyExposure);
    this.isolationProven = resolved.outsideWorkspaceIsolation;
  }


  protected configuredExposureVerifier(
    verifier: HarnessControllerOptions["verifyExposure"],
  ): NonNullable<HarnessControllerOptions["verifyExposure"]> {
    if (verifier !== undefined) {
      return verifier;
    }
    return (workspacePath, provider, runtimePath, writeEnabled) =>
      this.defaultVerifyExposure(workspacePath, provider, runtimePath, writeEnabled);
  }


  protected async defaultVerifyExposure(
    workspacePath: string,
    provider: NativeHarnessProvider,
    runtimePath: string,
    writeEnabled: boolean,
  ): Promise<boolean> {
    const runtime = this.runtimes[provider];
    if (runtime.verifyExposure !== undefined) {
      return runtime.verifyExposure(workspacePath, runtimePath, writeEnabled);
    }
    return verifyNativeHarnessExecutable({
      workspacePath,
      runtimePath,
      provider,
      writeEnabled,
      executable: nativeCliExecutable(provider),
    }, provider === "codex" ? ["app-server", "--help"] : ["--version"]);
  }


  protected runtimeRoot(): string {
    return path.join(this.userDataDir, "Arcelle Runtime");
  }


  protected orchestratorRoom(): NativeHarnessRoom {
    const room = this.state.room;
    if (room?.workspace === undefined || room.descriptor?.kind !== "workspace-folder") {
      throw new Error("The unified file harness requires an unlocked workspace room.");
    }
    return room as NativeHarnessRoom;
  }


  protected hasCurrentOrchestrator(room: NativeHarnessRoom): boolean {
    return (
      this.orchestrator !== null
      && this.roomId === room.descriptor.roomId
      && this.workspace === room.workspace
    );
  }


  protected newOrchestrator(room: NativeHarnessRoom): HarnessOrchestrator {
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
    return orchestrator;
  }


  protected ensureOrchestrator(): HarnessOrchestrator {
    const room = this.orchestratorRoom();
    // A lock/unlock or close/reopen creates a new WorkspaceService and opens a
    // new SQLCipher connection even when the stable room ID is unchanged. An
    // orchestrator retained for the old service would keep RunProtection
    // pointed at the closed database and make history/rollback fail after the
    // room is reopened.
    if (this.hasCurrentOrchestrator(room)) return this.orchestrator as HarnessOrchestrator;
    if (this.pumps.size > 0) throw new Error("Wait for the active agent runs to stop before changing rooms.");
    const orchestrator = this.newOrchestrator(room);
    this.orchestrator = orchestrator;
    this.roomId = room.descriptor.roomId;
    this.workspace = room.workspace;
    return orchestrator;
  }


  protected nativeProviderInstalled(
    name: NativeHarnessProvider,
    providerFlag: WorkspaceHarnessFlag,
    flags: Record<WorkspaceHarnessFlag, boolean>,
  ): Promise<boolean> | false {
    if (!flags[providerFlag]) return false;
    return this.runtimes[name].available();
  }


  protected nativeProbeReady(
    flags: Record<WorkspaceHarnessFlag, boolean>,
    providerFlag: WorkspaceHarnessFlag,
    installed: boolean,
    room: RoomManagerState["room"],
  ): room is NativeHarnessRoom {
    return [
      flags.unified_harness,
      flags[providerFlag],
      this.isolationProven,
      installed,
      room !== null,
      room?.workspace !== undefined,
      room?.readOnly !== true,
      room?.descriptor?.kind === "workspace-folder",
      room?.descriptor?.rootPath !== null,
    ].every(Boolean);
  }


  protected verifiedNativeHarness(
    name: NativeHarnessProvider,
    probePath: string,
    sandboxReady: boolean,
  ): HarnessRuntime["name"] | null {
    const runtime = this.runtimes[name];
    if (runtime instanceof RuntimeWithFallback) return runtime.consumeVerifiedHarness(probePath);
    return sandboxReady ? runtime.name : null;
  }


  protected async probeNativeProvider(
    name: NativeHarnessProvider,
    providerFlag: WorkspaceHarnessFlag,
    flags: Record<WorkspaceHarnessFlag, boolean>,
    installed: boolean,
    room: RoomManagerState["room"],
  ): Promise<NativeProviderProbe> {
    if (!this.nativeProbeReady(flags, providerFlag, installed, room)) {
      return { sandboxReady: false, harness: null };
    }
    const probePath = path.join(this.runtimeRoot(), room.descriptor.roomId, `capability-${randomUUID()}`);
    await mkdir(probePath, { recursive: true, mode: 0o700 });
    try {
      const sandboxReady = await this.verifyExposure(room.descriptor.rootPath, name, probePath, false);
      return {
        sandboxReady,
        harness: this.verifiedNativeHarness(name, probePath, sandboxReady),
      };
    } finally {
      await rm(probePath, { recursive: true, force: true });
    }
  }


  protected nativeProviderReason(
    name: NativeHarnessProvider,
    providerFlag: WorkspaceHarnessFlag,
    flags: Record<WorkspaceHarnessFlag, boolean>,
    installed: boolean,
    sandboxReady: boolean,
    harness: HarnessRuntime["name"] | null,
    room: RoomManagerState["room"],
  ): string | null {
    const reasons: Array<[boolean, string]> = [
      [!flags.unified_harness, "The unified harness feature is disabled."],
      [!flags[providerFlag], `The ${name} native harness feature is disabled.`],
      [!this.isolationProven, "Outside-workspace process isolation has not passed its security test."],
      [!installed, `The ${name} agent runtime is not installed.`],
      [room?.descriptor?.kind !== "workspace-folder", "Open a workspace room to run the sandbox capability test."],
      [room?.readOnly === true, "This workspace is read-only because another Arcelle process owns the writer lease."],
      [!sandboxReady, `The ${name} runtime failed its sandbox capability test.`],
      [harness === "legacy-cli", `The native ${name} harness failed its startup test. Arcelle will use the restricted CLI fallback.`],
    ];
    return reasons.find(([matches]) => matches)?.[1] ?? null;
  }


  protected async nativeProviderCapability(
    name: NativeHarnessProvider,
    providerFlag: WorkspaceHarnessFlag,
    flags: Record<WorkspaceHarnessFlag, boolean>,
  ): Promise<HarnessCapabilityReport["providers"][string]> {
    const installed = await this.nativeProviderInstalled(name, providerFlag, flags);
    const room = this.state.room;
    const { sandboxReady, harness } = await this.probeNativeProvider(
      name,
      providerFlag,
      flags,
      installed,
      room,
    );
    return {
      enabled: sandboxReady,
      installed,
      reason: this.nativeProviderReason(name, providerFlag, flags, installed, sandboxReady, harness, room),
      harness,
    };
  }


  protected async deepProviderInstalled(
    name: "ollama-local" | "ollama-cloud" | "openrouter",
    flags: Record<WorkspaceHarnessFlag, boolean>,
  ): Promise<boolean> {
    return flags.deep_agent_harness ? this.runtimes[name].available() : false;
  }


  protected deepProviderReason(
    flags: Record<WorkspaceHarnessFlag, boolean>,
    installed: boolean,
    room: RoomManagerState["room"],
  ): string | null {
    const reasons: Array<[boolean, string]> = [
      [!flags.unified_harness, "The unified harness feature is disabled."],
      [!flags.deep_agent_harness, "The Arcelle Deep Harness feature is disabled."],
      [!installed, "The built-in Deep Harness runtime is unavailable."],
      [room?.descriptor?.kind !== "workspace-folder" || room.workspace === undefined, "Open a workspace room to use the Deep Harness."],
      [room?.readOnly === true, "This workspace is read-only because another Arcelle process owns the writer lease."],
    ];
    return reasons.find(([matches]) => matches)?.[1] ?? null;
  }


  protected async deepProviderCapability(
    name: "ollama-local" | "ollama-cloud" | "openrouter",
    flags: Record<WorkspaceHarnessFlag, boolean>,
  ): Promise<HarnessCapabilityReport["providers"][string]> {
    const installed = await this.deepProviderInstalled(name, flags);
    const reason = this.deepProviderReason(flags, installed, this.state.room);
    return {
      enabled: reason === null,
      installed,
      reason,
      harness: reason === null ? this.runtimes[name].name : null,
    };
  }


  async capabilities(): Promise<HarnessCapabilityReport> {
    const flags = workspaceHarnessCapabilities();
    for (const name of Object.keys(flags) as WorkspaceHarnessFlag[]) flags[name] = this.flag(name);
    // Provider probes may execute installed CLIs and their sandbox self-tests.
    // They are independent, so running them serially makes one slow/missing
    // executable hold every other provider's result behind it (and can turn a
    // diagnostics refresh into the sum of all probe timeouts).
    const [codex, claude, ollamaLocal, ollamaCloud, openrouter] = await Promise.all([
      this.nativeProviderCapability("codex", "codex_app_server", flags),
      this.nativeProviderCapability("claude", "claude_agent_sdk", flags),
      this.deepProviderCapability("ollama-local", flags),
      this.deepProviderCapability("ollama-cloud", flags),
      this.deepProviderCapability("openrouter", flags),
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


  protected nativeProvider(provider: HarnessProvider): provider is NativeHarnessProvider {
    return provider === "codex" || provider === "claude";
  }


  protected ensureUnifiedHarnessEnabled(): void {
    if (!this.flag("unified_harness")) throw new Error("The unified harness feature is disabled.");
  }


  protected providerFlag(provider: HarnessProvider): WorkspaceHarnessFlag {
    if (provider === "codex") return "codex_app_server";
    if (provider === "claude") return "claude_agent_sdk";
    return "deep_agent_harness";
  }


  protected async selectedHarnessModel(request: HarnessStartRequest): Promise<{ native: boolean; model: string }> {
    const native = this.nativeProvider(request.provider);
    let model = this.initialHarnessModel(request.model, native);
    if (this.ollamaProvider(request.provider)) {
      model = await this.matchedOllamaModel(request.provider, model);
    }
    this.ensureSpecificModel(request.provider, native, model);
    return { native, model };
  }


  protected initialHarnessModel(model: string, native: boolean): string {
    return native ? nativeHarnessModel(model) ?? "" : model.trim();
  }


  protected ollamaProvider(provider: HarnessProvider): provider is "ollama-local" | "ollama-cloud" {
    return provider === "ollama-local" || provider === "ollama-cloud";
  }


  protected ensureSpecificModel(provider: HarnessProvider, native: boolean, model: string): void {
    if (!native && (model === "" || model.toLowerCase() === "default")) {
      throw new Error(`Choose a specific model for the ${provider} harness.`);
    }
  }


  protected async matchedOllamaModel(
    provider: "ollama-local" | "ollama-cloud",
    selectedModel: string,
  ): Promise<string> {
    const catalog = await this.listOllamaModels().catch(() => [] as string[]);
    const exact = catalog.find((model) => model === selectedModel);
    const folded = exact === undefined
      ? catalog.filter((model) => model.toLowerCase() === selectedModel.toLowerCase())
      : [];
    const matched = exact ?? (folded.length === 1 ? folded[0]! : selectedModel);
    return provider === "ollama-cloud" ? registryName(matched) : matched;
  }


  protected validatePrivacyMode(
    provider: HarnessProvider,
    native: boolean,
    selectedModel: string,
    privacyMode: PrivacyMode,
  ): void {
    if (native && privacyMode === "local") {
      throw new Error("Codex and Claude are cloud providers. Choose cloud-direct or cloud-redacted privacy mode.");
    }
    this.validateLocalOllama(provider, selectedModel, privacyMode);
    this.validateCloudProvider(provider, selectedModel, privacyMode);
  }


  protected validateLocalOllama(provider: HarnessProvider, selectedModel: string, privacyMode: PrivacyMode): void {
    if (provider !== "ollama-local") return;
    if (privacyMode !== "local") throw new Error("Local Ollama uses local privacy mode.");
    if (!runsOnThisMac(selectedModel)) {
      throw new Error("Choose a model that runs on this Mac for the local Ollama harness.");
    }
  }


  protected validateCloudProvider(provider: HarnessProvider, selectedModel: string, privacyMode: PrivacyMode): void {
    if (!this.cloudProvider(provider)) return;
    this.validateCloudPrivacy(privacyMode);
    this.validateOllamaCloudModel(provider, selectedModel);
  }


  protected cloudProvider(provider: HarnessProvider): boolean {
    return provider === "ollama-cloud" || provider === "openrouter";
  }


  protected validateCloudPrivacy(privacyMode: PrivacyMode): void {
    if (privacyMode === "local") {
      throw new Error("This cloud provider requires cloud-direct or cloud-redacted privacy mode.");
    }
  }


  protected validateOllamaCloudModel(provider: HarnessProvider, selectedModel: string): void {
    if (provider === "ollama-cloud" && runsOnThisMac(selectedModel)) {
      throw new Error("Choose an Ollama cloud model for the Ollama cloud harness.");
    }
  }


  protected startRoom(): NativeHarnessRoom {
    const room = this.state.room;
    if (room?.workspace === undefined) throw new Error("Open a workspace room before starting this harness.");
    if (room.descriptor?.kind !== "workspace-folder") throw new Error("Open a workspace room before starting this harness.");
    if (room.descriptor.rootPath === null) throw new Error("Open a workspace room before starting this harness.");
    if (room.readOnly === true) {
      throw new Error("Agent runs are unavailable because another Arcelle process owns the workspace writer lease.");
    }
    return room as NativeHarnessRoom;
  }

  protected abstract finishMirror(runId: string, status: HarnessFinalStatus, send: (event: HarnessEvent) => void): Promise<HarnessFinalStatus>;
  protected abstract reviewMassChanges(protection: RunProtection, runId: string, status: HarnessFinalStatus, send: (event: HarnessEvent) => void): Promise<HarnessFinalStatus>;
  protected abstract removeRunRuntime(runId: string): Promise<void>;
}
