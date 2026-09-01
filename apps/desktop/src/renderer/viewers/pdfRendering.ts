import type { MutableRefObject } from "react";
import * as pdfjs from "pdfjs-dist";
import { highlightQuoteOnPage, makeCopyButton, pageTextFromItems, readTextItems } from "./pdfHighlights";

const MAX_LIVE_PAGES = 28;

export type PdfPageHighlight = { page: number; quote: string } | null;

type PageRenderContext = {
  pdfRef: MutableRefObject<pdfjs.PDFDocumentProxy | null>;
  containerRef: MutableRefObject<HTMLDivElement | null>;
  pageWrapsRef: MutableRefObject<HTMLDivElement[]>;
  renderTokenRef: MutableRefObject<number>;
  livePagesRef: MutableRefObject<number[]>;
  scaleRef: MutableRefObject<number>;
  highlightRef: MutableRefObject<PdfPageHighlight>;
  findHlRef: MutableRefObject<PdfPageHighlight>;
  recyclePage: (page: number) => void;
};

function pageRenderInputs(context: PageRenderContext, page: number) {
  const pdf = context.pdfRef.current;
  const container = context.containerRef.current;
  const wrap = context.pageWrapsRef.current[page - 1];
  return pdf && container && wrap ? { pdf, container, wrap } : null;
}

function pageIsCurrent(context: PageRenderContext, token: number): boolean {
  return token === context.renderTokenRef.current;
}

function touchLivePage(context: PageRenderContext, page: number): boolean {
  const wrap = context.pageWrapsRef.current[page - 1];
  if (!wrap || (wrap.dataset.rendered !== "1" && wrap.dataset.rendering !== "1")) return false;
  const live = context.livePagesRef.current;
  const index = live.indexOf(page);
  if (index >= 0) live.splice(index, 1);
  live.push(page);
  return true;
}

function canvasForPage(
  page: pdfjs.PDFPageProxy,
  container: HTMLDivElement,
  scale: number,
) {
  const fitWidth = Math.max(container.clientWidth - 16, 400);
  const cssWidth = fitWidth * scale;
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({
    scale: (cssWidth / base.width) * (window.devicePixelRatio || 1),
  });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = `${cssWidth}px`;
  canvas.className = "pdf-page";
  return { base, canvas, cssWidth, viewport };
}

function mountPageBox(wrap: HTMLDivElement, canvas: HTMLCanvasElement, cssScale: number) {
  const box = document.createElement("div");
  box.className = "pdf-page-box";
  box.style.width = canvas.style.width;
  box.style.setProperty("--total-scale-factor", String(cssScale));
  box.style.setProperty("--scale-round-x", "1px");
  box.style.setProperty("--scale-round-y", "1px");
  box.appendChild(canvas);
  wrap.replaceChildren(box);
  wrap.style.minHeight = "";
  wrap.dataset.rendered = "1";
  return box;
}

async function renderRasterizedPage(
  context: PageRenderContext,
  pageNumber: number,
  token: number,
  input: { pdf: pdfjs.PDFDocumentProxy; container: HTMLDivElement; wrap: HTMLDivElement },
) {
  const page = await input.pdf.getPage(pageNumber);
  if (!pageIsCurrent(context, token)) return null;
  const raster = canvasForPage(page, input.container, context.scaleRef.current);
  await page.render({ canvas: raster.canvas, viewport: raster.viewport }).promise;
  if (!pageIsCurrent(context, token)) return null;
  const box = mountPageBox(input.wrap, raster.canvas, raster.cssWidth / raster.base.width);
  return { box, page, wrap: input.wrap, cssScale: raster.cssWidth / raster.base.width };
}

async function addSelectableText(
  page: pdfjs.PDFPageProxy,
  box: HTMLDivElement,
  cssScale: number,
) {
  const container = document.createElement("div");
  container.className = "textLayer";
  box.appendChild(container);
  const layer = new pdfjs.TextLayer({
    textContentSource: page.streamTextContent(),
    container,
    viewport: page.getViewport({ scale: cssScale }),
  });
  await layer.render().catch(() => {});
}

async function addCopyControl(
  context: PageRenderContext,
  page: pdfjs.PDFPageProxy,
  wrap: HTMLDivElement,
  token: number,
) {
  const text = pageTextFromItems(await readTextItems(page));
  if (!pageIsCurrent(context, token) || !text) return;
  wrap.appendChild(makeCopyButton(text));
}

async function repaintPageHighlights(
  context: PageRenderContext,
  page: pdfjs.PDFPageProxy,
  wrap: HTMLDivElement,
  pageNumber: number,
) {
  const citation = context.highlightRef.current;
  if (citation?.page === pageNumber) {
    await highlightQuoteOnPage(page, wrap, citation.quote, false);
  }
  const find = context.findHlRef.current;
  if (find?.page === pageNumber) {
    await highlightQuoteOnPage(page, wrap, find.quote, false, {
      className: "pdf-find-hl",
      badge: false,
    });
  }
}

function recycleDistantPages(context: PageRenderContext, page: number) {
  const live = context.livePagesRef.current;
  live.push(page);
  if (live.length <= MAX_LIVE_PAGES) return;
  live.sort((a, b) => Math.abs(b - page) - Math.abs(a - page));
  while (live.length > MAX_LIVE_PAGES) {
    const victim = live.shift();
    if (victim != null && victim !== page) context.recyclePage(victim);
  }
}

export async function renderPdfPage(context: PageRenderContext, page: number, token: number): Promise<void> {
  const input = pendingPageRender(context, page, token);
  if (!input) return;
  input.wrap.dataset.rendering = "1";
  try {
    const rendered = await renderRasterizedPage(context, page, token, input);
    if (!rendered) return;
    await addSelectableText(rendered.page, rendered.box, rendered.cssScale);
    if (!pageIsCurrent(context, token)) return;
    await addCopyControl(context, rendered.page, rendered.wrap, token);
    if (!pageIsCurrent(context, token)) return;
    await repaintPageHighlights(context, rendered.page, rendered.wrap, page);
    recycleDistantPages(context, page);
  } finally {
    delete input.wrap.dataset.rendering;
  }
}

function pendingPageRender(context: PageRenderContext, page: number, token: number) {
  const input = pageRenderInputs(context, page);
  if (!input || !pageIsCurrent(context, token) || touchLivePage(context, page)) return null;
  return input;
}
