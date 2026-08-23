/**
 * Closes the `#sketch` seam `chatCommandsGenerate.ts` left open.
 *
 * That file's own module doc names exactly this gap — "`commands::sketchdoc
 * ::layout_graph` (2811 lines — node/edge geometry, arrow routing, the
 * `.sketch` JSON format). No Electron port anywhere in this tree." — and
 * exposes an injectable `CmdCtx.layoutGraph?: LayoutGraphFn` defaulting to
 * its own `layoutGraphNotImplemented`, which `cmdSketch` falls back to.
 * `sketchDoc.ts` IS that port, now real and tested.
 *
 * This file is the ADAPTER between the two and nothing else: `layoutGraph`'s
 * `Sketch` return value wrapped as the plain `{toJson, extractedText}`
 * object the seam's contract expects. It does not edit
 * `chatCommandsGenerate.ts` — wiring `ctx.layoutGraph = layoutGraphReal`
 * wherever a real `CmdCtx` is assembled for a live `#sketch` call belongs to
 * whichever host-bootstrap batch assembles one, the same "seam exists, not
 * yet plugged in" posture every other unwired `CmdCtx`/`ExecToolDeps` field
 * in this port documents for itself.
 *
 * The `GraphNode`/`GraphEdge`/`SketchDoc`/`LayoutGraphFn` types are
 * TYPE-ONLY imports from `chatCommandsGenerate.ts` — erased at compile time,
 * so this creates no runtime dependency on that file and no import cycle.
 * Importing the real types rather than re-declaring look-alikes means `tsc`
 * itself proves this adapter satisfies the seam's actual contract.
 */

import type { GraphEdge, GraphNode, LayoutGraphFn, SketchDoc } from "./chatCommandsGenerate.js";
import { layoutGraph, sketchExtractedText, sketchToJson } from "./sketchDoc.js";

/**
 * `commands::sketchdoc::layout_graph`, adapted to the `LayoutGraphFn` shape
 * `#sketch` reads through `CmdCtx.layoutGraph`. Synchronous, matching both
 * the Rust call and the seam's own declared (non-`Promise`) signature —
 * `layoutGraph`/`sketchToJson`/`sketchExtractedText` are all pure, unlike
 * `sketchRaster.ts`'s `toPng`.
 */
export const layoutGraphReal: LayoutGraphFn = (
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[]
): SketchDoc => {
  const doc = layoutGraph(nodes, edges);
  return {
    toJson: () => sketchToJson(doc),
    extractedText: () => sketchExtractedText(doc),
  };
};
