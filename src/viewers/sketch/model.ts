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
 * `e2e/page-script/sketch.test.mjs`. The React component holds no drawing
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
