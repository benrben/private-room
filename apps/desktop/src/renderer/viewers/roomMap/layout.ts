import type { SimNode, SimEdge, View } from "./types";
import { GRAVITY, FIT_PAD, MIN_SCALE, MAX_SCALE } from "./constants";
import { styleFor } from "./edges";

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Star radius in world units from its (rendered-edge) degree. The coefficient
 *  is tuned for the TYPED graph's degrees: the old edge builder gave a 19-file
 *  room an average degree of 17, so every star sat at the size ceiling and the
 *  channel said nothing. Sparsified, a well-connected file has ~4 links, and
 *  the scale has to spread over that range instead. */
export function nodeRadius(deg: number): number {
  return 3.5 + Math.min(6, Math.sqrt(deg) * 2.6);
}

/** Deterministic per-node jitter so a room always lays out the same way. */
export function seedFrom(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Displacements {
  x: Float64Array;
  y: Float64Array;
}

interface Offset {
  x: number;
  y: number;
  distanceSquared: number;
}

function displacementsFor(count: number): Displacements {
  return { x: new Float64Array(count), y: new Float64Array(count) };
}

function pairOffset(a: SimNode, b: SimNode, aIndex: number, bIndex: number): Offset {
  const x = a.x - b.x;
  const y = a.y - b.y;
  const distanceSquared = x * x + y * y;
  if (distanceSquared < 0.01) return nudgedOffset(aIndex, bIndex);
  return { x, y, distanceSquared };
}

function nudgedOffset(aIndex: number, bIndex: number): Offset {
  const hash = ((aIndex * 73856093) ^ (bIndex * 19349663)) >>> 0;
  const x = (hash & 0xffff) / 0xffff - 0.5;
  const y = ((hash >>> 16) & 0xffff) / 0xffff - 0.5;
  return { x, y, distanceSquared: x * x + y * y + 0.01 };
}

function applyRepulsion(nodes: SimNode[], displacement: Displacements, k: number) {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const offset = pairOffset(nodes[i], nodes[j], i, j);
      const distance = Math.sqrt(offset.distanceSquared);
      const repulsion = (k * k) / distance;
      const x = offset.x / distance;
      const y = offset.y / distance;
      displacement.x[i] += x * repulsion;
      displacement.y[i] += y * repulsion;
      displacement.x[j] -= x * repulsion;
      displacement.y[j] -= y * repulsion;
    }
  }
}

function nonzeroDistance(x: number, y: number): number {
  return Math.sqrt(x * x + y * y) || 0.01;
}

function edgeAttraction(edge: SimEdge, distance: number, k: number): number {
  return ((distance * distance) / k) * (0.5 + edge.edge.weight) * styleFor(edge.edge.kind).springMul;
}

function applyAttraction(nodes: SimNode[], edges: SimEdge[], displacement: Displacements, k: number) {
  for (const edge of edges) {
    if (edge.hidden) continue;
    const a = nodes[edge.ai];
    const b = nodes[edge.bi];
    const x = a.x - b.x;
    const y = a.y - b.y;
    const distance = nonzeroDistance(x, y);
    const attraction = edgeAttraction(edge, distance, k);
    const unitX = x / distance;
    const unitY = y / distance;
    displacement.x[edge.ai] -= unitX * attraction;
    displacement.y[edge.ai] -= unitY * attraction;
    displacement.x[edge.bi] += unitX * attraction;
    displacement.y[edge.bi] += unitY * attraction;
  }
}

function nonzeroLength(x: number, y: number): number {
  return Math.hypot(x, y) || 1e-6;
}

function containNode(node: SimNode, maxRadius: number) {
  const radius = Math.hypot(node.x, node.y);
  if (radius > maxRadius) {
    node.x *= maxRadius / radius;
    node.y *= maxRadius / radius;
  }
}

function applyGravityAndMovement(nodes: SimNode[], displacement: Displacements, temp: number, k: number) {
  const maxRadius = 1.15 * k * Math.sqrt(nodes.length) + 2 * k;
  for (let i = 0; i < nodes.length; i++) {
    displacement.x[i] -= nodes[i].x * GRAVITY;
    displacement.y[i] -= nodes[i].y * GRAVITY;
    const distance = nonzeroLength(displacement.x[i], displacement.y[i]);
    const move = Math.min(distance, temp);
    nodes[i].x += (displacement.x[i] / distance) * move;
    nodes[i].y += (displacement.y[i] / distance) * move;
    containNode(nodes[i], maxRadius);
  }
}

/** One Fruchterman-Reingold tick: pairwise repulsion, edge attraction, a
 *  whiff of gravity, then a temperature-limited move. Mutates `nodes`.
 *  Fully deterministic — coincident nodes are nudged apart with an
 *  index-hashed offset rather than Math.random. */
export function runTick(nodes: SimNode[], edges: SimEdge[], temp: number, k: number) {
  const displacement = displacementsFor(nodes.length);
  applyRepulsion(nodes, displacement, k);
  applyAttraction(nodes, edges, displacement, k);
  // A disconnected node feels only repulsion (pushing out) and gravity (pulling
  // in); it settles at r ≈ k·√(n/GRAVITY) — with GRAVITY=0.015 that's ~8× the
  // connected cluster's radius, so a single unlinked file "floats far above" and
  // wrecks the auto-fit (the cluster shrinks to a dot). Contain every node
  // inside a frame sized to the connected layout so nothing escapes; the fit
  // then frames the real room instead of one outlier.
  applyGravityAndMovement(nodes, displacement, temp, k);
}

/* ----- the pen circle round a selected node -----
 *
 * The analyst's ring around the thing being talked about: a circle drawn by
 * hand, so it is slightly out of true and the pen carries a little past where
 * it started rather than closing exactly.
 *
 * Every number here is FIXED. The wobble is two harmonics of the angle, not a
 * random walk, so the same node draws the same ring on every frame and every
 * launch — a mark that re-shuffles as the layout settles would read as the map
 * twitching. Decoration on this map is inert by rule; this is the only mark on
 * it that is not a datum, and it still has to be reproducible.
 *
 * The ring is a polyline rather than a set of beziers because nodeRadius only
 * ever produces a handful of distinct sizes, so the paths are generated once
 * and cached. At HAND_CIRCLE_STEPS segments the chord sags about a pixel away
 * from a true arc at the map's absolute maximum zoom and far less than that
 * anywhere a reader actually works — which on a mark that is deliberately out
 * of true is not an error worth fitting curves to. Only the SELECTED node gets
 * a ring, so this runs once or twice a frame whatever the room's size. */
const HAND_CIRCLE_STEPS = 44;
/** Slightly more than one turn — where the overshoot comes from. */
const HAND_CIRCLE_TURNS = 1.06;
/** Where the pen touches down, in radians. Up and to the left in SVG's
 *  y-down coordinates, the way a hand starts a circle. */
const HAND_CIRCLE_START = -1.9;
const handCircleCache = new Map<number, string>();

export function handCircle(r: number): string {
  // Quantised so pan/zoom cannot mint a new path per frame. The step is a
  // quarter of a world unit, far below what a reader can see on a ring this
  // size, and it bounds the cache to the handful of radii nodeRadius produces.
  const key = Math.round(r * 4) / 4;
  const hit = handCircleCache.get(key);
  if (hit) return hit;
  const pts: string[] = [];
  const span = Math.PI * 2 * HAND_CIRCLE_TURNS;
  for (let i = 0; i <= HAND_CIRCLE_STEPS; i++) {
    const a = HAND_CIRCLE_START + span * (i / HAND_CIRCLE_STEPS);
    const rad = key * (1 + 0.055 * Math.sin(3 * a + 0.9) + 0.032 * Math.cos(5 * a - 2.1));
    pts.push(`${(Math.cos(a) * rad).toFixed(2)},${(Math.sin(a) * rad).toFixed(2)}`);
  }
  const d = `M${pts[0]}L${pts.slice(1).join("L")}`;
  handCircleCache.set(key, d);
  return d;
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function lowerBound(current: number, candidate: number): number {
  return candidate < current ? candidate : current;
}

function upperBound(current: number, candidate: number): number {
  return candidate > current ? candidate : current;
}

function includeInBounds(bounds: Bounds, node: SimNode): Bounds {
  return {
    minX: lowerBound(bounds.minX, node.x),
    minY: lowerBound(bounds.minY, node.y),
    maxX: upperBound(bounds.maxX, node.x),
    maxY: upperBound(bounds.maxY, node.y),
  };
}

function boundsOf(nodes: SimNode[]): Bounds {
  let bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const node of nodes) bounds = includeInBounds(bounds, node);
  return bounds;
}

function fitScale(bounds: Bounds, width: number, height: number): number {
  const boundsWidth = Math.max(bounds.maxX - bounds.minX, 1);
  const boundsHeight = Math.max(bounds.maxY - bounds.minY, 1);
  const scale = Math.min((width - FIT_PAD * 2) / boundsWidth, (height - FIT_PAD * 2) / boundsHeight);
  return clamp(validScale(scale), MIN_SCALE, MAX_SCALE);
}

function validScale(scale: number): number {
  if (!isFinite(scale) || scale <= 0) return 1;
  return scale;
}

function centeredView(bounds: Bounds, scale: number, width: number, height: number): View {
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  return { k: scale, x: width / 2 - centerX * scale, y: height / 2 - centerY * scale };
}

/** Fit the node bounds into a `w`×`h` viewport with padding, returning the
 *  world→screen transform. Used for the initial frame, on resize, and by the
 *  reset-view affordance. */
export function computeFit(nodes: SimNode[], w: number, h: number): View {
  if (!nodes.length || w <= 0 || h <= 0) return { k: 1, x: w / 2, y: h / 2 };
  const bounds = boundsOf(nodes);
  return centeredView(bounds, fitScale(bounds, w, h), w, h);
}
