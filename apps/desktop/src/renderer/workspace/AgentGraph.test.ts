import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AskPlanStep } from "../apiTypes";

const hooks = vi.hoisted(() => ({ prefersReducedMotion: vi.fn(() => false) }));

vi.mock("../rooms/helpers", () => ({
  prefersReducedMotion: hooks.prefersReducedMotion,
}));

import { AgentGraph } from "./AgentGraph";
import { sameEdges, type Edge } from "./agentGraphShared";

const { act, createElement } = React;
const globalKeys = [
  "document",
  "window",
  "Node",
  "HTMLElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
  "ResizeObserver",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() {
    this.callback([], this as unknown as ResizeObserver);
  }
  disconnect() {}
  unobserve() {}
}

function plan(overrides: Partial<AskPlanStep>[] = []): AskPlanStep[] {
  const base = [
    {
      key: "files",
      agent: "files.read",
      label: "Files",
      instruction: "Read the project brief",
      status: "running",
      batch: 0,
    },
    {
      key: "web",
      agent: "chat.web",
      label: "Web",
      instruction: "Find current facts",
      status: "done",
      batch: 0,
    },
    {
      key: "scripts",
      agent: "scripts.run",
      label: "Scripts",
      instruction: "Run the verification script",
      status: "failed",
      batch: 1,
    },
    {
      key: "main",
      agent: "chat.answer",
      label: "Main agent",
      instruction: "Compose the answer",
      status: "running",
      batch: null,
    },
  ];
  return base.map((step, index) => ({
    ...step,
    ...overrides[index],
  })) as AskPlanStep[];
}

function graphProps(
  overrides: Partial<React.ComponentProps<typeof AgentGraph>> = {},
) {
  return {
    plan: plan(),
    active: null,
    agentSteps: { files: [{ label: "Opened brief", ok: true }] },
    agentReports: {
      files: { text: "The brief is ready.", ok: true },
      scripts: { text: "The script exited 1.", ok: false },
    },
    steps: [{ label: "Asked specialists", ok: true }],
    lane: "Research",
    live: true,
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderGraph(props = graphProps()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Object.assign(window.HTMLElement.prototype, {
    scrollIntoView: vi.fn(),
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 120,
      bottom: 40,
      width: 120,
      height: 40,
    }),
  });
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "Node", window.Node);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  Reflect.set(globalThis, "ResizeObserver", TestResizeObserver);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(AgentGraph, props)));
  await flush();
  return { host, root, window };
}

function byText(host: ParentNode, text: string): HTMLElement {
  const node = [...host.querySelectorAll<HTMLElement>("button")].find(
    (candidate) => candidate.textContent?.includes(text),
  );
  if (!node) throw new Error(`button not found: ${text}`);
  return node;
}

async function click(node: Element, window: Window & typeof globalThis) {
  await act(async () => {
    node.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
  await flush();
}

afterEach(() => {
  vi.restoreAllMocks();
  hooks.prefersReducedMotion.mockReset();
  hooks.prefersReducedMotion.mockReturnValue(false);
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("AgentGraph", () => {
  it("compares edge identity and ignores only sub-pixel position jitter", () => {
    const edge: Edge = { key: "files", status: "running", label: "Files", x1: 10, y1: 20, x2: 30, y2: 40, dx: 20, lx: 1, ly: 2 };
    expect(sameEdges([edge], [{ ...edge, x1: 10.49, y1: 19.51, x2: 30.49, y2: 39.51 }])).toBe(true);
    expect(sameEdges([edge], [{ ...edge, x1: 10.5 }])).toBe(false);
    expect(sameEdges([edge], [{ ...edge, key: "web" }])).toBe(false);
    expect(sameEdges([edge], [{ ...edge, status: "done" }])).toBe(false);
    expect(sameEdges([edge], [{ ...edge, label: "Web" }])).toBe(false);
    expect(sameEdges([edge], [])).toBe(false);
  });

  it("shows the roster and opens a selected agent's report, steps, elapsed time, and close control", async () => {
    hooks.prefersReducedMotion.mockReturnValue(true);
    const timings: {
      current: Record<string, { start: number; end?: number }>;
    } = {
      // The node is still running, so an unstamped end would use the real
      // render-time clock and race from 1.4s to 1.5s under a busy full suite.
      // A recorded span exercises the same label path without wall-clock time.
      current: { files: { start: 0, end: 1_400 } },
    };
    const view = await renderGraph(graphProps({ timings }));
    expect(view.host.textContent).toContain("1 running");
    expect(view.host.textContent).toContain("Files");
    await click(byText(view.host, "Files"), view.window);
    expect(view.host.textContent).toContain("Read the project brief");
    expect(view.host.textContent).toContain("round 1, alongside 1 other agent");
    expect(view.host.textContent).toContain("The brief is ready.");
    expect(view.host.textContent).toContain("Opened brief");
    expect(view.host.textContent).toContain("1.4s");
    await click(byText(view.host, "✕"), view.window);
    expect(view.host.textContent).not.toContain("Opened brief");
    await act(async () => view.root.unmount());
  });

  it("draws the expanded hub-and-spoke dialog, supports graph selections, and honors both close paths", async () => {
    const view = await renderGraph();
    await click(byText(view.host, "Expand"), view.window);
    expect(view.window.document.body.textContent).toContain(
      "Agents on this turn",
    );
    expect(view.window.document.body.textContent).toContain("2 in parallel");
    expect(
      view.window.document.body.querySelectorAll(".agraph-edge"),
    ).toHaveLength(3);
    expect(view.window.document.body.textContent).toContain(
      "Read the project brief",
    );
    const child = view.window.document.body.querySelector(
      ".agraph-node:not(.hub)",
    );
    if (!child) throw new Error("graph child missing");
    await click(child, view.window);
    expect(view.window.document.body.textContent).toContain(
      "The brief is ready.",
    );
    const hub = view.window.document.body.querySelector(".agraph-node.hub");
    if (!hub) throw new Error("graph hub missing");
    await click(hub, view.window);
    expect(view.window.document.body.textContent).toContain("This turn");
    expect(view.window.document.body.textContent).toContain(
      "3 specialists dispatched, 1 still running",
    );
    expect(view.window.document.body.textContent).toContain("Research");
    const escape = new view.window.Event("keydown", { bubbles: true });
    Object.defineProperty(escape, "key", { value: "Escape" });
    await act(async () => hub.parentElement?.dispatchEvent(escape));
    await flush();
    expect(view.window.document.body.textContent).not.toContain(
      "Agents on this turn",
    );
    await click(byText(view.host, "Expand"), view.window);
    const backdrop =
      view.window.document.body.querySelector(".agraph-backdrop");
    if (!backdrop) throw new Error("graph backdrop missing");
    await click(backdrop, view.window);
    expect(view.window.document.body.textContent).not.toContain(
      "Agents on this turn",
    );
    await act(async () => view.root.unmount());
  });

  it("keeps a one-agent turn as the compact status strip, including failures", async () => {
    const view = await renderGraph(
      graphProps({
        plan: plan([
          {},
          {},
          {},
          { agent: "files.read", label: "Files", status: "failed" },
        ]).slice(-1),
        live: false,
      }),
    );
    expect(view.host.querySelector(".agent-strip")).not.toBeNull();
    expect(view.host.textContent).toContain("Files");
    expect(view.host.textContent).toContain("⚠");
    expect(view.host.querySelector(".agraph-expand")).toBeNull();
    await act(async () => view.root.unmount());
  });

  it("shows compact active status and agent report or step fallbacks", async () => {
    const compact = await renderGraph(
      graphProps({
        plan: plan([
          {},
          {},
          {},
          { agent: "files.read", label: "Files", status: "running" },
        ]).slice(-1),
      }),
    );
    expect(compact.host.querySelector(".agent-dot")).not.toBeNull();
    await act(async () => compact.root.unmount());

    const noReports = await renderGraph(
      graphProps({
        agentReports: undefined,
        agentSteps: {},
        timings: { current: {} },
      }),
    );
    await click(byText(noReports.host, "Files"), noReports.window);
    expect(noReports.host.textContent).toContain("Still working");
    expect(noReports.host.textContent).toContain("No tools yet.");
    await click(byText(noReports.host, "Web"), noReports.window);
    expect(noReports.host.textContent).toContain(
      "Reported back to the Main agent",
    );
    await click(byText(noReports.host, "Scripts"), noReports.window);
    expect(noReports.host.textContent).toContain(
      "No report — the agent did not finish",
    );
    await act(async () => noReports.root.unmount());
  });

  it("keeps recorded elapsed time, failed refusal reports, and pending fallbacks", async () => {
    const refusalPlan = plan([
      { status: "failed", report: "The room denied access." },
      { status: "pending" },
    ]);
    const timings: {
      current: Record<string, { start: number; end?: number }>;
    } = {
      current: {
        files: { start: 0, end: 65_000 },
        web: { start: 0 },
        scripts: { start: 0 },
      },
    };
    const view = await renderGraph(
      graphProps({
        plan: refusalPlan,
        agentReports: undefined,
        agentSteps: {},
        timings,
      }),
    );
    expect(timings.current.scripts.end).toBeDefined();
    await click(byText(view.host, "Files"), view.window);
    expect(view.host.textContent).toContain("1m 5s");
    expect(view.host.textContent).toContain("Why it failed");
    expect(view.host.textContent).toContain("The room denied access.");
    await click(byText(view.host, "Web"), view.window);
    expect(view.host.textContent).toContain("Not started");
    expect(view.host.textContent).toContain("Not started yet.");
    await act(async () => view.root.unmount());
  });

  it("uses the active hub's lane when every specialist has settled", async () => {
    const settled = await renderGraph(
      graphProps({
        plan: plan([
          { status: "done" },
          { status: "done" },
          { status: "failed" },
          { status: "running" },
        ]),
      }),
    );
    await click(byText(settled.host, "Expand"), settled.window);
    expect(
      settled.window.document.body.querySelector(".agraph-node.hub")
        ?.textContent,
    ).toContain("Research");
    await act(async () => settled.root.unmount());
  });
});
