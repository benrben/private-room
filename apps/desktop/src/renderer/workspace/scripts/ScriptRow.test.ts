import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScriptRow } from "./ScriptRow";

const { act, createElement } = React;
const mocks = vi.hoisted(() => ({ getWorkflowRuns: vi.fn() }));

vi.mock("../../api", () => ({ api: { getWorkflowRuns: mocks.getWorkflowRuns } }));
vi.mock("../../icons", () => ({ ScriptIcon: () => null, PlayIcon: () => null, ClockIcon: () => null }));
vi.mock("../workflows/SchedulePopover", () => ({
  SchedulePopover: ({ onClose, onSave }: { onClose: () => void; onSave: (arg: Record<string, unknown>) => void }) => createElement("div", null,
    createElement("button", { onClick: () => onSave({ kind: "daily", param: "09:00" }) }, "save schedule"),
    createElement("button", { onClick: onClose }, "close schedule"),
  ),
}));
vi.mock("../workflows/RunHistory", () => ({
  RunHistory: ({ runs }: { runs: Array<{ id: string }> }) => createElement("div", null, `history count ${runs.length}`),
}));

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  navigator: globalThis.navigator,
  HTMLElement: globalThis.HTMLElement,
  Event: globalThis.Event,
  React: Reflect.get(globalThis, "React"),
  IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT"),
};

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

function script(overrides: Record<string, unknown> = {}) {
  return {
    fileId: "script-1",
    name: "report.py",
    lang: "py",
    deps: [],
    inputs: [],
    outputs: [],
    shortcut: "none",
    approved: true,
    changedSinceApproval: false,
    workflowId: null,
    schedule: null,
    lastRun: null,
    consecutiveFailures: 0,
    lastError: null,
    ...overrides,
  } as Record<string, any>;
}

function state(overrides: Record<string, unknown> = {}) {
  return { jobProgress: {}, ...overrides } as Record<string, any>;
}

function actions(overrides: Record<string, unknown> = {}) {
  return {
    viewFile: vi.fn(),
    runScript: vi.fn(),
    scheduleScript: vi.fn(),
    ...overrides,
  } as Record<string, any>;
}

async function renderRow(initial = script(), initialState = state(), a = actions()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const draw = async (next = initial, nextState = initialState) => act(async () => {
    root.render(createElement(ScriptRow, { sc: next as never, s: nextState as never, a: a as never }));
    await Promise.resolve();
  });
  await draw();
  return { a, draw, host, root, window };
}

async function click(view: Awaited<ReturnType<typeof renderRow>>, text: string) {
  const button = [...view.host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`button not found: ${text}`);
  await act(async () => {
    button.dispatchEvent(new view.window.Event("click", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("ScriptRow", () => {
  it("shows one actionable incident with manifest, schedule, and history controls", async () => {
    mocks.getWorkflowRuns.mockResolvedValueOnce([{ id: "run-1" }]);
    const sc = script({
      deps: ["pandas"],
      inputs: ["input.csv"],
      outputs: ["report.csv"],
      shortcut: "global",
      changedSinceApproval: true,
      workflowId: "workflow-1",
      schedule: { kind: "daily", enabled: true, param: "09:00", catchUp: true },
      consecutiveFailures: 2,
      lastError: "The script failed\nImportError: pandas\n\nCouldn't auto-install 'pandas'. Ask the assistant.",
    });
    const view = await renderRow(sc);
    expect(view.host.textContent).toContain("Needs review");
    expect(view.host.textContent).toContain("Failed 2×");
    expect(view.host.textContent).toContain("ImportError: pandas");
    expect(view.host.textContent).toContain("Couldn't auto-install 'pandas'. Ask the assistant.");
    expect(view.host.textContent).toContain("Installs");
    expect(view.host.textContent).toContain("top-bar shortcut");
    await click(view, "Open to fix");
    await click(view, "Run current version");
    await click(view, "Run");
    await click(view, "daily");
    await click(view, "save schedule");
    await click(view, "close schedule");
    await click(view, "Runs");
    expect(mocks.getWorkflowRuns).toHaveBeenCalledWith("workflow-1");
    expect(view.host.textContent).toContain("Run history");
    expect(view.host.textContent).toContain("history count 1");
    await click(view, "Hide runs");
    expect(view.a.viewFile).toHaveBeenCalledWith("script-1");
    expect(view.a.runScript).toHaveBeenCalledTimes(2);
    expect(view.a.scheduleScript).toHaveBeenCalledWith("script-1", { kind: "daily", param: "09:00" });
    await act(async () => view.root.unmount());
  });

  it("keeps a live run selected, hides stale incidents, and disables execution", async () => {
    const sc = script({
      lastRun: { jobId: "job-1", status: "error", finishedAt: null },
      consecutiveFailures: 1,
      lastError: "header\nRuntimeError: old failure",
      workflowId: "workflow-1",
    });
    const view = await renderRow(sc, state({ jobProgress: { "job-1": { label: "Running now" } } }));
    expect(view.host.textContent).toContain("Running now");
    expect(view.host.textContent).not.toContain("old failure");
    const run = [...view.host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Run");
    expect(run).toHaveProperty("disabled", true);
    await act(async () => view.root.unmount());
  });

  it("names the approval gate and each non-live status honestly", async () => {
    const view = await renderRow(script({ approved: false, lastRun: { jobId: null, status: "done", finishedAt: "2026-08-31T08:00:00Z" } }));
    expect(view.host.textContent).toContain("This version has not been approved");
    expect(view.host.textContent).toContain("done");
    expect(view.host.querySelector<HTMLButtonElement>(".script-sched-wrap button")?.disabled).toBe(true);
    await click(view, "Review script");
    await view.draw(script({ lastRun: { jobId: null, status: "error", finishedAt: "not-a-date" } }));
    expect(view.host.textContent).toContain("error");
    await view.draw(script());
    expect(view.host.textContent).toContain("never run");
    expect(view.a.runScript).toHaveBeenCalledWith("script-1");
    await act(async () => view.root.unmount());
  });

  it("clears a failed history fetch and omits empty manifest fields", async () => {
    mocks.getWorkflowRuns.mockRejectedValueOnce(new Error("offline"));
    const view = await renderRow(script({ workflowId: "workflow-2", lastError: "one line", consecutiveFailures: 1 }));
    expect(view.host.querySelector(".script-fields")).toBeNull();
    expect(view.host.textContent).toContain("one line");
    await click(view, "Runs");
    expect(view.host.textContent).toContain("history count 0");
    await act(async () => view.root.unmount());
  });
});
