import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { locateQuoteHebrewAware, makeReceiptBadge } from "./highlight";
import { base64ToBytes } from "./util";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Render this far beyond the viewport so scrolling never shows a blank page. */
const RENDER_AHEAD_PX = 1500;
/** Rasterized pages kept alive at once. Far pages collapse back to
 * placeholders (their height preserved), so a 1,200-page book costs the
 * memory of ~28 canvases, not 1,200 — the old fix for that was a hard
 * MAX_PAGES=100 cap, which simply cut long documents off. */
const MAX_LIVE_PAGES = 28;
const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const SCALE_STEP = 0.25;

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
async function readTextItems(page: pdfjs.PDFPageProxy): Promise<TextItem[]> {
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
function pageTextFromItems(items: TextItem[]): string {
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
function pageSource(items: TextItem[]): { text: string; map: number[] } {
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
function makeCopyButton(text: string): HTMLButtonElement {
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
 */
async function highlightQuoteOnPage(
  page: pdfjs.PDFPageProxy,
  wrap: HTMLDivElement,
  quote: string,
  scroll = true,
): Promise<boolean> {
  // Normalization-tolerant match: locateQuote folds case, whitespace,
  // newlines, soft hyphens, line-end hyphenation and typographic
  // look-alikes, and can span the many items pdf.js splits a line into.
  const items = await readTextItems(page);
  const { text, map } = pageSource(items);
  // Hebrew-aware: visual-order PDFs store lines mirrored — the fallback
  // mirrors them back and still maps the hit to original char positions.
  const hit = locateQuoteHebrewAware(text, quote);
  if (!hit) return false;

  const canvas = wrap.querySelector("canvas");
  if (!canvas) return false;
  const cssWidth = parseFloat(canvas.style.width) || canvas.clientWidth;
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: cssWidth / base.width });
  // Every item the (inclusive) matched source range touches gets a box.
  const matched = [...new Set(map.slice(hit.start, hit.end + 1))];
  let first: HTMLDivElement | null = null;
  for (const idx of matched) {
    const it = items[idx];
    if (!it?.str?.trim()) continue;
    const tx = pdfjs.Util.transform(viewport.transform, it.transform);
    const fontH = Math.hypot(tx[2], tx[3]);
    const hl = document.createElement("div");
    hl.className = "pdf-hl";
    hl.style.left = `${tx[4]}px`;
    hl.style.top = `${tx[5] - fontH}px`;
    hl.style.width = `${Math.max((it.width ?? 0) * viewport.scale, 2)}px`;
    hl.style.height = `${fontH * 1.2}px`;
    wrap.appendChild(hl);
    first = first ?? hl;
  }
  // A painted highlight means locateQuote found the quote verbatim on this
  // page — a receipt. Tag the first box with a green "verified" check.
  if (first) {
    const badge = makeReceiptBadge();
    badge.classList.add("pdf-hl-badge");
    // Position only (look comes from the .receipt-badge CSS): sit just above
    // the first matched run.
    badge.style.position = "absolute";
    badge.style.left = first.style.left;
    badge.style.top = first.style.top;
    badge.style.transform = "translateY(-115%)";
    badge.style.pointerEvents = "none";
    badge.style.zIndex = "3";
    badge.style.whiteSpace = "nowrap";
    wrap.appendChild(badge);
  }
  if (scroll) first?.scrollIntoView({ block: "center", behavior: "smooth" });
  return first != null;
}

export default function PdfView({
  dataB64,
  target,
}: {
  dataB64: string;
  target?: PdfTarget;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<pdfjs.PDFDocumentProxy | null>(null);
  const pageWrapsRef = useRef<HTMLDivElement[]>([]);
  const renderTokenRef = useRef(0);
  const observerRef = useRef<IntersectionObserver | null>(null);
  /** Page numbers currently holding a live canvas, oldest-touched first. */
  const livePagesRef = useRef<number[]>([]);
  /** Placeholder height (css px) for un-rendered pages at the current scale. */
  const estHeightRef = useRef(600);
  /** Where the quote highlight lives, so a recycled page repaints it. */
  const highlightRef = useRef<{ page: number; quote: string } | null>(null);
  const hoverRef = useRef(false);
  const targetRef = useRef(target);
  targetRef.current = target;

  const [status, setStatus] = useState("Rendering PDF…");
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1);
  // A document that can't be opened gets a calm recovery panel, never a raw
  // exception — the technical error goes to the console for debugging.
  const [failed, setFailed] = useState(false);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const targetKey = JSON.stringify(target ?? null);

  /** Collapse a rendered page back to a fixed-height placeholder. */
  const recyclePage = useCallback((p: number) => {
    const wrap = pageWrapsRef.current[p - 1];
    if (!wrap || wrap.dataset.rendered !== "1") return;
    // Keep the height the page actually had so the scroll length is stable.
    const h = wrap.getBoundingClientRect().height;
    wrap.replaceChildren();
    wrap.style.minHeight = `${Math.max(h, 40)}px`;
    delete wrap.dataset.rendered;
  }, []);

  /** Rasterize page `p` into its wrap (idempotent), then recycle the pages
   * farthest from it once more than MAX_LIVE_PAGES are alive. */
  const renderPage = useCallback(
    async (p: number, token: number): Promise<void> => {
      const pdf = pdfRef.current;
      const container = containerRef.current;
      const wrap = pageWrapsRef.current[p - 1];
      if (!pdf || !container || !wrap) return;
      if (token !== renderTokenRef.current) return;
      if (wrap.dataset.rendered === "1" || wrap.dataset.rendering === "1") {
        const live = livePagesRef.current;
        const i = live.indexOf(p);
        if (i >= 0) {
          live.splice(i, 1);
          live.push(p); // touch
        }
        return;
      }
      wrap.dataset.rendering = "1";
      try {
        const page = await pdf.getPage(p);
        if (token !== renderTokenRef.current) return;
        const fitWidth = Math.max(container.clientWidth - 16, 400);
        const cssWidth = fitWidth * scaleRef.current;
        const base = page.getViewport({ scale: 1 });
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({
          scale: (cssWidth / base.width) * dpr,
        });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${cssWidth}px`;
        canvas.className = "pdf-page";
        await page.render({ canvas, viewport }).promise;
        if (token !== renderTokenRef.current) return;
        wrap.replaceChildren(canvas);
        wrap.style.minHeight = "";
        wrap.dataset.rendered = "1";

        // UX-2: per-page copy button, hidden when the page has no text.
        const pageText = pageTextFromItems(await readTextItems(page));
        if (token !== renderTokenRef.current) return;
        if (pageText) wrap.appendChild(makeCopyButton(pageText));

        // If this page carries the target-quote highlight and was recycled
        // meanwhile, repaint it (without stealing the scroll position).
        const hl = highlightRef.current;
        if (hl && hl.page === p) {
          await highlightQuoteOnPage(page, wrap, hl.quote, false);
        }

        const live = livePagesRef.current;
        live.push(p);
        if (live.length > MAX_LIVE_PAGES) {
          // Recycle the live pages farthest from the one just rendered.
          live.sort((a, b) => Math.abs(b - p) - Math.abs(a - p));
          while (live.length > MAX_LIVE_PAGES) {
            const victim = live.shift();
            if (victim != null && victim !== p) recyclePage(victim);
          }
        }
      } finally {
        delete wrap.dataset.rendering;
      }
    },
    [recyclePage],
  );

  /**
   * Build one fixed-height placeholder per page — every page of the
   * document, however many — and arm an IntersectionObserver that renders
   * pages as they approach the viewport. `restoreIdx` (set on zoom
   * re-renders) scrolls that page back to the top afterwards.
   */
  const buildPages = useCallback(
    async (renderScale: number, restoreIdx: number | null) => {
      const pdf = pdfRef.current;
      const container = containerRef.current;
      if (!pdf || !container) return;
      const token = ++renderTokenRef.current;
      const tgt = targetRef.current;
      const restoring = restoreIdx != null;

      observerRef.current?.disconnect();
      container.innerHTML = "";
      livePagesRef.current = [];
      highlightRef.current = null;
      const wraps: HTMLDivElement[] = [];
      pageWrapsRef.current = wraps;

      try {
        // Uniform placeholder height from page 1 (books are uniform; a page
        // that differs corrects itself the moment it renders).
        const page1 = await pdf.getPage(1);
        if (token !== renderTokenRef.current) return;
        const fitWidth = Math.max(container.clientWidth - 16, 400);
        const cssWidth = fitWidth * renderScale;
        const base1 = page1.getViewport({ scale: 1 });
        const estH = (base1.height / base1.width) * cssWidth;
        estHeightRef.current = estH;

        for (let p = 1; p <= pdf.numPages; p++) {
          const wrap = document.createElement("div");
          wrap.className = "pdf-page-wrap";
          wrap.dataset.page = String(p);
          wrap.style.minHeight = `${estH}px`;
          container.appendChild(wrap);
          wraps.push(wrap);
        }

        const obs = new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              if (!e.isIntersecting) continue;
              const p = Number((e.target as HTMLElement).dataset.page);
              if (p >= 1) void renderPage(p, renderTokenRef.current);
            }
          },
          { root: null, rootMargin: `${RENDER_AHEAD_PX}px 0px` },
        );
        wraps.forEach((w) => obs.observe(w));
        observerRef.current = obs;
        setStatus("");

        // Zoom re-render: put the page the reader was on back at the top.
        if (restoring && restoreIdx != null) {
          wraps[Math.min(restoreIdx, wraps.length - 1)]?.scrollIntoView({
            block: "start",
          });
          return;
        }

        if (tgt?.quote) {
          // Find the quote by TEXT (no rasterizing needed), hinted page
          // first — then render that one page and paint the highlight.
          const quote = tgt.quote;
          const order = [...Array(pdf.numPages).keys()].map((i) => i + 1);
          if (tgt.page && tgt.page >= 1 && tgt.page <= pdf.numPages) {
            order.splice(order.indexOf(tgt.page), 1);
            order.unshift(tgt.page);
          }
          let foundPage: number | null = null;
          for (let k = 0; k < order.length; k++) {
            const p = order[k];
            if (token !== renderTokenRef.current) return;
            // A long document takes a while to scan — narrate progress.
            if (k % 50 === 0 && order.length > 100) {
              setStatus(
                `Searching the document for the passage… (page ${k + 1} of ${order.length})`,
              );
            }
            const page = await pdf.getPage(p);
            const { text } = pageSource(await readTextItems(page));
            if (locateQuoteHebrewAware(text, quote)) {
              foundPage = p;
              break;
            }
          }
          if (token === renderTokenRef.current) setStatus("");
          if (token !== renderTokenRef.current) return;
          if (foundPage != null) {
            highlightRef.current = { page: foundPage, quote };
            wraps[foundPage - 1]?.scrollIntoView({ block: "center" });
            await renderPage(foundPage, token);
            // renderPage repainted the highlight; now center on the box.
            const box = wraps[foundPage - 1]?.querySelector(".pdf-hl");
            box?.scrollIntoView({ block: "center", behavior: "smooth" });
          } else {
            setStatus(
              tgt.page
                ? `Couldn't locate the highlighted text — showing page ${tgt.page} instead.`
                : "Couldn't locate the highlighted text in this PDF.",
            );
            if (tgt.page) {
              wraps[Math.min(tgt.page, pdf.numPages) - 1]?.scrollIntoView({
                block: "start",
                behavior: "smooth",
              });
            }
          }
        } else if (tgt?.page) {
          wraps[
            Math.min(Math.max(tgt.page, 1), pdf.numPages) - 1
          ]?.scrollIntoView({ block: "start", behavior: "smooth" });
        }
      } catch (e) {
        if (token === renderTokenRef.current) {
          console.error("PDF render failed:", e);
          setStatus("");
          setFailed(true);
        }
      }
    },
    [renderPage],
  );

  // Load the document once per file/target, then build the lazy pages.
  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;
    setStatus("Rendering PDF…");
    setFailed(false);
    const task = pdfjs.getDocument({ data: base64ToBytes(dataB64) });
    (async () => {
      try {
        const pdf = await task.promise;
        if (cancelled) return;
        pdfRef.current = pdf;
        setNumPages(pdf.numPages);
        await buildPages(scaleRef.current, null);
      } catch (e) {
        if (!cancelled) {
          console.error("PDF open failed:", e);
          setStatus("");
          setFailed(true);
        }
      }
    })();
    return () => {
      cancelled = true;
      renderTokenRef.current++; // cancel any in-flight render
      observerRef.current?.disconnect();
      observerRef.current = null;
      task.destroy();
      pdfRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataB64, targetKey, buildPages]);

  // UX-3: re-render on zoom, debounced, preserving reading position.
  useEffect(() => {
    if (!pdfRef.current) return; // document not loaded yet
    const container = containerRef.current;
    const wraps = pageWrapsRef.current;
    let topIdx = 0;
    if (container && wraps.length) {
      const ref = container.getBoundingClientRect().top;
      for (let i = 0; i < wraps.length; i++) {
        if (wraps[i].getBoundingClientRect().bottom >= ref + 4) {
          topIdx = i;
          break;
        }
      }
    }
    const t = window.setTimeout(() => buildPages(scale, topIdx), 200);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, buildPages]);

  const clamp = (s: number) =>
    Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(s * 100) / 100));
  const zoomIn = useCallback(() => setScale((s) => clamp(s + SCALE_STEP)), []);
  const zoomOut = useCallback(() => setScale((s) => clamp(s - SCALE_STEP)), []);
  const fitWidth = useCallback(() => setScale(1), []);

  // ⌘+ / ⌘- / ⌘0 while the viewer is hovered or focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      const root = rootRef.current;
      const active =
        hoverRef.current || (root ? root.contains(document.activeElement) : false);
      if (!active) return;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomIn();
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        fitWidth();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomIn, zoomOut, fitWidth]);

  return (
    <div
      className="pdf-view"
      ref={rootRef}
      onMouseEnter={() => {
        hoverRef.current = true;
      }}
      onMouseLeave={() => {
        hoverRef.current = false;
      }}
    >
      {failed && (
        <div className="pdf-failed" role="alert">
          <div className="pdf-failed-title">This PDF could not be opened.</div>
          <p className="pdf-failed-body">
            The file may be incomplete or damaged. You can{" "}
            <strong>Export</strong> the original from the toolbar above to
            inspect it, replace it by importing the file again, or{" "}
            <strong>Close</strong> it.
          </p>
        </div>
      )}
      {!failed && (
      <div className="pdf-zoombar">
        <button
          type="button"
          className="pdf-zoom-btn"
          onClick={zoomOut}
          disabled={scale <= MIN_SCALE + 1e-9}
          title="Zoom out (⌘−)"
          aria-label="Zoom out"
        >
          −
        </button>
        <span className="pdf-zoom-pct">{Math.round(scale * 100)}%</span>
        <button
          type="button"
          className="pdf-zoom-btn"
          onClick={zoomIn}
          disabled={scale >= MAX_SCALE - 1e-9}
          title="Zoom in (⌘+)"
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          className="pdf-zoom-fit"
          onClick={fitWidth}
          title="Fit width (⌘0)"
        >
          Fit width
        </button>
        {numPages > 0 && (
          <span className="pdf-page-total">{numPages} pages</span>
        )}
      </div>
      )}
      {status && <div className="viewer-status">{status}</div>}
      {/* Named landmark + page count so assistive tech keeps its bearings
          even when far pages are collapsed to placeholders. */}
      <div
        ref={containerRef}
        className="pdf-pages"
        role="document"
        aria-label={numPages > 0 ? `PDF document, ${numPages} pages` : "PDF document"}
      />
    </div>
  );
}
