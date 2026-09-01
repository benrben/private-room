import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Workflow,
  WorkflowBinding,
  WorkflowDef,
  WorkflowNode,
} from "../../api";
import type { WSActions } from "../actions";
import type { WSState } from "../state";

const mocks = vi.hoisted(() => ({
  api: {
    getWorkflowRuns: vi.fn(),
    getWorkflowSchedule: vi.fn(),
    updateWorkflow: vi.fn(),
    validateWorkflow: vi.fn(),
  },
  confirm: vi.fn(),
}));

vi.mock("../../api", () => ({ api: mocks.api }));
vi.mock("../../platform", () => ({ confirm: mocks.confirm }));
vi.mock("../../viewers/registry", () => ({
  coveredKinds: () => ["pdf", "docx"],
}));
vi.mock("../../icons", () => ({
  CalendarClockIcon: () => null,
  PinIcon: () => null,
  PlayIcon: () => null,
  WorkflowsIcon: () => null,
  SunriseIcon: () => null,
  InboxIcon: () => null,
  CalendarCheckIcon: () => null,
  BookOpenIcon: () => null,
  CompareIcon: () => null,
  FilesIcon: () => null,
  ListFilterIcon: () => null,
  SparklesIcon: () => null,
}));
vi.mock("./PipelineCanvas", () => ({
  PipelineCanvas: ({
    def,
    onAddAfter,
    onAddBranch,
    onSelect,
  }: {
    def: WorkflowDef;
    onAddAfter?: (id: string | null) => void;
    onAddBranch?: (id: string) => void;
    onSelect?: (id: string) => void;
  }) =>
    createElement(
      "div",
      null,
      createElement("output", { "data-definition": JSON.stringify(def) }),
      createElement(
        "button",
        { onClick: () => onAddAfter?.(def.nodes[0]?.id ?? null) },
        "add after",
      ),
      createElement(
        "button",
        { onClick: () => onAddAfter?.(null) },
        "append node",
      ),
      createElement(
        "button",
        { onClick: () => onAddBranch?.(def.nodes[0]?.id ?? "") },
        "add branch",
      ),
      createElement(
        "button",
        { onClick: () => onSelect?.(def.nodes[0]?.id ?? "") },
        "select first step",
      ),
    ),
}));
vi.mock("./NodeParamSheet", () => ({
  NodeParamSheet: ({
    node,
    onChange,
    onDelete,
    onEdgesChange,
  }: {
    node: WorkflowNode;
    onChange: (node: WorkflowNode) => void;
    onDelete: () => void;
    onEdgesChange: (edges: []) => void;
  }) =>
    createElement(
      "div",
      null,
      createElement("span", null, `selected ${node.id}`),
      createElement(
        "button",
        { onClick: () => onChange({ ...node, label: "Edited step" }) },
        "edit selected step",
      ),
      createElement("button", { onClick: onDelete }, "delete selected step"),
      createElement(
        "button",
        { onClick: () => onEdgesChange([]) },
        "clear selected edges",
      ),
    ),
}));
vi.mock("./SchedulePopover", () => ({
  SchedulePopover: ({
    onClose,
    onSave,
  }: {
    onClose: () => void;
    onSave: (schedule: { kind: string; param?: string }) => void;
  }) =>
    createElement(
      "div",
      null,
      createElement(
        "button",
        { onClick: () => onSave({ kind: "daily", param: "08:00" }) },
        "save schedule",
      ),
      createElement("button", { onClick: onClose }, "close schedule"),
    ),
}));
vi.mock("./RunHistory", () => ({
  RunHistory: () => createElement("div", null, "run history"),
}));

const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type DetailView = Awaited<ReturnType<typeof renderDetail>>;

function workflowDef(nodes: WorkflowNode[] = [conditionNode()]): WorkflowDef {
  return { version: 1, nodes, edges: [] };
}

function conditionNode(): WorkflowNode {
  return { id: "condition", label: "Decide", kind: "condition" };
}

function workflow(binding: WorkflowBinding = { scope: "general" }): Workflow {
  return {
    id: "workflow-1",
    name: "Daily digest",
    description: "",
    emoji: "⚙️",
    definition: workflowDef(),
    status: "draft",
    createdBy: "user",
    binding,
    pinned: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function actions() {
  return {
    deleteWorkflow: vi.fn().mockResolvedValue(undefined),
    refreshWorkflows: vi.fn().mockResolvedValue(undefined),
    runWorkflowNow: vi.fn().mockResolvedValue(undefined),
    saveWorkflowEdits: vi.fn().mockResolvedValue(undefined),
    setWorkflowPinned: vi.fn().mockResolvedValue(undefined),
    setWorkflowSchedule: vi.fn().mockResolvedValue(undefined),
    setWorkflowStatus: vi.fn().mockResolvedValue(undefined),
  };
}

function state() {
  return {
    files: [
      { id: "report", name: "report.pdf" },
      { id: "brief", name: "brief.docx" },
    ],
    pushToast: vi.fn(),
    setWfDetailId: vi.fn(),
    workflows: [],
    wfNodeStatus: {},
  };
}

beforeEach(() => {
  mocks.api.getWorkflowRuns.mockReset().mockResolvedValue([]);
  mocks.api.getWorkflowSchedule.mockReset().mockResolvedValue(null);
  mocks.api.updateWorkflow.mockReset().mockResolvedValue(undefined);
  mocks.api.validateWorkflow.mockReset().mockResolvedValue([]);
  mocks.confirm.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

async function flush(rounds = 4) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

async function renderDetail(
  nextWorkflow = workflow(),
  nextState = state(),
  nextActions = actions(),
) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  (window.HTMLElement.prototype as HTMLElement).scrollIntoView = vi.fn();
  Object.defineProperty(window, "innerWidth", { value: 1280 });
  (window.HTMLElement.prototype as HTMLElement).getBoundingClientRect = vi.fn(
    () => ({ bottom: 40, right: 400 }) as DOMRect,
  );

  const [{ createRoot }, { WorkflowDetail }] = await Promise.all([
    import("react-dom/client"),
    import("./WorkflowDetail"),
  ]);
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(WorkflowDetail, {
        s: nextState as unknown as WSState,
        a: nextActions as unknown as WSActions,
        workflow: nextWorkflow,
      }),
    );
  });
  await flush();
  return {
    actions: nextActions,
    close: async () => act(async () => root.unmount()),
    document,
    host,
    state: nextState,
    window,
  };
}

function reactProp<T>(element: Element, name: string): T {
  const key = Object.keys(element).find((candidate) =>
    candidate.startsWith("__reactProps"),
  );
  if (!key) throw new Error(`React props missing for ${name}`);
  return (element as unknown as Record<string, Record<string, T>>)[key][name];
}

async function invoke(
  element: Element,
  name = "onClick",
  event: Record<string, unknown> = {},
) {
  await act(async () => {
    reactProp<(event: Record<string, unknown>) => void>(
      element,
      name,
    )({
      currentTarget: element,
      preventDefault: vi.fn(),
      target: element,
      ...event,
    });
  });
  await flush();
}

async function setValue(element: Element, value: string) {
  await invoke(element, "onChange", { target: { value } });
}

function button(view: DetailView, text: string): Element {
  const element = [...view.document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.includes(text),
  );
  if (!element) throw new Error(`button not found: ${text}`);
  return element;
}

function labelledButton(view: DetailView, label: string): Element {
  const element = view.document.querySelector(`button[aria-label='${label}']`);
  if (!element) throw new Error(`button not found: ${label}`);
  return element;
}

function definition(view: DetailView): WorkflowDef {
  const node = view.host.querySelector("output[data-definition]");
  if (!node) throw new Error("definition output missing");
  return JSON.parse(node.getAttribute("data-definition") ?? "") as WorkflowDef;
}

describe("WorkflowDetail", () => {
  it("keeps empty, linear, and branchless graph insertion rules connected to the canvas", async () => {
    const empty = await renderDetail({
      ...workflow(),
      definition: workflowDef([]),
    });
    await invoke(button(empty, "add after"));
    expect(definition(empty)).toMatchObject({
      nodes: [expect.any(Object)],
      edges: [],
    });
    await invoke(button(empty, "append node"));
    const appended = definition(empty);
    expect(appended.edges).toEqual([
      { from: appended.nodes[0]?.id, to: appended.nodes[1]?.id },
    ]);
    await empty.close();

    const branchless = await renderDetail();
    await invoke(button(branchless, "add after"));
    const branchlessAdded = definition(branchless).nodes.find(
      (node) => node.id !== "condition",
    );
    expect(definition(branchless).edges).toEqual([
      { from: "condition", to: branchlessAdded?.id, branch: "then" },
    ]);
    await branchless.close();

    const first: WorkflowNode = {
      id: "first",
      label: "First",
      kind: "generate",
    };
    const last: WorkflowNode = { id: "last", label: "Last", kind: "generate" };
    const linear = await renderDetail({
      ...workflow(),
      definition: {
        version: 1,
        nodes: [first, last],
        edges: [{ from: "first", to: "last" }],
      },
    });
    await invoke(button(linear, "add after"));
    const inserted = definition(linear).nodes.find(
      (node) => !["first", "last"].includes(node.id),
    );
    expect(definition(linear).edges).toEqual([
      { from: "first", to: inserted?.id },
      { from: inserted?.id, to: "last" },
    ]);
    await linear.close();
  });

  it("keeps graph insertion and branch wiring faithful to the canvas actions", async () => {
    const source = conditionNode();
    const first: WorkflowNode = {
      id: "first",
      label: "First",
      kind: "generate",
    };
    const second: WorkflowNode = {
      id: "second",
      label: "Second",
      kind: "generate",
    };
    const view = await renderDetail({
      ...workflow(),
      definition: {
        version: 1,
        nodes: [source, first, second],
        edges: [
          { from: "condition", to: "first", branch: "then" },
          { from: "condition", to: "second", branch: "else" },
        ],
      },
    });

    await invoke(button(view, "add after"));
    const inserted = definition(view);
    const added = inserted.nodes.find(
      (node) => !["condition", "first", "second"].includes(node.id),
    );
    expect(added).toBeDefined();
    expect(inserted.edges).toEqual([
      { from: "condition", to: added?.id, branch: "then" },
      { from: "condition", to: "second", branch: "else" },
      { from: added?.id, to: "first" },
    ]);

    await invoke(button(view, "add branch"));
    const branched = definition(view);
    const branch = branched.edges.at(-1);
    expect(branch).toMatchObject({ from: "condition", branch: "then" });
    expect(branched.nodes).toHaveLength(5);
    await view.close();
  });

  it("keeps validation, binding edits, save, schedule, and selected-node callbacks connected", async () => {
    mocks.api.validateWorkflow.mockResolvedValueOnce([
      "Node 'condition' needs an input",
    ]);
    const view = await renderDetail();
    expect(view.host.textContent).toContain('"Decide" needs an input');
    await invoke(button(view, '"Decide" needs an input'));
    expect(view.host.textContent).toContain("selected condition");
    expect(
      vi.mocked(view.window.HTMLElement.prototype.scrollIntoView),
    ).toHaveBeenLastCalledWith({ block: "nearest" });
    await invoke(button(view, "edit selected step"));
    expect(definition(view).nodes[0]?.label).toBe("Edited step");
    await invoke(button(view, "clear selected edges"));
    expect(definition(view).edges).toEqual([]);

    const radios = [...view.host.querySelectorAll("button[role=radio]")];
    const fileRadio = radios.find((node) =>
      node.textContent?.includes("Specific files"),
    );
    if (!fileRadio) throw new Error("file binding radio missing");
    await invoke(fileRadio);
    await invoke(button(view, "pdf"));
    const extInput = view.host.querySelector(
      "input[placeholder='pdf, docx, md']",
    );
    if (!extInput) throw new Error("extensions input missing");
    await setValue(extInput, " .pdf, DOCX, ");
    const select = view.host.querySelector("select");
    if (!select) throw new Error("file binding select missing");
    await setValue(select, "report");
    await invoke(button(view, "pdf"));
    await invoke(button(view, "pdf"));

    const title = view.host.querySelector("input[aria-label='Workflow name']");
    if (!title) throw new Error("workflow title missing");
    await setValue(title, "Edited digest");
    await invoke(button(view, "Save"));
    expect(view.actions.saveWorkflowEdits).toHaveBeenLastCalledWith(
      "workflow-1",
      {
        name: "Edited digest",
        emoji: "⚙️",
        definition: expect.objectContaining({ nodes: expect.any(Array) }),
        binding: {
          scope: "file",
          kinds: ["pdf"],
          exts: ["pdf", "docx"],
          file_id: "report",
        },
      },
    );

    await invoke(button(view, "Schedule"));
    await invoke(button(view, "save schedule"));
    expect(view.actions.setWorkflowSchedule).toHaveBeenLastCalledWith(
      "workflow-1",
      {
        kind: "daily",
        param: "08:00",
      },
    );
    await view.close();
  });

  it("keeps dismissal, deletion, draft, and null-anchor fallbacks reachable", async () => {
    const view = await renderDetail({ ...workflow(), createdBy: "agent" });
    expect(view.host.textContent).toContain("Drafted by the agent");
    await invoke(labelledButton(view, "Choose an icon for this workflow"));
    const backdrop = view.document.querySelector(".menu-backdrop");
    if (!backdrop) throw new Error("icon picker backdrop missing");
    await invoke(backdrop, "onMouseDown");

    await invoke(button(view, "select first step"));
    await invoke(button(view, "delete selected step"));
    expect(definition(view).nodes).toEqual([]);
    vi.mocked(
      window.HTMLElement.prototype.getBoundingClientRect,
    ).mockReturnValueOnce(null as never);
    await invoke(button(view, "Schedule"));
    await invoke(button(view, "close schedule"));
    await view.close();
  });

  it("keeps active controls, icon selection, schedule close, and deletion callbacks wired", async () => {
    const view = await renderDetail({
      ...workflow(),
      status: "active",
      pinned: true,
      createdBy: "agent",
    });
    expect(view.host.textContent).not.toContain("Draft —");
    await invoke(labelledButton(view, "Choose an icon for this workflow"));
    await invoke(labelledButton(view, "Sunrise"));
    await invoke(button(view, "Run now"));
    expect(view.actions.runWorkflowNow).toHaveBeenLastCalledWith("workflow-1");
    await invoke(button(view, "Deactivate"));
    expect(view.actions.setWorkflowStatus).toHaveBeenLastCalledWith(
      "workflow-1",
      "draft",
    );
    await invoke(button(view, "Pinned"));
    expect(view.actions.setWorkflowPinned).toHaveBeenLastCalledWith(
      "workflow-1",
      false,
    );
    await invoke(button(view, "Specific files"));
    await invoke(button(view, "General"));
    await invoke(button(view, "Schedule"));
    await invoke(button(view, "close schedule"));
    await invoke(button(view, "Delete"));
    expect(view.actions.deleteWorkflow).toHaveBeenLastCalledWith("workflow-1");
    await view.close();
  });

  it("keeps failed validation and run-history refresh failures non-destructive", async () => {
    mocks.api.getWorkflowSchedule.mockRejectedValueOnce(
      new Error("schedule offline"),
    );
    mocks.api.getWorkflowRuns
      .mockResolvedValueOnce([{ status: "running", jobId: "job-1" }])
      .mockRejectedValueOnce(new Error("history offline"));
    mocks.api.validateWorkflow.mockRejectedValueOnce(
      new Error("validator offline"),
    );
    mocks.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const nextState = state();
    nextState.wfNodeStatus = { "job-1": {} };
    const view = await renderDetail(workflow(), nextState);
    expect(view.host.textContent).toContain(
      "Couldn't check this workflow: Error: validator offline",
    );
    const title = view.host.querySelector("input[aria-label='Workflow name']");
    if (!title) throw new Error("workflow title missing");
    await setValue(title, "Invalid draft");
    await invoke(button(view, "Test run"));
    expect(view.actions.runWorkflowNow).toHaveBeenCalledWith("workflow-1");
    await invoke(button(view, "Library"));
    expect(view.state.setWfDetailId).not.toHaveBeenCalled();
    expect(mocks.confirm).toHaveBeenLastCalledWith(
      expect.stringContaining("can't be saved"),
      expect.any(Object),
    );
    await invoke(button(view, "Library"));
    expect(view.state.setWfDetailId).toHaveBeenLastCalledWith(null);
    await view.close();
  });

  it("keeps successful activation ordered before its status flip and preserves missing file bindings", async () => {
    const view = await renderDetail(
      workflow({
        scope: "file",
        kinds: [],
        exts: [],
        file_id: "missing-file",
      }),
    );
    expect(view.host.textContent).toContain("bound file — not in this room");
    const select = view.host.querySelector("select");
    if (!select) throw new Error("file binding select missing");
    await setValue(select, "");
    const title = view.host.querySelector("input[aria-label='Workflow name']");
    if (!title) throw new Error("workflow title missing");
    await setValue(title, "Activated workflow");
    await invoke(button(view, "Activate"));
    expect(mocks.api.updateWorkflow).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "workflow-1", name: "Activated workflow" }),
    );
    expect(view.actions.refreshWorkflows).toHaveBeenCalledBefore(
      view.actions.setWorkflowStatus,
    );
    expect(view.actions.setWorkflowStatus).toHaveBeenLastCalledWith(
      "workflow-1",
      "active",
    );
    await view.close();
  });

  it("does not activate after an update failure and asks before discarding a dirty draft", async () => {
    mocks.api.updateWorkflow.mockRejectedValueOnce(
      new Error("disk unavailable"),
    );
    mocks.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const view = await renderDetail();
    const title = view.host.querySelector("input[aria-label='Workflow name']");
    if (!title) throw new Error("workflow title missing");
    await setValue(title, "Unsaved title");

    await invoke(button(view, "Activate"));
    expect(view.state.pushToast).toHaveBeenLastCalledWith(
      "error",
      "Error: disk unavailable",
    );
    expect(view.actions.refreshWorkflows).not.toHaveBeenCalled();
    expect(view.actions.setWorkflowStatus).not.toHaveBeenCalled();

    await invoke(button(view, "Library"));
    expect(view.state.setWfDetailId).not.toHaveBeenCalled();
    await invoke(button(view, "Library"));
    expect(view.state.setWfDetailId).toHaveBeenLastCalledWith(null);
    await view.close();
  });
});
