import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { normalizeForMatch } from "./highlight";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_PAGES = 100;

export function base64ToBytes(b64: string): Uint8Array {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export interface PdfTarget {
  page?: number;
  quote?: string;
}

interface TextItem {
  str?: string;
  width?: number;
  transform: number[];
}

/**
 * Find `quote` in a page's text items and paint absolutely-positioned
 * highlight divs over the canvas. Item-level granularity: every text run
 * the match passes through gets a box.
 */
async function highlightQuoteOnPage(
  page: pdfjs.PDFPageProxy,
  wrap: HTMLDivElement,
  quote: string,
): Promise<boolean> {
  const needle = normalizeForMatch(quote);
  if (!needle) return false;
  const content = await page.getTextContent();
  const items = content.items as TextItem[];
  let hay = "";
  const itemOf: number[] = [];
  let lastWasSpace = true;
  items.forEach((it, idx) => {
    for (const ch of `${it.str ?? ""} `) {
      if (/\s/.test(ch)) {
        if (!lastWasSpace) {
          hay += " ";
          itemOf.push(idx);
          lastWasSpace = true;
        }
      } else {
        hay += ch.toLowerCase().charAt(0);
        itemOf.push(idx);
        lastWasSpace = false;
      }
    }
  });
  const at = hay.indexOf(needle);
  if (at < 0) return false;

  const canvas = wrap.querySelector("canvas");
  if (!canvas) return false;
  const cssWidth = parseFloat(canvas.style.width) || canvas.clientWidth;
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: cssWidth / base.width });
  const matched = [...new Set(itemOf.slice(at, at + needle.length))];
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
  first?.scrollIntoView({ block: "center", behavior: "smooth" });
  return first != null;
}

export default function PdfView({
  dataB64,
  target,
}: {
  dataB64: string;
  target?: PdfTarget;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Rendering PDF…");
  const targetKey = JSON.stringify(target ?? null);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;
    container.innerHTML = "";
    const task = pdfjs.getDocument({ data: base64ToBytes(dataB64) });
    (async () => {
      try {
        const pdf = await task.promise;
        const pages = Math.min(pdf.numPages, MAX_PAGES);
        const pageWraps: HTMLDivElement[] = [];
        for (let p = 1; p <= pages; p++) {
          if (cancelled) return;
          const page = await pdf.getPage(p);
          const cssWidth = Math.max(container.clientWidth - 16, 400);
          const base = page.getViewport({ scale: 1 });
          const dpr = window.devicePixelRatio || 1;
          const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr });
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
        }
        if (cancelled) return;
        setStatus(
          pdf.numPages > MAX_PAGES
            ? `Showing first ${MAX_PAGES} of ${pdf.numPages} pages`
            : "",
        );
        if (target?.quote) {
          // Try the hinted page first, then the rest.
          const order = [...Array(pages).keys()].map((i) => i + 1);
          if (target.page && target.page >= 1 && target.page <= pages) {
            order.splice(order.indexOf(target.page), 1);
            order.unshift(target.page);
          }
          let found = false;
          for (const p of order) {
            if (cancelled) return;
            const page = await pdf.getPage(p);
            if (await highlightQuoteOnPage(page, pageWraps[p - 1], target.quote)) {
              found = true;
              break;
            }
          }
          if (!found && target.page) {
            pageWraps[Math.min(target.page, pages) - 1]?.scrollIntoView({
              block: "start",
              behavior: "smooth",
            });
          }
        } else if (target?.page) {
          pageWraps[Math.min(Math.max(target.page, 1), pages) - 1]?.scrollIntoView({
            block: "start",
            behavior: "smooth",
          });
        }
      } catch (e) {
        if (!cancelled) setStatus(`Could not render PDF: ${e}`);
      }
    })();
    return () => {
      cancelled = true;
      task.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataB64, targetKey]);

  return (
    <div className="pdf-view">
      {status && <div className="viewer-status">{status}</div>}
      <div ref={containerRef} />
    </div>
  );
}
