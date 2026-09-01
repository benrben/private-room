/** Cohesive extraction from moonshotGraph.ts; the public API remains on that module. */
import type Database from "better-sqlite3-multiple-ciphers";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

import { blobToEmbedding, cosineSimilarity, ftsFileMatches } from "./db-host/embeddings.js";
import { derivedLinks, listFiles, stripHebrewMarks, type FileMeta } from "./db-host/files.js";
import { listFolders } from "./db-host/folders.js";
import type { RoomSource } from "./moonshotCmds.js";
import type { OpenRoom } from "./turnEngine.js";
import { listMemories } from "./db-host/memories.js";
import { recentMessageSources } from "./db-host/messages.js";
import { ftsMatchExpr, NOT_ALPHANUMERIC, STOPWORDS } from "./db-host/retrieval.js";
import { queryRows } from "./db-host/util.js";
import { clampWords } from "./textClamp.js";
import { GraphFile } from "./moonshotGraphFiles.js";
import { roomGraph } from "./moonshotGraphSurface.js";
export type { OpenRoom, RoomSource };

// ============================================================================
// Wire types — see the module doc for why these are a fresh local mirror.
// ============================================================================

/** D3: one node in the room's similarity graph — a file or a memory. */
export interface GraphNode {
  id: string;
  name: string;
  folder: string | null;
  kind: "file" | "memory";
}

/** D3: a TYPED link between two nodes. `kind` is one of {@link EDGE_KINDS} —
 * "derived" | "same_page" | "mentions" | "cited" | "same_site" are relations
 * the room can prove from what it stored; "similar" is the only inferred
 * one. `weight` is on the ONE shared 0..1 scale {@link linkStrength} builds,
 * NOT the raw similarity — cosine and TF-IDF cosine are different
 * measurements, see that function's doc. `directed` marks the `a` → `b`
 * relations (`a` produced `b`, or `a`'s text names `b`). `shared` holds up
 * to 3 short strings of evidence for the link, empty when the kind alone
 * says it all. */
export interface GraphEdge {
  a: string;
  b: string;
  weight: number;
  kind: string;
  directed: boolean;
  shared: string[];
}

/** D3: the whole room graph, from {@link roomGraph}. */
export interface RoomGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ============================================================================
// Edge kinds — the trust order.
// ============================================================================

/** `b` was generated FROM `a` — the room watched it happen
 * (`files.derived_from`). */
export const EDGE_DERIVED = "derived";
/** Both files were saved from the SAME URL (the browser's md+html twin, a
 * re-save). */
export const EDGE_SAME_PAGE = "same_page";
/** Both files came off the same host. */
export const EDGE_SAME_SITE = "same_site";
/** `a`'s text contains `b`'s name — one document naming another. */
export const EDGE_MENTIONS = "mentions";
/** One answer used both files as its sources. */
export const EDGE_CITED = "cited";
/** The only INFERRED relation: the two read alike. Everything above is a
 * fact. */
export const EDGE_SIMILAR = "similar";

/** Every edge kind the builder can emit, most-trusted first. The order IS
 * the trust order: when two relations hold for one pair only the first is
 * drawn, because "made from" tells the reader strictly more than "reads
 * alike". */
export const EDGE_KINDS: readonly string[] = [
  EDGE_DERIVED,
  EDGE_SAME_PAGE,
  EDGE_MENTIONS,
  EDGE_CITED,
  EDGE_SAME_SITE,
  EDGE_SIMILAR,
];

export function edgeRank(kind: string): number {
  const idx = EDGE_KINDS.indexOf(kind);
  return idx === -1 ? EDGE_KINDS.length : idx;
}

// ============================================================================
// Tuning constants — ported verbatim. The tuning history IS the value; see
// each Rust doc comment (reproduced here) for the measurement behind it.
// ============================================================================

/** Cap the file set so the O(n²) pairing stays cheap on a very large room. */
export const GRAPH_MAX_FILES = 60;
/** How many neighbours each file may PROPOSE for the inferred `similar`
 * relation. Rank-based, not a similarity cutoff: mean-pooled document
 * vectors in one room all clear an absolute 0.55 cosine, which used to link
 * 163 of 171 possible pairs. A per-file top-K is invariant to that
 * compression. Union (an edge lives if EITHER end ranks it) rather than
 * mutual, which would strand every file whose nearest neighbour is a hub. */
export const GRAPH_SIM_TOP_K = 3;
/** Whole-map budget for `similar`, per FILE node (memories propose none).
 * Facts are not counted against it. */
export const GRAPH_SIM_MAX_PER_NODE = 3;
/** Sanity floor on the raw cosine of two mean chunk embeddings — what keeps
 * an unrelated file unconnected when rank alone would still link it. */
export const GRAPH_VEC_FLOOR = 0.45;
/** The same floor for the TF-IDF cosine used while a file has no
 * embeddings. Much lower because the two are different measurements —
 * {@link linkStrength} is what puts them on one scale. */
export const GRAPH_KW_FLOOR = 0.08;
/** Weight a link that only just clears its own floor is drawn at, so the
 * weakest surviving edge is still visible instead of a 0-width hairline. */
export const GRAPH_WEIGHT_MIN = 0.3;
/** How many files may be linked as naming one given file. `mentions` is a
 * fact, but an UNBOUNDED fact is still a hairball, so it gets a budget like
 * `similar`. */
export const GRAPH_MENTION_TOP = 2;
/** A name is only searched for if its rarest word appears in at most this
 * share of the room's files — what stops "Notes.md" linking to everything,
 * mechanically, from the room's own word statistics. */
export const GRAPH_MENTION_DF_RATIO = 0.15;
/** Shortest file-name stem worth searching for at all. */
export const GRAPH_MENTION_MIN_STEM = 6;
/** Biggest same-host group that still earns `same_site` links. Past this a
 * domain is a scrape, not a relationship. */
export const GRAPH_SITE_GROUP_MAX = 8;
/** An answer citing more than this many files is doing research, not
 * relating two documents — linking all its pairs would clique the map. */
export const GRAPH_CITED_MAX_SOURCES = 4;
/** How many `cited` partners one file may keep, most-cited first — the same
 * rank-based bound `similar`/`mentions` get: an UNBOUNDED fact accumulates
 * over every answer the room has ever given and eventually cites every file
 * alongside every other. */
export const GRAPH_CITED_TOP = 3;
/** Distinct terms kept per file for the TF-IDF signal. */
export const GRAPH_TFIDF_TERMS = 40;

// ============================================================================
// is_summary_file — duplicated, not imported. See module doc.
// ============================================================================

export const SUMMARY_FILE_NAME = "Room summary.html";

export function isSummaryFile(name: string, source: string): boolean {
  return (name === SUMMARY_FILE_NAME || name === "Room summary.md") && source === "generated";
}

// ============================================================================
// Scoring primitives.
// ============================================================================

/** Put a raw similarity on the ONE 0..1 scale the map draws, ranks and caps
 * by: each signal's own floor maps to {@link GRAPH_WEIGHT_MIN}, a perfect
 * match to 1.0. Cosine and TF-IDF cosine are different measurements — a 0.1
 * term overlap is about as strong a keyword link as a room ever produces,
 * while a 0.1 cosine is noise — so sending both raw drew every keyword edge
 * as a near-invisible hairline, labelled it "10% similar", and made it the
 * first edge dropped when the viewer's edge cap bit. */
export function linkStrength(raw: number, floor: number): number {
  if (floor >= 1.0) {
    return Math.min(Math.max(raw, 0), 1);
  }
  const above = Math.min(Math.max((raw - floor) / (1 - floor), 0), 1);
  return GRAPH_WEIGHT_MIN + above * (1 - GRAPH_WEIGHT_MIN);
}

/** The distinctive words of a piece of text, for the TF-IDF keyword signal.
 * Deliberately NOT `questionTerms` (`retrieval.ts`): that caps at 24 terms,
 * so over a whole file it would return the first two dozen words of the
 * first chunk — positional, not distinctive. Same {@link STOPWORDS} list
 * `questionTerms` filters against (the two are the same Rust `pub(crate)
 * const` via `use super::*`), same non-alphanumeric split. */
export function indexTerms(text: string): string[] {
  const stripped = stripHebrewMarks(text);
  const words = stripped.toLowerCase().split(NOT_ALPHANUMERIC);
  const out: string[] = [];
  for (const w of words) {
    if (Array.from(w).length >= 3 && !STOPWORDS.has(w)) {
      out.push(w);
    }
  }
  return out;
}

/** Cosine of two L2-normalised sparse TF-IDF vectors. */
export function tfidfCosine(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [t, w] of small) {
    const w2 = big.get(t);
    if (w2 !== undefined) {
      sum += w * w2;
    }
  }
  return Math.min(Math.max(sum, 0), 1);
}

/** The terms carrying the most of two files' shared TF-IDF mass — the
 * honest "why are these two linked" line. */
export function topSharedTerms(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
  max: number
): string[] {
  const hits: Array<[string, number]> = [];
  for (const [t, w] of a) {
    const w2 = b.get(t);
    if (w2 !== undefined) {
      hits.push([t, w * w2]);
    }
  }
  // Ties broken by term so the same room always produces the same reasons.
  hits.sort((x, y) => (y[1] !== x[1] ? y[1] - x[1] : x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  return hits.slice(0, max).map(([t]) => t);
}

/** A file name's searchable stem: extension dropped, and the " (2)" suffix
 * `availableName` (`files.ts`) adds to a re-run stripped, so the second run
 * of a studio still matches the text that names the first. */
export function nameStem(name: string): string {
  const dotIdx = name.lastIndexOf(".");
  const stem = dotIdx > 0 ? name.slice(0, dotIdx) : name;
  const trimmed = stem.replace(/\p{White_Space}+$/u, "");
  return withoutRerunSuffix(trimmed);
}

export function withoutRerunSuffix(trimmed: string): string {
  if (trimmed.endsWith(")")) {
    const withoutTrailingParen = trimmed.slice(0, -1);
    const open = withoutTrailingParen.lastIndexOf(" (");
    if (open !== -1) {
      const inner = trimmed.slice(open + 2, trimmed.length - 1);
      if (inner.length > 0 && /^[0-9]+$/.test(inner)) {
        return trimmed.slice(0, open).trim();
      }
    }
  }
  return trimmed;
}

/** Median, and median absolute deviation, of a score list. The `similar`
 * relation's per-file bar is built from these rather than from a constant:
 * a room's own similarity scale is the only thing a cutoff can honestly be
 * measured against. */
export function median(sortedDesc: readonly number[]): number {
  const n = sortedDesc.length;
  if (n % 2 === 1) {
    return sortedDesc[Math.floor(n / 2)] as number;
  }
  return ((sortedDesc[n / 2 - 1] as number) + (sortedDesc[n / 2] as number)) / 2;
}

/** The bar a file's own candidates must clear, from that file's own score
 * spread. Returns `-Infinity` (i.e. no bar) when there are too few
 * candidates for a spread to mean anything — at n=2 a median-based cutoff
 * would reject the only pair a two-file room can have, every time. */
export function adaptiveFloor(sortedDesc: readonly number[]): number {
  if (sortedDesc.length < 4) {
    return Number.NEGATIVE_INFINITY;
  }
  const med = median(sortedDesc);
  const devs = sortedDesc.map((s) => Math.abs(s - med));
  devs.sort((a, b) => b - a);
  return med + median(devs);
}

/** Unordered key for a pair of node ids, so the same relation found twice is
 * one edge. `\u0000` cannot appear in a UUID or in FTS-searched text, so this
 * cannot collide two distinct pairs onto one key. */
export function pairKeyStr(a: string, b: string): string {
  return a <= b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/** Collects at most one edge per pair, keeping the most-trusted kind (then
 * the strongest). Two files that are BOTH a full pass of each other and
 * word-alike should read as "made from", not as two lines on top of each
 * other. */
export class EdgeSet {
  private readonly byPair = new Map<string, GraphEdge>();

  offer(e: GraphEdge): void {
    if (e.a === e.b) {
      return;
    }
    const key = pairKeyStr(e.a, e.b);
    const cur = this.byPair.get(key);
    if (cur !== undefined && keepsEdge(cur, e)) return;
    this.byPair.set(key, e);
  }

  contains(a: string, b: string): boolean {
    return this.byPair.has(pairKeyStr(a, b));
  }

  /** Most-trusted first, then strongest — a stable order so an unchanged
   * room produces a byte-identical payload and the viewer never re-lays-out
   * for nothing. */
  intoSorted(): GraphEdge[] {
    const out = [...this.byPair.values()];
    out.sort(compareEdges);
    return out;
  }
}

export function keepsEdge(current: GraphEdge, candidate: GraphEdge): boolean {
  const currentRank = edgeRank(current.kind);
  const candidateRank = edgeRank(candidate.kind);
  return currentRank < candidateRank || (currentRank === candidateRank && current.weight >= candidate.weight);
}

export function compareText(x: string, y: string): number {
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

export function compareEdges(x: GraphEdge, y: GraphEdge): number {
  const rankDiff = edgeRank(x.kind) - edgeRank(y.kind);
  if (rankDiff !== 0) return rankDiff;
  if (y.weight !== x.weight) return y.weight - x.weight;
  const first = compareText(x.a, y.a);
  if (first !== 0) return first;
  return compareText(x.b, y.b);
}

/** The host of a URL with a leading `www.` dropped, or `null` when it
 * doesn't parse or has no host (e.g. a `mailto:` link). WHATWG `URL` stands
 * in for the Rust source's `reqwest::Url::parse` — both require an absolute
 * URL and both lower-case the host.
 *
 * EVERY leading `www.` goes, not just the first: Rust's
 * `trim_start_matches("www.")` strips the pattern repeatedly, so
 * `www.www.example.com` and `example.com` are the SAME site to the room map.
 * Stripping once left the two in different `by_site` groups and drew no
 * `same_site` link between them at all. */
export function siteOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  let host = parsed.hostname.toLowerCase();
  if (host === "") {
    return null;
  }
  while (host.startsWith("www.")) {
    host = host.slice(4);
  }
  return host;
}

/** Link every member of a same-origin group to its FIRST member (`group` is
 * newest-first, since it is built by iterating `files`, which is
 * newest-first). A star, not a clique: eight pages off one host is 7 honest
 * links, where all-pairs would be 28 and would swamp everything else on the
 * map. */
export function starLinks(
  group: readonly number[],
  files: readonly GraphFile[],
  kind: string,
  weight: number,
  why: readonly string[]
): GraphEdge[] {
  const hub = group[0] as number;
  return group.slice(1).map(
    (i): GraphEdge => ({
      a: (files[hub] as GraphFile).id,
      b: (files[i] as GraphFile).id,
      weight,
      kind,
      directed: false,
      shared: [...why],
    })
  );
}
