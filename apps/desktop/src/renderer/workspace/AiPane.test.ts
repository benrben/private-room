import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomInfo } from "../api";
import type { LayoutApi } from "../shell/useLayout";
import type { WSActions } from "./actions";
import AiPane, { groupHistoryRuns } from "./AiPane";
import type { WSState } from "./state";

const { act, createElement } = React;

const bridge = vi.hoisted(() => ({
  harnessCapabilities: vi.fn(), harnessStart: vi.fn(), harnessApprove: vi.fn(),
  harnessCloudWriteback: vi.fn(), harnessCancel: vi.fn(), harnessRollback: vi.fn(),
  harnessListRuns: vi.fn(), harnessRestoreBaselineCopies: vi.fn(), listFiles: vi.fn(),
  setTurnScope: vi.fn(),
}));

vi.mock("../api", () => ({ api: bridge, splitExternalModel: (model: string) => model.split(":", 2) }));
vi.mock("../icons", () => ({ ActivityIcon: () => null, ChatBubbleIcon: () => null, CloseIcon: () => null, CloudIcon: () => null, CollapseRightIcon: () => null, FocusIcon: () => null, SparkIcon: () => null }));
vi.mock("./markup", () => ({ isCloudRoute: (model: string) => model.includes("cloud"), trustState: (cloud: boolean) => ({ tone: cloud ? "cloud" : "local", title: cloud ? "cloud route" : "local route", label: cloud ? "Cloud route" : "On this Mac" }) }));
vi.mock("./browserScope", () => ({ ROOM_ONLY: "room", chatScope: () => ({ scope: "page", available: ["room", "page"], sendsPageText: true }), readablePage: () => null, scopeLabel: (scope: string) => scope, }));
vi.mock("./browserSignal", () => ({ subscribeBrowserPage: () => () => {}, browserPageSnapshot: () => null }));
vi.mock("./sketchFocus", () => ({ subscribeSketchFocus: () => () => {}, currentSketchFocus: () => null }));
vi.mock("./chatActions", () => ({ setTurnScope: bridge.setTurnScope }));
vi.mock("./composer", () => ({ displayName: (name: string) => name.replace(/\.md$/, "") }));
vi.mock("./ChatPane", () => ({ default: () => createElement("div", { "data-screen": "chat" }, "Chat pane") }));
vi.mock("./StudioShelf", () => ({ default: () => createElement("div", { "data-screen": "shelf" }, "Studio shelf") }));
vi.mock("./PodcastPanel", () => ({ default: () => createElement("div", { "data-screen": "podcast" }, "Podcast panel") }));
vi.mock("./jobProgress", () => ({ jobMeter: (_status: string, cursor: number, total: number, live: { done?: number } | undefined) => ({ indeterminate: total === 0, percent: total ? 100 * (live?.done ?? cursor) / total : 0, figure: total ? { done: live?.done ?? cursor, total } : null }) }));
vi.mock("../shell/activity", () => ({
  HISTORY_LIMIT: 4,
  pendingApprovalCount: (s: { scriptApprovals: unknown[]; mcpApprovals: unknown[]; browseConsents: unknown[]; editApprovals: unknown[] }) => s.scriptApprovals.length + s.mcpApprovals.length + s.browseConsents.length + s.editApprovals.length,
  runningJobCount: (s: { jobs: Array<{ status: string }> }) => s.jobs.filter((job) => job.status === "running" || job.status === "queued").length,
  groupActivity: (jobs: Array<{ status: string }>) => ({ active: jobs.filter((job) => job.status === "running" || job.status === "queued"), parked: jobs.filter((job) => job.status === "paused" || job.status === "error"), history: jobs.filter((job) => job.status === "done") }),
}));
vi.mock("./harnessUi", () => ({ registerHarnessRun: (runs: object) => runs, mergeHarnessHistory: (runs: object) => runs, resolveHarnessApproval: (runs: object) => runs }));

const info: RoomInfo = { name: "Room", path: "/room", fileCount: 0, messageCount: 0, synced: false, pendingMcp: null };
const globalKeys = ["document", "window", "navigator", "HTMLElement", "HTMLInputElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function job(overrides: Record<string, unknown> = {}) {
  return { id: "job", title: "Job", kind: "work", status: "running", cursor: 1, total: 4, createdAt: "2026-08-30T10:00:00.000Z", updatedAt: "2026-08-30T10:01:00.000Z", error: null, plan: null, parkedReason: null, ...overrides };
}

function state(overrides: Record<string, unknown> = {}) {
  return {
    aiTab: "chat", setAiTab: vi.fn(), model: "cloud:model", ai: {}, privacyOn: true,
    attachments: [], openFile: null, setLibraryTab: vi.fn(), files: [], jobs: [], jobProgress: {},
    studioStep: { text: "", local: true }, summaryStarting: false, openPodcast: false,
    scriptApprovals: [], mcpApprovals: [], browseConsents: [], editApprovals: [],
    importProgress: null, ocrFiles: [], recSave: null, recLive: null, organized: [], harnessRuns: {}, privacyScanning: false,
    setHarnessRuns: vi.fn(), setFiles: vi.fn(), pushToast: vi.fn(),
    ...overrides,
  } as unknown as WSState;
}

function actions(overrides: Record<string, unknown> = {}) {
  return { startDeepSummary: vi.fn(), viewFile: vi.fn(), dismissJob: vi.fn(), pauseJob: vi.fn(), resumeJob: vi.fn(), ...overrides } as unknown as WSActions;
}

function layout(overrides: Record<string, unknown> = {}) {
  return { toggleFocus: vi.fn(), collapsePane: vi.fn(), showPane: vi.fn(), ...overrides } as unknown as LayoutApi;
}

function resetBridge() {
  for (const mock of Object.values(bridge)) mock.mockReset();
  bridge.harnessCapabilities.mockResolvedValue({ providers: { codex: { enabled: true }, claude: { enabled: false, reason: "not configured" }, "ollama-local": { enabled: true }, "ollama-cloud": { enabled: true }, openrouter: { enabled: true } } });
  bridge.harnessStart.mockResolvedValue({ runId: "new-run" }); bridge.harnessApprove.mockResolvedValue(undefined); bridge.harnessCloudWriteback.mockResolvedValue(undefined); bridge.harnessCancel.mockResolvedValue(undefined); bridge.harnessRollback.mockResolvedValue({ conflicts: [], restored: ["a"], removedCreated: [] }); bridge.harnessListRuns.mockResolvedValue([]); bridge.harnessRestoreBaselineCopies.mockResolvedValue(["a"]); bridge.listFiles.mockResolvedValue([]);
}

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

async function renderPane(s = state(), a = actions(), pageLayout = layout()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window); Reflect.set(globalThis, "document", document);
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: { userAgent: "Vitest" } });
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement); Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement); Reflect.set(globalThis, "Event", window.Event); Reflect.set(globalThis, "React", React); Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client"); const host = document.getElementById("root"); if (!host) throw new Error("test root missing"); const root = createRoot(host);
  await act(async () => root.render(createElement(AiPane, { s, a, info, layout: pageLayout, area: "browser" as never }))); await flush();
  return { host, root, window, s, a, pageLayout };
}

function button(host: Element, label: string) { const found = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim().includes(label)); if (!found) throw new Error(`button not found: ${label}`); return found; }
async function click(node: Element, window: Window & typeof globalThis) { await act(async () => node.dispatchEvent(new window.Event("click", { bubbles: true }))); await flush(); }
async function key(node: Element, window: Window & typeof globalThis, value: string) { const event = new window.Event("keydown", { bubbles: true }); Object.defineProperty(event, "key", { value }); await act(async () => node.dispatchEvent(event)); await flush(); }
function reactProps<T>(node: Element): T { const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps")); if (!key) throw new Error("React props missing"); return (node as unknown as Record<string, unknown>)[key] as T; }
async function change(node: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) { await act(async () => reactProps<{ onChange: (event: { target: { value: string; checked?: boolean } }) => void }>(node).onChange({ target: { value } })); await flush(); }

beforeEach(resetBridge);
afterEach(() => { for (const [key, value] of Object.entries(originalGlobals)) { if (key === "navigator") { Reflect.deleteProperty(globalThis, key); if (originalNavigatorDescriptor) Object.defineProperty(globalThis, key, originalNavigatorDescriptor); continue; } if (value === undefined) Reflect.deleteProperty(globalThis, key); else Reflect.set(globalThis, key, value); } });

describe("AiPane", () => {
  it("keeps chat scope, tabs, keyboard navigation, and pane controls connected", async () => {
    const view = await renderPane(state({ openFile: { id: "drawing", content: { name: "plan.sketch" } } }));
    expect(view.host.textContent).toContain("The page’s text will leave your Mac");
    const scope = view.host.querySelector<HTMLSelectElement>(".context-scope"); if (!scope) throw new Error("scope missing"); await change(scope, "room"); await change(scope, "__pick_files"); expect(view.s.setLibraryTab).toHaveBeenCalledWith("sources"); expect(view.pageLayout.showPane).toHaveBeenCalledWith("library");
    const chat = view.host.querySelector('#ai-tab-chat'); if (!chat) throw new Error("chat tab missing"); for (const value of ["ArrowLeft", "ArrowRight", "Home", "End", "x"]) await key(chat, view.window, value); await click(button(view.host, "Studio"), view.window); await click(button(view.host, "Activity"), view.window); await click(view.host.querySelector('[aria-label="Give the AI pane the full width"]')!, view.window); await click(view.host.querySelector('[aria-label="Collapse the AI pane"]')!, view.window);
    expect(view.s.setAiTab).toHaveBeenCalledWith("studio"); expect(view.s.setAiTab).toHaveBeenCalledWith("activity"); expect(view.pageLayout.toggleFocus).toHaveBeenCalledWith("ai"); expect(view.pageLayout.collapsePane).toHaveBeenCalledWith("ai"); await act(async () => view.root.unmount()); expect(bridge.setTurnScope).toHaveBeenCalled();
  });

  it("renders podcast and studio summary states", async () => {
    const podcast = await renderPane(state({ aiTab: "studio", openPodcast: true, openFile: { id: "script", content: { name: "episode.md" } } })); expect(podcast.host.querySelector('[data-screen="podcast"]')).not.toBeNull(); await act(async () => podcast.root.unmount());
    const a = actions(); const studio = await renderPane(state({ aiTab: "studio", openFile: { id: "file", content: { name: "notes.md" } }, studioStep: { text: "Sending to cloud", local: false }, files: [{ id: "file" }] }), a); expect(studio.host.textContent).toContain("Sending to cloud"); await click(button(studio.host, "Summarize the room"), studio.window); expect(a.startDeepSummary).toHaveBeenCalled(); await act(async () => studio.root.unmount());
  });

  it("shows live, paused, historical, consent, and agent-run activity with its actions", async () => {
    const a = actions();
    const run = { runId: "run", provider: "codex", status: "completed", harness: "native", model: "fast", privacyMode: "cloud-redacted", startedAt: "2026-08-30T10:00:00.000Z", completedAt: "2026-08-30T10:01:00.000Z", plan: "inspect", currentTool: "read", text: "output", error: null, approvals: [{ requestId: "req", tool: "shell", detail: "read files" }, { requestId: "cloud-writeback-run", tool: "cloud_writeback", detail: "write" }], changes: [{ relativePath: "a.md", change: "modified", rollbackState: "conflict" }], inputTokens: 2, outputTokens: 3, costUsd: 0.1, writeEnabled: true, baselineCompleted: true, rollbackStatus: "none" };
    const interrupted = { ...run, runId: "interrupted", status: "interrupted", completedAt: null, plan: null, currentTool: null, text: "", error: "interrupted" };
    const s = state({ aiTab: "activity", scriptApprovals: [{ id: "script", name: "report" }], mcpApprovals: [{ id: "mcp", tool: "delete", server: "tool", confirm: true }], browseConsents: [{ id: "browse", field: "email" }], editApprovals: [{ id: "edit" }], ocrFiles: ["scan-a", "scan-b"], importProgress: { done: 1, total: 3, name: "archive" }, summaryStarting: true, recSave: { startedAt: "2026-08-30T10:00:00.000Z", stage: "writing", remaining: 2 }, recLive: { status: "saving", fileId: "recording" }, studioStep: { text: "Cloud step", local: false }, jobProgress: { file: { done: 3, label: "Reading" }, queued: { done: 0, label: "Queued" } }, jobs: [job({ id: "file", kind: "file_pass", plan: { windows: [1, 2, 3] } }), job({ id: "queued", status: "queued", createdAt: "2026-08-30T11:00:00.000Z" }), job({ id: "paused", status: "paused", parkedReason: "The room was locked" }), job({ id: "paused-reason", status: "paused", total: 0, parkedReason: "The app closed" }), job({ id: "paused-figure", status: "paused", parkedReason: null }), job({ id: "paused-empty", status: "paused", total: 0, parkedReason: null }), job({ id: "error", status: "error", error: "OLLAMA_DOWN" }), job({ id: "error-other", status: "error", error: "OTHER" }), job({ id: "history-a", status: "done", title: "Daily", updatedAt: "2026-07-03T10:00:00.000Z" }), job({ id: "history-b", status: "done", title: "Daily", updatedAt: "2026-07-03T09:00:00.000Z" }), job({ id: "history-old-a", status: "done", title: "Old", cursor: 4, updatedAt: "2025-01-03T10:00:00.000Z" }), job({ id: "history-old-b", status: "done", title: "Old", cursor: 4, updatedAt: "2025-01-03T09:00:00.000Z" })], organized: [{ seq: 1, linked: true, name: "notes.md" }], harnessRuns: { run, interrupted } });
    const view = await renderPane(s, a); expect(view.host.textContent).toContain("Needs your approval"); expect(view.host.textContent).toContain("Waiting — 1st in line"); expect(view.host.textContent).toContain("The local AI isn't running"); expect(view.host.querySelectorAll(".pass-cell").length).toBe(3);
    const dismiss = view.host.querySelector('[aria-label="Dismiss this job"]'); const allow = [...view.host.querySelectorAll(".harness-approval button.primary")]; if (!dismiss || allow.length < 2) throw new Error("activity controls missing"); await click(button(view.host, "Open"), view.window); await click(button(view.host, "Remove"), view.window); await click(button(view.host, "Stop"), view.window); await click(button(view.host, "Resume"), view.window); await click(button(view.host, "Retry"), view.window); await click(dismiss, view.window); await click(allow[0], view.window); await click(allow[1], view.window); await click(button(view.host, "Allow for run"), view.window); await click(button(view.host, "Deny"), view.window); await click(button(view.host, "Restore baselines as copies"), view.window); await click(button(view.host, "Roll back file changes"), view.window); await click(button(view.host, "Show runs"), view.window);
    expect(a.viewFile).toHaveBeenCalledWith("recording"); expect(a.pauseJob).toHaveBeenCalled(); expect(a.resumeJob).toHaveBeenCalled(); expect(a.dismissJob).toHaveBeenCalled(); expect(bridge.harnessApprove).toHaveBeenCalled(); expect(bridge.harnessCloudWriteback).toHaveBeenCalled(); expect(bridge.harnessRollback).toHaveBeenCalledWith("run"); expect(bridge.harnessRestoreBaselineCopies).toHaveBeenCalledWith("run", ["a.md"]); await act(async () => view.root.unmount());
  });

  it("handles harness availability, start failures, cancellation, and an idle room", async () => {
    const idle = await renderPane(state({ aiTab: "activity" })); expect(idle.host.textContent).toContain("The room is idle"); await act(async () => idle.root.unmount());
    const finishing = await renderPane(state({ aiTab: "activity", recLive: { status: "saving", fileId: null } })); expect(finishing.host.textContent).toContain("finishing the transcript"); await act(async () => finishing.root.unmount());
    bridge.harnessCapabilities.mockResolvedValueOnce({ providers: { codex: { enabled: false, reason: "offline" }, claude: { enabled: true }, "ollama-local": { enabled: true }, "ollama-cloud": { enabled: true }, openrouter: { enabled: true } } });
    const s = state({ aiTab: "activity", privacyOn: false, harnessRuns: { live: { runId: "live", provider: "claude", status: "running", harness: "native", model: "default", privacyMode: "cloud-direct", startedAt: "2026-08-30T10:00:00.000Z", completedAt: null, plan: null, currentTool: null, text: "", error: "failed later", approvals: [], changes: [], inputTokens: 0, outputTokens: 0, costUsd: null, writeEnabled: false, baselineCompleted: false, rollbackStatus: "none" } } });
    const view = await renderPane(s); expect(view.host.textContent).toContain("Unavailable: offline"); const prompt = view.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Workspace agent task"]'); const provider = view.host.querySelector<HTMLSelectElement>("select"); if (!prompt || !provider) throw new Error("agent controls missing"); await change(prompt, "organize files"); await click(button(view.host, "Test agents again"), view.window); bridge.harnessStart.mockRejectedValueOnce(new Error("start denied")); await click(button(view.host, "Run with file access"), view.window); expect(s.pushToast).toHaveBeenCalledWith("error", expect.stringContaining("start denied")); bridge.harnessStart.mockResolvedValueOnce({ runId: "started" }); await click(button(view.host, "Run with file access"), view.window); expect(s.setHarnessRuns).toHaveBeenCalled(); await change(provider, "ollama-local"); await click(button(view.host, "Stop"), view.window); expect(bridge.harnessCancel).toHaveBeenCalledWith("live"); await act(async () => view.root.unmount());
  });

  it("groups only adjacent same-day history rows", () => {
    const entries = [job({ id: "one", title: "Same", updatedAt: "2026-08-30T10:00:00.000Z" }), job({ id: "two", title: "Same", updatedAt: "2026-08-30T09:00:00.000Z" }), job({ id: "three", title: "Other", updatedAt: "2026-08-30T08:00:00.000Z" })] as never;
    expect(groupHistoryRuns(entries)).toHaveLength(2);
  });
});
