import { describe, expect, it } from "vitest";
import type { AskActiveAgent, AskPlanStep } from "../apiTypes";
import { chipClass, MAIN_KEY, toBands, toNodes } from "./agentNodes";

function step(agent: string, overrides: Partial<AskPlanStep> = {}): AskPlanStep {
  return {
    agent,
    label: `${agent} label`,
    instruction: `${agent} instruction`,
    ...overrides,
  };
}

function active(overrides: Partial<AskActiveAgent> = {}): AskActiveAgent {
  return { id: "files.read", label: "Files", step: 1, total: 1, ...overrides };
}

describe("agentNodes", () => {
  it("derives missing statuses from single and parallel active markers", () => {
    const plan = [step("files.read"), step("search.web"), step("chat.answer")];
    const single = toNodes(plan, active({ step: 2, total: 3 }));
    expect(single.map((node) => node.status)).toEqual(["done", "running", "pending"]);
    expect(single.map((node) => node.key)).toEqual(["files.read#0", "search.web#1", MAIN_KEY]);
    expect(single.map((node) => node.batch)).toEqual([0, 0, null]);

    const parallel = toNodes(plan, active({ step: 2, total: 3, active_steps: [1, 2] }));
    expect(parallel.map((node) => node.status)).toEqual(["running", "running", "pending"]);
  });

  it("uses complete roster metadata ahead of active-marker fallbacks", () => {
    const plan = [
      step("files.read", { key: "read-1", status: "failed", batch: 4 }),
      step("files.read", { key: "read-2", status: "done", batch: 4 }),
      step("chat.answer", { key: "main-custom", status: "pending", batch: 99 }),
    ];
    const nodes = toNodes(plan, active({ step: 1, total: 3, active_steps: [1, 2] }));
    expect(nodes.map((node) => [node.key, node.status, node.batch])).toEqual([
      ["read-1", "failed", 4],
      ["read-2", "done", 4],
      ["main-custom", "pending", 99],
    ]);
  });

  it("settles only a finished hub while preserving a tagged specialist failure", () => {
    const delegated = toNodes(
      [step("files.read", { status: "running" }), step("chat.answer", { status: "running" })],
      null,
      false,
    );
    expect(delegated.map((node) => node.status)).toEqual(["failed", "done"]);

    const tagged = toNodes([step("files.read", { status: "running" })], null, false);
    expect(tagged[0].status).toBe("failed");
    expect(toNodes([step("chat.answer", { status: "done" })], null, false)[0].status).toBe("done");
  });

  it("groups only consecutive children in roster order", () => {
    const nodes = toNodes([
      step("files.read", { batch: 0 }),
      step("search.web", { batch: 0 }),
      step("jobs.run", { batch: 1 }),
      step("files.read", { batch: 0 }),
      step("chat.answer"),
    ], null);
    expect(toBands(nodes).map((band) => band.map((node) => node.agent))).toEqual([
      ["files.read", "search.web"],
      ["jobs.run"],
      ["files.read"],
      ["chat.answer"],
    ]);
  });

  it("renders the flat chip statuses distinctly", () => {
    expect(chipClass("running")).toBe("active");
    expect(chipClass("failed")).toBe("failed");
    expect(chipClass("done")).toBe("done");
    expect(chipClass(undefined)).toBe("done");
  });
});
