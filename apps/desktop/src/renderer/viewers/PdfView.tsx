import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useFileBytes } from "./useFileBytes";
import "./pdf.css";
import { highlightQuoteOnPage, type PdfTarget } from "./pdfHighlights";
import { renderPdfPage } from "./pdfRendering";
import { applyPdfTarget, buildPdfPages, focusFindInput, pdfShortcut, runPdfFind, runPdfShortcut, viewerIsActive } from "./pdfNavigation";
import { PdfFailurePanels, PdfFindPanel, PdfPages, PdfProgress, PdfScanStatus, PdfToolbar } from "./PdfControls";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const SCALE_STEP = 0.25;

export default function PdfView({
  mediaToken,
  dataB64,
  target,
}: {
  /** Streaming token for the file's bytes (roommedia://). */
  mediaToken?: string | null;
  /** Legacy base64 payload — honoured if byte delivery is ever switched back. */
  dataB64?: string | null;
  target?: PdfTarget;
}) {
  const { bytes: fileBytes, error: readError, loading: readLoading } =
    useFileBytes(mediaToken, dataB64);
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
  // exception — the technical error goes to the console for debugging. WHICH
  // panel matters: an encrypted PDF is not a damaged one, and telling its
  // reader to re-import it sends them round a loop that cannot end.
  const [failed, setFailed] = useState<null | "damaged" | "locked">(null);
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
    (page: number, token: number) =>
      renderPdfPage(
        {
          pdfRef,
          containerRef,
          pageWrapsRef,
          renderTokenRef,
          livePagesRef,
          scaleRef,
          highlightRef,
          findHlRef,
          recyclePage,
        },
        page,
        token,
      ),
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
    (token: number) =>
      applyPdfTarget(
        {
          pdfRef,
          pageWrapsRef,
          renderTokenRef,
          scanCancelRef,
          targetRef,
          highlightRef,
          setScan,
          setStatus,
          renderPage,
        },
        token,
      ),
    [renderPage],
  );

  /**
   * Build one fixed-height placeholder per page — every page of the
   * document, however many — and arm an IntersectionObserver that renders
   * pages as they approach the viewport. `restoreIdx` (set on zoom
   * re-renders) scrolls that page back to the top afterwards.
   */
  const buildPages = useCallback(
    (renderScale: number, restoreIdx: number | null) =>
      buildPdfPages(
        {
          pdfRef,
          containerRef,
          pageWrapsRef,
          renderTokenRef,
          observerRef,
          livePagesRef,
          estHeightRef,
          highlightRef,
          findHlRef,
          setStatus,
          setFailed,
          renderPage,
          applyTarget,
        },
        renderScale,
        restoreIdx,
      ),
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
    if (!fileBytes) return;
    setStatus("Rendering PDF…");
    setFailed(null);
    // `slice()` hands pdf.js its own copy: it TRANSFERS the buffer it is given
    // to the worker, which would detach the shared streamed array and leave a
    // reopened document reading zero bytes.
    const task = pdfjs.getDocument({ data: fileBytes.slice() });
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
          // pdf.js rejects an encrypted document with a PasswordException, and
          // this viewer never asks for a password. That is not damage: calling
          // it damage offered three remedies (re-import, export, close) that
          // cannot work, and re-importing produced the same panel for ever.
          const locked = (e as { name?: string } | null)?.name === "PasswordException";
          setFailed(locked ? "locked" : "damaged");
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
  }, [fileBytes, buildPages]);

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
    (raw: string) =>
      runPdfFind(
        {
          pdfRef,
          pageWrapsRef,
          findTokenRef,
          findForRef,
          clearFindBoxes,
          setFindHits,
          setFindAt,
          setFinding,
          showFindHit,
        },
        raw,
      ),
    [clearFindBoxes, showFindHit],
  );

  // THE bug behind "Find is broken": `runFind` had exactly one call site — the
  // Enter key. Typing set `findQuery` and nothing else, so `findHits` stayed
  // empty, both nav buttons stayed `disabled`, and the count area rendered an
  // empty string. Nothing on screen said Enter was required, so the box read as
  // dead. Live QA reported it as "searching for `prose` left Previous and Next
  // disabled" — which is exactly what it did, on a document that contains the
  // word.
  //
  // Search as you type instead, debounced so a fast typist does not start a
  // scan per keystroke. `runFind` already bumps `findTokenRef`, so a superseded
  // scan abandons itself and only the newest writes state.
  useEffect(() => {
    if (!findOpen) return;
    const q = findQuery.trim();
    // Enter is STEPPING through results for a query already searched, not
    // re-running it — leave that to the key handler.
    if (q === findForRef.current) return;
    // One or two characters match nearly everything and cost a full parse of the
    // document to prove it. Clear rather than scan.
    if (q.length < 2) {
      findTokenRef.current++;
      setFinding(false);
      setFindHits([]);
      setFindAt(0);
      findForRef.current = q;
      clearFindBoxes();
      return;
    }
    const t = window.setTimeout(() => void runFind(findQuery), 250);
    return () => window.clearTimeout(t);
  }, [findQuery, findOpen, runFind, clearFindBoxes]);

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
  const openFind = useCallback(() => {
    setFindOpen(true);
    window.setTimeout(() => focusFindInput(findInputRef, false), 0);
  }, []);
  const openFindShortcut = useCallback(() => {
    setFindOpen(true);
    window.setTimeout(() => focusFindInput(findInputRef, true), 0);
  }, []);

  // ⌘+ / ⌘- / ⌘0 / ⌘F while the viewer is focused, or hovered with the caret
  // nowhere — see `typing` below.
  //
  // CAPTURE phase on purpose: the workspace's own ⌘F (the room-wide search)
  // listens on the window too, and it checks `defaultPrevented`. Claiming the
  // key here — before any bubble listener runs — is what lets the document in
  // front of the reader answer ⌘F instead of the room.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (!viewerIsActive(rootRef.current, hoverRef.current, document.activeElement)) return;
      const shortcut = pdfShortcut(e.key);
      if (!shortcut) return;
      e.preventDefault();
      runPdfShortcut(shortcut, {
        zoomIn,
        zoomOut,
        fit: fitWidth,
        find: openFindShortcut,
      });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [zoomIn, zoomOut, fitWidth, openFindShortcut]);

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
      <PdfFailurePanels readError={readError} readLoading={readLoading} failed={failed} />
      <PdfProgress failed={failed} currentPage={curPage} totalPages={numPages} />
      <PdfToolbar
        failed={failed}
        scale={scale}
        totalPages={numPages}
        currentPage={curPage}
        pageDraft={pageDraft}
        setPageDraft={setPageDraft}
        zoomIn={zoomIn}
        zoomOut={zoomOut}
        fitWidth={fitWidth}
        goToPage={goToPage}
        openFind={openFind}
      />
      <PdfFindPanel
        failed={failed}
        open={findOpen}
        inputRef={findInputRef}
        query={findQuery}
        finding={finding}
        hits={findHits}
        at={findAt}
        setQuery={setFindQuery}
        closeFind={closeFind}
        stepFind={stepFind}
        runFind={runFind}
        findForRef={findForRef}
      />
      <PdfScanStatus scan={scan} cancel={() => { scanCancelRef.current = true; }} />
      {status && <div className="viewer-status">{status}</div>}
      <PdfPages containerRef={containerRef} totalPages={numPages} />
    </div>
  );
}
