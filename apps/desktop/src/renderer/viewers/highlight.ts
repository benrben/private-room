/**
 * Shared quote-anchoring for document viewers. The model cites an exact
 * snippet; we resolve it against the rendered DOM with whitespace- and
 * case-insensitive matching and paint it via the CSS Custom Highlight API
 * (no DOM mutation — safe over docx-preview / react-markdown output).
 */

const FOLDED_CHARACTERS = new Map<string, string>([
  ["‘", "'"], ["’", "'"], ["ʼ", "'"],
  ["“", '"'], ["”", '"'],
  ["–", "-"], ["—", "-"], ["־", "-"],
  ["ﬁ", "fi"], ["ﬂ", "fl"], [" ", " "], ["­", ""],
]);
const HEBREW_FOLD_EXCLUSIONS = new Set([0x05be, 0x05c0, 0x05c3, 0x05c6]);

function isFoldedHebrewMark(ch: string): boolean {
  const codePoint = ch.codePointAt(0) ?? 0;
  return codePoint >= 0x0591 && codePoint <= 0x05c7 && !HEBREW_FOLD_EXCLUSIONS.has(codePoint);
}

/** Fold typographic look-alikes so quotes from extracted text match the
 * rendered document: curly quotes, dashes, ligatures, exotic spaces, and
 * soft hyphens (which the renderer may drop entirely). */
function foldChar(ch: string): string {
  const folded = FOLDED_CHARACTERS.get(ch);
  if (folded !== undefined) return folded;
  return isFoldedHebrewMark(ch) ? "" : ch;
}

/**
 * Normalize `src` for matching AND record, for every character of the
 * normalized string, the index into `src` it came from (so a match can be
 * mapped back to the original text). Rules — applied identically to needle
 * and haystack so search snippets / model quotes match the rendered text:
 *   - lowercase and fold look-alikes (curly quotes, dashes, ligatures);
 *   - drop soft hyphens (U+00AD);
 *   - join words hyphenated across a line end ("infor-\nmation" -> one word);
 *   - collapse every run of whitespace (incl. newlines) to a single space.
 * The normalized form is trimmed (no leading/trailing space).
 */
type NormalizedText = { map: number[]; norm: string; pendingSpace: boolean };

function hyphenWhitespace(src: string, index: number): { end: number; hasLineBreak: boolean } {
  let end = index + 1;
  let hasLineBreak = false;
  while (end < src.length && (src[end] === "­" || /\s/.test(src[end]))) {
    if (src[end] === "\n" || src[end] === "\r") hasLineBreak = true;
    end += 1;
  }
  return { end, hasLineBreak };
}

function joinedLineEnd(src: string, index: number, folded: string): number | null {
  if (folded !== "-") return null;
  const whitespace = hyphenWhitespace(src, index);
  return whitespace.hasLineBreak ? whitespace.end : null;
}

function noteWhitespace(normalized: NormalizedText): void {
  normalized.pendingSpace = normalized.norm.length > 0;
}

function appendFolded(normalized: NormalizedText, folded: string, sourceIndex: number): void {
  if (normalized.pendingSpace) {
    normalized.norm += " ";
    normalized.map.push(sourceIndex);
    normalized.pendingSpace = false;
  }
  for (const character of folded) {
    normalized.norm += character;
    normalized.map.push(sourceIndex);
  }
}

function normalizeWithMap(src: string): { norm: string; map: number[] } {
  const normalized: NormalizedText = { norm: "", map: [], pendingSpace: false };
  for (let index = 0; index < src.length; index++) {
    const character = src[index];
    if (character === "­") continue;
    if (/\s/.test(character)) {
      noteWhitespace(normalized);
      continue;
    }
    const folded = foldChar(character.toLowerCase());
    const lineEnd = joinedLineEnd(src, index, folded);
    if (lineEnd !== null) {
      index = lineEnd - 1;
      normalized.pendingSpace = false;
      continue;
    }
    appendFolded(normalized, folded, index);
  }
  return normalized;
}

/** Normalize `quote` to the same form used for the haystack (see
 * normalizeWithMap): whitespace-collapsed, folded, soft-hyphen-free. */
export function normalizeForMatch(s: string): string {
  return normalizeWithMap(s).norm;
}

/**
 * Locate `quote` inside `source`, tolerant of case, whitespace, newlines,
 * soft hyphens, line-end hyphenation and typographic look-alikes. Returns
 * the inclusive [start, end] character indices into the ORIGINAL `source`,
 * or null when the normalized needle genuinely isn't present. Matches may
 * span the whole source (i.e. cross text items / nodes). First tries a
 * whitespace-collapsed match, then a whitespace-free one, because text
 * extractors and renderers frequently disagree on where spaces fall.
 */
function locatedRange(text: string, map: readonly number[], needle: string): { start: number; end: number } | null {
  const at = text.indexOf(needle);
  return at < 0 ? null : { start: map[at]!, end: map[at + needle.length - 1]! };
}

function withoutWhitespace(normalized: { norm: string; map: readonly number[] }): { map: number[]; text: string } {
  let free = "";
  const freeMap: number[] = [];
  for (let index = 0; index < normalized.norm.length; index++) {
    if (normalized.norm[index] !== " ") {
      free += normalized.norm[index];
      freeMap.push(normalized.map[index]!);
    }
  }
  return { text: free, map: freeMap };
}

function locateQuote(source: string, quote: string): { start: number; end: number } | null {
  const normalized = normalizeWithMap(source);
  const needle = normalizeForMatch(quote);
  if (!needle) return null;
  const direct = locatedRange(normalized.norm, normalized.map, needle);
  if (direct) return direct;
  const free = withoutWhitespace(normalized);
  const freeNeedle = needle.replace(/ /g, "");
  if (!freeNeedle) return null;
  return locatedRange(free.text, free.map, freeNeedle);
}

/**
 * `locateQuote`, plus a fallback for VISUAL-ORDER Hebrew documents (many
 * Hebrew PDFs store each line character-mirrored; the app's extracted text
 * is repaired to logical order, so a quoted passage won't match the raw
 * page text). When the direct match fails and the quote contains Hebrew,
 * mirror every Hebrew-bearing line of the source and retry, mapping the hit
 * back to ORIGINAL source indices so highlight painting works unchanged.
 */
export function locateQuoteHebrewAware(
  source: string,
  quote: string,
): { start: number; end: number } | null {
  const direct = locateQuote(source, quote);
  if (direct) return direct;
  if (!/[א-ת]/.test(quote)) return null;

  const visualOrder = visualOrderSource(source);
  const hit = locateQuote(visualOrder.text, quote);
  if (!hit) return null;
  return originalRange(visualOrder.map, hit);
}

function appendVisualLine(
  source: string,
  start: number,
  end: number,
  mirrored: string[],
  backMap: number[],
): void {
  const reversed = /[א-ת]/.test(source.slice(start, end));
  for (let index = reversed ? end - 1 : start; reversed ? index >= start : index < end; index += reversed ? -1 : 1) {
    mirrored.push(source[index]!);
    backMap.push(index);
  }
}

function visualOrderSource(source: string): { map: number[]; text: string } {
  const mirrored: string[] = [];
  const backMap: number[] = [];
  let lineStart = 0;
  for (let index = 0; index < source.length; index++) {
    if (source[index] !== "\n") continue;
    appendVisualLine(source, lineStart, index, mirrored, backMap);
    mirrored.push("\n");
    backMap.push(index);
    lineStart = index + 1;
  }
  appendVisualLine(source, lineStart, source.length, mirrored, backMap);
  return { text: mirrored.join(""), map: backMap };
}

function originalRange(map: readonly number[], hit: { start: number; end: number }): { start: number; end: number } {
  let start = map[hit.start]!;
  let end = start;
  for (let index = hit.start; index <= hit.end; index++) {
    const original = map[index]!;
    if (original < start) start = original;
    if (original > end) end = original;
  }
  return { start, end };
}

const HIGHLIGHT_NAME = "pr-annotation";

/** Bumped on every apply/clear so a scheduled retry from a superseded call
 * (file closed, quote changed) never repaints a stale highlight. */
let highlightGen = 0;
const MAX_HIGHLIGHT_RETRY_FRAMES = 6;

/** One text node's placement in the joined text: it covers
 * [start, start + node.data.length) of it. */
interface TextSpan {
  node: Text;
  start: number;
}

/** Concatenate the text nodes under `root` into one string, recording one
 * span PER NODE (not per character — a 9 MB document would otherwise cost a
 * million objects on every retry frame). `resolveOffset` maps a match back
 * to {node, offset}, so a match may still span several nodes. */
function buildDomSource(root: HTMLElement): { text: string; spans: TextSpan[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  const spans: TextSpan[] = [];
  let at = 0;
  for (
    let node = walker.nextNode() as Text | null;
    node;
    node = walker.nextNode() as Text | null
  ) {
    const s = node.data;
    if (!s) continue; // empty node: covers nothing, would break the search
    spans.push({ node, start: at });
    parts.push(s);
    at += s.length;
  }
  return { text: parts.join(""), spans };
}

/** Character offset into the joined text -> the text node holding it.
 * Binary search for the last span that starts at or before `at`. */
function resolveOffset(
  spans: TextSpan[],
  at: number,
): { node: Text; offset: number } | null {
  if (at < 0 || spans.length === 0) return null;
  let lo = 0;
  let hi = spans.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (spans[mid].start <= at) lo = mid;
    else hi = mid - 1;
  }
  const span = spans[lo];
  const offset = at - span.start;
  return offset < span.node.data.length ? { node: span.node, offset } : null;
}

/** Find `quote` across the text nodes under `root` as a DOM Range,
 * tolerant of whitespace/case/soft-hyphen/line-break differences.
 * `seen`, when passed, carries the joined text of the previous attempt: a
 * retry frame over a DOM that hasn't changed yet cannot find anything the
 * last frame missed, so it skips the normalize-and-search. */
function findQuoteRange(
  root: HTMLElement,
  quote: string,
  seen?: { text: string | null },
): Range | null {
  const { text, spans } = buildDomSource(root);
  if (seen) {
    if (text === seen.text) return null;
    seen.text = text;
  }
  const hit = locateQuote(text, quote);
  if (!hit) return null;
  const start = resolveOffset(spans, hit.start);
  const end = resolveOffset(spans, hit.end);
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + 1);
  return range;
}

/** The element the older-WKWebView fallback painted, so the next apply — or a
 * clear — can take the yellow back off it. Without this the paragraph stays
 * highlighted for the rest of the session and a second citation inside it
 * shows no change at all. */
let flashedEl: HTMLElement | null = null;

function clearFlash(): void {
  flashedEl?.classList.remove("quote-flash");
  flashedEl = null;
}

/** Paint a resolved range via the CSS Custom Highlight API (or flash a
 * fallback element on older WKWebView) and scroll it into view. */
function paintQuoteRange(range: Range): void {
  const HighlightCtor = (window as unknown as { Highlight?: new (r: Range) => unknown })
    .Highlight;
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  if (HighlightCtor && registry) {
    registry.set(HIGHLIGHT_NAME, new HighlightCtor(range));
  } else {
    // Older WKWebView: flash the containing element instead.
    const el =
      range.commonAncestorContainer instanceof HTMLElement
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    clearFlash();
    if (el) {
      el.classList.add("quote-flash");
      flashedEl = el;
    }
  }
  const anchor =
    range.startContainer instanceof HTMLElement
      ? range.startContainer
      : range.startContainer.parentElement;
  anchor?.scrollIntoView({ block: "center", behavior: "smooth" });
}

/**
 * Highlight `quote` under `root` and scroll it into view. Returns whether
 * the quote was found on the first synchronous attempt. If it isn't found
 * yet — a freshly-opened file whose text layer hasn't been laid out when
 * the target arrives — retry on the next few animation frames, cancelled
 * if the root detaches or a newer apply/clear supersedes this one.
 */
export function applyQuoteHighlight(root: HTMLElement, quote: string): boolean {
  const gen = ++highlightGen;
  const seen: { text: string | null } = { text: null };
  const range = findQuoteRange(root, quote, seen);
  if (range) {
    paintQuoteRange(range);
    return true;
  }
  let frames = 0;
  const retry = () => {
    if (gen !== highlightGen || !root.isConnected) return;
    const r = findQuoteRange(root, quote, seen);
    if (r) {
      if (gen === highlightGen) paintQuoteRange(r);
      return;
    }
    if (frames++ < MAX_HIGHLIGHT_RETRY_FRAMES) requestAnimationFrame(retry);
  };
  requestAnimationFrame(retry);
  return false;
}

export function clearQuoteHighlight(): void {
  highlightGen++; // cancel any pending retry from the previous apply
  (CSS as unknown as { highlights?: Map<string, unknown> }).highlights?.delete(
    HIGHLIGHT_NAME,
  );
  clearFlash();
}

/* ============================ Receipts ============================ *
 * A "receipt" is a quote the app can prove: found word-for-word in a source
 * file, so it earns a green "verified" check. The imperative viewers
 * (PdfView) drop `makeReceiptBadge()` next to a located highlight. No change
 * to the highlight logic itself.
 * ---------------------------------------------------------------- */

/** DOM factory for imperative viewers that paint overlays by hand (PdfView).
 *  Returns `<span class="receipt-badge">✓ Verified</span>`; the caller
 *  positions it. Look (green, pill) is owned by the `.receipt-badge` CSS. */
export function makeReceiptBadge(label = "Verified"): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "receipt-badge";
  el.title = "This quote was found word-for-word in the source.";
  el.textContent = `✓ ${label}`;
  return el;
}

/** "B7" -> zero-based row/col, or null. */
function parseA1(cell: string): { r: number; c: number } | null {
  const m = /^([A-Z]+)([0-9]+)$/.exec(cell.trim().toUpperCase());
  if (!m) return null;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  const r = parseInt(m[2], 10) - 1;
  return r < 0 ? null : { r, c: c - 1 };
}

export interface CellRect {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/** "B7" or "B2:D5" -> normalized zero-based rectangle. */
export function parseA1Range(range: string | undefined): CellRect | null {
  if (!range) return null;
  const [a, b] = range.split(":");
  const start = parseA1(a);
  if (!start) return null;
  const end = b ? parseA1(b) : start;
  if (!end) return null;
  return {
    r1: Math.min(start.r, end.r),
    c1: Math.min(start.c, end.c),
    r2: Math.max(start.r, end.r),
    c2: Math.max(start.c, end.c),
  };
}
