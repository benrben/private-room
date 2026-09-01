/**
 * The sketch document, on the frontend side.
 *
 * A faithful mirror of `src-tauri/src/commands/sketchdoc.rs` — the same flat
 * element shape, the same five inks, the same integer coordinates. Rust owns
 * the format (it parses the agent's script, renders the export and rasterises
 * the picture the agent looks at); this module owns what the editor needs on
 * top of it: hit-testing, the undo stack, and turning a live pointer trail
 * into a stroke.
 *
 * Everything here is pure so it can be tested without a DOM — see
 * `tests/contract/sketch.test.mjs`. The React component holds no drawing
 * logic that is not in this file.
 */

export const CANVAS_W = 1600;
export const CANVAS_H = 1000;

export const INKS = ["pink", "yellow", "green", "blue", "red"] as const;
export type Ink = (typeof INKS)[number];

export type Point = [number, number];

export type Shape =
  | { type: "rect"; x: number; y: number; w: number; h: number }
  | { type: "ellipse"; x: number; y: number; w: number; h: number }
  | { type: "text"; x: number; y: number; text: string; size: number }
  | { type: "arrow"; points: Point[] }
  | { type: "line"; points: Point[] }
  | { type: "pen"; points: Point[] };

export type ElementKind = Shape["type"];

/** One flat map, exactly as the file stores it and the agent reads it. */
export type SketchElement = Shape & {
  id: string;
  ink: Ink;
  fill?: boolean;
  label?: string;
  /** THE TWO ENDS OF A CONNECTOR, when it has them.
   *
   * An arrow that merely starts and ends near two boxes is a picture of a
   * relationship; an arrow that NAMES them is the relationship, and stays true
   * when either box moves. Both are optional and both are only meaningful on an
   * arrow or a line: a stroke drawn between two shapes by hand keeps working
   * exactly as it did, and a file written before this existed reads back
   * unchanged. `reflow` is what keeps the points honest afterwards. */
  from?: string;
  to?: string;
  /** Held in place. A locked element cannot be picked, dragged, resized or
   * erased — it is background, not furniture. Deliberately not "invisible to
   * hit-testing" in the marquee sense either: a lasso that quietly grabbed a
   * locked shape would move it. */
  locked?: boolean;
};

export interface Sketch {
  version: number;
  width: number;
  height: number;
  seq: number;
  elements: SketchElement[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const emptySketch = (): Sketch => ({
  version: 1,
  width: CANVAS_W,
  height: CANVAS_H,
  seq: 0,
  elements: [],
});

export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
export const round = (n: number) => Math.round(n);

/**
 * Read a document off disk.
 *
 * Never throws. A drawing that fails to parse must still open — as an empty
 * page with the failure reported — because the alternative is a file the user
 * can neither see nor repair, and the bytes are still in version history.
 */
export function parseSketch(raw: string): { doc: Sketch; error: string | null } {
  if (!raw || !raw.trim()) return { doc: emptySketch(), error: null };
  try {
    return { doc: parsedSketch(JSON.parse(raw) as Partial<Sketch>), error: null };
  } catch (e) {
    return { doc: emptySketch(), error: e instanceof Error ? e.message : String(e) };
  }
}

function parsedSketch(value: Partial<Sketch>): Sketch {
  const elements = parsedElements(value);
  return {
    version: typeof value.version === "number" ? value.version : 1,
    width: positiveDimension(value.width, CANVAS_W),
    height: positiveDimension(value.height, CANVAS_H),
    seq: Math.max(numericSequence(value.seq), highestElementSequence(elements)),
    elements,
  };
}

function parsedElements(value: Partial<Sketch>): SketchElement[] {
  const candidates = Array.isArray(value.elements) ? value.elements : [];
  return candidates.filter(isElement);
}

function positiveDimension(value: unknown, fallback: number): number {
  return typeof value === "number" && value > 0 ? value : fallback;
}

function numericSequence(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function highestElementSequence(elements: SketchElement[]): number {
  return elements.reduce((highest, element) => Math.max(highest, sequenceFromId(element.id)), 0);
}

function sequenceFromId(id: string): number {
  const sequence = Number.parseInt(id.replace(/^e/, ""), 10);
  return Number.isFinite(sequence) ? sequence : 0;
}

function isElement(e: unknown): e is SketchElement {
  if (!e || typeof e !== "object") return false;
  const element = e as Record<string, unknown>;
  const validator = elementValidator(element.type);
  return typeof element.id === "string" && validator?.(element) === true;
}

type ElementValidator = (element: Record<string, unknown>) => boolean;

const ELEMENT_VALIDATORS = new Map<string, ElementValidator>([
  ["rect", hasBoxCoordinates],
  ["ellipse", hasBoxCoordinates],
  ["text", hasTextCoordinates],
  ["arrow", hasPoints],
  ["line", hasPoints],
  ["pen", hasPoints],
]);

function elementValidator(type: unknown): ElementValidator | null {
  return typeof type === "string" ? ELEMENT_VALIDATORS.get(type) ?? null : null;
}

function hasBoxCoordinates(element: Record<string, unknown>): boolean {
  return ["x", "y", "w", "h"].every((key) => typeof element[key] === "number");
}

function hasTextCoordinates(element: Record<string, unknown>): boolean {
  return typeof element.x === "number" && typeof element.y === "number" && typeof element.text === "string";
}

function hasPoints(element: Record<string, unknown>): boolean {
  return Array.isArray(element.points) && element.points.length >= 2;
}

export const serializeSketch = (doc: Sketch): string => JSON.stringify(doc, null, 2);

export function nextId(doc: Sketch): { id: string; seq: number } {
  const seq = doc.seq + 1;
  return { id: `e${seq}`, seq };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export function bboxOf(e: SketchElement): Rect {
  switch (e.type) {
    case "rect":
    case "ellipse":
      return { x: e.x, y: e.y, w: e.w, h: e.h };
    case "text": {
      const chars = Math.max(1, e.text.length);
      return {
        x: e.x,
        y: e.y - e.size,
        w: Math.round(chars * e.size * 0.52),
        h: Math.round(e.size * 1.25),
      };
    }
    default:
      return bboxOfPoints(e.points);
  }
}

export function bboxOfPoints(points: Point[]): Rect {
  if (!points.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const grow = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  w: r.w + by * 2,
  h: r.h + by * 2,
});

const inRect = (r: Rect, x: number, y: number) =>
  x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/**
 * What is under the cursor. Topmost first — later elements draw over earlier
 * ones, so they must also be picked before them, or clicking a box that sits
 * on another selects the one underneath.
 */
export function hitTest(doc: Sketch, x: number, y: number): SketchElement | null {
  for (let i = doc.elements.length - 1; i >= 0; i--) {
    const e = doc.elements[i];
    if (hitsElement(e, x, y)) return e;
  }
  return null;
}

function hitsElement(element: SketchElement, x: number, y: number): boolean {
  if (isPolyline(element)) return nearPolyline(element.points, x, y, 12);
  return inRect(grow(bboxOf(element), 4), x, y);
}

function isPolyline(element: SketchElement): element is Extract<SketchElement, { points: Point[] }> {
  return element.type === "pen" || element.type === "line" || element.type === "arrow";
}

function nearPolyline(points: Point[], px: number, py: number, tol: number): boolean {
  for (let i = 0; i < points.length - 1; i++) {
    if (distToSegment(points[i], points[i + 1], px, py) <= tol) return true;
  }
  return false;
}

export function distToSegment(a: Point, b: Point, px: number, py: number): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - a[0], py - a[1]);
  let t = ((px - a[0]) * dx + (py - a[1]) * dy) / len2;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

/** Everything inside a marquee. */
export function hitTestArea(doc: Sketch, area: Rect): SketchElement[] {
  return doc.elements.filter((e) => {
    const b = bboxOf(e);
    return (
      b.x >= area.x && b.y >= area.y && b.x + b.w <= area.x + area.w && b.y + b.h <= area.y + area.h
    );
  });
}

export function translate(e: SketchElement, dx: number, dy: number): SketchElement {
  switch (e.type) {
    case "rect":
    case "ellipse":
      return {
        ...e,
        x: clamp(round(e.x + dx), 0, CANVAS_W - e.w),
        y: clamp(round(e.y + dy), 0, CANVAS_H - e.h),
      };
    case "text":
      return {
        ...e,
        x: clamp(round(e.x + dx), 0, CANVAS_W),
        y: clamp(round(e.y + dy), 0, CANVAS_H),
      };
    default:
      return {
        ...e,
        points: e.points.map(
          ([x, y]) =>
            [clamp(round(x + dx), 0, CANVAS_W), clamp(round(y + dy), 0, CANVAS_H)] as Point,
        ),
      };
  }
}

/** The union of several elements' boxes — what a multi-selection occupies. */
export function bboxOfMany(els: SketchElement[]): Rect | null {
  if (!els.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const e of els) {
    const b = bboxOf(e);
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ---------------------------------------------------------------------------
// Naming things
// ---------------------------------------------------------------------------

/** What this object is called, in the words the toolbar uses for the tool that
 * made it. An arrow that has been attached at both ends is a connector — it
 * behaves differently from a loose arrow, so it is named differently. */
export function kindOf(e: SketchElement): string {
  if (e.type === "arrow" && e.from && e.to) return "Connector";
  return KIND_NAMES[e.type];
}

const KIND_NAMES: Record<ElementKind, string> = {
  rect: "Box",
  ellipse: "Ellipse",
  text: "Note",
  arrow: "Arrow",
  line: "Line",
  pen: "Stroke",
};

/** The words written on an object, if any. */
function wordsOf(e: SketchElement): string {
  return (e.type === "text" ? e.text : e.label) ?? "";
}

/** How much of an object's own words a chip shows before it starts costing
 * more room than the next object is worth. */
export const CHIP_WORDS = 18;

/**
 * A chip's visible text: what the object is, and what it says.
 *
 * Deliberately NOT `describeElement`. The strip showed the full description on
 * every chip, which put coordinates nobody reads into the widest part of each
 * one and pushed the rest of the drawing off the end of the row. Coordinates
 * stay — in the title and the accessible name, where they cost no width.
 */
export function chipLabel(e: SketchElement): string {
  const words = wordsOf(e).trim();
  if (!words) return kindOf(e);
  const short =
    words.length > CHIP_WORDS ? `${words.slice(0, CHIP_WORDS - 1).trimEnd()}…` : words;
  return `${kindOf(e)} “${short}”`;
}

/** Everything about one object in a sentence: what it is, what it says, where
 * it sits, and whether it can be moved. This is the accessible name — the only
 * account of the drawing available to someone who cannot see it. */
export function describeElement(e: SketchElement): string {
  const words = wordsOf(e).trim();
  const b = bboxOf(e);
  return [
    kindOf(e),
    words ? `“${words}”` : null,
    `at ${Math.round(b.x)}, ${Math.round(b.y)}`,
    e.locked ? "locked" : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * What the toolbar's Undo or Redo button says it will do.
 *
 * There are two histories on this page and only one of them is the toolbar's.
 * A note or a label is a real text field with the platform's own undo, and the
 * drawing stays out of it on purpose — so someone who types, presses ⌘Z, and
 * then looks up at a greyed-out Undo has just watched both histories work
 * correctly and concluded that one is broken. The button says which is which
 * rather than repeating a shortcut that, right then, belongs to the field.
 */
export function historyHint(h: {
  verb: string;
  shortcut: string;
  depth: number;
  typing: boolean;
}): string {
  if (h.typing) {
    return `${h.verb} the drawing. ${h.shortcut} belongs to the text field while it is open.`;
  }
  if (h.depth === 0) return `Nothing to ${h.verb.toLowerCase()} on this drawing yet`;
  return `${h.verb} · ${h.shortcut}`;
}

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

/** The eight grips on a selection box, named for the corner or edge they own. */
export const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
export type Handle = (typeof HANDLES)[number];

/** Where a handle sits on a box, as a 0–1 fraction of each side. */
export function handleAt(box: Rect, h: Handle): Point {
  const fx = h.includes("w") ? 0 : h.includes("e") ? 1 : 0.5;
  const fy = h.startsWith("n") ? 0 : h.startsWith("s") ? 1 : 0.5;
  return [box.x + box.w * fx, box.y + box.h * fy];
}

/** The smallest a shape may be dragged down to. Below this a box has no
 * interior left to grab, so the next drag can only ever make it smaller. */
export const MIN_SIZE = 12;

/**
 * The box a resize gesture produces.
 *
 * Pure geometry over the ORIGINAL box and the total pointer movement, never
 * over the box as it stands mid-drag: accumulating deltas lets a rounding error
 * per event walk the shape across the page, and it makes the min-size clamp
 * sticky — once a side stops moving, the pointer has to travel all the way back
 * before it starts again.
 *
 * `even` is the Shift constraint: the box keeps the proportions it started
 * with, driven by whichever axis the pointer moved further along.
 */
export function resizedBox(
  box: Rect,
  h: Handle,
  dx: number,
  dy: number,
  even = false,
): Rect {
  const pointer = constrainedResizePointer(box, h, dx, dy, even);
  const horizontal = resizedHorizontalEdge(box, h, pointer.dx);
  const vertical = resizedVerticalEdge(box, h, pointer.dy);
  return normalisedResizeBox(horizontal, vertical);
}

function constrainedResizePointer(
  box: Rect,
  handle: Handle,
  dx: number,
  dy: number,
  even: boolean,
): { dx: number; dy: number } {
  if (!keepsAspectRatio(box, handle, even)) return { dx, dy };
  // A corner drag: take the larger movement and derive the other axis, so
  // the shape cannot be squashed while Shift is held.
  const sx = handle.includes("w") ? -1 : 1;
  const sy = handle.startsWith("n") ? -1 : 1;
  const byWidth = (dx * sx) / box.w;
  const byHeight = (dy * sy) / box.h;
  const factor = Math.abs(byWidth) > Math.abs(byHeight) ? byWidth : byHeight;
  return { dx: factor * box.w * sx, dy: factor * box.h * sy };
}

function keepsAspectRatio(box: Rect, handle: Handle, even: boolean): boolean {
  return even && box.w > 0 && box.h > 0 && handle.length === 2;
}

function resizedHorizontalEdge(box: Rect, handle: Handle, dx: number): Pick<Rect, "x" | "w"> {
  if (handle.includes("w")) return { x: box.x + dx, w: box.w - dx };
  if (handle.includes("e")) return { x: box.x, w: box.w + dx };
  return { x: box.x, w: box.w };
}

function resizedVerticalEdge(box: Rect, handle: Handle, dy: number): Pick<Rect, "y" | "h"> {
  if (handle.startsWith("n")) return { y: box.y + dy, h: box.h - dy };
  if (handle.startsWith("s")) return { y: box.y, h: box.h + dy };
  return { y: box.y, h: box.h };
}

function normalisedResizeBox(
  horizontal: Pick<Rect, "x" | "w">,
  vertical: Pick<Rect, "y" | "h">,
): Rect {
  const width = positiveResizeSize(horizontal.x, horizontal.w);
  const height = positiveResizeSize(vertical.y, vertical.h);
  return {
    x: round(width.origin),
    y: round(height.origin),
    w: round(Math.max(MIN_SIZE, width.size)),
    h: round(Math.max(MIN_SIZE, height.size)),
  };
}

function positiveResizeSize(origin: number, size: number): { origin: number; size: number } {
  // A side dragged past its opposite flips rather than inverting: the shape
  // stays a rectangle with a positive size, which is what the person dragging
  // sees happen on every other canvas.
  if (size < 0) return { origin: origin + size, size: -size };
  return { origin, size };
}

/** Map an element from one box onto another, proportionally.
 *
 * One function for every kind, so a resize can act on a mixed selection: a
 * stroke's points scale with the box that contains them, and text scales by
 * its size rather than being stretched, because a stretched glyph is the one
 * result nobody wants. */
export function fitToBox(e: SketchElement, from: Rect, to: Rect): SketchElement {
  const sx = from.w === 0 ? 1 : to.w / from.w;
  const sy = from.h === 0 ? 1 : to.h / from.h;
  const mapX = (x: number) => clamp(round(to.x + (x - from.x) * sx), 0, CANVAS_W);
  const mapY = (y: number) => clamp(round(to.y + (y - from.y) * sy), 0, CANVAS_H);
  switch (e.type) {
    case "rect":
    case "ellipse": {
      const x = mapX(e.x);
      const y = mapY(e.y);
      return {
        ...e,
        x,
        y,
        w: Math.max(MIN_SIZE, round(Math.min(e.w * sx, CANVAS_W - x))),
        h: Math.max(MIN_SIZE, round(Math.min(e.h * sy, CANVAS_H - y))),
      };
    }
    case "text":
      return {
        ...e,
        x: mapX(e.x),
        y: mapY(e.y),
        // The smaller factor, so text inside a box being made narrow shrinks
        // with it rather than overflowing the shape it belongs to.
        size: Math.max(8, round(e.size * Math.min(Math.abs(sx), Math.abs(sy)))),
      };
    default:
      return { ...e, points: e.points.map(([x, y]) => [mapX(x), mapY(y)] as Point) };
  }
}

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

/** How far a connector stops short of the shape it points at. */
const CONNECT_GAP = 8;

/** Where a ray leaving `r`'s centre in direction (ux, uy) crosses its edge.
 *
 * The same rule Rust routes with (`sketchdoc.rs` `edge_point`), ported so the
 * editor and the exported file draw one picture. Two implementations of a
 * connector's geometry would disagree the first time either was touched. */
export function edgePoint(r: Rect, ux: number, uy: number, gap = CONNECT_GAP): Point {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const hw = r.w / 2 + gap;
  const hh = r.h / 2 + gap;
  // The nearer of the two axis crossings is the one on the box.
  const tx = ux === 0 ? Infinity : Math.abs(hw / ux);
  const ty = uy === 0 ? Infinity : Math.abs(hh / uy);
  const t = Math.min(tx, ty);
  if (!Number.isFinite(t)) return [round(cx), round(cy)];
  return [round(cx + ux * t), round(cy + uy * t)];
}

/** The two ends of a connector between two boxes. */
export function routeBetween(a: Rect, b: Rect): [Point, Point] {
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2;
  const by = b.y + b.h / 2;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len === 0) return [[round(ax), round(ay)], [round(bx), round(by)]];
  const ux = dx / len;
  const uy = dy / len;
  return [edgePoint(a, ux, uy), edgePoint(b, -ux, -uy)];
}

/**
 * Re-route every attached connector against where its ends are NOW.
 *
 * Called after any move, resize, alignment or delete. This is the whole
 * difference between an arrow and a connector: the picture stays true when the
 * boxes move, without the person who moved them having to fix it.
 *
 * An end whose element is gone drops the attachment and keeps its last
 * points — the arrow stays exactly where it was drawn rather than vanishing or
 * springing to the corner of the page, and the user can delete it themselves.
 */

export { reflow, canConnect, align, distribute, reorder } from "./modelLayout";
export type { AlignEdge, Axis, Ordering } from "./modelLayout";
export { DUPLICATE_OFFSET, duplicate, GRID, snapTo, SNAP_TOLERANCE, guidesFor, simplify, MAX_STROKE_POINTS, strokeFromTrail, seeded, wobblySegment, rectPath, ellipsePath, strokePath, arrowHead, UNDO_DEPTH, emptyHistory, pushHistory, undo, redo, mergeAgentDoc } from "./modelDrawing";
export type { Guide, History } from "./modelDrawing";
