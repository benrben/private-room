import * as pdfjs from "pdfjs-dist";
import { locateQuoteHebrewAware, makeReceiptBadge } from "./highlight";

export interface PdfTarget {
  page?: number;
  quote?: string;
}

interface TextItem {
  str?: string;
  width?: number;
  transform: number[];
  hasEOL?: boolean;
}

/** pdf.js v6's getTextContent() iterates a ReadableStream with
 * `for await`, which WKWebView/Safari doesn't support — it throws
 * "undefined is not a function". Read the stream manually instead. */
export async function readTextItems(page: pdfjs.PDFPageProxy): Promise<TextItem[]> {
  const reader = (
    page.streamTextContent() as ReadableStream<{ items: TextItem[] }>
  ).getReader();
  const items: TextItem[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    items.push(...value.items);
  }
  return items;
}

/** Join a page's text items into readable text (reading order + line
 * breaks). pdf.js emits `hasEOL` on the item that ends a line. */
export function pageTextFromItems(items: TextItem[]): string {
  let out = "";
  for (const it of items) {
    out += it.str ?? "";
    if (it.hasEOL) out += "\n";
  }
  return out.replace(/[ \t]+\n/g, "\n").trim();
}

/** Concatenate a page's text items into one source string, plus a
 * per-character map back to the originating item index. A `\n` is inserted
 * at each `hasEOL` boundary so line-end hyphenation and whitespace
 * collapsing (see locateQuote) see the line breaks. The map lets a match
 * that spans several items resolve back to every item it touched. */
export function pageSource(items: TextItem[]): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  items.forEach((it, idx) => {
    const s = it.str ?? "";
    for (let i = 0; i < s.length; i++) {
      text += s[i];
      map.push(idx);
    }
    if (it.hasEOL) {
      text += "\n";
      map.push(idx);
    }
  });
  return { text, map };
}

/** A per-page "Copy text" button (UX-2). Built imperatively because the
 * pages themselves are rendered imperatively into the container. */
export function makeCopyButton(text: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pdf-copy-btn";
  btn.textContent = "Copy text";
  btn.title = "Copy this page's text";
  const reset = () => {
    btn.textContent = "Copy text";
    btn.classList.remove("copied");
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    navigator.clipboard
      .writeText(text)
      .then(() => {
        btn.textContent = "Copied";
        btn.classList.add("copied");
        window.setTimeout(reset, 1200);
      })
      .catch(() => {
        btn.textContent = "Copy failed";
        window.setTimeout(reset, 1200);
      });
  });
  return btn;
}

/**
 * Find `quote` in a page's text items and paint absolutely-positioned
 * highlight divs over the canvas. Item-level granularity: every text run
 * the match passes through gets a box. `scroll` brings the first box into
 * view (suppressed on zoom re-renders, which preserve reading position).
 *
 * `opts` separates the two callers: a CITATION paints `.pdf-hl` and earns the
 * green receipt badge (the quote was verified on this page); an ordinary
 * ⌘F find paints `.pdf-find-hl` and earns nothing — it is the reader's own
 * search, not a claim about where a sentence came from.
 */
export async function highlightQuoteOnPage(
  page: pdfjs.PDFPageProxy,
  wrap: HTMLDivElement,
  quote: string,
  scroll = true,
  opts?: { className?: string; badge?: boolean },
): Promise<boolean> {
  const hit = await quoteHit(page, quote);
  return hit ? paintQuoteHit(page, wrap, hit, scroll, opts) : false;
}

function paintQuoteHit(
  page: pdfjs.PDFPageProxy,
  wrap: HTMLDivElement,
  hit: QuoteHit,
  scroll: boolean,
  opts: { className?: string; badge?: boolean } | undefined,
): boolean {
  const target = highlightTarget(page, wrap);
  if (!target) return false;
  const first = paintQuoteHighlights(target, hit, highlightClass(opts));
  addBadgeWhenRequested(target.box, first, opts);
  scrollHighlight(first, scroll);
  return first !== null;
}

function highlightClass(opts: { className?: string } | undefined): string {
  return opts?.className ?? "pdf-hl";
}

function addBadgeWhenRequested(
  box: HTMLDivElement,
  highlight: HTMLDivElement | null,
  opts: { badge?: boolean } | undefined,
) {
  if (highlight && (opts?.badge ?? true)) addHighlightBadge(box, highlight);
}

function scrollHighlight(highlight: HTMLDivElement | null, scroll: boolean) {
  if (scroll) highlight?.scrollIntoView({ block: "center", behavior: "smooth" });
}

type QuoteHit = { items: TextItem[]; map: number[]; start: number; end: number };

async function quoteHit(page: pdfjs.PDFPageProxy, quote: string): Promise<QuoteHit | null> {
  const items = await readTextItems(page);
  const { text, map } = pageSource(items);
  const hit = locateQuoteHebrewAware(text, quote);
  return hit ? { items, map, ...hit } : null;
}

function highlightTarget(page: pdfjs.PDFPageProxy, wrap: HTMLDivElement) {
  const box = wrap.querySelector<HTMLDivElement>(".pdf-page-box");
  const canvas = box?.querySelector("canvas");
  if (!box || !canvas) return null;
  const cssWidth = parseFloat(canvas.style.width) || canvas.clientWidth;
  const base = page.getViewport({ scale: 1 });
  return { box, viewport: page.getViewport({ scale: cssWidth / base.width }) };
}

function matchedItemIndexes(map: number[], start: number, end: number): number[] {
  return [...new Set(map.slice(start, end + 1))];
}

function makeHighlight(
  item: TextItem,
  viewport: pdfjs.PageViewport,
  className: string,
): HTMLDivElement {
  const tx = pdfjs.Util.transform(viewport.transform, item.transform);
  const fontHeight = Math.hypot(tx[2], tx[3]);
  const highlight = document.createElement("div");
  highlight.className = className;
  highlight.style.left = `${tx[4]}px`;
  highlight.style.top = `${tx[5] - fontHeight}px`;
  highlight.style.width = `${Math.max((item.width ?? 0) * viewport.scale, 2)}px`;
  highlight.style.height = `${fontHeight * 1.2}px`;
  return highlight;
}

function paintQuoteHighlights(
  target: { box: HTMLDivElement; viewport: pdfjs.PageViewport },
  hit: QuoteHit,
  className: string,
): HTMLDivElement | null {
  let first: HTMLDivElement | null = null;
  for (const index of matchedItemIndexes(hit.map, hit.start, hit.end)) {
    const item = hit.items[index];
    if (!item?.str?.trim()) continue;
    const highlight = makeHighlight(item, target.viewport, className);
    target.box.appendChild(highlight);
    first = first ?? highlight;
  }
  return first;
}

function addHighlightBadge(box: HTMLDivElement, highlight: HTMLDivElement) {
  const badge = makeReceiptBadge();
  badge.classList.add("pdf-hl-badge");
  badge.style.position = "absolute";
  badge.style.left = highlight.style.left;
  badge.style.top = highlight.style.top;
  badge.style.transform = "translateY(-115%)";
  badge.style.pointerEvents = "none";
  badge.style.zIndex = "3";
  badge.style.whiteSpace = "nowrap";
  box.appendChild(badge);
}
