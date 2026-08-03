import { useEffect, useState } from "react";
import { api } from "../api";
import TextView from "../workspace/TextView";
import { frameIsDark } from "./frameTheme";
import QuickLookView from "./QuickLookView";
import "./officedoc.css";

/**
 * A legacy `.doc` or `.rtf`, rendered with its real formatting.
 *
 * These used to reach the plain-text card: the words in order, in one
 * undifferentiated column, with every heading, weight, size, colour and
 * alignment gone. (Before that they had no text at all unless the reader
 * happened to have installed a third-party converter.)
 *
 * macOS has read Word documents since TextEdit did, so the backend hands the
 * file to that importer and gets back HTML with a real stylesheet — fonts,
 * sizes, weights, colours, alignment, lists. It renders in the app's
 * `roomdoc://` sandbox, the same isolated origin the HTML runner and the book
 * reader use: `default-src 'none'`, so the document displays as written while
 * script and network access are impossible.
 *
 * Unlike a Quick Look image this keeps every page AND keeps the text real —
 * selectable, and readable by a screen reader.
 */
export default function OfficeDocView({
  fileId,
  text,
  quote,
}: {
  fileId: string;
  /** The extracted text, as the fallback and for quote highlighting. */
  text: string | null;
  quote?: string;
}) {
  const [url, setUrl] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "none" | "error">("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let alive = true;
    setState("loading");
    setUrl("");
    (async () => {
      try {
        const html = await api.officeHtml(fileId);
        if (!alive) return;
        if (!html) {
          setState("none");
          return;
        }
        const token = await api.stagePreviewHtml(wrap(html, frameIsDark()));
        if (!alive) return;
        setUrl(`roomdoc://localhost/${token}`);
        setState("ready");
      } catch (e) {
        if (!alive) return;
        setMessage(String(e));
        setState("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [fileId]);

  if (state === "ready" && url) {
    return (
      <div className="odoc-view">
        <iframe
          key={url}
          className="odoc-frame"
          // No allow-scripts: a document is prose. The sandbox's CSP already
          // forbids script; withholding the permission too means the frame is
          // opaque even if that CSP ever changed.
          sandbox=""
          src={url}
          title="Document"
        />
      </div>
    );
  }
  if (state === "loading") {
    return <div className="empty-hint">Opening document…</div>;
  }
  // macOS couldn't import it: fall back to the text we did read, with the
  // Quick Look page under it — strictly more than this format used to get.
  return (
    <QuickLookView fileId={fileId}>
      {state === "error" && (
        <div className="viewer-status">
          This document's formatting could not be read ({message}) — its text is
          below.
        </div>
      )}
      {text ? <TextView text={text} quote={quote} /> : null}
    </QuickLookView>
  );
}

/** Give the imported HTML a readable page: a measured column, the APP's
 * light/dark setting, and images that can't overflow. The document's OWN
 * stylesheet comes after, so it wins wherever it has an opinion.
 *
 * `dark` is passed in rather than sniffed with `prefers-color-scheme`: the
 * frame is a separate origin and would otherwise follow the MAC's setting, so
 * an app on light over a Mac on dark rendered a dark page in a light window.
 * `html` carries the background too, so it covers the whole frame rather than
 * stopping where the text does. */
function wrap(html: string, dark: boolean): string {
  const bg = dark ? "#17171b" : "#ffffff";
  const fg = dark ? "#e4e1db" : "#111111";
  const style = `<style>
  :root { color-scheme: ${dark ? "dark" : "light"}; }
  html {
    -webkit-text-size-adjust: 100%;
    min-height: 100%;
    background: ${bg};
  }
  body {
    margin: 0 auto;
    min-height: 100vh;
    padding: 2.5rem 1.5rem 4rem;
    max-width: 48rem;
    background: ${bg};
    color: ${fg};
    line-height: 1.55;
    overflow-wrap: break-word;
  }
  a { color: ${dark ? "#9d8df1" : "#5b4bd6"}; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; max-width: 100%; }
  td, th { border: 1px solid rgba(128,128,128,.35); padding: 4px 7px; }
</style>`;
  // textutil emits a complete document; slip the page style in before its own
  // <style> block so the document's rules take precedence.
  const at = html.search(/<head[^>]*>/i);
  if (at >= 0) {
    const insert = html.indexOf(">", at) + 1;
    return html.slice(0, insert) + style + html.slice(insert);
  }
  return style + html;
}
