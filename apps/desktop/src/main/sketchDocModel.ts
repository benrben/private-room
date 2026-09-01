/** Cohesive extraction from sketchDoc.ts; its public API remains on that module. */
import { has, own } from "./sketchDocJson.js";
import { reflow, route } from "./sketchDocRouting.js";
import { parseNum } from "./sketchDocTokens.js";
// ---------------------------------------------------------------------------
// Constants (sketchdoc.rs's own, verbatim)
// ---------------------------------------------------------------------------

/** The page every drawing starts on. Bounded rather than infinite: a model
 * placing a box on an unbounded plane has no frame of reference for "middle"
 * and produces coordinates that scatter off-screen. */
export const CANVAS_W = 1600;
export const CANVAS_H = 1000;

/** How far outside the page an element may sit before the layout checker
 * calls it out. Some overhang is legitimate (a stroke running off the edge). */
export const OFF_PAGE_SLACK = 40;

/** Ceilings. None of these is a design limit the user should ever meet; they
 * exist so a model that loses its place in a loop cannot write a 40 MB file. */
export const MAX_ELEMENTS = 400;
export const MAX_POINTS = 2_000;
export const MAX_LABEL_CHARS = 200;
export const MAX_SCRIPT_LINES = 600;
/** Reported errors per script. Past this the list stops being feedback and
 * starts being a wall of text that crowds out the model's own context. */
export const MAX_REPORTED_ERRORS = 12;

/** How far a connector stops short of the shape it points at. The editor's
 * own `CONNECT_GAP` (`src/viewers/sketch/model.ts`) is the same number, and
 * it has to be: the two sides route the SAME connector, so a difference of
 * two units means every alternation between the agent and the editor
 * rewrites the file. */
export const CONNECT_GAP = 8.0;

// ---------------------------------------------------------------------------
// Arithmetic helpers whose Rust semantics differ from the obvious JS spelling
// ---------------------------------------------------------------------------

/** Rust's `f64::round()`: ties away from zero. `Math.round` ties to +∞. */
export function roundTiesAwayFromZero(n: number): number {
  return n < 0 ? -Math.round(-n) : Math.round(n);
}

/**
 * Rust's `format!("{:.d}", v)`. Identical to `v.toFixed(d)` except on an
 * EXACT tie, where Rust rounds to even and `toFixed` rounds away from zero.
 *
 * A value is an exact tie at `d` decimals iff `v * 2^(d+1)` is an odd
 * integer — multiplying by a power of two is exact in binary floating point,
 * so this test never itself introduces rounding.
 */
export function fixed(v: number, d: number): string {
  const probe = v * 2 ** (d + 1);
  if (Number.isInteger(probe) && Math.abs(probe) % 2 === 1) {
    const scale = 10 ** d;
    const half = v * scale; // exact: v is a dyadic rational with a tiny denominator
    const lower = Math.floor(half);
    const picked = lower % 2 === 0 ? lower : lower + 1;
    const text = (picked / scale).toFixed(d);
    // Rust prints the SIGN of a negative value that rounds to zero
    // (`format!("{:.0}", -0.5)` is "-0"); dividing back through an integral
    // `picked` of 0 has already lost it. `toFixed` keeps the sign on every
    // non-tie (`(-0.4).toFixed(0)` is "-0"), so only this branch needs it.
    // `v < 0` deliberately excludes a literal -0: a coordinate reaches here
    // from an `i32`, which has no negative zero for Rust to print.
    return picked === 0 && v < 0 ? `-${text}` : text;
  }
  return v.toFixed(d);
}

/** Rust's `f64 as i64` (SATURATING) followed by `i64 as i32` (TRUNCATING to
 * the low 32 bits) — the two casts every coordinate in the script language
 * passes through, `parse_num` returning an `i64` and each call site writing
 * `as i32`. Identity for everything inside the `i32` range, so only a model
 * that has lost its place in a loop ever notices: `4294967296` is a width of
 * ZERO and refuses the line, where clamping the raw value would have drawn a
 * full-page box. */
export function asI32(n: number): number {
  if (n >= -2147483648 && n <= 2147483647) {
    return n;
  }
  if (!Number.isFinite(n)) {
    return 0; // unreachable: `parseNum` refuses a non-finite literal
  }
  const wide =
    n >= 9223372036854775808
      ? 9223372036854775807n
      : n <= -9223372036854775808
        ? -9223372036854775808n
        : BigInt(Math.trunc(n));
  return Number(BigInt.asIntN(32, wide));
}

/** Rust's `str::to_ascii_lowercase` — non-ASCII characters are left alone. */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** Rust's `str::eq_ignore_ascii_case`. */
export function eqIgnoreAsciiCase(a: string, b: string): boolean {
  return a.length === b.length && asciiLower(a) === asciiLower(b);
}

/** Rust's `Ord for String` — UTF-8 byte order, which differs from JS's
 * UTF-16 code-unit order for anything above the BMP. */
export function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** Rust's `char::is_whitespace()` (the Unicode White_Space property).
 * Deliberately not JS's `\s`, which misses U+0085 and adds U+FEFF. */
export const IS_WHITESPACE = /\p{White_Space}/u;

export const WS_PREFIX = /^\p{White_Space}+/u;
export const WS_SUFFIX = /\p{White_Space}+$/u;

/**
 * Rust's `str::trim` — the SAME Unicode White_Space property
 * {@link IS_WHITESPACE} uses, and deliberately not JS's `String#trim`, whose
 * set differs at both ends: it strips U+FEFF (which Rust keeps) and keeps
 * U+0085 (which Rust strips).
 *
 * Both directions decide real cases. A script whose first line carries a
 * byte-order mark — what a model copying out of a file emits — is REFUSED by
 * Rust (`\u{feff}rect` is not a command) and would be silently drawn under
 * JS's trim; and a label ending in U+0085 is stored one way by Rust and
 * another by JS, which is a document that opens as two different drawings
 * depending on which side read it.
 */
export function rustTrim(s: string): string {
  return s.replace(WS_PREFIX, "").replace(WS_SUFFIX, "");
}

/** Rust's `str::trim_end`. */
export function rustTrimEnd(s: string): string {
  return s.replace(WS_SUFFIX, "");
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** The five pens. Named, not hexed — see the module doc. Represented as the
 * lowercase string `serde`'s `rename_all = "lowercase"` writes, which is
 * also what `Ink::name()` returns. */
export type Ink = "pink" | "yellow" | "green" | "blue" | "red";

export const INK_DEFAULT: Ink = "blue";

export function isInk(v: unknown): v is Ink {
  return v === "pink" || v === "yellow" || v === "green" || v === "blue" || v === "red";
}

/** Ink for the drawn line. These are the light-theme values from
 * `tokens.css`, because a rendered sketch is drawn on paper whichever theme
 * the app itself is wearing — an exported file opened in Preview, or a
 * raster handed to a vision model, has no theme. */
export function inkHex(ink: Ink): string {
  switch (ink) {
    case "pink":
      return "#b23a78";
    case "yellow":
      return "#8a6d0b";
    case "green":
      return "#2e7d4f";
    case "blue":
      return "#2563b0";
    case "red":
      return "#b3362b";
  }
}

/** The translucent wash behind a filled shape. Kept well below the ink so a
 * label on top of a fill still clears contrast. */
export function inkFillHex(ink: Ink): string {
  switch (ink) {
    case "pink":
      return "#f2dbe8";
    case "yellow":
      return "#f0e6c4";
    case "green":
      return "#d7ecdf";
    case "blue":
      return "#d8e5f5";
    case "red":
      return "#f5dcd8";
  }
}

/**
 * Parse a colour WORD: the five names, plus the handful of near-misses a
 * model actually reaches for. Anything else is `null` rather than a silent
 * substitution — a drawing whose colours were quietly reassigned is worse
 * than one that refused and said why.
 *
 * SCRIPT LANGUAGE ONLY. JSON decoding is strict ({@link isInk}); a file
 * carrying `"ink":"magenta"` must fail exactly as it would in Rust, not
 * normalise to pink.
 */
export const INK_ALIASES: Readonly<Record<string, Ink>> = {
  pink: "pink",
  magenta: "pink",
  purple: "pink",
  violet: "pink",
  yellow: "yellow",
  orange: "yellow",
  amber: "yellow",
  gold: "yellow",
  green: "green",
  teal: "green",
  emerald: "green",
  lime: "green",
  blue: "blue",
  cyan: "blue",
  navy: "blue",
  indigo: "blue",
  red: "red",
  crimson: "red",
  scarlet: "red",
  maroon: "red",
};

export function inkParse(word: string): Ink | null {
  return INK_ALIASES[asciiLower(rustTrim(word))] ?? null;
}

/** A point, `[x, y]` — Rust's `[i32; 2]`, and the shape that round-trips
 * through the file, so a 2-tuple rather than an `{x,y}` object. */
export type Point = [number, number];

/** The geometry half of an element. Internally tagged and flattened into the
 * element object, so the JSON a human or a model reads is one flat map. `y`
 * on a text element is the BASELINE, matching SVG's own `<text y=…>`. */
export type Shape =
  | { type: "rect"; x: number; y: number; w: number; h: number }
  | { type: "ellipse"; x: number; y: number; w: number; h: number }
  | { type: "text"; x: number; y: number; text: string; size: number }
  | { type: "arrow"; points: Point[] }
  | { type: "line"; points: Point[] }
  | { type: "pen"; points: Point[] };

export interface Element {
  id: string;
  shape: Shape;
  ink: Ink;
  fill: boolean;
  /** The word this element carries. This is what makes a drawing legible to
   * a text-only model, so the tool descriptions push hard for it. */
  label: string | null;
  /** THE TWO ENDS OF A CONNECTOR. `link` used to compute two points and
   * forget which shapes they came from, so the arrow was a picture of a
   * relationship rather than the relationship itself: the next `move` left
   * it pointing at where a box had been. Recording the ends is what lets
   * {@link reflow} keep the diagram true — for the agent's edits and for the
   * editor's, which routes by the same rule. */
  from: string | null;
  to: string | null;
  /** Held in place: not pickable, draggable or erasable in the editor. */
  locked: boolean;
}

/** The parts of an element that are nothing in particular — no attachment,
 * not locked. Every construction site fills the fields it means and spreads
 * this, so adding a field later cannot silently give one call site a
 * different default from its neighbour (Rust's `Element::plain()`). */
export function plainElement(): Element {
  return {
    id: "",
    shape: { type: "rect", x: 0, y: 0, w: 0, h: 0 },
    ink: INK_DEFAULT,
    fill: false,
    label: null,
    from: null,
    to: null,
    locked: false,
  };
}

/** A rectangle in canvas units. Used for layout checks and arrow routing. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function rectRight(r: Rect): number {
  return r.x + r.w;
}
export function rectBottom(r: Rect): number {
  return r.y + r.h;
}
export function rectCx(r: Rect): number {
  return r.x + r.w / 2;
}
export function rectCy(r: Rect): number {
  return r.y + r.h / 2;
}
export function rectOverlap(a: Rect, b: Rect): [number, number] | null {
  const ox = Math.min(rectRight(a), rectRight(b)) - Math.max(a.x, b.x);
  const oy = Math.min(rectBottom(a), rectBottom(b)) - Math.max(a.y, b.y);
  return ox > 0 && oy > 0 ? [ox, oy] : null;
}
export function rectContains(r: Rect, px: number, py: number): boolean {
  return px >= r.x && px <= rectRight(r) && py >= r.y && py <= rectBottom(r);
}
export function grow(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
}

export function bboxOfPoints(points: readonly Point[]): Rect {
  if (points.length === 0) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [px, py] of points) {
    x0 = Math.min(x0, px);
    y0 = Math.min(y0, py);
    x1 = Math.max(x1, px);
    y1 = Math.max(y1, py);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The element's bounding box. Text is measured from its baseline with a
 * per-character estimate — exact metrics would need the font, and every
 * consumer here (overlap warnings, arrow routing) wants an approximation
 * that is stable across platforms rather than one that is precise on one.
 *
 * `chars` counts Unicode SCALAR VALUES (`text.chars().count()`), so it is
 * `[...text].length`, never `text.length`: an emoji is one character wide to
 * this estimate, not two.
 */
export function elementBbox(e: Element): Rect {
  const shape = e.shape;
  if (shape.type === "rect" || shape.type === "ellipse") return boxBbox(shape);
  return shape.type === "text" ? textBbox(shape) : bboxOfPoints(shape.points);
}

export function boxBbox(shape: Extract<Shape, { type: "rect" | "ellipse" }>): Rect {
  return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
}

export function textBbox(shape: Extract<Shape, { type: "text" }>): Rect {
  const chars = Math.max([...shape.text].length, 1);
  return {
    x: shape.x,
    y: shape.y - shape.size,
    w: roundTiesAwayFromZero(chars * shape.size * 0.52),
    h: roundTiesAwayFromZero(shape.size * 1.25),
  };
}

/** What the element says, for the index and for a text-only reader. */
export function elementWords(e: Element): string | null {
  return e.shape.type === "text" ? e.shape.text : e.label;
}

/** Shapes that enclose an area, and so can meaningfully overlap or be
 * pointed at. A stroke crossing a box is drawing, not a layout mistake. */
export function elementIsSolid(e: Element): boolean {
  return e.shape.type === "rect" || e.shape.type === "ellipse";
}

export interface Sketch {
  version: number;
  width: number;
  height: number;
  /** The id counter. Persisted so ids stay unique across sessions even after
   * elements are deleted — a reused id would silently retarget an `edit` the
   * model wrote against the older drawing. */
  seq: number;
  elements: Element[];
}

export function defaultSketch(): Sketch {
  return { version: 1, width: CANVAS_W, height: CANVAS_H, seq: 0, elements: [] };
}

/** `self.seq += 1; format!("e{}", self.seq)`. */
export function sketchNextId(doc: Sketch): string {
  doc.seq += 1;
  return `e${doc.seq}`;
}

export function sketchIndexOf(doc: Sketch, id: string): number {
  return doc.elements.findIndex((e) => e.id === id);
}

/**
 * The searchable text for this drawing: its labels and notes, one per line.
 * Deliberately NOT the JSON — indexing the document source would put
 * coordinates into search results and into the model's context.
 */
export function sketchExtractedText(doc: Sketch): string {
  let out = "";
  for (const e of doc.elements) {
    const w = elementWords(e);
    if (w !== null) {
      const trimmed = rustTrim(w);
      if (trimmed !== "") {
        out += trimmed;
        out += "\n";
      }
    }
  }
  return out;
}
