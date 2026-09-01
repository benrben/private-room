import { describe, expect, it } from "vitest";
import {
  countByKind,
  edgeInk,
  edgeLines,
  edgeRank,
  filterEdges,
  rankEdges,
  styleFor,
  type EdgeFilter,
} from "./edges";
import type { GraphEdge } from "./types";

function edge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    a: "file-a",
    b: "file-b",
    kind: "derived",
    weight: 0.5,
    directed: true,
    shared: [],
    ...overrides,
  };
}

describe("room-map edges", () => {
  it("uses the memory-specific lead only for memory mentions and retains concise evidence", () => {
    expect(edgeLines(edge({ kind: "mentions", a: "mem:preference", shared: ["rare", "words", "only", "three"] }))).toEqual([
      "This memory's distinctive words appear in this file",
      "rare",
      "words",
      "only",
    ]);
    expect(edgeLines(edge({ kind: "mentions", a: "file-a" }))[0]).toBe(
      "This one names the other by name",
    );
    expect(edgeLines(edge({ kind: "future-kind" }))[0]).toBe(
      "These read alike — a guess, not a record",
    );
  });

  it("ranks fabricated facts before guesses and filters only inferred weak links", () => {
    const edges = [
      edge({ kind: "similar", weight: 0.99 }),
      edge({ kind: "same_site", weight: 0.1 }),
      edge({ kind: "derived", weight: 0.2 }),
      edge({ a: "file-a", b: "file-a", kind: "derived" }),
      edge({ b: "missing", kind: "mentions" }),
    ];
    const ranked = rankEdges(edges, new Set(["file-a", "file-b"]));
    expect(ranked.map((item) => item.kind)).toEqual(["derived", "same_site", "similar"]);
    expect(edgeRank("derived")).toBeLessThan(edgeRank("similar"));
    expect(edgeRank("future-kind")).toBeGreaterThan(edgeRank("similar"));
    expect(styleFor("future-kind")).toEqual(styleFor("similar"));

    const filter: EdgeFilter = { hidden: ["same_site"], minWeight: 0.9 };
    expect(filterEdges(ranked, filter).map((item) => item.kind)).toEqual(["derived", "similar"]);
    expect(countByKind(ranked)).toEqual({ derived: 1, same_site: 1, similar: 1 });
  });

  it("uses distinct fact and inferred ink ramps while clamping fabricated weights", () => {
    expect(edgeInk(edge({ kind: "derived", weight: -3 }), false)).toBe(0.55);
    expect(edgeInk(edge({ kind: "derived", weight: 3 }), true)).toBe(0.96);
    expect(edgeInk(edge({ kind: "similar", weight: 1 }), false)).toBe(0.75);
    expect(edgeInk(edge({ kind: "similar", weight: 1 }), true)).toBe(0.96);
  });
});
