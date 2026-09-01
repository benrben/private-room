import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent, HarnessHistoryRun } from "../apiTypes";
import {
  applyHarnessEvent,
  mergeHarnessHistory,
  registerHarnessRun,
  resolveHarnessApproval,
  type HarnessUiRun,
  type HarnessUiRuns,
} from "./harnessUi";

function run(overrides: Partial<HarnessUiRun> = {}): HarnessUiRun {
  return {
    runId: "run-1",
    provider: "codex",
    harness: "codex-app-server",
    status: "completed",
    startedAt: "2026-08-31T09:00:00.000Z",
    completedAt: "2026-08-31T09:10:00.000Z",
    model: "model",
    privacyMode: "local",
    writeEnabled: true,
    baselineCompleted: true,
    rollbackStatus: "none",
    plan: "plan",
    text: "text",
    currentTool: null,
    approvals: [],
    changes: [],
    inputTokens: 1,
    outputTokens: 2,
    costUsd: 0.3,
    error: null,
    ...overrides,
  };
}

function history(
  overrides: Partial<HarnessHistoryRun> = {},
): HarnessHistoryRun {
  return {
    runId: "run-1",
    provider: "codex",
    harness: "codex-app-server",
    model: "persisted-model",
    privacyMode: "cloud-redacted",
    status: "completed",
    writeEnabled: true,
    baselineCompleted: true,
    rollbackStatus: "restored",
    startedAt: "2026-08-31T08:00:00.000Z",
    completedAt: "2026-08-31T08:10:00.000Z",
    changes: [],
    ...overrides,
  };
}

function event(value: HarnessEvent): HarnessEvent {
  return value;
}

afterEach(() => vi.useRealTimers());

describe("harnessUi", () => {
  it("registers placeholders and hydrates persisted history without losing newer live fields", () => {
    const registered = registerHarnessRun({}, "new", "claude", {
      model: "claude-model",
      privacyMode: "cloud-direct",
      writeEnabled: true,
    });
    expect(registered.new).toMatchObject({
      provider: "claude",
      status: "starting",
      model: "claude-model",
      privacyMode: "cloud-direct",
      writeEnabled: true,
    });
    const retained = registerHarnessRun(
      { "run-1": run({ provider: null, model: "kept", privacyMode: "local" }) },
      "run-1",
      "openrouter",
    );
    expect(retained["run-1"]).toMatchObject({
      provider: "openrouter",
      model: "kept",
      privacyMode: "local",
    });

    const invalid = mergeHarnessHistory({}, [
      history({
        runId: "invalid",
        provider: "unknown",
        harness: "unknown",
        status: "mystery",
        changes: [
          {
            fileId: "file",
            relativePath: "a.md",
            change: "created",
            rollbackState: null,
          },
        ],
      }),
    ]);
    expect(invalid.invalid).toMatchObject({
      provider: null,
      harness: null,
      status: "failed",
      changes: [
        { relativePath: "a.md", change: "created", rollbackState: null },
      ],
    });

    const live = run({
      status: "waiting",
      provider: null,
      model: null,
      privacyMode: null,
      completedAt: null,
      changes: [
        { relativePath: "a.md", change: "modified", rollbackState: null },
        { relativePath: "b.md", change: "created", rollbackState: "removed" },
      ],
    });
    const merged = mergeHarnessHistory({ "run-1": live }, [
      history({
        changes: [
          {
            fileId: "file",
            relativePath: "a.md",
            change: "persisted",
            rollbackState: "restored",
          },
        ],
      }),
    ]);
    expect(merged["run-1"]).toMatchObject({
      status: "waiting",
      provider: "codex",
      model: "persisted-model",
      privacyMode: "cloud-redacted",
      completedAt: "2026-08-31T08:10:00.000Z",
      rollbackStatus: "restored",
      changes: [
        { relativePath: "a.md", change: "modified", rollbackState: "restored" },
        { relativePath: "b.md", change: "created", rollbackState: "removed" },
      ],
    });

    const finished = mergeHarnessHistory(
      { "run-1": run({ status: "failed", provider: null, harness: null }) },
      [history({ status: "cancelled", completedAt: null })],
    );
    expect(finished["run-1"].status).toBe("cancelled");
  });

  it("folds every streamed event into one ordered audit record", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
    let runs: HarnessUiRuns = {};
    const fold = (value: HarnessEvent) => {
      runs = applyHarnessEvent(runs, value);
    };
    fold(
      event({
        type: "run_started",
        runId: "run-1",
        harness: "claude-agent-sdk",
      }),
    );
    fold(event({ type: "plan_updated", runId: "run-1", text: "Plan" }));
    fold(event({ type: "text_delta", runId: "run-1", text: "hello " }));
    fold(event({ type: "text_delta", runId: "run-1", text: "world" }));
    fold(
      event({
        type: "approval_requested",
        runId: "run-1",
        requestId: "one",
        tool: "read",
        detail: "first",
      }),
    );
    fold(
      event({
        type: "approval_requested",
        runId: "run-1",
        requestId: "one",
        tool: "write",
        detail: "replacement",
      }),
    );
    fold(event({ type: "tool_started", runId: "run-1", tool: "write" }));
    fold(event({ type: "tool_completed", runId: "run-1", tool: "write" }));
    fold(
      event({
        type: "file_changed",
        runId: "run-1",
        relativePath: "a.md",
        change: "created",
      }),
    );
    fold(
      event({
        type: "file_changed",
        runId: "run-1",
        relativePath: "a.md",
        change: "modified",
      }),
    );
    fold(
      event({
        type: "usage_updated",
        runId: "run-1",
        inputTokens: 12,
        outputTokens: 9,
        costUsd: 0.42,
      }),
    );
    fold(event({ type: "usage_updated", runId: "run-1" }));
    fold(event({ type: "run_failed", runId: "run-1", error: "offline" }));
    expect(runs["run-1"]).toMatchObject({
      status: "failed",
      plan: "Plan",
      text: "hello world",
      currentTool: null,
      approvals: [{ requestId: "one", tool: "write", detail: "replacement" }],
      changes: [{ relativePath: "a.md", change: "modified" }],
      inputTokens: 12,
      outputTokens: 9,
      costUsd: 0.42,
      error: "offline",
      completedAt: "2026-08-31T12:00:00.000Z",
    });
    fold(event({ type: "run_completed", runId: "run-1", status: "cancelled" }));
    fold(event({ type: "agent_started", runId: "run-1", agentId: "agent" }));
    fold(event({ type: "agent_completed", runId: "run-1", agentId: "agent" }));
    fold(
      event({
        type: "tool_requested",
        runId: "run-1",
        requestId: "two",
        tool: "read",
        input: {},
      }),
    );
    expect(runs["run-1"]).toMatchObject({
      status: "cancelled",
      approvals: [],
      currentTool: null,
      completedAt: "2026-08-31T12:00:00.000Z",
    });
  });

  it("resolves approvals only for live records and returns to running after the last one", () => {
    const missing: HarnessUiRuns = {};
    expect(resolveHarnessApproval(missing, "missing", "request")).toBe(missing);
    const runs: HarnessUiRuns = {
      "run-1": run({
        status: "waiting",
        approvals: [
          { requestId: "one", tool: "read", detail: "first" },
          { requestId: "two", tool: "write", detail: "second" },
        ],
      }),
    };
    const once = resolveHarnessApproval(runs, "run-1", "one");
    expect(once["run-1"]).toMatchObject({
      status: "waiting",
      approvals: [runs["run-1"].approvals[1]],
    });
    const twice = resolveHarnessApproval(once, "run-1", "two");
    expect(twice["run-1"]).toMatchObject({ status: "running", approvals: [] });
  });
});
