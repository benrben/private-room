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
  status:
    | "starting"
    | "running"
    | "waiting"
    | "completed"
    | "cancelled"
    | "failed"
    | "interrupted"
    | "rolled_back";
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

type EventOf<Type extends HarnessEvent["type"]> = Extract<
  HarnessEvent,
  { type: Type }
>;
type EventReducer<Type extends HarnessEvent["type"]> = (
  current: HarnessUiRun,
  event: EventOf<Type>,
) => HarnessUiRun;
type EventReducers = Partial<{
  [Type in HarnessEvent["type"]]: EventReducer<Type>;
}>;

const PROVIDERS: HarnessProvider[] = [
  "codex",
  "claude",
  "ollama-local",
  "ollama-cloud",
  "openrouter",
];
const HARNESSES: HarnessName[] = [
  "codex-app-server",
  "claude-agent-sdk",
  "arcelle-deep",
  "legacy-cli",
];
const HISTORY_RUNNING = new Set(["preparing", "running"]);
const HISTORY_TERMINAL = new Set([
  "completed",
  "cancelled",
  "failed",
  "interrupted",
  "rolled_back",
]);
const LIVE_STATUSES = new Set<HarnessUiRun["status"]>([
  "starting",
  "running",
  "waiting",
]);

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

function historyStatus(status: string): HarnessUiRun["status"] {
  if (HISTORY_RUNNING.has(status)) return "running";
  if (HISTORY_TERMINAL.has(status)) return status as HarnessUiRun["status"];
  return "failed";
}

function knownProvider(provider: string) {
  return PROVIDERS.includes(provider as HarnessProvider)
    ? (provider as HarnessProvider)
    : null;
}

function knownHarness(harness: string) {
  return HARNESSES.includes(harness as HarnessName)
    ? (harness as HarnessName)
    : null;
}

function historyChanges(row: HarnessHistoryRun): HarnessUiChange[] {
  return row.changes.map((change) => ({
    relativePath: change.relativePath,
    change: change.change,
    rollbackState: change.rollbackState,
  }));
}

function historyRun(row: HarnessHistoryRun): HarnessUiRun {
  return {
    ...emptyRun(row.runId),
    provider: knownProvider(row.provider),
    harness: knownHarness(row.harness),
    status: historyStatus(row.status),
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    model: row.model,
    privacyMode: row.privacyMode,
    writeEnabled: row.writeEnabled,
    baselineCompleted: row.baselineCompleted,
    rollbackStatus: row.rollbackStatus,
    changes: historyChanges(row),
  };
}

function provisionalHistory(status: string) {
  return HISTORY_RUNNING.has(status);
}

function liveRun(run: HarnessUiRun) {
  return LIVE_STATUSES.has(run.status);
}

function mergedChanges(
  persisted: HarnessUiChange[],
  current: HarnessUiChange[],
) {
  const changes = new Map(
    persisted.map((change) => [change.relativePath, change]),
  );
  for (const change of current) {
    const durable = changes.get(change.relativePath);
    changes.set(change.relativePath, {
      ...durable,
      ...change,
      rollbackState: change.rollbackState ?? durable?.rollbackState,
    });
  }
  return [...changes.values()];
}

function mergedStatus(
  current: HarnessUiRun,
  persisted: HarnessUiRun,
  persistedStatus: string,
) {
  if (liveRun(current)) return current.status;
  if (provisionalHistory(persistedStatus)) return current.status;
  return persisted.status;
}

function mergeHistoryRun(
  current: HarnessUiRun,
  persisted: HarnessUiRun,
  row: HarnessHistoryRun,
): HarnessUiRun {
  return {
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
    changes: mergedChanges(persisted.changes, current.changes),
    status: mergedStatus(current, persisted, row.status),
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
    next[row.runId] = current
      ? mergeHistoryRun(current, persisted, row)
      : persisted;
  }
  return next;
}

function replaceApproval(
  approvals: HarnessUiApproval[],
  event: EventOf<"approval_requested">,
) {
  return [
    ...approvals.filter((approval) => approval.requestId !== event.requestId),
    { requestId: event.requestId, tool: event.tool, detail: event.detail },
  ];
}

function replaceChange(
  changes: HarnessUiChange[],
  event: EventOf<"file_changed">,
) {
  return [
    ...changes.filter((change) => change.relativePath !== event.relativePath),
    { relativePath: event.relativePath, change: event.change },
  ];
}

const EVENT_REDUCERS: EventReducers = {
  run_started: (current, event) => ({
    ...current,
    harness: event.harness,
    status: "running",
  }),
  plan_updated: (current, event) => ({ ...current, plan: event.text }),
  text_delta: (current, event) => ({
    ...current,
    text: current.text + event.text,
  }),
  approval_requested: (current, event) => ({
    ...current,
    status: "waiting",
    approvals: replaceApproval(current.approvals, event),
  }),
  tool_started: (current, event) => ({
    ...current,
    currentTool: event.tool,
    status: "running",
  }),
  tool_completed: (current) => ({ ...current, currentTool: null }),
  file_changed: (current, event) => ({
    ...current,
    changes: replaceChange(current.changes, event),
  }),
  usage_updated: (current, event) => ({
    ...current,
    inputTokens: event.inputTokens ?? current.inputTokens,
    outputTokens: event.outputTokens ?? current.outputTokens,
    costUsd: event.costUsd ?? current.costUsd,
  }),
  run_failed: (current, event) => ({
    ...current,
    status: "failed",
    completedAt: new Date().toISOString(),
    currentTool: null,
    error: event.error,
  }),
  run_completed: (current, event) => ({
    ...current,
    status: event.status,
    completedAt: new Date().toISOString(),
    currentTool: null,
    approvals: [],
  }),
};

function reduceEvent(current: HarnessUiRun, event: HarnessEvent) {
  const reducer = EVENT_REDUCERS[event.type] as
    | ((run: HarnessUiRun, next: HarnessEvent) => HarnessUiRun)
    | undefined;
  return reducer ? reducer(current, event) : current;
}

/** Fold one normalized main-process event into the renderer's audit record. */
export function applyHarnessEvent(
  runs: HarnessUiRuns,
  event: HarnessEvent,
): HarnessUiRuns {
  const current = runs[event.runId] ?? emptyRun(event.runId);
  return { ...runs, [event.runId]: reduceEvent(current, event) };
}

export function resolveHarnessApproval(
  runs: HarnessUiRuns,
  runId: string,
  requestId: string,
): HarnessUiRuns {
  const current = runs[runId];
  if (!current) return runs;
  const approvals = current.approvals.filter(
    (approval) => approval.requestId !== requestId,
  );
  return {
    ...runs,
    [runId]: {
      ...current,
      approvals,
      status: approvals.length > 0 ? "waiting" : "running",
    },
  };
}
