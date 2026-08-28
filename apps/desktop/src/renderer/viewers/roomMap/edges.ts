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
 *
 * THREE CHANNELS, NEVER ONE. A relationship kind is a nominal set, and hue
 * alone is not an accessible channel for a nominal set — so every kind carries
 * a hue AND a line treatment (dash pattern + weight) AND its own word in the
 * legend. The two neutral kinds at the bottom share a graphite and are told
 * apart by their dash and their weight, which is more honest than inventing a
 * sixth hue the palette does not have: tokens.css does the same thing for the
 * seven search engines (markers plus neutrals).
 *
 * The dash patterns also carry the trust axis on their own: a recorded fact is
 * drawn as an unbroken stroke, the further down the list the more broken it
 * gets, and the single inferred kind is a dotted pencil trail.
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
    widthMul: 2.4,
    springMul: 1.6,
    directed: true,
    fact: true,
  },
  same_page: {
    label: "Same page",
    lead: "Both saved from the same page",
    color: "var(--rm-edge-page)",
    dash: null,
    widthMul: 1.9,
    springMul: 1.4,
    directed: false,
    fact: true,
  },
  mentions: {
    label: "Names",
    lead: "This one names the other by name",
    color: "var(--rm-edge-mentions)",
    dash: null,
    widthMul: 1.6,
    springMul: 1.2,
    directed: true,
    fact: true,
  },
  cited: {
    label: "Cited together",
    lead: "One answer used both",
    color: "var(--rm-edge-cited)",
    dash: "3 3",
    widthMul: 1.3,
    springMul: 0.8,
    directed: false,
    fact: true,
  },
  same_site: {
    label: "Same site",
    lead: "Both came from the same website",
    color: "var(--rm-edge-site)",
    dash: "5 3",
    widthMul: 1.1,
    springMul: 0.7,
    directed: false,
    fact: true,
  },
  similar: {
    // The pencil trail: shortest dash, thinnest stroke, faintest ramp. It is
    // the only line on the map that is not a record of something the room
    // watched happen, and it is drawn like a note to self.
    label: "Reads alike",
    lead: "These read alike — a guess, not a record",
    color: "var(--rm-edge-similar)",
    dash: "1 3.5",
    widthMul: 0.9,
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
    // FACTS ARE NOT WEAK LINKS. The backend gives each recorded kind a constant
    // weight (same_site 0.45, a memory's match 0.6, `mentions` 0.8) while an
    // inferred `similar` is scored against this room's own range and can sit
    // near 1 — so one comparison across every kind took the proven relations
    // off the map first and left the guesses drawn. `rankEdges` spends its
    // render budget on facts first for the same reason; there it still has a
    // budget to run out of, whereas here nothing is being rationed, so a fact
    // is simply never hidden for being weak.
    (e) =>
      !filter.hidden.includes(e.kind) &&
      (styleFor(e.kind).fact || e.weight >= filter.minWeight),
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
  return [leadFor(edge), ...edge.shared.slice(0, 3)];
}

/** What THIS link claims.
 *
 *  A memory's link is not the file-to-file relation its kind is named after:
 *  the backend found the memory's two rarest words somewhere in the file's
 *  text, where `mentions` between files is a match on the file's own NAME. So
 *  the borrowed lead — "this one names the other by name" — stated a match
 *  nobody made, under evidence ("zermatt") that plainly isn't a name. Said
 *  here rather than as a sixth kind because the kind is the backend's word;
 *  what a line CLAIMS to the reader is this file's. */
function leadFor(edge: GraphEdge): string {
  if (edge.kind === "mentions" && edge.a.startsWith("mem:")) {
    return "This memory's distinctive words appear in this file";
  }
  return styleFor(edge.kind).lead;
}

/* ----- how much ink a link gets -----
 *
 * A weak link is drawn faint and a strong one is drawn dark, on separate ramps
 * for records and for the one inferred kind. This is the whole answer to "the
 * map is a hairball": nothing is hidden, the weak relations simply recede, and
 * the reader can still bring any of them forward with the strength bar or the
 * legend — both of which are visible, reversible controls.
 *
 * The ramps are set so that a full-strength link of every kind clears 3:1
 * against the paper in BOTH themes (the floor WCAG 1.4.11 asks of meaningful
 * non-text), while a near-zero-strength one is deliberately a whisper. That
 * lower end is under 3:1 on purpose, and it is allowed to be: the map is a
 * supplementary picture of data that is also stated in words — every link it
 * draws is spelled out, by kind and by name, in the List view beside it, which
 * is the keyboard and screen-reader route to the same information. */
const FACT_INK_FLOOR = 0.55;
const FACT_INK_GAIN = 0.38;
const GUESS_INK_FLOOR = 0.3;
const GUESS_INK_GAIN = 0.45;
/** How much darker a link goes while its node is hovered or selected. */
const LIT_INK_BOOST = 0.3;
const LIT_INK_MAX = 0.96;

/** Stroke opacity for one link. `lit` is true while either end is the hovered
 *  or selected node, which is the map's way of answering "what is this file
 *  attached to" without hiding anything else. */
export function edgeInk(edge: GraphEdge, lit: boolean): number {
  const s = styleFor(edge.kind);
  // The backend's weight is a position in this room's own range and should
  // already be 0..1; clamp anyway, because an out-of-range weight would push
  // the opacity past 1 and quietly flatten the whole strength channel.
  const w = Math.max(0, Math.min(1, edge.weight));
  const base = s.fact
    ? FACT_INK_FLOOR + w * FACT_INK_GAIN
    : GUESS_INK_FLOOR + w * GUESS_INK_GAIN;
  return lit ? Math.min(LIT_INK_MAX, base + LIT_INK_BOOST) : base;
}
