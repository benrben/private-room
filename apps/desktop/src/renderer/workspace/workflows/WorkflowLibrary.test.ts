import * as React from "react";

import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workflow } from "../../api";
import type { WSActions } from "../actions";
import type { WSState } from "../state";
import { WorkflowLibrary } from "./WorkflowLibrary";

const mocks = vi.hoisted(() => ({
  getWorkflowRuns: vi.fn(),
  getWorkflowSchedule: vi.fn(),
  workflowTemplates: vi.fn(),
}));

vi.mock("../../api", () => ({
  api: {
    getWorkflowRuns: mocks.getWorkflowRuns,
    getWorkflowSchedule: mocks.getWorkflowSchedule,
    workflowTemplates: mocks.workflowTemplates,
  },
}));
vi.mock("../../icons", () => ({ PlusIcon: () => null, PinIcon: () => null, SparklesIcon: () => null }));
vi.mock("./workflowGlyph", () => ({ WorkflowGlyph: () => null }));

const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

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
    createdAt: "2026-08-31T12:00:00.000Z",
    updatedAt: "2026-08-31T12:00:00.000Z",
    ...overrides,
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
    refreshWorkflows: vi.fn(),
  } as unknown as WSActions;
}

async function render(s: WSState, a: WSActions) {
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
  await act(async () => {
    root.render(createElement(WorkflowLibrary, { s, a }));
    await Promise.resolve();
  });
  return { host, close: async () => act(async () => root.unmount()) };
}

async function click(element: Element) {
  const propKey = Object.keys(element).find((key) => key.startsWith("__reactProps"));
  if (!propKey) throw new Error("React click handler missing");
  const props = (element as unknown as Record<string, Record<string, () => void>>)[propKey];
  await act(async () => {
    props.onClick();
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("WorkflowLibrary", () => {
  it("renders each workflow card's status/binding cues and opens its exact detail", async () => {
    mocks.workflowTemplates.mockResolvedValue([]);
    mocks.getWorkflowSchedule.mockResolvedValue(null);
    mocks.getWorkflowRuns.mockResolvedValue([]);
    const s = state([
      workflow("daily-review", {
        name: "Daily review",
        description: "Summarize new notes.",
        pinned: true,
      }),
      workflow("file-draft", {
        name: "File draft",
        status: "draft",
        createdBy: "agent",
        binding: { scope: "file", kinds: ["pdf"], exts: [".pdf"] },
      }),
    ]);
    const a = actions();
    const view = await render(s, a);

    expect(view.host.textContent).toContain("Daily review");
    expect(view.host.textContent).toContain("Summarize new notes.");
    expect(view.host.querySelector('[aria-label="Pinned to the top bar"]')).not.toBeNull();
    expect(view.host.textContent).toContain("File draft");
    expect(view.host.textContent).toContain("Draft");
    expect(view.host.textContent).toContain("Drafted by the agent");
    expect(view.host.textContent).toContain("On: pdf, .pdf");

    const draftCard = [...view.host.querySelectorAll(".wf-card")].find((card) =>
      card.textContent?.includes("File draft"),
    );
    if (!draftCard) throw new Error("draft workflow card missing");
    await click(draftCard);
    expect(a.openWorkflowDetail).toHaveBeenCalledWith("file-draft");
    await view.close();
  });
});
