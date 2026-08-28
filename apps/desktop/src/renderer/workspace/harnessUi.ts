import type {
  HarnessEvent,
  HarnessHistoryRun,
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
  rollbackState?: string | null;
}

export interface HarnessUiRun {
  runId: string;
  provider: HarnessProvider | null;
  harness: HarnessName | null;
  status: "starting" | "running" | "waiting" | "completed" | "cancelled" | "failed" | "interrupted" | "rolled_back";
  startedAt: string;
  completedAt: string | null;
  model: string | null;
  privacyMode: string | null;
  writeEnabled: boolean;
  baselineCompleted: boolean;
  rollbackStatus: string;
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
    completedAt: null,
    model: null,
    privacyMode: null,
    writeEnabled: false,
    baselineCompleted: false,
    rollbackStatus: "none",
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
  metadata: {
    model?: string;
    privacyMode?: string;
    writeEnabled?: boolean;
  } = {},
): HarnessUiRuns {
  const current = runs[runId] ?? emptyRun(runId);
  return {
    ...runs,
    [runId]: {
      ...current,
      provider,
      model: metadata.model ?? current.model,
      privacyMode: metadata.privacyMode ?? current.privacyMode,
      writeEnabled: metadata.writeEnabled ?? current.writeEnabled,
    },
  };
}

const PROVIDERS: HarnessProvider[] = ["codex", "claude", "ollama-local", "ollama-cloud", "openrouter"];
const HARNESSES: HarnessName[] = ["codex-app-server", "claude-agent-sdk", "arcelle-deep", "legacy-cli"];

function historyStatus(status: string): HarnessUiRun["status"] {
  return status === "preparing" || status === "running"
    ? "running"
    : status === "completed" || status === "cancelled" || status === "failed"
      || status === "interrupted" || status === "rolled_back"
      ? status
      : "failed";
}

function historyRun(row: HarnessHistoryRun): HarnessUiRun {
  return {
    ...emptyRun(row.runId),
    provider: PROVIDERS.includes(row.provider as HarnessProvider) ? row.provider as HarnessProvider : null,
    harness: HARNESSES.includes(row.harness as HarnessName) ? row.harness as HarnessName : null,
    status: historyStatus(row.status),
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    model: row.model,
    privacyMode: row.privacyMode,
    writeEnabled: row.writeEnabled,
    baselineCompleted: row.baselineCompleted,
    rollbackStatus: row.rollbackStatus,
    changes: row.changes.map((change) => ({
      relativePath: change.relativePath,
      change: change.change,
      rollbackState: change.rollbackState,
    })),
  };
}

/** Hydrate encrypted history without overwriting newer live streamed state. */
export function mergeHarnessHistory(
  runs: HarnessUiRuns,
  history: readonly HarnessHistoryRun[],
): HarnessUiRuns {
  const next = { ...runs };
  for (const row of history) {
    const persisted = historyRun(row);
    const current = runs[row.runId];
    if (!current) {
      next[row.runId] = persisted;
      continue;
    }
    const persistedIsProvisional = row.status === "preparing" || row.status === "running";
    const currentIsLive = current.status === "starting" || current.status === "running" || current.status === "waiting";
    const changes = new Map(persisted.changes.map((change) => [change.relativePath, change]));
    for (const change of current.changes) {
      const durable = changes.get(change.relativePath);
      changes.set(change.relativePath, {
        ...durable,
        ...change,
        rollbackState: change.rollbackState ?? durable?.rollbackState,
      });
    }
    next[row.runId] = {
      ...persisted,
      ...current,
      provider: current.provider ?? persisted.provider,
      harness: current.harness ?? persisted.harness,
      model: current.model ?? persisted.model,
      privacyMode: current.privacyMode ?? persisted.privacyMode,
      startedAt: persisted.startedAt,
      completedAt: persisted.completedAt ?? current.completedAt,
      writeEnabled: persisted.writeEnabled,
      baselineCompleted: persisted.baselineCompleted,
      rollbackStatus: persisted.rollbackStatus,
      changes: [...changes.values()],
      status: currentIsLive || persistedIsProvisional ? current.status : persisted.status,
    };
  }
  return next;
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
      next = { ...current, status: "failed", completedAt: new Date().toISOString(), currentTool: null, error: event.error };
      break;
    case "run_completed":
      next = {
        ...current,
        status: event.status,
        completedAt: new Date().toISOString(),
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
