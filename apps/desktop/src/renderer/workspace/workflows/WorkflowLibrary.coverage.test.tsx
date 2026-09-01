import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Schedule, Workflow, WorkflowRun } from "../../api";
import type { WSActions } from "../actions";
import type { WSState } from "../state";

const fakes = vi.hoisted(() => ({
  composeWorkflow: vi.fn(),
  getWorkflowRuns: vi.fn(),
  getWorkflowSchedule: vi.fn(),
  workflowTemplates: vi.fn(),
}));

vi.mock("../../api", () => ({
  api: {
    composeWorkflow: fakes.composeWorkflow,
    getWorkflowRuns: fakes.getWorkflowRuns,
    getWorkflowSchedule: fakes.getWorkflowSchedule,
    workflowTemplates: fakes.workflowTemplates,
  },
}));
vi.mock("../../icons", () => ({ PlusIcon: () => null, PinIcon: () => null, SparklesIcon: () => null }));
vi.mock("./workflowGlyph", () => ({ WorkflowGlyph: () => null }));

const { act, createElement } = React;
const NOW = new Date("2026-09-01T12:00:00.000Z").getTime();

const originalGlobals = {
  Element: globalThis.Element,
  Event: globalThis.Event,
  HTMLElement: globalThis.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT"),
  React: Reflect.get(globalThis, "React"),
  document: globalThis.document,
  navigator: globalThis.navigator,
  window: globalThis.window,
};

function workflow(id: string, overrides: Partial<Workflow> = {}): Workflow {
  return {
    id,
    name: id,
    description: "",
    emoji: "⚙️",
    definition: { version: 1, nodes: [], edges: [] },
    status: "active",
    createdBy: "user",
    binding: { scope: "general" },
    pinned: false,
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:00.000Z",
    ...overrides,
  };
}

function schedule(workflowId: string, nextRunAt: string | null, enabled = true): Schedule {
  return {
    id: `schedule-${workflowId}`,
    workflowId,
    kind: "daily",
    param: "09:00",
    enabled,
    catchUp: false,
    nextRunAt,
    lastRunAt: null,
    lastJobId: null,
  };
}

function run(workflowId: string, status: string): WorkflowRun {
  return {
    id: `run-${workflowId}`,
    workflowId,
    jobId: null,
    trigger: "manual",
    status,
    error: null,
    inputFileId: null,
    startedAt: "2026-09-01T11:00:00.000Z",
    finishedAt: null,
  };
}

function state(workflows: Workflow[]): WSState {
  return { workflows, pushToast: vi.fn() } as unknown as WSState;
}

function actions(): WSActions {
  return {
    createBlankWorkflow: vi.fn(),
    instantiateTemplate: vi.fn(),
    openWorkflowDetail: vi.fn(),
    refreshWorkflows: vi.fn().mockResolvedValue(undefined),
  } as unknown as WSActions;
}

function prop(element: Element, name: string): (...args: any[]) => void {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error(`React ${name} handler missing`);
  return (element as unknown as Record<string, Record<string, (...args: any[]) => void>>)[key][name];
}

async function invoke(element: Element, name = "onClick", event: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    prop(element, name)(event);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

async function render(s: WSState, a: WSActions) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Element", window.Element);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  window.setTimeout = globalThis.setTimeout as typeof window.setTimeout;
  window.clearTimeout = globalThis.clearTimeout as typeof window.clearTimeout;
  window.setInterval = globalThis.setInterval as typeof window.setInterval;
  window.clearInterval = globalThis.clearInterval as typeof window.clearInterval;
  const { createRoot } = await import("react-dom/client");
  const { WorkflowLibrary } = await import("./WorkflowLibrary");
  const host = document.getElementById("root");
  if (!host) throw new Error("missing fake root");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(WorkflowLibrary, { s, a }));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
  return {
    host,
    close: async () => { await act(async () => root.unmount()); },
  };
}

function card(host: Element, text: string): Element {
  const result = [...host.querySelectorAll(".wf-card")].find((candidate) => candidate.textContent?.includes(text));
  if (!result) throw new Error(`workflow card missing: ${text}`);
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("WorkflowLibrary coverage", () => {
  it("renders fabricated countdowns, card actions, template actions, and timer updates", async () => {
    const workflows = [
      workflow("minutes", { name: "Minutes", description: "Soon", pinned: true }),
      workflow("hours", { name: "Hours" }),
      workflow("days", { name: "Days" }),
      workflow("due", { name: "Due" }),
      workflow("draft", { name: "Draft", status: "draft", createdBy: "agent" }),
      workflow("paused", { name: "Paused" }),
      workflow("none", { name: "No next" }),
      workflow("invalid", { name: "Invalid" }),
      workflow("file", { name: "File task", binding: { scope: "file", kinds: ["pdf"], exts: [".pdf"] } }),
      workflow("hidden", { name: "Hidden script", createdBy: "script" }),
    ];
    const schedules: Record<string, Schedule | null> = {
      minutes: schedule("minutes", new Date(NOW + 30 * 60_000).toISOString()),
      hours: schedule("hours", new Date(NOW + 2 * 3_600_000).toISOString()),
      days: schedule("days", new Date(NOW + 2 * 86_400_000).toISOString()),
      due: schedule("due", new Date(NOW - 1_000).toISOString()),
      draft: schedule("draft", new Date(NOW + 60_000).toISOString()),
      paused: schedule("paused", new Date(NOW + 60_000).toISOString(), false),
      none: schedule("none", null),
      invalid: schedule("invalid", "not-a-date"),
      file: schedule("file", new Date(NOW + 60_000).toISOString()),
      hidden: schedule("hidden", new Date(NOW + 60_000).toISOString()),
    };
    fakes.workflowTemplates.mockResolvedValue([
      {
        name: "Daily digest",
        description: "A fabricated template",
        emoji: "✨",
        binding: { scope: "general" },
        schedule: { kind: "daily", param: "08:00" },
        definition: { version: 1, nodes: [], edges: [] },
      },
    ]);
    fakes.getWorkflowSchedule.mockImplementation((id: string) => Promise.resolve(schedules[id]));
    fakes.getWorkflowRuns.mockImplementation((id: string) => Promise.resolve([run(id, id === "minutes" ? "done" : "paused")]));
    const s = state(workflows);
    const a = actions();
    const view = await render(s, a);

    expect(view.host.textContent).toContain("in 30m");
    expect(view.host.textContent).toContain("in 2h");
    expect(view.host.textContent).toContain("in 2d");
    expect(view.host.textContent).toContain("due now");
    expect(view.host.textContent).toContain("not until you activate it");
    expect(view.host.textContent).toContain("schedule paused");
    expect(view.host.textContent).toContain("On: pdf, .pdf");
    expect(view.host.textContent).toContain("Ran OK");
    expect(view.host.textContent).toContain("Stopped");
    expect(view.host.textContent).not.toContain("Hidden script");

    await invoke(card(view.host, "Minutes"), "onKeyDown", { key: "Enter", preventDefault: vi.fn() });
    await invoke(card(view.host, "Minutes"), "onKeyDown", { key: " ", preventDefault: vi.fn() });
    expect(a.openWorkflowDetail).toHaveBeenCalledWith("minutes");
    expect(a.openWorkflowDetail).toHaveBeenCalledTimes(2);

    const templateToggle = [...view.host.querySelectorAll("button")].find((button) => button.textContent?.includes("From template"));
    if (!templateToggle) throw new Error("template toggle missing");
    await invoke(templateToggle);
    await invoke(card(view.host, "Daily digest"));
    await invoke(card(view.host, "Blank workflow"));
    expect(a.instantiateTemplate).toHaveBeenCalledWith(expect.objectContaining({ name: "Daily digest" }));
    expect(a.createBlankWorkflow).toHaveBeenCalledOnce();

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(view.host.textContent).toContain("in 29m");
    await view.close();
  });

  it("composes fabricated descriptions and keeps empty-state templates reachable", async () => {
    fakes.workflowTemplates.mockResolvedValue([]);
    fakes.composeWorkflow
      .mockResolvedValueOnce("draft-id")
      .mockRejectedValueOnce("fabricated compose failure");
    const s = state([workflow("script-only", { createdBy: "script" })]);
    const a = actions();
    const view = await render(s, a);
    const input = view.host.querySelector("textarea");
    if (!input) throw new Error("compose input missing");

    await invoke(input, "onChange", { target: { value: "  summarize the room  " } });
    const compose = [...view.host.querySelectorAll("button")].find((button) => button.textContent?.includes("Compose with AI"));
    if (!compose) throw new Error("compose button missing");
    await invoke(compose);

    expect(fakes.composeWorkflow).toHaveBeenCalledWith("summarize the room");
    expect(a.refreshWorkflows).toHaveBeenCalledOnce();
    expect(a.openWorkflowDetail).toHaveBeenCalledWith("draft-id");
    expect((s.pushToast as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("success", "Draft ready — review and activate it.");

    await invoke(input, "onChange", { target: { value: "fail this composition" } });
    await invoke(input, "onKeyDown", { key: "Enter", shiftKey: false, preventDefault: vi.fn() });
    expect(fakes.composeWorkflow).toHaveBeenLastCalledWith("fail this composition");
    expect((s.pushToast as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("error", "fabricated compose failure");
    await view.close();
  });
});
