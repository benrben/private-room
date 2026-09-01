/**
 * Position-preserving HTML text scanner/editor — ported from
 * `src-tauri/src/extraction/html_edit.rs` (`scan_html_runs`,
 * `html_replace_text`, `scan_headings`, `find_section_range`), plus
 * `src-tauri/src/extraction/html.rs`'s `strip_html` (the "closest passage"
 * hint when a quote isn't found) and `commands/docs_html.rs`'s `html_escape`.
 *
 * Mirrors `docx.rs`'s scan/match/splice discipline over raw HTML markup
 * instead of Word XML runs, so a quote drawn from the page's readable text is
 * rewritten IN PLACE without disturbing surrounding tags. html/htm is the
 * app's DEFAULT AI-document format, and before this scanner existed it was
 * the one format `edit_file` refused outright.
 *
 * Deliberately NOT built on `stripHtml` — that pipeline is lossy BY DESIGN
 * for retrieval (narrows to `<main>`/`<article>`, drops
 * `<nav>`/`<header>`/`<footer>`/`<script>`/`<style>` bodies) and keeps no
 * offsets. Editing needs every character traceable back to the exact source
 * position it decoded from. `stripHtml` is still used, unmodified, for the
 * advisory "closest passage" hint — never for anything spliced back into
 * markup.
 *
 * OFFSETS here are UTF-16 code-unit positions into the JS string rather than
 * UTF-8 byte offsets; see `editMatchFuzzy.ts`'s module doc, whose reasoning
 * applies verbatim.
 *
 * EVERY lowered copy that gets INDEXED goes through `asciiLower`, never
 * `String.prototype.toLowerCase()`. The latter is Unicode-aware and NOT
 * length-preserving (Turkish `İ` U+0130 → `i` + U+0307), so an index found in
 * a Unicode-lowered copy is not a valid index into the original: a page with
 * one such character before a heading's closing tag made `scan_headings`
 * swallow the following paragraph into the heading's text, and a
 * `section`-scoped edit then landed on the wrong byte range. This is exactly
 * the trap `html.rs`'s own `ascii_lower` comment warns about.
 */

import { asciiLower, decodeBasicEntities, foldEditChar, stripTags } from "./editMatchExtraction.js";
import {
  BLOCK_SENTINEL,
  commentEndAt,
  SENTINEL_RUN,
  scanHtmlRuns,
  tagNameEnd,
  trimStartUnicode,
  type HtmlTextRun,
} from "./editMatchHtmlScanner.js";

export { scanHtmlRuns, type HtmlTextRun } from "./editMatchHtmlScanner.js";

// ============================================================ html.rs

/**
 * Narrow HTML down to its readable text: keep only `<main>`/`<article>` when
 * present, put a newline after block closes, drop non-content element bodies
 * (nav/header/footer/aside/form/script/style/noscript/svg), then strip tags.
 * Ported verbatim from `html::strip_html`.
 */
export function stripHtml(html: string): string {
  const readable = readableContainer(html);
  const separated = separateReadableBlocks(readable);
  return stripTags(removeChromeBodies(separated));
}

function readableContainer(html: string): string {
  for (const tag of ["<main", "<article"]) {
    const selected = completeContainer(html, tag);
    if (selected !== null) {
      return selected;
    }
  }
  return html;
}

function completeContainer(html: string, openTag: string): string | null {
  const lower = asciiLower(html);
  const open = lower.indexOf(openTag);
  if (open === -1) {
    return null;
  }
  const close = `</${openTag.slice(1)}>`;
  const closeStart = lower.lastIndexOf(close);
  return closeStart >= open ? html.slice(open, closeStart + close.length) : null;
}

function separateReadableBlocks(html: string): string {
  let separated = html;
  for (const tag of BLOCK_TEXT_TAGS) {
    separated = separated.split(tag).join(`${tag}\n`);
  }
  return separated;
}

const BLOCK_TEXT_TAGS = ["</p>", "</div>", "</li>", "</h1>", "</h2>", "</h3>", "</h4>", "</tr>", "<br>", "<br/>", "<br />"];

const CHROME_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["<script", "</script>"],
  ["<style", "</style>"],
  ["<nav", "</nav>"],
  ["<header", "</header>"],
  ["<footer", "</footer>"],
  ["<aside", "</aside>"],
  ["<form", "</form>"],
  ["<noscript", "</noscript>"],
  ["<svg", "</svg>"],
];

function removeChromeBodies(html: string): string {
  let withoutChrome = html;
  for (const pair of CHROME_PAIRS) {
    withoutChrome = removeChromePair(withoutChrome, pair);
  }
  return withoutChrome;
}

function removeChromePair(html: string, [openTag, closeTag]: readonly [string, string]): string {
  let result = html;
  for (;;) {
    const range = chromeBodyRange(result, openTag, closeTag);
    if (range === null) {
      return result;
    }
    result = result.slice(0, range[0]) + result.slice(range[1]);
  }
}

function chromeBodyRange(html: string, openTag: string, closeTag: string): readonly [number, number] | null {
  const lower = asciiLower(html);
  const start = lower.indexOf(openTag);
  if (start === -1) {
    return null;
  }
  const closeStart = lower.indexOf(closeTag, start);
  return closeStart === -1 ? null : [start, closeStart + closeTag.length];
}

// ============================================================ docs_html.rs

/** Escape text for safe literal inclusion in HTML. The CALLER's job before
 * handing a replacement to {@link htmlReplaceText}. Ported verbatim from
 * `docs_html::html_escape` (`&` first, or the later escapes' own ampersands
 * would be re-escaped). */
export function htmlEscape(s: string): string {
  return s.split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;").split('"').join("&quot;");
}

// ============================================================ html_edit.rs

/**
 * Fold an `edit_file` quote the SAME way `flattenRuns` folds the document's
 * own text: `foldEditChar`, whitespace runs collapsed to one space, edge
 * spaces trimmed. Ported verbatim from `html_edit::fold_needle` — kept as its
 * own copy rather than reusing `editMatchFuzzy.ts`'s `normalizeNeedle`
 * (observationally identical, different shape), exactly as the Rust source
 * keeps `fold_needle`, `collapse_ws` and `normalize_needle` side by side.
 */
function foldNeedle(s: string): string[] {
  const state = newNeedleFold();
  for (const c of s) {
    appendNeedleFold(state, c);
  }
  while (state.out.length > 0 && state.out[state.out.length - 1] === " ") {
    state.out.pop();
  }
  return state.out;
}

interface NeedleFold {
  readonly out: string[];
  lastSpace: boolean;
}

function newNeedleFold(): NeedleFold {
  return { out: [], lastSpace: true };
}

function appendNeedleFold(state: NeedleFold, source: string): void {
  const fold = foldEditChar(source);
  if (fold.kind === "space") {
    appendNeedleSpace(state);
    return;
  }
  if (fold.kind === "char") {
    appendNeedleChars(state, [fold.c]);
    return;
  }
  if (fold.kind === "pair") {
    appendNeedleChars(state, [fold.a, fold.b]);
  }
}

function appendNeedleSpace(state: NeedleFold): void {
  if (!state.lastSpace) {
    state.out.push(" ");
    state.lastSpace = true;
  }
}

function appendNeedleChars(state: NeedleFold, chars: readonly string[]): void {
  state.out.push(...chars);
  state.lastSpace = false;
}

/**
 * Flatten every run into one folded haystack, each entry mapped back to
 * `[runIndex, charOffsetWithinRun]`. A {@link BLOCK_SENTINEL} sits between
 * runs separated by a block boundary; runs joined only by inline markup get
 * none, so a quote may span them — exactly `scan_docx_text`'s paragraph
 * discipline, ported from Word runs to HTML tags. Ported verbatim from
 * `html_edit::flatten_runs`.
 */
function flattenRuns(
  runs: readonly HtmlTextRun[],
  boundaries: readonly boolean[]
): { hay: string[]; map: Array<[number, number]> } {
  const state = newRunFold();
  for (let ri = 0; ri < runs.length; ri++) {
    if (ri > 0 && boundaries[ri - 1]) {
      appendBlockSentinel(state);
    }
    appendRunFold(state, runs[ri]!, ri);
  }
  while (state.hay.length > 0 && state.hay[state.hay.length - 1] === " ") {
    state.hay.pop();
    state.map.pop();
  }
  return { hay: state.hay, map: state.map };
}

interface RunFold {
  readonly hay: string[];
  readonly map: Array<[number, number]>;
  lastSpace: boolean;
}

function newRunFold(): RunFold {
  return { hay: [], map: [], lastSpace: true };
}

function appendBlockSentinel(state: RunFold): void {
  state.hay.push(BLOCK_SENTINEL);
  state.map.push([SENTINEL_RUN, 0]);
  state.lastSpace = true;
}

function appendRunFold(state: RunFold, run: HtmlTextRun, runIndex: number): void {
  for (let charIndex = 0; charIndex < run.chars.length; charIndex++) {
    appendRunCharacter(state, run.chars[charIndex]!, runIndex, charIndex);
  }
}

function appendRunCharacter(state: RunFold, source: string, runIndex: number, charIndex: number): void {
  const fold = foldEditChar(source);
  if (fold.kind === "space") {
    appendRunSpace(state, runIndex, charIndex);
    return;
  }
  if (fold.kind === "char") {
    appendRunChars(state, [fold.c], runIndex, charIndex);
    return;
  }
  if (fold.kind === "pair") {
    appendRunChars(state, [fold.a, fold.b], runIndex, charIndex);
  }
}

function appendRunSpace(state: RunFold, runIndex: number, charIndex: number): void {
  if (!state.lastSpace) {
    appendRunChars(state, [" "], runIndex, charIndex);
    state.lastSpace = true;
  }
}

function appendRunChars(state: RunFold, chars: readonly string[], runIndex: number, charIndex: number): void {
  for (const char of chars) {
    state.hay.push(char);
    state.map.push([runIndex, charIndex]);
  }
  state.lastSpace = false;
}

/** Ported verbatim from `html_edit::find_sub`. */
function findSub(hay: readonly string[], needle: readonly string[], from: number): number {
  if (needle.length === 0 || hay.length < needle.length) {
    return -1;
  }
  const limit = hay.length - needle.length;
  outer: for (let s = from; s <= limit; s++) {
    for (let k = 0; k < needle.length; k++) {
      if (hay[s + k] !== needle[k]) {
        continue outer;
      }
    }
    return s;
  }
  return -1;
}

/** `Result<(String, usize), String>` — the exact shape
 * `html_edit::html_replace_text` returns. A discriminated union rather than a
 * throw so the CALLER's "not found" branch can never accidentally swallow an
 * unrelated failure (`Err(_)` in Rust can only ever be the no-match case). */
export type HtmlReplaceResult =
  | { readonly ok: true; readonly html: string; readonly count: number }
  | { readonly ok: false; readonly error: string };

/**
 * Replace `old` with `newEscaped` across every text run in `html`, tolerant
 * of the same typographic drift `foldEditChar` corrects for text and docx
 * files. A quote may span inline markup (`<b>`, `<span>`, `<a>`, …) but never
 * a block boundary — crossing one would silently splice two block elements
 * together. `newEscaped` is spliced in LITERALLY, so the caller must
 * HTML-escape it first ({@link htmlEscape}) or a replacement containing
 * `<`/`&` would inject markup.
 *
 * Replaces EVERY non-overlapping match and returns the new markup plus the
 * count — the same pure replace-then-let-the-caller-decide shape
 * `docxReplaceText` has: `computeEditBytes`'s HTML arm applies the ambiguity/
 * `all` check, so this function never needs to know about `all` at all.
 * Fails only when nothing matched. Ported verbatim from
 * `html_edit::html_replace_text`.
 */
export function htmlReplaceText(html: string, old: string, newEscaped: string): HtmlReplaceResult {
  const needle = foldNeedle(old);
  if (needle.length === 0) {
    return { ok: false, error: "Could not find that text in the page." };
  }
  const { runs, boundaries } = scanHtmlRuns(html);
  const { hay, map } = flattenRuns(runs, boundaries);
  const matches = allMatches(hay, needle);
  if (matches.length === 0) {
    return {
      ok: false,
      error: "Could not find that exact text in the page. Copy it exactly, including spacing and punctuation.",
    };
  }
  const out = replaceMatches(html, runs, map, matches, newEscaped);
  return { ok: true, html: out, count: matches.length };
}

function allMatches(hay: readonly string[], needle: readonly string[]): Array<[number, number]> {
  const matches: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const start = findSub(hay, needle, from);
    if (start === -1) {
      return matches;
    }
    const end = start + needle.length - 1;
    matches.push([start, end]);
    from = end + 1;
  }
}

function replaceMatches(
  html: string,
  runs: readonly HtmlTextRun[],
  map: ReadonlyArray<readonly [number, number]>,
  matches: ReadonlyArray<readonly [number, number]>,
  newEscaped: string
): string {
  let out = html;
  // Right-to-left so earlier offsets in `out` stay valid while later
  // (higher-offset) spans are rewritten first.
  for (let mi = matches.length - 1; mi >= 0; mi--) {
    out = replaceMatch(out, runs, map, matches[mi]!, newEscaped);
  }
  return out;
}

function replaceMatch(
  html: string,
  runs: readonly HtmlTextRun[],
  map: ReadonlyArray<readonly [number, number]>,
  [start, end]: readonly [number, number],
  newEscaped: string
): string {
  const [firstRun, firstChar] = map[start]!;
  const [lastRun, lastChar] = map[end]!;
  if (firstRun === lastRun) {
    return replaceWithinRun(html, runs[firstRun]!, firstChar, lastChar, newEscaped);
  }
  return replaceAcrossRuns(html, runs, firstRun, firstChar, lastRun, lastChar, newEscaped);
}

function replaceWithinRun(html: string, run: HtmlTextRun, firstChar: number, lastChar: number, newEscaped: string): string {
  return html.slice(0, run.charSpans[firstChar]![0]) + newEscaped + html.slice(run.charSpans[lastChar]![1]);
}

function replaceAcrossRuns(
  html: string,
  runs: readonly HtmlTextRun[],
  firstRun: number,
  firstChar: number,
  lastRun: number,
  lastChar: number,
  newEscaped: string
): string {
  let out = removeLastRunPart(html, runs[lastRun]!, lastChar);
  for (let runIndex = lastRun - 1; runIndex > firstRun; runIndex--) {
    out = removeWholeRun(out, runs[runIndex]!);
  }
  return replaceFirstRunPart(out, runs[firstRun]!, firstChar, newEscaped);
}

function removeLastRunPart(html: string, run: HtmlTextRun, lastChar: number): string {
  return html.slice(0, run.span[0]) + html.slice(run.charSpans[lastChar]![1]);
}

function removeWholeRun(html: string, run: HtmlTextRun): string {
  return html.slice(0, run.span[0]) + html.slice(run.span[1]);
}

function replaceFirstRunPart(html: string, run: HtmlTextRun, firstChar: number, newEscaped: string): string {
  return html.slice(0, run.charSpans[firstChar]![0]) + newEscaped + html.slice(run.span[1]);
}

// ------------------------------------------------------------------- headings

/** One `<h1>`–`<h6>` heading found in the page. Ported from
 * `html_edit::Heading`. */
export interface Heading {
  readonly level: number;
  readonly text: string;
  /** Position right after this heading's OWN closing tag — where the section
   * it introduces begins. */
  readonly sectionStart: number;
  /** Position where this heading's opening tag begins — where the PRECEDING
   * section ends. */
  readonly tagStart: number;
}

const HEADING_LEVELS: ReadonlyMap<string, number> = new Map([
  ["h1", 1], ["h2", 2], ["h3", 3], ["h4", 4], ["h5", 5], ["h6", 6],
]);

/**
 * Every heading in `html`, in document order, with its decoded text (built
 * from {@link scanHtmlRuns}'s own runs, so a heading carrying inline markup
 * like `<h2>Setup <em>and</em> Config</h2>` decodes correctly for free).
 * Ported verbatim from `html_edit::scan_headings`, including its deliberate
 * quirk of NOT special-casing `<script>`/`<style>` bodies the way
 * {@link scanHtmlRuns} does.
 */
export function scanHeadings(html: string): Heading[] {
  const { runs } = scanHtmlRuns(html);
  const lower = asciiLower(html);
  const out: Heading[] = [];
  let i = 0;
  while (i < html.length) {
    const next = consumeHeadingMarkup(html, lower, runs, out, i);
    if (next === null) {
      break;
    }
    i = next;
  }
  return out;
}

function consumeHeadingMarkup(
  html: string,
  lower: string,
  runs: readonly HtmlTextRun[],
  headings: Heading[],
  i: number
): number | null {
  if (html[i] !== "<") {
    return i + 1;
  }
  const commentEnd = commentEndAt(html, i);
  if (commentEnd !== undefined) {
    return commentEnd;
  }
  return consumeHeadingTag(html, lower, runs, headings, i);
}

function consumeHeadingTag(
  html: string,
  lower: string,
  runs: readonly HtmlTextRun[],
  headings: Heading[],
  tagStart: number
): number | null {
  const tagEnd = html.indexOf(">", tagStart);
  if (tagEnd === -1) {
    return null;
  }
  const heading = headingAt(html, lower, runs, tagStart, tagEnd);
  if (heading !== null) {
    headings.push(heading);
    return heading.sectionStart;
  }
  return tagEnd + 1;
}

function headingAt(
  html: string,
  lower: string,
  runs: readonly HtmlTextRun[],
  tagStart: number,
  tagEnd: number
): Heading | null {
  const name = openingHeadingName(html.slice(tagStart + 1, tagEnd));
  if (name === null) {
    return null;
  }
  const close = headingCloseRange(html, lower, name.tag, tagEnd + 1);
  if (close === null) {
    return null;
  }
  return {
    level: name.level,
    text: headingText(runs, tagEnd + 1, close[0]),
    sectionStart: close[1],
    tagStart,
  };
}

function openingHeadingName(source: string): { readonly tag: string; readonly level: number } | null {
  const tag = trimStartUnicode(source);
  if (tag.startsWith("/")) {
    return null;
  }
  const name = asciiLower(tag.slice(0, tagNameEnd(tag)));
  const level = HEADING_LEVELS.get(name);
  return level === undefined ? null : { tag: name, level };
}

function headingCloseRange(html: string, lower: string, tag: string, contentStart: number): readonly [number, number] | null {
  const closeStart = lower.indexOf(`</${tag}`, contentStart);
  if (closeStart === -1) {
    return null;
  }
  const closeEnd = html.indexOf(">", closeStart);
  return closeEnd === -1 ? null : [closeStart, closeEnd + 1];
}

function headingText(runs: readonly HtmlTextRun[], contentStart: number, closeStart: number): string {
  return runs
    .filter((run) => run.span[0] >= contentStart && run.span[1] <= closeStart)
    .flatMap((run) => [...run.chars])
    .join("")
    .trim();
}

/** `Result<Range<usize>, Vec<String>>` — a found range, or every heading the
 * page actually has so the caller can offer the model a real one. */
export type SectionRange =
  | { readonly ok: true; readonly start: number; readonly end: number }
  | { readonly ok: false; readonly headings: string[] };

/**
 * The range in `html` that `section` (a heading's text, fold-tolerant) owns:
 * from right after that heading's closing tag to the next heading of the SAME
 * OR HIGHER level (h1 is higher than h2), or the end of the document. On a
 * miss it lists every heading actually found — it never falls back to
 * searching the whole document, which would defeat the point of scoping the
 * edit. Ported verbatim from `html_edit::find_section_range`.
 */
export function findSectionRangeHtml(html: string, section: string): SectionRange {
  const headings = scanHeadings(html);
  const needle = foldNeedle(section).join("");
  const idx = headings.findIndex((h) => foldNeedle(h.text).join("") === needle);
  if (idx === -1) {
    return { ok: false, headings: headings.map((h) => h.text) };
  }
  const level = headings[idx]!.level;
  const start = headings[idx]!.sectionStart;
  const next = headings.slice(idx + 1).find((h) => h.level <= level);
  return { ok: true, start, end: next !== undefined ? next.tagStart : html.length };
}
