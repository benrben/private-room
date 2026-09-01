/** Cohesive extraction from sketchDoc.ts; its public API remains on that module. */
import { elementById } from "./sketchDocApply.js";
import { CANVAS_H, CANVAS_W, Element, Ink, MAX_ELEMENTS, Shape, Sketch, asciiLower, defaultSketch, elementBbox, plainElement, rustTrim, sketchNextId } from "./sketchDocModel.js";
import { route } from "./sketchDocRouting.js";
import { clampLabel } from "./sketchDocTokens.js";
// ---------------------------------------------------------------------------
// Laying a described graph out
// ---------------------------------------------------------------------------

/** One thing in a described diagram. */
export interface GraphNode {
  id: string;
  label: string;
  /** One short line of explanation, drawn under the box. */
  note?: string | null;
  /** `start`, `end` or anything else (a plain step). */
  kind?: string | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string | null;
}

/** `head.len()` is a BYTE length in the Rust source and `max / 2` a CHAR
 * budget; the mismatch is load-bearing (a 25-character Hebrew head is 50
 * bytes, and Rust keeps it where a UTF-16 length would drop it). */
export function clampWords(s: string, max: number): string {
  const t = rustTrim(s);
  const chars = [...t];
  if (chars.length <= max) {
    return t;
  }
  const cut = chars.slice(0, max).join("");
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace !== -1) {
    const head = cut.slice(0, lastSpace);
    if (Buffer.byteLength(head, "utf8") > Math.floor(max / 2)) {
      return `${head}…`;
    }
  }
  return `${cut}…`;
}

/**
 * Longest-path layering, cycle-safe.
 *
 * A described process is very often circular ("…and back to review"), and a
 * naive depth walk on one of those never terminates. Relaxing a bounded
 * number of times settles every acyclic part correctly and simply stops on
 * the rest, which draws a cycle as a back-arrow — the right picture anyway.
 */
export function layerNodes(n: number, edges: ReadonlyArray<readonly [number, number, string | null]>): number[] {
  const layer = new Array<number>(n).fill(0);
  relaxLayers(layer, incomingNodes(n, edges), edges);
  return cappedLayers(layer, n);
}

export function incomingNodes(
  n: number,
  edges: ReadonlyArray<readonly [number, number, string | null]>
): boolean[] {
  const incoming = new Array<boolean>(n).fill(false);
  for (const [, target] of edges) incoming[target] = true;
  return incoming;
}

export function relaxLayers(
  layer: number[],
  incoming: readonly boolean[],
  edges: ReadonlyArray<readonly [number, number, string | null]>
): void {
  for (let iteration = 0; iteration < Math.min(layer.length, 64); iteration++) {
    if (!relaxLayer(layer, incoming, edges)) break;
  }
}

export function relaxLayer(
  layer: number[],
  incoming: readonly boolean[],
  edges: ReadonlyArray<readonly [number, number, string | null]>
): boolean {
  let moved = false;
  for (const [source, target] of edges) {
    if (incoming[target] && (layer[target] as number) < (layer[source] as number) + 1) {
      layer[target] = (layer[source] as number) + 1;
      moved = true;
    }
  }
  return moved;
}

export function cappedLayers(layer: readonly number[], nodeCount: number): number[] {
  const cap = Math.min(nodeCount, 8);
  return layer.map((value) => Math.min(value, cap));
}

/** Ink by column, so the eye can follow the stages of a flow. The five pens
 * cycle; a diagram deeper than five layers repeats, which reads as a rhythm
 * rather than as five arbitrary colours. */
export const WHEEL: readonly Ink[] = ["blue", "green", "yellow", "pink", "red"];

/**
 * Turn a DESCRIBED graph into a drawing.
 *
 * This is the part `#sketch` exists for, and it is deliberately not the
 * model's job. Asked for a diagram, a model can reliably say what the boxes
 * are and which ones connect; it cannot reliably say where they go — that is
 * arithmetic over a canvas it cannot see, and it is where generated diagrams
 * come out overlapping and mis-wired.
 *
 * So the model supplies meaning and this supplies geometry: nodes are layered
 * by how far they sit from a starting point, laid out in columns, and every
 * edge is routed edge-to-edge by the same {@link route} the `link` command
 * uses. The result cannot overlap and cannot have a dangling arrow, which is
 * why `#sketch` needs no correction pass.
 */
export function layoutGraph(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): Sketch {
  const doc = defaultSketch();
  if (nodes.length === 0) return doc;
  const graph = preparedGraph(nodes, edges);
  sizeGraphCanvas(doc, graph.columns);
  const ids = drawGraphNodes(doc, graph.nodes, graph.columns);
  drawGraphEdges(doc, ids, graph.edges);
  return doc;
}

export type IndexedGraphEdge = readonly [number, number, string | null];

export interface PreparedGraph {
  nodes: readonly GraphNode[];
  edges: readonly IndexedGraphEdge[];
  columns: readonly number[][];
}

export const GRAPH_BOX_WIDTH = 300;
export const GRAPH_BOX_HEIGHT = 130;
export const GRAPH_GAP_X = 130;
export const GRAPH_GAP_Y = 90;
export const GRAPH_MARGIN = 80;

export function preparedGraph(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): PreparedGraph {
  const capped = nodes.slice(0, Math.floor(MAX_ELEMENTS / 4));
  const liveEdges = indexedGraphEdges(edges, graphNodeIndex(capped));
  return { nodes: capped, edges: liveEdges, columns: graphColumns(capped.length, liveEdges) };
}

export function graphNodeIndex(nodes: readonly GraphNode[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let position = 0; position < nodes.length; position++) {
    index.set((nodes[position] as GraphNode).id, position);
  }
  return index;
}

export function indexedGraphEdge(
  edge: GraphEdge,
  index: ReadonlyMap<string, number>,
): IndexedGraphEdge | null {
  const source = index.get(edge.from);
  if (source === undefined) return null;
  const target = index.get(edge.to);
  if (target === undefined) return null;
  if (source === target) return null;
  return [source, target, edge.label ?? null];
}

export function indexedGraphEdges(
  edges: readonly GraphEdge[],
  index: ReadonlyMap<string, number>
): IndexedGraphEdge[] {
  const live: IndexedGraphEdge[] = [];
  for (const edge of edges) {
    const indexed = indexedGraphEdge(edge, index);
    if (indexed !== null) live.push(indexed);
  }
  return live;
}

export function graphColumns(nodeCount: number, edges: readonly IndexedGraphEdge[]): number[][] {
  const layer = layerNodes(nodeCount, edges);
  const columns = Array.from({ length: Math.max(...layer) + 1 }, () => [] as number[]);
  for (let node = 0; node < layer.length; node++) {
    (columns[layer[node] as number] as number[]).push(node);
  }
  return columns;
}

export function sizeGraphCanvas(doc: Sketch, columns: readonly number[][]): void {
  const layers = columns.length;
  const tallest = Math.max(...columns.map((column) => column.length), 1);
  doc.width = Math.max(graphWidth(layers), CANVAS_W);
  doc.height = Math.max(graphHeight(tallest), CANVAS_H);
}

export function graphWidth(layers: number): number {
  return GRAPH_MARGIN * 2 + layers * GRAPH_BOX_WIDTH + Math.max(layers - 1, 0) * GRAPH_GAP_X;
}

export function graphHeight(rows: number): number {
  return GRAPH_MARGIN * 2 + rows * GRAPH_BOX_HEIGHT + Math.max(rows - 1, 0) * GRAPH_GAP_Y;
}

export function drawGraphNodes(doc: Sketch, nodes: readonly GraphNode[], columns: readonly number[][]): string[] {
  const ids = new Array<string>(nodes.length).fill("");
  for (let layer = 0; layer < columns.length; layer++) {
    const column = columns[layer] as number[];
    const position = graphColumnPosition(doc, column.length, layer);
    for (let row = 0; row < column.length; row++) {
      drawGraphNode(doc, nodes, ids, column[row] as number, position.x, position.top + row * (GRAPH_BOX_HEIGHT + GRAPH_GAP_Y), layer);
    }
  }
  return ids;
}

export function graphColumnPosition(doc: Sketch, rows: number, layer: number): { x: number; top: number } {
  const x = GRAPH_MARGIN + layer * (GRAPH_BOX_WIDTH + GRAPH_GAP_X);
  const block = rows * GRAPH_BOX_HEIGHT + Math.max(rows - 1, 0) * GRAPH_GAP_Y;
  return { x, top: Math.max(Math.trunc((doc.height - block) / 2), GRAPH_MARGIN) };
}

export function drawGraphNode(
  doc: Sketch,
  nodes: readonly GraphNode[],
  ids: string[],
  index: number,
  x: number,
  y: number,
  layer: number
): void {
  const node = nodes[index] as GraphNode;
  const terminal = isTerminalGraphNode(node);
  const ink = WHEEL[layer % WHEEL.length] as Ink;
  const id = sketchNextId(doc);
  doc.elements.push({
    ...plainElement(),
    id,
    shape: graphNodeShape(terminal, x, y),
    ink,
    fill: terminal,
    label: clampLabel(node.label),
  });
  ids[index] = id;
  drawGraphNote(doc, node.note, x, y, ink);
}

export function isTerminalGraphNode(node: GraphNode): boolean {
  const kind = asciiLower(node.kind ?? "");
  return kind === "start" || kind === "end" || kind === "terminal";
}

export function graphNodeShape(terminal: boolean, x: number, y: number): Shape {
  const type = terminal ? "ellipse" : "rect";
  return { type, x, y, w: GRAPH_BOX_WIDTH, h: GRAPH_BOX_HEIGHT };
}

export function drawGraphNote(doc: Sketch, source: string | null | undefined, x: number, y: number, ink: Ink): void {
  const note = rustTrim(source ?? "");
  if (note === "") return;
  doc.elements.push({
    ...plainElement(),
    id: sketchNextId(doc),
    shape: { type: "text", x, y: y + GRAPH_BOX_HEIGHT + 34, text: clampWords(note, 60), size: 22 },
    ink,
  });
}

export function drawGraphEdges(doc: Sketch, ids: readonly string[], edges: readonly IndexedGraphEdge[]): void {
  for (const edge of edges) drawGraphEdge(doc, ids, edge);
}

export function drawGraphEdge(doc: Sketch, ids: readonly string[], edge: IndexedGraphEdge): void {
  const [source, target, label] = edge;
  const from = ids[source] as string;
  const to = ids[target] as string;
  const [start, end] = route(elementBbox(elementById(doc, from) as Element), elementBbox(elementById(doc, to) as Element));
  doc.elements.push({
    ...plainElement(),
    id: sketchNextId(doc),
    shape: { type: "arrow", points: [start, end] },
    ink: "blue",
    label: graphEdgeLabel(label),
    from,
    to,
  });
}

export function graphEdgeLabel(label: string | null): string | null {
  if (label === null) return null;
  const clamped = clampLabel(label);
  return clamped === "" ? null : clamped;
}
