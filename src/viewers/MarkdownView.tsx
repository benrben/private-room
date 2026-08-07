import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { applyQuoteHighlight, clearQuoteHighlight } from "./highlight";
import Mermaid from "./Mermaid";
import { loadRichPlugins, RichPlugins, richPluginsIfLoaded } from "./markdownRich";
import "./markdown.css";

interface Props {
  text: string;
  target?: { quote?: string };
}

/** Rendered Markdown.
 *
 * Beyond GitHub-flavoured tables and task lists this now covers the three
 * things notes are actually written in and which used to come out as raw
 * source: `$…$` maths (KaTeX), fenced code (highlighted), and ```mermaid
 * diagrams. All three render on-device — KaTeX ships its own fonts, the
 * highlighter is a local grammar set, and Mermaid draws inline SVG — so
 * nothing here reaches the network, which is the whole point of the app.
 *
 * Maths and highlighting load in a SECOND chunk (see `markdownRich.ts`): this
 * component renders every chat message, so importing them here statically
 * would put ~700 KB in the app's first chunk and charge every cold start for
 * them. The first paint has tables and lists; maths and colours follow a beat
 * later, once per session.
 */
export default function MarkdownView({ text, target }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const quote = target?.quote;
  // Already loaded (any earlier message in the session) → no un-highlighted
  // pass at all for this one.
  const [rich, setRich] = useState<RichPlugins | null>(richPluginsIfLoaded);

  useEffect(() => {
    if (rich) return;
    let alive = true;
    void loadRichPlugins().then((p) => {
      if (alive) setRich(p);
    });
    return () => {
      alive = false;
    };
  }, [rich]);

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

  const components = useMemo(
    () => ({
      // A ```mermaid fence is a DIAGRAM, not a code sample. Everything else
      // keeps the highlighter's output untouched.
      code({ className, children }: { className?: string; children?: React.ReactNode }) {
        const lang = /language-(\w+)/.exec(className ?? "")?.[1];
        if (lang === "mermaid") {
          return <Mermaid source={String(children ?? "")} />;
        }
        return <code className={className}>{children}</code>;
      },
      // A wide table scrolls inside its own box rather than widening the
      // document (or the chat bubble) around it. Presentational only — the
      // table, its cells and its reading order are untouched, so a screen
      // reader and the quote-highlighter both see exactly what they did.
      table({ children }: { children?: React.ReactNode }) {
        return (
          <div className="md-table-scroll">
            <table>{children}</table>
          </div>
        );
      },
    }),
    [],
  );

  return (
    <div className="md-body" ref={ref} onClick={onClick}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, ...(rich?.remarkPlugins ?? [])]}
        rehypePlugins={rich?.rehypePlugins ?? []}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
