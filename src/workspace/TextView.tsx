import { useEffect, useRef } from "react";
import { applyQuoteHighlight, clearQuoteHighlight } from "../viewers/highlight";

/** Read-only extracted-text preview that can highlight a quoted snippet.
 *
 * These are the words read out of a PDF, a legacy `.doc` or an `.rtf` — the
 * user's PROSE, not source. It is still a `<pre>`, so every space, tab and
 * line break the extractor found is preserved exactly; `.text-extract`
 * (viewer-formats.css) is what stops it inheriting the viewer's monospace
 * rule and reading like an IDE buffer. `dir="auto"` puts a Hebrew or Arabic
 * document the right way round instead of forcing it left-to-right.
 */
export default function TextView({ text, quote }: { text: string; quote?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!quote || !ref.current) return;
    applyQuoteHighlight(ref.current, quote);
    return clearQuoteHighlight;
  }, [text, quote]);
  return (
    <pre className="text-extract" dir="auto" ref={ref}>
      {text}
    </pre>
  );
}
