import { describe, expect, it } from "vitest";
import { AsyncEventQueue } from "./eventQueue.js";
import { HarnessOrchestrator } from "./orchestrator.js";
import type { HarnessEvent, HarnessRun, HarnessRuntime } from "./types.js";

class FakeRuntime implements HarnessRuntime {
  readonly name = "legacy-cli" as const;
  readonly events = new AsyncEventQueue<HarnessEvent>();
  async available(): Promise<boolean> { return true; }
  async startTurn(): Promise<HarnessRun> {
    return {
      events: this.events,
      cancel: async () => undefined,
      approve: async () => undefined,
    };
  }
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
    const started = await orchestrator.start({
      runId: "run-one",
      roomId: "room-one",
      provider: "fake",
      model: "test",
      workspacePath: "/tmp",
      privacyMode: "local",
      writeEnabled: false,
      exposureVerified: true,
      text: "hello",
    });
    runtime.events.push({ type: "run_started", runId: started.runId, harness: "legacy-cli" });
    runtime.events.push({ type: "run_completed", runId: started.runId, status: "completed" });
    runtime.events.end();
    const received: HarnessEvent[] = [];
    for await (const event of started.events) received.push(event);
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
    await orchestrator.start({
      runId: "write-run",
      roomId: "room-one",
      provider: "fake",
      model: "test",
      workspacePath: "/tmp",
      privacyMode: "local",
      writeEnabled: true,
      exposureVerified: true,
      text: "write",
    });
    await expect(orchestrator.start({
      runId: "read-run",
      roomId: "room-one",
      provider: "fake",
      model: "test",
      workspacePath: "/tmp",
      privacyMode: "local",
      writeEnabled: false,
      exposureVerified: true,
      text: "read",
    })).rejects.toThrow(/write lease/i);
    runtime.events.push({ type: "run_completed", runId: "write-run", status: "completed" });
    runtime.events.end();
  });
});
