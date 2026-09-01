import { describe, expect, it } from "vitest";
import type { Workflow, WorkflowEdge, WorkflowNode } from "../../apiTypes";
import { branchFor, runDotClass, visibleWorkflows } from "./selectors";

function node(kind: WorkflowNode["kind"], extras: Record<string, unknown> = {}): WorkflowNode {
  return { id: `node-${kind}`, kind, ...extras };
}

function edge(branch?: string | null): WorkflowEdge {
  return { from: "from", to: "to", branch };
}

function workflow(id: string, createdBy: Workflow["createdBy"]): Workflow {
  return {
    id,
    name: id,
    description: "",
    emoji: "",
    definition: { version: 1, nodes: [], edges: [] },
    status: "draft",
    createdBy,
    binding: { scope: "general" },
    pinned: false,
    createdAt: "2026-08-31T00:00:00Z",
    updatedAt: "2026-08-31T00:00:00Z",
  };
}

describe("workflow selectors", () => {
  it("hides only script-owned workflows without changing visible order", () => {
    const user = workflow("user", "user");
    const script = workflow("script", "script");
    const agent = workflow("agent", "agent");
    expect(visibleWorkflows([user, script, agent])).toEqual([user, agent]);
  });

  it("chooses a truthful first unused condition or route outcome", () => {
    expect(branchFor(undefined, [])).toBeUndefined();
    expect(branchFor(node("generate"), [])).toBeUndefined();
    const condition = node("condition");
    expect(branchFor(condition, [])).toBe("then");
    expect(branchFor(condition, [edge("then")])).toBe("else");
    expect(branchFor(condition, [edge("then"), edge("else")])).toBe("then");

    const route = node("route", { labels: [" alpha ", "", 42] });
    expect(branchFor(route, [edge("alpha"), edge(null)])).toBe("42");
    expect(branchFor(route, [edge("alpha"), edge("42")])).toBe("alpha");
    expect(branchFor(node("route", { labels: "not labels" }), [])).toBeUndefined();
  });

  it("uses success, failure, and in-progress dot classes consistently", () => {
    expect(runDotClass("error")).toBe("dot-err");
    expect(runDotClass("failed")).toBe("dot-err");
    expect(runDotClass("done")).toBe("dot-ok");
    expect(runDotClass("paused")).toBe("dot-run");
  });
});
