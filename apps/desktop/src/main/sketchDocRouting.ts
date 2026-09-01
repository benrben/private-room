/** Cohesive extraction from sketchDoc.ts; its public API remains on that module. */
import { translate } from "./sketchDocApply.js";
import { has } from "./sketchDocJson.js";
import { layoutReport } from "./sketchDocLayout.js";
import { CONNECT_GAP, Element, Point, Rect, Shape, Sketch, bboxOfPoints, elementBbox, rectCx, rectCy, roundTiesAwayFromZero } from "./sketchDocModel.js";
// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Route an arrow between two boxes: centre to centre, trimmed to each box's
 * edge with a small gap.
 *
 * This exists so the model never does arrow arithmetic. Asked to connect two
 * boxes it will confidently emit endpoints that start inside one shape and
 * stop short of the other, and that error is invisible in text — it only
 * shows up in the picture, which the model usually cannot see.
 *
 * An endpoint belongs to the SHAPE it touches, not to the page. Nothing is
 * clamped here — the editor's `routeBetween` clamps nothing either, and the
 * two must agree to the unit or every alternation between the agent and the
 * editor rewrites the same connector.
 */
export function route(a: Rect, b: Rect): [Point, Point] {
  const ax = rectCx(a);
  const ay = rectCy(a);
  const bx = rectCx(b);
  const by = rectCy(b);
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.sqrt(dx * dx + dy * dy);
  // Two shapes sharing a centre have no direction between them. Both ends
  // land on the centres — the same answer `routeBetween` gives — rather than
  // dividing by a fabricated length of 1, which sent the ray to infinity and
  // wrote [0,0] into the file as `NaN as i32`.
  if (len === 0) {
    return [
      [roundTiesAwayFromZero(ax), roundTiesAwayFromZero(ay)],
      [roundTiesAwayFromZero(bx), roundTiesAwayFromZero(by)],
    ];
  }
  const ux = dx / len;
  const uy = dy / len;
  return [edgePoint(a, ux, uy, CONNECT_GAP), edgePoint(b, -ux, -uy, CONNECT_GAP)];
}

/**
 * Walk from a box's centre along a unit vector until leaving the box, plus a
 * gap. Uses the slab method so it is exact for any direction. The gap GROWS
 * THE BOX rather than extending the ray — on a diagonal the two are several
 * units apart, and the editor's port grows the box.
 */
export function edgePoint(r: Rect, ux: number, uy: number, gap: number): Point {
  const hw = r.w / 2 + gap;
  const hh = r.h / 2 + gap;
  const tx = ux === 0 ? Infinity : Math.abs(hw / ux);
  const ty = uy === 0 ? Infinity : Math.abs(hh / uy);
  const t = Math.min(tx, ty);
  // Neither axis was crossed: the direction is the zero vector, so there is
  // no edge to walk to. The centre is the honest answer.
  if (!Number.isFinite(t)) {
    return [roundTiesAwayFromZero(rectCx(r)), roundTiesAwayFromZero(rectCy(r))];
  }
  return [roundTiesAwayFromZero(rectCx(r) + ux * t), roundTiesAwayFromZero(rectCy(r) + uy * t)];
}

/**
 * Re-route every attached connector against where its ends are NOW.
 *
 * The other half of recording `from`/`to`. Without it a link is only correct
 * until the first `move`: the agent would tidy a diagram and leave every
 * arrow pointing at the empty space a box used to occupy — and, worse, keep
 * reporting the connection in {@link layoutReport}, so it would believe the
 * picture was still right.
 *
 * An end whose element is gone drops the attachment and keeps the last
 * points, exactly as the editor does. The two sides must agree: one
 * document, one picture, whoever drew it.
 */
export function reflow(doc: Sketch): void {
  const boxes = elementBoxes(doc.elements);
  for (const element of doc.elements) reflowElement(element, boxes);
}

export function elementBoxes(elements: readonly Element[]): Map<string, Rect> {
  const boxes = new Map<string, Rect>();
  for (const element of elements) boxes.set(element.id, elementBbox(element));
  return boxes;
}

export function reflowElement(element: Element, boxes: ReadonlyMap<string, Rect>): void {
  if (!hasAttachment(element) || !isRoutableShape(element.shape)) return;
  const ends = routedBoxes(element, boxes);
  if (ends === null) {
    clearAttachment(element);
    return;
  }
  const [start, end] = route(...ends);
  element.shape = { ...element.shape, points: [start, end] };
}

export function hasAttachment(element: Element): boolean {
  return element.from !== null || element.to !== null;
}

export function isRoutableShape(shape: Shape): shape is Extract<Shape, { type: "arrow" | "line" }> {
  return shape.type === "arrow" || shape.type === "line";
}

export function routedBoxes(element: Element, boxes: ReadonlyMap<string, Rect>): [Rect, Rect] | null {
  const from = boxForAttachment(element.from, boxes);
  const to = boxForAttachment(element.to, boxes);
  return from === undefined || to === undefined ? null : [from, to];
}

export function boxForAttachment(id: string | null, boxes: ReadonlyMap<string, Rect>): Rect | undefined {
  return id === null ? undefined : boxes.get(id);
}

export function clearAttachment(element: Element): void {
  element.from = null;
  element.to = null;
}

// ---------------------------------------------------------------------------
// Reading a drawing back out as script
// ---------------------------------------------------------------------------

export function quote(s: string): string {
  return `"${s.replaceAll('"', "'")}"`;
}

export type ScriptShapeFormatter = (element: Element, label: string) => string | null;

export function boxScript(
  element: Element,
  kind: "rect" | "ellipse",
  label: string
): string {
  const shape = element.shape as Extract<Shape, { type: "rect" | "ellipse" }>;
  const fill = element.fill ? " fill" : "";
  return `${element.id} ${kind} ${shape.x} ${shape.y} ${shape.w} ${shape.h} ${element.ink}${fill}${label}`;
}

export function textScript(element: Element): string {
  const shape = element.shape as Extract<Shape, { type: "text" }>;
  return `${element.id} text ${shape.x} ${shape.y} ${element.ink} ${shape.size} ${quote(shape.text)}`;
}

export function pointedShapeScript(
  element: Element,
  kind: "arrow" | "line",
  label: string
): string | null {
  const shape = element.shape as Extract<Shape, { type: "arrow" | "line" }>;
  const [start, end] = shape.points;
  if (start === undefined || end === undefined) {
    return null;
  }
  return `${element.id} ${kind} ${start[0]} ${start[1]} ${end[0]} ${end[1]} ${element.ink}${label}`;
}

export function penScript(element: Element, label: string): string {
  const shape = element.shape as Extract<Shape, { type: "pen" }>;
  const box = bboxOfPoints(shape.points);
  return `${element.id} pen ${element.ink} — freehand, ${shape.points.length} points around ${box.x} ${box.y} (${box.w}×${box.h})${label}`;
}

export const SHAPE_TO_SCRIPT: Record<Shape["type"], ScriptShapeFormatter> = {
  rect: (element, label) => boxScript(element, "rect", label),
  ellipse: (element, label) => boxScript(element, "ellipse", label),
  text: (element) => textScript(element),
  arrow: (element, label) => pointedShapeScript(element, "arrow", label),
  line: (element) => pointedShapeScript(element, "line", ""),
  pen: (element, label) => penScript(element, label),
};

export function elementScript(element: Element): string | null {
  const label = element.label !== null && element.label !== "" ? ` ${quote(element.label)}` : "";
  return SHAPE_TO_SCRIPT[element.shape.type](element, label);
}

/**
 * The drawing as the same language that writes it.
 *
 * Read and write share one vocabulary on purpose: a model that has just been
 * shown `e3 rect 250 400 320 130 blue "Login form"` does not have to
 * translate anything to edit it, and the round trip is testable in one
 * property.
 */
export function toScript(doc: Sketch): string {
  let out = `canvas ${doc.width} ${doc.height}\n`;
  for (const element of doc.elements) {
    const line = elementScript(element);
    if (line !== null) {
      out += `${line}\n`;
    }
  }
  return out;
}
