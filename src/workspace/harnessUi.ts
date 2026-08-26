import type {
  HarnessEvent,
  HarnessName,
  HarnessProvider,
} from "../apiTypes";

export interface HarnessUiApproval {
  requestId: string;
  tool: string;
  detail: string;
}

export interface HarnessUiChange {
  relativePath: string;
  change: string;
}

export interface HarnessUiRun {
  runId: string;
  provider: HarnessProvider | null;
  harness: HarnessName | null;
  status: "starting" | "running" | "waiting" | "completed" | "cancelled" | "failed";
  startedAt: string;
  plan: string;
  text: string;
  currentTool: string | null;
  approvals: HarnessUiApproval[];
  changes: HarnessUiChange[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  error: string | null;
}

export type HarnessUiRuns = Record<string, HarnessUiRun>;

function emptyRun(runId: string): HarnessUiRun {
  return {
    runId,
    provider: null,
    harness: null,
    status: "starting",
    startedAt: new Date().toISOString(),
    plan: "",
    text: "",
    currentTool: null,
    approvals: [],
    changes: [],
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    error: null,
  };
}

export function registerHarnessRun(
  runs: HarnessUiRuns,
  runId: string,
  provider: HarnessProvider,
): HarnessUiRuns {
  const current = runs[runId] ?? emptyRun(runId);
  return { ...runs, [runId]: { ...current, provider } };
}

/** Fold one normalized main-process event into the renderer's audit record. */
export function applyHarnessEvent(
  runs: HarnessUiRuns,
  event: HarnessEvent,
): HarnessUiRuns {
  const current = runs[event.runId] ?? emptyRun(event.runId);
  let next = current;
  switch (event.type) {
    case "run_started":
      next = { ...current, harness: event.harness, status: "running" };
      break;
    case "plan_updated":
      next = { ...current, plan: event.text };
      break;
    case "text_delta":
      next = { ...current, text: current.text + event.text };
      break;
    case "approval_requested":
      next = {
        ...current,
        status: "waiting",
        approvals: [
          ...current.approvals.filter((row) => row.requestId !== event.requestId),
          { requestId: event.requestId, tool: event.tool, detail: event.detail },
        ],
      };
      break;
    case "tool_started":
      next = { ...current, currentTool: event.tool, status: "running" };
      break;
    case "tool_completed":
      next = { ...current, currentTool: null };
      break;
    case "file_changed": {
      const changes = current.changes.filter(
        (row) => row.relativePath !== event.relativePath,
      );
      next = {
        ...current,
        changes: [...changes, { relativePath: event.relativePath, change: event.change }],
      };
      break;
    }
    case "usage_updated":
      next = {
        ...current,
        inputTokens: event.inputTokens ?? current.inputTokens,
        outputTokens: event.outputTokens ?? current.outputTokens,
        costUsd: event.costUsd ?? current.costUsd,
      };
      break;
    case "run_failed":
      next = { ...current, status: "failed", currentTool: null, error: event.error };
      break;
    case "run_completed":
      next = {
        ...current,
        status: event.status,
        currentTool: null,
        approvals: [],
      };
      break;
    case "agent_started":
    case "agent_completed":
    case "tool_requested":
      break;
  }
  return { ...runs, [event.runId]: next };
}

export function resolveHarnessApproval(
  runs: HarnessUiRuns,
  runId: string,
  requestId: string,
): HarnessUiRuns {
  const current = runs[runId];
  if (!current) return runs;
  const approvals = current.approvals.filter((row) => row.requestId !== requestId);
  return {
    ...runs,
    [runId]: {
      ...current,
      approvals,
      status: approvals.length > 0 ? "waiting" : "running",
    },
  };
}
