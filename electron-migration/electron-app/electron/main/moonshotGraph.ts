/**
 * D3: the room graph — files and memories as nodes, six kinds of typed edges
 * between them (five the room can PROVE from what it stored, one INFERRED).
 * Ported from `src-tauri/src/commands/moonshot/graph.rs` (1163 lines, the
 * largest submodule of `moonshot.rs` — read in full, including its
 * `#[cfg(test)] mod tests`; all 14 are reproduced in `moonshotGraph.test.ts`,
 * plus a few extra covering the `roomGraph`/IPC wrapper layer the Rust
 * `#[cfg(test)]` module never touches because it tests `build_room_graph`
 * directly, not the `#[tauri::command]` around it).
 *
 * ============================================================================
 * OVERLAP CHECK — this is NOT the same "graph" as `workflowModel.ts`/
 * `workflowEngine.ts`
 * ============================================================================
 * Both READ this batch's instructions as touching a "graph". They are
 * genuinely unrelated features that happen to share a common noun:
 *  - `workflowModel.ts`/`workflowEngine.ts` port `src-tauri/src/commands/
 *    jobs/workflow.rs` — an LLM-orchestrated multi-step job's DAG (nodes are
 *    generate/transform/branch/… STEPS, edges are execution order with
 *    conditions). Its own header calls this "the LLM graph workflow engine".
 *  - This file ports `src-tauri/src/commands/moonshot/graph.rs` — the ROOM's
 *    own similarity/relation map (nodes are FILES and MEMORIES the user
 *    already has, edges are six kinds of "how are these two related").
 * Confirmed no shared code either direction: `grep -n "RoomGraph\|GraphNode\|
 * GraphEdge\|EDGE_KINDS\|link_strength" workflowModel.ts workflowEngine.ts`
 * returns nothing, and the two Rust source files (`jobs/workflow.rs` vs
 * `moonshot/graph.rs`) never reference each other's types either. One design
 * ("workflow") did not supersede the other ("room graph") — both ship in the
 * current Rust tree and both are registered in `lib.rs`.
 *
 * ============================================================================
 * NOT MODEL-INVOCABLE
 * ============================================================================
 * `room_graph` takes no arguments and is registered ONLY in `lib.rs`'s
 * `tauri::generate_handler!` list, directly between `ensure_embed_model` and
 * `front_page` under the "Moonshot (Section D)" banner (lib.rs:364-368) — a
 * person's RoomMap viewer opening, not a tool a model calls. Grepped
 * `agent.rs`'s `exec_tool` match arms and this migration's own
 * `toolSpecs.ts`/`toolSchema.ts`/`execTool.ts`: `"room_graph"`/`"graph"`
 * appears in none of them (the one `toolSpecs.ts` hit is an unrelated
 * `create_workflow` tool description that uses the word "graph" to describe
 * ITS OWN node+edge shape — see the overlap check above). Nothing was added
 * to `execTool.ts`.
 *
 * ============================================================================
 * moonshotCmds.ts's OWN FINDINGS, AND ONE THING TO WATCH
 * ============================================================================
 * `moonshot.rs` (the top-level dispatcher, 129 lines) was read directly
 * rather than through a pre-existing `moonshotCmds.ts`, because at the start
 * of this task no port of it existed yet in this tree — `moonshotCmds.ts`,
 * `moonshotDiscovery.ts` and `moonshotRoles.ts` all landed (concurrently, a
 * few minutes apart, per their mtimes) from other batches WHILE this task was
 * in progress. `moonshotCmds.ts` is now the real port of `moonshot.rs` and
 * confirms what its own header says: it ports only `resolve_structured_model`/
 * `recommended_models`/`ensure_embed_model` — none of `graph.rs`'s surface.
 * `graph.rs` never calls `resolve_structured_model` (it does no model call at
 * all — pure DB reads), so this file needs nothing from `moonshotCmds.ts`.
 *
 * (An earlier revision of this comment claimed `resolveStructuredModel` had
 * been ported TWICE, in `moonshotCmds.ts` and again in
 * `moonshotFrontPage.ts`. That was already out of date when it was written:
 * `moonshotFrontPage.ts` IMPORTS `moonshotCmds.ts`'s copy, as do
 * `moonshotAiActions.ts` and this file's other siblings. There is exactly one
 * port of it, in `moonshotCmds.ts`. Do not "consolidate" a duplicate that
 * does not exist.)
 *
 * ============================================================================
 * WHY `GraphNode`/`GraphEdge`/`RoomGraph` ARE RE-DECLARED HERE, NOT IMPORTED
 * FROM `../shared/apiTypes.ts`
 * ============================================================================
 * `shared/apiTypes.ts` already declares all three (carried over verbatim from
 * the pre-migration frontend's `src/apiTypes.ts`), and this port's own house
 * style prefers reusing an already-correct shared type (`moonshotFrontPage.ts`
 * does exactly that for `FrontPage`). But `apiTypes.ts`'s `GraphNode` has
 * DRIFTED from the current Rust struct:
 *  - it carries an optional `summary?: string` field that current `graph.rs`
 *    does not have at all — `git log -p -- src-tauri/src/commands/moonshot/
 *    graph.rs` shows a `summary: Option<String>` field that existed in an
 *    earlier revision and was removed; the frontend type was never updated
 *    to match.
 *  - it types `folder` as bare-optional (`folder?: string`), which cannot
 *    represent what the Rust struct (`pub folder: Option<String>`, no
 *    `skip_serializing_if`) actually puts on the wire for a top-level file:
 *    an explicit `"folder": null`, not an omitted key.
 * Rather than reuse a type that would either reject a faithful `null` or
 * silently accept a `summary` this builder never produces, this file declares
 * its own field-for-field mirror of the CURRENT struct — the same "local
 * mirror" convention `Memory`/`Folder`/`FileMeta`/etc. all follow in
 * `db-host/`, used here because for once `apiTypes.ts`'s copy is not the
 * genuinely-current one. `kind` is narrowed to the literal union the builder
 * actually emits (`apiTypes.ts` already does this too); `GraphEdge.kind`
 * stays a bare `string`, matching both Rust's own `pub kind: String` and
 * `apiTypes.ts`, since it is compared against {@link EDGE_KINDS} rather than
 * switched over.
 *
 * ============================================================================
 * DEPENDENCIES — ALL ALREADY REAL, INCLUDING ONE BUILT FOR THIS EXACT PORT
 * ============================================================================
 * Every `db::*` call `graph.rs` makes already has a real Electron port:
 * `listFolders`/`listFiles`/`derivedLinks`/`stripHebrewMarks` (`files.ts`,
 * `folders.ts`), `listMemories` (`memories.ts`), `blobToEmbedding`/
 * `cosineSimilarity`/`ftsFileMatches` (`embeddings.ts` — whose own doc comment
 * on `ftsFileMatches` is literally headed "Room map:", written in
 * anticipation of this port), `recentMessageSources` (`messages.ts`),
 * `ftsMatchExpr` (`retrieval.ts`), `clampWords` (`textClamp.ts`). The one raw
 * query `graph.rs` issues directly (`SELECT file_id, embedding, text FROM
 * chunks WHERE file_id IN (...)`, no `db::` wrapper of its own in Rust either)
 * is issued the same way here, via `db-host/util.ts`'s `queryRows`, following
 * `storyTools.ts`'s precedent for a commands-layer file that needs one custom
 * query alongside its `db-host` calls.
 *
 * `STOPWORDS`/`NOT_ALPHANUMERIC` (`db-host/retrieval.ts`) were WIDENED from
 * module-private to exported by this batch — a two-line, purely-additive
 * change (re-run `retrieval.test.ts` after: unaffected) — because
 * `index_terms` (this file) and `question_terms` (`retrieval.ts`) are, in
 * Rust, the exact same shared `pub(crate) const STOPWORDS` via `use
 * super::*`; duplicating a ~50-entry list here would be exactly the
 * driftable copy this migration's other modules (`messages.ts`'s
 * `searchTerms`/`likeAllClause`, reused rather than re-spelled by
 * `memories.ts`) avoid on principle.
 *
 * `isSummaryFile`/`SUMMARY_FILE_NAME` are duplicated a SECOND time (after
 * `moonshotFrontPage.ts`'s own copy) rather than imported, for the identical
 * reason that file's header states: `summarize.rs` has no Electron port yet,
 * the predicate is two string comparisons and an `&&`, and importing from a
 * sibling "moonshot" file for a helper neither file owns would just move the
 * duplication sideways. When `summarize.rs` lands for real, BOTH copies
 * should be deleted in favor of importing it.
 *
 * ============================================================================
 * `RoomSource` — the MOONSHOT FAMILY'S shape, from `moonshotCmds.ts`
 * ============================================================================
 * Two shapes for "read the currently open room" exist in this codebase:
 * `recIpc.ts`/`turnEngine.ts`/`moonshotCmds.ts` declare
 * `{ currentRoom(): OpenRoom | null }`, while `jobs.ts` declares
 * `{ current(): RoomHandle | null }` (reused by `feedbackTools.ts` and the
 * job runners). This file originally took `jobs.ts`'s, on the stated grounds
 * that `moonshotFrontPage.ts` — `room_graph`'s literal neighbour in `lib.rs`'s
 * handler list — had done the same. That was simply not true:
 * `moonshotFrontPage.ts` takes `moonshotCmds.ts`'s `currentRoom()`, and so do
 * `moonshotAiActions.ts` and `moonshotServer.ts`. The result was that a
 * bootstrap building ONE room object for the moonshot family could drive five
 * of the six files and hit `TypeError: rooms.current is not a function` on
 * this one. All six now take the same shape; the room object a host builds for
 * `front_page` drives `room_graph` unchanged.
 *
 * (`buildRoomGraph(db)` is the real work and takes a plain connection, so
 * anything holding a `Database.Database` — a `jobs.ts` runner included — can
 * still call it directly without a `RoomSource` at all.)
 *
 * ============================================================================
 * DEVIATIONS
 * ============================================================================
 *  - Rust's `Result<RoomGraph, String>` becomes a plain return value that
 *    throws, matching `db-host`'s established "errors, not `Result`"
 *    convention (`util.ts`'s own note): every `?` in `build_room_graph` only
 *    ever fails on a broken DB connection, which throws here exactly as
 *    `queryRows`/`queryOne` already throw for every other reader.
 *  - Every `HashMap`/`HashSet` keyed by ROOM- OR FILE-CONTROLLED text (TF-IDF
 *    terms out of a file's own words, URLs, hosts, file names) is a `Map`/
 *    `Set` here, never a plain `{}` object literal — this codebase has found
 *    the `"__proto__"`-as-a-key bug five times already (rule 2), and
 *    `index_terms` over an attacker-authored file's text is exactly the kind
 *    of room-controlled key that bug keeps recurring on. `index_of`,
 *    unambiguously UUID-keyed and therefore lower risk, is still a `Map` for
 *    the same reason `db-host/retrieval.ts`'s `pool` is: consistency costs
 *    nothing here and removes any doubt.
 *  - Pair keys (`pair_key` in Rust, returning a `(String, String)` tuple used
 *    as a `HashMap`/`HashSet` key) become a single joined string
 *    (`${lo} ${hi}`) for use as a `Map`/`Set` key — ` ` cannot
 *    appear in a UUID or in FTS-searched text, so this cannot collide.
 *  - `median`/`adaptive_floor`'s `HashMap<(usize, usize), (f32, bool)>` score
 *    cache becomes a `Map<string, [number, boolean]>` keyed by `"i,j"`
 *    (i < j) — same reasoning, indices are small non-negative integers so no
 *    ambiguity is possible.
 *
 * Per rule 4/`recIpc.ts`'s precedent, {@link registerRoomGraphIpc} is written
 * and tested directly but NOT wired into any bootstrap file. The channel name
 * (`"room_graph"`) is the Rust `#[tauri::command]` name `src/api.ts:1470`
 * already invokes, so a future renderer needs no rename.
 */

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

function edgeRank(kind: string): number {
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

const SUMMARY_FILE_NAME = "Room summary.html";

function isSummaryFile(name: string, source: string): boolean {
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
function indexTerms(text: string): string[] {
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
function tfidfCosine(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
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
function topSharedTerms(
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
function median(sortedDesc: readonly number[]): number {
  const n = sortedDesc.length;
  if (n === 0) {
    return 0;
  }
  if (n % 2 === 1) {
    return sortedDesc[Math.floor(n / 2)] as number;
  }
  return ((sortedDesc[n / 2 - 1] as number) + (sortedDesc[n / 2] as number)) / 2;
}

/** The bar a file's own candidates must clear, from that file's own score
 * spread. Returns `-Infinity` (i.e. no bar) when there are too few
 * candidates for a spread to mean anything — at n=2 a median-based cutoff
 * would reject the only pair a two-file room can have, every time. */
function adaptiveFloor(sortedDesc: readonly number[]): number {
  if (sortedDesc.length < 4) {
    return Number.NEGATIVE_INFINITY;
  }
  const med = median(sortedDesc);
  const devs = sortedDesc.map((s) => Math.abs(s - med));
  devs.sort((a, b) => b - a);
  return med + median(devs);
}

/** Unordered key for a pair of node ids, so the same relation found twice is
 * one edge. ` ` cannot appear in a UUID or in FTS-searched text, so this
 * cannot collide two distinct pairs onto one key. */
function pairKeyStr(a: string, b: string): string {
  return a <= b ? `${a} ${b}` : `${b} ${a}`;
}

/** Collects at most one edge per pair, keeping the most-trusted kind (then
 * the strongest). Two files that are BOTH a full pass of each other and
 * word-alike should read as "made from", not as two lines on top of each
 * other. */
class EdgeSet {
  private readonly byPair = new Map<string, GraphEdge>();

  offer(e: GraphEdge): void {
    if (e.a === e.b) {
      return;
    }
    const key = pairKeyStr(e.a, e.b);
    const cur = this.byPair.get(key);
    if (cur !== undefined) {
      const curRank = edgeRank(cur.kind);
      const newRank = edgeRank(e.kind);
      // Keep the current edge if it is at least as trusted, and — on a tied
      // rank — at least as strong.
      if (curRank < newRank || (curRank === newRank && cur.weight >= e.weight)) {
        return;
      }
    }
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
    out.sort((x, y) => {
      const rankDiff = edgeRank(x.kind) - edgeRank(y.kind);
      if (rankDiff !== 0) {
        return rankDiff;
      }
      if (y.weight !== x.weight) {
        return y.weight - x.weight;
      }
      if (x.a !== y.a) {
        return x.a < y.a ? -1 : 1;
      }
      if (x.b !== y.b) {
        return x.b < y.b ? -1 : 1;
      }
      return 0;
    });
    return out;
  }
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
function siteOf(url: string): string | null {
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
function starLinks(
  group: readonly number[],
  files: readonly GraphFile[],
  kind: string,
  weight: number,
  why: readonly string[]
): GraphEdge[] {
  if (group.length === 0) {
    return [];
  }
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

// ============================================================================
// The builder.
// ============================================================================

interface GraphFile {
  id: string;
  name: string;
  folder: string | null;
  originUrl: string | null;
  mean: number[] | null;
  /** L2-normalised TF-IDF weights over the file's most distinctive terms. */
  tfidf: Map<string, number>;
}

interface Acc {
  sum: number[];
  n: number;
  tf: Map<string, number>;
}

/**
 * D3: build the room's typed link graph from stored data ONLY — no model
 * call. Ported from `build_room_graph`.
 *
 * Six relations, five of which the room can PROVE (provenance, a shared
 * source URL, one document naming another, two documents cited by one
 * answer) and one inferred (`similar`). The inferred one is the only one
 * that is thresholded, and it is bounded by rank rather than by an absolute
 * similarity, because a single global cutoff over mean-pooled document
 * vectors admits every pair in the room. Nothing here invents a relation to
 * make the picture look connected: a file the room knows nothing about
 * stays a lone star.
 *
 * Pure over the connection → unit-testable with a real fixture room.
 */
export function buildRoomGraph(db: Database.Database): RoomGraph {
  const folders = new Map<string, string>();
  for (const f of listFolders(db)) {
    folders.set(f.id, f.name);
  }

  // Newest files first; cap for the pairwise pass. Skip the app's own
  // summary.
  const metas: FileMeta[] = listFiles(db)
    .filter((f) => !isSummaryFile(f.name, f.source))
    .slice(0, GRAPH_MAX_FILES);

  // One pass over chunks: a summed embedding + a term-frequency map per
  // file.
  const acc = new Map<string, Acc>();
  if (metas.length > 0) {
    // ONLY the files the map will draw — reading every chunk in the room
    // made the map's open time scale with the whole room instead of with
    // the (at most GRAPH_MAX_FILES) nodes on it.
    const placeholders = metas.map(() => "?").join(",");
    const rows = queryRows(
      db,
      `SELECT file_id, embedding, text FROM chunks WHERE file_id IN (${placeholders})`,
      metas.map((m) => m.id),
      (r): [string, Buffer | null, string] => [
        r[0] as string,
        r[1] as Buffer | null,
        r[2] as string,
      ]
    );
    for (const [fileId, emb, text] of rows) {
      let entry = acc.get(fileId);
      if (entry === undefined) {
        entry = { sum: [], n: 0, tf: new Map() };
        acc.set(fileId, entry);
      }
      if (emb !== null) {
        const vec = blobToEmbedding(emb);
        if (vec !== null) {
          if (entry.sum.length === 0) {
            entry.sum = vec;
            entry.n += 1;
          } else if (entry.sum.length === vec.length) {
            for (let k = 0; k < entry.sum.length; k++) {
              entry.sum[k] = (entry.sum[k] as number) + (vec[k] as number);
            }
            entry.n += 1;
          }
        }
      }
      for (const term of indexTerms(text)) {
        // A book's vocabulary is bounded in practice; the cap is only here
        // so a pathological file can't grow this map without end.
        if (entry.tf.size < 20_000 || entry.tf.has(term)) {
          entry.tf.set(term, (entry.tf.get(term) ?? 0) + 1);
        }
      }
    }
  }

  // Document frequency over the mapped files — the room's own word
  // statistics. Used twice: to weight the TF-IDF vectors, and to decide
  // whether a file's NAME is distinctive enough to be worth searching the
  // room's text for.
  const nDocs = Math.max(metas.length, 1);
  const df = new Map<string, number>();
  for (const a of acc.values()) {
    for (const term of a.tf.keys()) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  // Per-file records: mean embedding (if any) + a normalised TF-IDF vector.
  const files: GraphFile[] = metas.map((m) => {
    const a = acc.get(m.id);
    let mean: number[] | null = null;
    if (a !== undefined && a.n > 0 && a.sum.length > 0) {
      mean = a.sum.map((x) => x / a.n);
    }
    let weighted: Array<[string, number]> = [];
    if (a !== undefined) {
      for (const [t, tf] of a.tf) {
        const idf = Math.log(nDocs / (df.get(t) ?? 1)) + 1;
        weighted.push([t, (1 + Math.log(tf)) * idf]);
      }
    }
    weighted.sort((x, y) => (y[1] !== x[1] ? y[1] - x[1] : x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    weighted = weighted.slice(0, GRAPH_TFIDF_TERMS);
    const norm = Math.sqrt(weighted.reduce((s, [, w]) => s + w * w, 0));
    const tfidf = new Map<string, number>();
    if (norm > 0) {
      for (const [t, w] of weighted) {
        tfidf.set(t, w / norm);
      }
    }
    return {
      id: m.id,
      name: m.name,
      folder: m.folderId !== null ? (folders.get(m.folderId) ?? null) : null,
      originUrl: m.originUrl,
      mean,
      tfidf,
    };
  });

  const indexOfId = new Map<string, number>();
  files.forEach((f, i) => indexOfId.set(f.id, i));

  // Nodes: files (with folder) then memories.
  const memories = listMemories(db);
  const nodes: GraphNode[] = files.map((f) => ({
    id: f.id,
    name: f.name,
    folder: f.folder,
    kind: "file",
  }));
  for (const m of memories.slice(0, GRAPH_MAX_FILES)) {
    nodes.push({
      id: `mem:${m.id}`,
      name: clampWords(m.content, 60),
      folder: null,
      kind: "memory",
    });
  }

  const edges = new EdgeSet();

  // ---- 1. `derived`: the room watched this file being made from that one --
  for (const [src, out] of derivedLinks(db)) {
    if (indexOfId.has(src) && indexOfId.has(out)) {
      edges.offer({ a: src, b: out, weight: 1.0, kind: EDGE_DERIVED, directed: true, shared: [] });
    }
  }

  // ---- 2. `same_page` / `same_site`: a shared web origin -----------------
  // Exact-URL groups first (the browser saves a page as an .md and an .html
  // sharing one origin_url — the twin every reader expects to see joined).
  const byUrl = new Map<string, number[]>();
  const bySite = new Map<string, number[]>();
  files.forEach((f, i) => {
    const url = f.originUrl?.trim();
    if (url === undefined || url === "") {
      return;
    }
    let urlGroup = byUrl.get(url);
    if (urlGroup === undefined) {
      urlGroup = [];
      byUrl.set(url, urlGroup);
    }
    urlGroup.push(i);
    const site = siteOf(url);
    if (site !== null) {
      let siteGroup = bySite.get(site);
      if (siteGroup === undefined) {
        siteGroup = [];
        bySite.set(site, siteGroup);
      }
      siteGroup.push(i);
    }
  });
  for (const url of [...byUrl.keys()].sort()) {
    const group = byUrl.get(url) as number[];
    if (group.length < 2) {
      continue;
    }
    for (const e of starLinks(group, files, EDGE_SAME_PAGE, 1.0, [url])) {
      edges.offer(e);
    }
  }
  for (const site of [...bySite.keys()].sort()) {
    const group = bySite.get(site) as number[];
    // Past the cap a host is a scrape, and linking it says nothing about
    // any two of its pages. Nothing is drawn rather than something false.
    if (group.length < 2 || group.length > GRAPH_SITE_GROUP_MAX) {
      continue;
    }
    for (const e of starLinks(group, files, EDGE_SAME_SITE, 0.45, [site])) {
      edges.offer(e);
    }
  }

  // ---- 3. `mentions`: one document names another --------------------------
  // Bounded three ways — a name must be long enough, its rarest word must be
  // rare in THIS room, and only the best few matches per name are kept.
  const dfCap = Math.max(Math.round(nDocs * GRAPH_MENTION_DF_RATIO), 1);
  const isDistinctive = (tokens: readonly string[]): boolean => {
    if (tokens.length === 0) {
      return false;
    }
    let min = Number.POSITIVE_INFINITY;
    for (const t of tokens) {
      const d = df.get(t) ?? 0;
      if (d < min) {
        min = d;
      }
    }
    return min <= dfCap;
  };
  for (const f of files) {
    const stem = nameStem(f.name);
    if (Array.from(stem).length < GRAPH_MENTION_MIN_STEM) {
      continue;
    }
    const tokens = indexTerms(stem);
    if (!isDistinctive(tokens)) {
      continue;
    }
    // ONE quoted item, which FTS5 reads as a phrase. Passing the stem's
    // words separately would OR them and match anything.
    const expr = ftsMatchExpr([stem.toLowerCase()]);
    if (expr === null) {
      continue;
    }
    for (const hit of ftsFileMatches(db, expr, f.id, GRAPH_MENTION_TOP)) {
      if (indexOfId.has(hit)) {
        edges.offer({
          a: hit,
          b: f.id,
          weight: 0.8,
          kind: EDGE_MENTIONS,
          directed: true,
          shared: [stem],
        });
      }
    }
  }
  // Memories were decorative before this: nodes with no edge, ever. A memory
  // whose distinctive words appear in a file is a real, checkable relation —
  // and one with no distinctive word stays unlinked.
  for (const m of memories.slice(0, GRAPH_MAX_FILES)) {
    let terms = [...new Set(indexTerms(m.content))];
    terms = terms.filter((t) => {
      const d = df.get(t);
      return d !== undefined && d >= 1 && d <= dfCap;
    });
    terms.sort((x, y) => {
      const dx = df.get(x) ?? 0;
      const dy = df.get(y) ?? 0;
      if (dx !== dy) {
        return dx - dy;
      }
      return x < y ? -1 : x > y ? 1 : 0;
    });
    terms = terms.slice(0, 2);
    if (terms.length === 0) {
      continue;
    }
    // AND, not OR: the memory has to share ALL of its rare words with the
    // file, or a one-line memory links to half the room.
    const expr = terms.map((t) => `"${t.replaceAll('"', "")}"`).join(" AND ");
    for (const hit of ftsFileMatches(db, expr, "", GRAPH_MENTION_TOP)) {
      if (indexOfId.has(hit)) {
        edges.offer({
          a: `mem:${m.id}`,
          b: hit,
          weight: 0.6,
          kind: EDGE_MENTIONS,
          directed: true,
          shared: [...terms],
        });
      }
    }
  }

  // ---- 4. `cited`: one answer used both files ------------------------------
  const byName = new Map<string, string>();
  for (const f of files) {
    if (!byName.has(f.name)) {
      byName.set(f.name, f.id);
    }
  }
  interface CiteEntry {
    a: string;
    b: string;
    count: number;
  }
  const citeCounts = new Map<string, CiteEntry>();
  for (const sources of recentMessageSources(db, 500)) {
    const resolved = sources
      .map((n) => byName.get(n))
      .filter((id): id is string => id !== undefined);
    const ids = [...new Set(resolved)].sort();
    if (ids.length < 2 || ids.length > GRAPH_CITED_MAX_SOURCES) {
      continue;
    }
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i] as string;
        const b = ids[j] as string;
        const key = pairKeyStr(a, b);
        const entry = citeCounts.get(key);
        if (entry !== undefined) {
          entry.count += 1;
        } else {
          citeCounts.set(key, { a, b, count: 1 });
        }
      }
    }
  }
  // Union top-K per file, by how often the pair was cited: the same
  // rank-based bound `similar` and `mentions` get.
  const partners = new Map<string, Array<[string, number]>>();
  const pushPartner = (owner: string, other: string, count: number): void => {
    let arr = partners.get(owner);
    if (arr === undefined) {
      arr = [];
      partners.set(owner, arr);
    }
    arr.push([other, count]);
  };
  for (const { a, b, count } of citeCounts.values()) {
    pushPartner(a, b, count);
    pushPartner(b, a, count);
  }
  const kept = new Set<string>();
  for (const owner of [...partners.keys()].sort()) {
    const list = [...(partners.get(owner) as Array<[string, number]>)];
    // Ties by partner id, never by insertion order — the payload has to be
    // byte-identical for an unchanged room.
    list.sort((x, y) => (y[1] !== x[1] ? y[1] - x[1] : x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    for (const [other] of list.slice(0, GRAPH_CITED_TOP)) {
      kept.add(pairKeyStr(owner, other));
    }
  }
  for (const { a, b, count } of citeCounts.values()) {
    if (!kept.has(pairKeyStr(a, b))) {
      continue;
    }
    edges.offer({
      a,
      b,
      weight: Math.min(0.5 + 0.15 * Math.log1p(count), 0.9),
      kind: EDGE_CITED,
      directed: false,
      shared: [`cited together in ${count} answer${count === 1 ? "" : "s"}`],
    });
  }

  // ---- 5. `similar`: the one inferred relation, rank-bounded --------------
  // Score every pair once. A pair where both ends have embeddings is scored
  // by cosine; otherwise by TF-IDF overlap, so a freshly-imported room still
  // shows links instead of isolated dots while the backfill runs.
  const n = files.length;
  const scores = new Map<string, [number, boolean]>();
  const scoreKey = (i: number, j: number): string => (i < j ? `${i},${j}` : `${j},${i}`);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const fi = files[i] as GraphFile;
      const fj = files[j] as GraphFile;
      const entry: [number, boolean] =
        fi.mean !== null && fj.mean !== null
          ? [cosineSimilarity(fi.mean, fj.mean), true]
          : [tfidfCosine(fi.tfidf, fj.tfidf), false];
      scores.set(scoreKey(i, j), entry);
    }
  }
  const scoreOf = (i: number, j: number): [number, boolean] => scores.get(scoreKey(i, j)) ?? [0, false];
  const floorFor = (vector: boolean): number => (vector ? GRAPH_VEC_FLOOR : GRAPH_KW_FLOOR);

  // Each file proposes its own top-K, per signal (a room mid-backfill has
  // both). An edge survives if EITHER end proposed it.
  const proposed = new Set<string>();
  for (let i = 0; i < n; i++) {
    for (const vector of [true, false]) {
      const cands: Array<[number, number]> = [];
      for (let j = 0; j < n; j++) {
        if (j === i) {
          continue;
        }
        const [raw, isVec] = scoreOf(i, j);
        if (isVec === vector && raw >= floorFor(vector)) {
          cands.push([j, raw]);
        }
      }
      if (cands.length === 0) {
        continue;
      }
      // Deterministic: ties resolved by index, never by insertion order.
      cands.sort((x, y) => (y[1] !== x[1] ? y[1] - x[1] : x[0] - y[0]));
      const sorted = cands.map((c) => c[1]);
      const bar = adaptiveFloor(sorted);
      for (const [j, raw] of cands.slice(0, GRAPH_SIM_TOP_K)) {
        if (raw >= bar) {
          proposed.add(scoreKey(i, j));
        }
      }
    }
  }
  const sim: Array<[number, number, number, boolean]> = [];
  for (const key of proposed) {
    const [iStr, jStr] = key.split(",");
    const i = Number(iStr);
    const j = Number(jStr);
    const [raw, isVec] = scoreOf(i, j);
    sim.push([i, j, raw, isVec]);
  }
  sim.sort((x, y) => {
    if (y[2] !== x[2]) {
      return y[2] - x[2];
    }
    if (x[0] !== y[0]) {
      return x[0] - y[0];
    }
    return x[1] - y[1];
  });
  const simCapped = sim.slice(0, n * GRAPH_SIM_MAX_PER_NODE);
  for (const [i, j, raw, isVec] of simCapped) {
    const fi = files[i] as GraphFile;
    const fj = files[j] as GraphFile;
    edges.offer({
      a: fi.id,
      b: fj.id,
      weight: linkStrength(raw, floorFor(isVec)),
      kind: EDGE_SIMILAR,
      directed: false,
      shared: topSharedTerms(fi.tfidf, fj.tfidf, 3),
    });
  }

  // ---- 6. rescue the isolates ---------------------------------------------
  // Sparsifying by rank can leave a file with no edge at all even though it
  // has a decent partner. Give each isolate its single best partner, and
  // ONLY if that partner clears the same absolute floor every other link had
  // to: a file the room has nothing to say about stays a lone star.
  const isolated: number[] = [];
  for (let i = 0; i < n; i++) {
    const fi = files[i] as GraphFile;
    let hasEdge = false;
    for (let j = 0; j < n; j++) {
      if (j === i) {
        continue;
      }
      const fj = files[j] as GraphFile;
      if (edges.contains(fi.id, fj.id)) {
        hasEdge = true;
        break;
      }
    }
    if (!hasEdge) {
      isolated.push(i);
    }
  }
  for (const i of isolated) {
    // Highest raw score wins; on a tie the SMALLER index wins (the newer
    // file, since `files` is newest-first) — the direct translation of
    // Rust's `max_by(...then_with(|| y.0.cmp(&x.0)))` tie-break.
    let best: [number, number, boolean] | null = null;
    for (let j = 0; j < n; j++) {
      if (j === i) {
        continue;
      }
      const [raw, isVec] = scoreOf(i, j);
      if (raw < floorFor(isVec)) {
        continue;
      }
      if (best === null || raw > best[1] || (raw === best[1] && j < best[0])) {
        best = [j, raw, isVec];
      }
    }
    if (best !== null) {
      const [j, raw, isVec] = best;
      const fi = files[i] as GraphFile;
      const fj = files[j] as GraphFile;
      edges.offer({
        a: fi.id,
        b: fj.id,
        weight: linkStrength(raw, floorFor(isVec)),
        kind: EDGE_SIMILAR,
        directed: false,
        shared: topSharedTerms(fi.tfidf, fj.tfidf, 3),
      });
    }
  }

  return { nodes, edges: edges.intoSorted() };
}

// ============================================================================
// D3: the `#[tauri::command]` wrapper.
// ============================================================================

/** D3: the room's link graph for the RoomMap viewer. Ported from
 * `room_graph`. Empty when no room is open (never an error the UI has to
 * special-case) — same posture as `moonshotFrontPage.ts`'s `frontPage` for
 * its sibling command. */
export function roomGraph(rooms: RoomSource): RoomGraph {
  const room = rooms.currentRoom();
  if (room === null) {
    return { nodes: [], edges: [] };
  }
  return buildRoomGraph(room.db);
}

// ============================================================================
// IPC — written, NOT wired into any bootstrap file (rule 4).
// ============================================================================

/** Register the `room_graph` channel on `ipcMain`. NOT wired into any
 * bootstrap file — ready for a future preload/renderer batch, same
 * convention as `registerFrontPageIpc`/`registerRecIpc`. */
export function registerRoomGraphIpc(ipcMain: Pick<IpcMain, "handle">, rooms: RoomSource): void {
  ipcMain.handle("room_graph", (_event: IpcMainInvokeEvent) => roomGraph(rooms));
}
