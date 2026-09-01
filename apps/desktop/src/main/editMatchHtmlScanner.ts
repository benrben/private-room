/** Position-preserving scanner for matchable HTML text runs. */

import { asciiLower, isUnicodeWhitespace } from "./editMatchExtraction.js";


/** One matchable run of text between tags, with the range in the RAW markup
 * it decoded from. Never spans a tag; `<script>`/`<style>`/comment bodies and
 * tag interiors (including attribute values) never become a run. Ported from
 * `html_edit::HtmlTextRun`. */
export interface HtmlTextRun {
  /** Absolute `[start, end)` range in the source HTML this run occupies. */
  readonly span: readonly [number, number];
  /** Decoded characters (entities resolved). */
  readonly chars: readonly string[];
  /** Absolute range per char of `chars` — char i decoded from `charSpans[i]`
   * in the source. An entity like `&amp;` is one char mapping to a 5-unit
   * source range. */
  readonly charSpans: ReadonlyArray<readonly [number, number]>;
}

/** Tags whose CLOSE marks a boundary a match may never cross — moving between
 * block-level containers (paragraphs, headings, list items, table rows and
 * cells, lists) must never silently splice two block elements together.
 * Inline tags (`<b>`, `<i>`, `<span>`, `<a>`, `<em>`, `<strong>`, `<code>`,
 * and anything not in this list) get no boundary — a quote MAY span them.
 * Ported verbatim from `html_edit::BLOCK_CLOSE_TAGS`. */
const BLOCK_CLOSE_TAGS: ReadonlySet<string> = new Set([
  "p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "td", "th", "ul", "ol", "table",
  "blockquote", "section", "article", "header", "footer", "nav", "aside", "figure",
  "figcaption", "pre", "body", "html",
]);

/** Unmatchable separator between runs joined by a block boundary — the same
 * NUL convention as `editMatchFuzzy.ts`'s paragraph sentinel and docx's
 * paragraph marker. `foldEditChar(NUL)` is `drop`, so a needle can never
 * contain one and therefore can never match across it. Built with
 * `String.fromCharCode` so no raw NUL sits in this source file. Ported from
 * `html_edit::BLOCK_SENTINEL`. */
export const BLOCK_SENTINEL = String.fromCharCode(0);

/** Sentinel entries in the flattened map point at no real run — Rust uses
 * `usize::MAX`; a negative index is the JS equivalent. A needle can never
 * contain the sentinel character, so a real match's endpoints never land on
 * one and this is never dereferenced. */
export const SENTINEL_RUN = -1;

/** The entity table the position-preserving SCANNER uses. Deliberately
 * distinct from `editMatchExtraction.ts`'s display-only `NAMED_ENTITIES`
 * (whose `nbsp` is a plain space): this one produces a real U+00A0, matching
 * `html_edit::decode_entity_body`, because the fold table then turns it into
 * a matchable space while the SOURCE span still covers the whole `&nbsp;`. */
const SCANNER_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["#39", "'"],
  ["nbsp", " "],
]);

function isScalarValue(code: number): boolean {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
}

/** Ported verbatim from `html_edit::decode_entity_body`. */
function decodeEntityBody(body: string): string | null {
  const named = SCANNER_ENTITIES.get(body);
  if (named !== undefined) {
    return named;
  }
  const numeric = numericEntity(body);
  if (numeric === null || !numericPattern(numeric.digits, numeric.radix)) {
    return null;
  }
  const code = Number.parseInt(numeric.digits, numeric.radix);
  return isScalarValue(code) ? String.fromCodePoint(code) : null;
}

function numericEntity(body: string): { readonly digits: string; readonly radix: number } | null {
  if (body.startsWith("#x") || body.startsWith("#X")) {
    return { digits: body.slice(2), radix: 16 };
  }
  return body.startsWith("#") ? { digits: body.slice(1), radix: 10 } : null;
}

function numericPattern(digits: string, radix: number): boolean {
  return radix === 16 ? /^[0-9a-fA-F]+$/.test(digits) : /^[0-9]+$/.test(digits);
}

/**
 * Decode one entity or literal char starting at `html[i]`, returning the
 * decoded char and how many source code units it consumed. An unrecognized or
 * malformed `&…;` sequence is treated as a literal `&` (1 unit) — safe, and
 * the rest scans normally as text. Ported verbatim from
 * `html_edit::decode_html_unit`, INDEXING rather than re-slicing the tail on
 * every character (slicing per character would make a whole-page scan
 * quadratic).
 */
function decodeHtmlUnit(html: string, i: number): { ch: string; len: number } {
  const entity = decodedEntityAt(html, i);
  if (entity !== null) {
    return entity;
  }
  const ch = String.fromCodePoint(html.codePointAt(i) ?? 0xfffd);
  return { ch, len: ch.length };
}

function decodedEntityAt(html: string, i: number): { ch: string; len: number } | null {
  if (html[i] !== "&") {
    return null;
  }
  const bodyStart = i + 1;
  const semi = entityTerminatorOffset(html, bodyStart);
  if (semi === -1) {
    return null;
  }
  const body = html.slice(bodyStart, bodyStart + semi);
  const decoded = decodeEntityBody(body);
  return decoded === null ? null : { ch: decoded, len: body.length + 2 };
}

function entityTerminatorOffset(html: string, bodyStart: number): number {
  for (let offset = 0; offset <= 32 && bodyStart + offset < html.length; offset++) {
    if (html[bodyStart + offset] === ";") {
      return offset;
    }
  }
  return -1;
}

/** Where a tag's NAME ends within its (already `<`/`/`-stripped) source: the
 * first Unicode-whitespace character or `/`, else the whole string. Ported
 * from the `.find(|c: char| c.is_whitespace() || c == '/')` expression shared
 * by `scan_html_runs` and `scan_headings`. */
export function tagNameEnd(nameSrc: string): number {
  let pos = 0;
  for (const ch of nameSrc) {
    if (ch === "/" || isUnicodeWhitespace(ch)) {
      return pos;
    }
    pos += ch.length;
  }
  return nameSrc.length;
}

/** Ported from `html_edit.rs`'s use of `str::trim_start()` (Unicode
 * White_Space-aware, not just ASCII `\s`). */
export function trimStartUnicode(s: string): string {
  let i = 0;
  for (const ch of s) {
    if (!isUnicodeWhitespace(ch)) {
      break;
    }
    i += ch.length;
  }
  return s.slice(i);
}

/**
 * Scan `html` into text runs plus a boundary flag between each consecutive
 * pair (`boundaries[i] === true` means a BLOCK boundary separates `runs[i]`
 * and `runs[i + 1]`; `boundaries.length === max(runs.length - 1, 0)`).
 *
 * Malformed markup (an unterminated tag, an unclosed `<script>`/`<style>`)
 * ENDS the scan at that point rather than reading past it — whatever text came
 * before is still editable; nothing after is claimed. Ported verbatim from
 * `html_edit::scan_html_runs`.
 */
export function scanHtmlRuns(html: string): { runs: HtmlTextRun[]; boundaries: boolean[] } {
  // Position-preserving lowered copy, computed once: `asciiLower` never
  // changes a string's length, so an index found in `lower` is a valid index
  // into `html`.
  const lower = asciiLower(html);
  const state = newRunScanner();
  let i = 0;
  while (i < html.length) {
    let next: number | null;
    if (html[i] === "<") {
      next = consumeMarkup(state, html, lower, i);
    } else {
      next = consumeText(state, html, i);
    }
    if (next === null) {
      break;
    }
    i = next;
  }
  flushRun(state, i);
  return { runs: state.runs, boundaries: state.boundaries };
}

interface RunScanner {
  readonly runs: HtmlTextRun[];
  readonly boundaries: boolean[];
  pendingBoundary: boolean;
  start: number;
  chars: string[];
  spans: Array<readonly [number, number]>;
}

function newRunScanner(): RunScanner {
  return { runs: [], boundaries: [], pendingBoundary: false, start: -1, chars: [], spans: [] };
}

function consumeMarkup(state: RunScanner, html: string, lower: string, i: number): number | null {
  flushRun(state, i);
  const commentEnd = commentEndAt(html, i);
  if (commentEnd !== undefined) {
    return commentEnd;
  }
  const hiddenEnd = hiddenElementEnd(html, lower, i);
  if (hiddenEnd !== undefined) {
    return hiddenEnd;
  }
  return consumeOrdinaryTag(state, html, i);
}

export function commentEndAt(html: string, i: number): number | null | undefined {
  if (!html.startsWith("<!--", i)) {
    return undefined;
  }
  const end = html.indexOf("-->", i);
  return end === -1 ? null : end + 3;
}

function hiddenElementEnd(html: string, lower: string, i: number): number | null | undefined {
  const name = hiddenElementName(lower, i, html.length);
  if (name === null) {
    return undefined;
  }
  const openEnd = html.indexOf(">", i);
  if (openEnd === -1) {
    return null;
  }
  return closingElementEnd(html, lower, name, openEnd + 1);
}

function hiddenElementName(lower: string, i: number, length: number): "script" | "style" | null {
  const peek = lower.slice(i, i + Math.min(length - i, 8));
  if (peek.startsWith("<script")) {
    return "script";
  }
  return peek.startsWith("<style") ? "style" : null;
}

function closingElementEnd(html: string, lower: string, name: string, from: number): number | null {
  const closeStart = lower.indexOf(`</${name}`, from);
  if (closeStart === -1) {
    return null;
  }
  const closeEnd = html.indexOf(">", closeStart);
  return closeEnd === -1 ? null : closeEnd + 1;
}

function consumeOrdinaryTag(state: RunScanner, html: string, i: number): number | null {
  const end = html.indexOf(">", i);
  if (end === -1) {
    return null;
  }
  markBlockBoundary(state, html.slice(i + 1, end));
  return end + 1;
}

function markBlockBoundary(state: RunScanner, tagSource: string): void {
  const tag = trimStartUnicode(tagSource);
  if (isBlockCloseTag(tag)) {
    state.pendingBoundary = true;
  }
}

function isBlockCloseTag(tag: string): boolean {
  if (!tag.startsWith("/")) {
    return false;
  }
  // EVERY leading slash comes off, not just the first — Rust's
  // `tag_src.trim_start_matches('/')` keeps malformed `<//p>` a boundary.
  const nameSource = tag.replace(/^\/+/, "");
  const name = asciiLower(nameSource.slice(0, tagNameEnd(nameSource)));
  return BLOCK_CLOSE_TAGS.has(name);
}

function consumeText(state: RunScanner, html: string, i: number): number {
  if (state.start === -1) {
    state.start = i;
  }
  const { ch, len } = decodeHtmlUnit(html, i);
  state.spans.push([i, i + len]);
  state.chars.push(ch);
  return i + len;
}

function flushRun(state: RunScanner, end: number): void {
  if (state.start === -1) {
    return;
  }
  if (state.runs.length > 0) {
    state.boundaries.push(state.pendingBoundary);
  }
  state.runs.push({ span: [state.start, end], chars: state.chars, charSpans: state.spans });
  state.pendingBoundary = false;
  state.start = -1;
  state.chars = [];
  state.spans = [];
}
