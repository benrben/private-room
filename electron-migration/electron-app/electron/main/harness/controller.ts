import { randomUUID } from "node:crypto";
import path from "node:path";
import type { EventSender } from "../turn.js";
import { activePolicy, type PolicyState } from "../privacy.js";
import type { RoomManagerState } from "../roomManager.js";
import {
  workspaceHarnessCapabilities,
  workspaceHarnessFlag,
  type WorkspaceHarnessFlag,
} from "../workspace/featureFlags.js";
import { ClaudeAgentSdkRuntime } from "./claudeAgentSdk.js";
import { CloudRedactedMirror } from "./cloudMirror.js";
import { CodexAppServerRuntime } from "./codexAppServer.js";
import { HarnessOrchestrator, type HarnessFinalStatus } from "./orchestrator.js";
import { RunProtection, type RollbackResult } from "./runProtection.js";
import type {
  ApprovalDecision,
  HarnessEvent,
  HarnessRuntime,
  PrivacyMode,
} from "./types.js";

export interface HarnessStartRequest {
  provider: "codex" | "claude";
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
  runtimes?: Partial<Record<"codex" | "claude", HarnessRuntime>>;
  policy?: () => PolicyState | null;
  flag?: (name: WorkspaceHarnessFlag) => boolean;
  /**
   * Must prove both private-path denial and outside-workspace denial.
   * Production deliberately supplies no verifier until that stronger sandbox
   * exists. The old `.arcelle`-only canary is not enough.
   */
  verifyExposure?: (workspacePath: string) => Promise<boolean>;
  outsideWorkspaceIsolation?: boolean;
}

/** Trusted bridge between room state, provider runtimes and renderer events. */
export class HarnessController {
  private readonly runtimes: Record<"codex" | "claude", HarnessRuntime>;
  private readonly policy: () => PolicyState | null;
  private readonly flag: (name: WorkspaceHarnessFlag) => boolean;
  private readonly verifyExposure: (workspacePath: string) => Promise<boolean>;
  private isolationProven: boolean;
  private readonly mirrors = new Map<string, MirrorRun>();
  private readonly pendingMirrorApprovals = new Map<string, PendingMirrorApproval>();
  private readonly pumps = new Map<string, Promise<void>>();
  private orchestrator: HarnessOrchestrator | null = null;
  private roomId: string | null = null;

  constructor(
    private readonly state: RoomManagerState,
    private readonly userDataDir: string,
    private readonly emit: EventSender,
    options: HarnessControllerOptions = {},
  ) {
    this.runtimes = {
      codex: options.runtimes?.codex ?? new CodexAppServerRuntime(),
      claude: options.runtimes?.claude ?? new ClaudeAgentSdkRuntime(),
    };
    this.policy = options.policy ?? activePolicy;
    this.flag = options.flag ?? workspaceHarnessFlag;
    this.verifyExposure = options.verifyExposure ?? (async () => false);
    this.isolationProven = options.outsideWorkspaceIsolation === true;
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
    const protection = new RunProtection(room.workspace, room.descriptor.roomId);
    const orchestrator = new HarnessOrchestrator(protection, {
      beforeFinish: (runId, status, send) => this.finishMirror(runId, status, send),
    });
    orchestrator.register("codex", this.runtimes.codex);
    orchestrator.register("claude", this.runtimes.claude);
    this.orchestrator = orchestrator;
    this.roomId = room.descriptor.roomId;
    return orchestrator;
  }

  async capabilities(): Promise<HarnessCapabilityReport> {
    const flags = workspaceHarnessCapabilities();
    for (const name of Object.keys(flags) as WorkspaceHarnessFlag[]) flags[name] = this.flag(name);
    const provider = async (name: "codex" | "claude", providerFlag: WorkspaceHarnessFlag) => {
      const enabled = flags.unified_harness && flags[providerFlag] && this.isolationProven;
      const installed = flags[providerFlag] ? await this.runtimes[name].available() : false;
      let reason: string | null = null;
      if (!flags.unified_harness) reason = "The unified harness feature is disabled.";
      else if (!flags[providerFlag]) reason = `The ${name} native harness feature is disabled.`;
      else if (!this.isolationProven) reason = "Outside-workspace process isolation has not passed its security test.";
      else if (!installed) reason = `The ${name} agent runtime is not installed.`;
      return { enabled: enabled && installed, installed, reason };
    };
    return {
      flags,
      roomFormat: this.state.room?.descriptor?.kind ?? null,
      outsideWorkspaceIsolation: this.isolationProven,
      providers: {
        codex: await provider("codex", "codex_app_server"),
        claude: await provider("claude", "claude_agent_sdk"),
      },
    };
  }

  async start(request: HarnessStartRequest): Promise<string> {
    if (!this.flag("unified_harness")) throw new Error("The unified harness feature is disabled.");
    const providerFlag = request.provider === "codex" ? "codex_app_server" : "claude_agent_sdk";
    if (!this.flag(providerFlag)) throw new Error(`The ${request.provider} native harness feature is disabled.`);
    if (!this.isolationProven) {
      throw new Error("Native harness mode is disabled because outside-workspace isolation is not proven.");
    }
    if (request.privacyMode === "local") {
      throw new Error("Codex and Claude are cloud providers. Choose cloud-direct or cloud-redacted privacy mode.");
    }
    const room = this.state.room;
    if (
      room?.workspace === undefined
      || room.descriptor?.kind !== "workspace-folder"
      || room.descriptor.rootPath === null
    ) {
      throw new Error("Open a workspace room before starting this harness.");
    }
    const runId = randomUUID();
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
    }
    if (!(await this.verifyExposure(workspacePath))) {
      this.isolationProven = false;
      await this.removeMirror(runId);
      throw new Error("The native harness exposure failed its sandbox self-test.");
    }

    const orchestrator = this.ensureOrchestrator();
    try {
      const started = await orchestrator.start({
        ...request,
        runId,
        roomId: room.descriptor.roomId,
        workspacePath,
        exposureVerified: true,
      });
      const pump = (async () => {
        try {
          for await (const event of started.events) this.emit("harness-event", event);
        } finally {
          this.pumps.delete(runId);
        }
      })();
      this.pumps.set(runId, pump);
      return runId;
    } catch (error) {
      await this.removeMirror(runId);
      throw error;
    }
  }

  approve(runId: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    if (this.orchestrator === null) throw new Error("No harness run is active.");
    return this.orchestrator.approve(runId, requestId, decision);
  }

  async cancel(runId: string): Promise<void> {
    this.pendingMirrorApprovals.get(runId)?.resolve(false);
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
    await Promise.allSettled([...this.mirrors.keys()].map((id) => this.removeMirror(id)));
  }

  /** Forced synchronous teardown: signal providers and remove cloud exposure now. */
  stopAllNoWait(): void {
    for (const id of this.orchestrator?.activeRunIds() ?? []) {
      this.pendingMirrorApprovals.get(id)?.resolve(false);
      void this.orchestrator?.cancel(id).catch(() => undefined);
    }
    for (const id of this.mirrors.keys()) void this.removeMirror(id).catch(() => undefined);
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

  private async removeMirror(runId: string): Promise<void> {
    const entry = this.mirrors.get(runId);
    this.mirrors.delete(runId);
    if (entry !== undefined) await entry.mirror.cleanup();
  }
}
