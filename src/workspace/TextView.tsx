import { useEffect, useRef } from "react";
import { applyQuoteHighlight, clearQuoteHighlight } from "../viewers/highlight";

/** Read-only extracted-text preview that can highlight a quoted snippet. */
export default function TextView({ text, quote }: { text: string; quote?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!quote || !ref.current) return;
    applyQuoteHighlight(ref.current, quote);
    return clearQuoteHighlight;
  }, [text, quote]);
  return <pre ref={ref}>{text}</pre>;
}
