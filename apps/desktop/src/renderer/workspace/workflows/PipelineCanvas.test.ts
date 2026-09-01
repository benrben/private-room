import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDef, WorkflowNode } from "../../api";
import { PipelineCanvas } from "./PipelineCanvas";

const { act, createElement } = React;
const globalKeys = [
  "document",
  "window",
  "Node",
  "HTMLElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

function node(
  id: string,
  label: string,
  kind: WorkflowNode["kind"] = "generate",
): WorkflowNode {
  return { id, label, kind };
}

function definition(
  nodes: WorkflowNode[] = [
    node("start", "Draft"),
    node("review", "Review", "condition"),
    node("side", "Parallel check"),
    node("finish", "Publish"),
  ],
): WorkflowDef {
  return {
    version: 1,
    nodes,
    edges: [
      { from: "start", to: "review", branch: "then" },
      { from: "start", to: "side" },
      { from: "review", to: "finish" },
      { from: "missing", to: "finish" },
    ],
  };
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    def: definition(),
    status: {
      start: {
        jobId: "job",
        workflowId: "workflow",
        nodeId: "start",
        status: "done",
        peek: "Draft finished",
      },
      review: {
        jobId: "job",
        workflowId: "workflow",
        nodeId: "review",
        status: "running",
      },
    },
    selectedId: "review",
    onSelect: vi.fn(),
    onAddAfter: vi.fn(),
    onAddBranch: vi.fn(),
    editable: true,
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderCanvas(canvasProps = props()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "Node", window.Node);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(PipelineCanvas, canvasProps as never)),
  );
  await flush();
  return { canvasProps, host, root, window };
}

async function click(node: Element, window: Window & typeof globalThis) {
  await act(async () =>
    node.dispatchEvent(new window.Event("click", { bubbles: true })),
  );
  await flush();
}

function byLabel(host: ParentNode, label: string): HTMLElement {
  const element = host.querySelector<HTMLElement>(`[aria-label='${label}']`);
  if (!element) throw new Error(`missing ${label}`);
  return element;
}

function reactHandler<T>(element: Element, name: string): T {
  const key = Object.keys(element).find((candidate) =>
    candidate.startsWith("__reactProps"),
  );
  if (!key) throw new Error(`missing React ${name} handler`);
  return (element as unknown as Record<string, Record<string, T>>)[key][name];
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("PipelineCanvas", () => {
  it("lays out valid topology, renders branch/live state, and wires node plus add actions", async () => {
    const view = await renderCanvas();
    const canvas = view.host.querySelector<HTMLElement>(".pipeline-canvas");
    if (!canvas) throw new Error("pipeline canvas missing");
    expect(canvas.style.width).toBe("638px");
    expect(canvas.style.height).toBe("238px");
    expect(view.host.querySelectorAll(".pipeline-edge")).toHaveLength(3);
    expect(view.host.textContent).toContain("then");
    expect(view.host.querySelector(".pipeline-edge.live")).not.toBeNull();
    const review = byLabel(view.host, "Condition step: Review, running");
    expect(review.className).toContain("selected");
    expect(review.getAttribute("title")).toBeNull();
    const start = byLabel(view.host, "Generate text step: Draft, done");
    expect(start.getAttribute("title")).toBe("Draft finished");
    await click(review, view.window);
    expect(view.canvasProps.onSelect).toHaveBeenCalledWith("review");
    const preventDefault = vi.fn();
    await act(async () => {
      reactHandler<
        (event: { key: string; preventDefault: () => void }) => void
      >(
        review,
        "onKeyDown",
      )({ key: "Enter", preventDefault });
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(view.canvasProps.onSelect).toHaveBeenLastCalledWith("review");
    const after = view.host.querySelector<HTMLElement>(
      "button[aria-label='Add a step after this one']",
    );
    if (!after) throw new Error("add-after control missing");
    await click(after, view.window);
    expect(view.canvasProps.onAddAfter).toHaveBeenCalledWith("start");
    const branch = view.host.querySelector<HTMLElement>(
      "button[aria-label='Add a parallel branch from this step']",
    );
    if (!branch) throw new Error("add-branch control missing");
    await click(branch, view.window);
    expect(view.canvasProps.onAddBranch).toHaveBeenCalledWith("start");
    await act(async () => view.root.unmount());
  });

  it("offers the first-step control for an editable empty workflow", async () => {
    const canvasProps = props({ def: definition([]) });
    const view = await renderCanvas(canvasProps);
    expect(view.host.querySelectorAll(".pipeline-node")).toHaveLength(0);
    await click(byLabel(view.host, "Add a step"), view.window);
    expect(canvasProps.onAddAfter).toHaveBeenCalledWith(null);
    await act(async () => view.root.unmount());
  });

  it("places joins only after every parent and safely stacks cycle-only steps", async () => {
    const join = definition([
      node("left", "Left"),
      node("right", "Right"),
      node("join", "Join"),
    ]);
    join.edges = [
      { from: "left", to: "join" },
      { from: "right", to: "join" },
    ];
    const joined = await renderCanvas(
      props({
        def: join,
        editable: false,
        onAddAfter: undefined,
        onAddBranch: undefined,
      }),
    );
    expect(byLabel(joined.host, "Generate text step: Left").style.left).toBe(
      "24px",
    );
    expect(byLabel(joined.host, "Generate text step: Right").style.top).toBe(
      "132px",
    );
    expect(byLabel(joined.host, "Generate text step: Join").style.left).toBe(
      "244px",
    );
    expect(joined.host.querySelector(".pipeline-add")).toBeNull();
    await act(async () => joined.root.unmount());

    const cycle = definition([node("a", "A"), node("b", "B")]);
    cycle.edges = [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ];
    const cycled = await renderCanvas(props({ def: cycle, editable: false }));
    expect(byLabel(cycled.host, "Generate text step: A").style.left).toBe(
      "244px",
    );
    expect(byLabel(cycled.host, "Generate text step: B").style.top).toBe(
      "132px",
    );
    await act(async () => cycled.root.unmount());
  });
});
