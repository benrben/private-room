import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowEdge, WorkflowNode } from "../../api";

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

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

type Sheet = Awaited<ReturnType<typeof renderSheet>>;

function workflowNode(
  kind: WorkflowNode["kind"],
  values: Record<string, unknown> = {},
): WorkflowNode {
  return { id: "step", label: "Named step", kind, ...values };
}

async function renderSheet(
  node = workflowNode("generate"),
  edges: WorkflowEdge[] = [],
  allNodes: WorkflowNode[] = [],
  files?: { id: string; name: string }[],
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

  const [{ createRoot }, { NodeParamSheet }] = await Promise.all([
    import("react-dom/client"),
    import("./NodeParamSheet"),
  ]);
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const onChange = vi.fn();
  const onDelete = vi.fn();
  const onEdgesChange = vi.fn();
  const draw = async (
    nextNode = node,
    nextEdges = edges,
    nextNodes = allNodes,
    nextFiles = files,
  ) =>
    act(async () => {
      root.render(
        createElement(NodeParamSheet, {
          node: nextNode,
          onChange,
          onDelete,
          edges: nextEdges,
          allNodes: nextNodes,
          onEdgesChange,
          files: nextFiles,
        }),
      );
      await Promise.resolve();
    });
  await draw();
  const close = async () => act(async () => root.unmount());
  return { close, document, draw, host, onChange, onDelete, onEdgesChange };
}

function reactProp(
  element: Element,
  name: string,
): (event: Record<string, unknown>) => void {
  const key = Object.keys(element).find((candidate) =>
    candidate.startsWith("__reactProps"),
  );
  if (!key) throw new Error(`React props missing for ${name}`);
  return (
    element as unknown as Record<
      string,
      Record<string, (event: Record<string, unknown>) => void>
    >
  )[key][name];
}

async function invoke(
  element: Element,
  name = "onClick",
  event: Record<string, unknown> = {},
) {
  await act(async () =>
    reactProp(
      element,
      name,
    )({
      currentTarget: element,
      preventDefault: vi.fn(),
      target: element,
      ...event,
    }),
  );
}

async function setValue(element: Element, value: string) {
  await invoke(element, "onChange", { target: { value } });
}

function button(view: Sheet, text: string) {
  const element = [...view.host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!element) throw new Error(`button not found: ${text}`);
  return element;
}

function input(view: Sheet, selector: string) {
  const element = view.host.querySelector(selector);
  if (!element) throw new Error(`input not found: ${selector}`);
  return element;
}

describe("NodeParamSheet", () => {
  it("keeps the header, model choices, deletion, and kind defaults connected", async () => {
    const view = await renderSheet(
      workflowNode("generate", { prompt: "original", model: "auto" }),
    );
    await setValue(input(view, "input[type=text]"), "Renamed");
    expect(view.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ label: "Renamed", prompt: "original" }),
    );
    const headerKind = view.host.querySelector("select");
    if (!headerKind) throw new Error("kind select missing");
    await setValue(headerKind, "route");
    expect(view.onChange).toHaveBeenLastCalledWith({
      id: "step",
      label: "Named step",
      kind: "route",
      prompt: "",
      labels: ["a", "b"],
      model: "auto",
    });
    await invoke(button(view, "Cloud"));
    expect(view.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: "cloud" }),
    );
    await invoke(button(view, "Delete step"));
    expect(view.onDelete).toHaveBeenCalledOnce();
    await view.close();
  });

  it("renders every kind-specific form including all conditional controls", async () => {
    const cases: Array<[WorkflowNode, { id: string; name: string }[]?]> = [
      [workflowNode("generate", { prompt: "draft" })],
      [
        workflowNode("summarize_file", {
          select: { type: "name_like", pattern: "report" },
        }),
      ],
      [
        workflowNode("file_pass", {
          select: { type: "all" },
          instruction: "read",
          mode: "stitch",
        }),
      ],
      [
        workflowNode("for_each_file", {
          select: { type: "name_like", pattern: "memo" },
          instruction: "tag",
        }),
      ],
      [workflowNode("agent_run", { question: "what changed?" })],
      [workflowNode("extract", { fields: ["title", "author"] })],
      [workflowNode("route", { prompt: "classify", labels: ["urgent"] })],
      [workflowNode("vote", { prompt: "pick", samples: 6, mode: "majority" })],
      [
        workflowNode("refine", {
          prompt: "polish",
          rubric: "clear",
          max_rounds: 4,
        }),
      ],
      [workflowNode("plan_and_map", { objective: "ship", max_workers: 8 })],
      [workflowNode("transform", { op: "replace", find: "old", value: "new" })],
      [workflowNode("transform", { op: "append", value: "suffix" })],
      [workflowNode("transform", { op: "trim" })],
      [workflowNode("merge", { mode: "numbered" })],
      [workflowNode("http_fetch", { url: "https://example.test" })],
      [workflowNode("script_run", { file: "manual.py", mode: "transform" })],
      [
        workflowNode("script_run", { file: "missing.py", mode: "import" }),
        [
          { id: "py", name: "run.py" },
          { id: "js", name: "convert.js" },
          { id: "txt", name: "notes.txt" },
        ],
      ],
      [
        workflowNode("save_file", {
          name_template: "result-{{date}}",
          format: "md",
          mode: "append",
        }),
      ],
      [workflowNode("condition", { op: "contains", value: "approved" })],
      [workflowNode("condition", { op: "is_empty" })],
    ];
    for (const [node, files] of cases) {
      const view = await renderSheet(node, [], [], files);
      expect(view.host.textContent).toContain("Delete step");
      await view.close();
    }
  });

  it("binds selections, CSV values, clamps numeric fields, and preserves segmented actions", async () => {
    const summary = await renderSheet(
      workflowNode("summarize_file", {
        select: { type: "name_like", pattern: "old" },
      }),
    );
    const summarySelects = summary.host.querySelectorAll("select");
    await setValue(summarySelects[1], "all");
    expect(summary.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ select: { type: "all", pattern: "old" } }),
    );
    await setValue(summary.host.querySelectorAll("input[type=text]")[1], "new");
    expect(summary.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        select: { type: "name_like", pattern: "new" },
      }),
    );
    await summary.close();

    const extract = await renderSheet(
      workflowNode("extract", { fields: ["title"] }),
    );
    await setValue(
      input(extract, "input[placeholder='title, author, date']"),
      " title, author, , date ",
    );
    expect(extract.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ fields: ["title", "author", "date"] }),
    );
    await invoke(button(extract, "Local"));
    expect(extract.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: "local" }),
    );
    await extract.close();

    const route = await renderSheet(
      workflowNode("route", { labels: ["first"] }),
    );
    await setValue(
      input(route, "input[placeholder='urgent, normal, ignore']"),
      " urgent, normal ",
    );
    expect(route.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ labels: ["urgent", "normal"] }),
    );
    await route.close();

    const vote = await renderSheet(
      workflowNode("vote", { samples: 3, mode: "concat" }),
    );
    await setValue(input(vote, "input[type=number]"), "99");
    expect(vote.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ samples: 7 }),
    );
    await setValue(input(vote, "input[type=number]"), "not-a-number");
    expect(vote.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ samples: 1 }),
    );
    await invoke(button(vote, "Majority"));
    expect(vote.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "majority" }),
    );
    await vote.close();

    const refine = await renderSheet(workflowNode("refine", { max_rounds: 2 }));
    await setValue(input(refine, "input[type=number]"), "0");
    expect(refine.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ max_rounds: 1 }),
    );
    await refine.close();

    const plan = await renderSheet(
      workflowNode("plan_and_map", { max_workers: 4 }),
    );
    await setValue(input(plan, "input[type=number]"), "10");
    expect(plan.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ max_workers: 8 }),
    );
    await plan.close();
  });

  it("updates each remaining text, select, and segmented kind parameter", async () => {
    const filePass = await renderSheet(
      workflowNode("file_pass", { select: { type: "all" }, mode: "merge" }),
    );
    await invoke(button(filePass, "stitch"));
    expect(filePass.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "stitch" }),
    );
    await filePass.close();

    const forEach = await renderSheet(
      workflowNode("for_each_file", { instruction: "old" }),
    );
    await setValue(
      forEach.host.querySelectorAll("textarea")[0],
      "new instruction",
    );
    expect(forEach.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ instruction: "new instruction" }),
    );
    await forEach.close();

    const agent = await renderSheet(
      workflowNode("agent_run", { question: "old" }),
    );
    await setValue(
      agent.host.querySelector("textarea") as Element,
      "new question",
    );
    expect(agent.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ question: "new question" }),
    );
    await agent.close();

    const transform = await renderSheet(
      workflowNode("transform", { op: "replace", find: "old", value: "new" }),
    );
    const transformInputs = transform.host.querySelectorAll("input[type=text]");
    await setValue(transformInputs[1], "find me");
    expect(transform.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ find: "find me" }),
    );
    await setValue(transformInputs[2], "replace me");
    expect(transform.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ value: "replace me" }),
    );
    await transform.close();

    const merge = await renderSheet(workflowNode("merge", { mode: "concat" }));
    await setValue(merge.host.querySelectorAll("select")[1], "dedupe_lines");
    expect(merge.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "dedupe_lines" }),
    );
    await merge.close();

    const fetch = await renderSheet(workflowNode("http_fetch", { url: "old" }));
    await setValue(
      input(fetch, "input[placeholder='https://…']"),
      "https://new.test",
    );
    expect(fetch.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: "https://new.test" }),
    );
    await fetch.close();

    const script = await renderSheet(
      workflowNode("script_run", { file: "old.py", mode: "import" }),
      [],
      [],
      [{ id: "py", name: "old.py" }],
    );
    await setValue(script.host.querySelectorAll("select")[1], "old.py");
    expect(script.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ file: "old.py" }),
    );
    await invoke(button(script, "Pipe"));
    expect(script.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "transform" }),
    );
    await script.close();

    const save = await renderSheet(
      workflowNode("save_file", {
        name_template: "old",
        format: "html",
        mode: "create",
      }),
    );
    await setValue(save.host.querySelectorAll("input[type=text]")[1], "new.md");
    expect(save.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ name_template: "new.md" }),
    );
    await invoke(button(save, "md"));
    expect(save.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ format: "md" }),
    );
    await setValue(save.host.querySelectorAll("select")[1], "overwrite");
    expect(save.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "overwrite" }),
    );
    await save.close();

    const condition = await renderSheet(
      workflowNode("condition", { op: "contains", value: "old" }),
    );
    await setValue(
      condition.host.querySelectorAll("select")[1],
      "not_contains",
    );
    expect(condition.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ op: "not_contains" }),
    );
    await setValue(
      condition.host.querySelectorAll("input[type=text]")[1],
      "new value",
    );
    expect(condition.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ value: "new value" }),
    );
    await condition.close();
  });

  it("maintains branch and fan-in edges without dropping outcome labels", async () => {
    const target = workflowNode("generate", { id: "target" });
    const condition = workflowNode("condition", {
      id: "condition",
      label: "Decision",
    });
    const route = workflowNode("route", {
      id: "route",
      labels: ["urgent", "normal"],
    });
    const plain = workflowNode("agent_run", { id: "plain", label: "Ask" });
    const fanIn = await renderSheet(target, [], [target, condition, plain]);
    const checks = fanIn.host.querySelectorAll("input[type=checkbox]");
    await invoke(checks[0], "onChange");
    expect(fanIn.onEdgesChange).toHaveBeenLastCalledWith([
      { from: "condition", to: "target", branch: "then" },
    ]);
    await invoke(checks[1], "onChange");
    expect(fanIn.onEdgesChange).toHaveBeenLastCalledWith([
      { from: "plain", to: "target" },
    ]);
    await fanIn.draw(
      target,
      [{ from: "plain", to: "target" }],
      [target, plain],
    );
    await invoke(
      fanIn.host.querySelector("input[type=checkbox]") as Element,
      "onChange",
    );
    expect(fanIn.onEdgesChange).toHaveBeenLastCalledWith([]);
    await fanIn.close();

    const disabled = await renderSheet(
      workflowNode("route", { id: "solo", labels: ["only"] }),
      [],
      [workflowNode("route", { id: "solo", labels: ["only"] })],
    );
    expect(button(disabled, "Add branch").hasAttribute("disabled")).toBe(true);
    expect(disabled.host.textContent).toContain("Add at least two labels");
    await disabled.close();

    const branch = await renderSheet(
      condition,
      [{ from: "plain", to: "target" }],
      [condition, target, plain],
    );
    await invoke(button(branch, "Add branch"));
    expect(branch.onEdgesChange).toHaveBeenLastCalledWith([
      { from: "plain", to: "target" },
      { from: "condition", to: "target", branch: "then" },
    ]);
    const own = { from: "condition", to: "target", branch: "then" };
    await branch.draw(
      condition,
      [{ from: "plain", to: "target" }, own],
      [condition, target, plain],
    );
    const branchSelects = branch.host.querySelectorAll(".wf-branch-row select");
    await setValue(branchSelects[0], "else");
    expect(branch.onEdgesChange).toHaveBeenLastCalledWith([
      { from: "plain", to: "target" },
      { from: "condition", to: "target", branch: "else" },
    ]);
    await setValue(branchSelects[1], "plain");
    expect(branch.onEdgesChange).toHaveBeenLastCalledWith([
      { from: "plain", to: "target" },
      { from: "condition", to: "plain", branch: "then" },
    ]);
    await invoke(
      branch.host.querySelector("[aria-label='Remove branch']") as Element,
    );
    expect(branch.onEdgesChange).toHaveBeenLastCalledWith([
      { from: "plain", to: "target" },
    ]);
    await branch.close();

    const routed = await renderSheet(
      route,
      [{ from: "route", to: "target", branch: "urgent" }],
      [route, target],
    );
    await invoke(button(routed, "Add branch"));
    expect(routed.onEdgesChange).toHaveBeenLastCalledWith([
      { from: "route", to: "target", branch: "urgent" },
      { from: "route", to: "target", branch: "normal" },
    ]);
    await routed.close();

    const exhaustedRoute = workflowNode("route", {
      id: "exhausted-route",
      labels: ["only"],
    });
    const exhausted = await renderSheet(
      exhaustedRoute,
      [{ from: "exhausted-route", to: "target", branch: "only" }],
      [exhaustedRoute, target],
    );
    await invoke(button(exhausted, "Add branch"));
    expect(exhausted.onEdgesChange).toHaveBeenLastCalledWith([
      { from: "exhausted-route", to: "target", branch: "only" },
      { from: "exhausted-route", to: "target", branch: "only" },
    ]);
    await exhausted.close();

    const unlabeledRoute = workflowNode("route", {
      id: "unlabeled-route",
      labels: [],
    });
    const unlabeled = await renderSheet(
      unlabeledRoute,
      [],
      [unlabeledRoute, target],
    );
    await invoke(button(unlabeled, "Add branch"));
    expect(unlabeled.onEdgesChange).toHaveBeenLastCalledWith([
      { from: "unlabeled-route", to: "target", branch: "then" },
    ]);
    await unlabeled.close();
  });
});
