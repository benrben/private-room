import { randomUUID } from "node:crypto";
import { AsyncEventQueue } from "./eventQueue.js";
import { safeFinalizationFailure, safeProviderFailure } from "./failureSafety.js";
import { RunProtection, type RollbackResult } from "./runProtection.js";
import type {
  ApprovalDecision,
  HarnessContext,
  HarnessEvent,
  HarnessInput,
  HarnessRun,
  HarnessRuntime,
  PrivacyMode,
} from "./types.js";
import type { HarnessHistoryRun } from "../../shared/harnessTypes.js";

export interface StartHarnessTurn {
  /** Supplied by the trusted controller when it must prepare an exposure first. */
  runId?: string;
  roomId: string;
  provider: string;
  model: string;
  workspacePath: string;
  runtimePath: string;
  privacyMode: PrivacyMode;
  writeEnabled: boolean;
  exposureVerified: boolean;
  text: string;
  threadId?: string;
  systemPrompt?: string;
}

interface ActiveRun {
  run: HarnessRun;
  runtime: HarnessRuntime;
  writeEnabled: boolean;
}

interface RunOutcome {
  final: HarnessFinalStatus;
  failure: string;
}

export type HarnessFinalStatus = "completed" | "cancelled" | "failed";

export interface HarnessRunLifecycle {
  beforeFinish?(
    runId: string,
    status: HarnessFinalStatus,
    emit: (event: HarnessEvent) => void,
  ): Promise<HarnessFinalStatus | void>;
}

export class HarnessOrchestrator {
  private readonly runtimes = new Map<string, HarnessRuntime>();
  private readonly active = new Map<string, ActiveRun>();

  constructor(
    private readonly protection: RunProtection | null,
    private readonly lifecycle: HarnessRunLifecycle = {},
  ) {}

  register(provider: string, runtime: HarnessRuntime): void {
    this.runtimes.set(provider, runtime);
  }

  async start(input: StartHarnessTurn): Promise<{ runId: string; events: AsyncIterable<HarnessEvent> }> {
    const runtime = await this.availableRuntime(input.provider);
    this.requireAvailableLease(input.writeEnabled);
    const runId = this.newRunId(input.runId);
    const context = this.contextFor(runId, input);
    const run = await this.startRuntime(runtime, context, input);
    return this.activateRun(runId, run, runtime, input);
  }

  private async availableRuntime(provider: string): Promise<HarnessRuntime> {
    const runtime = this.runtimes.get(provider);
    if (runtime === undefined || !(await runtime.available())) {
      throw new Error(`The ${provider} harness is not available.`);
    }
    return runtime;
  }

  private requireAvailableLease(writeEnabled: boolean): void {
    if (writeEnabled && this.active.size > 0) {
      throw new Error("Another agent run currently holds the room write lease.");
    }
    if (!writeEnabled && [...this.active.values()].some((entry) => entry.writeEnabled)) {
      throw new Error("A write-enabled agent run currently holds the room write lease.");
    }
  }

  private newRunId(requestedRunId: string | undefined): string {
    const runId = requestedRunId ?? randomUUID();
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw new Error("The agent run ID is invalid.");
    if (this.active.has(runId)) throw new Error("That agent run ID is already active.");
    return runId;
  }

  private contextFor(runId: string, input: StartHarnessTurn): HarnessContext {
    return {
      runId,
      roomId: input.roomId,
      provider: input.provider,
      model: input.model,
      workspacePath: input.workspacePath,
      runtimePath: input.runtimePath,
      privacyMode: input.privacyMode,
      writeEnabled: input.writeEnabled,
      exposureVerified: input.exposureVerified,
      systemPrompt: input.systemPrompt,
    };
  }

  private async startRuntime(
    runtime: HarnessRuntime,
    context: HarnessContext,
    input: StartHarnessTurn,
  ): Promise<HarnessRun> {
    if (this.protection !== null) await this.protection.createBaseline(context);
    try {
      return await runtime.startTurn(context, { text: input.text, threadId: input.threadId } satisfies HarnessInput);
    } catch (error) {
      if (this.protection !== null) await this.protection.finish(context.runId, "failed");
      throw error;
    }
  }

  private activateRun(
    runId: string,
    run: HarnessRun,
    runtime: HarnessRuntime,
    input: StartHarnessTurn,
  ): { runId: string; events: AsyncIterable<HarnessEvent> } {
    this.active.set(runId, { run, runtime, writeEnabled: input.writeEnabled });
    const output = new AsyncEventQueue<HarnessEvent>();
    void this.relayEvents(runId, run, input.provider, output);
    return { runId, events: output };
  }

  private async relayEvents(
    runId: string,
    run: HarnessRun,
    provider: string,
    output: AsyncEventQueue<HarnessEvent>,
  ): Promise<void> {
    const outcome: RunOutcome = {
      final: "failed",
      failure: "The agent harness ended without a completion event.",
    };
    try {
      for await (const event of run.events) this.applyRunEvent(event, outcome, output);
    } finally {
      await this.applyLifecycle(runId, outcome, output);
      await this.finishProtection(runId, outcome);
      this.active.delete(runId);
      this.pushTerminalEvent(runId, provider, outcome, output);
      output.end();
    }
  }

  private applyRunEvent(
    event: HarnessEvent,
    outcome: RunOutcome,
    output: AsyncEventQueue<HarnessEvent>,
  ): void {
    // A provider terminal event is provisional until cloud write-back and the
    // mandatory filesystem reconciliation both succeed.
    if (event.type === "run_completed") {
      outcome.final = event.status;
      return;
    }
    if (event.type === "run_failed") {
      outcome.final = "failed";
      outcome.failure = event.error;
      return;
    }
    output.push(event);
  }

  private async applyLifecycle(
    runId: string,
    outcome: RunOutcome,
    output: AsyncEventQueue<HarnessEvent>,
  ): Promise<void> {
    try {
      const lifecycleStatus = await this.lifecycle.beforeFinish?.(runId, outcome.final, (event) => output.push(event));
      if (lifecycleStatus !== undefined) outcome.final = lifecycleStatus;
    } catch (error) {
      outcome.final = "failed";
      outcome.failure = safeFinalizationFailure("write-back");
    }
  }

  private async finishProtection(runId: string, outcome: RunOutcome): Promise<void> {
    if (this.protection === null) return;
    try {
      await this.protection.finish(runId, outcome.final);
    } catch (error) {
      outcome.final = "failed";
      outcome.failure = safeFinalizationFailure("reconciliation");
    }
  }

  private pushTerminalEvent(
    runId: string,
    provider: string,
    outcome: RunOutcome,
    output: AsyncEventQueue<HarnessEvent>,
  ): void {
    if (outcome.final === "failed") {
      const error = outcome.failure === "The agent harness ended without a completion event."
        ? safeProviderFailure(provider)
        : outcome.failure;
      output.push({ type: "run_failed", runId, error });
      return;
    }
    output.push({ type: "run_completed", runId, status: outcome.final });
  }

  async approve(runId: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    const active = this.active.get(runId);
    if (active === undefined) throw new Error("That agent run is no longer active.");
    await active.run.approve(requestId, decision);
  }

  async cancel(runId: string): Promise<void> {
    const active = this.active.get(runId);
    if (active === undefined) return;
    await active.run.cancel();
  }

  activeRunIds(): string[] {
    return [...this.active.keys()];
  }

  rollback(runId: string): Promise<RollbackResult> {
    if (this.active.has(runId)) throw new Error("Stop the agent run before rolling it back.");
    if (this.protection === null) throw new Error("Rollback is unavailable for this room format.");
    return this.protection.rollback(runId);
  }

  restoreBaselineAsCopies(runId: string, relativePaths: string[]): Promise<string[]> {
    if (this.active.has(runId)) throw new Error("Stop the agent run before restoring its baseline.");
    if (this.protection === null) throw new Error("Rollback is unavailable for this room format.");
    return this.protection.restoreBaselineAsCopies(runId, relativePaths);
  }

  listHistory(
    additionalActiveRunIds: readonly string[] = [],
    recoverStale = true,
  ): Promise<HarnessHistoryRun[]> {
    if (this.protection === null) return Promise.resolve([]);
    return this.protection.listHistory(
      [...new Set([...this.activeRunIds(), ...additionalActiveRunIds])],
      recoverStale,
    );
  }

  recordHarness(runId: string, harness: string): void {
    this.protection?.recordHarness(runId, harness);
  }
}
