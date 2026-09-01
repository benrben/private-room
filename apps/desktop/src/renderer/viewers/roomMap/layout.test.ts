import { describe, expect, it } from "vitest";
import { computeFit, clamp, handCircle, mulberry32, nodeRadius, runTick, seedFrom } from "./layout";
import type { SimEdge, SimNode } from "./types";

function node(id: string, x: number, y: number): SimNode {
  return { id, name: id, kind: "file", x, y };
}

function edge(ai: number, bi: number, hidden = false): SimEdge {
  return {
    ai,
    bi,
    hidden,
    edge: { a: "a", b: "b", kind: "derived", weight: 1, directed: true, shared: [] },
  };
}

function positions(nodes: SimNode[]) {
  return nodes.map(({ x, y }) => ({ x, y }));
}

describe("room-map layout", () => {
  it("keeps scalar and decorative helpers deterministic", () => {
    expect(clamp(-2, 0, 5)).toBe(0);
    expect(clamp(8, 0, 5)).toBe(5);
    expect(clamp(3, 0, 5)).toBe(3);
    expect(nodeRadius(0)).toBe(3.5);
    expect(nodeRadius(100)).toBe(9.5);
    expect(seedFrom("notes/plan.md")).toBe(seedFrom("notes/plan.md"));
    expect(seedFrom("notes/plan.md")).not.toBe(seedFrom("notes/review.md"));

    const first = mulberry32(42);
    const second = mulberry32(42);
    expect([first(), first(), first()]).toEqual([second(), second(), second()]);

    const circle = handCircle(5);
    expect(handCircle(5.01)).toBe(circle);
    expect(circle).toMatch(/^M-\d/);
    expect(circle).not.toContain("Z");
  });

  it("uses visible links, ignores hidden links, and resolves coincident nodes reproducibly", () => {
    const linked = [node("a", -100, 0), node("b", 100, 0)];
    const unlinked = [node("a", -100, 0), node("b", 100, 0)];
    runTick(linked, [edge(0, 1)], 10, 50);
    runTick(unlinked, [], 10, 50);
    expect(Math.abs(linked[0].x - linked[1].x)).toBeLessThan(
      Math.abs(unlinked[0].x - unlinked[1].x),
    );

    const hidden = [node("a", 0, 0), node("b", 40, 0)];
    const withoutEdge = [node("a", 0, 0), node("b", 40, 0)];
    runTick(hidden, [edge(0, 1, true)], 8, 20);
    runTick(withoutEdge, [], 8, 20);
    expect(positions(hidden)).toEqual(positions(withoutEdge));

    const first = [node("a", 0, 0), node("b", 0, 0)];
    const second = [node("a", 0, 0), node("b", 0, 0)];
    runTick(first, [edge(0, 1)], 5, 20);
    runTick(second, [edge(0, 1)], 5, 20);
    expect(positions(first)).toEqual(positions(second));
    expect(first.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
    expect(first[0].x).not.toBe(first[1].x);
  });

  it("contains an outlying node and fits bounds, degenerate views, and scale limits", () => {
    const centered = [node("center", 0, 0)];
    runTick(centered, [], 1, 10);
    expect(positions(centered)).toEqual([{ x: 0, y: 0 }]);

    const outlier = [node("far", 1000, 0)];
    runTick(outlier, [], 0, 10);
    expect(Math.hypot(outlier[0].x, outlier[0].y)).toBeCloseTo(31.5);

    expect(computeFit([], 200, 100)).toEqual({ k: 1, x: 100, y: 50 });
    expect(computeFit([node("a", 0, 0)], 0, 100)).toEqual({ k: 1, x: 0, y: 50 });
    expect(computeFit([node("a", 0, 0)], 100, 0)).toEqual({ k: 1, x: 50, y: 0 });
    expect(computeFit([node("a", -10, -20), node("b", 30, 20)], 500, 300)).toEqual({
      k: 4.9,
      x: 201,
      y: 150,
    });
    expect(computeFit([node("a", 0, 0)], 2_000, 2_000).k).toBe(12);
    expect(computeFit([node("a", -5_000, 0), node("b", 5_000, 0)], 200, 200).k).toBe(0.05);
    expect(computeFit([node("a", 0, 0)], Infinity, Infinity)).toEqual({
      k: 1,
      x: Infinity,
      y: Infinity,
    });
  });
});
