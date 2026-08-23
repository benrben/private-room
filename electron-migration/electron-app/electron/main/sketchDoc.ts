/**
 * Ported from `src-tauri/src/commands/sketchdoc.rs` (2,811 lines, read in
 * full) — the `.sketch` document format's model, script language, arrow
 * router, layout checker, SVG renderer and described-graph layout engine.
 * The PNG rasteriser (`to_png`), the one piece with a native dependency,
 * lives in `sketchRaster.ts`; the command/tool layer (`sketch.rs`) lives in
 * `sketchCommands.ts`.
 *
 * Everything here is pure, synchronous and deterministic: the same document
 * always produces the same bytes, which is the property the whole format
 * leans on (the hand-drawn "wobble" is seeded from an element's id and
 * nothing else, so a drawing does not redraw differently every time it is
 * opened).
 *
 * Three decisions carried over verbatim from the Rust module doc, each of
 * them a response to a measured failure rather than a preference:
 *
 * 1. THE AGENT NEVER WRITES SVG PATH DATA. Published evaluations of
 *    model-authored SVG put `<path d="…">` at the centre of the failure
 *    distribution, and the error rate climbs with scene complexity. So the
 *    model emits `rect 250 400 320 130 blue "Login form"` and THIS module
 *    emits the geometry. SVG is an output of the format, never an input.
 * 2. COORDINATES ARE INTEGERS ON A FIXED PAGE, clamped rather than refused —
 *    a model that put a box at x=1700 meant it near the right edge, and the
 *    layout report names what moved.
 * 3. COLOUR IS ONE OF FIVE MARKER NAMES, never a hex value, so every drawing
 *    is theme-correct by construction.
 *
 * The script parser is FORGIVING on purpose ({@link sortTokens} sorts tokens
 * by what they LOOK like, not by position, so all three of `rect 250 400 320
 * 130 blue "x"`, `rect x=250 y=400 w=320 h=130 ink=blue "x"` and
 * `rect 250 400 320 130 "x" blue` mean the same thing). VALIDATION is not
 * forgiving: {@link applyScript} is two-pass, so a script with any bad line
 * changes NOTHING and reports every problem at once.
 *
 * ERROR CONVENTION. {@link sketchFromJson} THROWS (Rust's
 * `Result<Sketch, String>`, this port's db-host convention). {@link
 * applyScript} and {@link parseStmt} instead keep a DISCRIMINATED-UNION
 * return, exactly as `editMatch.ts`'s module doc prescribes for a
 * `Result<_, String>` whose failure is a routine, expected outcome: a
 * blanket `catch` around a parser with a dozen internal failure branches
 * would silently swallow an unrelated bug and report it as "line 4 is
 * wrong".
 *
 * ARITHMETIC FIDELITY (verified against a compiled-`rustc` oracle built from
 * this exact Rust source, not derived from the formulae):
 *
 *  - `f64::round()` rounds ties AWAY FROM ZERO (-227.5 → -228); JS's
 *    `Math.round` rounds ties towards +∞ (-227.5 → -227). Every `.round() as
 *    i32` site goes through {@link roundTiesAwayFromZero}. This is reachable:
 *    routing a connector to a box at negative coordinates (a hand-edited
 *    file, or a page resized out from under a shape) hits an exact .5 tie.
 *  - Rust's `{:.N}` float formatting rounds ties to EVEN (`{:.0}` of 250.5 is
 *    "250", of 251.5 is "252"); JS's `toFixed` rounds ties away from zero.
 *    {@link fixed} implements Rust's rule. Reachable on every odd-width box:
 *    a 301-wide rect centred at 250.5 writes its label at x="250" in Rust and
 *    x="251" under a naive `toFixed`.
 *  - Rust `to_ascii_lowercase`/`eq_ignore_ascii_case` leave non-ASCII alone
 *    ("CAFÉ" → "cafÉ"); JS `toLowerCase()` does not ("café"). {@link
 *    asciiLower} is used at every site whose Rust original is the ASCII one —
 *    most visibly {@link layoutReport}'s duplicate-label key, where the
 *    difference is a spurious "both say" note on two differently-cased
 *    accented labels.
 *  - Rust sorts `String` by UTF-8 BYTES; JS sorts by UTF-16 code units, and
 *    the two disagree above the BMP (an emoji label sorts before a fullwidth
 *    one in JS, after it in Rust). {@link compareUtf8} keeps
 *    {@link layoutReport}'s note order identical.
 *  - `clamp_words`'s `head.len() > max / 2` is a BYTE length against a CHAR
 *    count — a deliberate-looking mismatch in the Rust source that decides
 *    real cases (a 25-character Hebrew head is 50 bytes, so it passes the
 *    test its UTF-16 length would fail).
 *
 * SECURITY. Every map keyed by a room- or model-controlled string —
 * `Tokens.named` (a `x=250`-style script token), {@link reflow}'s box
 * lookup, {@link layoutReport}'s duplicate-label key, {@link layoutGraph}'s
 * node-id index — is a `Map`, never a plain `{}`; and every read out of a
 * `JSON.parse`d element object is `hasOwnProperty`-guarded. A `"__proto__"`
 * id, label or key therefore cannot reach `Object.prototype`.
 *
 * JSON SHAPE. Rust's `Element` is `#[serde(flatten)] shape: Shape` over a
 * `#[serde(tag = "type")]` enum, i.e. ONE FLAT MAP per element —
 * `{"id":"e1","type":"rect","x":250,…}`, never a nested `"shape"` key — with
 * `fill`/`label`/`from`/`to`/`locked` omitted at their defaults. Neither
 * `JSON.stringify` nor `JSON.parse` can express that, so
 * {@link elementToJsonValue}/{@link elementFromJsonValue} hand-roll it.
 * READING IS STRICT, matching serde: a document missing `version`/`width`/
 * `height`/`seq`/`elements`, or carrying an element with an unknown `type`
 * or a non-integer coordinate, fails the WHOLE read rather than being
 * partially adopted — because `writeSketch` parses before it writes, and a
 * lenient reader there would let a malformed document quietly become the
 * file and open as a different drawing on the Rust side.
 */

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
const OFF_PAGE_SLACK = 40;

/** Ceilings. None of these is a design limit the user should ever meet; they
 * exist so a model that loses its place in a loop cannot write a 40 MB file. */
export const MAX_ELEMENTS = 400;
const MAX_POINTS = 2_000;
const MAX_LABEL_CHARS = 200;
export const MAX_SCRIPT_LINES = 600;
/** Reported errors per script. Past this the list stops being feedback and
 * starts being a wall of text that crowds out the model's own context. */
const MAX_REPORTED_ERRORS = 12;

/** How far a connector stops short of the shape it points at. The editor's
 * own `CONNECT_GAP` (`src/viewers/sketch/model.ts`) is the same number, and
 * it has to be: the two sides route the SAME connector, so a difference of
 * two units means every alternation between the agent and the editor
 * rewrites the file. */
const CONNECT_GAP = 8.0;

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
function eqIgnoreAsciiCase(a: string, b: string): boolean {
  return a.length === b.length && asciiLower(a) === asciiLower(b);
}

/** Rust's `Ord for String` — UTF-8 byte order, which differs from JS's
 * UTF-16 code-unit order for anything above the BMP. */
export function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** Rust's `char::is_whitespace()` (the Unicode White_Space property).
 * Deliberately not JS's `\s`, which misses U+0085 and adds U+FEFF. */
const IS_WHITESPACE = /\p{White_Space}/u;

const WS_PREFIX = /^\p{White_Space}+/u;
const WS_SUFFIX = /\p{White_Space}+$/u;

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
function rustTrimEnd(s: string): string {
  return s.replace(WS_SUFFIX, "");
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** The five pens. Named, not hexed — see the module doc. Represented as the
 * lowercase string `serde`'s `rename_all = "lowercase"` writes, which is
 * also what `Ink::name()` returns. */
export type Ink = "pink" | "yellow" | "green" | "blue" | "red";

const INK_DEFAULT: Ink = "blue";

function isInk(v: unknown): v is Ink {
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
export function inkParse(word: string): Ink | null {
  switch (asciiLower(rustTrim(word))) {
    case "pink":
    case "magenta":
    case "purple":
    case "violet":
      return "pink";
    case "yellow":
    case "orange":
    case "amber":
    case "gold":
      return "yellow";
    case "green":
    case "teal":
    case "emerald":
    case "lime":
      return "green";
    case "blue":
    case "cyan":
    case "navy":
    case "indigo":
      return "blue";
    case "red":
    case "crimson":
    case "scarlet":
    case "maroon":
      return "red";
    default:
      return null;
  }
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

function rectRight(r: Rect): number {
  return r.x + r.w;
}
function rectBottom(r: Rect): number {
  return r.y + r.h;
}
function rectCx(r: Rect): number {
  return r.x + r.w / 2;
}
function rectCy(r: Rect): number {
  return r.y + r.h / 2;
}
function rectOverlap(a: Rect, b: Rect): [number, number] | null {
  const ox = Math.min(rectRight(a), rectRight(b)) - Math.max(a.x, b.x);
  const oy = Math.min(rectBottom(a), rectBottom(b)) - Math.max(a.y, b.y);
  return ox > 0 && oy > 0 ? [ox, oy] : null;
}
function rectContains(r: Rect, px: number, py: number): boolean {
  return px >= r.x && px <= rectRight(r) && py >= r.y && py <= rectBottom(r);
}
function grow(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
}

function bboxOfPoints(points: readonly Point[]): Rect {
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
  switch (e.shape.type) {
    case "rect":
    case "ellipse":
      return { x: e.shape.x, y: e.shape.y, w: e.shape.w, h: e.shape.h };
    case "text": {
      const chars = Math.max([...e.shape.text].length, 1);
      return {
        x: e.shape.x,
        y: e.shape.y - e.shape.size,
        w: roundTiesAwayFromZero(chars * e.shape.size * 0.52),
        h: roundTiesAwayFromZero(e.shape.size * 1.25),
      };
    }
    case "arrow":
    case "line":
    case "pen":
      return bboxOfPoints(e.shape.points);
  }
}

/** What the element says, for the index and for a text-only reader. */
function elementWords(e: Element): string | null {
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

// ---------------------------------------------------------------------------
// JSON — hand-rolled to match serde's flatten/tag/skip_serializing_if
// ---------------------------------------------------------------------------

function parseFail(reason: string): never {
  throw new Error(`This sketch file could not be read (${reason}).`);
}

/** `Object.prototype.hasOwnProperty.call` — a `JSON.parse`d object may carry
 * a `"__proto__"` own key, and no read here may resolve through the
 * prototype chain. */
function has(o: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

function own(o: Record<string, unknown>, key: string): unknown {
  return has(o, key) ? o[key] : undefined;
}

function requireObject(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    parseFail(`${what} must be an object`);
  }
  return v as Record<string, unknown>;
}

function requireString(o: Record<string, unknown>, key: string): string {
  const v = own(o, key);
  if (typeof v !== "string") {
    parseFail(`missing or invalid "${key}"`);
  }
  return v;
}

/** An `i32` field. JSON cannot tell `250` from `250.0` in JavaScript, so a
 * whole-numbered float is indistinguishable and accepted; anything with a
 * real fraction is refused, as serde refuses it. */
function requireInt(o: Record<string, unknown>, key: string): number {
  const v = own(o, key);
  if (typeof v !== "number" || !Number.isInteger(v)) {
    parseFail(`missing or invalid "${key}"`);
  }
  return v;
}

/** A `u32` field — additionally refuses a negative, as unsigned
 * deserialisation does. */
function requireUint(o: Record<string, unknown>, key: string): number {
  const n = requireInt(o, key);
  if (n < 0) {
    parseFail(`"${key}" must not be negative`);
  }
  return n;
}

function optionalString(o: Record<string, unknown>, key: string): string | null {
  const v = own(o, key);
  if (v === undefined || v === null) {
    return null;
  }
  if (typeof v !== "string") {
    parseFail(`invalid "${key}"`);
  }
  return v;
}

function optionalBool(o: Record<string, unknown>, key: string): boolean {
  const v = own(o, key);
  if (v === undefined) {
    return false;
  }
  if (typeof v !== "boolean") {
    parseFail(`invalid "${key}"`);
  }
  return v;
}

function optionalInk(o: Record<string, unknown>): Ink {
  const v = own(o, "ink");
  if (v === undefined) {
    return INK_DEFAULT;
  }
  if (!isInk(v)) {
    parseFail('invalid "ink"');
  }
  return v;
}

function requirePoints(o: Record<string, unknown>): Point[] {
  const v = own(o, "points");
  if (!Array.isArray(v)) {
    parseFail('missing or invalid "points"');
  }
  return v.map((p): Point => {
    if (
      !Array.isArray(p) ||
      p.length !== 2 ||
      typeof p[0] !== "number" ||
      typeof p[1] !== "number" ||
      !Number.isInteger(p[0]) ||
      !Number.isInteger(p[1])
    ) {
      parseFail('invalid point in "points"');
    }
    return [p[0], p[1]];
  });
}

function shapeFromJsonValue(type: string, o: Record<string, unknown>): Shape {
  switch (type) {
    case "rect":
    case "ellipse":
      return {
        type,
        x: requireInt(o, "x"),
        y: requireInt(o, "y"),
        w: requireInt(o, "w"),
        h: requireInt(o, "h"),
      };
    case "text":
      return {
        type: "text",
        x: requireInt(o, "x"),
        y: requireInt(o, "y"),
        text: requireString(o, "text"),
        size: requireInt(o, "size"),
      };
    case "arrow":
    case "line":
    case "pen":
      return { type, points: requirePoints(o) };
    default:
      return parseFail(`unknown element type "${type}"`);
  }
}

function elementFromJsonValue(v: unknown): Element {
  const o = requireObject(v, "an element");
  return {
    id: requireString(o, "id"),
    shape: shapeFromJsonValue(requireString(o, "type"), o),
    ink: optionalInk(o),
    fill: optionalBool(o, "fill"),
    label: optionalString(o, "label"),
    from: optionalString(o, "from"),
    to: optionalString(o, "to"),
    locked: optionalBool(o, "locked"),
  };
}

/** `Element` → one FLAT JSON object: the shape's own fields sit beside
 * `id`/`ink`/… under a `type` tag, and every field at its default is
 * omitted (`skip_serializing_if`). Field ORDER matches the Rust struct's
 * declaration order, so the two builds write byte-identical files. */
function elementToJsonValue(e: Element): Record<string, unknown> {
  const out: Record<string, unknown> = { id: e.id, type: e.shape.type };
  switch (e.shape.type) {
    case "rect":
    case "ellipse":
      out.x = e.shape.x;
      out.y = e.shape.y;
      out.w = e.shape.w;
      out.h = e.shape.h;
      break;
    case "text":
      out.x = e.shape.x;
      out.y = e.shape.y;
      out.text = e.shape.text;
      out.size = e.shape.size;
      break;
    case "arrow":
    case "line":
    case "pen":
      out.points = e.shape.points.map(([x, y]) => [x, y]);
      break;
  }
  out.ink = e.ink;
  if (e.fill) {
    out.fill = true;
  }
  if (e.label !== null) {
    out.label = e.label;
  }
  if (e.from !== null) {
    out.from = e.from;
  }
  if (e.to !== null) {
    out.to = e.to;
  }
  if (e.locked) {
    out.locked = true;
  }
  return out;
}

/** `e123` → `123`, or `null` for anything else — the counter recovery's own
 * `strip_prefix('e')` + all-ASCII-digits test. */
function idNumber(id: string): number | null {
  if (!id.startsWith("e")) {
    return null;
  }
  const rest = id.slice(1);
  if (rest.length === 0 || !/^[0-9]+$/.test(rest)) {
    return null;
  }
  const n = Number(rest);
  // Rust parses the suffix as a `u32`; past that the parse FAILS and the id
  // recovers no counter at all, rather than pushing `seq` into the billions.
  return Number.isSafeInteger(n) && n <= 4294967295 ? n : null;
}

/**
 * Parse a sketch document. Empty/blank text is a fresh {@link defaultSketch}
 * (a brand-new room file has no bytes yet); anything else must parse as a
 * COMPLETE document or the whole read fails. Ported from `Sketch::from_json`,
 * including the ordering the Rust source calls out: one-point connectors are
 * dropped BEFORE the counter is recovered, so both sides recover the same
 * `seq` from the same surviving list.
 */
export function sketchFromJson(raw: string): Sketch {
  if (rustTrim(raw) === "") {
    return defaultSketch();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    parseFail(e instanceof Error ? e.message : String(e));
  }
  const o = requireObject(parsed, "the document");
  const version = requireUint(o, "version");
  let width = requireInt(o, "width");
  let height = requireInt(o, "height");
  let seq = requireUint(o, "seq");
  const rawElements = own(o, "elements");
  if (!Array.isArray(rawElements)) {
    parseFail('missing or invalid "elements"');
  }
  let elements = rawElements.map(elementFromJsonValue);

  if (width <= 0 || height <= 0) {
    width = CANVAS_W;
    height = CANVAS_H;
  }

  // A CONNECTOR NEEDS TWO ENDS. An arrow or line carrying one point (a
  // hand-edited file, an import, a half-written stroke) reads as an element
  // everywhere else in this module, and three readers — the SVG renderer,
  // `toScript` and the layout checker — index `points[1]` directly. Dropped
  // on the way in, the way the editor's own `isElement` refuses it. Pen rides
  // along because the editor drops it on the same rule: a file that opens as
  // two different drawings depending on which side read it is the one thing
  // this module exists to prevent.
  elements = elements.filter((e) => {
    if (e.shape.type === "arrow" || e.shape.type === "line" || e.shape.type === "pen") {
      return e.shape.points.length >= 2;
    }
    return true;
  });

  // A file hand-edited to reuse an id, or written by an older build that did
  // not persist `seq`, would otherwise mint a duplicate on the next add.
  let high = 0;
  for (const e of elements) {
    const n = idNumber(e.id);
    if (n !== null && n > high) {
      high = n;
    }
  }
  seq = Math.max(seq, high);

  return { version, width, height, seq, elements };
}

export function sketchToJson(doc: Sketch): string {
  const value = {
    version: doc.version,
    width: doc.width,
    height: doc.height,
    seq: doc.seq,
    elements: doc.elements.map(elementToJsonValue),
  };
  return JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------------------
// The script language
// ---------------------------------------------------------------------------

/**
 * One line's worth of tokens, sorted by what they LOOK like rather than by
 * where they sit — the forgiving half of the parser. `named` is a `Map`, so
 * a line like `rect __proto__=1 …` cannot touch `Object.prototype`.
 */
interface Tokens {
  nums: number[];
  named: Map<string, string>;
  words: string[];
  refs: string[];
  quoted: string[];
}

/** A named value if present, else the next positional number. */
function tokenNum(t: Tokens, keys: readonly string[], pos: number): number | null {
  for (const k of keys) {
    const v = t.named.get(k);
    if (v !== undefined) {
      const n = parseNum(v);
      if (n !== null) {
        return n;
      }
    }
  }
  return t.nums[pos] ?? null;
}

function tokenInk(t: Tokens): Ink | null {
  const named = t.named.get("ink") ?? t.named.get("color") ?? t.named.get("colour");
  if (named !== undefined) {
    const parsed = inkParse(named);
    if (parsed !== null) {
      return parsed;
    }
  }
  for (const w of t.words) {
    const parsed = inkParse(w);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function tokenHasFlag(t: Tokens, flag: string): boolean {
  if (t.words.some((w) => eqIgnoreAsciiCase(w, flag))) {
    return true;
  }
  const v = t.named.get(flag);
  if (v === undefined) {
    return false;
  }
  const lowered = asciiLower(v);
  return lowered === "true" || lowered === "yes" || lowered === "1";
}

function tokenLabel(t: Tokens): string | null {
  const raw = t.quoted[0] ?? t.named.get("label") ?? t.named.get("text");
  if (raw === undefined) {
    return null;
  }
  const clamped = clampLabel(raw);
  return clamped === "" ? null : clamped;
}

/** Words that were neither a colour nor a known flag. Reported rather than
 * ignored: a silently dropped token is how `rect 10 10 100 100 bleu` ends up
 * a different colour than the model believes it drew. */
function tokenStrays(t: Tokens, flags: readonly string[]): string[] {
  return t.words.filter((w) => inkParse(w) === null && !flags.some((f) => eqIgnoreAsciiCase(w, f)));
}

/** Rust's `s.parse::<i64>()`, then `s.parse::<f64>()` filtered to finite and
 * rounded. The float grammar deliberately admits the exponent form Rust's
 * `f64::from_str` admits (`1e5`) and nothing JS's `Number()` would otherwise
 * wave through (hex, `Infinity`, a bare sign, embedded whitespace). */
const FLOAT_LITERAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

function parseNum(s: string): number | null {
  const t = rustTrim(s);
  if (/^[+-]?\d+$/.test(t)) {
    const n = Number(t);
    if (Number.isSafeInteger(n)) {
      return n;
    }
  }
  // A model asked for integers still produces `320.0` often enough that
  // rejecting it would be pedantry rather than safety.
  if (FLOAT_LITERAL.test(t)) {
    const f = Number(t);
    return Number.isFinite(f) ? roundTiesAwayFromZero(f) : null;
  }
  return null;
}

function clampLabel(s: string): string {
  const t = rustTrim(s);
  const chars = [...t];
  if (chars.length <= MAX_LABEL_CHARS) {
    return t;
  }
  return rustTrimEnd(chars.slice(0, MAX_LABEL_CHARS).join(""));
}

function isRef(tok: string): boolean {
  if (tok.startsWith("#") || tok.startsWith("e")) {
    const rest = tok.slice(1);
    return rest.length > 0 && /^[0-9]+$/.test(rest);
  }
  return false;
}

/** A sentinel marking a token that came from inside quotes — Rust's
 * `'\u{0}'`, one character ordinary script text can never carry. */
const QUOTE_SENTINEL = "\u0000";

/**
 * Split one line into tokens, honouring quotes.
 *
 * `#` is both a comment marker and the prefix of a back-reference (`#2`), so
 * the digit test decides which. Getting this wrong in either direction is
 * silent: a comment parsed as a reference retargets an edit, and a reference
 * parsed as a comment drops the rest of the line.
 */
function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  const chars = [...line];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as string;
    if (quote !== null) {
      // A backslash escapes the next character inside quotes, so a label may
      // contain the quote mark that delimits it.
      if (c === "\\") {
        const next = chars[i + 1];
        if (next !== undefined) {
          cur += next;
          i += 1;
        }
      } else if (c === quote) {
        out.push(cur);
        cur = "";
        quote = null;
      } else {
        cur += c;
      }
    } else if (c === '"' || c === "'") {
      if (cur !== "") {
        out.push(cur);
        cur = "";
      }
      quote = c;
      cur += QUOTE_SENTINEL;
    } else if (c === "#") {
      // A comment unless the very next character is a digit.
      const next = chars[i + 1];
      if (next !== undefined && next >= "0" && next <= "9") {
        cur += c;
      } else {
        break;
      }
    } else if (IS_WHITESPACE.test(c) || c === ",") {
      if (cur !== "") {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += c;
    }
  }
  if (cur !== "") {
    out.push(cur);
  }
  return out;
}

function sortTokens(raw: readonly string[]): Tokens {
  const t: Tokens = { nums: [], named: new Map(), words: [], refs: [], quoted: [] };
  for (const tok of raw) {
    if (tok.startsWith(QUOTE_SENTINEL)) {
      t.quoted.push(tok.slice(1));
      continue;
    }
    const eq = tok.indexOf("=");
    if (eq > 0) {
      const k = asciiLower(rustTrim(tok.slice(0, eq)));
      const v = rustTrim(tok.slice(eq + 1));
      if (k !== "") {
        t.named.set(k, v);
        continue;
      }
    }
    if (isRef(tok)) {
      t.refs.push(tok);
      continue;
    }
    const n = parseNum(tok);
    if (n !== null) {
      t.nums.push(n);
      continue;
    }
    t.words.push(tok);
  }
  return t;
}

/** Canonical verb for a written one, or `""` for an unknown word (which the
 * caller reports with its ORIGINAL spelling). The synonyms are the words
 * models reach for unprompted; accepting them costs one match arm and saves
 * a round trip. */
function canonVerb(w: string): string {
  switch (asciiLower(w)) {
    case "rect":
    case "rectangle":
    case "box":
    case "square":
      return "rect";
    case "ellipse":
    case "circle":
    case "oval":
    case "round":
      return "ellipse";
    case "text":
    case "note":
    case "label_at":
    case "write":
      return "text";
    case "arrow":
      return "arrow";
    case "line":
      return "line";
    case "pen":
    case "stroke":
    case "draw":
    case "path":
      return "pen";
    case "link":
    case "connect":
    case "join":
      return "link";
    case "move":
    case "nudge":
    case "shift":
      return "move";
    case "label":
    case "rename":
    case "retitle":
      return "label";
    case "ink":
    case "color":
    case "colour":
    case "recolor":
    case "recolour":
      return "ink";
    case "delete":
    case "remove":
    case "erase":
    case "del":
      return "delete";
    case "clear":
    case "reset":
      return "clear";
    case "canvas":
    case "page":
    case "size":
      return "canvas";
    default:
      return "";
  }
}

/** What a script did, so the tool result can be specific about it. "Drew 6
 * things" is not a receipt; "added e12…e17, moved e3" is. */
export interface ScriptOutcome {
  added: string[];
  changed: string[];
  removed: string[];
  cleared: boolean;
  /** The page size this script set, when it set one. A `canvas` line changes
   * no element, so without it recorded here a script that ONLY resizes reads
   * as "nothing changed": the editor is handed the wider page and the file on
   * disk keeps the old one. */
  resized: [number, number] | null;
  /** One line per statement, in order. The step-by-step trace the editor
   * animates; emitted with `sketch-drawn`, never in the tool result. */
  steps: string[];
  /** Lines this deliberately did not carry out, in words the model can act
   * on. {@link scriptOutcomeSummary} is the WHOLE of what `draw` hands back,
   * so a refusal recorded only in `steps` is one the model never hears — and
   * it sends the same line again on the next turn. */
  refused: string[];
}

function newScriptOutcome(): ScriptOutcome {
  return { added: [], changed: [], removed: [], cleared: false, resized: null, steps: [], refused: [] };
}

export function scriptOutcomeIsEmpty(out: ScriptOutcome): boolean {
  return (
    out.added.length === 0 &&
    out.changed.length === 0 &&
    out.removed.length === 0 &&
    !out.cleared &&
    out.resized === null
  );
}

function idList(ids: readonly string[]): string {
  if (ids.length <= 4) {
    return ids.join(", ");
  }
  return `${ids[0]}, ${ids[1]} and ${ids.length - 2} more`;
}

/** A one-line receipt naming real ids. */
export function scriptOutcomeSummary(out: ScriptOutcome): string {
  const parts: string[] = [];
  if (out.cleared) {
    parts.push("cleared the page");
  }
  if (out.resized !== null) {
    parts.push(`set the page to ${out.resized[0]}×${out.resized[1]}`);
  }
  if (out.added.length > 0) {
    parts.push(`added ${idList(out.added)}`);
  }
  if (out.changed.length > 0) {
    parts.push(`changed ${idList(out.changed)}`);
  }
  if (out.removed.length > 0) {
    parts.push(`deleted ${idList(out.removed)}`);
  }
  // Last, and never suppressed by a change on another line: a script whose
  // fourth line was refused must not read as one that did everything asked.
  parts.push(...out.refused);
  return parts.length === 0 ? "nothing changed" : parts.join(", ");
}

/** A reference to an element: an existing id, or `#n` for the nth element
 * this script creates. */
type Ref = { kind: "id"; id: string } | { kind: "back"; index: number };

function refEquals(a: Ref, b: Ref): boolean {
  if (a.kind === "id" && b.kind === "id") {
    return a.id === b.id;
  }
  if (a.kind === "back" && b.kind === "back") {
    return a.index === b.index;
  }
  return false;
}

type Stmt =
  | { kind: "add"; shape: Shape; ink: Ink; fill: boolean; label: string | null }
  | { kind: "link"; from: Ref; to: Ref; ink: Ink; label: string | null }
  | { kind: "move"; target: string; dx: number; dy: number }
  | { kind: "label"; target: string; label: string }
  | { kind: "ink"; target: string; ink: Ink }
  | { kind: "delete"; target: string }
  | { kind: "clear" }
  | { kind: "canvas"; w: number; h: number };

function stmtCreates(s: Stmt): boolean {
  return s.kind === "add" || s.kind === "link";
}

const EXAMPLE_SCRIPT =
  'rect 250 400 320 130 blue "Login form"\n' +
  'rect 930 400 330 130 green "Auth service"\n' +
  'link #1 #2 blue "credentials"';

const SCRIPT_HELP =
  "Commands (one per line, whole numbers, colours are pink/yellow/green/blue/red):\n" +
  'rect X Y W H [colour] [fill] "label"\n' +
  'ellipse X Y W H [colour] [fill] "label"\n' +
  'text X Y [colour] [size] "words"\n' +
  'arrow X1 Y1 X2 Y2 [colour] "label"\n' +
  "line X1 Y1 X2 Y2 [colour]\n" +
  "pen [colour] X1 Y1 X2 Y2 …\n" +
  'link FROM TO [colour] "label"   — routes an arrow between two shapes\n' +
  'move ID DX DY · label ID "new" · ink ID colour · delete ID · clear\n' +
  "FROM/TO/ID is an existing id like e7, or #1 for the first shape THIS script creates.";

/** `n` is a `bigint` because Rust parses `#n` as a `usize`, which reaches
 * 2^64 - 1 — past what a `number` can spell exactly. */
function ordinal(n: bigint): string {
  if (n === 1n) {
    return "1st";
  }
  if (n === 2n) {
    return "2nd";
  }
  if (n === 3n) {
    return "3rd";
  }
  return `${n}th`;
}

function unknownWords(strays: readonly string[]): string {
  return (
    `did not understand ${strays.map((s) => `\`${s}\``).join(", ")} — colours are ` +
    'pink/yellow/green/blue/red, and any words to show must be in "quotes"'
  );
}

type Fallible<T> = { ok: true; value: T } | { ok: false; error: string };

function four(
  t: Tokens,
  keys: readonly [string, string, string, string],
  alt: readonly [string, string, string, string]
): Fallible<[number, number, number, number]> {
  const got: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const names = [keys[i] as string, alt[i] as string].filter((s) => s !== "");
    const n = tokenNum(t, names, i);
    if (n === null) {
      return { ok: false, error: `needs four numbers (${keys.join(" ")}); got ${t.nums.length}` };
    }
    // Rust's `(got[i] as i32)`: the caller's `w <= 0` test reads the CAST
    // value, so a width of 2^32 is zero and refuses the line.
    got[i] = asI32(n);
  }
  return { ok: true, value: got };
}

/**
 * Keep a shape on the page. Clamping rather than refusing: a model that put a
 * box at x=1700 meant it to be near the right edge, and moving it there is a
 * better answer than a syntax error — the layout report says what moved.
 *
 * `page` is the document's OWN size, which `canvas` may have just changed.
 */
function clampBox(
  x: number,
  y: number,
  w: number,
  h: number,
  page: readonly [number, number]
): [number, number, number, number] {
  const [pw, ph] = page;
  const cw = clamp(w, 1, pw);
  const ch = clamp(h, 1, ph);
  return [clamp(x, 0, pw - cw), clamp(y, 0, ph - ch), cw, ch];
}

/**
 * `page` is the document's size as of THIS line — see {@link applyScript}.
 * Every coordinate below is clamped against it rather than against the
 * default canvas, so a script that widens the page can then draw in the new
 * space.
 */
function parseStmt(
  line: string,
  live: readonly string[],
  created: readonly string[],
  page: readonly [number, number]
): Fallible<Stmt> {
  const raw = tokenize(line);
  if (raw.length === 0) {
    return { ok: false, error: "nothing on the line" };
  }
  // The verb is the first token that is not quoted; a leading quote means the
  // model wrote a bare label with no command.
  const head = raw[0] as string;
  if (head.startsWith(QUOTE_SENTINEL)) {
    return {
      ok: false,
      error:
        'this line starts with a label but no command — put the command first, e.g. `text 200 300 "…"`',
    };
  }
  const verb = canonVerb(head);
  if (verb === "") {
    return { ok: false, error: `\`${head}\` is not a command` };
  }
  const t = sortTokens(raw.slice(1));

  const resolve = (r: string): Fallible<Ref> => {
    if (r.startsWith("#")) {
      const digits = r.slice(1);
      // Rust parses the suffix as a `usize` and reports a PARSE failure — "is
      // not a reference" — separately from an in-range index that overshoots.
      // `isRef` already required an all-digit, non-empty suffix of anything
      // that reached `t.refs`; the overflow case is what a bare `Number`
      // silently turns into a shape count nobody wrote.
      if (!/^[0-9]+$/.test(digits) || BigInt(digits) > 18446744073709551615n) {
        return { ok: false, error: `\`${r}\` is not a reference` };
      }
      const n = BigInt(digits);
      if (n === 0n || n > BigInt(created.length)) {
        return {
          ok: false,
          error: `\`${r}\` points at the ${ordinal(n)} shape this script creates, but it only creates ${created.length}`,
        };
      }
      return { ok: true, value: { kind: "back", index: Number(n) - 1 } };
    }
    if (live.includes(r)) {
      return { ok: true, value: { kind: "id", id: r } };
    }
    return { ok: false, error: `there is no \`${r}\` on this page` };
  };

  // Mutating verbs need a target that already exists at this point in the
  // script; `#n` back-references resolve to a concrete id at apply time.
  const targetOf = (tok: Tokens): Fallible<string> => {
    const r = tok.refs[0];
    if (r === undefined) {
      return {
        ok: false,
        error:
          "this command needs the id of something on the page (like e3), or #1 for the first shape this script creates",
      };
    }
    const ref = resolve(r);
    if (!ref.ok) {
      return ref;
    }
    return { ok: true, value: ref.value.kind === "id" ? ref.value.id : (created[ref.value.index] as string) };
  };

  const ink = tokenInk(t) ?? INK_DEFAULT;

  switch (verb) {
    case "rect":
    case "ellipse": {
      const strays = tokenStrays(t, ["fill", "filled", "solid"]);
      if (strays.length > 0) {
        return { ok: false, error: unknownWords(strays) };
      }
      const nums = four(t, ["x", "y", "w", "h"], ["", "", "width", "height"]);
      if (!nums.ok) {
        return nums;
      }
      const [x, y, w, h] = nums.value;
      if (w <= 0 || h <= 0) {
        return {
          ok: false,
          error: `width and height must be positive (got ${w}×${h}); the numbers are X Y WIDTH HEIGHT, not two corners`,
        };
      }
      const [bx, by, bw, bh] = clampBox(x, y, w, h, page);
      return {
        ok: true,
        value: {
          kind: "add",
          shape: verb === "rect" ? { type: "rect", x: bx, y: by, w: bw, h: bh } : { type: "ellipse", x: bx, y: by, w: bw, h: bh },
          ink,
          fill: tokenHasFlag(t, "fill") || tokenHasFlag(t, "filled") || tokenHasFlag(t, "solid"),
          label: tokenLabel(t),
        },
      };
    }
    case "text": {
      const strays = tokenStrays(t, []);
      if (strays.length > 0) {
        return { ok: false, error: unknownWords(strays) };
      }
      const x = tokenNum(t, ["x"], 0);
      if (x === null) {
        return { ok: false, error: "needs an X position" };
      }
      const y = tokenNum(t, ["y"], 1);
      if (y === null) {
        return { ok: false, error: "needs a Y position" };
      }
      const text = tokenLabel(t);
      if (text === null) {
        return {
          ok: false,
          error: 'needs the words to write, in quotes — e.g. `text 200 300 "retry three times"`',
        };
      }
      const size = clamp(tokenNum(t, ["size"], 2) ?? 30, 10, 160);
      return {
        ok: true,
        value: {
          kind: "add",
          // `as i32` first, then the clamp — Rust's order for a text position.
          shape: { type: "text", x: clamp(asI32(x), 0, page[0]), y: clamp(asI32(y), 0, page[1]), text, size },
          ink,
          fill: false,
          label: null,
        },
      };
    }
    case "arrow":
    case "line": {
      const strays = tokenStrays(t, []);
      if (strays.length > 0) {
        return { ok: false, error: unknownWords(strays) };
      }
      const nums = four(t, ["x1", "y1", "x2", "y2"], ["from_x", "from_y", "to_x", "to_y"]);
      if (!nums.ok) {
        return nums;
      }
      const [x1, y1, x2, y2] = nums.value;
      const p0: Point = [clamp(x1, 0, page[0]), clamp(y1, 0, page[1])];
      const p1: Point = [clamp(x2, 0, page[0]), clamp(y2, 0, page[1])];
      if (p0[0] === p1[0] && p0[1] === p1[1]) {
        return { ok: false, error: "start and end are the same point" };
      }
      return {
        ok: true,
        value: {
          kind: "add",
          shape: verb === "arrow" ? { type: "arrow", points: [p0, p1] } : { type: "line", points: [p0, p1] },
          ink,
          fill: false,
          label: tokenLabel(t),
        },
      };
    }
    case "pen": {
      const strays = tokenStrays(t, []);
      if (strays.length > 0) {
        return { ok: false, error: unknownWords(strays) };
      }
      if (t.nums.length < 4 || t.nums.length % 2 !== 0) {
        return {
          ok: false,
          error: `needs an even list of at least two X Y pairs (got ${t.nums.length} number(s))`,
        };
      }
      const points: Point[] = [];
      for (let i = 0; i + 1 < t.nums.length && points.length < MAX_POINTS; i += 2) {
        points.push([clamp(asI32(t.nums[i] as number), 0, page[0]), clamp(asI32(t.nums[i + 1] as number), 0, page[1])]);
      }
      return { ok: true, value: { kind: "add", shape: { type: "pen", points }, ink, fill: false, label: tokenLabel(t) } };
    }
    case "link": {
      const strays = tokenStrays(t, []);
      if (strays.length > 0) {
        return { ok: false, error: unknownWords(strays) };
      }
      if (t.refs.length < 2) {
        return {
          ok: false,
          error:
            'needs two things to connect — e.g. `link e3 e5 "sends token"`, or `link #1 #2` for shapes this script just drew',
        };
      }
      const from = resolve(t.refs[0] as string);
      if (!from.ok) {
        return from;
      }
      const to = resolve(t.refs[1] as string);
      if (!to.ok) {
        return to;
      }
      if (refEquals(from.value, to.value)) {
        return { ok: false, error: "cannot connect something to itself" };
      }
      return { ok: true, value: { kind: "link", from: from.value, to: to.value, ink, label: tokenLabel(t) } };
    }
    case "move": {
      const target = targetOf(t);
      if (!target.ok) {
        return target;
      }
      const dx = tokenNum(t, ["dx"], 0);
      if (dx === null) {
        return { ok: false, error: "needs how far to move across (DX)" };
      }
      const dy = tokenNum(t, ["dy"], 1);
      if (dy === null) {
        return { ok: false, error: "needs how far to move down (DY)" };
      }
      return { ok: true, value: { kind: "move", target: target.value, dx: asI32(dx), dy: asI32(dy) } };
    }
    case "label": {
      const target = targetOf(t);
      if (!target.ok) {
        return target;
      }
      const label = tokenLabel(t);
      if (label === null) {
        return { ok: false, error: "needs the new label in quotes" };
      }
      return { ok: true, value: { kind: "label", target: target.value, label } };
    }
    case "ink": {
      const target = targetOf(t);
      if (!target.ok) {
        return target;
      }
      const chosen = tokenInk(t);
      if (chosen === null) {
        return { ok: false, error: "needs a colour: pink, yellow, green, blue or red" };
      }
      return { ok: true, value: { kind: "ink", target: target.value, ink: chosen } };
    }
    case "delete": {
      const target = targetOf(t);
      if (!target.ok) {
        return target;
      }
      return { ok: true, value: { kind: "delete", target: target.value } };
    }
    case "clear":
      return { ok: true, value: { kind: "clear" } };
    case "canvas": {
      const w = tokenNum(t, ["w", "width"], 0) ?? CANVAS_W;
      const h = tokenNum(t, ["h", "height"], 1) ?? CANVAS_H;
      // `as i32` first, then the clamp: `canvas 4294967296` is a page of
      // ZERO, which clamps UP to the 200 minimum rather than to the maximum.
      return { ok: true, value: { kind: "canvas", w: clamp(asI32(w), 200, 8000), h: clamp(asI32(h), 200, 8000) } };
    }
    default:
      return { ok: false, error: `\`${head}\` is not a command` };
  }
}

function resolveBack(r: Ref, back: readonly string[]): string {
  return r.kind === "id" ? r.id : back[r.index] ?? "";
}

/**
 * The two shapes a connector is attached to, when both are still on the page.
 *
 * Both, deliberately: {@link reflow} re-routes only a connector whose ends it
 * can BOTH find, and drops the attachment otherwise — so an arrow with one
 * end missing is an ordinary arrow again and moves like one.
 */
function attachedEnds(doc: Sketch, index: number): [string, string] | null {
  const e = doc.elements[index] as Element;
  if (e.shape.type !== "arrow" && e.shape.type !== "line") {
    return null;
  }
  if (e.from === null || e.to === null) {
    return null;
  }
  if (sketchIndexOf(doc, e.from) === -1 || sketchIndexOf(doc, e.to) === -1) {
    return null;
  }
  return [e.from, e.to];
}

function noteChanged(out: ScriptOutcome, id: string): void {
  if (!out.changed.includes(id)) {
    out.changed.push(id);
  }
}

function translate(shape: Shape, dx: number, dy: number, page: readonly [number, number]): Shape {
  const [pw, ph] = page;
  switch (shape.type) {
    case "rect":
    case "ellipse":
      // `Math.max(…, 0)`: a shape can be WIDER than the page it sits on — a
      // `canvas` line may shrink the page under it, and a hand-edited file
      // can hold anything — and an inverted clamp range panics in Rust.
      return {
        ...shape,
        x: clamp(shape.x + dx, 0, Math.max(pw - shape.w, 0)),
        y: clamp(shape.y + dy, 0, Math.max(ph - shape.h, 0)),
      };
    case "text":
      return { ...shape, x: clamp(shape.x + dx, 0, pw), y: clamp(shape.y + dy, 0, ph) };
    case "arrow":
    case "line":
    case "pen":
      return {
        ...shape,
        points: shape.points.map(([px, py]): Point => [clamp(px + dx, 0, pw), clamp(py + dy, 0, ph)]),
      };
  }
}

function applyStmt(doc: Sketch, stmt: Stmt, back: string[], out: ScriptOutcome): void {
  switch (stmt.kind) {
    case "add": {
      const id = sketchNextId(doc);
      const kind = stmt.shape.type;
      const what = stmt.label ?? (stmt.shape.type === "text" ? stmt.shape.text : "");
      doc.elements.push({ ...plainElement(), id, shape: stmt.shape, ink: stmt.ink, fill: stmt.fill, label: stmt.label });
      back.push(id);
      out.steps.push(what === "" ? `drew ${kind} ${id}` : `drew ${kind} ${id} "${what}"`);
      out.added.push(id);
      return;
    }
    case "link": {
      const a = resolveBack(stmt.from, back);
      const b = resolveBack(stmt.to, back);
      const ai = sketchIndexOf(doc, a);
      const bi = sketchIndexOf(doc, b);
      if (ai === -1 || bi === -1) {
        // Both ends were checked in pass 1; this branch is only reachable if
        // a later `delete` removed one, which pass 1 also tracks. Skip rather
        // than draw a nonsense arrow.
        out.steps.push("skipped a link whose ends went away");
        return;
      }
      const [start, end] = route(elementBbox(doc.elements[ai] as Element), elementBbox(doc.elements[bi] as Element));
      const id = sketchNextId(doc);
      doc.elements.push({
        ...plainElement(),
        id,
        shape: { type: "arrow", points: [start, end] },
        ink: stmt.ink,
        label: stmt.label,
        // What makes this a LINK and not an arrow that happens to be in the
        // right place. `reflow` reads these after every edit.
        from: a,
        to: b,
      });
      back.push(id);
      out.steps.push(stmt.label !== null ? `linked ${a} → ${b} as ${id} "${stmt.label}"` : `linked ${a} → ${b} as ${id}`);
      out.added.push(id);
      return;
    }
    case "move": {
      const i = sketchIndexOf(doc, stmt.target);
      if (i === -1) {
        return;
      }
      // A connector's points are `reflow`'s to write: it re-routes both ends
      // against its shapes at the end of every script, so moving one here
      // would be reported as done and then discarded in the same call — and
      // the model, reading the drawing back unchanged, moves it again.
      const attached = attachedEnds(doc, i);
      if (attached !== null) {
        const [from, to] = attached;
        // One sentence, both carriers: the editor's trace and the tool result
        // have to say the same thing, and writing it twice is how they stop
        // agreeing.
        const why = `left ${stmt.target} where it is (a connector between ${from} and ${to} — move ${from} or ${to} instead)`;
        out.steps.push(why);
        out.refused.push(why);
        return;
      }
      const el = doc.elements[i] as Element;
      el.shape = translate(el.shape, stmt.dx, stmt.dy, [doc.width, doc.height]);
      out.steps.push(`moved ${stmt.target} by ${stmt.dx},${stmt.dy}`);
      noteChanged(out, stmt.target);
      return;
    }
    case "label": {
      const i = sketchIndexOf(doc, stmt.target);
      if (i === -1) {
        return;
      }
      const e = doc.elements[i] as Element;
      if (e.shape.type === "text") {
        e.shape = { ...e.shape, text: stmt.label };
      } else {
        e.label = stmt.label;
      }
      out.steps.push(`relabelled ${stmt.target} to "${stmt.label}"`);
      noteChanged(out, stmt.target);
      return;
    }
    case "ink": {
      const i = sketchIndexOf(doc, stmt.target);
      if (i === -1) {
        return;
      }
      (doc.elements[i] as Element).ink = stmt.ink;
      out.steps.push(`recoloured ${stmt.target} ${stmt.ink}`);
      noteChanged(out, stmt.target);
      return;
    }
    case "delete": {
      const i = sketchIndexOf(doc, stmt.target);
      if (i === -1) {
        return;
      }
      doc.elements.splice(i, 1);
      out.steps.push(`deleted ${stmt.target}`);
      out.removed.push(stmt.target);
      return;
    }
    case "clear": {
      const n = doc.elements.length;
      doc.elements.length = 0;
      back.length = 0;
      out.cleared = true;
      out.steps.push(`cleared the page (${n} removed)`);
      return;
    }
    case "canvas": {
      // Only a real change counts. `toScript` opens every reading with the
      // drawing's own `canvas` line, so a script the agent edited and sent
      // back would otherwise re-save the file on every round trip and claim a
      // change nobody made.
      if (doc.width !== stmt.w || doc.height !== stmt.h) {
        out.resized = [stmt.w, stmt.h];
      }
      doc.width = stmt.w;
      doc.height = stmt.h;
      out.steps.push(`set the page to ${stmt.w}×${stmt.h}`);
      return;
    }
  }
}

/**
 * Apply a script to a drawing.
 *
 * Two-pass by design: every statement is parsed and checked BEFORE any of
 * them is applied. A half-applied script leaves the model reasoning about a
 * drawing that does not exist — it believes 9 of its 10 boxes landed and has
 * no way to tell which — so a script with any bad line changes nothing and
 * reports every problem it found.
 */
export function applyScript(doc: Sketch, script: string): Fallible<ScriptOutcome> {
  const lines: Array<[number, string]> = [];
  const rawLines = script.split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    const l = rustTrim(rawLines[i] as string);
    if (l !== "" && !l.startsWith("#") && !l.startsWith("//")) {
      lines.push([i + 1, l]);
    }
  }

  if (lines.length === 0) {
    return {
      ok: false,
      error: `That script had no drawing commands in it. One command per line, for example:\n${EXAMPLE_SCRIPT}`,
    };
  }
  if (lines.length > MAX_SCRIPT_LINES) {
    return {
      ok: false,
      error: `That script has ${lines.length} lines; ${MAX_SCRIPT_LINES} is the most a single call may carry. Split it across calls.`,
    };
  }

  // Pass 1: parse every line into a statement, collecting errors.
  const stmts: Stmt[] = [];
  const errors: string[] = [];
  // Ids that WILL exist once this script applies, so a later line may refer
  // to something an earlier line created.
  const created: string[] = [];
  const live: string[] = doc.elements.map((e) => e.id);
  let projectedSeq = doc.seq;
  // The page each line is placed on. A `canvas` line takes effect for the
  // lines BELOW it — the same order pass 2 applies them in — because every
  // coordinate is clamped at parse time.
  let page: [number, number] = [doc.width, doc.height];

  for (const [lineno, line] of lines) {
    const parsed = parseStmt(line, live, created, page);
    if (!parsed.ok) {
      if (errors.length < MAX_REPORTED_ERRORS) {
        errors.push(`line ${lineno} (\`${line}\`): ${parsed.error}`);
      }
      continue;
    }
    const stmt = parsed.value;
    if (stmt.kind === "canvas") {
      page = [stmt.w, stmt.h];
    }
    if (stmtCreates(stmt)) {
      projectedSeq += 1;
      const id = `e${projectedSeq}`;
      created.push(id);
      live.push(id);
    }
    if (stmt.kind === "delete") {
      // Rust's `live.retain(|id| id != target)` drops EVERY copy. A
      // hand-edited file can repeat an id, and leaving one behind lets a
      // later line resolve against a shape the projected page no longer has.
      for (let at = live.length - 1; at >= 0; at--) {
        if (live[at] === stmt.target) {
          live.splice(at, 1);
        }
      }
    }
    if (stmt.kind === "clear") {
      live.length = 0;
      created.length = 0;
    }
    stmts.push(stmt);
  }

  if (errors.length > 0) {
    const more = Math.max(lines.length - MAX_REPORTED_ERRORS, 0);
    const tail =
      errors.length >= MAX_REPORTED_ERRORS && more > 0
        ? "\n(more lines may also be wrong — these are the first few.)"
        : "";
    return {
      ok: false,
      error:
        `Nothing was drawn — ${errors.length} line(s) could not be read, so the whole script was refused:\n` +
        `${errors.join("\n")}${tail}\n\n${SCRIPT_HELP}`,
    };
  }

  // What the page will actually hold: `live` is the projected id list pass 1
  // has been keeping all along, so it already counts this script's deletions
  // and its `clear`. Summing only the creations refused `clear` + a full
  // redraw with a number the script would never reach.
  const projected = live.length;
  if (projected > MAX_ELEMENTS) {
    return {
      ok: false,
      error: `That would put ${projected} things on the page; ${MAX_ELEMENTS} is the limit. Draw fewer, or start a new sketch.`,
    };
  }

  // Pass 2: apply. Every statement here has already been validated against
  // the drawing's projected state, so this pass cannot fail.
  const out = newScriptOutcome();
  const back: string[] = [];
  for (const stmt of stmts) {
    applyStmt(doc, stmt, back, out);
  }
  // Once, at the end, rather than after each statement: a script that moves
  // three boxes and then deletes a fourth should route its arrows against
  // where everything finally landed. It is also idempotent.
  reflow(doc);
  return { ok: true, value: out };
}

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
function edgePoint(r: Rect, ux: number, uy: number, gap: number): Point {
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
  const boxes = new Map<string, Rect>();
  for (const e of doc.elements) {
    boxes.set(e.id, elementBbox(e));
  }
  for (const e of doc.elements) {
    if (e.from === null && e.to === null) {
      continue;
    }
    if (e.shape.type !== "arrow" && e.shape.type !== "line") {
      continue;
    }
    const a = e.from !== null ? boxes.get(e.from) : undefined;
    const b = e.to !== null ? boxes.get(e.to) : undefined;
    if (a !== undefined && b !== undefined) {
      const [start, end] = route(a, b);
      e.shape = { ...e.shape, points: [start, end] };
    } else {
      e.from = null;
      e.to = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Reading a drawing back out as script
// ---------------------------------------------------------------------------

function quote(s: string): string {
  return `"${s.replaceAll('"', "'")}"`;
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
  for (const e of doc.elements) {
    const ink = e.ink;
    const label = e.label !== null && e.label !== "" ? ` ${quote(e.label)}` : "";
    let line: string | null;
    switch (e.shape.type) {
      case "rect":
        line = `${e.id} rect ${e.shape.x} ${e.shape.y} ${e.shape.w} ${e.shape.h} ${ink}${e.fill ? " fill" : ""}${label}`;
        break;
      case "ellipse":
        line = `${e.id} ellipse ${e.shape.x} ${e.shape.y} ${e.shape.w} ${e.shape.h} ${ink}${e.fill ? " fill" : ""}${label}`;
        break;
      case "text":
        line = `${e.id} text ${e.shape.x} ${e.shape.y} ${ink} ${e.shape.size} ${quote(e.shape.text)}`;
        break;
      // Both ends or nothing: an arrow with one point has no line to
      // describe, and reading it back as script is what an agent does with a
      // file it did not write.
      case "arrow": {
        const [p0, p1] = e.shape.points;
        line = p0 === undefined || p1 === undefined ? null : `${e.id} arrow ${p0[0]} ${p0[1]} ${p1[0]} ${p1[1]} ${ink}${label}`;
        break;
      }
      case "line": {
        const [p0, p1] = e.shape.points;
        line = p0 === undefined || p1 === undefined ? null : `${e.id} line ${p0[0]} ${p0[1]} ${p1[0]} ${p1[1]} ${ink}`;
        break;
      }
      // A freehand stroke's point list is neither useful nor editable to a
      // model — it is a hundred numbers describing a squiggle. Show where it
      // is and how big, and nothing else.
      case "pen": {
        const b = bboxOfPoints(e.shape.points);
        line = `${e.id} pen ${ink} — freehand, ${e.shape.points.length} points around ${b.x} ${b.y} (${b.w}×${b.h})${label}`;
        break;
      }
    }
    if (line !== null) {
      out += `${line}\n`;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The layout checker
// ---------------------------------------------------------------------------

/**
 * Problems a drawing can have that are visible at a glance but invisible in
 * text.
 *
 * This is the other half of "let the agent see its work". A rendered picture
 * only helps a model that can read pictures well, and the small local models
 * this app is built around cannot. Every check here is geometric, exact, and
 * phrased as an instruction the model can act on directly.
 */
export function layoutReport(doc: Sketch): string[] {
  const notes: string[] = [];

  // Overlapping shapes: the single most common way a generated diagram comes
  // out unreadable, because the model places boxes on a grid it is imagining
  // and never checks the arithmetic.
  const solids = doc.elements.filter(elementIsSolid);
  for (let i = 0; i < solids.length; i++) {
    for (let j = i + 1; j < solids.length; j++) {
      const a = solids[i] as Element;
      const b = solids[j] as Element;
      const overlap = rectOverlap(elementBbox(a), elementBbox(b));
      if (overlap !== null) {
        notes.push(`${a.id} and ${b.id} overlap by ${overlap[0]}×${overlap[1]} — move one of them apart.`);
      }
    }
  }

  // Off the page.
  for (const e of doc.elements) {
    const b = elementBbox(e);
    if (
      b.x < -OFF_PAGE_SLACK ||
      b.y < -OFF_PAGE_SLACK ||
      rectRight(b) > doc.width + OFF_PAGE_SLACK ||
      rectBottom(b) > doc.height + OFF_PAGE_SLACK
    ) {
      notes.push(
        `${e.id} sits outside the ${doc.width}×${doc.height} page (at ${b.x} ${b.y}, ${b.w}×${b.h}) — move it back on.`
      );
    }
  }

  // Unlabelled shapes: a box with no word in it is invisible to every
  // text-only reader of this drawing, including the agent's own next turn.
  for (const e of doc.elements) {
    if (elementIsSolid(e) && rustTrim(e.label ?? "") === "") {
      notes.push(`${e.id} has no label — give it one so it can be read.`);
    }
  }

  // Arrows that point at nothing. Checked against solid shapes only: a
  // free-floating arrow is legitimate, but one whose ends MISS boxes that sit
  // nearby is almost always intended to connect them.
  const touches = (p: Point): boolean => solids.some((o) => rectContains(grow(elementBbox(o), 14), p[0], p[1]));
  const near = (p: Point): boolean => solids.some((o) => rectContains(grow(elementBbox(o), 90), p[0], p[1]));
  for (const e of doc.elements) {
    if (e.shape.type !== "arrow") {
      continue;
    }
    // `sketchFromJson` drops a one-point arrow, but a document built in
    // memory does not pass through it, and this loop reads both ends.
    const s = e.shape.points[0];
    const t = e.shape.points[1];
    if (s === undefined || t === undefined) {
      continue;
    }
    if ((!touches(s) && near(s)) || (!touches(t) && near(t))) {
      notes.push(
        `${e.id} nearly touches a shape but stops short — use \`link\` to connect two shapes instead of placing arrow ends by hand.`
      );
    }
  }

  // Text sitting on top of a shape it does not belong to. A label belongs
  // INSIDE its own box; a separate note landing there reads as that box's
  // caption and says the wrong thing.
  for (const e of doc.elements) {
    if (e.shape.type !== "text") {
      continue;
    }
    for (const s of solids) {
      const overlap = rectOverlap(elementBbox(e), elementBbox(s));
      if (overlap !== null && overlap[0] > 8 && overlap[1] > 8) {
        notes.push(`the note ${e.id} lies on top of ${s.id} — move it clear, or make it ${s.id}'s label.`);
      }
    }
  }

  // Duplicate labels: two boxes saying the same thing is usually a repeated
  // add, not a deliberate choice. Boxes and notes only — arrows repeat their
  // labels legitimately and constantly ("then", "yes", "no"), and reporting
  // those sent the agent off deleting the connections that made the diagram
  // readable.
  const seen = new Map<string, string>();
  for (const e of doc.elements) {
    if (!elementIsSolid(e) && e.shape.type !== "text") {
      continue;
    }
    const w = elementWords(e);
    if (w === null) {
      continue;
    }
    const key = asciiLower(rustTrim(w));
    if (key === "") {
      continue;
    }
    const prev = seen.get(key);
    seen.set(key, e.id);
    if (prev !== undefined) {
      notes.push(`${prev} and ${e.id} both say "${rustTrim(w)}" — delete one if it is a duplicate.`);
    }
  }

  // `sort` then `dedup`: Rust's `dedup` drops only CONSECUTIVE duplicates,
  // which after a sort is all of them — and the sort is by UTF-8 bytes.
  notes.sort(compareUtf8);
  return notes.filter((n, i) => i === 0 || n !== notes[i - 1]);
}

// ---------------------------------------------------------------------------
// Rendering (SVG; the PNG rasteriser is `sketchRaster.ts`)
// ---------------------------------------------------------------------------

/** Paper. An explicit background means an exported file and a rasterised
 * screenshot are both legible wherever they are opened, rather than
 * depending on the viewer's own backdrop. */
export const PAPER = "#f4f1e8";

/** Fallbacks only — a rasteriser loads whatever the system has, and an
 * exported file opens on machines that have none of these. Ending the stack
 * with a generic family is what keeps text visible rather than absent. */
export const FONT = "Bradley Hand, Noteworthy, Chalkboard SE, Segoe Print, Comic Sans MS, cursive, sans-serif";

/**
 * A tiny deterministic PRNG, seeded from the element id: FNV-1a, then
 * xorshift32.
 *
 * The wobble that makes these drawings look hand-drawn MUST be a function of
 * the id and nothing else. Randomising per render would make a sketch redraw
 * differently every time it is opened, and would break the one property the
 * tests lean on hardest: the same document always produces the same bytes.
 *
 * `u32` wrapping arithmetic is explicit (`Math.imul`, `>>> 0`); the hash
 * consumes UTF-8 BYTES (`id.as_bytes()`), not UTF-16 code units.
 */
function seeded(id: string): () => number {
  let h = 2166136261 >>> 0;
  for (const b of Buffer.from(id, "utf8")) {
    h = (h ^ b) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return () => {
    h = (h ^ (h << 13)) >>> 0;
    h = (h ^ (h >>> 17)) >>> 0;
    h = (h ^ (h << 5)) >>> 0;
    return (h % 100_000) / 100_000;
  };
}

/**
 * One wobbly quadratic segment.
 *
 * The ORDER of the six `r()` draws matters and is Rust's: the mid-point
 * jitters first (they are computed before the `format!`), then the four
 * endpoint jitters in the left-to-right order `format!` evaluates its
 * arguments. Reproducing them out of order desyncs every later element's
 * wobble.
 */
function wobblySegment(r: () => number, x1: number, y1: number, x2: number, y2: number, a: number): string {
  const j = (amp: number): number => (r() * 2 - 1) * amp;
  const mx = (x1 + x2) / 2 + j(a * 1.8);
  const my = (y1 + y2) / 2 + j(a * 1.8);
  const sx = x1 + j(a);
  const sy = y1 + j(a);
  const ex = x2 + j(a);
  const ey = y2 + j(a);
  return `M${fixed(sx, 1)} ${fixed(sy, 1)}Q${fixed(mx, 1)} ${fixed(my, 1)} ${fixed(ex, 1)} ${fixed(ey, 1)}`;
}

export function xmlEscape(s: string): string {
  // `&` first, or the ampersands the later replacements introduce would be
  // escaped twice.
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function writeLabel(e: Element, cx: number, cy: number, ink: string): string {
  if (e.label === null || rustTrim(e.label) === "") {
    return "";
  }
  return (
    `<text x="${fixed(cx, 0)}" y="${fixed(cy, 0)}" font-family="${FONT}" font-size="26" ` +
    `fill="${ink}" text-anchor="middle">${xmlEscape(e.label)}</text>`
  );
}

/**
 * The drawing as a standalone SVG document.
 *
 * One renderer serves both the exported `.svg` room file and the raster the
 * agent looks at, so what the agent inspects is what the user has.
 */
export function toSvg(doc: Sketch): string {
  const w = doc.width;
  const h = doc.height;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
  s += `<rect width="${w}" height="${h}" fill="${PAPER}"/>`;
  for (const e of doc.elements) {
    const r = seeded(e.id);
    const ink = inkHex(e.ink);
    switch (e.shape.type) {
      case "rect": {
        const { x, y, w: bw, h: bh } = e.shape;
        if (e.fill) {
          s += `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="8" fill="${inkFillHex(e.ink)}"/>`;
        }
        let d = "";
        for (let pass = 0; pass < 2; pass++) {
          d += wobblySegment(r, x, y, x + bw, y, 2.2);
          d += wobblySegment(r, x + bw, y, x + bw, y + bh, 2.2);
          d += wobblySegment(r, x + bw, y + bh, x, y + bh, 2.2);
          d += wobblySegment(r, x, y + bh, x, y, 2.2);
        }
        s += `<path d="${d}" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>`;
        s += writeLabel(e, x + bw / 2, y + bh / 2 + 9, ink);
        break;
      }
      case "ellipse": {
        const { x, y, w: bw, h: bh } = e.shape;
        const cx = x + bw / 2;
        const cy = y + bh / 2;
        const rx = bw / 2;
        const ry = bh / 2;
        if (e.fill) {
          s += `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${inkFillHex(e.ink)}"/>`;
        }
        let d = "";
        for (let pass = 0; pass < 2; pass++) {
          const n = 16;
          const wob = Math.min(Math.min(rx, ry) * 0.04 + 1.5, 4.0);
          const pts: Point[] = [];
          for (let i = 0; i < n; i++) {
            const t = (i / n) * Math.PI * 2;
            const jr = (r() * 2 - 1) * wob;
            pts.push([cx + Math.cos(t) * (rx + jr), cy + Math.sin(t) * (ry + jr)]);
          }
          const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          const start = mid(pts[0] as Point, pts[1 % n] as Point);
          d += `M${fixed(start[0], 1)} ${fixed(start[1], 1)}`;
          for (let k = 1; k <= n; k++) {
            const a = pts[k % n] as Point;
            const b = pts[(k + 1) % n] as Point;
            const m = mid(a, b);
            d += `Q${fixed(a[0], 1)} ${fixed(a[1], 1)} ${fixed(m[0], 1)} ${fixed(m[1], 1)}`;
          }
          d += "Z";
        }
        s += `<path d="${d}" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>`;
        s += writeLabel(e, cx, cy + 9, ink);
        break;
      }
      case "text": {
        const { x, y, text, size } = e.shape;
        s += `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" fill="${ink}">${xmlEscape(text)}</text>`;
        break;
      }
      // One point is not a line, so there is nothing to stroke. Drawn as
      // nothing rather than indexed into: this renderer serves the exported
      // file and the raster the agent inspects, and neither may fail on a
      // document somebody else wrote.
      case "line": {
        const [p0, p1] = e.shape.points;
        if (p0 === undefined || p1 === undefined) {
          break;
        }
        const d = wobblySegment(r, p0[0], p0[1], p1[0], p1[1], 2.5);
        s += `<path d="${d}" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>`;
        break;
      }
      case "arrow": {
        const [p0, p1] = e.shape.points;
        if (p0 === undefined || p1 === undefined) {
          break;
        }
        const [x1, y1] = p0;
        const [x2, y2] = p1;
        const d = wobblySegment(r, x1, y1, x2, y2, 2.5);
        s += `<path d="${d}" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>`;
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const hl = 20.0;
        for (const a of [ang + 2.6, ang - 2.6]) {
          s +=
            `<path d="M${fixed(x2, 1)} ${fixed(y2, 1)}L${fixed(x2 + Math.cos(a) * hl, 1)} ` +
            `${fixed(y2 + Math.sin(a) * hl, 1)}" stroke="${ink}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
        }
        if (e.label !== null && e.label !== "") {
          s +=
            `<text x="${fixed((x1 + x2) / 2, 0)}" y="${fixed((y1 + y2) / 2 - 12, 0)}" font-family="${FONT}" ` +
            `font-size="24" fill="${ink}" text-anchor="middle">${xmlEscape(e.label)}</text>`;
        }
        break;
      }
      case "pen": {
        let d = "";
        const points = e.shape.points;
        const first = points[0];
        if (first !== undefined) {
          d += `M${first[0]} ${first[1]}`;
          for (let i = 0; i + 1 < points.length; i++) {
            const a = points[i] as Point;
            const b = points[i + 1] as Point;
            // Rust's `/` on `i32` truncates towards zero.
            d += `Q${a[0]} ${a[1]} ${Math.trunc((a[0] + b[0]) / 2)} ${Math.trunc((a[1] + b[1]) / 2)}`;
          }
          const last = points[points.length - 1] as Point;
          d += `L${last[0]} ${last[1]}`;
        }
        s += `<path d="${d}" fill="none" stroke="${ink}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
        break;
      }
    }
  }
  s += "</svg>";
  return s;
}

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
function clampWords(s: string, max: number): string {
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
function layerNodes(n: number, edges: ReadonlyArray<readonly [number, number, string | null]>): number[] {
  const layer = new Array<number>(n).fill(0);
  // Anything nothing points at starts the diagram. A graph where everything
  // has an incoming edge (a pure cycle) leaves them all at zero, which lays
  // out as one column — honest for a diagram with no beginning.
  const hasIncoming = new Array<boolean>(n).fill(false);
  for (const [, b] of edges) {
    hasIncoming[b] = true;
  }
  for (let iter = 0; iter < Math.min(n, 64); iter++) {
    let moved = false;
    for (const [a, b] of edges) {
      if (hasIncoming[b] && (layer[b] as number) < (layer[a] as number) + 1) {
        layer[b] = (layer[a] as number) + 1;
        moved = true;
      }
    }
    if (!moved) {
      break;
    }
  }
  // A runaway from a cycle would otherwise put one node 60 columns out.
  const cap = Math.min(n, 8);
  return layer.map((l) => Math.min(l, cap));
}

/** Ink by column, so the eye can follow the stages of a flow. The five pens
 * cycle; a diagram deeper than five layers repeats, which reads as a rhythm
 * rather than as five arbitrary colours. */
const WHEEL: readonly Ink[] = ["blue", "green", "yellow", "pink", "red"];

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
  if (nodes.length === 0) {
    return doc;
  }
  const capped = nodes.slice(0, Math.floor(MAX_ELEMENTS / 4));
  // A `Map`, never a plain object: these ids come from the model.
  const index = new Map<string, number>();
  capped.forEach((n, i) => index.set(n.id, i));
  // Only edges whose ends both exist. A model that invents an endpoint would
  // otherwise produce an arrow from nowhere.
  const live: Array<[number, number, string | null]> = [];
  for (const e of edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a !== undefined && b !== undefined && a !== b) {
      live.push([a, b, e.label ?? null]);
    }
  }

  const layer = layerNodes(capped.length, live);
  const layers = Math.max(...layer) + 1;

  // Columns across, rows down. The canvas grows taller when a layer is
  // crowded rather than squeezing boxes until their labels stop fitting.
  const perLayer: number[][] = Array.from({ length: layers }, () => []);
  layer.forEach((l, i) => (perLayer[l] as number[]).push(i));
  const tallest = Math.max(...perLayer.map((c) => c.length), 1);

  const BOX_W = 300;
  const BOX_H = 130;
  const GAP_X = 130;
  const GAP_Y = 90;
  const MARGIN = 80;

  doc.width = Math.max(MARGIN * 2 + layers * BOX_W + Math.max(layers - 1, 0) * GAP_X, CANVAS_W);
  doc.height = Math.max(MARGIN * 2 + tallest * BOX_H + Math.max(tallest - 1, 0) * GAP_Y, CANVAS_H);

  const ids = new Array<string>(capped.length).fill("");
  perLayer.forEach((column, l) => {
    const x = MARGIN + l * (BOX_W + GAP_X);
    const block = column.length * BOX_H + Math.max(column.length - 1, 0) * GAP_Y;
    // Rust's `/` on `i32` truncates towards zero.
    const top = Math.max(Math.trunc((doc.height - block) / 2), MARGIN);
    column.forEach((n, row) => {
      const y = top + row * (BOX_H + GAP_Y);
      const node = capped[n] as GraphNode;
      const kind = asciiLower(node.kind ?? "");
      const terminal = kind === "start" || kind === "end" || kind === "terminal";
      const ink = WHEEL[l % WHEEL.length] as Ink;
      const id = sketchNextId(doc);
      doc.elements.push({
        ...plainElement(),
        id,
        shape: terminal ? { type: "ellipse", x, y, w: BOX_W, h: BOX_H } : { type: "rect", x, y, w: BOX_W, h: BOX_H },
        ink,
        fill: terminal,
        label: clampLabel(node.label),
      });
      ids[n] = id;
      // The explanation, under its box. Short by construction: a paragraph
      // here would collide with the next row, and the reply text is where the
      // long version belongs.
      const note = rustTrim(node.note ?? "");
      if (note !== "") {
        doc.elements.push({
          ...plainElement(),
          id: sketchNextId(doc),
          shape: { type: "text", x, y: y + BOX_H + 34, text: clampWords(note, 60), size: 22 },
          ink,
        });
      }
    });
  });

  for (const [a, b, label] of live) {
    const ra = elementBbox(doc.elements[sketchIndexOf(doc, ids[a] as string)] as Element);
    const rb = elementBbox(doc.elements[sketchIndexOf(doc, ids[b] as string)] as Element);
    const [start, end] = route(ra, rb);
    const clamped = label === null ? null : clampLabel(label);
    doc.elements.push({
      ...plainElement(),
      id: sketchNextId(doc),
      shape: { type: "arrow", points: [start, end] },
      ink: "blue",
      label: clamped === null || clamped === "" ? null : clamped,
      // A generated graph is a diagram, so its arrows are links: moving a box
      // later must not leave the picture lying about what joins what.
      from: ids[a] as string,
      to: ids[b] as string,
    });
  }
  return doc;
}
