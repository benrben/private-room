import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
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

  /** A link inside a note or an AI answer must NEVER navigate the app's own
   * window — there is no back button and back-swipes are off, so it would
   * strand the user on a web page until they quit. Hand http(s)/mailto to the
   * real browser instead and swallow everything else. */
  function onClick(e: React.MouseEvent<HTMLDivElement>) {
    const anchor = (e.target as HTMLElement | null)?.closest?.("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    e.preventDefault();
    if (/^(https?|mailto):/i.test(href)) void openUrl(href).catch(() => {});
  }

  return (
    <div className="md-body" ref={ref} onClick={onClick}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
