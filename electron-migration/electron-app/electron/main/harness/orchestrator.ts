import { randomUUID } from "node:crypto";
import { AsyncEventQueue } from "./eventQueue.js";
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

export interface StartHarnessTurn {
  /** Supplied by the trusted controller when it must prepare an exposure first. */
  runId?: string;
  roomId: string;
  provider: string;
  model: string;
  workspacePath: string;
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
    const runtime = this.runtimes.get(input.provider);
    if (runtime === undefined || !(await runtime.available())) {
      throw new Error(`The ${input.provider} harness is not available.`);
    }
    if (input.writeEnabled && this.active.size > 0) {
      throw new Error("Another agent run currently holds the room write lease.");
    }
    if (!input.writeEnabled && [...this.active.values()].some((entry) => entry.writeEnabled)) {
      throw new Error("A write-enabled agent run currently holds the room write lease.");
    }
    const runId = input.runId ?? randomUUID();
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw new Error("The agent run ID is invalid.");
    if (this.active.has(runId)) throw new Error("That agent run ID is already active.");
    const context: HarnessContext = {
      runId,
      roomId: input.roomId,
      provider: input.provider,
      model: input.model,
      workspacePath: input.workspacePath,
      privacyMode: input.privacyMode,
      writeEnabled: input.writeEnabled,
      exposureVerified: input.exposureVerified,
      systemPrompt: input.systemPrompt,
    };
    if (this.protection !== null) await this.protection.createBaseline(context);
    let run: HarnessRun;
    try {
      run = await runtime.startTurn(context, { text: input.text, threadId: input.threadId } satisfies HarnessInput);
    } catch (error) {
      if (this.protection !== null) await this.protection.finish(runId, "failed");
      throw error;
    }
    this.active.set(runId, { run, runtime, writeEnabled: input.writeEnabled });
    const output = new AsyncEventQueue<HarnessEvent>();
    void (async () => {
      let final: HarnessFinalStatus = "failed";
      let failure = "The agent harness ended without a completion event.";
      try {
        for await (const event of run.events) {
          // A provider terminal event is provisional until cloud write-back
          // and the mandatory filesystem reconciliation both succeed.
          if (event.type === "run_completed") final = event.status;
          else if (event.type === "run_failed") {
            final = "failed";
            failure = event.error;
          } else output.push(event);
        }
      } finally {
        try {
          const lifecycleStatus = await this.lifecycle.beforeFinish?.(
            runId,
            final,
            (event) => output.push(event),
          );
          if (lifecycleStatus !== undefined) final = lifecycleStatus;
        } catch (error) {
          final = "failed";
          failure = `Run finalization failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (this.protection !== null) {
          try { await this.protection.finish(runId, final); }
          catch (error) {
            final = "failed";
            failure = `Post-run reconciliation failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        this.active.delete(runId);
        if (final === "failed") output.push({ type: "run_failed", runId, error: failure });
        else output.push({ type: "run_completed", runId, status: final });
        output.end();
      }
    })();
    return { runId, events: output };
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
}
