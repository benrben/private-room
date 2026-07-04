import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { locateQuote } from "./highlight";
import { base64ToBytes } from "./util";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_PAGES = 100;
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
  const hit = locateQuote(text, quote);
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
  const hoverRef = useRef(false);
  const targetRef = useRef(target);
  targetRef.current = target;

  const [status, setStatus] = useState("Rendering PDF…");
  const [scale, setScale] = useState(1);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const targetKey = JSON.stringify(target ?? null);

  /**
   * Render every page into the container at `scale` (1 = fit width),
   * attach per-page copy buttons, then re-run the quote highlight.
   * `restoreIdx` (set on zoom re-renders) scrolls that page back to the
   * top afterwards instead of auto-scrolling to the highlighted match.
   * A monotonic token cancels a render that a newer one has superseded.
   */
  const doRender = useCallback(
    async (renderScale: number, restoreIdx: number | null) => {
      const pdf = pdfRef.current;
      const container = containerRef.current;
      if (!pdf || !container) return;
      const token = ++renderTokenRef.current;
      const tgt = targetRef.current;
      const restoring = restoreIdx != null;

      container.innerHTML = "";
      const pageWraps: HTMLDivElement[] = [];
      pageWrapsRef.current = pageWraps;
      const pages = Math.min(pdf.numPages, MAX_PAGES);

      try {
        for (let p = 1; p <= pages; p++) {
          if (token !== renderTokenRef.current) return;
          const page = await pdf.getPage(p);
          const fitWidth = Math.max(container.clientWidth - 16, 400);
          const cssWidth = fitWidth * renderScale;
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
          const wrap = document.createElement("div");
          wrap.className = "pdf-page-wrap";
          wrap.appendChild(canvas);
          container.appendChild(wrap);
          pageWraps.push(wrap);
          await page.render({ canvas, viewport }).promise;
          if (token !== renderTokenRef.current) return;

          // UX-2: per-page copy button, hidden when the page has no text.
          const pageText = pageTextFromItems(await readTextItems(page));
          if (pageText) wrap.appendChild(makeCopyButton(pageText));

          // Keep the reader's place while pages stream in below.
          if (restoring && p - 1 === restoreIdx) {
            wrap.scrollIntoView({ block: "start" });
          }
        }
        if (token !== renderTokenRef.current) return;
        setStatus(
          pdf.numPages > MAX_PAGES
            ? `Showing first ${MAX_PAGES} of ${pdf.numPages} pages`
            : "",
        );

        if (tgt?.quote) {
          const quote = tgt.quote;
          // Search the hinted page first, then the rest; the match may live
          // on a different page than the hint.
          const runHighlight = async (): Promise<boolean> => {
            const order = [...Array(pages).keys()].map((i) => i + 1);
            if (tgt.page && tgt.page >= 1 && tgt.page <= pages) {
              order.splice(order.indexOf(tgt.page), 1);
              order.unshift(tgt.page);
            }
            for (const p of order) {
              if (token !== renderTokenRef.current) return false;
              const page = await pdf.getPage(p);
              if (
                await highlightQuoteOnPage(page, pageWraps[p - 1], quote, !restoring)
              ) {
                return true;
              }
            }
            return false;
          };
          let found = await runHighlight();
          if (!found && token === renderTokenRef.current) {
            // A freshly-opened page's text layer may not be parsed on the
            // first pass; wait one frame and retry once before giving up.
            await new Promise<void>((r) => requestAnimationFrame(() => r()));
            if (token !== renderTokenRef.current) return;
            found = await runHighlight();
          }
          if (!found && token === renderTokenRef.current && !restoring) {
            setStatus(
              tgt.page
                ? `Couldn't locate the highlighted text — showing page ${tgt.page} instead.`
                : "Couldn't locate the highlighted text in this PDF.",
            );
            if (tgt.page) {
              pageWraps[Math.min(tgt.page, pages) - 1]?.scrollIntoView({
                block: "start",
                behavior: "smooth",
              });
            }
          }
        } else if (tgt?.page && !restoring) {
          pageWraps[Math.min(Math.max(tgt.page, 1), pages) - 1]?.scrollIntoView({
            block: "start",
            behavior: "smooth",
          });
        }

        // UX-3: with every page now rendered at final height, put the page
        // the reader was on before the zoom back at the top of the viewport.
        // (Done here, not only mid-stream, so there is enough scroll room to
        // actually reach it — the mid-loop scroll can fall short.)
        if (restoreIdx != null && token === renderTokenRef.current) {
          pageWraps[restoreIdx]?.scrollIntoView({ block: "start" });
        }
      } catch (e) {
        if (token === renderTokenRef.current) {
          setStatus(`Could not render PDF: ${e}`);
        }
      }
    },
    [],
  );

  // Load the document once per file/target, then render at current scale.
  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;
    setStatus("Rendering PDF…");
    const task = pdfjs.getDocument({ data: base64ToBytes(dataB64) });
    (async () => {
      try {
        const pdf = await task.promise;
        if (cancelled) return;
        pdfRef.current = pdf;
        await doRender(scaleRef.current, null);
      } catch (e) {
        if (!cancelled) setStatus(`Could not render PDF: ${e}`);
      }
    })();
    return () => {
      cancelled = true;
      renderTokenRef.current++; // cancel any in-flight render
      task.destroy();
      pdfRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataB64, targetKey, doRender]);

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
    const t = window.setTimeout(() => doRender(scale, topIdx), 200);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, doRender]);

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
      </div>
      {status && <div className="viewer-status">{status}</div>}
      <div ref={containerRef} className="pdf-pages" />
    </div>
  );
}
