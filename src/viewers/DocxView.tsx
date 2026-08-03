import { useEffect, useRef, useState } from "react";
import { renderAsync } from "docx-preview";
import { useFileBytes } from "./useFileBytes";
import { applyQuoteHighlight, clearQuoteHighlight } from "./highlight";

interface Props {
  /** Streaming token for the file's bytes (roommedia://). */
  mediaToken?: string | null;
  /** Legacy base64 payload — honoured if byte delivery is ever switched back. */
  dataB64?: string | null;
  target?: { quote?: string };
}

export default function DocxView({ mediaToken, dataB64, target }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const quote = target?.quote;
  const { bytes, error: readError, loading } = useFileBytes(mediaToken, dataB64);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !bytes) return;
    container.innerHTML = "";
    setError("");
    let cancelled = false;
    renderAsync(bytes.slice().buffer, container, undefined, {
      // Word's own page breaks, headers, footers, footnotes and endnotes are
      // all in the file; rendering them is what makes the preview read as the
      // document rather than as one endless column of paragraphs.
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      renderComments: true,
      // Numbering and change bars only mean anything with the real styles on.
      ignoreWidth: false,
      ignoreHeight: false,
      experimental: true,
    })
      .then(() => {
        if (!cancelled && quote) applyQuoteHighlight(container, quote);
      })
      .catch((e) => setError(`Could not render document: ${e}`));
    return () => {
      cancelled = true;
      clearQuoteHighlight();
    };
  }, [bytes, quote]);

  return (
    <div className="docx-view">
      {loading && <div className="viewer-status">Opening document…</div>}
      {(error || readError) && <div className="viewer-status">{error || readError}</div>}
      <div ref={containerRef} />
    </div>
  );
}
