import { useEffect, useRef, useState } from "react";
import { renderAsync } from "docx-preview";
import { base64ToBytes } from "./PdfView";
import { applyQuoteHighlight, clearQuoteHighlight } from "./highlight";

interface Props {
  dataB64: string;
  target?: { quote?: string };
}

export default function DocxView({ dataB64, target }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const quote = target?.quote;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.innerHTML = "";
    setError("");
    const bytes = base64ToBytes(dataB64);
    let cancelled = false;
    renderAsync(bytes.buffer, container, undefined, {
      inWrapper: true,
      ignoreLastRenderedPageBreak: true,
    })
      .then(() => {
        if (!cancelled && quote) applyQuoteHighlight(container, quote);
      })
      .catch((e) => setError(`Could not render document: ${e}`));
    return () => {
      cancelled = true;
      clearQuoteHighlight();
    };
  }, [dataB64, quote]);

  return (
    <div className="docx-view">
      {error && <div className="viewer-status">{error}</div>}
      <div ref={containerRef} />
    </div>
  );
}
