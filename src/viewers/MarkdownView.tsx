import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { applyQuoteHighlight, clearQuoteHighlight } from "./highlight";

interface Props {
  text: string;
  target?: { quote?: string };
}

export default function MarkdownView({ text, target }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const quote = target?.quote;

  useEffect(() => {
    if (!quote || !ref.current) return;
    applyQuoteHighlight(ref.current, quote);
    return clearQuoteHighlight;
  }, [text, quote]);

  return (
    <div className="md-body" ref={ref}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
