import { describe, expect, it, vi } from "vitest";
import { AsyncEventQueue } from "./eventQueue.js";
import { HarnessOrchestrator, type StartHarnessTurn } from "./orchestrator.js";
import type { RunProtection } from "./runProtection.js";
import type { HarnessEvent, HarnessRun, HarnessRuntime } from "./types.js";

class FakeRuntime implements HarnessRuntime {
  readonly name = "legacy-cli" as const;
  readonly events = new AsyncEventQueue<HarnessEvent>();
  availableResult = true;
  startFailure: Error | null = null;
  readonly approvals: Array<{ requestId: string; decision: string }> = [];
  cancelCount = 0;

  async available(): Promise<boolean> { return this.availableResult; }
  async startTurn(): Promise<HarnessRun> {
    if (this.startFailure !== null) throw this.startFailure;
    return {
      events: this.events,
      cancel: async () => { this.cancelCount += 1; },
      approve: async (requestId, decision) => { this.approvals.push({ requestId, decision }); },
    };
  }
}

function input(overrides: Partial<StartHarnessTurn> = {}): StartHarnessTurn {
  return {
    runId: "run-one",
    roomId: "room-one",
    provider: "fake",
    model: "test",
    workspacePath: "/tmp",
    runtimePath: "/tmp/run-one",
    privacyMode: "local",
    writeEnabled: false,
    exposureVerified: true,
    text: "hello",
    ...overrides,
  };
}

async function collected(events: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const received: HarnessEvent[] = [];
  for await (const event of events) received.push(event);
  return received;
}

describe("HarnessOrchestrator", () => {
  it("publishes one terminal event only after lifecycle finalization", async () => {
    const runtime = new FakeRuntime();
    const orchestrator = new HarnessOrchestrator(null, {
      beforeFinish: async (runId, status, emit) => {
        expect(status).toBe("completed");
        emit({ type: "file_changed", runId, relativePath: "notes.md", change: "modified" });
      },
    });
    orchestrator.register("fake", runtime);
    const started = await orchestrator.start(input());
    runtime.events.push({ type: "run_started", runId: started.runId, harness: "legacy-cli" });
    runtime.events.push({ type: "run_completed", runId: started.runId, status: "completed" });
    runtime.events.end();
    const received = await collected(started.events);
    expect(received.map((event) => event.type)).toEqual([
      "run_started",
      "file_changed",
      "run_completed",
    ]);
  });

  it("does not allow a read run to overlap the room write lease", async () => {
    const runtime = new FakeRuntime();
    const orchestrator = new HarnessOrchestrator(null);
    orchestrator.register("fake", runtime);
    await orchestrator.start(input({ runId: "write-run", writeEnabled: true, text: "write" }));
    await expect(orchestrator.start(input({ runId: "read-run", text: "read" }))).rejects.toThrow(/write lease/i);
    runtime.events.push({ type: "run_completed", runId: "write-run", status: "completed" });
    runtime.events.end();
  });

  it("does not allow a write run to overlap an active read run", async () => {
    const runtime = new FakeRuntime();
    const orchestrator = new HarnessOrchestrator(null);
    orchestrator.register("fake", runtime);
    const started = await orchestrator.start(input({ runId: "read-run" }));
    await expect(orchestrator.start(input({ runId: "write-run", writeEnabled: true })))
      .rejects.toThrow("Another agent run currently holds the room write lease.");
    runtime.events.push({ type: "run_completed", runId: started.runId, status: "completed" });
    runtime.events.end();
    await collected(started.events);
  });

  it("rejects unavailable runtimes and invalid or duplicate run IDs", async () => {
    const unavailable = new FakeRuntime();
    unavailable.availableResult = false;
    const unavailableOrchestrator = new HarnessOrchestrator(null);
    unavailableOrchestrator.register("fake", unavailable);
    await expect(unavailableOrchestrator.start(input())).rejects.toThrow("The fake harness is not available.");

    const runtime = new FakeRuntime();
    const orchestrator = new HarnessOrchestrator(null);
    orchestrator.register("fake", runtime);
    await expect(orchestrator.start(input({ runId: "not valid" }))).rejects.toThrow("The agent run ID is invalid.");
    const started = await orchestrator.start(input());
    await expect(orchestrator.start(input())).rejects.toThrow("That agent run ID is already active.");
    runtime.events.push({ type: "run_completed", runId: started.runId, status: "completed" });
    runtime.events.end();
    await collected(started.events);
  });

  it("forwards approvals and cancellation only while a run remains active", async () => {
    const runtime = new FakeRuntime();
    const orchestrator = new HarnessOrchestrator(null);
    orchestrator.register("fake", runtime);
    const started = await orchestrator.start(input());
    expect(orchestrator.activeRunIds()).toEqual([started.runId]);
    expect(() => orchestrator.rollback(started.runId)).toThrow("Stop the agent run before rolling it back.");
    expect(() => orchestrator.restoreBaselineAsCopies(started.runId, [])).toThrow("Stop the agent run before restoring its baseline.");
    await orchestrator.approve(started.runId, "request-1", "allow-once");
    await orchestrator.cancel(started.runId);
    expect(runtime.approvals).toEqual([{ requestId: "request-1", decision: "allow-once" }]);
    expect(runtime.cancelCount).toBe(1);
    runtime.events.push({ type: "run_completed", runId: started.runId, status: "cancelled" });
    runtime.events.end();
    expect(await collected(started.events)).toEqual([{ type: "run_completed", runId: started.runId, status: "cancelled" }]);
    await expect(orchestrator.approve(started.runId, "request-2", "deny"))
      .rejects.toThrow("That agent run is no longer active.");
    await expect(orchestrator.cancel(started.runId)).resolves.toBeUndefined();
  });

  it("normalizes missing and lifecycle-failed terminal events without leaking errors", async () => {
    const missingRuntime = new FakeRuntime();
    const missing = new HarnessOrchestrator(null);
    missing.register("fake", missingRuntime);
    const missingStarted = await missing.start(input());
    missingRuntime.events.end();
    await expect(collected(missingStarted.events)).resolves.toEqual([
      expect.objectContaining({ type: "run_failed", runId: missingStarted.runId, error: expect.stringContaining("Provider diagnostics were omitted") }),
    ]);

    const lifecycleRuntime = new FakeRuntime();
    const lifecycle = new HarnessOrchestrator(null, {
      beforeFinish: async () => { throw new Error("private cloud response"); },
    });
    lifecycle.register("fake", lifecycleRuntime);
    const lifecycleStarted = await lifecycle.start(input());
    lifecycleRuntime.events.push({ type: "run_completed", runId: lifecycleStarted.runId, status: "completed" });
    lifecycleRuntime.events.end();
    await expect(collected(lifecycleStarted.events)).resolves.toEqual([
      expect.objectContaining({ type: "run_failed", error: expect.stringContaining("Raw diagnostics were omitted") }),
    ]);

    const failedRuntime = new FakeRuntime();
    const failed = new HarnessOrchestrator(null);
    failed.register("fake", failedRuntime);
    const failedStarted = await failed.start(input());
    failedRuntime.events.push({ type: "run_failed", runId: failedStarted.runId, error: "runtime refused request" });
    failedRuntime.events.end();
    await expect(collected(failedStarted.events)).resolves.toEqual([
      { type: "run_failed", runId: failedStarted.runId, error: "runtime refused request" },
    ]);
  });

  it("finishes a protected baseline after startup failure and redacts finalization failure", async () => {
    const startupRuntime = new FakeRuntime();
    startupRuntime.startFailure = new Error("private startup details");
    const startupProtection = {
      createBaseline: vi.fn(async () => undefined),
      finish: vi.fn(async () => undefined),
    } as unknown as RunProtection;
    const startup = new HarnessOrchestrator(startupProtection);
    startup.register("fake", startupRuntime);
    await expect(startup.start(input())).rejects.toThrow("private startup details");
    expect(startupProtection.createBaseline).toHaveBeenCalledTimes(1);
    expect(startupProtection.finish).toHaveBeenCalledWith("run-one", "failed");

    const finalRuntime = new FakeRuntime();
    const finalProtection = {
      createBaseline: vi.fn(async () => undefined),
      finish: vi.fn(async () => { throw new Error("raw filesystem failure"); }),
    } as unknown as RunProtection;
    const finalization = new HarnessOrchestrator(finalProtection);
    finalization.register("fake", finalRuntime);
    const started = await finalization.start(input());
    finalRuntime.events.push({ type: "run_completed", runId: started.runId, status: "completed" });
    finalRuntime.events.end();
    await expect(collected(started.events)).resolves.toEqual([
      expect.objectContaining({ type: "run_failed", error: expect.stringContaining("Raw diagnostics were omitted") }),
    ]);
  });

  it("delegates rollback history and copy restoration only when protection exists", async () => {
    const protection = {
      rollback: vi.fn(async () => ({ restored: ["notes.txt"], removedCreated: [], conflicts: [] })),
      restoreBaselineAsCopies: vi.fn(async () => ["notes (baseline).txt"]),
      listHistory: vi.fn(async () => []),
      recordHarness: vi.fn(),
    } as unknown as RunProtection;
    const orchestrator = new HarnessOrchestrator(protection);

    await expect(orchestrator.rollback("finished-run"))
      .resolves.toEqual({ restored: ["notes.txt"], removedCreated: [], conflicts: [] });
    await expect(orchestrator.restoreBaselineAsCopies("finished-run", ["notes.txt"]))
      .resolves.toEqual(["notes (baseline).txt"]);
    await expect(orchestrator.listHistory(["external-run"], false)).resolves.toEqual([]);
    orchestrator.recordHarness("finished-run", "legacy-cli");
    expect(protection.listHistory).toHaveBeenCalledWith(["external-run"], false);
    expect(protection.recordHarness).toHaveBeenCalledWith("finished-run", "legacy-cli");

    const withoutProtection = new HarnessOrchestrator(null);
    expect(() => withoutProtection.rollback("finished-run")).toThrow("Rollback is unavailable for this room format.");
    expect(() => withoutProtection.restoreBaselineAsCopies("finished-run", [])).toThrow("Rollback is unavailable for this room format.");
    await expect(withoutProtection.listHistory()).resolves.toEqual([]);
    withoutProtection.recordHarness("finished-run", "legacy-cli");
  });
});
