/**
 * Proves `sketchLayoutAdapter.ts`'s {@link layoutGraphReal} really
 * satisfies the `LayoutGraphFn` seam `chatCommandsGenerate.ts`'s `cmdSketch`
 * calls through `ctx.layoutGraph ?? layoutGraphNotImplemented` — i.e. that
 * wiring `ctx.layoutGraph = layoutGraphReal` wherever a real `CmdCtx` gets
 * assembled would make `#sketch` draw for real instead of hitting
 * `LAYOUT_GRAPH_NOT_IMPLEMENTED`.
 */

import { describe, expect, it } from "vitest";
import { layoutGraphNotImplemented, type CmdCtx, type GraphEdge, type GraphNode } from "./chatCommandsGenerate.js";
import { layoutGraphReal } from "./sketchLayoutAdapter.js";
import { sketchFromJson } from "./sketchDoc.js";

describe("layoutGraphReal", () => {
  it("is assignable to CmdCtx.layoutGraph — the exact seam #sketch reads", () => {
    // If this line does not type-check, the adapter does not satisfy the
    // seam. Runtime assertion below is the second half of the proof.
    const ctx: Pick<CmdCtx, "layoutGraph"> = { layoutGraph: layoutGraphReal };
    expect(ctx.layoutGraph).toBe(layoutGraphReal);
  });

  it("draws a real, laid-out .sketch document from described nodes and edges", () => {
    const nodes: GraphNode[] = [
      { id: "a", label: "Draft" },
      { id: "b", label: "Review" },
      { id: "c", label: "Published", kind: "end" },
    ];
    const edges: GraphEdge[] = [
      { from: "a", to: "b", label: "then" },
      { from: "b", to: "c", label: "then" },
    ];

    const doc = layoutGraphReal(nodes, edges);
    const parsed = sketchFromJson(doc.toJson());
    const boxes = parsed.elements.filter((e) => e.shape.type === "rect" || e.shape.type === "ellipse");
    expect(boxes).toHaveLength(3);
    expect(parsed.elements.filter((e) => e.shape.type === "arrow")).toHaveLength(2);

    const text = doc.extractedText();
    expect(text).toContain("Draft");
    expect(text).toContain("Review");
    expect(text).toContain("Published");
  });

  it("differs from the NOT_IMPLEMENTED default — the seam is genuinely closeable now", () => {
    expect(() => layoutGraphNotImplemented([{ id: "a", label: "A" }], [])).toThrow(/NOT_IMPLEMENTED/);
    expect(() => layoutGraphReal([{ id: "a", label: "A" }], [])).not.toThrow();
  });
});
