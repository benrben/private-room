import { useEffect, useRef, useState } from "react";
import { applyQuoteHighlight, clearQuoteHighlight } from "./highlight";
import "./prose.css";

/**
 * A plain-text document, read as writing.
 *
 * A `.txt` used to open in the CODE EDITOR: a letter, a diary entry or a set
 * of meeting notes rendered in a monospace IDE with a line-number gutter and a
 * "plaintext" language mode. Prose gets prose typography — a measured column,
 * real paragraph spacing, and the same quote highlighting every other reader
 * in the app has. The Edit button still opens the editor for anyone who wants
 * one.
 */
export default function ProseView({
  text,
  quote,
}: {
  text: string;
  quote?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const read = useReadingProgress(ref);
  useEffect(() => {
    if (!quote || !ref.current) return;
    applyQuoteHighlight(ref.current, quote);
    return clearQuoteHighlight;
  }, [text, quote]);

  // Blank lines separate paragraphs; a single newline inside one is a soft
  // wrap the author typed, not a paragraph break.
  const paragraphs = text.split(/\n{2,}/);

  return (
    <div className="prose-view" ref={ref}>
      {/* Reading progress, drawn as a marker stroke across the top of the
          page. Decorative and aria-hidden: it carries no information a
          keyboard or screen-reader user does not already get from the scroll
          position itself, and a live region that announced a percentage on
          every scroll frame would be unusable. Rendered only when the page
          actually scrolls, so a short note never shows a bar that could
          neither move nor mean anything. */}
      {read !== null && (
        <div
          className="rdr-progress"
          aria-hidden
          style={{ "--nb-val": `${read}%` } as React.CSSProperties}
        >
          <i />
        </div>
      )}
      {paragraphs.map((p, i) => (
        <p key={i} dir="auto">
          {p}
        </p>
      ))}
    </div>
  );
}

/**
 * How far down its scroller an element has been read, 0–100, or null when
 * there is nothing to scroll.
 *
 * The document readers do NOT own their scroll container: `.viewer-body` in
 * ViewerPane is what scrolls, and a viewer is handed to it as plain content.
 * So the scroller is found by walking up rather than assumed, which also
 * makes the same hook correct inside the Markdown editor's preview pane,
 * where the scroller IS the viewer's own element.
 *
 * The number is the real `scrollTop / (scrollHeight - clientHeight)`. A
 * progress mark that was decorative — eased, animated, or rounded up to a
 * visible sliver — would be the reader telling the user something it has not
 * measured, which is the one thing this app does not do.
 */
export function useReadingProgress(
  ref: React.RefObject<HTMLElement | null>,
): number | null {
  const [pct, setPct] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scroller = scrollParentOf(el);
    if (!scroller) return;

    const measure = () => {
      const span = scroller.scrollHeight - scroller.clientHeight;
      // Under a pixel of travel is not a scrollable document; showing 0% (or
      // 100%) there would be noise on every short file.
      if (span <= 1) {
        setPct(null);
        return;
      }
      const ratio = scroller.scrollTop / span;
      // Clamped because WebKit reports negative scrollTop during rubber-band
      // overscroll, and a bar that runs backwards past its own start reads as
      // a rendering fault.
      setPct(Math.round(Math.min(1, Math.max(0, ratio)) * 100));
    };

    measure();
    scroller.addEventListener("scroll", measure, { passive: true });
    // The document's own height changes as lazy content lands (KaTeX, a
    // diagram, an image): without this the denominator would be whatever it
    // was on the first frame.
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    ro.observe(el);
    return () => {
      scroller.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [ref]);

  return pct;
}

/** The nearest ancestor that actually scrolls vertically, or null. */
function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let n = el.parentElement; n; n = n.parentElement) {
    const overflow = getComputedStyle(n).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") {
      return n;
    }
  }
  return null;
}
