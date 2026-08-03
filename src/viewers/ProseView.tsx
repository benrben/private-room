import { useEffect, useRef } from "react";
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
      {paragraphs.map((p, i) => (
        <p key={i} dir="auto">
          {p}
        </p>
      ))}
    </div>
  );
}
