/** Vision image preparation and grounding-response parsing. */

import sharp from "sharp";
import { stripThinkSpans } from "./engineRouting.js";
import type { PreparedImage } from "./turnContext.js";
import type { ImageBox } from "../shared/apiTypes.js";

// ============================================================================
// constants + pure formatting (vision.rs top of file)
// ============================================================================

/** Ported verbatim from `vision::VISION_SQUARE`. The square canvas every
 * image is fitted to before grounding — see {@link prepareImage}'s doc for
 * why a square (rather than the image's own aspect ratio) is what keeps a
 * small vision model's box coordinates from drifting downward. */
export const VISION_SQUARE = 1000;

/**
 * The grounding prompt Qwen-VL models were trained on. Ported verbatim from
 * `grounding_prompt` (the Rust source's backslash-newline string
 * continuations collapse to a single space-preserving string — reproduced
 * here as plain concatenation so the wire text matches exactly).
 */
export function groundingPrompt(query: string, w: number, h: number): string {
  return (
    `Outline the position of each instance of the following in this ${w.toFixed(0)}x${h.toFixed(0)} ` +
    `pixel image: ${query}\n` +
    `Output ONLY a JSON array, no other text, in the format ` +
    `[{"bbox_2d": [x1, y1, x2, y2], "label": "<short name>"}]. ` +
    `One element per match, each with a distinct descriptive label. ` +
    `If it is not in the image, output [].`
  );
}

/** ADD-22: JSON schema handed to Ollama `format` for the grounding pass, so a
 * small vision model can only ever emit a well-formed box array. Ported
 * verbatim from `boxes_schema`. */
export function boxesSchema(): unknown {
  return {
    type: "array",
    items: {
      type: "object",
      properties: {
        bbox_2d: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
        label: { type: "string" },
      },
      required: ["bbox_2d", "label"],
    },
  };
}

// ============================================================================
// parse_boxes / boxes_from_items
// ============================================================================

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** An OWN-property read — the guard this file's sibling modules
 * (`privacy.ts`'s `ownValue`, `ollamaGenerate.ts`'s `ownValue`) already use
 * for exactly the same reason: a model-controlled JSON object must never be
 * allowed to answer through an INHERITED `Object.prototype` entry. */
export function ownValue(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/**
 * The index one past the JSON value that STARTS at `s[open]` (which must be
 * `"["` or `"{"`), found by walking bracket depth while respecting string
 * quoting/escaping — or `null` if the brackets never balance before the
 * string ends.
 *
 * This is the structural half of what Rust's
 * `serde_json::Deserializer::from_str(&cleaned[start..]).into_iter::<Value>().next()`
 * does: a streaming deserializer parses exactly ONE balanced JSON value
 * starting at a position and stops, ignoring any trailing prose — it does
 * NOT require the rest of the string to be valid JSON, or even present. A
 * bracket-depth walk that respects quoting finds the same boundary, because
 * JSON's grammar is exactly "balanced brackets/braces, with quoting inside
 * strings" — so slicing `s[open..=end]` and handing it to a strict
 * `JSON.parse` reproduces the streaming parser's own value boundary.
 */
interface BracketScanState {
  depth: number;
  inString: boolean;
  escaped: boolean;
}

function matchingClose(s: string, open: number): string {
  return s[open] === "[" ? "]" : "}";
}

function consumesQuotedCharacter(c: string | undefined, state: BracketScanState): boolean {
  if (!state.inString) return false;
  if (state.escaped) {
    state.escaped = false;
  } else if (c === "\\") {
    state.escaped = true;
  } else if (c === '"') {
    state.inString = false;
  }
  return true;
}

function isOpeningBracket(c: string | undefined): boolean {
  return c === "[" || c === "{";
}

function isClosingBracket(c: string | undefined): boolean {
  return c === "]" || c === "}";
}

function bracketEndAt(
  c: string | undefined,
  state: BracketScanState,
  close: string,
  index: number,
): number | null | undefined {
  if (isOpeningBracket(c)) {
    state.depth += 1;
    return undefined;
  }
  if (!isClosingBracket(c)) return undefined;
  state.depth -= 1;
  if (state.depth !== 0) return undefined;
  return c === close ? index : null;
}

function matchingBracketEnd(s: string, open: number): number | null {
  const close = matchingClose(s, open);
  const state: BracketScanState = { depth: 0, inString: false, escaped: false };
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (consumesQuotedCharacter(c, state)) continue;
    if (c === '"') {
      state.inString = true;
      continue;
    }
    const end = bracketEndAt(c, state, close, i);
    if (end !== undefined) {
      return end;
    }
  }
  return null;
}

/**
 * Requested `"bbox_2d"` is absolute pixels (Qwen-VL's native grounding
 * format), `"bbox"` an alias for it. `"box_2d"` is Google-style
 * `[ymin, xmin, ymax, xmax]` 0-1000. `"box"` is the same axis order as
 * `bbox_2d` but not treated as pixels. Ported verbatim from
 * `boxes_from_items`.
 */
function itemLabel(item: Record<string, unknown>): string {
  const label = ownValue(item, "label");
  if (typeof label === "string") {
    return label;
  }
  const name = ownValue(item, "name");
  return typeof name === "string" ? name : "match";
}

interface BoxCoordinates {
  coords: unknown[];
  yFirst: boolean;
  pixels: boolean;
}

const BOX_COORDINATE_KEYS: ReadonlyArray<readonly [string, boolean, boolean]> = [
  ["bbox_2d", false, true],
  ["bbox", false, true],
  ["box_2d", true, false],
  ["box", false, false],
];

function itemCoordinates(item: Record<string, unknown>): BoxCoordinates | null {
  for (const [key, yFirst, pixels] of BOX_COORDINATE_KEYS) {
    const coords = ownValue(item, key);
    if (Array.isArray(coords)) {
      return { coords, yFirst, pixels };
    }
  }
  return null;
}

function finiteCoordinates(coords: unknown[]): number[] | null {
  // `vals.len() != 4` after `filter_map(as_f64)` — every one of the 4 must
  // be a genuine JSON number, or the whole element is skipped.
  if (coords.length !== 4 || coords.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    return null;
  }
  return coords as number[];
}

function orderedCoordinates(values: number[], yFirst: boolean): [number, number, number, number] {
  if (yFirst) {
    return [values[1]!, values[0]!, values[3]!, values[2]!];
  }
  return [values[0]!, values[1]!, values[2]!, values[3]!];
}

function scaleForCoordinates(
  values: number[],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  pixels: boolean,
  imgW: number,
  imgH: number
): [number, number] {
  if (Math.max(...values) <= 1.0) {
    return [1.0, 1.0];
  }
  const outOfRange = Math.max(x1, x2) > imgW * 1.05 || Math.max(y1, y2) > imgH * 1.05;
  if (pixels && !outOfRange) {
    return [Math.max(imgW, 1.0), Math.max(imgH, 1.0)];
  }
  return [1000.0, 1000.0];
}

function clampCoordinate(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function boxItem(raw: unknown): Record<string, unknown> {
  return isPlainObject(raw) ? raw : {};
}

function hasBoxArea(x1: number, y1: number, x2: number, y2: number): boolean {
  return x2 - x1 >= 0.001 && y2 - y1 >= 0.001;
}

function normalizedCoordinates(
  values: number[],
  yFirst: boolean,
  pixels: boolean,
  imgW: number,
  imgH: number
): [number, number, number, number] {
  let [x1, y1, x2, y2] = orderedCoordinates(values, yFirst);
  const [scaleX, scaleY] = scaleForCoordinates(values, x1, y1, x2, y2, pixels, imgW, imgH);
  x1 /= scaleX;
  x2 /= scaleX;
  y1 /= scaleY;
  y2 /= scaleY;
  if (x1 > x2) {
    [x1, x2] = [x2, x1];
  }
  if (y1 > y2) {
    [y1, y2] = [y2, y1];
  }
  return [clampCoordinate(x1), clampCoordinate(y1), clampCoordinate(x2), clampCoordinate(y2)];
}

function boxFromItem(raw: unknown, imgW: number, imgH: number): ImageBox | null {
  const item = boxItem(raw);
  const details = itemCoordinates(item);
  if (details === null) {
    return null;
  }
  const values = finiteCoordinates(details.coords);
  if (values === null) {
    return null;
  }
  const [x1, y1, x2, y2] = normalizedCoordinates(values, details.yFirst, details.pixels, imgW, imgH);
  if (!hasBoxArea(x1, y1, x2, y2)) {
    return null;
  }
  return { label: itemLabel(item), x1, y1, x2, y2 };
}

export function boxesFromItems(items: readonly unknown[], imgW: number, imgH: number): ImageBox[] {
  const boxes: ImageBox[] = [];
  for (const raw of items) {
    const box = boxFromItem(raw, imgW, imgH);
    if (box !== null) {
      boxes.push(box);
    }
  }
  return boxes;
}

/**
 * CHG-21: drop any `<think>…</think>` spans some models leak, then scan each
 * `'['` as a candidate JSON array (up to 8, matching Rust's `.take(8)`),
 * returning the first array that yields at least one box. Robust to
 * leading/trailing prose containing brackets, unlike a single
 * first-`[`-to-last-`]` slice. Ported verbatim from `parse_boxes`.
 *
 * `strip_think_spans` is `ollama::strip_think_spans` — `vision.rs` itself
 * re-exports it with `pub(crate) use crate::ollama::strip_think_spans;`
 * rather than defining its own copy, and this port does the same by
 * importing `engineRouting.ts`'s already-real {@link stripThinkSpans}.
 */
function candidateArrayPositions(cleaned: string): number[] {
  const positions: number[] = [];
  for (let i = 0; i < cleaned.length && positions.length < 8; i++) {
    if (cleaned[i] === "[") {
      positions.push(i);
    }
  }
  return positions;
}

function parsedCandidateArray(cleaned: string, start: number): unknown[] | null {
  const end = matchingBracketEnd(cleaned, start);
  if (end === null) return null;
  try {
    const value: unknown = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function parseBoxes(raw: string, imgW: number, imgH: number): ImageBox[] {
  const cleaned = stripThinkSpans(raw);
  for (const start of candidateArrayPositions(cleaned)) {
    const value = parsedCandidateArray(cleaned, start);
    if (value === null) continue;
    const boxes = boxesFromItems(value, imgW, imgH);
    if (boxes.length > 0) return boxes;
  }
  return [];
}

// ============================================================================
// prepare_image — REAL, via sharp (see module doc)
// ============================================================================

/**
 * Normalize an image for the model: transcode to PNG and fit it onto a fixed
 * `VISION_SQUARE`×`VISION_SQUARE` canvas. Returns the {@link PreparedImage}
 * shape `turnContext.ts` already declares for this exact seam.
 *
 * STRETCHED to a square rather than kept at its own aspect ratio — Rust's own
 * "Marking fix" comment explains why: this removes both the pixel-vs-0..1000
 * scale ambiguity (on a 1000×1000 image both conventions normalize
 * identically) and the vision model's own internal square-padding, which
 * otherwise squeezes a non-square image toward the middle and drags boxes
 * down. Boxes are drawn back over the ORIGINAL image using NORMALIZED
 * coordinates, so the per-axis stretch cancels out exactly.
 *
 * `fit: "fill"` is `resize_exact` (stretch, discard aspect ratio); `kernel:
 * "linear"` is the closest published match to `FilterType::Triangle` (the
 * `image` crate's own docs describe `Triangle` as "linear filter" — both are
 * the bilinear/tent kernel). Falls back to `sharp(bytes).metadata()` — a
 * header-only read, the same operation `imagesize::blob_size` performs, for
 * bytes `sharp` cannot fully decode but can still identify — and only then
 * to a flat `VISION_SQUARE`×`VISION_SQUARE` guess, mirroring Rust's own
 * two-step fallback exactly.
 */
export async function prepareImage(bytes: Buffer): Promise<PreparedImage> {
  const square = VISION_SQUARE;
  try {
    const out = await sharp(bytes)
      .resize(VISION_SQUARE, VISION_SQUARE, { fit: "fill", kernel: "linear" })
      .png()
      .toBuffer();
    return { bytes: out, width: square, height: square };
  } catch {
    try {
      const meta = await sharp(bytes).metadata();
      if (typeof meta.width === "number" && typeof meta.height === "number") {
        return { bytes, width: meta.width, height: meta.height };
      }
    } catch {
      // Genuinely unreadable — fall through to the flat guess below, exactly
      // as Rust's `unwrap_or((square, square))` does.
    }
    return { bytes, width: square, height: square };
  }
}

// ============================================================================
// models.rs duplication — see module doc's "ONE DUPLICATION" section
