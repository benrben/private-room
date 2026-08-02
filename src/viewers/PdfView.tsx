import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { locateQuoteHebrewAware, makeReceiptBadge } from "./highlight";
import { base64ToBytes } from "./util";
import "./pdf.css";

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
 *
 * `opts` separates the two callers: a CITATION paints `.pdf-hl` and earns the
 * green receipt badge (the quote was verified on this page); an ordinary
 * ⌘F find paints `.pdf-find-hl` and earns nothing — it is the reader's own
 * search, not a claim about where a sentence came from.
 */
async function highlightQuoteOnPage(
  page: pdfjs.PDFPageProxy,
  wrap: HTMLDivElement,
  quote: string,
  scroll = true,
  opts?: { className?: string; badge?: boolean },
): Promise<boolean> {
  const boxClass = opts?.className ?? "pdf-hl";
  const wantBadge = opts?.badge ?? true;
  // Normalization-tolerant match: locateQuote folds case, whitespace,
  // newlines, soft hyphens, line-end hyphenation and typographic
  // look-alikes, and can span the many items pdf.js splits a line into.
  const items = await readTextItems(page);
  const { text, map } = pageSource(items);
  // Hebrew-aware: visual-order PDFs store lines mirrored — the fallback
  // mirrors them back and still maps the hit to original char positions.
  const hit = locateQuoteHebrewAware(text, quote);
  if (!hit) return false;

  // Overlays go in the page BOX (exactly the page's own coordinate space),
  // never in the wrap, which can be wider than the page.
  const box = wrap.querySelector<HTMLDivElement>(".pdf-page-box");
  const canvas = box?.querySelector("canvas");
  if (!box || !canvas) return false;
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
    hl.className = boxClass;
    hl.style.left = `${tx[4]}px`;
    hl.style.top = `${tx[5] - fontH}px`;
    hl.style.width = `${Math.max((it.width ?? 0) * viewport.scale, 2)}px`;
    hl.style.height = `${fontH * 1.2}px`;
    box.appendChild(hl);
    first = first ?? hl;
  }
  // A painted highlight means locateQuote found the quote verbatim on this
  // page — a receipt. Tag the first box with a green "verified" check.
  if (first && wantBadge) {
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
    box.appendChild(badge);
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
  /** Same, for the ⌘F hit currently being shown: without it, scrolling away
   * from the hit and back in a document long enough for the recycler to bite
   * showed a bare page while the find bar still counted the match. */
  const findHlRef = useRef<{ page: number; quote: string } | null>(null);
  const hoverRef = useRef(false);
  const targetRef = useRef(target);
  targetRef.current = target;

  const [status, setStatus] = useState("Rendering PDF…");
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1);
  // A document that can't be opened gets a calm recovery panel, never a raw
  // exception — the technical error goes to the console for debugging.
  const [failed, setFailed] = useState(false);
  /** Live readout of the "find the quoted passage" scan, so a long search
   * never looks frozen — and can be abandoned. */
  const [scan, setScan] = useState<{ at: number; total: number } | null>(null);
  const scanCancelRef = useRef(false);
  /** Which page is at the top of the viewport, and the jump box's draft. */
  const [curPage, setCurPage] = useState(1);
  const [pageDraft, setPageDraft] = useState("");
  /** ⌘F: find inside THIS document. ⌘F used to open the room-wide search, so
   * the one place a reader expects to search — the page in front of them —
   * was the one place they could not. */
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  /** Pages carrying the searched phrase, and which of them is showing. */
  const [findHits, setFindHits] = useState<number[]>([]);
  const [findAt, setFindAt] = useState(0);
  const [finding, setFinding] = useState(false);
  /** The phrase `findHits` belongs to: Enter steps to the next hit while it is
   * unchanged, and re-scans when it is not. "" = nothing searched yet. */
  const findForRef = useRef("");
  const findInputRef = useRef<HTMLInputElement>(null);
  const findTokenRef = useRef(0);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const targetKey = JSON.stringify(target ?? null);
  const targetKeyRef = useRef(targetKey);
  targetKeyRef.current = targetKey;
  /** The target the pages on screen are already aimed at. */
  const appliedTargetRef = useRef<string | null>(null);

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
        // The page BOX is exactly the page: canvas, selectable text and any
        // quote highlight all share one coordinate space inside it.
        const cssScale = cssWidth / base.width;
        const box = document.createElement("div");
        box.className = "pdf-page-box";
        box.style.width = `${cssWidth}px`;
        box.style.setProperty("--total-scale-factor", String(cssScale));
        box.style.setProperty("--scale-round-x", "1px");
        box.style.setProperty("--scale-round-y", "1px");
        box.appendChild(canvas);
        wrap.replaceChildren(box);
        wrap.style.minHeight = "";
        wrap.dataset.rendered = "1";

        // Selectable text: pdf.js positions transparent spans over the raster,
        // so a sentence can be dragged over and copied like on any web page.
        // Without it a PDF is a picture of words.
        const textLayerDiv = document.createElement("div");
        textLayerDiv.className = "textLayer";
        box.appendChild(textLayerDiv);
        const textLayer = new pdfjs.TextLayer({
          textContentSource: page.streamTextContent(),
          container: textLayerDiv,
          viewport: page.getViewport({ scale: cssScale }),
        });
        await textLayer.render().catch(() => {
          /* a page whose text can't be laid out still shows its raster */
        });
        if (token !== renderTokenRef.current) return;

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
        // Same for the ⌘F hit on screen, so the find bar's count and the page
        // never disagree after a recycle.
        const fh = findHlRef.current;
        if (fh && fh.page === p) {
          await highlightQuoteOnPage(page, wrap, fh.quote, false, {
            className: "pdf-find-hl",
            badge: false,
          });
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

  /** Strip the previous target's highlight boxes and receipt badge, so a
   * second citation doesn't leave the first one painted. */
  const clearHighlightBoxes = useCallback(() => {
    highlightRef.current = null;
    for (const wrap of pageWrapsRef.current) {
      wrap
        .querySelectorAll(".pdf-hl, .pdf-hl-badge")
        .forEach((el) => el.remove());
    }
  }, []);

  /**
   * Aim the viewer at the current target: find the quoted passage by TEXT (no
   * rasterizing needed), hinted page first, then render that one page and
   * paint the highlight. Separate from buildPages so a new citation reuses the
   * document and the pages already on screen.
   */
  const applyTarget = useCallback(
    async (token: number) => {
      const pdf = pdfRef.current;
      const wraps = pageWrapsRef.current;
      const tgt = targetRef.current;
      if (!pdf || wraps.length === 0) return;

      if (tgt?.quote) {
        const quote = tgt.quote;
        const order = [...Array(pdf.numPages).keys()].map((i) => i + 1);
        if (tgt.page && tgt.page >= 1 && tgt.page <= pdf.numPages) {
          order.splice(order.indexOf(tgt.page), 1);
          order.unshift(tgt.page);
        }
        let foundPage: number | null = null;
        scanCancelRef.current = false;
        // Reading every page of a long book is a real wait, and it is the
        // worst wait when the passage isn't there at all: narrate it every few
        // pages (not every fifty, which reads as frozen) and offer a way out.
        const narrate = order.length > 20;
        if (narrate) setScan({ at: 0, total: order.length });
        try {
          for (let k = 0; k < order.length; k++) {
            const p = order[k];
            if (token !== renderTokenRef.current) return;
            if (scanCancelRef.current) {
              setStatus("Search stopped — the document is still open.");
              return;
            }
            if (narrate && k % 5 === 0) setScan({ at: k, total: order.length });
            const page = await pdf.getPage(p);
            const { text } = pageSource(await readTextItems(page));
            if (locateQuoteHebrewAware(text, quote)) {
              foundPage = p;
              break;
            }
            // Release the page's parsed operator list again — scanning a
            // 1,200-page book otherwise grows memory the whole way down.
            if (wraps[p - 1]?.dataset.rendered !== "1") page.cleanup();
          }
        } finally {
          setScan(null);
        }
        if (token !== renderTokenRef.current) return;
        setStatus("");
        if (foundPage != null) {
          highlightRef.current = { page: foundPage, quote };
          const wrap = wraps[foundPage - 1];
          wrap?.scrollIntoView({ block: "center" });
          await renderPage(foundPage, token);
          if (token !== renderTokenRef.current) return;
          // renderPage only paints the highlight while it RASTERIZES a page; a
          // page that was already live — the normal case for a follow-up
          // citation near where the reader already is — bails out of it early,
          // and clearHighlightBoxes has just wiped the previous highlight. So
          // paint it here when it isn't already there, exactly as showFindHit
          // does for its own hits.
          if (wrap && !wrap.querySelector(".pdf-hl")) {
            const page = await pdf.getPage(foundPage);
            if (token !== renderTokenRef.current) return;
            await highlightQuoteOnPage(page, wrap, quote, false);
            if (token !== renderTokenRef.current) return;
          }
          const box = wrap?.querySelector(".pdf-hl");
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
    },
    [renderPage],
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
      const restoring = restoreIdx != null;

      observerRef.current?.disconnect();
      container.innerHTML = "";
      livePagesRef.current = [];
      highlightRef.current = null;
      findHlRef.current = null;
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

        await applyTarget(token);
      } catch (e) {
        if (token === renderTokenRef.current) {
          console.error("PDF render failed:", e);
          setStatus("");
          setFailed(true);
        }
      }
    },
    [renderPage, applyTarget],
  );

  // Load the document ONCE per file, then build the lazy pages. The target is
  // deliberately NOT a dependency: a second quote in an already-open book used
  // to throw away the parsed document, decode the bytes again and rebuild every
  // page — multiple seconds of stall for nothing but a different highlight.
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
        appliedTargetRef.current = targetKeyRef.current;
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
      scanCancelRef.current = true;
      observerRef.current?.disconnect();
      observerRef.current = null;
      task.destroy();
      pdfRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataB64, buildPages]);

  // A NEW target on the already-open document: drop the old highlight and
  // re-aim, reusing every parsed and rasterized page.
  useEffect(() => {
    if (!pdfRef.current || pageWrapsRef.current.length === 0) return;
    if (appliedTargetRef.current === targetKey) return;
    appliedTargetRef.current = targetKey;
    clearHighlightBoxes();
    void applyTarget(renderTokenRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

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

  /** Drop the find highlights (never the citation ones — different class). */
  const clearFindBoxes = useCallback(() => {
    findHlRef.current = null;
    for (const wrap of pageWrapsRef.current) {
      wrap.querySelectorAll(".pdf-find-hl").forEach((el) => el.remove());
    }
  }, []);

  /** Show one hit: scroll its page in, rasterize it, paint the match. */
  const showFindHit = useCallback(
    async (pageNo: number, needle: string) => {
      const pdf = pdfRef.current;
      const wrap = pageWrapsRef.current[pageNo - 1];
      if (!pdf || !wrap) return;
      clearFindBoxes();
      // Remembered so a recycled page repaints this hit on its way back.
      findHlRef.current = { page: pageNo, quote: needle };
      const token = renderTokenRef.current;
      wrap.scrollIntoView({ block: "start" });
      await renderPage(pageNo, token);
      if (token !== renderTokenRef.current) return;
      // renderPage repaints the remembered hit itself when it rasterizes the
      // page fresh; drop that copy so exactly one set of boxes is painted and
      // scrolled to below.
      wrap.querySelectorAll(".pdf-find-hl").forEach((el) => el.remove());
      const page = await pdf.getPage(pageNo);
      if (token !== renderTokenRef.current) return;
      await highlightQuoteOnPage(page, wrap, needle, true, {
        className: "pdf-find-hl",
        badge: false,
      });
    },
    [clearFindBoxes, renderPage],
  );

  /** Search every page for `raw` by TEXT — no rasterizing — then show the
   * first hit. Same normalization the citation highlight uses, so a phrase
   * broken across lines or hyphenated still matches. */
  const runFind = useCallback(
    async (raw: string) => {
      const pdf = pdfRef.current;
      const needle = raw.trim();
      clearFindBoxes();
      setFindHits([]);
      setFindAt(0);
      findForRef.current = needle;
      if (!pdf || !needle) return;
      const token = ++findTokenRef.current;
      setFinding(true);
      const hits: number[] = [];
      try {
        for (let p = 1; p <= pdf.numPages; p++) {
          if (token !== findTokenRef.current) return;
          const page = await pdf.getPage(p);
          const { text } = pageSource(await readTextItems(page));
          if (locateQuoteHebrewAware(text, needle)) hits.push(p);
          // Same memory discipline as the citation scan: a page parsed only
          // to be read is released again.
          if (pageWrapsRef.current[p - 1]?.dataset.rendered !== "1") page.cleanup();
        }
      } finally {
        if (token === findTokenRef.current) setFinding(false);
      }
      if (token !== findTokenRef.current) return;
      setFindHits(hits);
      setFindAt(0);
      if (hits.length > 0) await showFindHit(hits[0], needle);
    },
    [clearFindBoxes, showFindHit],
  );

  /** Next/previous hit, wrapping at both ends. */
  const stepFind = useCallback(
    (delta: number) => {
      if (findHits.length === 0) return;
      const next = (findAt + delta + findHits.length) % findHits.length;
      setFindAt(next);
      void showFindHit(findHits[next], findForRef.current);
    },
    [findAt, findHits, showFindHit],
  );

  const closeFind = useCallback(() => {
    findTokenRef.current++; // abandon a scan still running
    setFinding(false);
    setFindOpen(false);
    setFindHits([]);
    setFindAt(0);
    findForRef.current = "";
    clearFindBoxes();
  }, [clearFindBoxes]);

  /** Scroll a 1-based page to the top of the viewer. */
  const goToPage = useCallback((p: number) => {
    const wraps = pageWrapsRef.current;
    if (wraps.length === 0) return;
    const idx = Math.min(Math.max(Math.round(p), 1), wraps.length) - 1;
    wraps[idx]?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);

  // Which page am I on? The toolbar used to show only a total, so in a long
  // document there was no way to tell where you were or to jump anywhere.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const wraps = pageWrapsRef.current;
      if (wraps.length === 0) return;
      const top = container.getBoundingClientRect().top;
      for (let i = 0; i < wraps.length; i++) {
        if (wraps[i].getBoundingClientRect().bottom >= top + 4) {
          setCurPage(i + 1);
          return;
        }
      }
      setCurPage(wraps.length);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    // The scroll may happen on this element or on an ancestor pane; capture.
    window.addEventListener("scroll", onScroll, true);
    measure();
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [numPages]);

  const clamp = (s: number) =>
    Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(s * 100) / 100));
  const zoomIn = useCallback(() => setScale((s) => clamp(s + SCALE_STEP)), []);
  const zoomOut = useCallback(() => setScale((s) => clamp(s - SCALE_STEP)), []);
  const fitWidth = useCallback(() => setScale(1), []);

  // ⌘+ / ⌘- / ⌘0 / ⌘F while the viewer is hovered or focused.
  //
  // CAPTURE phase on purpose: the workspace's own ⌘F (the room-wide search)
  // listens on the window too, and it checks `defaultPrevented`. Claiming the
  // key here — before any bubble listener runs — is what lets the document in
  // front of the reader answer ⌘F instead of the room.
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
      } else if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFindOpen(true);
        // After the bar has mounted; select so a second ⌘F retypes.
        window.setTimeout(() => {
          findInputRef.current?.focus();
          findInputRef.current?.select();
        }, 0);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
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
          <label className="pdf-page-jump">
            Page
            <input
              type="text"
              inputMode="numeric"
              aria-label={`Page number, ${numPages} pages in this document`}
              value={pageDraft === "" ? String(curPage) : pageDraft}
              onChange={(e) => setPageDraft(e.target.value.replace(/\D/g, ""))}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={() => setPageDraft("")}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const n = parseInt(pageDraft, 10);
                if (!Number.isNaN(n)) goToPage(n);
                setPageDraft("");
                e.currentTarget.blur();
              }}
            />
            <span className="pdf-page-total">of {numPages}</span>
          </label>
        )}
        <button
          type="button"
          className="pdf-zoom-fit"
          onClick={() => {
            setFindOpen(true);
            window.setTimeout(() => findInputRef.current?.focus(), 0);
          }}
          title="Find in this document (⌘F)"
        >
          Find
        </button>
      </div>
      )}
      {!failed && findOpen && (
        <div className="pdf-findbar" role="search">
          <input
            ref={findInputRef}
            type="text"
            className="pdf-find-input"
            dir="auto"
            placeholder="Find in this document"
            aria-label="Find in this document"
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                closeFind();
                return;
              }
              if (e.key !== "Enter") return;
              e.preventDefault();
              // Enter searches a new phrase, and steps through the hits of one
              // already searched (Shift+Enter goes back) — what every find bar
              // does, and it saves re-reading the whole document per hit.
              if (findQuery.trim() && findQuery.trim() === findForRef.current) {
                stepFind(e.shiftKey ? -1 : 1);
              } else {
                void runFind(findQuery);
              }
            }}
          />
          <span className="pdf-find-count" role="status">
            {finding
              ? "Searching…"
              : findForRef.current === "" || findQuery.trim() !== findForRef.current
                ? ""
                : findHits.length === 0
                  ? "No matches"
                  : `Page ${findHits[findAt]} · ${findAt + 1} of ${findHits.length}`}
          </span>
          <button
            type="button"
            className="pdf-zoom-btn"
            onClick={() => stepFind(-1)}
            disabled={findHits.length === 0}
            title="Previous match (⇧⏎)"
            aria-label="Previous match"
          >
            ↑
          </button>
          <button
            type="button"
            className="pdf-zoom-btn"
            onClick={() => stepFind(1)}
            disabled={findHits.length === 0}
            title="Next match (⏎)"
            aria-label="Next match"
          >
            ↓
          </button>
          <button
            type="button"
            className="pdf-zoom-btn"
            onClick={closeFind}
            title="Close the find bar (Esc)"
            aria-label="Close the find bar"
          >
            ✕
          </button>
        </div>
      )}
      {/* A long, possibly fruitless scan gets a moving readout and a way out
          — the old one repainted every 50 pages and could not be stopped. */}
      {scan && (
        <div className="viewer-status pdf-scan" role="status">
          <span>
            Searching for the passage… page {scan.at + 1} of {scan.total}
          </span>
          <span className="pdf-scan-bar" aria-hidden>
            <i style={{ width: `${Math.round((scan.at / scan.total) * 100)}%` }} />
          </span>
          <button
            type="button"
            className="subtle"
            onClick={() => {
              scanCancelRef.current = true;
            }}
          >
            Cancel
          </button>
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
