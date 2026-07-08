/**
 * Shared quote-anchoring for document viewers. The model cites an exact
 * snippet; we resolve it against the rendered DOM with whitespace- and
 * case-insensitive matching and paint it via the CSS Custom Highlight API
 * (no DOM mutation — safe over docx-preview / react-markdown output).
 */

/** Fold typographic look-alikes so quotes from extracted text match the
 * rendered document: curly quotes, dashes, ligatures, exotic spaces, and
 * soft hyphens (which the renderer may drop entirely). */
export function foldChar(ch: string): string {
  switch (ch) {
    case "‘":
    case "’":
    case "ʼ":
      return "'";
    case "“":
    case "”":
      return '"';
    case "–":
    case "—":
      return "-";
    case "ﬁ":
      return "fi";
    case "ﬂ":
      return "fl";
    case " ":
      return " ";
    case "­": // soft hyphen — invisible, often present on one side only
      return "";
    default:
      return ch;
  }
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
export function normalizeWithMap(src: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "­") continue; // soft hyphen: vanish, no space
    if (/\s/.test(ch)) {
      pendingSpace = norm.length > 0; // collapse run; suppress leading space
      continue;
    }
    const folded = foldChar(ch.toLowerCase());
    if (folded === "-") {
      // Line-end hyphenation: a hyphen whose following whitespace run
      // contains a newline joins the two word halves — drop both.
      let j = i + 1;
      let newline = false;
      while (j < src.length && (src[j] === "­" || /\s/.test(src[j]))) {
        if (src[j] === "\n" || src[j] === "\r") newline = true;
        j++;
      }
      if (newline) {
        i = j - 1; // consume the whitespace run too
        pendingSpace = false;
        continue;
      }
    }
    if (pendingSpace) {
      norm += " ";
      map.push(i);
      pendingSpace = false;
    }
    for (const fc of folded) {
      norm += fc;
      map.push(i);
    }
  }
  return { norm, map };
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
export function locateQuote(
  source: string,
  quote: string,
): { start: number; end: number } | null {
  const { norm, map } = normalizeWithMap(source);
  const needle = normalizeForMatch(quote);
  if (!needle) return null;

  let at = norm.indexOf(needle);
  if (at >= 0) return { start: map[at], end: map[at + needle.length - 1] };

  // Whitespace-free fallback: strip spaces from both sides, keep the map.
  let free = "";
  const freeMap: number[] = [];
  for (let k = 0; k < norm.length; k++) {
    if (norm[k] !== " ") {
      free += norm[k];
      freeMap.push(map[k]);
    }
  }
  const freeNeedle = needle.replace(/ /g, "");
  if (!freeNeedle) return null;
  at = free.indexOf(freeNeedle);
  if (at >= 0) return { start: freeMap[at], end: freeMap[at + freeNeedle.length - 1] };
  return null;
}

const HIGHLIGHT_NAME = "pr-annotation";

/** Bumped on every apply/clear so a scheduled retry from a superseded call
 * (file closed, quote changed) never repaints a stale highlight. */
let highlightGen = 0;
const MAX_HIGHLIGHT_RETRY_FRAMES = 6;

/** Concatenate the text nodes under `root` into one string with a
 * per-character map back to {node, offset}, so a match found on the joined
 * text can be resolved to a DOM Range even when it spans several nodes. */
function buildDomSource(root: HTMLElement): {
  text: string;
  map: { node: Text; offset: number }[];
} {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = "";
  const map: { node: Text; offset: number }[] = [];
  for (
    let node = walker.nextNode() as Text | null;
    node;
    node = walker.nextNode() as Text | null
  ) {
    const s = node.data;
    for (let i = 0; i < s.length; i++) {
      text += s[i];
      map.push({ node, offset: i });
    }
  }
  return { text, map };
}

/** Find `quote` across the text nodes under `root` as a DOM Range,
 * tolerant of whitespace/case/soft-hyphen/line-break differences. */
export function findQuoteRange(root: HTMLElement, quote: string): Range | null {
  const { text, map } = buildDomSource(root);
  const hit = locateQuote(text, quote);
  if (!hit) return null;
  const start = map[hit.start];
  const end = map[hit.end];
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + 1);
  return range;
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
    el?.classList.add("quote-flash");
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
  const range = findQuoteRange(root, quote);
  if (range) {
    paintQuoteRange(range);
    return true;
  }
  let frames = 0;
  const retry = () => {
    if (gen !== highlightGen || !root.isConnected) return;
    const r = findQuoteRange(root, quote);
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
}

/* ============================ Receipts ============================ *
 * A "receipt" is a quote the app can prove: found word-for-word in a source
 * file, so it earns a green "verified" check. These are small, reusable
 * helpers layered on top of the existing quote-anchoring above — the React
 * shell (Workspace) verifies annotation chips with `isQuoteVerified`, and the
 * imperative viewers (PdfView) drop `makeReceiptBadge()` next to a located
 * highlight. No change to the highlight logic itself.
 * ---------------------------------------------------------------- */

/**
 * Is `quote` present, word-for-word, in `source`? Uses the same
 * normalization-tolerant match as the highlighters (case / whitespace /
 * newlines / soft hyphens / typographic look-alikes), so a quote copied from
 * a rendered document still verifies against the extracted text. A quote that
 * resolves to a real span is a located, verbatim-verified quote — exactly what
 * earns the badge.
 */
export function isQuoteVerified(source: string, quote: string): boolean {
  if (!quote || quote.trim().length < 2) return false;
  return locateQuote(source, quote) !== null;
}

/** Stable class name for the "verified" receipt badge (styled in App.css by
 *  the CSS track). */
export const RECEIPT_BADGE_CLASS = "receipt-badge";

/** A framework-neutral description of the badge, so a React caller can render
 *  `<span className={b.className} title={b.title}>{b.symbol} {b.label}</span>`
 *  without pulling in any DOM helper. */
export interface ReceiptBadge {
  className: string;
  symbol: string;
  label: string;
  title: string;
}

export function receiptBadge(label = "Verified"): ReceiptBadge {
  return {
    className: RECEIPT_BADGE_CLASS,
    symbol: "✓",
    label,
    title: "This quote was found word-for-word in the source.",
  };
}

/** DOM factory for imperative viewers that paint overlays by hand (PdfView).
 *  Returns `<span class="receipt-badge">✓ Verified</span>`; the caller
 *  positions it. Look (green, pill) is owned by the `.receipt-badge` CSS. */
export function makeReceiptBadge(label = "Verified"): HTMLSpanElement {
  const b = receiptBadge(label);
  const el = document.createElement("span");
  el.className = b.className;
  el.title = b.title;
  el.textContent = `${b.symbol} ${b.label}`;
  return el;
}

/** "B7" -> zero-based row/col, or null. */
export function parseA1(cell: string): { r: number; c: number } | null {
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
