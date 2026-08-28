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

import { foldEditChar } from "./editMatchExtraction.js";

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

/** Ported verbatim from `edit_match::normalize_with_spans`. */
export function normalizeWithSpans(text: string): NormText {
  const chars: string[] = [];
  const spans: Span[] = [];
  // Pending whitespace run: start, end (exclusive) and newline count.
  let wsStart = -1;
  let wsEnd = -1;
  let wsNewlines = 0;
  const flushWs = (): void => {
    if (wsStart !== -1) {
      chars.push(wsNewlines >= 2 ? PARA_SENTINEL : " ");
      spans.push([wsStart, wsEnd]);
      wsStart = -1;
      wsEnd = -1;
      wsNewlines = 0;
    }
  };
  let i = 0;
  for (const c of text) {
    const end = i + c.length;
    const fold = foldEditChar(c);
    switch (fold.kind) {
      case "space": {
        const nl = c === "\n" ? 1 : 0;
        if (wsStart === -1) {
          wsStart = i;
          wsEnd = end;
          wsNewlines = nl;
        } else {
          wsEnd = end;
          wsNewlines += nl;
        }
        break;
      }
      case "drop":
        break;
      case "char":
        flushWs();
        chars.push(fold.c);
        spans.push([i, end]);
        break;
      case "pair":
        flushWs();
        // Both halves map back to the SAME source char span.
        chars.push(fold.a);
        spans.push([i, end]);
        chars.push(fold.b);
        spans.push([i, end]);
        break;
    }
    i = end;
  }
  flushWs();
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
export function normalizeNeedle(s: string): string[] {
  const out: string[] = [];
  let pendingSpace = false;
  for (const c of s) {
    const fold = foldEditChar(c);
    switch (fold.kind) {
      case "space":
        pendingSpace = out.length > 0;
        break;
      case "drop":
        break;
      case "char":
        if (pendingSpace) {
          out.push(" ");
          pendingSpace = false;
        }
        out.push(fold.c);
        break;
      case "pair":
        if (pendingSpace) {
          out.push(" ");
          pendingSpace = false;
        }
        out.push(fold.a);
        out.push(fold.b);
        break;
    }
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

/**
 * Scan `content` for `oldText` tolerant of the fold table, requiring a UNIQUE
 * hit. Counts NON-OVERLAPPING matches (the same advance discipline as the
 * docx/HTML `find_sub`), so its uniqueness verdict matches what
 * `content.matches(old_text).count()` would report for an exact quote.
 * Ported verbatim from `edit_match::fuzzy_find`.
 */
export function fuzzyFind(content: string, oldText: string): FuzzyFind {
  const needle = normalizeNeedle(oldText);
  if (needle.length === 0) {
    return NOT_FOUND;
  }
  const hay = normalizeWithSpans(content);
  const h = hay.chars;
  const n = needle.length;
  if (h.length < n) {
    return NOT_FOUND;
  }
  let first = -1;
  let count = 0;
  let i = 0;
  while (i + n <= h.length) {
    if (sliceEquals(h, i, needle) && !splitsALigature(hay.spans, i, i + n - 1)) {
      count += 1;
      if (first === -1) {
        first = i;
      }
      i += n; // non-overlapping
    } else {
      i += 1;
    }
  }
  if (count === 1 && first !== -1) {
    return { kind: "unique", start: hay.spans[first]![0], end: hay.spans[first + n - 1]![1] };
  }
  if (count === 0) {
    return NOT_FOUND;
  }
  return { kind: "ambiguous", count };
}
