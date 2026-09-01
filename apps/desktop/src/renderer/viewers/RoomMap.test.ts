import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { act, createElement } = React;

const mocks = vi.hoisted(() => ({
  graphParams: null as any,
  nodeProps: null as any,
  onOpenFile: vi.fn(),
  panParams: null as any,
  reload: vi.fn(),
  resetView: vi.fn(),
  setView: vi.fn(),
  state: null as any,
  zoomBy: vi.fn(),
}));

vi.mock("../icons", () => ({ GraphIcon: () => createElement("i", { className: "graph-icon" }) }));
vi.mock("./roomMap/Edge", () => ({
  default: (props: any) => createElement("button", { className: "mock-edge", onClick: () => props.showTip({ clientX: 30, clientY: 30 }, "edge", ["reason"]) }, "edge"),
}));
vi.mock("./roomMap/Label", () => ({ default: ({ l }: any) => createElement("text", { "data-label": l.id }, l.name) }));
vi.mock("./roomMap/NodeStar", () => ({
  default: (props: any) => {
    mocks.nodeProps = props;
    return createElement("button", {
      className: "mock-node",
      onClick: () => {
        props.setFocus(props.n.id);
        props.showTip({ clientX: 99, clientY: 79 }, props.n.name, ["node"]);
      },
    }, props.n.name);
  },
}));
vi.mock("./roomMap/usePanZoom", () => ({
  usePanZoom: (params: any) => {
    mocks.panParams = params;
    return {
      onBgDown: vi.fn(), onBgMove: vi.fn(), onBgUp: vi.fn(), onWheel: vi.fn(),
      resetView: mocks.resetView, setView: mocks.setView, svgRef: { current: null },
      view: { k: 1, x: 0, y: 0 }, zoomBy: mocks.zoomBy,
    };
  },
}));
vi.mock("./roomMap/useRoomGraph", () => ({
  useRoomGraph: (params: any) => {
    mocks.graphParams = params;
    params.layoutRef.current = mocks.state.layout;
    return mocks.state.graphState;
  },
}));

const originalGlobals = {
  document: globalThis.document,
  Element: globalThis.Element,
  Event: globalThis.Event,
  HTMLElement: globalThis.HTMLElement,
  navigator: globalThis.navigator,
  React: Reflect.get(globalThis, "React"),
  SVGElement: globalThis.SVGElement,
  window: globalThis.window,
  IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT"),
};

function graph() {
  const nodes = [
    { id: "file", name: "a very long file name for labels", folder: "notes", kind: "file" as const },
    { id: "memory", name: "remembered item", kind: "memory" as const },
    { id: "outside", name: "outside", folder: "", kind: "file" as const },
  ];
  const edge = { a: "file", b: "memory", weight: 0.8, kind: "derived", directed: true, shared: ["source"] };
  return { nodes, edges: [edge] };
}

function scenario(overrides: Record<string, unknown> = {}) {
  const roomGraph = graph();
  const layout = {
    nodes: [
      { ...roomGraph.nodes[0], x: 20, y: 20 },
      { ...roomGraph.nodes[1], x: 20, y: 20 },
      { ...roomGraph.nodes[2], x: -100, y: -100 },
    ],
    edges: [{ ai: 0, bi: 1, edge: roomGraph.edges[0], hidden: false }],
  };
  const graphState = {
    adjacency: new Map([["file", new Set(["memory"])], ["memory", new Set(["file"])]]),
    atFileLimit: true,
    cappedEdges: [roomGraph.edges[0], { ...roomGraph.edges[0], kind: "similar" }],
    degree: new Map([["file", 1], ["memory", 1], ["outside", 0]]),
    edgeCounts: { derived: 1, same_page: 0, mentions: 0, cited: 0, same_site: 0, similar: 1 },
    error: null,
    fileNodeCount: 2,
    graph: roomGraph,
    nonce: 1,
    reload: mocks.reload,
    size: { w: 100, h: 80 },
    status: "Mapped",
    topNode: "file",
    visibleEdges: roomGraph.edges,
  };
  mocks.state = { graphState, layout, ...overrides };
  Object.assign(graphState, overrides.graphState as object);
}

beforeEach(() => {
  vi.clearAllMocks();
  scenario();
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

async function renderMap() {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Element", window.Element);
  Reflect.set(globalThis, "SVGElement", window.SVGElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const [{ createRoot }, { default: RoomMap }] = await Promise.all([import("react-dom/client"), import("./RoomMap")]);
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const draw = async () => act(async () => {
    root.render(createElement(RoomMap, { onOpenFile: mocks.onOpenFile }));
    await Promise.resolve();
  });
  await draw();
  return { document, draw, host, root, window };
}

function reactProp(element: Element, name: string): (event?: Record<string, unknown>) => void {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error(`React props missing for ${name}`);
  return (element as unknown as Record<string, Record<string, (event?: Record<string, unknown>) => void>>)[key][name];
}

async function invoke(element: Element, name = "onClick", event: Record<string, unknown> = {}) {
  await act(async () => {
    reactProp(element, name)(event);
    await Promise.resolve();
  });
}

function button(view: Awaited<ReturnType<typeof renderMap>>, text: string) {
  const result = [...view.host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
  if (!result) throw new Error(`button not found: ${text}`);
  return result;
}

function namedButton(view: Awaited<ReturnType<typeof renderMap>>, label: string) {
  const result = view.host.querySelector(`button[aria-label="${label}"]`);
  if (!result) throw new Error(`named button not found: ${label}`);
  return result;
}

describe("RoomMap", () => {
  it("renders, filters, lists, tips, rebuilds and navigates without changing map behavior", async () => {
    const view = await renderMap();
    const stage = view.host.querySelector(".room-map-stage") as HTMLDivElement;
    Object.defineProperty(stage, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, width: 100, height: 80 }) });
    const crowded = Array.from({ length: 7 }, (_, index) => ({ id: `crowded-${index}`, name: `crowded ${index}`, folder: "", kind: "file" as const }));
    mocks.state.graphState.graph = { ...mocks.state.graphState.graph, nodes: [...mocks.state.graphState.graph.nodes, ...crowded] };
    mocks.state.layout = { ...mocks.state.layout, nodes: [...mocks.state.layout.nodes, ...crowded.map((node) => ({ ...node, x: 20, y: 20 }))] };
    mocks.state.graphState.adjacency = new Map([["file", new Set(["memory", ...crowded.map((node) => node.id)])]]);
    const crowdDegrees: Array<[string, number]> = crowded.map((node) => [node.id, 1]);
    mocks.state.graphState.degree = new Map<string, number>([["file", 1], ["memory", 1], ["outside", 0], ...crowdDegrees]);
    await view.draw();
    expect(view.host.textContent).toContain("Mapped");
    expect(view.host.textContent).toContain("newest 2 files");
    await invoke(button(view, "file name"));
    expect(view.host.textContent).toContain("a very long file name");
    await invoke(button(view, "edge"));
    expect(view.host.textContent).toContain("reason");
    await invoke(button(view, "Links"));
    expect(view.host.querySelector(".rm-legend")).toBeNull();
    await invoke(button(view, "Links"));
    const range = view.host.querySelector("input[type=range]");
    if (!range) throw new Error("range missing");
    await invoke(range, "onChange", { target: { value: "0.5" } });
    await invoke(button(view, "Made from"));
    await invoke(namedButton(view, "Zoom in"));
    await invoke(namedButton(view, "Zoom out"));
    await invoke(namedButton(view, "Reset view"));
    expect(mocks.zoomBy).toHaveBeenCalledTimes(2);
    expect(mocks.resetView).toHaveBeenCalledOnce();
    await invoke(button(view, "List"));
    expect(view.host.textContent).toContain("Memory");
    await invoke(button(view, "a very long file name"));
    expect(mocks.onOpenFile).toHaveBeenCalledWith("file");
    await invoke(button(view, "Map"));
    mocks.panParams.userAdjustedRef.current = true;
    mocks.state.graphState.graph = { ...graph(), nodes: [...graph().nodes] };
    mocks.state.graphState.nonce += 1;
    await view.draw();
    await view.draw();
    expect(view.host.textContent).toContain("Map rebuilt — reset view");
    await invoke(button(view, "Map rebuilt"));
    expect(mocks.resetView).toHaveBeenCalledTimes(2);
    await act(async () => view.root.unmount());
    await act(async () => mocks.nodeProps.showTip({ clientX: 2, clientY: 3 }, "detached", []));
  });

  it("shows error, empty, unmeasured and absent-graph outcomes with retry available", async () => {
    const view = await renderMap();
    mocks.state.graphState.error = "backend unavailable";
    mocks.state.graphState.status = "";
    await view.draw();
    expect(view.host.textContent).toContain("couldn’t be built");
    await invoke(button(view, "Try again"));
    expect(mocks.reload).toHaveBeenCalledOnce();
    mocks.state.graphState.error = null;
    mocks.state.graphState.fileNodeCount = 0;
    mocks.state.graphState.graph = { nodes: [], edges: [] };
    mocks.state.layout = null;
    await view.draw();
    expect(view.host.textContent).toContain("Add a few files");
    mocks.state.graphState.graph = null;
    mocks.state.graphState.fileNodeCount = 0;
    mocks.state.graphState.size = { w: 0, h: 0 };
    await view.draw();
    expect(view.host.querySelector(".room-map-svg")).toBeNull();
    await act(async () => view.root.unmount());
  });
});
