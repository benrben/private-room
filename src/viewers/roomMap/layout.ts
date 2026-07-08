import type { SimNode, SimEdge, View } from "./types";
import { GRAVITY, FIT_PAD, MIN_SCALE, MAX_SCALE } from "./constants";

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Star radius in world units from its (rendered-edge) degree. */
export function nodeRadius(deg: number): number {
  return 3.5 + Math.min(6, Math.sqrt(deg) * 1.6);
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

/** One Fruchterman-Reingold tick: pairwise repulsion, edge attraction, a
 *  whiff of gravity, then a temperature-limited move. Mutates `nodes`.
 *  Fully deterministic — coincident nodes are nudged apart with an
 *  index-hashed offset rather than Math.random. */
export function runTick(nodes: SimNode[], edges: SimEdge[], temp: number, k: number) {
  const n = nodes.length;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let ox = nodes[i].x - nodes[j].x;
      let oy = nodes[i].y - nodes[j].y;
      let d2 = ox * ox + oy * oy;
      if (d2 < 0.01) {
        // exactly overlapping — nudge apart in a deterministic direction
        const hash = ((i * 73856093) ^ (j * 19349663)) >>> 0;
        ox = (hash & 0xffff) / 0xffff - 0.5;
        oy = ((hash >>> 16) & 0xffff) / 0xffff - 0.5;
        d2 = ox * ox + oy * oy + 0.01;
      }
      const dist = Math.sqrt(d2);
      const rep = (k * k) / dist;
      const ux = ox / dist;
      const uy = oy / dist;
      dx[i] += ux * rep;
      dy[i] += uy * rep;
      dx[j] -= ux * rep;
      dy[j] -= uy * rep;
    }
  }
  for (const e of edges) {
    const a = nodes[e.ai];
    const b = nodes[e.bi];
    const ox = a.x - b.x;
    const oy = a.y - b.y;
    const dist = Math.sqrt(ox * ox + oy * oy) || 0.01;
    // Stronger for higher-confidence edges so related files sit closer.
    const att = ((dist * dist) / k) * (0.5 + e.edge.weight);
    const ux = ox / dist;
    const uy = oy / dist;
    dx[e.ai] -= ux * att;
    dy[e.ai] -= uy * att;
    dx[e.bi] += ux * att;
    dy[e.bi] += uy * att;
  }
  for (let i = 0; i < n; i++) {
    dx[i] -= nodes[i].x * GRAVITY;
    dy[i] -= nodes[i].y * GRAVITY;
    const dl = Math.hypot(dx[i], dy[i]) || 1e-6;
    const move = Math.min(dl, temp);
    nodes[i].x += (dx[i] / dl) * move;
    nodes[i].y += (dy[i] / dl) * move;
  }
}

/** An 8-vertex sparkle (4-point star) of radius `r`, centred on the origin. */
export function starPoints(r: number): string {
  const inner = r * 0.4;
  const pts: string[] = [];
  for (let i = 0; i < 8; i++) {
    const ang = -Math.PI / 2 + (i * Math.PI) / 4;
    const rad = i % 2 === 0 ? r : inner;
    pts.push(`${(Math.cos(ang) * rad).toFixed(2)},${(Math.sin(ang) * rad).toFixed(2)}`);
  }
  return pts.join(" ");
}

/** Fit the node bounds into a `w`×`h` viewport with padding, returning the
 *  world→screen transform. Used for the initial frame, on resize, and by the
 *  reset-view affordance. */
export function computeFit(nodes: SimNode[], w: number, h: number): View {
  if (!nodes.length || w <= 0 || h <= 0) return { k: 1, x: w / 2, y: h / 2 };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
    if (n.y > maxY) maxY = n.y;
  }
  const bw = Math.max(maxX - minX, 1);
  const bh = Math.max(maxY - minY, 1);
  let k = Math.min((w - FIT_PAD * 2) / bw, (h - FIT_PAD * 2) / bh);
  if (!isFinite(k) || k <= 0) k = 1;
  k = clamp(k, MIN_SCALE, MAX_SCALE);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { k, x: w / 2 - cx * k, y: h / 2 - cy * k };
}
