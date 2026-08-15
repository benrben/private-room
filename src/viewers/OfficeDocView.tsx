import { useEffect, useState } from "react";
import { api } from "../api";
import TextView from "../workspace/TextView";
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
  // The formatted document renders in an opaque frame, so a selection made in
  // it never reaches the app. This second reading is the same one the page and
  // book readers offer, and the only way this document's words can be quoted.
  const [mode, setMode] = useState<"page" | "text">("page");

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
        const token = await api.stagePreviewHtml(wrap(html));
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
        <div className="odoc-bar rdr-bar">
          <span className="rdr-modes" role="group" aria-label="How to read this document">
            <button
              type="button"
              className="rdr-mode"
              aria-pressed={mode === "page"}
              title="The document with its real formatting"
              onClick={() => setMode("page")}
            >
              Page
            </button>
            <button
              type="button"
              className="rdr-mode"
              aria-pressed={mode === "text"}
              title="The document's words — selectable, and quotable in chat"
              onClick={() => setMode("text")}
            >
              Text
            </button>
          </span>
        </div>
        {/* Hidden rather than unmounted: remounting reloads the staged
            document and throws away the reader's scroll position. */}
        <iframe
          key={url}
          className="odoc-frame"
          hidden={mode !== "page"}
          // No allow-scripts: a document is prose. The sandbox's CSP already
          // forbids script; withholding the permission too means the frame is
          // opaque even if that CSP ever changed.
          sandbox=""
          src={url}
          title="Document"
        />
        {mode === "text" && (
          <div className="odoc-text">
            {text?.trim() ? (
              <pre className="html-doc" dir="auto">
                {text}
              </pre>
            ) : (
              <div className="empty-hint">
                No text could be read out of this document.
              </div>
            )}
          </div>
        )}
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

/* The document's page, written into the frame's own markup.
 *
 * These are literal hex values rather than the app's tokens on purpose: a
 * `roomdoc://` frame is an opaque origin and cannot read a single custom
 * property off the parent. They are the light theme's warm paper and ink, and
 * they are FIXED — see the note on `wrap` for why the theme does not reach in
 * here. A link is drawn in the app's own pink pen so it still reads as part of
 * this product rather than as a browser default. */
const DOC_PAPER = "#f7f4ec";
const DOC_INK = "#1b1c19";
const DOC_LINK = "#a92f49";

/** Give the imported HTML a readable page: warm paper, a measured column, and
 * images that can't overflow. The document's OWN stylesheet comes after, so it
 * wins wherever it has an opinion.
 *
 * THE PAGE IS ALWAYS PAPER, IN BOTH THEMES. This used to take the app's
 * light/dark setting and paint the document charcoal in dark mode, which is
 * the trap every "dark reader" falls into: `textutil` emits Word's own
 * character formatting, and Word writes explicit colours — `color:#000000` on
 * a run is ordinary — while writing no background at all. A document that
 * named its ink and trusted the paper therefore came out black-on-charcoal,
 * unreadable, with no way for the reader to tell that the app had done it.
 * Only the app can be sure what its own frame is; it cannot be sure what a
 * 2003 Word file assumed. So the frame keeps the author's assumption (paper
 * under ink) and the notebook stays outside it, exactly as a rasterised PDF
 * page and a rendered slide already do in this app.
 *
 * `html` carries the background too, so it covers the whole frame rather than
 * stopping where the text does. */
function wrap(html: string): string {
  const style = `<style>
  :root { color-scheme: light; }
  html {
    -webkit-text-size-adjust: 100%;
    min-height: 100%;
    background: ${DOC_PAPER};
  }
  body {
    margin: 0 auto;
    min-height: 100vh;
    padding: 3rem 2rem 5rem;
    max-width: 46rem;
    background: ${DOC_PAPER};
    color: ${DOC_INK};
    line-height: 1.6;
    overflow-wrap: break-word;
  }
  a { color: ${DOC_LINK}; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; max-width: 100%; }
  td, th { border: 1px solid rgba(27,28,25,.28); padding: 4px 7px; }
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
