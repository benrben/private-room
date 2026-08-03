import type { GraphEdge, EdgeKind } from "./types";
import { MAX_EDGES } from "./constants";

/* ------------------------------------------------------------------ *
 * Typed links — what a line on the map MEANS.
 *
 * The map used to draw one violet hairline for everything, so "this file was
 * made from that one" and "these two use some of the same words" were the same
 * picture. They are not the same claim: the first is something the room
 * watched happen, the last is a guess. Order here is the trust order the
 * backend uses too (moonshot/graph.rs EDGE_KINDS) — it drives the draw order,
 * the legend, and which edges survive the cap.
 *
 * Colors are CSS custom properties, not hex literals: the canvas is near-black
 * in dark mode and near-white in light mode (roomMap.css), and a fixed amber at
 * low opacity is invisible on one of them.
 * ------------------------------------------------------------------ */

export interface EdgeStyle {
  /** Legend label — a plain noun phrase, not a jargon key. */
  label: string;
  /** Tooltip lead line: what the link claims, in full. */
  lead: string;
  /** CSS custom property holding the hue. */
  color: string;
  /** SVG stroke-dasharray in world units, or null for a solid line. Redundant
   *  with hue so the kinds stay distinguishable in greyscale / for colorblind
   *  readers (hue alone is not an accessible channel for a nominal set). */
  dash: string | null;
  /** Width multiplier — facts are drawn heavier than guesses. */
  widthMul: number;
  /** Spring multiplier in the layout, so a provenance pair actually settles
   *  next to each other and the map READS as structure. */
  springMul: number;
  /** True when the relation has a direction (a → b) and earns an arrowhead. */
  directed: boolean;
  /** False for `similar` — the only inferred relation. Facts are never dropped
   *  by the render cap. */
  fact: boolean;
}

export const EDGE_STYLE: Record<EdgeKind, EdgeStyle> = {
  derived: {
    label: "Made from",
    lead: "Made from this file",
    color: "var(--rm-edge-derived)",
    dash: null,
    widthMul: 2.2,
    springMul: 1.6,
    directed: true,
    fact: true,
  },
  same_page: {
    label: "Same page",
    lead: "Both saved from the same page",
    color: "var(--rm-edge-page)",
    dash: null,
    widthMul: 1.8,
    springMul: 1.4,
    directed: false,
    fact: true,
  },
  mentions: {
    label: "Names",
    lead: "This one names the other by name",
    color: "var(--rm-edge-mentions)",
    dash: null,
    widthMul: 1.5,
    springMul: 1.2,
    directed: true,
    fact: true,
  },
  cited: {
    label: "Cited together",
    lead: "One answer used both",
    color: "var(--rm-edge-cited)",
    dash: "3 3",
    widthMul: 1.2,
    springMul: 0.8,
    directed: false,
    fact: true,
  },
  same_site: {
    label: "Same site",
    lead: "Both came from the same website",
    color: "var(--rm-edge-site)",
    dash: "4 3",
    widthMul: 1,
    springMul: 0.7,
    directed: false,
    fact: true,
  },
  similar: {
    label: "Reads alike",
    lead: "These read alike — a guess, not a record",
    color: "var(--rm-edge-similar)",
    dash: "1 3",
    widthMul: 1,
    springMul: 0.5,
    directed: false,
    fact: false,
  },
};

/** Trust order — index 0 is the most-trusted. */
export const EDGE_KINDS = Object.keys(EDGE_STYLE) as EdgeKind[];

export function edgeRank(kind: string): number {
  const i = EDGE_KINDS.indexOf(kind as EdgeKind);
  return i < 0 ? EDGE_KINDS.length : i;
}

/** The style for an edge, falling back to `similar` for a kind this build
 *  doesn't know (an older/newer backend). An unknown link is drawn as the
 *  weakest thing it could be, never as a fact. */
export function styleFor(kind: string): EdgeStyle {
  return EDGE_STYLE[kind as EdgeKind] ?? EDGE_STYLE.similar;
}

/** Valid edges in draw order, capped for rendering.
 *
 * Sorted by (trust, strength), and the cap only ever eats INFERRED edges: a
 * plain weight sort would drop a modest-weight "made from" before a noisy
 * "reads alike", which is exactly backwards. This is the layout's input and
 * deliberately does NOT depend on the type filter — a legend toggle must not
 * re-seed the simulation and scatter the reader's map. */
export function rankEdges(edges: GraphEdge[], nodeIds: Set<string>): GraphEdge[] {
  const valid = edges
    .filter((e) => e.a !== e.b && nodeIds.has(e.a) && nodeIds.has(e.b))
    .sort((x, y) => edgeRank(x.kind) - edgeRank(y.kind) || y.weight - x.weight);
  const facts = valid.filter((e) => styleFor(e.kind).fact);
  const guesses = valid.filter((e) => !styleFor(e.kind).fact);
  // MAX_EDGES is a rendering/simulation budget, not an editorial one, so it
  // still binds when a long-lived room has more facts than it: every relation
  // is bounded per node in the builder, but a 60-file room with a lot of chat
  // history can still clear this. Facts are simply spent first — `valid` is
  // already in (trust, strength) order, so what survives is the most trusted.
  return [...facts.slice(0, MAX_EDGES), ...guesses.slice(0, Math.max(0, MAX_EDGES - facts.length))];
}

export interface EdgeFilter {
  /** Kinds the reader has switched off. */
  hidden: readonly string[];
  /** Minimum link strength to draw, 0..1. */
  minWeight: number;
}

export const NO_FILTER: EdgeFilter = { hidden: [], minWeight: 0 };

/** The subset the reader has asked to see. Density control lives here and only
 *  here: everything downstream of it (what is drawn, the degree that sizes a
 *  star, the neighbour highlight, the count line) reads THIS list, so the map
 *  never claims a connection it is not showing. */
export function filterEdges(edges: GraphEdge[], filter: EdgeFilter): GraphEdge[] {
  return edges.filter(
    (e) => !filter.hidden.includes(e.kind) && e.weight >= filter.minWeight,
  );
}

/** How many of each kind are present — the legend's counts, so a toggle for a
 *  kind the room has none of can say so instead of looking broken. */
export function countByKind(edges: GraphEdge[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of edges) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}

/** The tooltip for one link: what it claims, then the evidence the backend
 *  actually has for it. Never a bare percentage — after the sparsification the
 *  weight is a position in this room's own range, not a "% similar". */
export function edgeLines(edge: GraphEdge): string[] {
  return [styleFor(edge.kind).lead, ...edge.shared.slice(0, 3)];
}
