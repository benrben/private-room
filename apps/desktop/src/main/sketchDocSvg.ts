/** Cohesive extraction from sketchDoc.ts; its public API remains on that module. */
import { has, own } from "./sketchDocJson.js";
import { Element, Point, Shape, Sketch, fixed, inkFillHex, inkHex, rustTrim } from "./sketchDocModel.js";
import { four } from "./sketchDocStatements.js";
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
export function seeded(id: string): () => number {
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
export function wobblySegment(r: () => number, x1: number, y1: number, x2: number, y2: number, a: number): string {
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

export function writeLabel(e: Element, cx: number, cy: number, ink: string): string {
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
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
  svg += `<rect width="${w}" height="${h}" fill="${PAPER}"/>`;
  for (const element of doc.elements) {
    svg += renderSvgElement(element);
  }
  return `${svg}</svg>`;
}

export type SvgRenderer = (element: Element, ink: string, random: () => number) => string;

export function renderSvgElement(element: Element): string {
  const renderer = SVG_RENDERERS[element.shape.type] as SvgRenderer | undefined;
  return renderer === undefined ? "" : renderer(element, inkHex(element.ink), seeded(element.id));
}

export function renderRect(element: Element, ink: string, random: () => number): string {
  const shape = element.shape as Extract<Shape, { type: "rect" }>;
  const fill = element.fill
    ? `<rect x="${shape.x}" y="${shape.y}" width="${shape.w}" height="${shape.h}" rx="8" fill="${inkFillHex(element.ink)}"/>`
    : "";
  return fill + rectOutline(random, shape, ink) + writeLabel(element, shape.x + shape.w / 2, shape.y + shape.h / 2 + 9, ink);
}

export function rectOutline(random: () => number, shape: Extract<Shape, { type: "rect" }>, ink: string): string {
  let path = "";
  for (let pass = 0; pass < 2; pass += 1) {
    path += wobblySegment(random, shape.x, shape.y, shape.x + shape.w, shape.y, 2.2);
    path += wobblySegment(random, shape.x + shape.w, shape.y, shape.x + shape.w, shape.y + shape.h, 2.2);
    path += wobblySegment(random, shape.x + shape.w, shape.y + shape.h, shape.x, shape.y + shape.h, 2.2);
    path += wobblySegment(random, shape.x, shape.y + shape.h, shape.x, shape.y, 2.2);
  }
  return `<path d="${path}" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>`;
}

export function renderEllipse(element: Element, ink: string, random: () => number): string {
  const shape = element.shape as Extract<Shape, { type: "ellipse" }>;
  const cx = shape.x + shape.w / 2;
  const cy = shape.y + shape.h / 2;
  const rx = shape.w / 2;
  const ry = shape.h / 2;
  const fill = element.fill ? `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${inkFillHex(element.ink)}"/>` : "";
  return fill + ellipseOutline(random, cx, cy, rx, ry, ink) + writeLabel(element, cx, cy + 9, ink);
}

export function ellipseOutline(random: () => number, cx: number, cy: number, rx: number, ry: number, ink: string): string {
  let path = "";
  for (let pass = 0; pass < 2; pass += 1) {
    path += ellipsePass(random, cx, cy, rx, ry);
  }
  return `<path d="${path}" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>`;
}

export function ellipsePass(random: () => number, cx: number, cy: number, rx: number, ry: number): string {
  const points = ellipsePoints(random, cx, cy, rx, ry);
  const start = midpoint(points[0] as Point, points[1] as Point);
  let path = `M${fixed(start[0], 1)} ${fixed(start[1], 1)}`;
  for (let index = 1; index <= points.length; index += 1) {
    const point = points[index % points.length] as Point;
    const next = points[(index + 1) % points.length] as Point;
    const middle = midpoint(point, next);
    path += `Q${fixed(point[0], 1)} ${fixed(point[1], 1)} ${fixed(middle[0], 1)} ${fixed(middle[1], 1)}`;
  }
  return `${path}Z`;
}

export function ellipsePoints(random: () => number, cx: number, cy: number, rx: number, ry: number): Point[] {
  const count = 16;
  const wobble = Math.min(Math.min(rx, ry) * 0.04 + 1.5, 4.0);
  const points: Point[] = [];
  for (let index = 0; index < count; index += 1) {
    const radians = (index / count) * Math.PI * 2;
    const radiusJitter = (random() * 2 - 1) * wobble;
    points.push([cx + Math.cos(radians) * (rx + radiusJitter), cy + Math.sin(radians) * (ry + radiusJitter)]);
  }
  return points;
}

export function midpoint(first: Point, second: Point): Point {
  return [(first[0] + second[0]) / 2, (first[1] + second[1]) / 2];
}

export function renderText(element: Element, ink: string): string {
  const shape = element.shape as Extract<Shape, { type: "text" }>;
  return `<text x="${shape.x}" y="${shape.y}" font-family="${FONT}" font-size="${shape.size}" fill="${ink}">${xmlEscape(shape.text)}</text>`;
}

export function renderLine(element: Element, ink: string, random: () => number): string {
  const points = (element.shape as Extract<Shape, { type: "line" }>).points;
  const ends = firstTwoPoints(points);
  if (ends === null) {
    return "";
  }
  return connectorPath(random, ends[0], ends[1], ink);
}

export function renderArrow(element: Element, ink: string, random: () => number): string {
  const points = (element.shape as Extract<Shape, { type: "arrow" }>).points;
  const ends = firstTwoPoints(points);
  if (ends === null) {
    return "";
  }
  return connectorPath(random, ends[0], ends[1], ink) + arrowheadPaths(ends[0], ends[1], ink) + arrowLabel(element, ends[0], ends[1], ink);
}

export function firstTwoPoints(points: readonly Point[]): [Point, Point] | null {
  const first = points[0];
  const second = points[1];
  return first === undefined || second === undefined ? null : [first, second];
}

export function connectorPath(random: () => number, start: Point, end: Point, ink: string): string {
  const path = wobblySegment(random, start[0], start[1], end[0], end[1], 2.5);
  return `<path d="${path}" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>`;
}

export function arrowheadPaths(start: Point, end: Point, ink: string): string {
  const angle = Math.atan2(end[1] - start[1], end[0] - start[0]);
  let paths = "";
  for (const headAngle of [angle + 2.6, angle - 2.6]) {
    paths +=
      `<path d="M${fixed(end[0], 1)} ${fixed(end[1], 1)}L${fixed(end[0] + Math.cos(headAngle) * 20, 1)} ` +
      `${fixed(end[1] + Math.sin(headAngle) * 20, 1)}" stroke="${ink}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
  }
  return paths;
}

export function arrowLabel(element: Element, start: Point, end: Point, ink: string): string {
  if (element.label === null || element.label === "") {
    return "";
  }
  return (
    `<text x="${fixed((start[0] + end[0]) / 2, 0)}" y="${fixed((start[1] + end[1]) / 2 - 12, 0)}" font-family="${FONT}" ` +
    `font-size="24" fill="${ink}" text-anchor="middle">${xmlEscape(element.label)}</text>`
  );
}

export function renderPen(element: Element, ink: string): string {
  const points = (element.shape as Extract<Shape, { type: "pen" }>).points;
  return `<path d="${penPath(points)}" fill="none" stroke="${ink}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
}

export function penPath(points: readonly Point[]): string {
  const first = points[0];
  if (first === undefined) {
    return "";
  }
  let path = `M${first[0]} ${first[1]}`;
  for (let index = 0; index + 1 < points.length; index += 1) {
    const current = points[index] as Point;
    const next = points[index + 1] as Point;
    path += `Q${current[0]} ${current[1]} ${Math.trunc((current[0] + next[0]) / 2)} ${Math.trunc((current[1] + next[1]) / 2)}`;
  }
  const last = points[points.length - 1] as Point;
  return `${path}L${last[0]} ${last[1]}`;
}

export const SVG_RENDERERS: Readonly<Record<Shape["type"], SvgRenderer>> = {
  rect: renderRect,
  ellipse: renderEllipse,
  text: renderText,
  line: renderLine,
  arrow: renderArrow,
  pen: renderPen,
};
