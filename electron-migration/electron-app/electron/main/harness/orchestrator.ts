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
}

export class HarnessOrchestrator {
  private readonly runtimes = new Map<string, HarnessRuntime>();
  private readonly active = new Map<string, ActiveRun>();

  constructor(private readonly protection: RunProtection | null) {}

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
    const runId = randomUUID();
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
    this.active.set(runId, { run, runtime });
    const output = new AsyncEventQueue<HarnessEvent>();
    void (async () => {
      let final: "completed" | "cancelled" | "failed" = "failed";
      try {
        for await (const event of run.events) {
          output.push(event);
          if (event.type === "run_completed") final = event.status;
          else if (event.type === "run_failed") final = "failed";
        }
      } finally {
        this.active.delete(runId);
        if (this.protection !== null) {
          try { await this.protection.finish(runId, final); }
          catch (error) {
            output.push({ type: "run_failed", runId, error: `Post-run reconciliation failed: ${error instanceof Error ? error.message : String(error)}` });
          }
        }
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
