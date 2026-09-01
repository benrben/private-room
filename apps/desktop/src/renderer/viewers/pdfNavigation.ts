import type { MutableRefObject } from "react";
import * as pdfjs from "pdfjs-dist";
import { locateQuoteHebrewAware } from "./highlight";
import { highlightQuoteOnPage, pageSource, readTextItems, type PdfTarget } from "./pdfHighlights";
import type { PdfPageHighlight } from "./pdfRendering";

const RENDER_AHEAD_PX = 1500;

function isTypingIn(element: Element | null): boolean {
  return (
    element instanceof HTMLElement &&
    (element.isContentEditable || element.tagName === "INPUT" || element.tagName === "TEXTAREA")
  );
}

export function viewerIsActive(
  root: HTMLDivElement | null,
  hover: boolean,
  activeElement: Element | null,
): boolean {
  return Boolean(root?.contains(activeElement)) || (hover && !isTypingIn(activeElement));
}

export function pdfShortcut(key: string): "in" | "out" | "fit" | "find" | null {
  const match = [
    { keys: ["+", "="], action: "in" as const },
    { keys: ["-", "_"], action: "out" as const },
    { keys: ["0"], action: "fit" as const },
    { keys: ["f"], action: "find" as const },
  ].find((entry) => entry.keys.includes(key.toLowerCase()));
  return match?.action ?? null;
}

export function runPdfShortcut(
  shortcut: "in" | "out" | "fit" | "find",
  actions: { zoomIn: () => void; zoomOut: () => void; fit: () => void; find: () => void },
) {
  if (shortcut === "in") actions.zoomIn();
  if (shortcut === "out") actions.zoomOut();
  if (shortcut === "fit") actions.fit();
  if (shortcut === "find") actions.find();
}

export function focusFindInput(inputRef: MutableRefObject<HTMLInputElement | null>, select: boolean) {
  inputRef.current?.focus();
  if (select) inputRef.current?.select?.();
}

async function pageMatchesFind(
  pdf: pdfjs.PDFDocumentProxy,
  pageNumber: number,
  needle: string,
) {
  const page = await pdf.getPage(pageNumber);
  const { text } = pageSource(await readTextItems(page));
  return { page, matches: Boolean(locateQuoteHebrewAware(text, needle)) };
}

async function publishFindHit(
  hits: number[],
  pageNumber: number,
  needle: string,
  setHits: (hits: number[]) => void,
  setFindAt: (index: number) => void,
  show: (page: number, quote: string) => Promise<void>,
) {
  hits.push(pageNumber);
  setHits([...hits]);
  if (hits.length === 1) {
    setFindAt(0);
    await show(pageNumber, needle);
  }
}

function cleanupFindPage(wrap: HTMLDivElement | undefined, page: pdfjs.PDFPageProxy) {
  if (wrap?.dataset.rendered !== "1") page.cleanup();
}

type TargetContext = {
  pdfRef: MutableRefObject<pdfjs.PDFDocumentProxy | null>;
  pageWrapsRef: MutableRefObject<HTMLDivElement[]>;
  renderTokenRef: MutableRefObject<number>;
  scanCancelRef: MutableRefObject<boolean>;
  targetRef: MutableRefObject<PdfTarget | undefined>;
  highlightRef: MutableRefObject<PdfPageHighlight>;
  setScan: (scan: { at: number; total: number } | null) => void;
  setStatus: (status: string) => void;
  renderPage: (page: number, token: number) => Promise<void>;
};

function targetPages(pdf: pdfjs.PDFDocumentProxy, target: PdfTarget): number[] {
  const pages = Array.from({ length: pdf.numPages }, (_, index) => index + 1);
  const preferred = target.page;
  if (!preferred || preferred < 1 || preferred > pdf.numPages) return pages;
  return [preferred, ...pages.filter((page) => page !== preferred)];
}

function targetIsCurrent(context: TargetContext, token: number): boolean {
  return token === context.renderTokenRef.current;
}

function targetScanIsCancelled(context: TargetContext): boolean {
  return context.scanCancelRef.current;
}

function targetScanProgress(context: TargetContext, at: number, total: number) {
  if (total > 20 && at % 5 === 0) context.setScan({ at, total });
}

async function targetPageHasQuote(
  context: TargetContext,
  pageNumber: number,
  quote: string,
): Promise<boolean> {
  const pdf = context.pdfRef.current;
  const wrap = context.pageWrapsRef.current[pageNumber - 1];
  if (!pdf) return false;
  const page = await pdf.getPage(pageNumber);
  const { text } = pageSource(await readTextItems(page));
  const matches = Boolean(locateQuoteHebrewAware(text, quote));
  if (!matches && wrap?.dataset.rendered !== "1") page.cleanup();
  return matches;
}

type TargetScanStep = "continue" | "match" | "stop";

async function scanTargetStep(
  context: TargetContext,
  pageNumber: number,
  quote: string,
  at: number,
  total: number,
  token: number,
): Promise<TargetScanStep> {
  if (!targetIsCurrent(context, token)) return "stop";
  if (targetScanIsCancelled(context)) {
    context.setStatus("Search stopped — the document is still open.");
    return "stop";
  }
  targetScanProgress(context, at, total);
  return (await targetPageHasQuote(context, pageNumber, quote)) ? "match" : "continue";
}

async function scanTargetPages(
  context: TargetContext,
  order: number[],
  quote: string,
  token: number,
): Promise<number | null | undefined> {
  for (const [at, pageNumber] of order.entries()) {
    const result = await scanTargetStep(context, pageNumber, quote, at, order.length, token);
    if (result === "match") return pageNumber;
    if (result === "stop") return undefined;
  }
  return null;
}

async function findTargetPage(
  context: TargetContext,
  target: PdfTarget,
  quote: string,
  token: number,
): Promise<number | null | undefined> {
  const pdf = context.pdfRef.current;
  if (!pdf) return null;
  const order = targetPages(pdf, target);
  context.scanCancelRef.current = false;
  if (order.length > 20) context.setScan({ at: 0, total: order.length });
  try {
    return await scanTargetPages(context, order, quote, token);
  } finally {
    context.setScan(null);
  }
}

async function repaintTargetHighlight(
  context: TargetContext,
  pageNumber: number,
  quote: string,
  token: number,
) {
  const pdf = context.pdfRef.current;
  const wrap = context.pageWrapsRef.current[pageNumber - 1];
  if (!pdf || !wrap || wrap.querySelector(".pdf-hl")) return;
  const page = await pdf.getPage(pageNumber);
  if (targetIsCurrent(context, token)) await highlightQuoteOnPage(page, wrap, quote, false);
}

async function showTargetMatch(
  context: TargetContext,
  pageNumber: number,
  quote: string,
  token: number,
) {
  const wrap = context.pageWrapsRef.current[pageNumber - 1];
  context.highlightRef.current = { page: pageNumber, quote };
  wrap?.scrollIntoView({ block: "center" });
  await context.renderPage(pageNumber, token);
  if (!targetIsCurrent(context, token)) return;
  await repaintTargetHighlight(context, pageNumber, quote, token);
  wrap?.querySelector(".pdf-hl")?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function showTargetFallback(context: TargetContext, target: PdfTarget) {
  const pdf = context.pdfRef.current;
  if (!pdf || !target.page) {
    context.setStatus("Couldn't locate the highlighted text in this PDF.");
    return;
  }
  context.setStatus(`Couldn't locate the highlighted text — showing page ${target.page} instead.`);
  context.pageWrapsRef.current[Math.min(target.page, pdf.numPages) - 1]?.scrollIntoView({
    block: "start",
    behavior: "smooth",
  });
}

function showTargetPage(context: TargetContext, page: number) {
  const numPages = context.pdfRef.current?.numPages ?? 0;
  context.pageWrapsRef.current[Math.min(Math.max(page, 1), numPages) - 1]?.scrollIntoView({
    block: "start",
    behavior: "smooth",
  });
}

function targetContextIsReady(context: TargetContext): boolean {
  return Boolean(context.pdfRef.current) && context.pageWrapsRef.current.length > 0;
}

async function applyQuoteTarget(context: TargetContext, target: PdfTarget, token: number) {
  const quote = target.quote;
  if (!quote) return;
  const foundPage = await findTargetPage(context, target, quote, token);
  if (foundPage === undefined || !targetIsCurrent(context, token)) return;
  context.setStatus("");
  if (foundPage != null) await showTargetMatch(context, foundPage, quote, token);
  else showTargetFallback(context, target);
}

export async function applyPdfTarget(context: TargetContext, token: number) {
  const target = context.targetRef.current;
  if (!targetContextIsReady(context) || !target) return;
  if (!target.quote) {
    if (target.page) showTargetPage(context, target.page);
    return;
  }
  await applyQuoteTarget(context, target, token);
}

type PageBuildContext = {
  pdfRef: MutableRefObject<pdfjs.PDFDocumentProxy | null>;
  containerRef: MutableRefObject<HTMLDivElement | null>;
  pageWrapsRef: MutableRefObject<HTMLDivElement[]>;
  renderTokenRef: MutableRefObject<number>;
  observerRef: MutableRefObject<IntersectionObserver | null>;
  livePagesRef: MutableRefObject<number[]>;
  estHeightRef: MutableRefObject<number>;
  highlightRef: MutableRefObject<PdfPageHighlight>;
  findHlRef: MutableRefObject<PdfPageHighlight>;
  setStatus: (status: string) => void;
  setFailed: (failure: "damaged") => void;
  renderPage: (page: number, token: number) => Promise<void>;
  applyTarget: (token: number) => Promise<void>;
};

function pageBuildInputs(context: PageBuildContext) {
  const pdf = context.pdfRef.current;
  const container = context.containerRef.current;
  return pdf && container ? { pdf, container } : null;
}

function resetPageBuild(context: PageBuildContext, restoring: boolean) {
  context.observerRef.current?.disconnect();
  context.containerRef.current?.replaceChildren();
  context.livePagesRef.current = [];
  if (!restoring) {
    context.highlightRef.current = null;
    context.findHlRef.current = null;
  }
}

async function estimatePageHeight(
  pdf: pdfjs.PDFDocumentProxy,
  container: HTMLDivElement,
  scale: number,
): Promise<number> {
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const width = Math.max(container.clientWidth - 16, 400) * scale;
  return (base.height / base.width) * width;
}

function createPagePlaceholders(
  container: HTMLDivElement,
  total: number,
  height: number,
): HTMLDivElement[] {
  const wraps: HTMLDivElement[] = [];
  for (let page = 1; page <= total; page++) {
    const wrap = document.createElement("div");
    wrap.className = "pdf-page-wrap";
    wrap.dataset.page = String(page);
    wrap.style.minHeight = `${height}px`;
    container.appendChild(wrap);
    wraps.push(wrap);
  }
  return wraps;
}

function observePdfPages(
  context: PageBuildContext,
  wraps: HTMLDivElement[],
) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const page = Number((entry.target as HTMLElement).dataset.page);
        if (page >= 1) void context.renderPage(page, context.renderTokenRef.current);
      }
    },
    { root: null, rootMargin: `${RENDER_AHEAD_PX}px 0px` },
  );
  wraps.forEach((wrap) => observer.observe(wrap));
  context.observerRef.current = observer;
}

function restorePagePosition(wraps: HTMLDivElement[], restoreIdx: number | null): boolean {
  if (restoreIdx == null) return false;
  wraps[Math.min(restoreIdx, wraps.length - 1)]?.scrollIntoView({ block: "start" });
  return true;
}

function handlePageBuildFailure(context: PageBuildContext, token: number, error: unknown) {
  if (token !== context.renderTokenRef.current) return;
  console.error("PDF render failed:", error);
  context.setStatus("");
  context.setFailed("damaged");
}

export async function buildPdfPages(
  context: PageBuildContext,
  renderScale: number,
  restoreIdx: number | null,
) {
  const input = pageBuildInputs(context);
  if (!input) return;
  const token = ++context.renderTokenRef.current;
  const restoring = restoreIdx != null;
  resetPageBuild(context, restoring);
  try {
    const height = await estimatePageHeight(input.pdf, input.container, renderScale);
    if (token !== context.renderTokenRef.current) return;
    context.estHeightRef.current = height;
    const wraps = createPagePlaceholders(input.container, input.pdf.numPages, height);
    context.pageWrapsRef.current = wraps;
    observePdfPages(context, wraps);
    context.setStatus("");
    if (!restorePagePosition(wraps, restoreIdx)) await context.applyTarget(token);
  } catch (error) {
    handlePageBuildFailure(context, token, error);
  }
}

type FindRunContext = {
  pdfRef: MutableRefObject<pdfjs.PDFDocumentProxy | null>;
  pageWrapsRef: MutableRefObject<HTMLDivElement[]>;
  findTokenRef: MutableRefObject<number>;
  findForRef: MutableRefObject<string>;
  clearFindBoxes: () => void;
  setFindHits: (hits: number[]) => void;
  setFindAt: (index: number) => void;
  setFinding: (finding: boolean) => void;
  showFindHit: (page: number, quote: string) => Promise<void>;
};

function resetFindSearch(context: FindRunContext, needle: string) {
  context.clearFindBoxes();
  context.setFindHits([]);
  context.setFindAt(0);
  context.findForRef.current = needle;
}

async function scanFindPages(
  context: FindRunContext,
  pdf: pdfjs.PDFDocumentProxy,
  needle: string,
  token: number,
) {
  const hits: number[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    if (token !== context.findTokenRef.current) return;
    const result = await pageMatchesFind(pdf, pageNumber, needle);
    if (result.matches) {
      await publishFindHit(
        hits,
        pageNumber,
        needle,
        context.setFindHits,
        context.setFindAt,
        context.showFindHit,
      );
    }
    cleanupFindPage(context.pageWrapsRef.current[pageNumber - 1], result.page);
  }
}

export async function runPdfFind(context: FindRunContext, raw: string) {
  const pdf = context.pdfRef.current;
  const needle = raw.trim();
  resetFindSearch(context, needle);
  if (!pdf || !needle) return;
  const token = ++context.findTokenRef.current;
  context.setFinding(true);
  try {
    await scanFindPages(context, pdf, needle, token);
  } finally {
    if (token === context.findTokenRef.current) context.setFinding(false);
  }
}
