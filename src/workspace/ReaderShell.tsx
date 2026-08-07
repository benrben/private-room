import { useCallback, useEffect, useRef, useState } from "react";
import { fileKindLabel, formatSize, type FileMeta, type ViewerKind } from "../api";
import { formatWhen } from "./composer";

/** The document kinds that read as RESEARCH — something you sit with, rather
 * than something you operate.
 *
 * These are the ones the reader shell wraps: a source card at the head of the
 * column and a reading-progress stroke across the top of the scroll. The
 * working formats are deliberately absent — a spreadsheet, a script, a JSON
 * payload or an archive is a thing you act on, and a progress bar over it
 * would be measuring the wrong quantity.
 *
 * Every kind here is also one whose scroller is `.viewer-body` itself. A
 * viewer that owns its own scroll region (the `fill` set in ViewerPane) would
 * leave the stroke reporting the position of a container that never moves. */
export const READER_KINDS = new Set<ViewerKind>([
  "docx",
  "pdf",
  "prose",
  "email",
  "text",
  "markdown",
]);

/**
 * What the ROOM knows about a document, drawn as the card at the head of its
 * reading column.
 *
 * Deliberately not the same card as `PageSource`. That one shows what a saved
 * web page declared ABOUT ITSELF — its site, its byline, its publication date
 * — and it is the better witness whenever it exists, so this card stands down
 * for a file that has one rather than printing a second, thinner version of
 * the same facts beside it.
 *
 * The same "absent means absent" rule applies here as there: a row is drawn
 * only when the room actually recorded the value. There is no "Source:
 * unknown" line, because that reads as a finding rather than as a gap.
 */
export function DocSourceCard({ file }: { file: FileMeta | undefined }) {
  if (!file) return null;
  const rows: { label: string; value: string; hand?: boolean }[] = [
    { label: "Kind", value: fileKindLabel(file) },
    { label: "Size", value: formatSize(file.sizeBytes) },
    { label: "Added", value: formatWhen(file.createdAt), hand: true },
  ];
  // `source` is how the file got here — an import, a download, an agent, a
  // recording. Blank on rows written before it was tracked, and a blank is a
  // gap, so it simply does not draw.
  const origin = file.source?.trim();
  if (origin) rows.push({ label: "From", value: origin });

  return (
    <div
      className="doc-source nb-card"
      role="note"
      aria-label="What this room knows about this document"
    >
      <span className="doc-source-title">{file.name}</span>
      <span className="doc-source-rows">
        {rows.map((r) => (
          <span className="doc-source-fact" key={r.label}>
            <span className="doc-source-label">{r.label}</span>
            {/* A date is handwritten; a kind, a byte count and a provenance
                string are not — the last of those can be any text the source
                supplied, including a non-Latin path. */}
            <span className={r.hand ? "doc-source-when" : "doc-source-value"}>
              {r.value}
            </span>
          </span>
        ))}
      </span>
    </div>
  );
}

/**
 * How far down a document the reader has come, as a fraction from 0 to 1.
 *
 * Measured from the scroll container itself on every scroll and on every
 * resize, so it is the real position and not an estimate: a document short
 * enough not to scroll reports 0 and the stroke stays empty, which is honest —
 * there is no progress to make through a page you can already see whole.
 *
 * Returns a ref to attach to the scroller. Re-measures when `key` changes,
 * because opening a different file in the same container starts a new read.
 */
export function useReadingProgress(key: string): {
  ref: React.RefObject<HTMLDivElement | null>;
  progress: number;
} {
  const ref = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const span = el.scrollHeight - el.clientHeight;
    setProgress(span > 1 ? Math.min(1, Math.max(0, el.scrollTop / span)) : 0);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A new document starts unread even if the container kept its offset.
    setProgress(0);
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    // Documents grow after they mount — a .docx renders section by section, a
    // PDF appends pages — so scrollHeight is not final at the first frame.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [key, measure]);

  return { ref, progress };
}

/**
 * The progress stroke: a marker line drawn left to right across the top of the
 * reading column as the reader moves down it.
 *
 * Inert — `aria-hidden`, no pointer events. It reports a position the reader
 * already knows from the scrollbar; announcing a percentage on every scroll
 * event would be noise in a screen reader, not information.
 */
export function ReadingProgress({ value }: { value: number }) {
  return (
    <div className="doc-progress" aria-hidden>
      <span
        className="doc-progress-ink"
        style={{ transform: `scaleX(${value})` }}
      />
    </div>
  );
}
