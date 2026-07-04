/**
 * Shared quote-anchoring for document viewers. The model cites an exact
 * snippet; we resolve it against the rendered DOM with whitespace- and
 * case-insensitive matching and paint it via the CSS Custom Highlight API
 * (no DOM mutation — safe over docx-preview / react-markdown output).
 */

export function normalizeForMatch(s: string): string {
  return s.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

const HIGHLIGHT_NAME = "pr-annotation";

/** Find `quote` across the text nodes under `root` as a DOM Range. */
export function findQuoteRange(root: HTMLElement, quote: string): Range | null {
  const needle = normalizeForMatch(quote);
  if (!needle) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let hay = "";
  const map: { node: Text; offset: number }[] = [];
  let lastWasSpace = true;
  for (
    let node = walker.nextNode() as Text | null;
    node;
    node = walker.nextNode() as Text | null
  ) {
    const s = node.data;
    for (let i = 0; i < s.length; i++) {
      if (/\s/.test(s[i])) {
        if (!lastWasSpace) {
          hay += " ";
          map.push({ node, offset: i });
          lastWasSpace = true;
        }
      } else {
        hay += s[i].toLowerCase().charAt(0);
        map.push({ node, offset: i });
        lastWasSpace = false;
      }
    }
  }
  const idx = hay.indexOf(needle);
  if (idx < 0) return null;
  const start = map[idx];
  const end = map[idx + needle.length - 1];
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + 1);
  return range;
}

/** Highlight `quote` under `root` and scroll it into view. */
export function applyQuoteHighlight(root: HTMLElement, quote: string): boolean {
  const range = findQuoteRange(root, quote);
  if (!range) return false;
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
  return true;
}

export function clearQuoteHighlight(): void {
  (CSS as unknown as { highlights?: Map<string, unknown> }).highlights?.delete(
    HIGHLIGHT_NAME,
  );
}

/** "B7" → zero-based row/col, or null. */
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

/** "B7" or "B2:D5" → normalized zero-based rectangle. */
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
