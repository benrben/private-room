/**
 * The RAG context-gathering core: markup stripping, question-term extraction,
 * FTS5 match-expression construction, the keyword/vector blended retrieval
 * (`retrieveContext` / `retrieveContextExcluding` / `retrieveContextLimited`),
 * snippet extraction, chat-history compaction and memory selection. Ported
 * from `src-tauri/src/commands/retrieval.rs`.
 *
 * REUSES PART A's `embeddings.ts` for the whole vector half —
 * `forEachChunkEmbedding` (the streaming (rowid, blob) scan),
 * `cosineSimilarityBlob` (scoring off the borrowed bytes, no decode),
 * `chunksByRowids` (hydrating only the winners), `searchChunksFtsRanked` and
 * `recentChunks`. None of that is reimplemented here; this file only POOLS
 * and RANKS what those return. Per `embeddings.ts`'s own header the on-disk
 * f32 format is byte-exact while the cosine arithmetic accumulates in JS
 * doubles — a divergence far below anything a ranking or the 0.55 floor
 * notices.
 *
 * REUSES `files.ts`'s `stripHebrewMarks` for the question side of a search
 * (`questionTerms`), so a pointed query and the already-stripped indexed text
 * agree on what "the same word" is.
 *
 * BORROWED CONSTANTS: `MAX_CONTEXT_CHUNKS` (6) and `RETRIEVE_CANDIDATES`
 * (6 * 4) are declared in `commands.rs`, not `retrieval.rs` — but
 * `retrieval.rs` uses both directly and `commands.rs` has no port yet. Their
 * values are copied verbatim rather than invented, and re-exported here so
 * the eventual `commands.ts` can take them from one place.
 *
 * BYTE- VS. CHARACTER-BUDGETING is load-bearing and ASYMMETRIC in the Rust
 * source, deliberately preserved rather than "tidied":
 *   - `compact_history`'s budget counts `String::len()` — UTF-8 BYTES — so
 *     {@link compactHistory} measures and cuts through a `Buffer`, on real
 *     UTF-8 boundaries, via a JS port of Rust's `floor_boundary`.
 *   - `select_memories`' budget counts `chars().count()` — CODE POINTS —
 *     because CHG-8 fixed exactly that byte/char confusion there (a Hebrew
 *     note cost double what the same note cost in English, in a room where
 *     Hebrew is first-class) and did NOT touch history. So
 *     {@link selectMemories} counts `Array.from(m).length`.
 *   - `question_terms`' `word.len() >= 2` is likewise BYTES, which is why
 *     {@link questionTerms} measures `Buffer.byteLength`: a single Hebrew or
 *     CJK letter is already 2-3 UTF-8 bytes and survives that filter in the
 *     Rust build, while `.length` (UTF-16 units) would call it 1 and drop it.
 *
 * NOT PORTED (out of scope for this batch): `backfill.rs` (`embed_question`,
 * `spawn_reextract_backfill` — Tauri/Ollama orchestration, not DB query
 * logic) and everything under retrieval.rs's "chat commands" heading (the
 * `#name`/`@name` pipeline, which calls into these functions but is not
 * itself part of the query layer).
 */

import type Database from "better-sqlite3-multiple-ciphers";
import {
  chunksByRowids,
  cosineSimilarityBlob,
  forEachChunkEmbedding,
  recentChunks,
  searchChunksFtsRanked,
} from "./embeddings.js";
import { stripHebrewMarks } from "./files.js";

// ------------------------------------------------------------- constants

/** `commands.rs`'s own constant — the chunk cap a normal (non-#find)
 * question's context is built from. */
export const MAX_CONTEXT_CHUNKS = 6;

/** `commands.rs`'s own constant: `MAX_CONTEXT_CHUNKS * 4` — widen the
 * per-signal candidate pool before RRF blending so a strong vector-only
 * (synonym) chunk can surface above weak keyword hits. */
export const RETRIEVE_CANDIDATES = MAX_CONTEXT_CHUNKS * 4;

/**
 * How close a chunk's vector has to be to the question's before it counts as
 * a match at all.
 *
 * Measured on the embed model this app actually runs (nomic-embed-text with
 * the `search_query:`/`search_document:` prefixes, 2026-08-16): a question
 * nothing in the room answers ("asdf qwerty", "kzzzt vorplex") scores
 * 0.32-0.49 against EVERY chunk, while a real paraphrase of a chunk scores
 * 0.64-0.83. Any positive cosine used to pool a chunk, so once the backfill
 * had run no question could ever be reported as unanswered: the six chunks
 * with the highest cosine came back under a header calling them context from
 * the room, when all that distinguished them was being least-unrelated. A
 * FLOOR, not "any positive value".
 */
export const MIN_CHUNK_SIMILARITY = 0.55;

/** How many vector candidates one question may carry into hydration.
 *
 * `chunksByRowids` binds one SQL variable per rowid and SQLite binds at most
 * 32,766 of them, so an unlimited request (`limit: null`) over a room with
 * more embedded chunks than that failed the whole query rather than answering
 * it. Far above anything a caller displays, and far below the bind limit. */
export const MAX_VECTOR_CANDIDATES = 2_000;

/** RRF damping constant; standard value. */
const RRF_K = 60;

export interface ScoredChunk {
  rowid: number;
  fileName: string;
  text: string;
  score: number;
}

// ---------------------------------------------------------- markup / terms

/** Remove fenced UI-markup payloads (```boxes, ```annotation) from message
 * content — they are viewer data, not conversation text. */
export function stripMarkupBlocks(content: string): string {
  let out = content;
  for (const tag of ["```boxes", "```annotation"]) {
    let start = out.indexOf(tag);
    while (start !== -1) {
      const after = out.slice(start + tag.length);
      const end = after.indexOf("```");
      out = (end !== -1 ? out.slice(0, start) + after.slice(end + 3) : out.slice(0, start)).trim();
      start = out.indexOf(tag);
    }
  }
  return out;
}

/** CHG-14: include common 2-letter function words so the >=2 length filter
 * can admit high-signal short terms (AI, EU, Q2, IP) without letting these
 * through.
 *
 * Exported (Rust's `retrieval.rs::STOPWORDS` is `pub(crate)`, reused by
 * `moonshot/graph.rs::index_terms` via `use super::*` — this is the same
 * crate-wide sharing, not a new seam) so {@link ../moonshotGraph.js}'s own
 * `indexTerms` filters against the identical list rather than a second,
 * driftable copy. */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "is", "to", "of", "in", "on", "at", "it", "be", "as", "by", "an", "or", "if", "we", "do",
  "so", "up", "my", "me", "no", "us", "am", "he",
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was", "one", "our",
  "out", "get", "has", "him", "his", "how", "new", "now", "see", "two", "way", "who", "did",
  "its", "let", "say", "she", "too", "use", "that", "with", "have", "this", "will", "your",
  "from", "they", "know", "want", "been", "good", "much", "some", "time", "what", "when",
  "which", "about", "would", "there", "their", "were", "them", "then", "than", "into", "also",
  "just", "like", "over", "such", "only", "most", "make", "after", "where", "does", "please",
  "could", "should", "tell",
]);

/** UTF-8 byte length — what Rust's `str::len()` measures, and therefore what
 * `question_terms`' `>= 2` filter and `compact_history`'s budget both count.
 * See the module comment. */
function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Rust splits the question on `!c.is_alphanumeric()`, which is
 * `is_alphabetic() || is_numeric()` — the derived ALPHABETIC property plus
 * general categories Nd/Nl/No. `\p{Alphabetic}` + `\p{N}` is that set exactly.
 *
 * Not `\p{L}`, which is the near-miss: `\p{L}` omits Other_Alphabetic
 * combining marks, so a Devanagari word ("किताב") splits at every matra into
 * single-consonant fragments — one question term per letter, none of which
 * the index contains — where Rust keeps the word whole. (It also omits Hebrew
 * points, which matters less here only because {@link stripHebrewMarks} has
 * already removed those by the time this runs — exactly as the Rust source
 * does, and for the same reason.)
 *
 * Exported for the same reason as {@link STOPWORDS} above: `moonshot/graph.rs`'s
 * `index_terms` splits on this exact same `!c.is_alphanumeric()` predicate. */
export const NOT_ALPHANUMERIC = /[^\p{Alphabetic}\p{N}]+/u;

/**
 * The search terms in a question: Hebrew marks stripped first (a pasted
 * pointed query must match the consonantal index), lowercased, split on runs
 * of non-alphanumeric characters, de-duplicated, stopwords and words under
 * 2 BYTES dropped, capped at 24.
 */
export function questionTerms(question: string): string[] {
  const stripped = stripHebrewMarks(question);
  const words = stripped.toLowerCase().split(NOT_ALPHANUMERIC);
  const terms: string[] = [];
  for (const word of words) {
    // CHG-14: >=2 so short high-signal terms (AI, EU, Q2, IP) survive; the
    // 2-letter function words are filtered by STOPWORDS above.
    if (byteLen(word) >= 2 && !STOPWORDS.has(word) && !terms.includes(word)) {
      terms.push(word);
    }
    if (terms.length >= 24) {
      break;
    }
  }
  return terms;
}

/** Build an FTS5 MATCH expression from search terms: each term is
 * double-quoted (so punctuation or an FTS keyword like "or"/"near" is treated
 * as a literal) and the terms are OR-joined. `null` when there are no usable
 * terms. */
export function ftsMatchExpr(terms: Iterable<string>): string | null {
  const quoted: string[] = [];
  for (const t of terms) {
    // A quote inside a term would break out of the FTS string literal.
    const q = `"${t.replaceAll('"', "")}"`;
    if (q.length > 2) {
      // drop the empty `""` a fully-stripped term leaves
      quoted.push(q);
    }
  }
  return quoted.length === 0 ? null : quoted.join(" OR ");
}

// -------------------------------------------------------------- retrieval

/** HLT-3 + ADD-13: retrieve context by blending the FTS5 keyword score with
 * vector (cosine) similarity over stored chunk embeddings, then taking the
 * top {@link MAX_CONTEXT_CHUNKS}. `questionEmbedding` is the question's
 * vector; pass `null` to run the pure keyword path unchanged — when the embed
 * model is absent or no chunks are embedded yet, retrieval degrades cleanly
 * to keywords.
 *
 * Returns `[chunks, fallback]`: `fallback` is true when nothing matched and
 * recent content was padded in instead (CHG-10 — such filler must not be
 * credited as a "source"). */
export function retrieveContext(
  db: Database.Database,
  question: string,
  questionEmbedding: readonly number[] | null
): [ScoredChunk[], boolean] {
  return retrieveContextExcluding(db, question, questionEmbedding, new Set());
}

/** CHG-13 + CHG-15 + CHG-16: as {@link retrieveContext}, but excludes chunk
 * rowids in `exclude` (used by search_room to skip chunks already injected
 * into the prompt). Blends keyword and vector signals with Reciprocal Rank
 * Fusion — scale-free, no min-max degeneracy, no "vec=0 for a good keyword
 * hit". */
export function retrieveContextExcluding(
  db: Database.Database,
  question: string,
  questionEmbedding: readonly number[] | null,
  exclude: ReadonlySet<number>
): [ScoredChunk[], boolean] {
  return retrieveContextLimited(db, question, questionEmbedding, exclude, MAX_CONTEXT_CHUNKS);
}

interface Cand {
  fileName: string;
  text: string;
  kwRank: number | null;
  vecRank: number | null;
}

/**
 * As {@link retrieveContextExcluding}, but with the result count as a
 * parameter. `null` means every match, for callers that are SHOWING results
 * rather than spending a context window on them (#find): capping a search
 * result list at the six chunks a prompt can afford hides matches the user
 * came to see.
 *
 * The vector pass scores over (rowid, blob) only — no text shuttled, via
 * {@link forEachChunkEmbedding} + {@link cosineSimilarityBlob} — and hydrates
 * only the top candidates the keyword pass did not already provide (via
 * {@link chunksByRowids}), so a large room no longer allocates every chunk's
 * text per question.
 */
export function retrieveContextLimited(
  db: Database.Database,
  question: string,
  questionEmbedding: readonly number[] | null,
  exclude: ReadonlySet<number>,
  limit: number | null
): [ScoredChunk[], boolean] {
  // Rank enough candidates per signal to fill the requested result count; an
  // unlimited request pools everything the index can return, bounded by
  // MAX_VECTOR_CANDIDATES so hydration still fits SQLite's bind limit.
  const candidates =
    limit === null ? MAX_VECTOR_CANDIDATES : Math.max(limit * 4, RETRIEVE_CANDIDATES);

  const pool = new Map<number, Cand>();

  // Keyword signal: chunks ranked best-first by bm25 -> RRF rank.
  const expr = ftsMatchExpr(questionTerms(question));
  if (expr !== null) {
    const hits = searchChunksFtsRanked(db, expr, candidates);
    hits.forEach(([rowid, name, text], rank) => {
      let entry = pool.get(rowid);
      if (entry === undefined) {
        entry = { fileName: name, text, kwRank: null, vecRank: null };
        pool.set(rowid, entry);
      }
      entry.kwRank = rank;
    });
  }

  // Vector signal: brute-force cosine over (rowid, blob) — no text shuttled.
  // Pool only chunks AT OR ABOVE THE FLOOR, ranked by cosine -> RRF rank;
  // hydrate text for the winners not already present from the keyword pass.
  if (questionEmbedding !== null) {
    const scored: Array<[number, number]> = [];
    forEachChunkEmbedding(db, (rowid, blob) => {
      const cos = cosineSimilarityBlob(questionEmbedding, blob);
      // A floor, not "any positive cosine" — see MIN_CHUNK_SIMILARITY's doc:
      // every chunk scores somewhat above zero against any question, so
      // pooling on `> 0` meant a question the room cannot answer still came
      // back with its six least-unrelated chunks, presented as context.
      if (cos >= MIN_CHUNK_SIMILARITY) {
        scored.push([rowid, cos]);
      }
    });
    scored.sort((a, b) => b[1] - a[1]);
    const capped = scored.slice(0, candidates);
    const needText = capped.map(([rowid]) => rowid).filter((rowid) => !pool.has(rowid));
    const hydrated = new Map<number, [string, string]>();
    for (const [rowid, name, text] of chunksByRowids(db, needText)) {
      hydrated.set(rowid, [name, text]);
    }
    capped.forEach(([rowid], rank) => {
      const entry = pool.get(rowid);
      if (entry !== undefined) {
        entry.vecRank = rank;
      } else {
        const h = hydrated.get(rowid);
        if (h !== undefined) {
          pool.set(rowid, { fileName: h[0], text: h[1], kwRank: null, vecRank: rank });
        }
      }
    });
  }

  // A real match means the pool was populated by keyword or above-floor
  // cosine hits — gate the fallback on that (BEFORE any exclusion) so
  // no-match questions still fall back and CHG-10 keeps refusing to credit
  // filler as a source.
  if (pool.size > 0) {
    let ranked: ScoredChunk[] = [];
    for (const [rowid, c] of pool) {
      if (exclude.has(rowid)) {
        continue;
      }
      const rrf =
        (c.kwRank !== null ? 1 / (RRF_K + c.kwRank) : 0) +
        (c.vecRank !== null ? 1 / (RRF_K + c.vecRank) : 0);
      ranked.push({ rowid, fileName: c.fileName, text: c.text, score: rrf });
    }
    ranked.sort((a, b) => b.score - a.score);
    if (limit !== null) {
      ranked = ranked.slice(0, limit);
    }
    // Every RRF-pooled chunk scores > 0; empty only when exclusion removed
    // all of them — the caller distinguishes that from a true no-match.
    return [ranked, false];
  }

  // Generic questions ("summarize this") match nothing; fall back to the most
  // recently added content so the model still sees the room.
  const recent = recentChunks(db, limit ?? MAX_CONTEXT_CHUNKS).map(
    ([fileName, text]): ScoredChunk => ({ rowid: -1, fileName, text, score: 0 })
  );
  return [recent, true];
}

// ------------------------------------------------------------------- snippet

/** Greek final sigma: `String.prototype.toLowerCase` picks ς at a word end
 * (as Rust's `str::to_lowercase` does) while lowering one character at a time
 * always gives σ. Folding both sides to σ keeps the per-char-lowered haystack
 * interchangeable with the needle's own whole-string lowering. */
function fold(ch: string): string {
  return ch === "ς" ? "σ" : ch;
}

function foldString(s: string): string {
  return Array.from(s).map(fold).join("");
}

/** Rust's `str::split_whitespace()` semantics — `\p{White_Space}`, not `\s`;
 * see `messages.ts`'s own copy of this reasoning. */
function splitWhitespace(s: string): string[] {
  return s.split(/\p{White_Space}+/u).filter((t) => t !== "");
}

/** The last index `i` with `starts[i] <= at` — the TypeScript stand-in for
 * Rust's `starts.partition_point(|&s| s <= at).saturating_sub(1)`. `starts`
 * is strictly increasing (every char lowers to at least one unit), so a
 * binary search is exact. */
function lastIndexAtOrBefore(starts: readonly number[], at: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((starts[mid] as number) <= at) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return Math.max(0, lo - 1);
}

/**
 * ADD-6: extract a short snippet of `haystack` around the first occurrence of
 * `needle` (case-insensitive), with ellipses when clipped. Whitespace is
 * collapsed so multi-line file text reads as one line.
 *
 * The whole phrase is tried first; failing that, the most SELECTIVE word in
 * it. Word ORDER used to decide, so "the deposit" previewed the region around
 * "the" — in a lease that opens "The tenant shall…", the reader saw the first
 * sentence with "the" marked and never saw the word that made the file match.
 * {@link questionTerms} is the same stopword filter the search itself ranks
 * with; longest term first is the cheap stand-in for selectivity. Raw word
 * order still backstops it, so a query that is ALL stopwords ("the it")
 * centres exactly where it used to.
 *
 * Lowercasing is length-preserving in neither bytes NOR characters — Turkish
 * 'İ' (U+0130) lowercases to TWO characters — so an offset into the lowered
 * text says nothing about the original. `starts[i]` records where character
 * `i` landed in the lowered string, and a hit maps back through that. Counting
 * the characters of `lower[..hit]` instead (what the Rust source used to do)
 * drifts one per 'İ' and, once the drift passes `radius`, produces
 * `start > end` — a panic on any room holding a page of Turkish headings.
 */
export function makeSnippet(haystack: string, needle: string, radius: number): string {
  const normalized = splitWhitespace(haystack).join(" ");
  const chars = Array.from(normalized);
  let lower = "";
  const starts: number[] = [];
  for (const c of chars) {
    starts.push(lower.length);
    lower += foldString(c.toLowerCase());
  }
  const find = (n: string): number | null => {
    const folded = foldString(n.trim().toLowerCase());
    if (folded === "") {
      return null;
    }
    const idx = lower.indexOf(folded);
    return idx === -1 ? null : idx;
  };

  // `Array.prototype.sort` is stable (ES2019+), matching Rust's stable
  // `sort_by_key`, so equal-length terms keep question order.
  const selective = [...questionTerms(needle)].sort(
    (a, b) => Array.from(b).length - Array.from(a).length
  );

  let at = find(needle);
  if (at === null) {
    for (const t of selective) {
      at = find(t);
      if (at !== null) {
        break;
      }
    }
  }
  if (at === null) {
    for (const w of splitWhitespace(needle)) {
      at = find(w);
      if (at !== null) {
        break;
      }
    }
  }

  if (at === null) {
    // No match to centre on: a clipped preview from the start.
    let out = chars.slice(0, radius * 2).join("");
    if (chars.length > radius * 2) {
      out += "…";
    }
    return out;
  }

  const charPos = lastIndexAtOrBefore(starts, at);
  const start = Math.max(0, charPos - radius);
  const end = Math.min(charPos + radius, chars.length);
  let out = "";
  if (start > 0) {
    out += "…";
  }
  out += chars.slice(start, end).join("");
  if (end < chars.length) {
    out += "…";
  }
  return out;
}

// -------------------------------------------------------- history / memory

/** Largest UTF-8 BYTE index <= `max` that does not split a multi-byte
 * character — the `Buffer` equivalent of Rust's `floor_boundary`
 * (`commands/agent.rs`, itself a stable-Rust stand-in for the nightly
 * `str::floor_char_boundary`). A continuation byte matches `10xxxxxx`; back
 * up until landing on a byte that starts a character. */
function floorBoundary(buf: Buffer, max: number): number {
  if (max >= buf.length) {
    return buf.length;
  }
  let cut = max;
  while (cut > 0 && ((buf[cut] as number) & 0xc0) === 0x80) {
    cut -= 1;
  }
  return cut;
}

/**
 * CHG-8: compact chat history under a single BYTE budget (Rust's
 * `String::len()`, and the budget's own unit — `HISTORY_HANDOFF_MAX` is
 * documented in bytes). `history` is oldest-first. We walk newest-first,
 * keeping whole turns until the budget is spent (recency-weighted), and drop
 * older turns entirely instead of cutting each to a fixed head.
 *
 * A turn that alone exceeds the budget is cut at the last paragraph boundary
 * NEAR the limit — or at the limit itself when the nearest one is far behind
 * it — with an explicit omitted-marker, so the model never sees a silently
 * unterminated prior turn. "Near" matters: one blank line early in a long
 * turn ("Here's the summary:\n\n" above a list written with single newlines)
 * is the last "\n\n" before a cut 40 KB later, and cutting there kept 19
 * characters and threw the rest of the allowance away.
 */
export function compactHistory(
  history: ReadonlyArray<readonly [string, string]>,
  budget: number
): Array<[string, string]> {
  const kept: Array<[string, string]> = [];
  let remaining = budget;
  for (let i = history.length - 1; i >= 0; i--) {
    const [role, raw] = history[i] as readonly [string, string];
    // Viewer-markup payloads are UI data, not conversation.
    const content = stripMarkupBlocks(raw);
    if (content === "") {
      continue;
    }
    const buf = Buffer.from(content, "utf8");
    if (buf.length <= remaining) {
      remaining -= buf.length;
      kept.push([role, content]);
      continue;
    }
    // Doesn't fully fit. If there is room for a useful fragment of the newest
    // such turn, cut it at a paragraph boundary; otherwise stop.
    if (remaining < 400) {
      break;
    }
    const cut = floorBoundary(buf, Math.max(0, remaining - 40));
    const floor = cut - Math.floor(cut / 5);
    // The last "\n\n" wholly inside buf[0..cut) — i.e. starting at or before
    // `cut - 2`. Both bytes are ASCII, so a plain byte search is exact.
    let end = cut;
    if (cut >= 2) {
      const at = buf.lastIndexOf("\n\n", cut - 2);
      if (at !== -1 && at >= floor) {
        end = at;
      }
    }
    const piece = `${buf.subarray(0, end).toString("utf8")}\n… [rest of this message omitted]`;
    kept.push([role, piece]);
    break;
  }
  kept.reverse();
  return kept;
}

/**
 * CHG-7: choose which persistent memories to inject under a CHARACTER budget,
 * preferring ones whose text overlaps the question's keywords, then recency.
 * `memories` is oldest-first (listMemories order); returns the selected
 * memory strings in the order they should be shown.
 */
export function selectMemories(
  memories: readonly string[],
  question: string,
  budget: number
): string[] {
  const terms = questionTerms(question);
  // Score = overlapping keyword count; recency breaks ties (higher index —
  // later in the oldest-first input — is newer, and wins).
  const scored = memories.map((m, idx) => {
    const lower = m.toLowerCase();
    const hits = terms.filter((t) => lower.includes(t)).length;
    return { hits, idx, m };
  });
  scored.sort((a, b) => b.hits - a.hits || b.idx - a.idx);
  const out: string[] = [];
  let used = 0;
  for (const { m } of scored) {
    // CHARACTERS (code points via `Array.from`), matching the budget's own
    // name (`MAX_MEMORY_INJECT_CHARS`). This charged `m.len()` — BYTES — so a
    // note in Hebrew, Arabic, Greek or Cyrillic cost twice what the same note
    // costs in English, and a room written in one of them got half the memory
    // injected. Nothing about the budget's purpose is script-dependent; the
    // counting was.
    const cost = Array.from(m).length + 3; // "- " + "\n"
    if (used + cost > budget) {
      // CONTINUE, NOT BREAK, and a test is red on the difference: the list is
      // relevance-ordered, so skipping one note that will not fit to take a
      // later one that does spends budget that would otherwise sit empty.
      continue;
    }
    used += cost;
    out.push(m);
  }
  return out;
}
