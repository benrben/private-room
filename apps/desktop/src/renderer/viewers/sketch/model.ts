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

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const round = (n: number) => Math.round(n);

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
    const v = JSON.parse(raw) as Partial<Sketch>;
    const elements = Array.isArray(v.elements) ? (v.elements as SketchElement[]) : [];
    const doc: Sketch = {
      version: typeof v.version === "number" ? v.version : 1,
      width: typeof v.width === "number" && v.width > 0 ? v.width : CANVAS_W,
      height: typeof v.height === "number" && v.height > 0 ? v.height : CANVAS_H,
      seq: typeof v.seq === "number" ? v.seq : 0,
      elements: elements.filter(isElement),
    };
    // The same counter recovery Rust does: a file written by hand, or one
    // whose seq was lost, must not mint an id that is already on the page.
    const high = doc.elements.reduce((m, e) => {
      const n = Number.parseInt(e.id.replace(/^e/, ""), 10);
      return Number.isFinite(n) ? Math.max(m, n) : m;
    }, 0);
    doc.seq = Math.max(doc.seq, high);
    return { doc, error: null };
  } catch (e) {
    return { doc: emptySketch(), error: e instanceof Error ? e.message : String(e) };
  }
}

function isElement(e: unknown): e is SketchElement {
  if (!e || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  if (typeof o.id !== "string") return false;
  switch (o.type) {
    case "rect":
    case "ellipse":
      return ["x", "y", "w", "h"].every((k) => typeof o[k] === "number");
    case "text":
      return typeof o.x === "number" && typeof o.y === "number" && typeof o.text === "string";
    case "arrow":
    case "line":
    case "pen":
      return Array.isArray(o.points) && o.points.length >= 2;
    default:
      return false;
  }
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
    if (e.type === "pen" || e.type === "line" || e.type === "arrow") {
      // A stroke has no interior to click, so the test is distance to the
      // polyline rather than its bounding box — a diagonal arrow's box covers
      // a large empty area the user is usually trying to click THROUGH.
      if (nearPolyline(e.points, x, y, 12)) return e;
      continue;
    }
    if (inRect(grow(bboxOf(e), 4), x, y)) return e;
  }
  return null;
}

function nearPolyline(points: Point[], px: number, py: number, tol: number): boolean {
  for (let i = 0; i < points.length - 1; i++) {
    if (distToSegment(points[i], points[i + 1], px, py) <= tol) return true;
  }
  return false;
}

function distToSegment(a: Point, b: Point, px: number, py: number): number {
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
  switch (e.type) {
    case "rect":
      return "Box";
    case "ellipse":
      return "Ellipse";
    case "text":
      return "Note";
    case "arrow":
      return e.from && e.to ? "Connector" : "Arrow";
    case "line":
      return "Line";
    default:
      return "Stroke";
  }
}

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
  let { x, y, w, ...rest } = box;
  let hgt = rest.h;
  if (even && box.w > 0 && box.h > 0 && h.length === 2) {
    // A corner drag: take the larger movement and derive the other axis, so
    // the shape cannot be squashed while Shift is held.
    const sx = h.includes("w") ? -1 : 1;
    const sy = h.startsWith("n") ? -1 : 1;
    const byW = (dx * sx) / box.w;
    const byH = (dy * sy) / box.h;
    const f = Math.abs(byW) > Math.abs(byH) ? byW : byH;
    dx = f * box.w * sx;
    dy = f * box.h * sy;
  }
  if (h.includes("w")) {
    x = box.x + dx;
    w = box.w - dx;
  } else if (h.includes("e")) {
    w = box.w + dx;
  }
  if (h.startsWith("n")) {
    y = box.y + dy;
    hgt = box.h - dy;
  } else if (h.startsWith("s")) {
    hgt = box.h + dy;
  }
  // A side dragged past its opposite flips rather than inverting: the shape
  // stays a rectangle with a positive size, which is what the person dragging
  // sees happen on every other canvas.
  if (w < 0) {
    x += w;
    w = -w;
  }
  if (hgt < 0) {
    y += hgt;
    hgt = -hgt;
  }
  return {
    x: round(x),
    y: round(y),
    w: round(Math.max(MIN_SIZE, w)),
    h: round(Math.max(MIN_SIZE, hgt)),
  };
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
export function reflow(doc: Sketch): Sketch {
  const boxes = new Map<string, Rect>();
  for (const e of doc.elements) boxes.set(e.id, bboxOf(e));
  let touched = false;
  const elements = doc.elements.map((e) => {
    if (e.type !== "arrow" && e.type !== "line") return e;
    if (!e.from && !e.to) return e;
    const a = e.from ? boxes.get(e.from) : undefined;
    const b = e.to ? boxes.get(e.to) : undefined;
    if (!a || !b) {
      // One end is gone. Forget the attachment rather than leaving a connector
      // that claims to join something the page no longer has.
      if ((e.from && !a) || (e.to && !b)) {
        touched = true;
        const { from: _f, to: _t, ...rest } = e;
        return rest as SketchElement;
      }
      return e;
    }
    const [p, q] = routeBetween(a, b);
    const [op, oq] = [e.points[0], e.points[e.points.length - 1]];
    if (op[0] === p[0] && op[1] === p[1] && oq[0] === q[0] && oq[1] === q[1]) return e;
    touched = true;
    return { ...e, points: [p, q] as Point[] };
  });
  return touched ? { ...doc, elements } : doc;
}

/** What a connector may attach to. A connector cannot hang off another
 * connector — that is a chain with no shape at the end of it — and a shape
 * cannot join itself. */
export function canConnect(e: SketchElement | null): e is SketchElement {
  return !!e && (e.type === "rect" || e.type === "ellipse" || e.type === "text");
}

// ---------------------------------------------------------------------------
// Arrangement
// ---------------------------------------------------------------------------

export type AlignEdge = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/**
 * Line a selection up against its own bounding box.
 *
 * Nothing moves along the other axis, and one element is a no-op — aligning a
 * single shape to "left" against itself would be a change with no meaning and
 * an undo entry to match.
 */
export function align(els: SketchElement[], edge: AlignEdge): SketchElement[] {
  const box = bboxOfMany(els);
  if (!box || els.length < 2) return els;
  return els.map((e) => {
    const b = bboxOf(e);
    switch (edge) {
      case "left":
        return translate(e, box.x - b.x, 0);
      case "right":
        return translate(e, box.x + box.w - (b.x + b.w), 0);
      case "hcenter":
        return translate(e, box.x + box.w / 2 - (b.x + b.w / 2), 0);
      case "top":
        return translate(e, 0, box.y - b.y);
      case "bottom":
        return translate(e, 0, box.y + box.h - (b.y + b.h));
      default:
        return translate(e, 0, box.y + box.h / 2 - (b.y + b.h / 2));
    }
  });
}

/**
 * Equal gaps between three or more elements, along one axis.
 *
 * The two outermost stay put — they define the span the rest are spread
 * inside — and the gap is the leftover space divided evenly, so shapes of
 * different sizes end up evenly SPACED rather than evenly numbered.
 */
export function distribute(els: SketchElement[], axis: "x" | "y"): SketchElement[] {
  if (els.length < 3) return els;
  const order = [...els].sort((p, q) =>
    axis === "x" ? bboxOf(p).x - bboxOf(q).x : bboxOf(p).y - bboxOf(q).y,
  );
  const span = bboxOfMany(order);
  if (!span) return els;
  const total = order.reduce((sum, e) => {
    const b = bboxOf(e);
    return sum + (axis === "x" ? b.w : b.h);
  }, 0);
  const gap = ((axis === "x" ? span.w : span.h) - total) / (order.length - 1);
  let cursor = axis === "x" ? span.x : span.y;
  const moved = new Map<string, SketchElement>();
  for (const e of order) {
    const b = bboxOf(e);
    moved.set(
      e.id,
      axis === "x" ? translate(e, cursor - b.x, 0) : translate(e, 0, cursor - b.y),
    );
    cursor += (axis === "x" ? b.w : b.h) + gap;
  }
  // Returned in the caller's order, not the sorted one: the document's element
  // order is its z-order, and quietly restacking a drawing because someone
  // tidied it is a change nobody asked for.
  return els.map((e) => moved.get(e.id) ?? e);
}

export type Ordering = "front" | "forward" | "backward" | "back";

/**
 * Move elements through the z-order, which IS the document's element order.
 *
 * The moved set keeps its own relative order in every direction, so sending
 * three overlapping shapes to the back does not shuffle them against each
 * other on the way.
 */
export function reorder(doc: Sketch, ids: string[], where: Ordering): Sketch {
  const picked = new Set(ids);
  if (!picked.size) return doc;
  const moving = doc.elements.filter((e) => picked.has(e.id));
  const rest = doc.elements.filter((e) => !picked.has(e.id));
  if (!moving.length) return doc;
  if (where === "front") return { ...doc, elements: [...rest, ...moving] };
  if (where === "back") return { ...doc, elements: [...moving, ...rest] };
  // One step. Walk in the direction of travel so a run of selected elements
  // moves as a block instead of piling onto the first free slot.
  const next = [...doc.elements];
  const step = where === "forward" ? 1 : -1;
  const order =
    step === 1
      ? next.map((_, i) => i).reverse()
      : next.map((_, i) => i);
  for (const i of order) {
    const j = i + step;
    if (j < 0 || j >= next.length) continue;
    if (!picked.has(next[i].id) || picked.has(next[j].id)) continue;
    [next[i], next[j]] = [next[j], next[i]];
  }
  return { ...doc, elements: next };
}

/** How far a copy lands from its original, so it is visibly a second thing. */
export const DUPLICATE_OFFSET = 24;

/**
 * Copy elements, giving each a fresh id.
 *
 * A connector between two copied shapes is re-pointed at the COPIES, so
 * duplicating a diagram gives a second working diagram rather than a second
 * set of boxes wired back into the first.
 */
export function duplicate(
  doc: Sketch,
  ids: string[],
  offset = DUPLICATE_OFFSET,
): { doc: Sketch; ids: string[] } {
  const picked = doc.elements.filter((e) => ids.includes(e.id));
  if (!picked.length) return { doc, ids: [] };
  let seq = doc.seq;
  const remap = new Map<string, string>();
  for (const e of picked) remap.set(e.id, `e${++seq}`);
  const copies = picked.map((e) => {
    const moved = translate(e, offset, offset);
    const copy: SketchElement = { ...moved, id: remap.get(e.id) as string };
    if (copy.from) copy.from = remap.get(copy.from) ?? copy.from;
    if (copy.to) copy.to = remap.get(copy.to) ?? copy.to;
    return copy;
  });
  return {
    doc: { ...doc, seq, elements: [...doc.elements, ...copies] },
    ids: copies.map((e) => e.id),
  };
}

// ---------------------------------------------------------------------------
// Snapping and guides
// ---------------------------------------------------------------------------

/** The paper's dot spacing — what "snap to grid" snaps to. */
export const GRID = 22;

export const snapTo = (n: number, grid = GRID) => Math.round(n / grid) * grid;

/** How near an edge has to be before it pulls, in canvas units. */
export const SNAP_TOLERANCE = 6;

export interface Guide {
  axis: "x" | "y";
  at: number;
}

/**
 * The alignment lines a moving box should snap to, and the offset that lands
 * it on them.
 *
 * Three lines per axis on each side — near edge, centre, far edge — which is
 * what makes "line this up with that" work without the user aiming: any of the
 * nine pairings can catch. The nearest catch on each axis wins, so a box
 * between two candidates does not jitter between them.
 */
export function guidesFor(
  moving: Rect,
  others: Rect[],
  tolerance = SNAP_TOLERANCE,
): { dx: number; dy: number; guides: Guide[] } {
  const linesX = (r: Rect) => [r.x, r.x + r.w / 2, r.x + r.w];
  const linesY = (r: Rect) => [r.y, r.y + r.h / 2, r.y + r.h];
  const guides: Guide[] = [];
  let dx = 0;
  let dy = 0;
  let bestX = tolerance + 1;
  let bestY = tolerance + 1;
  for (const o of others) {
    for (const mine of linesX(moving)) {
      for (const theirs of linesX(o)) {
        const d = theirs - mine;
        if (Math.abs(d) <= tolerance && Math.abs(d) < Math.abs(bestX)) {
          bestX = d;
          dx = d;
        }
      }
    }
    for (const mine of linesY(moving)) {
      for (const theirs of linesY(o)) {
        const d = theirs - mine;
        if (Math.abs(d) <= tolerance && Math.abs(d) < Math.abs(bestY)) {
          bestY = d;
          dy = d;
        }
      }
    }
  }
  // Report only the lines actually landed on, so the canvas draws a guide
  // exactly where the box is now — not everywhere it nearly was.
  if (Math.abs(bestX) <= tolerance) {
    const at = moving.x + dx;
    for (const o of others) {
      for (const theirs of linesX(o)) {
        if (linesX({ ...moving, x: at }).some((m) => Math.abs(m - theirs) < 0.5)) {
          guides.push({ axis: "x", at: theirs });
        }
      }
    }
  }
  if (Math.abs(bestY) <= tolerance) {
    const at = moving.y + dy;
    for (const o of others) {
      for (const theirs of linesY(o)) {
        if (linesY({ ...moving, y: at }).some((m) => Math.abs(m - theirs) < 0.5)) {
          guides.push({ axis: "y", at: theirs });
        }
      }
    }
  }
  return { dx, dy, guides };
}

// ---------------------------------------------------------------------------
// Freehand
// ---------------------------------------------------------------------------

/**
 * Ramer–Douglas–Peucker. Iterative, not recursive: a fast stroke on a
 * high-refresh trackpad arrives as thousands of coalesced points, and the
 * recursive form blows the stack on exactly the drawing someone put effort
 * into.
 */
export function simplify(points: Point[], tolerance = 1.2): Point[] {
  if (points.length <= 2) return points.slice();
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop() as [number, number];
    let worst = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = distToSegment(points[first], points[last], points[i][0], points[i][1]);
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (index !== -1 && worst > tolerance) {
      keep[index] = true;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Cap a stroke's point count so one very long scribble cannot bloat the file. */
export const MAX_STROKE_POINTS = 2000;

export function strokeFromTrail(trail: Point[]): Point[] {
  const simplified = simplify(
    trail.map(([x, y]) => [clamp(round(x), 0, CANVAS_W), clamp(round(y), 0, CANVAS_H)] as Point),
  );
  return simplified.length > MAX_STROKE_POINTS
    ? simplified.slice(0, MAX_STROKE_POINTS)
    : simplified;
}

// ---------------------------------------------------------------------------
// Deterministic hand-drawn geometry
// ---------------------------------------------------------------------------

/**
 * The same seeded wobble Rust renders with, ported so the editor and the
 * exported file draw the same picture.
 *
 * The seed is the element id and nothing else. Randomising per render would
 * make a box jitter on every React update — which reads as the drawing being
 * unstable — and would break the property the Rust tests lean on: one document
 * always produces one picture.
 */
export function seeded(id: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return () => {
    h ^= h << 13;
    h >>>= 0;
    h ^= h >>> 17;
    h ^= h << 5;
    h >>>= 0;
    return (h % 100000) / 100000;
  };
}

const jitter = (r: () => number, amp: number) => (r() * 2 - 1) * amp;

export function wobblySegment(
  r: () => number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  amp: number,
): string {
  const mx = (x1 + x2) / 2 + jitter(r, amp * 1.8);
  const my = (y1 + y2) / 2 + jitter(r, amp * 1.8);
  return `M${(x1 + jitter(r, amp)).toFixed(1)} ${(y1 + jitter(r, amp)).toFixed(1)}Q${mx.toFixed(
    1,
  )} ${my.toFixed(1)} ${(x2 + jitter(r, amp)).toFixed(1)} ${(y2 + jitter(r, amp)).toFixed(1)}`;
}

export function rectPath(r: () => number, x: number, y: number, w: number, h: number): string {
  let d = "";
  for (let pass = 0; pass < 2; pass++) {
    d += wobblySegment(r, x, y, x + w, y, 2.2);
    d += wobblySegment(r, x + w, y, x + w, y + h, 2.2);
    d += wobblySegment(r, x + w, y + h, x, y + h, 2.2);
    d += wobblySegment(r, x, y + h, x, y, 2.2);
  }
  return d;
}

export function ellipsePath(
  r: () => number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
): string {
  let d = "";
  const n = 16;
  const wob = Math.min(Math.min(rx, ry) * 0.04 + 1.5, 4);
  for (let pass = 0; pass < 2; pass++) {
    const pts: Point[] = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      const jr = jitter(r, wob);
      pts.push([cx + Math.cos(t) * (rx + jr), cy + Math.sin(t) * (ry + jr)]);
    }
    const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const start = mid(pts[0], pts[1 % n]);
    d += `M${start[0].toFixed(1)} ${start[1].toFixed(1)}`;
    for (let k = 1; k <= n; k++) {
      const a = pts[k % n];
      const b = pts[(k + 1) % n];
      const m = mid(a, b);
      d += `Q${a[0].toFixed(1)} ${a[1].toFixed(1)} ${m[0].toFixed(1)} ${m[1].toFixed(1)}`;
    }
    d += "Z";
  }
  return d;
}

export function strokePath(points: Point[]): string {
  if (points.length < 2) return "";
  if (points.length === 2) {
    return `M${points[0][0]} ${points[0][1]}L${points[1][0]} ${points[1][1]}`;
  }
  let d = `M${points[0][0]} ${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    d += `Q${a[0]} ${a[1]} ${((a[0] + b[0]) / 2).toFixed(1)} ${((a[1] + b[1]) / 2).toFixed(1)}`;
  }
  const last = points[points.length - 1];
  d += `L${last[0]} ${last[1]}`;
  return d;
}

/** The two short lines that make an arrowhead. */
export function arrowHead(points: Point[]): [Point, Point] {
  const [x1, y1] = points[0];
  const [x2, y2] = points[points.length - 1];
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const len = 20;
  return [
    [x2 + Math.cos(ang + 2.6) * len, y2 + Math.sin(ang + 2.6) * len],
    [x2 + Math.cos(ang - 2.6) * len, y2 + Math.sin(ang - 2.6) * len],
  ];
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/**
 * Snapshot undo, capped.
 *
 * A document here is a few hundred small objects, so a whole-document snapshot
 * per edit costs less than the bookkeeping an inverse-operation stack would
 * need — and it cannot drift out of step with the document the way a
 * hand-written inverse for each operation can.
 */
export const UNDO_DEPTH = 80;

export interface History {
  past: Sketch[];
  future: Sketch[];
}

export const emptyHistory = (): History => ({ past: [], future: [] });

export function pushHistory(h: History, before: Sketch): History {
  const past = [...h.past, before];
  return { past: past.length > UNDO_DEPTH ? past.slice(-UNDO_DEPTH) : past, future: [] };
}

export function undo(h: History, current: Sketch): { doc: Sketch; history: History } | null {
  if (!h.past.length) return null;
  const doc = h.past[h.past.length - 1];
  return {
    doc,
    history: { past: h.past.slice(0, -1), future: [current, ...h.future].slice(0, UNDO_DEPTH) },
  };
}

export function redo(h: History, current: Sketch): { doc: Sketch; history: History } | null {
  if (!h.future.length) return null;
  const doc = h.future[0];
  return {
    doc,
    history: { past: [...h.past, current].slice(-UNDO_DEPTH), future: h.future.slice(1) },
  };
}

// ---------------------------------------------------------------------------
// Merging the agent's work into an open editor
// ---------------------------------------------------------------------------

/**
 * Fold a drawing the agent just wrote into the page the user has open.
 *
 * The agent's document is authoritative for everything it touched, but it was
 * built from the file on disk — so anything the user drew since the last
 * autosave is not in it. Those elements are carried over rather than dropped:
 * losing a stroke someone just drew because the assistant happened to answer
 * at that moment is the worst failure this page can have.
 */
export function mergeAgentDoc(
  mine: Sketch,
  theirs: Sketch,
  removed: string[],
): { doc: Sketch; unsavedKept: string[] } {
  const theirIds = new Set(theirs.elements.map((e) => e.id));
  const gone = new Set(removed);
  const unsaved = mine.elements.filter((e) => !theirIds.has(e.id) && !gone.has(e.id));
  return {
    doc: {
      ...theirs,
      seq: Math.max(theirs.seq, mine.seq),
      elements: [...theirs.elements, ...unsaved],
    },
    unsavedKept: unsaved.map((e) => e.id),
  };
}
