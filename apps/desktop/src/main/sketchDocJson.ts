/** Cohesive extraction from sketchDoc.ts; its public API remains on that module. */
import { CANVAS_H, CANVAS_W, Element, INK_DEFAULT, Ink, Point, Shape, Sketch, defaultSketch, isInk, rustTrim } from "./sketchDocModel.js";
// ---------------------------------------------------------------------------
// JSON — hand-rolled to match serde's flatten/tag/skip_serializing_if
// ---------------------------------------------------------------------------

export function parseFail(reason: string): never {
  throw new Error(`This sketch file could not be read (${reason}).`);
}

/** `Object.prototype.hasOwnProperty.call` — a `JSON.parse`d object may carry
 * a `"__proto__"` own key, and no read here may resolve through the
 * prototype chain. */
export function has(o: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

export function own(o: Record<string, unknown>, key: string): unknown {
  return has(o, key) ? o[key] : undefined;
}

export function requireObject(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    parseFail(`${what} must be an object`);
  }
  return v as Record<string, unknown>;
}

export function requireString(o: Record<string, unknown>, key: string): string {
  const v = own(o, key);
  if (typeof v !== "string") {
    parseFail(`missing or invalid "${key}"`);
  }
  return v;
}

/** An `i32` field. JSON cannot tell `250` from `250.0` in JavaScript, so a
 * whole-numbered float is indistinguishable and accepted; anything with a
 * real fraction is refused, as serde refuses it. */
export function requireInt(o: Record<string, unknown>, key: string): number {
  const v = own(o, key);
  if (typeof v !== "number" || !Number.isInteger(v)) {
    parseFail(`missing or invalid "${key}"`);
  }
  return v;
}

/** A `u32` field — additionally refuses a negative, as unsigned
 * deserialisation does. */
export function requireUint(o: Record<string, unknown>, key: string): number {
  const n = requireInt(o, key);
  if (n < 0) {
    parseFail(`"${key}" must not be negative`);
  }
  return n;
}

export function optionalString(o: Record<string, unknown>, key: string): string | null {
  const v = own(o, key);
  if (v === undefined || v === null) {
    return null;
  }
  if (typeof v !== "string") {
    parseFail(`invalid "${key}"`);
  }
  return v;
}

export function optionalBool(o: Record<string, unknown>, key: string): boolean {
  const v = own(o, key);
  if (v === undefined) {
    return false;
  }
  if (typeof v !== "boolean") {
    parseFail(`invalid "${key}"`);
  }
  return v;
}

export function optionalInk(o: Record<string, unknown>): Ink {
  const v = own(o, "ink");
  if (v === undefined) {
    return INK_DEFAULT;
  }
  if (!isInk(v)) {
    parseFail('invalid "ink"');
  }
  return v;
}

export function requirePoints(o: Record<string, unknown>): Point[] {
  const v = own(o, "points");
  if (!Array.isArray(v)) {
    parseFail('missing or invalid "points"');
  }
  return v.map(pointFromJsonValue);
}

export function pointFromJsonValue(value: unknown): Point {
  if (!isPointTuple(value)) parseFail('invalid point in "points"');
  return [pointCoordinate(value[0]), pointCoordinate(value[1])];
}

export function isPointTuple(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length === 2;
}

export function pointCoordinate(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    parseFail('invalid point in "points"');
  }
  return value;
}

export function shapeFromJsonValue(type: string, o: Record<string, unknown>): Shape {
  if (isBoxType(type)) return boxShapeFromJson(type, o);
  if (type === "text") return textShapeFromJson(o);
  if (isPointShapeType(type)) return { type, points: requirePoints(o) };
  return parseFail(`unknown element type "${type}"`);
}

export function isBoxType(type: string): type is "rect" | "ellipse" {
  return type === "rect" || type === "ellipse";
}

export function isPointShapeType(type: string): type is "arrow" | "line" | "pen" {
  return type === "arrow" || type === "line" || type === "pen";
}

export function boxShapeFromJson(type: "rect" | "ellipse", o: Record<string, unknown>): Shape {
  return {
    type,
    x: requireInt(o, "x"),
    y: requireInt(o, "y"),
    w: requireInt(o, "w"),
    h: requireInt(o, "h"),
  };
}

export function textShapeFromJson(o: Record<string, unknown>): Shape {
  return {
    type: "text",
    x: requireInt(o, "x"),
    y: requireInt(o, "y"),
    text: requireString(o, "text"),
    size: requireInt(o, "size"),
  };
}

export function elementFromJsonValue(v: unknown): Element {
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
export function elementToJsonValue(e: Element): Record<string, unknown> {
  return { id: e.id, type: e.shape.type, ...shapeJsonValue(e.shape), ...elementJsonOptions(e) };
}

export function shapeJsonValue(shape: Shape): Record<string, unknown> {
  if (shape.type === "rect" || shape.type === "ellipse") {
    return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
  }
  if (shape.type === "text") {
    return { x: shape.x, y: shape.y, text: shape.text, size: shape.size };
  }
  return { points: shape.points.map(([x, y]) => [x, y]) };
}

export function elementJsonOptions(e: Element): Record<string, unknown> {
  const out: Record<string, unknown> = { ink: e.ink };
  addTrueOption(out, "fill", e.fill);
  addStringOption(out, "label", e.label);
  addStringOption(out, "from", e.from);
  addStringOption(out, "to", e.to);
  addTrueOption(out, "locked", e.locked);
  return out;
}

export function addTrueOption(out: Record<string, unknown>, key: string, value: boolean): void {
  if (value) out[key] = true;
}

export function addStringOption(out: Record<string, unknown>, key: string, value: string | null): void {
  if (value !== null) out[key] = value;
}

/** `e123` → `123`, or `null` for anything else — the counter recovery's own
 * `strip_prefix('e')` + all-ASCII-digits test. */
export function idNumber(id: string): number | null {
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
  if (rustTrim(raw) === "") return defaultSketch();
  return normalizedSketch(readSketchDocument(raw));
}

export function readSketchDocument(raw: string): Sketch {
  const o = requireObject(parseSketchJson(raw), "the document");
  const rawElements = own(o, "elements");
  if (!Array.isArray(rawElements)) parseFail('missing or invalid "elements"');
  return {
    version: requireUint(o, "version"),
    width: requireInt(o, "width"),
    height: requireInt(o, "height"),
    seq: requireUint(o, "seq"),
    elements: rawElements.map(elementFromJsonValue),
  };
}

export function parseSketchJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    return parseFail(error instanceof Error ? error.message : String(error));
  }
}

export function normalizedSketch(doc: Sketch): Sketch {
  const elements = doc.elements.filter(isUsableSketchElement);
  const [width, height] = normalizedCanvasSize(doc.width, doc.height);
  return { ...doc, width, height, seq: recoveredSequence(doc.seq, elements), elements };
}

export function isUsableSketchElement(element: Element): boolean {
  const shape = element.shape;
  return !isPointShape(shape) || shape.points.length >= 2;
}

export function isPointShape(shape: Shape): shape is Extract<Shape, { type: "arrow" | "line" | "pen" }> {
  return isPointShapeType(shape.type);
}

export function normalizedCanvasSize(width: number, height: number): [number, number] {
  return width <= 0 || height <= 0 ? [CANVAS_W, CANVAS_H] : [width, height];
}

export function recoveredSequence(seq: number, elements: readonly Element[]): number {
  let high = 0;
  for (const element of elements) {
    const n = idNumber(element.id);
    if (n !== null && n > high) high = n;
  }
  return Math.max(seq, high);
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
