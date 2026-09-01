import { CANVAS_H, CANVAS_W, clamp, distToSegment, round, translate, type Point, type Rect, type Sketch, type SketchElement } from "./model";
import { axisOrigin, axisSize, type Axis } from "./modelLayout";

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
  const xOffset = nearestGuideOffset(moving, others, "x", tolerance);
  const yOffset = nearestGuideOffset(moving, others, "y", tolerance);
  return {
    dx: xOffset ?? 0,
    dy: yOffset ?? 0,
    guides: [
      ...guidesAtSnap(moving, others, "x", xOffset),
      ...guidesAtSnap(moving, others, "y", yOffset),
    ],
  };
}

function nearestGuideOffset(
  moving: Rect,
  others: Rect[],
  axis: Axis,
  tolerance: number,
): number | null {
  let nearest = tolerance + 1;
  const movingLines = guideLines(moving, axis);
  for (const other of others) {
    for (const mine of movingLines) {
      for (const theirs of guideLines(other, axis)) {
        nearest = preferredGuideOffset(nearest, theirs - mine, tolerance);
      }
    }
  }
  return Math.abs(nearest) <= tolerance ? nearest : null;
}

function preferredGuideOffset(current: number, candidate: number, tolerance: number): number {
  if (Math.abs(candidate) > tolerance) return current;
  if (Math.abs(candidate) >= Math.abs(current)) return current;
  return candidate;
}

function guideLines(rect: Rect, axis: Axis): number[] {
  const start = axisOrigin(rect, axis);
  const size = axisSize(rect, axis);
  return [start, start + size / 2, start + size];
}

function guidesAtSnap(
  moving: Rect,
  others: Rect[],
  axis: Axis,
  offset: number | null,
): Guide[] {
  if (offset === null) return [];
  // Report only the lines actually landed on, so the canvas draws a guide
  // exactly where the box is now — not everywhere it nearly was.
  const snappedLines = guideLines(movedRect(moving, axis, offset), axis);
  const guides: Guide[] = [];
  for (const other of others) {
    for (const theirs of guideLines(other, axis)) {
      if (snappedLines.some((mine) => Math.abs(mine - theirs) < 0.5)) {
        guides.push({ axis, at: theirs });
      }
    }
  }
  return guides;
}

function movedRect(rect: Rect, axis: Axis, offset: number): Rect {
  return axis === "x" ? { ...rect, x: rect.x + offset } : { ...rect, y: rect.y + offset };
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
    const furthest = furthestPoint(points, first, last);
    if (!shouldKeepPoint(furthest, tolerance)) continue;
    keep[furthest.index] = true;
    stack.push([first, furthest.index], [furthest.index, last]);
  }
  return points.filter((_, i) => keep[i]);
}

function furthestPoint(points: Point[], first: number, last: number): { index: number; distance: number } {
  let furthest = { index: -1, distance: 0 };
  for (let index = first + 1; index < last; index++) {
    const point = points[index];
    const distance = distToSegment(points[first], points[last], point[0], point[1]);
    if (distance > furthest.distance) furthest = { index, distance };
  }
  return furthest;
}

function shouldKeepPoint(point: { index: number; distance: number }, tolerance: number): boolean {
  return point.index !== -1 && point.distance > tolerance;
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
