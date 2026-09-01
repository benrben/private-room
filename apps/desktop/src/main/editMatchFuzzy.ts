/**
 * The typo-tolerant matching CORE behind `edit_file`/`edit_files`'s plain-text
 * fuzzy fallback — ported from the "normalization" section of
 * `src-tauri/src/commands/edit_match.rs` (`PARA_SENTINEL`, `NormText`,
 * `normalize_with_spans`, `normalize_needle`, `FuzzyFind`, `fuzzy_find`).
 * Kept in its own file, apart from the plan/batch orchestration in
 * `editMatch.ts`, so the matching ALGORITHM can be read, reviewed and tested
 * in isolation — mirroring the way the Rust source itself opens with this
 * section before anything else.
 *
 * ALGORITHM, in one paragraph. `old_text` is folded to a normalized character
 * list (whitespace collapsed to a single space, curly quotes/dashes/ligatures
 * folded to ASCII, zero-widths dropped — the ONE table in
 * `editMatchExtraction.ts`). The file's content is folded the SAME way,
 * EXCEPT a whitespace run spanning 2+ newlines becomes an UNMATCHABLE
 * sentinel: a fuzzy needle may never splice two paragraphs together. The
 * normalized needle is then hunted through the normalized haystack with a
 * non-overlapping left-to-right scan; a UNIQUE hit has its span mapped back
 * to a range in the ORIGINAL text so the caller can splice safely. Zero hits
 * is "not found"; two or more is "ambiguous" — this matcher NEVER guesses
 * which one the caller meant, and there is no scoring, no threshold and no
 * edit distance anywhere in it: the tolerance is EXACTLY the fold table, and
 * nothing else.
 *
 * POSITION UNITS. Rust's `String` is a UTF-8 byte sequence, so
 * `edit_match.rs`'s spans are BYTE ranges (`Range<usize>`, sliced with
 * `content[range]`/`replace_range`). A JS string is a UTF-16 code-unit
 * sequence, and slicing/splicing one is a code-unit operation throughout the
 * standard library. This port therefore tracks spans as CODE-UNIT ranges into
 * the original JS string — a deliberate, behavior-preserving adaptation (the
 * same one `textClamp.ts` documents), not a simplification: every span is
 * produced and consumed in the same unit within one call, so which occurrence
 * is found, whether it is unique, and what text is replaced are all
 * IDENTICAL to the Rust source. Iterating `for (const ch of text)` yields
 * whole code points (a surrogate pair together, exactly as Rust's
 * `char_indices()` yields one scalar value at a time), so an astral character
 * is never split mid-surrogate any more than Rust's version splits one
 * mid-UTF-8-byte.
 */

import { foldEditChar, type FoldOut } from "./editMatchExtraction.js";

/**
 * A collapsed whitespace run that spans a paragraph break (2+ newlines)
 * becomes this sentinel. It can never appear in a normalized NEEDLE (needle
 * whitespace always collapses to a plain space, and `foldEditChar` DROPS a
 * literal NUL), so a fuzzy needle can never match across a blank line —
 * mirroring the docx matcher's own `'\u{0}'` paragraph discipline. A
 * single-space needle silently splicing two paragraphs into one is exactly
 * the footgun that guard prevents.
 *
 * Built with `String.fromCharCode` rather than written as a literal: a raw
 * NUL in a source file is invisible to a reader and a hazard to every tool
 * that touches the file.
 */
const PARA_SENTINEL = String.fromCharCode(0);

/** A `[start, endExclusive)` range of code-unit positions in the original
 * string. */
export type Span = readonly [number, number];

/** The haystack, folded to comparison characters, each carrying the range in
 * the ORIGINAL text it came from — so a match's range slices the original
 * safely. Ported from `edit_match::NormText`. */
export interface NormText {
  readonly chars: readonly string[];
  readonly spans: readonly Span[];
}

function spanEq(a: Span, b: Span): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * Two neighbouring entries carrying the SAME source span are the two halves
 * of one ligature (a `pair` fold is the only producer that pushes a span
 * twice). A match that begins on the second half or ends on the first covers
 * half a character, and splicing its range would delete the other half — one
 * letter more than the quote asked for, reported as a clean single
 * replacement. Ported verbatim from `NormText::splits_a_ligature`.
 */
function splitsALigature(spans: readonly Span[], first: number, last: number): boolean {
  const beginsMid = first > 0 && spanEq(spans[first - 1]!, spans[first]!);
  const endsMid = last + 1 < spans.length && spanEq(spans[last]!, spans[last + 1]!);
  return beginsMid || endsMid;
}

interface PendingWhitespace {
  start: number;
  end: number;
  newlines: number;
}

function appendWhitespace(
  pending: PendingWhitespace | null,
  start: number,
  end: number,
  sourceChar: string,
): PendingWhitespace {
  const newlines = sourceChar === "\n" ? 1 : 0;
  if (pending === null) return { start, end, newlines };
  return { start: pending.start, end, newlines: pending.newlines + newlines };
}

function flushWhitespace(
  pending: PendingWhitespace | null,
  chars: string[],
  spans: Span[],
): null {
  if (pending !== null) {
    chars.push(pending.newlines >= 2 ? PARA_SENTINEL : " ");
    spans.push([pending.start, pending.end]);
  }
  return null;
}

function appendFoldedChar(chars: string[], spans: Span[], value: string, start: number, end: number): void {
  chars.push(value);
  spans.push([start, end]);
}

function appendFoldedPair(
  chars: string[],
  spans: Span[],
  first: string,
  second: string,
  start: number,
  end: number,
): void {
  appendFoldedChar(chars, spans, first, start, end);
  appendFoldedChar(chars, spans, second, start, end);
}

/** Ported verbatim from `edit_match::normalize_with_spans`. */
export function normalizeWithSpans(text: string): NormText {
  const chars: string[] = [];
  const spans: Span[] = [];
  // Pending whitespace run: start, end (exclusive) and newline count.
  let whitespace: PendingWhitespace | null = null;
  let i = 0;
  for (const c of text) {
    const end = i + c.length;
    const fold = foldEditChar(c);
    switch (fold.kind) {
      case "space":
        whitespace = appendWhitespace(whitespace, i, end, c);
        break;
      case "drop":
        break;
      case "char":
        whitespace = flushWhitespace(whitespace, chars, spans);
        appendFoldedChar(chars, spans, fold.c, i, end);
        break;
      case "pair":
        whitespace = flushWhitespace(whitespace, chars, spans);
        // Both halves map back to the SAME source char span.
        appendFoldedPair(chars, spans, fold.a, fold.b, i, end);
        break;
    }
    i = end;
  }
  flushWhitespace(whitespace, chars, spans);
  return { chars, spans };
}

/**
 * The needle folded to comparison characters, whitespace collapsed to single
 * spaces (never the paragraph sentinel) and trimmed of edge spaces. Ported
 * verbatim from `edit_match::normalize_needle` — its OWN lazy-pending-space
 * implementation, not `editMatchDocx.ts`'s `collapseWs` or
 * `editMatchHtml.ts`'s `foldNeedle`, which use an eager-push-then-trim shape.
 * The three are observationally identical; the Rust source keeps all three,
 * one per matcher, and so does this port.
 */
function emitPendingSpace(out: string[], pending: boolean): void {
  if (pending) out.push(" ");
}

function appendNeedleFold(out: string[], pending: boolean, fold: FoldOut): boolean {
  switch (fold.kind) {
    case "space":
      return out.length > 0;
    case "drop":
      return pending;
    case "char":
      emitPendingSpace(out, pending);
      out.push(fold.c);
      return false;
    case "pair":
      emitPendingSpace(out, pending);
      out.push(fold.a, fold.b);
      return false;
  }
}

export function normalizeNeedle(s: string): string[] {
  const out: string[] = [];
  let pendingSpace = false;
  for (const c of s) {
    pendingSpace = appendNeedleFold(out, pendingSpace, foldEditChar(c));
  }
  return out;
}

/** Result of hunting a typographically-drifted needle in the file's raw text.
 * Ported from `edit_match::FuzzyFind`. `unique`'s `start`/`end` is a
 * code-unit range (see the module doc), the JS analogue of Rust's byte
 * `Range<usize>`. */
export type FuzzyFind =
  /** Exactly one normalized occurrence — the range to rewrite. */
  | { readonly kind: "unique"; readonly start: number; readonly end: number }
  /** Multiple occurrences post-normalization — ambiguous, carries the count. */
  | { readonly kind: "ambiguous"; readonly count: number }
  /** No occurrence (or an empty needle). */
  | { readonly kind: "notFound" };

const NOT_FOUND: FuzzyFind = { kind: "notFound" };

function sliceEquals(hay: readonly string[], at: number, needle: readonly string[]): boolean {
  for (let k = 0; k < needle.length; k++) {
    if (hay[at + k] !== needle[k]) {
      return false;
    }
  }
  return true;
}

interface FuzzyMatchScan {
  first: number;
  count: number;
}

function matchesNeedleAt(hay: NormText, needle: readonly string[], at: number): boolean {
  return sliceEquals(hay.chars, at, needle) && !splitsALigature(hay.spans, at, at + needle.length - 1);
}

function scanMatches(hay: NormText, needle: readonly string[]): FuzzyMatchScan {
  let first = -1;
  let count = 0;
  let at = 0;
  while (at + needle.length <= hay.chars.length) {
    if (matchesNeedleAt(hay, needle, at)) {
      count += 1;
      if (first === -1) first = at;
      at += needle.length;
    } else {
      at += 1;
    }
  }
  return { first, count };
}

function fuzzyResult(hay: NormText, needle: readonly string[], scan: FuzzyMatchScan): FuzzyFind {
  if (scan.count === 0) return NOT_FOUND;
  if (scan.count !== 1 || scan.first === -1) return { kind: "ambiguous", count: scan.count };
  return {
    kind: "unique",
    start: hay.spans[scan.first]![0],
    end: hay.spans[scan.first + needle.length - 1]![1],
  };
}

/**
 * Scan `content` for `oldText` tolerant of the fold table, requiring a UNIQUE
 * hit. Counts NON-OVERLAPPING matches (the same advance discipline as the
 * docx/HTML `find_sub`), so its uniqueness verdict matches what
 * `content.matches(old_text).count()` would report for an exact quote.
 * Ported verbatim from `edit_match::fuzzy_find`.
 */
export function fuzzyFind(content: string, oldText: string): FuzzyFind {
  const needle = normalizeNeedle(oldText);
  if (needle.length === 0) return NOT_FOUND;
  const hay = normalizeWithSpans(content);
  if (hay.chars.length < needle.length) return NOT_FOUND;
  return fuzzyResult(hay, needle, scanMatches(hay, needle));
}
